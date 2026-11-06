/**
 * First-in, first-out matchmaking. Nothing touches the chain until two players are paired.
 *
 * This transport is a BroadcastChannel, so it pairs tabs of the same browser: enough for
 * local testing against surfpool. The devnet build swaps in a Supabase Realtime transport
 * with the same messages.
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

type Wire =
  | { kind: 'hello'; peer: Peer }
  | { kind: 'bye'; id: string }
  | { kind: 'direct'; to: string; from: Peer; payload: Direct }

const CHANNEL = 'ttsol:queue'
const HEARTBEAT_MS = 500
const EXPIRE_MS = 2000

export type Pairing = { role: 'x' | 'o'; me: Peer; opponent: Peer }

export class Matchmaker {
  readonly id = crypto.randomUUID()
  private channel = new BroadcastChannel(CHANNEL)
  private peers = new Map<string, { peer: Peer; seen: number }>()
  private me: Peer | null = null
  private paired: Pairing | null = null
  private timer: ReturnType<typeof setInterval>
  private queueListeners = new Set<(count: number) => void>()
  private pairListeners = new Set<(p: Pairing) => void>()
  private directListeners = new Set<(msg: Direct, from: Peer) => void>()

  constructor() {
    this.channel.onmessage = (e: MessageEvent<Wire>) => this.receive(e.data)
    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS)
  }

  /** Enter the queue. Pass the original `joinedAt` to keep your place after a failed match. */
  join(wallet: string, session: string, joinedAt = Date.now()) {
    this.me = { id: this.id, wallet, session, joinedAt }
    this.paired = null
    this.tick()
  }

  leave() {
    if (this.me) this.post({ kind: 'bye', id: this.id })
    this.me = null
  }

  get queued() {
    return this.me
  }

  send(to: Peer, payload: Direct) {
    if (!this.me) return
    this.post({ kind: 'direct', to: to.id, from: this.me, payload })
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
    this.channel.close()
  }

  private post(msg: Wire) {
    this.channel.postMessage(msg)
  }

  private count() {
    return this.alive().length + (this.me && !this.paired ? 1 : 0)
  }

  private alive() {
    const now = Date.now()
    for (const [id, { seen }] of this.peers) if (now - seen > EXPIRE_MS) this.peers.delete(id)
    return [...this.peers.values()].map((p) => p.peer)
  }

  private tick() {
    const queue = this.alive()
    if (this.me && !this.paired) {
      this.post({ kind: 'hello', peer: this.me })
      // Everyone sorts the same way, so the two oldest pair up. The older one proposes.
      const all = [...queue, this.me].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
      const i = all.findIndex((p) => p.id === this.id)
      if (i % 2 === 0 && all[i + 1]) this.send(all[i + 1], { type: 'propose' })
    }
    this.queueListeners.forEach((fn) => fn(this.count()))
  }

  private setPaired(p: Pairing) {
    this.paired = p
    this.post({ kind: 'bye', id: this.id })
    this.pairListeners.forEach((fn) => fn(p))
  }

  private receive(msg: Wire) {
    if (msg.kind === 'hello') {
      if (msg.peer.id !== this.id) this.peers.set(msg.peer.id, { peer: msg.peer, seen: Date.now() })
      return
    }
    if (msg.kind === 'bye') {
      this.peers.delete(msg.id)
      return
    }
    if (msg.to !== this.id || !this.me) return
    const { from, payload } = msg
    if (payload.type === 'propose') {
      if (this.paired) return
      this.send(from, { type: 'accept' })
      this.setPaired({ role: 'o', me: this.me, opponent: from })
      return
    }
    if (payload.type === 'accept') {
      if (this.paired) return
      this.setPaired({ role: 'x', me: this.me, opponent: from })
      return
    }
    this.directListeners.forEach((fn) => fn(payload, from))
  }
}

export const matchmaker = new Matchmaker()
