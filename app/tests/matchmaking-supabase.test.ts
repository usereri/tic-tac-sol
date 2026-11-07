import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Envelope, Peer } from '../src/lib/matchmaking-core'

type Status = 'SUBSCRIBED' | 'CLOSED' | 'CHANNEL_ERROR' | 'TIMED_OUT'

class FakeChannel {
  handlers: Record<string, (arg: any) => void> = {}
  statusCb: ((status: Status, err?: Error) => void) | null = null
  track = vi.fn()
  untrack = vi.fn()
  send = vi.fn()
  presence: Record<string, unknown[]> = {}
  presenceState = () => this.presence

  on(type: string, filter: { event: string }, cb: (arg: any) => void) {
    this.handlers[`${type}:${filter.event}`] = cb
    return this
  }
  subscribe(cb: (status: Status, err?: Error) => void) {
    this.statusCb = cb
    return this
  }
  status(s: Status, err?: Error) {
    this.statusCb?.(s, err)
  }
}

const channels: FakeChannel[] = []
const removeChannel = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  RealtimeClient: class {
    channel() {
      const c = new FakeChannel()
      channels.push(c)
      return c
    }
    removeChannel = removeChannel
  },
}))

const { SupabaseTransport } = await import('../src/lib/matchmaking-supabase')

const peer = (id: string, joinedAt = 1): Peer => ({ id, wallet: `w${id}`, session: id, stake: '1000', joinedAt, proof: { message: `join ${id}`, signature: `sig ${id}` } })
const entry = (id: string, hb: number, joinedAt = 1) => ({ ...peer(id, joinedAt), hb })
const env = (to: string): Envelope => ({ to, body: '{}', sig: 'sig' })
const last = () => channels[channels.length - 1]

let events: { peers: Mock<() => void>; direct: Mock<(msg: Envelope) => void> }
let t: InstanceType<typeof SupabaseTransport>

beforeEach(() => {
  vi.useFakeTimers()
  channels.length = 0
  removeChannel.mockClear()
  events = { peers: vi.fn(), direct: vi.fn() }
  t = new SupabaseTransport('https://x.supabase.co', 'key', 'topic')
  t.start(events)
})

afterEach(() => vi.useRealTimers())

