import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSigner, getBase58Decoder, getBase64Decoder, getUtf8Encoder, signBytes, type KeyPairSigner } from '@solana/kit'
import { joinMessage, Matchmaker, type Direct, type Envelope, type JoinProof, type Pairing, type Peer } from '../src/lib/matchmaking-core'
import { Bus, typeOf, type FakeTransport } from './fake-transport'

const CLUSTER = 'devnet'

type Player = {
  mm: Matchmaker
  t: FakeTransport
  signer: KeyPairSigner
  wallet: KeyPairSigner
  id: string
  pairs: Pairing[]
  direct: { msg: Direct; from: Peer }[]
}

let bus: Bus
let players: Player[]

/** A player with a fresh session key, and a fresh wallet unless it shares one. */
async function make(wallet?: KeyPairSigner): Promise<Player> {
  const t = bus.transport()
  const mm = new Matchmaker(t, CLUSTER)
  const signer = await generateKeyPairSigner()
  const p: Player = { mm, t, signer, wallet: wallet ?? (await generateKeyPairSigner()), id: signer.address, pairs: [], direct: [] }
  mm.onPaired((x) => p.pairs.push(x))
  mm.onDirect((msg, from) => p.direct.push({ msg, from }))
  players.push(p)
  return p
}

const makeMany = (n: number) => Promise.all(Array.from({ length: n }, make))

const base58 = getBase58Decoder()
const utf8 = getUtf8Encoder()
const toBase64 = getBase64Decoder()

type EntryOptions = {
  wallet?: KeyPairSigner
  /** The session address, which is also the id. */
  session?: string
  stake?: string
  joinedAt?: number
  cluster?: string
  /** Who actually signs the proof; the wallet unless a test says otherwise. */
  signer?: KeyPairSigner
}

/** A queue entry as another player would publish it, with a proof signed by hand. */
async function makeEntry(o: EntryOptions = {}): Promise<Peer> {
  const wallet = o.wallet ?? (await generateKeyPairSigner())
  const session = o.session ?? (await generateKeyPairSigner()).address
  const fields = { wallet: wallet.address, session, stake: o.stake ?? '1000', joinedAt: o.joinedAt ?? 1 }
  const message = joinMessage({ ...fields, cluster: o.cluster ?? CLUSTER })
  const signature = base58.decode(await signBytes((o.signer ?? wallet).keyPair.privateKey, utf8.encode(message)))
  return { id: session, ...fields, proof: { message, signature } }
}

/** Enter the queue with a proof signed by the player's wallet. */
async function join(p: Player, joinedAt: number, stake = 1n, proof?: JoinProof) {
  proof ??= (await makeEntry({ wallet: p.wallet, session: p.id, stake: stake.toString(), joinedAt })).proof
  p.mm.join({ wallet: p.wallet.address, session: p.signer, stake, joinedAt, proof })
  // Other players only see our entry once its proof has been checked.
  await drain()
}

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
  for (const [p, at, stake] of entries) await join(p, at, stake)
  await drain()
  bus.drop = () => false
}

const sent = (p: Player) => p.t.sent.map((e) => ({ to: JSON.parse(e.body).to as string, type: typeOf(e) }))
const ids = (list: Peer[]) => list.map((p) => p.id)

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
    await join(b, 200)
    await join(a, 100)
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
    await join(a, 100)
    await join(b, 100)
    await step(2000)
    const [first] = [a, b].sort((x, y) => x.id.localeCompare(y.id))
    expect(first.pairs[0].role).toBe('x')
    expect([a, b].find((p) => p !== first)!.pairs[0].role).toBe('o')
  })

  it('puts the stake, wallet and session in the pairing', async () => {
    const [a, b] = await makeMany(2)
    await join(a, 1, 5n)
    await join(b, 2, 5n)
    await step(500)
    expect(a.pairs[0].me).toMatchObject({ id: a.id, wallet: a.wallet.address, session: a.id, stake: '5', joinedAt: 1 })
    expect(a.pairs[0].opponent).toMatchObject({ id: b.id, wallet: b.wallet.address, session: b.id, stake: '5', joinedAt: 2 })
  })

  it('does not pair a lone peer', async () => {
    const [a] = await makeMany(1)
    await join(a, 1)
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
    await join(d, 4)
    await step(2000)
    expect(c.pairs[0].opponent.id).toBe(d.id)
    expect(d.pairs[0].opponent.id).toBe(c.id)
  })
})

