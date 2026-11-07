import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSigner, getBase64Decoder, getUtf8Encoder, signBytes, type KeyPairSigner } from '@solana/kit'
import { Matchmaker, type Direct, type Envelope, type Pairing, type Peer } from '../src/lib/matchmaking-core'
import { Bus, typeOf, type FakeTransport } from './fake-transport'

type Player = {
  mm: Matchmaker
  t: FakeTransport
  signer: KeyPairSigner
  id: string
  pairs: Pairing[]
  direct: { msg: Direct; from: Peer }[]
}

let bus: Bus
let players: Player[]

async function make(): Promise<Player> {
  const t = bus.transport()
  const mm = new Matchmaker(t)
  const signer = await generateKeyPairSigner()
  const p: Player = { mm, t, signer, id: signer.address, pairs: [], direct: [] }
  mm.onPaired((x) => p.pairs.push(x))
  mm.onDirect((msg, from) => p.direct.push({ msg, from }))
  players.push(p)
  return p
}

const makeMany = (n: number) => Promise.all(Array.from({ length: n }, make))

const join = (p: Player, joinedAt: number, stake = 1n, wallet = `w-${p.id}`) =>
  p.mm.join({ wallet, session: p.signer, stake, joinedAt })

/** Signing and verifying are async and chained per Matchmaker; wait until they are all idle. */
async function drain() {
  for (let i = 0; i < 20; i++) await Promise.all(players.map((p) => p.mm['work']))
}

async function step(ms: number) {
  for (let t = 0; t < ms; t += 500) {
    vi.advanceTimersByTime(500)
    await drain()
  }
}

/** Join everyone while proposals are dropped, so the order of joins cannot decide who pairs. */
async function joinTogether(entries: [Player, number, bigint?][]) {
  bus.drop = (m) => typeOf(m) === 'propose'
  entries.forEach(([p, at, stake]) => join(p, at, stake))
  await drain()
  bus.drop = () => false
}

const sent = (p: Player) => p.t.sent.map((e) => ({ to: JSON.parse(e.body).to as string, type: typeOf(e) }))
const ids = (list: Peer[]) => list.map((p) => p.id)

const utf8 = getUtf8Encoder()
const toBase64 = getBase64Decoder()

/** A signed envelope made by hand, so tests can break exactly one rule at a time. */
async function forge(o: { signer: KeyPairSigner; from: string; to: string; payload: Direct; ts?: number; bodyTo?: string }): Promise<Envelope> {
  const body = JSON.stringify({ to: o.bodyTo ?? o.to, from: o.from, ts: o.ts ?? Date.now(), payload: o.payload })
  const sig = toBase64.decode(await signBytes(o.signer.keyPair.privateKey, utf8.encode(body)))
  return { to: o.to, body, sig }
}

async function deliver(to: Player, env: Envelope) {
  to.t.on!.direct(env)
  await drain()
}

beforeEach(() => {
  vi.useFakeTimers()
  bus = new Bus()
  players = []
})

afterEach(() => {
  players.forEach((p) => p.mm.dispose())
  vi.useRealTimers()
})

describe('pairing two peers', () => {
  it('older joinedAt becomes X, the other O', async () => {
    const [a, b] = await makeMany(2)
    join(b, 200)
    join(a, 100)
    await step(2000)
    expect(a.pairs).toHaveLength(1)
    expect(b.pairs).toHaveLength(1)
    expect(a.pairs[0]).toMatchObject({ role: 'x', me: { id: a.id }, opponent: { id: b.id } })
    expect(b.pairs[0]).toMatchObject({ role: 'o', me: { id: b.id }, opponent: { id: a.id } })
    expect(a.t.trackCalls.at(-1)).toBeNull()
    expect(b.t.trackCalls.at(-1)).toBeNull()
    expect(bus.queue()).toEqual([])
  })

  it('breaks joinedAt ties by id', async () => {
    const [a, b] = await makeMany(2)
    join(a, 100)
    join(b, 100)
    await step(2000)
    const [first] = [a, b].sort((x, y) => x.id.localeCompare(y.id))
    expect(first.pairs[0].role).toBe('x')
    expect([a, b].find((p) => p !== first)!.pairs[0].role).toBe('o')
  })

  it('puts the stake, wallet and session in the pairing', async () => {
    const [a, b] = await makeMany(2)
    join(a, 1, 5n, 'wallet-a')
    join(b, 2, 5n, 'wallet-b')
    await step(500)
    expect(a.pairs[0].me).toEqual({ id: a.id, wallet: 'wallet-a', session: a.id, stake: '5', joinedAt: 1 })
    expect(a.pairs[0].opponent).toEqual({ id: b.id, wallet: 'wallet-b', session: b.id, stake: '5', joinedAt: 2 })
  })

  it('does not pair a lone peer', async () => {
    const [a] = await makeMany(1)
    join(a, 1)
    await step(2000)
    expect(a.pairs).toEqual([])
    expect(a.t.sent).toEqual([])
  })
})

