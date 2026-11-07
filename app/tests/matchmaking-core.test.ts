import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Matchmaker, type Direct, type Pairing, type Peer } from '../src/lib/matchmaking-core'
import { Bus, type FakeTransport } from './fake-transport'

type Player = { mm: Matchmaker; t: FakeTransport; pairs: Pairing[]; direct: { msg: Direct; from: Peer }[] }

let bus: Bus
let players: Player[]

function make(id: string): Player {
  const t = bus.transport()
  const mm = new Matchmaker(t, id)
  const p: Player = { mm, t, pairs: [], direct: [] }
  mm.onPaired((x) => p.pairs.push(x))
  mm.onDirect((msg, from) => p.direct.push({ msg, from }))
  players.push(p)
  return p
}

const join = (p: Player, joinedAt: number) => p.mm.join(`w-${p.mm.id}`, `s-${p.mm.id}`, joinedAt)
const settle = (ms = 2000) => vi.advanceTimersByTime(ms)
const TICK = 500

/** Join everyone while proposals are dropped, so the order of joins cannot decide who pairs. */
function joinTogether(entries: [Player, number][]) {
  bus.drop = (m) => m.payload.type === 'propose'
  entries.forEach(([p, at]) => join(p, at))
  bus.drop = () => false
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
  it('older joinedAt becomes X, the other O', () => {
    const a = make('a')
    const b = make('b')
    join(b, 200)
    join(a, 100)
    settle()
    expect(a.pairs).toHaveLength(1)
    expect(b.pairs).toHaveLength(1)
    expect(a.pairs[0]).toMatchObject({ role: 'x', me: { id: 'a' }, opponent: { id: 'b' } })
    expect(b.pairs[0]).toMatchObject({ role: 'o', me: { id: 'b' }, opponent: { id: 'a' } })
    expect(a.t.trackCalls.at(-1)).toBeNull()
    expect(b.t.trackCalls.at(-1)).toBeNull()
    expect(bus.queue()).toEqual([])
  })

  it('breaks joinedAt ties by id', () => {
    const a = make('a')
    const b = make('b')
    join(b, 100)
    join(a, 100)
    settle()
    expect(a.pairs[0].role).toBe('x')
    expect(b.pairs[0].role).toBe('o')
  })

  it('pairs when the older peer next ticks, or at once if the newer one is the proposer', () => {
    const a = make('a')
    const b = make('b')
    join(b, 2)
    join(a, 1) // a is older and sees b already queued, so it proposes on join
    expect(a.pairs).toHaveLength(1)
    expect(b.pairs).toHaveLength(1)
  })

  it('does not pair a lone peer', () => {
    const a = make('a')
    join(a, 1)
    settle()
    expect(a.pairs).toEqual([])
    expect(a.t.sent).toEqual([])
  })
})

describe('FIFO with several peers', () => {
  it('pairs the two oldest first and leaves the rest queued', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(make)
    joinTogether([[c, 300], [a, 100], [b, 200]])
    settle()
    expect(a.pairs[0].opponent.id).toBe('b')
    expect(b.pairs[0].opponent.id).toBe('a')
    expect(c.pairs).toEqual([])
    expect(bus.queue().map((p) => p.id)).toEqual(['c'])
  })

  it('makes two pairs from four', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(make)
    joinTogether([[d, 4], [b, 2], [c, 3], [a, 1]])
    settle()
    expect(a.pairs[0]).toMatchObject({ role: 'x', opponent: { id: 'b' } })
    expect(b.pairs[0]).toMatchObject({ role: 'o', opponent: { id: 'a' } })
    expect(c.pairs[0]).toMatchObject({ role: 'x', opponent: { id: 'd' } })
    expect(d.pairs[0]).toMatchObject({ role: 'o', opponent: { id: 'c' } })
    ;[a, b, c, d].forEach((p) => expect(p.pairs).toHaveLength(1))
  })

  it('a late arrival waits behind an existing odd one out', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(make)
    joinTogether([[a, 1], [b, 2], [c, 3]])
    settle()
    join(d, 4)
    settle()
    expect(c.pairs[0].opponent.id).toBe('d')
    expect(d.pairs[0].opponent.id).toBe('c')
  })
})

describe('rejoining', () => {
  it('keeps its place in line with the original joinedAt', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(make)
    joinTogether([[a, 100], [b, 200]])
    settle()
    join(c, 300)
    settle()
    expect(c.pairs).toEqual([])
    // a's match failed; it rejoins with the original joinedAt and is older than c again.
    join(a, 100)
    expect(a.pairs).toHaveLength(2)
    expect(a.pairs[1]).toMatchObject({ role: 'x', opponent: { id: 'c' } })
    expect(c.pairs[0]).toMatchObject({ role: 'o', opponent: { id: 'a' } })
  })

  it('goes to the back of the line with a fresh joinedAt', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(make)
    joinTogether([[a, 100], [b, 200]])
    settle()
    join(c, 300)
    a.mm.join('w', 's') // Date.now() under fake timers, far above 300
    settle(TICK)
    expect(c.pairs[0]).toMatchObject({ role: 'x', opponent: { id: 'a' } })
    expect(a.pairs[1]).toMatchObject({ role: 'o', opponent: { id: 'c' } })
  })
})