describe('stake buckets', () => {
  it('never pairs different stakes', async () => {
    const [a, b] = await makeMany(2)
    await join(a, 1, 1n)
    await join(b, 2, 2n)
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
  const sharedWallet = () => generateKeyPairSigner()

  it('never pairs two entries of one wallet', async () => {
    const w = await sharedWallet()
    const a1 = await make(w)
    const a2 = await make(w)
    await join(a1, 1)
    await join(a2, 2)
    await step(10_000)
    expect(a1.pairs).toEqual([])
    expect(a2.pairs).toEqual([])
    expect(a1.t.sent).toEqual([])
  })

  it('lets the younger entry pair only after the older one leaves', async () => {
    const w = await sharedWallet()
    const a1 = await make(w)
    const a2 = await make(w)
    const [c, d] = await makeMany(2)
    await join(a1, 1)
    await join(a2, 2)
    await join(c, 3)
    await step(3000)
    // c took the older entry; the younger one is still waiting.
    expect(a1.pairs[0].opponent.id).toBe(c.id)
    expect(a2.pairs).toEqual([])
    await join(d, 4)
    await step(3000)
    expect(a2.pairs[0]).toMatchObject({ role: 'x', opponent: { id: d.id } })
  })

  it('the younger entry gets in line when the older leaves', async () => {
    const w = await sharedWallet()
    const a1 = await make(w)
    const a2 = await make(w)
    const c = await make()
    await join(a1, 1)
    await join(a2, 2)
    a1.mm.leave()
    await join(c, 3)
    await step(2000)
    expect(a2.pairs[0].opponent.id).toBe(c.id)
    expect(c.pairs[0].opponent.id).toBe(a2.id)
  })

  it('counts across stakes: the younger entry at another stake waits behind the older one', async () => {
    const w = await sharedWallet()
    const a1 = await make(w)
    const a2 = await make(w)
    const b = await make()
    await join(a1, 1, 1n)
    await join(a2, 2, 2n)
    await join(b, 3, 2n)
    await step(5000)
    expect(a2.pairs).toEqual([])
    expect(b.pairs).toEqual([])
    expect(a1.pairs).toEqual([])
    a1.mm.leave()
    await step(2000)
    expect(a2.pairs[0]).toMatchObject({ role: 'x', opponent: { id: b.id } })
  })
})

describe('rejoining', () => {
  it('keeps its place in line with the original joinedAt', async () => {
    const [a, b, c] = await makeMany(3)
    await joinTogether([[a, 100], [b, 200]])
    await step(500)
    await join(c, 300)
    await step(1000)
    expect(c.pairs).toEqual([])
    // a's match failed; it rejoins with the original joinedAt and is older than c again.
    await join(a, 100)
    await step(500)
    expect(a.pairs).toHaveLength(2)
    expect(a.pairs[1]).toMatchObject({ role: 'x', opponent: { id: c.id } })
    expect(c.pairs[0]).toMatchObject({ role: 'o', opponent: { id: a.id } })
  })

  it('goes to the back of the line with a fresh joinedAt', async () => {
    const [a, b, c] = await makeMany(3)
    await joinTogether([[a, 100], [b, 200]])
    await step(500)
    await join(c, 300)
    await join(a, Date.now())
    await step(1000)
    expect(c.pairs[0]).toMatchObject({ role: 'x', opponent: { id: a.id } })
    expect(a.pairs[1]).toMatchObject({ role: 'o', opponent: { id: c.id } })
  })
})

describe('leave', () => {
  it('removes you from the queue and stops you pairing', async () => {
    const [a, b] = await makeMany(2)
    await join(a, 1)
    a.mm.leave()
    expect(a.mm.queued).toBeNull()
    expect(bus.queue()).toEqual([])
    await join(b, 2)
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
    await join(a, 1)
    await join(b, 2)
    await step(500)
    const calls = a.t.trackCalls.length
    a.mm.leave()
    expect(a.t.trackCalls).toHaveLength(calls)
    expect(a.mm.queued).toBeNull()
  })

  it('can rejoin after leaving', async () => {
    const [a, b] = await makeMany(2)
    await join(a, 1)
    a.mm.leave()
    await join(a, 1)
    await join(b, 2)
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
    await join(b, 1)
    b.mm.send(a.mm.queued ?? { id: a.id, wallet: '', session: a.id, stake: '1', joinedAt: 0, proof: { message: '', signature: '' } }, { type: 'cancel' })
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
      await join(a, 1)
      await join(b, 2)
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
    await join(b, 2)
    await deliver(b, await forge({ signer: stranger, from: stranger.address, to: b.id, payload: { type: 'propose' } }))
    expect(b.pairs).toEqual([])
    expect(b.t.sent).toEqual([])
  })
})

describe('accept handling', () => {
  it('cancels an accept from someone it never asked', async () => {
    const [a, c] = await makeMany(2)
    const stranger = await generateKeyPairSigner()
    await join(a, 1)
    await deliver(a, await forge({ signer: stranger, from: stranger.address, to: a.id, payload: { type: 'accept' } }))
    expect(a.pairs).toEqual([])
    expect(sent(a)).toEqual([{ to: stranger.address, type: 'cancel' }])
    expect(c.t.sent).toEqual([])
  })

  it('a paired peer cancels an accept from a third peer', async () => {
    const [a, b, c] = await makeMany(3)
    await join(a, 1)
    await join(b, 2)
    await step(500)
    await deliver(a, await forge({ signer: c.signer, from: c.id, to: a.id, payload: { type: 'accept' } }))
    expect(sent(a).filter((m) => m.type === 'cancel')).toEqual([{ to: c.id, type: 'cancel' }])
    expect(a.pairs).toHaveLength(1)
    expect(a.pairs[0].opponent.id).toBe(b.id)
  })

  it('does not cancel the opponent re-sending its accept', async () => {
    const [a, b] = await makeMany(2)
    await join(a, 1)
    await join(b, 2)
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
    await join(a, 1)
    await join(b, 2)
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
    await join(a, 1)
    await join(b, 2)
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
    await join(a, 1)
    await join(b, 2)
    await step(1000)
    expect(b.pairs).toEqual([])
    bus.drop = () => false
    await step(1000)
    expect(a.pairs).toHaveLength(1)
    expect(b.pairs).toHaveLength(1)
  })

  it('stops proposing once paired', async () => {
    const [a, b] = await makeMany(2)
    await join(a, 1)
    await join(b, 2)
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
    await join(a, 1)
    await join(b, 2)
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
    await join(c, 3)
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
    a.mm.send({ id: 'b', wallet: '', session: 'b', stake: '1', joinedAt: 0, proof: { message: '', signature: '' } }, { type: 'cancel' })
    await drain()
    expect(a.t.sent).toEqual([])
  })
})

describe('queue entries', () => {
  const sizeSeenBy = async (spectator: Player) => {
    await drain()
    const sizes: number[] = []
    spectator.mm.onQueueSize((n) => sizes.push(n))
    return sizes.at(-1)
  }

  it('counts a valid entry published by another player', async () => {
    const [spectator] = await makeMany(1)
    bus.transport().track(await makeEntry())
    expect(await sizeSeenBy(spectator)).toBe(1)
  })

  it('drops entries whose id is not their session', async () => {
    const [spectator] = await makeMany(1)
    bus.transport().track({ ...(await makeEntry()), id: 'x' })
    expect(await sizeSeenBy(spectator)).toBe(0)
  })

  it('counts an id once even if it appears twice', async () => {
    const [spectator] = await makeMany(1)
    const entry = await makeEntry()
    bus.transport().track(entry)
    bus.transport().track(entry)
    expect(await sizeSeenBy(spectator)).toBe(1)
  })
})

describe('queue counts', () => {
  it('reports the count immediately and on each change', async () => {
    const [a] = await makeMany(1)
    const counts: number[] = []
    a.mm.onQueueSize((n) => counts.push(n))
    expect(counts).toEqual([0])
    await join(a, 1)
    expect(counts.at(-1)).toBe(1)
  })

  it('a spectator that never joins sees the queue size', async () => {
    const [spectator, a, b, c] = await makeMany(4)
    const seen = vi.fn()
    spectator.mm.onQueueSize(seen)
    expect(seen).toHaveBeenLastCalledWith(0)
    await join(a, 1)
    expect(seen).toHaveBeenLastCalledWith(1)
    await join(b, 2)
    await step(500)
    expect(seen).toHaveBeenLastCalledWith(0)
    await join(c, 3)
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
    await join(a, 1)
    await join(b, 2)
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
    await join(a, 1)
    await join(b, 2)
    expect(ids(seen.mock.calls.at(-1)![0])).toEqual([a.id, b.id])
    await step(500)
    expect(seen.mock.calls.at(-1)![0]).toEqual([])
  })

  it('fires only when the list changes', async () => {
    const [spectator, a] = await makeMany(2)
    const seen = vi.fn()
    spectator.mm.onQueue(seen)
    await join(a, 1)
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
    await join(a, 1)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('join proofs', () => {
  /** What a spectator sees after `entries` are published and checked. */
  async function seenWith(entries: Peer[]) {
    const [spectator] = await makeMany(1)
    const seen = vi.fn()
    spectator.mm.onQueue(seen)
    for (const e of entries) bus.transport().track(e)
    await drain()
    await step(1000)
    return ids(seen.mock.calls.at(-1)![0])
  }

  it('accepts a valid proof and shows the entry after a drain', async () => {
    const [spectator] = await makeMany(1)
    const seen = vi.fn()
    spectator.mm.onQueue(seen)
    const entry = await makeEntry()
    bus.transport().track(entry)
    // Not visible until its signature has been checked.
    expect(seen.mock.calls.at(-1)![0]).toEqual([])
    await drain()
    expect(seen.mock.calls.at(-1)![0]).toEqual([entry])
  })

  it('ignores a proof signed by a key that is not the wallet', async () => {
    const other = await generateKeyPairSigner()
    expect(await seenWith([await makeEntry({ signer: other })])).toEqual([])
  })

  it.each([
    ['garbage', 'garbage'],
    ['empty', ''],
    ['64 zero bytes', '1'.repeat(64)],
    ['wrong length', '1'.repeat(10)],
  ])('ignores a %s signature', async (_n, signature) => {
    const e = await makeEntry()
    expect(await seenWith([{ ...e, proof: { ...e.proof, signature } }])).toEqual([])
  })

  it('ignores an entry with no proof', async () => {
    const e = await makeEntry()
    expect(await seenWith([{ ...e, proof: undefined } as unknown as Peer])).toEqual([])
  })

  it('shows the control entry the other cases tamper with', async () => {
    const e = await makeEntry()
    expect(await seenWith([e])).toEqual([e.id])
  })

  it.each<[string, (e: Peer, other: string) => Peer | Promise<Peer>]>([
    ['tampered stake', (e) => ({ ...e, stake: '2000' })],
    ['tampered joinedAt', (e) => ({ ...e, joinedAt: e.joinedAt + 1 })],
    ['tampered wallet', (e, other) => ({ ...e, wallet: other })],
    ['tampered session and id', (e, other) => ({ ...e, session: other, id: other })],
    ['tampered session only', (e, other) => ({ ...e, session: other })],
    ['a different cluster', () => makeEntry({ cluster: 'mainnet-beta' })],
  ])('ignores %s', async (_n, alter) => {
    const e = await makeEntry()
    const other = (await generateKeyPairSigner()).address
    expect(await seenWith([await alter(e, other)])).toEqual([])
  })

  it('does not let a verified signature approve altered fields', async () => {
    const e = await makeEntry()
    const forged = [
      { ...e, stake: '2000' },
      // The message is rewritten to match the altered fields, but the signature is the old one.
      { ...e, stake: '2000', proof: { message: joinMessage({ ...e, stake: '2000', cluster: CLUSTER }), signature: e.proof.signature } },
      { ...e, joinedAt: 99, proof: { message: joinMessage({ ...e, joinedAt: 99, cluster: CLUSTER }), signature: e.proof.signature } },
    ]
    const [spectator] = await makeMany(1)
    const seen = vi.fn()
    spectator.mm.onQueue(seen)
    // The honest entry is checked and cached first.
    const honest = bus.transport()
    honest.track(e)
    await drain()
    expect(ids(seen.mock.calls.at(-1)![0])).toEqual([e.id])
    // The honest entry leaves; the same id comes back with altered fields and the old signature.
    honest.track(null)
    await drain()
    for (const f of forged) {
      bus.transport().track(f)
      await drain()
      await step(500)
      expect(seen.mock.calls.at(-1)![0]).toEqual([])
    }
  })

  it('checks each proof once, however often the queue is read', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify')
    const [spectator] = await makeMany(1)
    spectator.mm.onQueue(() => {})
    bus.transport().track(await makeEntry())
    bus.transport().track(await makeEntry())
    await drain()
    await step(5000)
    expect(verify).toHaveBeenCalledTimes(2)
    verify.mockRestore()
  })

  it('checks a rejected proof only once too', async () => {
    const verify = vi.spyOn(crypto.subtle, 'verify')
    const [spectator] = await makeMany(1)
    spectator.mm.onQueue(() => {})
    const e = await makeEntry({ signer: await generateKeyPairSigner() })
    bus.transport().track(e)
    await drain()
    await step(5000)
    expect(verify).toHaveBeenCalledTimes(1)
    verify.mockRestore()
  })

  it('a player whose own proof is bad is never paired', async () => {
    const [a, b] = await makeMany(2)
    const bad = await makeEntry({ wallet: a.wallet, session: a.id, joinedAt: 1, signer: await generateKeyPairSigner() })
    await join(a, 1, 1n, bad.proof)
    await join(b, 2)
    await step(3000)
    // a's own entry carries a bad proof, so b never sees it and nothing pairs.
    expect(a.pairs).toEqual([])
    expect(b.pairs).toEqual([])
  })
})

describe('own proof warning', () => {
  it('warns once when our own proof does not verify', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [a] = await makeMany(1)
    const bad = await makeEntry({ wallet: a.wallet, session: a.id, joinedAt: 1, signer: await generateKeyPairSigner() })
    await join(a, 1, 1n, bad.proof)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/join proof/)
    warn.mockRestore()
  })

  it('warns when our proof signs a different cluster', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [a] = await makeMany(1)
    const other = await makeEntry({ wallet: a.wallet, session: a.id, joinedAt: 1, cluster: 'mainnet-beta' })
    await join(a, 1, 1n, other.proof)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('stays quiet with a good proof', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [a] = await makeMany(1)
    await join(a, 1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('onDuplicate', () => {
  async function sameWallet() {
    const w = await generateKeyPairSigner()
    return [await make(w), await make(w)] as const
  }

  it('fires immediately with null', async () => {
    const [a] = await makeMany(1)
    const fn = vi.fn()
    a.mm.onDuplicate(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith(null)
  })

  it('reports the older entry of our own wallet', async () => {
    const [older, younger] = await sameWallet()
    const fn = vi.fn()
    younger.mm.onDuplicate(fn)
    await join(older, 1)
    await join(younger, 2)
    await step(500)
    expect(fn.mock.calls.at(-1)![0]).toMatchObject({ id: older.id, wallet: older.wallet.address })
  })

  it('is null for the oldest entry', async () => {
    const [older, younger] = await sameWallet()
    const fn = vi.fn()
    older.mm.onDuplicate(fn)
    await join(older, 1)
    await join(younger, 2)
    await step(2000)
    expect(fn.mock.calls.every(([x]) => x === null)).toBe(true)
  })

  it('flips to null when the older one leaves', async () => {
    const [older, younger] = await sameWallet()
    const fn = vi.fn()
    younger.mm.onDuplicate(fn)
    await join(older, 1)
    await join(younger, 2)
    await step(500)
    expect(fn.mock.calls.at(-1)![0]).not.toBeNull()
    older.mm.leave()
    await step(500)
    expect(fn.mock.calls.at(-1)![0]).toBeNull()
  })

  it('is null after we pair', async () => {
    const [older, younger] = await sameWallet()
    const c = await make()
    const fn = vi.fn()
    younger.mm.onDuplicate(fn)
    await join(older, 1)
    await join(younger, 2)
    older.mm.leave()
    await join(c, 3)
    await step(2000)
    expect(younger.pairs).toHaveLength(1)
    expect(fn.mock.calls.at(-1)![0]).toBeNull()
  })

  it('is null after we leave', async () => {
    const [older, younger] = await sameWallet()
    const fn = vi.fn()
    younger.mm.onDuplicate(fn)
    await join(older, 1)
    await join(younger, 2)
    await step(500)
    expect(fn.mock.calls.at(-1)![0]).not.toBeNull()
    younger.mm.leave()
    await step(500)
    expect(fn.mock.calls.at(-1)![0]).toBeNull()
  })

  it('does not fire again without a change', async () => {
    const [older, younger] = await sameWallet()
    const fn = vi.fn()
    younger.mm.onDuplicate(fn)
    await join(older, 1)
    await join(younger, 2)
    await step(500)
    const calls = fn.mock.calls.length
    await step(5000)
    expect(fn).toHaveBeenCalledTimes(calls)
  })

  it('counts an older entry of our wallet at another stake', async () => {
    const [older, younger] = await sameWallet()
    const fn = vi.fn()
    younger.mm.onDuplicate(fn)
    await join(older, 1, 1n)
    await join(younger, 2, 5n)
    await step(500)
    expect(fn.mock.calls.at(-1)![0]).toMatchObject({ id: older.id })
  })

  it('ignores an older same-wallet entry with an invalid proof', async () => {
    const [a] = await makeMany(1)
    const fn = vi.fn()
    a.mm.onDuplicate(fn)
    await join(a, 5)
    const bad = await makeEntry({ wallet: a.wallet, joinedAt: 1, signer: await generateKeyPairSigner() })
    bus.transport().track(bad)
    await step(2000)
    expect(fn.mock.calls.every(([x]) => x === null)).toBe(true)
  })

  it('reports an older same-wallet entry with a valid proof', async () => {
    const [a] = await makeMany(1)
    const fn = vi.fn()
    a.mm.onDuplicate(fn)
    await join(a, 5)
    const other = await makeEntry({ wallet: a.wallet, joinedAt: 1 })
    bus.transport().track(other)
    await step(500)
    expect(fn.mock.calls.at(-1)![0]).toEqual(other)
  })
})