describe('SupabaseTransport', () => {
  it('defers track() until SUBSCRIBED', () => {
    t.track(peer('a'))
    expect(last().track).not.toHaveBeenCalled()
    last().status('SUBSCRIBED')
    expect(last().track).toHaveBeenCalledWith(entry('a', 1))
  })

  it('tracks and untracks directly once subscribed', () => {
    last().status('SUBSCRIBED')
    t.track(peer('a'))
    expect(last().track).toHaveBeenCalledTimes(1)
    t.track(null)
    expect(last().untrack).toHaveBeenCalledTimes(1)
  })

  it('tracks nothing on SUBSCRIBED if the latest track() was null', () => {
    t.track(peer('a'))
    t.track(null)
    last().status('SUBSCRIBED')
    expect(last().track).not.toHaveBeenCalled()
  })

  it('defers send() until SUBSCRIBED, then flushes in order', () => {
    t.send(env('x'))
    t.send(env('y'))
    expect(last().send).not.toHaveBeenCalled()
    last().status('SUBSCRIBED')
    expect(last().send.mock.calls.map(([m]) => m.payload.to)).toEqual(['x', 'y'])
    expect(last().send.mock.calls[0][0]).toMatchObject({ type: 'broadcast', event: 'direct' })
    t.send(env('z'))
    expect(last().send).toHaveBeenCalledTimes(3)
  })

  it('keeps only the newest 32 queued messages', () => {
    for (let i = 0; i < 40; i++) t.send(env(String(i)))
    last().status('SUBSCRIBED')
    const sent = last().send.mock.calls.map(([m]) => m.payload.to)
    expect(sent).toHaveLength(32)
    expect(sent[0]).toBe('8')
  })

  it('re-tracks the current peer on a second SUBSCRIBED', () => {
    t.track(peer('a'))
    last().status('SUBSCRIBED')
    last().status('TIMED_OUT')
    last().status('SUBSCRIBED')
    expect(last().track).toHaveBeenCalledTimes(2)
  })

  it('peers() is empty until subscribed and ignores malformed entries', () => {
    const c = last()
    c.presence = {
      k1: [
        entry('a', 1),
        { id: 1 },
        null,
        { ...peer('q'), hb: 1, stake: undefined },
        { ...peer('r') }, // no hb
        { ...peer('s'), hb: '1' },
        { ...peer('t'), hb: 1, stake: 5 },
      ],
      k2: [entry('b', 1, 2)],
    }
    c.handlers['presence:sync']({})
    expect(t.peers()).toEqual([])
    c.status('SUBSCRIBED')
    expect(t.peers()).toEqual([peer('a'), peer('b', 2)])
    c.status('TIMED_OUT')
    expect(t.peers()).toEqual([])
  })

  it('notifies on presence sync and on status changes', () => {
    last().handlers['presence:sync']({})
    expect(events.peers).toHaveBeenCalledTimes(1)
    last().status('SUBSCRIBED')
    expect(events.peers).toHaveBeenCalledTimes(2)
  })

  it('delivers well-formed broadcasts and drops malformed ones', () => {
    const on = last().handlers['broadcast:direct']
    const good = env('a')
    on({ payload: good })
    expect(events.direct).toHaveBeenCalledWith(good)
    for (const bad of [null, {}, { to: 'a' }, { to: 'a', body: 'b' }, { to: 'a', sig: 's' }, { to: 1, body: 'b', sig: 's' }, { to: 'a', body: 5, sig: 's' }, { to: 'a', body: 'b', sig: null }]) {
      on({ payload: bad })
    }
    expect(events.direct).toHaveBeenCalledTimes(1)
  })

  it('opens a new channel after the retry delay on CLOSED', () => {
    t.track(peer('a'))
    last().status('CLOSED')
    expect(channels).toHaveLength(1)
    vi.advanceTimersByTime(2999)
    expect(channels).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(channels).toHaveLength(2)
    channels[1].status('SUBSCRIBED')
    expect(channels[1].track).toHaveBeenCalledWith(entry('a', 1))
  })

  it('ignores status callbacks from a replaced channel', () => {
    last().status('CLOSED')
    vi.advanceTimersByTime(3000)
    channels[0].status('SUBSCRIBED')
    expect(t.peers()).toEqual([])
    expect(channels[0].track).not.toHaveBeenCalled()
  })

  it('does not reconnect after close()', () => {
    last().status('CLOSED')
    t.close()
    vi.advanceTimersByTime(10_000)
    expect(channels).toHaveLength(1)
    expect(removeChannel).toHaveBeenCalledWith(channels[0])
  })

  it('does not reconnect when CLOSED arrives after close()', () => {
    t.close()
    last().status('CLOSED')
    vi.advanceTimersByTime(10_000)
    expect(channels).toHaveLength(1)
  })

  it('warns when a status carries an error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    last().status('CHANNEL_ERROR', new Error('boom'))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  describe('heartbeat', () => {
    const present = (...entries: object[]) => {
      last().presence = { k: entries }
      last().handlers['presence:sync']({})
    }

    /** Make the fake server apply our track/untrack to presence under our own key, as the real one does. */
    const echo = () => {
      const key: string = t['key']
      last().track.mockImplementation((payload: object) => void (last().presence[key] = [payload]))
      last().untrack.mockImplementation(() => void delete last().presence[key])
    }

    it('publishes hb with track() and bumps it every 5 s', () => {
      echo()
      last().status('SUBSCRIBED')
      t.track(peer('a'))
      expect(last().track).toHaveBeenLastCalledWith(entry('a', 1))
      vi.advanceTimersByTime(5000)
      expect(last().track).toHaveBeenLastCalledWith(entry('a', 2))
      vi.advanceTimersByTime(5000)
      expect(last().track).toHaveBeenLastCalledWith(entry('a', 3))
      expect(last().track).toHaveBeenCalledTimes(3)
    })

    it('tracks again within a second when the server dropped our track', () => {
      last().status('SUBSCRIBED')
      t.track(peer('a')) // never shows up in presence
      vi.advanceTimersByTime(1000)
      expect(last().track).toHaveBeenLastCalledWith(entry('a', 2))
      vi.advanceTimersByTime(1000)
      expect(last().track).toHaveBeenLastCalledWith(entry('a', 3))
      echo()
      last().track(entry('a', 3)) // the server finally applies it
      last().track.mockClear()
      vi.advanceTimersByTime(4000)
      expect(last().track).not.toHaveBeenCalled()
    })

    it('untracks again when our entry is still there after untrack', () => {
      echo()
      last().status('SUBSCRIBED')
      t.track(peer('a'))
      last().untrack.mockImplementation(() => {}) // dropped by the server
      vi.advanceTimersByTime(1000)
      t.track(null)
      expect(last().untrack).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1000)
      expect(last().untrack).toHaveBeenCalledTimes(2)
      delete last().presence[t['key']]
      vi.advanceTimersByTime(5000)
      expect(last().untrack).toHaveBeenCalledTimes(2)
    })

    it('does not publish while not tracking or not subscribed', () => {
      vi.advanceTimersByTime(10_000)
      t.track(peer('a'))
      vi.advanceTimersByTime(10_000)
      expect(last().track).not.toHaveBeenCalled()
      last().status('SUBSCRIBED')
      t.track(null)
      vi.advanceTimersByTime(10_000)
      expect(last().track).toHaveBeenCalledTimes(1) // only the SUBSCRIBED publish before track(null)
      expect(last().untrack).toHaveBeenCalledTimes(1)
    })

    it('stops publishing after close()', () => {
      last().status('SUBSCRIBED')
      t.track(peer('a'))
      t.close()
      last().track.mockClear()
      vi.advanceTimersByTime(20_000)
      expect(last().track).not.toHaveBeenCalled()
    })

    it('drops an entry whose hb stops growing for over 15 s', () => {
      last().status('SUBSCRIBED')
      present(entry('a', 1))
      expect(t.peers()).toEqual([peer('a')])
      vi.advanceTimersByTime(15_000)
      expect(t.peers()).toEqual([peer('a')])
      vi.advanceTimersByTime(1)
      expect(t.peers()).toEqual([])
    })

    it('keeps an entry that keeps bumping', () => {
      last().status('SUBSCRIBED')
      present(entry('a', 1))
      for (let hb = 2; hb <= 6; hb++) {
        vi.advanceTimersByTime(5000)
        present(entry('a', hb))
        expect(t.peers()).toEqual([peer('a')])
      }
    })

    it('does not refresh on a lower or equal hb', () => {
      last().status('SUBSCRIBED')
      present(entry('a', 5))
      vi.advanceTimersByTime(10_000)
      present(entry('a', 5))
      present(entry('a', 4))
      vi.advanceTimersByTime(6000)
      expect(t.peers()).toEqual([])
    })

    it('refreshes on a higher hb after a stale spell', () => {
      last().status('SUBSCRIBED')
      present(entry('a', 1))
      vi.advanceTimersByTime(20_000)
      expect(t.peers()).toEqual([])
      present(entry('a', 2))
      expect(t.peers()).toEqual([peer('a')])
    })

    it('removes ids that leave presence', () => {
      last().status('SUBSCRIBED')
      present(entry('a', 1), entry('b', 1))
      expect(t.peers()).toHaveLength(2)
      present(entry('b', 2))
      expect(t.peers()).toEqual([peer('b')])
      present()
      expect(t.peers()).toEqual([])
    })

    it('strips hb from the peers it returns and tells the matchmaker on sync', () => {
      last().status('SUBSCRIBED')
      events.peers.mockClear()
      present(entry('a', 1))
      expect(events.peers).toHaveBeenCalledTimes(1)
      expect(t.peers()[0]).not.toHaveProperty('hb')
    })

    it('ignores entries without a well-formed proof', () => {
      last().status('SUBSCRIBED')
      const { proof: _p, ...noProof } = entry('a', 1)
      present(
        noProof,
        { ...entry('b', 1), proof: null },
        { ...entry('d', 1), proof: { message: 'm' } },
        { ...entry('e', 1), proof: { signature: 's' } },
        { ...entry('f', 1), proof: { message: 1, signature: 's' } },
        entry('c', 1),
      )
      expect(t.peers()).toEqual([peer('c')])
    })

    it('passes the proof through unchanged and drops extra fields', () => {
      last().status('SUBSCRIBED')
      present({ ...entry('a', 1), extra: true, proof: { message: 'm', signature: 's', more: 1 } })
      expect(t.peers()).toEqual([{ ...peer('a'), proof: { message: 'm', signature: 's' } }])
    })

    it('ignores entries without stake or hb', () => {
      last().status('SUBSCRIBED')
      present({ ...peer('a'), hb: 1, stake: undefined }, { ...peer('b') }, entry('c', 1))
      expect(t.peers()).toEqual([peer('c')])
    })
  })
})
