import type { Envelope, Peer, Transport, TransportEvents } from '../src/lib/matchmaking-core'

/** The payload type inside a signed envelope, for drop rules and assertions. */
export const typeOf = (env: Envelope): string => JSON.parse(env.body).payload.type

/** In-memory stand-in for the network: tracked peers are the queue, sends reach everyone else. */
export class Bus {
  readonly transports = new Set<FakeTransport>()
  /** Return true to drop a message in flight. */
  drop: (msg: Envelope) => boolean = () => false

  transport() {
    return new FakeTransport(this)
  }

  queue() {
    return [...this.transports].flatMap((t) => (t.tracked ? [t.tracked] : []))
  }

  changed() {
    this.transports.forEach((t) => t.on?.peers())
  }
}

export class FakeTransport implements Transport {
  on: TransportEvents | null = null
  tracked: Peer | null = null
  /** Every value passed to track(), in order. */
  trackCalls: (Peer | null)[] = []
  sent: Envelope[] = []
  closed = false

  constructor(private bus: Bus) {
    bus.transports.add(this)
  }

  start(on: TransportEvents) {
    this.on = on
  }

  track(peer: Peer | null) {
    this.tracked = peer
    this.trackCalls.push(peer)
    this.bus.changed()
  }

  peers() {
    return this.bus.queue()
  }

  send(msg: Envelope) {
    this.sent.push(msg)
    if (this.closed || this.bus.drop(msg)) return
    this.bus.transports.forEach((t) => {
      if (t !== this && !t.closed) t.on?.direct(msg)
    })
  }

  close() {
    this.closed = true
    this.tracked = null
    this.bus.transports.delete(this)
    this.bus.changed()
  }
}