describe('FIFO with several peers', () => {
  it('pairs the two oldest first and leaves the rest queued', async () => {
    const [a, b, c] = await makeMany(3)
    await joinTogether([[c, 300], [a, 100], [b, 200]])
    await step(2000)
    expect(a.pairs[0].opponent.id).toBe(b.id)
    expect(b.pairs[0].opponent.id).toBe(a.id)
    expect(c.pairs).toEqual([])
    expect(ids(bus.queue())).toEqual([c.id])
  })

  it('makes two pairs from four', async () => {
    const [a, b, c, d] = await makeMany(4)
    await joinTogether([[d, 4], [b, 2], [c, 3], [a, 1]])
    await step(2000)
    expect(a.pairs[0]).toMatchObject({ role: 'x', opponent: { id: b.id } })
    expect(b.pairs[0]).toMatchObject({ role: 'o', opponent: { id: a.id } })
    expect(c.pairs[0]).toMatchObject({ role: 'x', opponent: { id: d.id } })
    expect(d.pairs[0]).toMatchObject({ role: 'o', opponent: { id: c.id } })
    ;[a, b, c, d].forEach((p) => expect(p.pairs).toHaveLength(1))
  })

  it('a late arrival waits behind an existing odd one out', async () => {
    const [a, b, c, d] = await makeMany(4)
    await joinTogether([[a, 1], [b, 2], [c, 3]])
    await step(2000)
    join(d, 4)
    await step(2000)
    expect(c.pairs[0].opponent.id).toBe(d.id)
    expect(d.pairs[0].opponent.id).toBe(c.id)
  })
})

describe('stake buckets', () => {
  it('never pairs different stakes', async () => {
    const [a, b] = await makeMany(2)
    join(a, 1, 1n)
    join(b, 2, 2n)
    await step(3000)
    expect(a.pairs).toEqual([])
    expect(b.pairs).toEqual([])
    expect(a.t.sent).toEqual([])
    expect(b.t.sent).toEqual([])
  })

  it('makes two pairs from four peers of the same stake', async () => {
    const [a, b, c, d] = await makeMany(4)
    await joinTogether([[a, 1, 7n], [b, 2, 7n], [c, 3, 7n], [d, 4, 7n]])
    await step(2000)
    expect(a.pairs[0].opponent.id).toBe(b.id)
    expect(c.pairs[0].opponent.id).toBe(d.id)
    expect(ids(bus.queue())).toEqual([])
  })

  it('pairs mixed stakes within each bucket in FIFO order', async () => {
    const [a, b, c, d, e] = await makeMany(5)
    // Interleaved: odd-numbered peers bet 1, even ones bet 2, and e (stake 1) is the odd one out.
    await joinTogether([[a, 1, 1n], [b, 2, 2n], [c, 3, 1n], [d, 4, 2n], [e, 5, 1n]])
    await step(2000)
    expect(a.pairs[0]).toMatchObject({ role: 'x', opponent: { id: c.id } })
    expect(c.pairs[0]).toMatchObject({ role: 'o', opponent: { id: a.id } })
    expect(b.pairs[0]).toMatchObject({ role: 'x', opponent: { id: d.id } })
    expect(d.pairs[0]).toMatchObject({ role: 'o', opponent: { id: b.id } })
    expect(e.pairs).toEqual([])
    expect(ids(bus.queue())).toEqual([e.id])
  })
})