describe('leave', () => {
  it('removes you from the queue and stops you pairing', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    a.mm.leave()
    expect(a.mm.queued).toBeNull()
    expect(bus.queue()).toEqual([])
    join(b, 2)
    settle(TICK)
    settle()
    expect(a.pairs).toEqual([])
    expect(b.pairs).toEqual([])
  })

  it('ignores everything delivered after leave', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    a.mm.leave()
    b.t.send({ to: 'a', from: { id: 'b', wallet: 'w', session: 's', joinedAt: 2 }, payload: { type: 'propose' } })
    b.t.send({ to: 'a', from: { id: 'b', wallet: 'w', session: 's', joinedAt: 2 }, payload: { type: 'cancel' } })
    expect(a.pairs).toEqual([])
    expect(a.direct).toEqual([])
    expect(a.t.sent).toEqual([])
  })

  it('does not untrack again after pairing already did', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    join(b, 2)
    settle(TICK)
    const calls = a.t.trackCalls.length
    a.mm.leave()
    expect(a.t.trackCalls).toHaveLength(calls)
    expect(a.mm.queued).toBeNull()
  })

  it('can rejoin after leaving', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    a.mm.leave()
    join(a, 1)
    join(b, 2)
    settle(TICK)
    expect(a.pairs[0].opponent.id).toBe('b')
  })
})

describe('addressing', () => {
  it('ignores messages addressed to someone else', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    join(b, 2)
    settle(TICK)
    const peer: Peer = { id: 'z', wallet: 'w', session: 's', joinedAt: 0 }
    a.pairs.length = 0
    b.t.send({ to: 'someone-else', from: peer, payload: { type: 'cancel' } })
    expect(a.direct).toEqual([])
    expect(b.direct).toEqual([])
  })

  it('ignores messages while not joined', () => {
    const a = make('a')
    const b = make('b')
    join(b, 1)
    b.mm.send(a.mm.queued ?? { id: 'a', wallet: '', session: '', joinedAt: 0 }, { type: 'cancel' })
    expect(a.direct).toEqual([])
  })
})

describe('lost messages', () => {
  it('the proposer keeps proposing until the accept gets through', () => {
    const a = make('a')
    const b = make('b')
    bus.drop = (m) => m.payload.type === 'accept'
    join(a, 1)
    join(b, 2)
    settle(TICK)
    expect(b.pairs).toHaveLength(1)
    expect(a.pairs).toEqual([])
    settle(1500)
    expect(a.pairs).toEqual([])
    // b answers each repeated propose with another accept.
    expect(b.t.sent.filter((m) => m.payload.type === 'accept').length).toBeGreaterThan(1)
    bus.drop = () => false
    settle(600)
    expect(a.pairs).toHaveLength(1)
    expect(a.pairs[0]).toMatchObject({ role: 'x', opponent: { id: 'b' } })
    expect(b.pairs).toHaveLength(1)
  })

  it('gives up on a vanished peer after a while', () => {
    const a = make('a')
    const b = make('b')
    bus.drop = (m) => m.payload.type === 'accept'
    join(a, 1)
    join(b, 2)
    settle(6000)
    const n = a.t.sent.length
    settle()
    expect(a.t.sent).toHaveLength(n)
    expect(a.pairs).toEqual([])
  })

  it('stops asking a peer that is still queued but no longer next in line', () => {
    const [a, b, z] = ['a', 'b', 'z'].map(make)
    bus.drop = (m) => m.payload.type === 'propose'
    join(a, 10)
    join(b, 20)
    settle(TICK)
    join(z, 5) // older than a, so a is now the one proposed to
    const n = a.t.sent.length
    settle()
    expect(a.t.sent.slice(n).filter((m) => m.to === 'b')).toEqual([])
  })

  it('a lost propose is retried on the next tick', () => {
    const a = make('a')
    const b = make('b')
    bus.drop = (m) => m.payload.type === 'propose'
    join(a, 1)
    join(b, 2)
    settle(TICK)
    settle(1000)
    expect(b.pairs).toEqual([])
    bus.drop = () => false
    settle(600)
    expect(a.pairs).toHaveLength(1)
    expect(b.pairs).toHaveLength(1)
  })

  it('stops proposing once paired', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    join(b, 2)
    settle(TICK)
    const n = a.t.sent.length
    settle()
    expect(a.t.sent).toHaveLength(n)
  })
})

