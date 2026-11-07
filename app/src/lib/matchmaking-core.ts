/**
 * First-in, first-out matchmaking. Nothing touches the chain until two players are paired.
 *
 * The pairing logic lives here and reaches other players through a `Transport`, so the same
 * rules run over a BroadcastChannel (local testing) or Supabase Realtime (devnet).
 */

export type Peer = {
  id: string
  wallet: string
  session: string
  joinedAt: number
}

export type Direct =
  | { type: 'propose' }
  | { type: 'accept' }
  | { type: 'offer'; tx: string; game: string; nonce: string; blockhash: string; lastValidBlockHeight: string }
  | { type: 'started'; game: string }
  | { type: 'cancel' }

/** A direct message. Every transport delivers it to everyone; the receiver checks `to`. */
export type Envelope = { to: string; from: Peer; payload: Direct }

export type TransportEvents = {
  /** The queue changed. */
  peers: () => void
  direct: (msg: Envelope) => void
}

/** How the matchmaker reaches other players. Calls may arrive before the transport is connected. */
export interface Transport {
  start(on: TransportEvents): void
  /** Show `peer` in the queue, or take ours out with null. */
  track(peer: Peer | null): void
  /** Everyone in the queue right now, possibly including ourselves. */
  peers(): Peer[]
  /** Best effort: the matchmaker retries proposals, and Play times out the rest. */
  send(msg: Envelope): void
  close(): void
}

const TICK_MS = 500
const LINGER_MS = 5000

export type Pairing = { role: 'x' | 'o'; me: Peer; opponent: Peer }

export class Matchmaker {
  readonly id: string
  private transport: Transport
  private me: Peer | null = null
  private paired: Pairing | null = null
  private proposal: { to: Peer; until: number } | null = null
  private timer: ReturnType<typeof setInterval>
  private queueListeners = new Set<(count: number) => void>()
  private pairListeners = new Set<(p: Pairing) => void>()
  private directListeners = new Set<(msg: Direct, from: Peer) => void>()

  constructor(transport: Transport, id: string = crypto.randomUUID()) {
    this.id = id
    this.transport = transport
    transport.start({ peers: () => this.notify(), direct: (msg) => this.receive(msg) })
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  /** Enter the queue. Pass the original `joinedAt` to keep your place after a failed match. */
  join(wallet: string, session: string, joinedAt = Date.now()) {
    this.me = { id: this.id, wallet, session, joinedAt }
    this.paired = null
    this.proposal = null
    this.transport.track(this.me)
    this.tick()
  }

  leave() {
    // Pairing already took us out of the queue.
    if (this.me && !this.paired) this.transport.track(null)
    this.me = null
  }

  get queued() {
    return this.me
  }

  send(to: Peer, payload: Direct) {
    if (!this.me) return
    this.transport.send({ to: to.id, from: this.me, payload })
  }

  onQueueSize(fn: (count: number) => void) {
    this.queueListeners.add(fn)
    fn(this.count())
    return () => void this.queueListeners.delete(fn)
  }

  onPaired(fn: (p: Pairing) => void) {
    this.pairListeners.add(fn)
    return () => void this.pairListeners.delete(fn)
  }

  onDirect(fn: (msg: Direct, from: Peer) => void) {
    this.directListeners.add(fn)
    return () => void this.directListeners.delete(fn)
  }

  dispose() {
    this.leave()
    clearInterval(this.timer)
    this.transport.close()
  }

  private others() {
    return this.transport.peers().filter((p) => p.id !== this.id)
  }

  private count() {
    return this.others().length + (this.me && !this.paired ? 1 : 0)
  }

  private notify() {
    const count = this.count()
    this.queueListeners.forEach((fn) => fn(count))
  }

  private tick() {
    if (this.me && !this.paired) {
      // Everyone sorts the same way, so the two oldest pair up. The older one proposes.
      const all = [...this.others(), this.me].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
      const i = all.findIndex((p) => p.id === this.id)
      const next = i % 2 === 0 ? all[i + 1] : undefined
      const last = this.proposal
      if (next) this.proposal = { to: next, until: Date.now() + LINGER_MS }
      // If they dropped out of the queue they may have accepted and lost the reply, so keep asking a while.
      else if (last && (Date.now() > last.until || all.some((p) => p.id === last.to.id))) this.proposal = null
      if (this.proposal) this.send(this.proposal.to, { type: 'propose' })
    }
    this.notify()
  }

  private setPaired(p: Pairing) {
    this.paired = p
    this.proposal = null
    this.transport.track(null)
    this.pairListeners.forEach((fn) => fn(p))
  }

  private receive({ to, from, payload }: Envelope) {
    if (to !== this.id || !this.me) return
    if (payload.type === 'propose') {
      if (this.paired) {
        // They are still proposing, so our accept was lost: say it again.
        if (this.paired.role === 'o' && this.paired.opponent.id === from.id) this.send(from, { type: 'accept' })
        return
      }
      this.send(from, { type: 'accept' })
      this.setPaired({ role: 'o', me: this.me, opponent: from })
      return
    }
    if (payload.type === 'accept') {
      if (this.paired) {
        // The queue shifted between two proposals and both accepted: release the late one.
        if (this.paired.opponent.id !== from.id) this.send(from, { type: 'cancel' })
        return
      }
      this.setPaired({ role: 'x', me: this.me, opponent: from })
      return
    }
    this.directListeners.forEach((fn) => fn(payload, from))
  }
}