describe('same wallet', () => {
  it('never pairs two entries of one wallet', async () => {
    const [a1, a2] = await makeMany(2)
    join(a1, 1, 1n, 'same')
    join(a2, 2, 1n, 'same')
    await step(10_000)
    expect(a1.pairs).toEqual([])
    expect(a2.pairs).toEqual([])
    expect(a1.t.sent).toEqual([])
  })

  it('lets the younger entry pair only after the older one leaves', async () => {
    const [a1, a2, c] = await makeMany(3)
    join(a1, 1, 1n, 'same')
    join(a2, 2, 1n, 'same')
    join(c, 3, 1n, 'other')
    await step(3000)
    // c took the older entry; the younger one is still waiting.
    expect(a1.pairs[0].opponent.id).toBe(c.id)
    expect(a2.pairs).toEqual([])
    const d = await make()
    join(d, 4, 1n, 'third')
    await step(3000)
    expect(a2.pairs[0]).toMatchObject({ role: 'x', opponent: { id: d.id } })
  })

  it('the younger entry gets in line when the older leaves', async () => {
    const [a1, a2, c] = await makeMany(3)
    join(a1, 1, 1n, 'same')
    join(a2, 2, 1n, 'same')
    a1.mm.leave()
    join(c, 3, 1n, 'other')
    await step(2000)
    expect(a2.pairs[0].opponent.id).toBe(c.id)
    expect(c.pairs[0].opponent.id).toBe(a2.id)
  })
})

describe('rejoining', () => {
  it('keeps its place in line with the original joinedAt', async () => {
    const [a, b, c] = await makeMany(3)
    await joinTogether([[a, 100], [b, 200]])
    await step(500)
    join(c, 300)
    await step(1000)
    expect(c.pairs).toEqual([])
    // a's match failed; it rejoins with the original joinedAt and is older than c again.
    join(a, 100)
    await step(500)
    expect(a.pairs).toHaveLength(2)
    expect(a.pairs[1]).toMatchObject({ role: 'x', opponent: { id: c.id } })
    expect(c.pairs[0]).toMatchObject({ role: 'o', opponent: { id: a.id } })
  })

  it('goes to the back of the line with a fresh joinedAt', async () => {
    const [a, b, c] = await makeMany(3)
    await joinTogether([[a, 100], [b, 200]])
    await step(500)
    join(c, 300)
    join(a, Date.now())
    await step(1000)
    expect(c.pairs[0]).toMatchObject({ role: 'x', opponent: { id: a.id } })
    expect(a.pairs[1]).toMatchObject({ role: 'o', opponent: { id: c.id } })
  })
})

describe('leave', () => {
  it('removes you from the queue and stops you pairing', async () => {
    const [a, b] = await makeMany(2)
    join(a, 1)
    a.mm.leave()
    expect(a.mm.queued).toBeNull()
    expect(bus.queue()).toEqual([])
    join(b, 2)
    await step(2000)
    expect(a.pairs).toEqual([])
    expect(b.pairs).toEqual([])
  })

  it('ignores a valid message delivered after leave', async () => {
    const [a, b] = await makeMany(2)
    await joinTogether([[a, 1], [b, 2]])
    b.mm.leave()
    await deliver(b, await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } }))
    expect(b.pairs).toEqual([])
    expect(b.t.sent).toEqual([])
  })

  it('does not untrack again after pairing already did', async () => {
    const [a, b] = await makeMany(2)
    join(a, 1)
    join(b, 2)
    await step(500)
    const calls = a.t.trackCalls.length
    a.mm.leave()
    expect(a.t.trackCalls).toHaveLength(calls)
    expect(a.mm.queued).toBeNull()
  })

  it('can rejoin after leaving', async () => {
    const [a, b] = await makeMany(2)
    join(a, 1)
    a.mm.leave()
    join(a, 1)
    join(b, 2)
    await step(500)
    expect(a.pairs[0].opponent.id).toBe(b.id)
  })
})

