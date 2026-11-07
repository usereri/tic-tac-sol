import { RealtimeClient, type RealtimeChannel } from '@supabase/supabase-js'
import type { Envelope, Peer, Transport, TransportEvents } from './matchmaking-core'

const RETRY_MS = 3000
const OUTBOX_MAX = 32
const HEARTBEAT_MS = 5000
const EXPIRE_MS = 15_000

/** What we track in presence: the peer plus a counter bumped on every heartbeat. */
type Entry = Peer & { hb: number }

const isEntry = (p: any): p is Entry =>
  typeof p?.id === 'string' && typeof p.wallet === 'string' && typeof p.session === 'string' &&
  typeof p.stake === 'string' && typeof p.joinedAt === 'number' && typeof p.hb === 'number'

const isEnvelope = (m: any): m is Envelope => typeof m?.to === 'string' && typeof m.body === 'string' && typeof m.sig === 'string'

/**
 * Supabase Realtime, no tables: presence holds the queue, broadcast carries direct messages.
 * Everyone subscribes on load, so spectators see the queue without joining it.
 *
 * The server only drops a presence when its socket dies, which can take a while, so queued
 * players re-track every few seconds and anyone silent for 15 s counts as gone.
 *
 * Broadcast and presence on a public channel are unauthenticated: anyone with the anon key can
 * post anything. The matchmaker signs direct messages with session keys, and O's `checkOffer`
 * in Play.tsx inspects the transaction before co-signing. Keep both.
 */
export class SupabaseTransport implements Transport {
  private client: RealtimeClient
  private topic: string
  private key = crypto.randomUUID()
  private channel: RealtimeChannel | null = null
  private on: TransportEvents | null = null
  private me: Peer | null = null
  private hb = 0
  /** Every id in presence, with when we last saw its counter move. */
  private live = new Map<string, { peer: Peer; hb: number; at: number }>()
  private outbox: Envelope[] = []
  private subscribed = false
  private closed = false
  private timer = setInterval(() => this.publish(), HEARTBEAT_MS)

  constructor(url: string, apikey: string, topic: string) {
    const endpoint = new URL('realtime/v1', url.replace(/\/?$/, '/'))
    endpoint.protocol = endpoint.protocol.replace('http', 'ws')
    this.client = new RealtimeClient(endpoint.href, { params: { apikey } })
    this.topic = topic
  }

  start(on: TransportEvents) {
    this.on = on
    this.connect()
  }

  track(peer: Peer | null) {
    this.me = peer
    // Not subscribed yet: the SUBSCRIBED handler applies it.
    if (!this.subscribed || !this.channel) return
    if (peer) this.publish()
    else void this.channel.untrack()
  }

  peers() {
    if (!this.subscribed) return []
    const now = Date.now()
    return [...this.live.values()].filter((l) => now - l.at <= EXPIRE_MS).map((l) => l.peer)
  }

  send(msg: Envelope) {
    if (this.subscribed) return this.push(msg)
    this.outbox.push(msg)
    if (this.outbox.length > OUTBOX_MAX) this.outbox.shift()
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
    if (this.channel) void this.client.removeChannel(this.channel)
  }

  private connect() {
    if (this.closed) return
    const channel = this.client.channel(this.topic, { config: { presence: { key: this.key } } })
    this.channel = channel
    channel
      .on('presence', { event: 'sync' }, () => this.sync(channel))
      .on('broadcast', { event: 'direct' }, ({ payload }) => {
        if (isEnvelope(payload)) this.on?.direct(payload)
      })
      .subscribe((status, err) => {
        if (channel !== this.channel) return
        if (err) console.warn(`matchmaking: ${status}`, err)
        this.subscribed = status === 'SUBSCRIBED'
        if (status === 'SUBSCRIBED') {
          // Also fires after every automatic rejoin, when the server has forgotten our presence.
          this.publish()
          this.outbox.splice(0).forEach((msg) => this.push(msg))
        } else if (status === 'CLOSED' && !this.closed) {
          // realtime-js retries errors and timeouts by itself, but a closed channel stays closed.
          setTimeout(() => this.connect(), RETRY_MS)
        }
        this.on?.peers()
      })
  }

  /** Track ourselves with a bumped counter, which tells the others we are still here. */
  private publish() {
    if (this.me && this.subscribed && this.channel) void this.channel.track({ ...this.me, hb: ++this.hb })
  }

  /** Refresh an id only when its counter grows, so a stale or replayed entry still expires. */
  private sync(channel: RealtimeChannel) {
    if (channel !== this.channel) return
    const now = Date.now()
    const present = new Set<string>()
    for (const e of Object.values(channel.presenceState()).flat()) {
      if (!isEntry(e)) continue
      present.add(e.id)
      const known = this.live.get(e.id)
      if (!known || e.hb > known.hb) {
        const { id, wallet, session, stake, joinedAt } = e
        this.live.set(id, { peer: { id, wallet, session, stake, joinedAt }, hb: e.hb, at: now })
      }
    }
    for (const id of this.live.keys()) if (!present.has(id)) this.live.delete(id)
    this.on?.peers()
  }

  private push(msg: Envelope) {
    void this.channel?.send({ type: 'broadcast', event: 'direct', payload: msg })
  }
}
