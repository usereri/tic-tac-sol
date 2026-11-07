import { RealtimeClient, type RealtimeChannel } from '@supabase/supabase-js'
import type { Envelope, Peer, Transport, TransportEvents } from './matchmaking-core'

const RETRY_MS = 3000
const OUTBOX_MAX = 32

const isPeer = (p: any): p is Peer =>
  typeof p?.id === 'string' && typeof p.wallet === 'string' && typeof p.session === 'string' && typeof p.joinedAt === 'number'

const isEnvelope = (m: any): m is Envelope => typeof m?.to === 'string' && isPeer(m.from) && typeof m.payload?.type === 'string'

/**
 * Supabase Realtime, no tables: presence holds the queue, broadcast carries direct messages.
 * Everyone subscribes on load, so spectators see the queue size without joining it.
 *
 * Broadcast on a public channel is unauthenticated: anyone with the anon key can post any
 * message under any `from`. Pairing only decides who talks to whom. What protects a player is
 * O's `checkOffer` in Play.tsx, which inspects the transaction before co-signing. Keep it.
 */
export class SupabaseTransport implements Transport {
  private client: RealtimeClient
  private topic: string
  private key = crypto.randomUUID()
  private channel: RealtimeChannel | null = null
  private on: TransportEvents | null = null
  private me: Peer | null = null
  private outbox: Envelope[] = []
  private subscribed = false
  private closed = false

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
    void (peer ? this.channel.track(peer) : this.channel.untrack())
  }

  peers() {
    if (!this.subscribed || !this.channel) return []
    return Object.values(this.channel.presenceState<Peer>())
      .flat()
      .filter(isPeer)
      .map(({ id, wallet, session, joinedAt }) => ({ id, wallet, session, joinedAt }))
  }

  send(msg: Envelope) {
    if (this.subscribed) return this.push(msg)
    this.outbox.push(msg)
    if (this.outbox.length > OUTBOX_MAX) this.outbox.shift()
  }

  close() {
    this.closed = true
    if (this.channel) void this.client.removeChannel(this.channel)
  }

  private connect() {
    if (this.closed) return
    const channel = this.client.channel(this.topic, { config: { presence: { key: this.key } } })
    this.channel = channel
    channel
      .on('presence', { event: 'sync' }, () => this.on?.peers())
      .on('broadcast', { event: 'direct' }, ({ payload }) => {
        if (isEnvelope(payload)) this.on?.direct(payload)
      })
      .subscribe((status, err) => {
        if (channel !== this.channel) return
        if (err) console.warn(`matchmaking: ${status}`, err)
        this.subscribed = status === 'SUBSCRIBED'
        if (status === 'SUBSCRIBED') {
          // Also fires after every automatic rejoin, when the server has forgotten our presence.
          if (this.me) void channel.track(this.me)
          this.outbox.splice(0).forEach((msg) => this.push(msg))
        } else if (status === 'CLOSED' && !this.closed) {
          // realtime-js retries errors and timeouts by itself, but a closed channel stays closed.
          setTimeout(() => this.connect(), RETRY_MS)
        }
        this.on?.peers()
      })
  }

  private push(msg: Envelope) {
    void this.channel?.send({ type: 'broadcast', event: 'direct', payload: msg })
  }
}