describe('addressing', () => {
  it('ignores a message whose envelope is addressed to someone else', async () => {
    const [a, b, c] = await makeMany(3)
    await joinTogether([[a, 1], [b, 2], [c, 3, 2n]])
    const propose = await forge({ signer: a.signer, from: a.id, to: c.id, payload: { type: 'propose' } })
    await deliver(b, propose)
    expect(b.pairs).toEqual([])
    expect(b.t.sent).toEqual([])
  })

  it('ignores messages while not joined', async () => {
    const [a, b] = await makeMany(2)
    join(b, 1)
    b.mm.send(a.mm.queued ?? { id: a.id, wallet: '', session: a.id, stake: '1', joinedAt: 0 }, { type: 'cancel' })
    await drain()
    expect(a.direct).toEqual([])
    expect(a.t.sent).toEqual([])
  })
})

describe('signatures', () => {
  /** a (older) and b are queued and unpaired, so a valid propose from a to b would pair b. */
  async function lineup() {
    const [a, b, attacker] = await makeMany(2).then(async ([x, y]) => [x, y, await generateKeyPairSigner()] as const)
    await joinTogether([[a, 1], [b, 2]])
    return { a, b, attacker }
  }

  it('control: a hand-signed propose from the expected proposer is accepted', async () => {
    const { a, b } = await lineup()
    await deliver(b, await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } }))
    expect(b.pairs[0]).toMatchObject({ role: 'o', opponent: { id: a.id } })
    expect(sent(b)).toEqual([{ to: a.id, type: 'accept' }])
  })

  it.each([
    ['forged sender', async (a: Player, b: Player, attacker: KeyPairSigner) => forge({ signer: attacker, from: a.id, to: b.id, payload: { type: 'propose' } })],
    ['all-zero signature', async (a: Player, b: Player) => ({ ...(await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } })), sig: 'A'.repeat(86) + '==' })],
    ['garbage signature', async (a: Player, b: Player) => ({ ...(await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } })), sig: 'not a signature' })],
    ['empty signature', async (a: Player, b: Player) => ({ ...(await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } })), sig: '' })],
    ['tampered body', async (a: Player, b: Player) => {
      const good = await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } })
      const other = await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' }, ts: Date.now() + 1 })
      return { ...good, body: other.body }
    }],
    ['body that is not JSON', async (a: Player, b: Player) => ({ to: b.id, body: 'nope', sig: (await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } })).sig })],
    ['stale timestamp', async (a: Player, b: Player) => forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' }, ts: Date.now() - 61_000 })],
    ['timestamp too far ahead', async (a: Player, b: Player) => forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' }, ts: Date.now() + 61_000 })],
    ['body.to different from env.to', async (a: Player, b: Player, attacker: KeyPairSigner) => forge({ signer: a.signer, from: a.id, to: b.id, bodyTo: attacker.address, payload: { type: 'propose' } })],
  ])('rejects %s', async (_name, build) => {
    const { a, b, attacker } = await lineup()
    await deliver(b, await build(a, b, attacker))
    expect(b.pairs).toEqual([])
    expect(b.direct).toEqual([])
    expect(b.t.sent).toEqual([])
  })

  it('rejects a replay of a valid envelope', async () => {
    const { a, b } = await lineup()
    const propose = await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } })
    await deliver(b, propose)
    await deliver(b, propose)
    expect(b.pairs).toHaveLength(1)
    // A second copy would have made the paired O answer with another accept.
    expect(sent(b)).toEqual([{ to: a.id, type: 'accept' }])
  })

  it('rejects a replayed cancel from the opponent', async () => {
    const { a, b } = await lineup()
    await deliver(b, await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } }))
    const cancel = await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'cancel' } })
    await deliver(b, cancel)
    await deliver(b, cancel)
    expect(b.direct).toEqual([{ msg: { type: 'cancel' }, from: expect.objectContaining({ id: a.id }) }])
  })

  describe('spoofed directs to a paired player', () => {
    async function paired() {
      const [a, b, attacker] = await Promise.all([make(), make(), generateKeyPairSigner()])
      join(a, 1)
      join(b, 2)
      await step(500)
      expect(b.pairs).toHaveLength(1)
      return { a, b, attacker }
    }

    it.each<[string, Direct]>([
      ['cancel', { type: 'cancel' }],
      ['started', { type: 'started', game: 'g' }],
    ])('ignores a %s forged in the opponent\'s name', async (_n, payload) => {
      const { a, b, attacker } = await paired()
      await deliver(b, await forge({ signer: attacker, from: a.id, to: b.id, payload }))
      expect(b.direct).toEqual([])
    })

    it.each<[string, Direct]>([
      ['cancel', { type: 'cancel' }],
      ['started', { type: 'started', game: 'g' }],
    ])('ignores a correctly signed %s from a stranger', async (_n, payload) => {
      const { b, attacker } = await paired()
      await deliver(b, await forge({ signer: attacker, from: attacker.address, to: b.id, payload }))
      expect(b.direct).toEqual([])
    })
  })
})

