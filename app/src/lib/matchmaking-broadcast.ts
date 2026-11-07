import type { Envelope, Peer, Transport, TransportEvents } from './matchmaking-core'

type Wire =
  | { kind: 'hello'; peer: Peer }
  | { kind: 'bye'; id: string }
  | { kind: 'direct'; msg: Envelope }

const CHANNEL = 'ttsol:queue'
const HEARTBEAT_MS = 500
const EXPIRE_MS = 2000

/** Pairs tabs of the same browser, which is enough for local testing against surfpool. */
export class BroadcastTransport implements Transport {
  private channel = new BroadcastChannel(CHANNEL)
  private seen = new Map<string, { peer: Peer; at: number }>()
  private me: Peer | null = null
  private timer = setInterval(() => this.hello(), HEARTBEAT_MS)

  start(on: TransportEvents) {
    this.channel.onmessage = ({ data }: MessageEvent<Wire>) => {
      if (data.kind === 'hello') {
        const known = this.seen.has(data.peer.id)
        this.seen.set(data.peer.id, { peer: data.peer, at: Date.now() })
        if (!known) on.peers()
      } else if (data.kind === 'bye') {
        if (this.seen.delete(data.id)) on.peers()
      } else {
        on.direct(data.msg)
      }
    }
  }

  track(peer: Peer | null) {
    if (!peer && this.me) this.post({ kind: 'bye', id: this.me.id })
    this.me = peer
    this.hello()
  }

  peers() {
    const now = Date.now()
    for (const [id, { at }] of this.seen) if (now - at > EXPIRE_MS) this.seen.delete(id)
    return [...this.seen.values()].map((s) => s.peer)
  }

  send(msg: Envelope) {
    this.post({ kind: 'direct', msg })
  }

  close() {
    clearInterval(this.timer)
    this.channel.close()
  }

  private hello() {
    if (this.me) this.post({ kind: 'hello', peer: this.me })
  }

  private post(msg: Wire) {
    this.channel.postMessage(msg)
  }
}
