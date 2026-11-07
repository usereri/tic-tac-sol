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

const peer = (id: string, joinedAt = 1): Peer => ({ id, wallet: `w${id}`, session: `s${id}`, joinedAt })
const env = (to: string, from = peer('b')): Envelope => ({ to, from, payload: { type: 'cancel' } })
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
    expect(last().track).toHaveBeenCalledWith(peer('a'))
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
      k1: [{ ...peer('a'), presence_ref: 'r' }, { id: 1 }, null, { id: 'q', wallet: 'w', session: 's' }],
      k2: [peer('b', 2)],
    }
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
    for (const bad of [null, {}, { to: 'a' }, { to: 'a', from: { id: 'b' }, payload: { type: 'cancel' } }, { to: 'a', from: peer('b'), payload: {} }, { to: 1, from: peer('b'), payload: { type: 'x' } }]) {
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
    expect(channels[1].track).toHaveBeenCalledWith(peer('a'))
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
})