describe('expected partner', () => {
  it('ignores a propose from someone two places ahead', async () => {
    const [a, b, c, d] = await makeMany(4)
    await joinTogether([[a, 1], [b, 2], [c, 3], [d, 4]])
    // d is fourth in line and expects c. a is not directly ahead.
    await deliver(d, await forge({ signer: a.signer, from: a.id, to: d.id, payload: { type: 'propose' } }))
    expect(d.pairs).toEqual([])
    expect(d.t.sent).toEqual([])
    // b expects a, not c.
    await deliver(b, await forge({ signer: c.signer, from: c.id, to: b.id, payload: { type: 'propose' } }))
    expect(b.pairs).toEqual([])
  })

  it('ignores a propose to a peer at an even place', async () => {
    const [a, b, c] = await makeMany(3)
    await joinTogether([[a, 1], [b, 2], [c, 3]])
    await deliver(c, await forge({ signer: b.signer, from: b.id, to: c.id, payload: { type: 'propose' } }))
    expect(c.pairs).toEqual([])
    expect(c.t.sent).toEqual([])
  })

  it('ignores a propose from a peer of a different stake', async () => {
    const [a, b] = await makeMany(2)
    await joinTogether([[a, 1, 1n], [b, 2, 2n]])
    await deliver(b, await forge({ signer: a.signer, from: a.id, to: b.id, payload: { type: 'propose' } }))
    expect(b.pairs).toEqual([])
    expect(b.t.sent).toEqual([])
  })

  it('ignores a propose from a peer that is not queued at all', async () => {
    const [b] = await makeMany(1)
    const stranger = await generateKeyPairSigner()
    join(b, 2)
    await deliver(b, await forge({ signer: stranger, from: stranger.address, to: b.id, payload: { type: 'propose' } }))
    expect(b.pairs).toEqual([])
    expect(b.t.sent).toEqual([])
  })
})

describe('accept handling', () => {
  it('cancels an accept from someone it never asked', async () => {
    const [a, c] = await makeMany(2)
    const stranger = await generateKeyPairSigner()
    join(a, 1)
    await deliver(a, await forge({ signer: stranger, from: stranger.address, to: a.id, payload: { type: 'accept' } }))
    expect(a.pairs).toEqual([])
    expect(sent(a)).toEqual([{ to: stranger.address, type: 'cancel' }])
    expect(c.t.sent).toEqual([])
  })

  it('a paired peer cancels an accept from a third peer', async () => {
    const [a, b, c] = await makeMany(3)
    join(a, 1)
    join(b, 2)
    await step(500)
    await deliver(a, await forge({ signer: c.signer, from: c.id, to: a.id, payload: { type: 'accept' } }))
    expect(sent(a).filter((m) => m.type === 'cancel')).toEqual([{ to: c.id, type: 'cancel' }])
    expect(a.pairs).toHaveLength(1)
    expect(a.pairs[0].opponent.id).toBe(b.id)
  })

  it('does not cancel the opponent re-sending its accept', async () => {
    const [a, b] = await makeMany(2)
    join(a, 1)
    join(b, 2)
    await step(500)
    await deliver(a, await forge({ signer: b.signer, from: b.id, to: a.id, payload: { type: 'accept' } }))
    expect(sent(a).some((m) => m.type === 'cancel')).toBe(false)
    expect(a.pairs).toHaveLength(1)
  })
})