describe('stray accept', () => {
  it('a paired peer cancels a third peer that accepts', () => {
    const a = make('a')
    const b = make('b')
    const c = make('c')
    join(a, 1)
    join(b, 2)
    settle(TICK)
    const cPeer: Peer = { id: 'c', wallet: 'w', session: 's', joinedAt: 3 }
    c.t.send({ to: 'a', from: cPeer, payload: { type: 'accept' } })
    const cancel = a.t.sent.find((m) => m.payload.type === 'cancel')
    expect(cancel).toMatchObject({ to: 'c', from: { id: 'a' } })
    expect(a.pairs).toHaveLength(1)
    expect(a.pairs[0].opponent.id).toBe('b')
  })

  it('does not cancel the opponent re-sending its accept', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    join(b, 2)
    settle(TICK)
    b.t.send({ to: 'a', from: b.mm.queued ?? { id: 'b', wallet: '', session: '', joinedAt: 2 }, payload: { type: 'accept' } })
    expect(a.t.sent.some((m) => m.payload.type === 'cancel')).toBe(false)
    expect(a.pairs).toHaveLength(1)
  })
})

describe('direct messages', () => {
  it('delivers offer, started and cancel to onDirect with the sender', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    join(b, 2)
    settle(TICK)
    const offer: Direct = { type: 'offer', tx: 'tx', game: 'g', nonce: 'n', blockhash: 'h', lastValidBlockHeight: '9' }
    const bPeer = b.pairs[0].me
    const aPeer = a.pairs[0].me
    a.mm.send(bPeer, offer)
    a.mm.send(bPeer, { type: 'started', game: 'g' })
    a.mm.send(bPeer, { type: 'cancel' })
    expect(b.direct.map((d) => d.msg)).toEqual([offer, { type: 'started', game: 'g' }, { type: 'cancel' }])
    b.direct.forEach((d) => expect(d.from).toEqual(aPeer))
    expect(a.direct).toEqual([])
    b.mm.send(aPeer, { type: 'started', game: 'g' })
    expect(a.direct).toEqual([{ msg: { type: 'started', game: 'g' }, from: bPeer }])
  })

  it('does not hand propose or accept to onDirect', () => {
    const a = make('a')
    const b = make('b')
    join(a, 1)
    join(b, 2)
    settle(TICK)
    expect(a.direct).toEqual([])
    expect(b.direct).toEqual([])
  })

  it('unsubscribed listeners stop receiving', () => {
    const a = make('a')
    const b = make('b')
    const fn = vi.fn()
    const off = b.mm.onDirect(fn)
    join(a, 1)
    join(b, 2)
    settle(TICK)
    off()
    a.mm.send(b.pairs[0].me, { type: 'cancel' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('send is a no-op when not joined', () => {
    const a = make('a')
    a.mm.send({ id: 'b', wallet: '', session: '', joinedAt: 0 }, { type: 'cancel' })
    expect(a.t.sent).toEqual([])
  })
})

describe('queue counts', () => {
  it('reports the count immediately and on each change', () => {
    const a = make('a')
    const counts: number[] = []
    a.mm.onQueueSize((n) => counts.push(n))
    expect(counts).toEqual([0])
    a.mm.join('w', 's', 1)
    expect(counts.at(-1)).toBe(1)
  })

  it('counts others plus ourselves, without double counting', () => {
    const a = make('a')
    const b = make('b')
    const c = make('c')
    const seen = vi.fn()
    c.mm.onQueueSize(seen)
    join(a, 1)
    expect(seen).toHaveBeenLastCalledWith(1)
    join(b, 2) // pairs with a straight away
    settle(TICK)
    expect(seen).toHaveBeenLastCalledWith(0)
  })

  it('a spectator that never joins sees the queue size', () => {
    const spectator = make('spectator')
    const a = make('a')
    const b = make('b')
    const c = make('c')
    const seen = vi.fn()
    spectator.mm.onQueueSize(seen)
    expect(seen).toHaveBeenLastCalledWith(0)
    join(a, 1)
    expect(seen).toHaveBeenLastCalledWith(1)
    join(b, 2)
    settle(TICK)
    expect(seen).toHaveBeenLastCalledWith(0)
    join(c, 3)
    expect(seen).toHaveBeenLastCalledWith(1)
    c.mm.leave()
    expect(seen).toHaveBeenLastCalledWith(0)
    expect(spectator.pairs).toEqual([])
    expect(spectator.t.sent).toEqual([])
  })

  it('a queued peer counts itself once the others are paired away', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(make)
    const seen = vi.fn()
    c.mm.onQueueSize(seen)
    join(a, 1)
    join(c, 3)
    join(b, 2)
    settle(TICK)
    settle()
    // a and b paired, c alone in the queue.
    expect(seen).toHaveBeenLastCalledWith(1)
  })

  it('a paired peer no longer counts itself', () => {
    const a = make('a')
    const b = make('b')
    const seen = vi.fn()
    a.mm.onQueueSize(seen)
    join(a, 1)
    join(b, 2)
    settle(TICK)
    settle()
    expect(seen).toHaveBeenLastCalledWith(0)
  })

  it('unsubscribing stops updates', () => {
    const a = make('a')
    const fn = vi.fn()
    const off = a.mm.onQueueSize(fn)
    off()
    fn.mockClear()
    settle()
    expect(fn).not.toHaveBeenCalled()
  })
})