describe('lost messages', () => {
  it('the proposer keeps proposing until the accept gets through', async () => {
    const [a, b] = await makeMany(2)
    bus.drop = (m) => typeOf(m) === 'accept'
    join(a, 1)
    join(b, 2)
    await step(2000)
    expect(b.pairs).toHaveLength(1)
    expect(a.pairs).toEqual([])
    // b answers each repeated propose with another accept.
    expect(sent(b).filter((m) => m.type === 'accept').length).toBeGreaterThan(1)
    bus.drop = () => false
    await step(1000)
    expect(a.pairs).toHaveLength(1)
    expect(a.pairs[0]).toMatchObject({ role: 'x', opponent: { id: b.id } })
  })

  it('gives up proposing after the linger window', async () => {
    const [a, b] = await makeMany(2)
    bus.drop = (m) => typeOf(m) === 'accept'
    join(a, 1)
    join(b, 2)
    await step(8000)
    const proposes = sent(a).filter((m) => m.type === 'propose').length
    await step(3000)
    expect(sent(a).filter((m) => m.type === 'propose')).toHaveLength(proposes)
    bus.drop = () => false
    await step(2000)
    expect(a.pairs).toEqual([])
  })

  it('a lost propose is retried on the next tick', async () => {
    const [a, b] = await makeMany(2)
    bus.drop = (m) => typeOf(m) === 'propose'
    join(a, 1)
    join(b, 2)
    await step(1000)
    expect(b.pairs).toEqual([])
    bus.drop = () => false
    await step(1000)
    expect(a.pairs).toHaveLength(1)
    expect(b.pairs).toHaveLength(1)
  })

  it('stops proposing once paired', async () => {
    const [a, b] = await makeMany(2)
    join(a, 1)
    join(b, 2)
    await step(500)
    const n = a.t.sent.length
    await step(3000)
    expect(a.t.sent).toHaveLength(n)
  })
})

describe('direct messages', () => {
  const offer: Direct = { type: 'offer', tx: 'tx', game: 'g', nonce: 'n', blockhash: 'h', lastValidBlockHeight: '9' }

  async function paired() {
    const [a, b] = await makeMany(2)
    join(a, 1)
    join(b, 2)
    await step(500)
    return { a, b }
  }

  it('delivers offer, started and cancel from the opponent with its stored Peer', async () => {
    const { a, b } = await paired()
    a.mm.send(b.pairs[0].me, offer)
    a.mm.send(b.pairs[0].me, { type: 'started', game: 'g' })
    a.mm.send(b.pairs[0].me, { type: 'cancel' })
    await drain()
    expect(b.direct.map((d) => d.msg)).toEqual([offer, { type: 'started', game: 'g' }, { type: 'cancel' }])
    b.direct.forEach((d) => expect(d.from).toEqual(a.pairs[0].me))
    expect(a.direct).toEqual([])
    b.mm.send(a.pairs[0].me, { type: 'started', game: 'g' })
    await drain()
    expect(a.direct).toEqual([{ msg: { type: 'started', game: 'g' }, from: b.pairs[0].me }])
  })

  it('does not hand propose or accept to onDirect', async () => {
    const { a, b } = await paired()
    expect(a.direct).toEqual([])
    expect(b.direct).toEqual([])
  })

  it('ignores a direct from a peer that is not the opponent', async () => {
    const { b } = await paired()
    const c = await make()
    join(c, 3)
    await drain()
    c.mm.send(b.pairs[0].me, { type: 'cancel' })
    await drain()
    expect(b.direct).toEqual([])
  })

  it('ignores a direct before pairing', async () => {
    const [a, b] = await makeMany(2)
    await joinTogether([[a, 1], [b, 2]])
    a.mm.send(b.mm.queued!, { type: 'cancel' })
    await drain()
    expect(b.direct).toEqual([])
  })

  it('unsubscribed listeners stop receiving', async () => {
    const { a, b } = await paired()
    const fn = vi.fn()
    const off = b.mm.onDirect(fn)
    off()
    a.mm.send(b.pairs[0].me, { type: 'cancel' })
    await drain()
    expect(fn).not.toHaveBeenCalled()
  })

  it('send is a no-op when not joined', async () => {
    const [a] = await makeMany(1)
    a.mm.send({ id: 'b', wallet: '', session: 'b', stake: '1', joinedAt: 0 }, { type: 'cancel' })
    await drain()
    expect(a.t.sent).toEqual([])
  })
})

describe('queue entries', () => {
  it('drops entries whose id is not their session', async () => {
    const [spectator] = await makeMany(1)
    const liar = bus.transport()
    liar.track({ id: 'x', wallet: 'w', session: 'y', stake: '1', joinedAt: 1 })
    const sizes: number[] = []
    spectator.mm.onQueueSize((n) => sizes.push(n))
    expect(sizes.at(-1)).toBe(0)
  })

  it('counts an id once even if it appears twice', async () => {
    const [spectator] = await makeMany(1)
    const peer: Peer = { id: 'p', wallet: 'w', session: 'p', stake: '1', joinedAt: 1 }
    bus.transport().track(peer)
    bus.transport().track(peer)
    const sizes: number[] = []
    spectator.mm.onQueueSize((n) => sizes.push(n))
    expect(sizes.at(-1)).toBe(1)
  })
})

describe('queue counts', () => {
  it('reports the count immediately and on each change', async () => {
    const [a] = await makeMany(1)
    const counts: number[] = []
    a.mm.onQueueSize((n) => counts.push(n))
    expect(counts).toEqual([0])
    join(a, 1)
    expect(counts.at(-1)).toBe(1)
  })

  it('a spectator that never joins sees the queue size', async () => {
    const [spectator, a, b, c] = await makeMany(4)
    const seen = vi.fn()
    spectator.mm.onQueueSize(seen)
    expect(seen).toHaveBeenLastCalledWith(0)
    join(a, 1)
    expect(seen).toHaveBeenLastCalledWith(1)
    join(b, 2)
    await step(500)
    expect(seen).toHaveBeenLastCalledWith(0)
    join(c, 3)
    expect(seen).toHaveBeenLastCalledWith(1)
    c.mm.leave()
    expect(seen).toHaveBeenLastCalledWith(0)
    expect(spectator.pairs).toEqual([])
    expect(spectator.t.sent).toEqual([])
  })

  it('a paired peer no longer counts itself', async () => {
    const [a, b] = await makeMany(2)
    const seen = vi.fn()
    a.mm.onQueueSize(seen)
    join(a, 1)
    join(b, 2)
    await step(1000)
    expect(seen).toHaveBeenLastCalledWith(0)
  })

  it('unsubscribing stops updates', async () => {
    const [a] = await makeMany(1)
    const fn = vi.fn()
    const off = a.mm.onQueueSize(fn)
    off()
    fn.mockClear()
    await step(1000)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('onQueue', () => {
  it('includes us while queued, oldest first', async () => {
    const [a, b, c] = await makeMany(3)
    const seen = vi.fn()
    c.mm.onQueue(seen)
    expect(seen).toHaveBeenLastCalledWith([])
    await joinTogether([[a, 1], [b, 2], [c, 3]])
    const last = seen.mock.calls.at(-1)![0] as Peer[]
    expect(ids(last)).toEqual([a.id, b.id, c.id])
  })

  it('excludes us once paired', async () => {
    const [a, b] = await makeMany(2)
    const seen = vi.fn()
    a.mm.onQueue(seen)
    join(a, 1)
    join(b, 2)
    expect(ids(seen.mock.calls.at(-1)![0])).toEqual([a.id, b.id])
    await step(500)
    expect(seen.mock.calls.at(-1)![0]).toEqual([])
  })

  it('fires only when the list changes', async () => {
    const [spectator, a] = await makeMany(2)
    const seen = vi.fn()
    spectator.mm.onQueue(seen)
    join(a, 1)
    const calls = seen.mock.calls.length
    await step(3000)
    expect(seen).toHaveBeenCalledTimes(calls)
  })

  it('gives a spectator the lists of every stake', async () => {
    const [spectator, a, b, c] = await makeMany(4)
    const seen = vi.fn()
    spectator.mm.onQueue(seen)
    await joinTogether([[a, 1, 1n], [b, 2, 2n], [c, 3, 1n]])
    const queue = seen.mock.calls.at(-1)![0] as Peer[]
    expect(ids(queue.filter((p) => p.stake === '1'))).toEqual([a.id, c.id])
    expect(ids(queue.filter((p) => p.stake === '2'))).toEqual([b.id])
    expect(spectator.t.sent).toEqual([])
  })

  it('unsubscribing stops updates', async () => {
    const [spectator, a] = await makeMany(2)
    const fn = vi.fn()
    spectator.mm.onQueue(fn)()
    fn.mockClear()
    join(a, 1)
    expect(fn).not.toHaveBeenCalled()
  })
})
