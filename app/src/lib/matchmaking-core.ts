import {
  getBase64Decoder,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getUtf8Encoder,
  signatureBytes,
  signBytes,
  verifySignature,
  type Address,
  type KeyPairSigner,
} from '@solana/kit'

/**
 * First-in, first-out matchmaking, one line per stake. Nothing touches the chain until two
 * players are paired.
 *
 * The pairing logic lives here and reaches other players through a `Transport`, so the same
 * rules run over a BroadcastChannel (local testing) or Supabase Realtime (devnet).
 *
 * A peer's id is its session address and every direct message is signed with that session key,
 * so nobody can propose, cancel or start on another player's behalf. The queue itself is not
 * signed: a fake entry can waste someone's time, never make them pay. O's `checkOffer` still
 * guards the transaction it co-signs.
 */

export type Peer = {
  /** The session address, so a message from this id must be signed by that key. */
  id: string
  wallet: string
  session: string
  /** Lamports, in decimal. */
  stake: string
  joinedAt: number
}

export type Direct =
  | { type: 'propose' }
  | { type: 'accept' }
  | { type: 'offer'; tx: string; game: string; nonce: string; blockhash: string; lastValidBlockHeight: string }
  | { type: 'started'; game: string }
  | { type: 'cancel' }

/** A signed direct message. Every transport delivers it to everyone; the receiver checks `to`. */
export type Envelope = { to: string; body: string; sig: string }

/** What `body` holds. It travels as a string so the signed bytes survive any relay unchanged. */
type Message = { to: string; from: string; ts: number; payload: Direct }

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

export type Pairing = { role: 'x' | 'o'; me: Peer; opponent: Peer }

const TICK_MS = 500
const LINGER_MS = 5000
const MAX_AGE_MS = 60_000

const utf8 = getUtf8Encoder()
const toBase64 = getBase64Decoder()
const fromBase64 = getBase64Encoder()

const byAge = (a: Peer, b: Peer) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id)

/** The message in `env` if its sender signed it within the last minute, else null. */
async function open(env: Envelope): Promise<Message | null> {
  try {
    const msg = JSON.parse(env.body) as Message
    if (msg.to !== env.to || typeof msg.payload?.type !== 'string' || !(Math.abs(Date.now() - msg.ts) <= MAX_AGE_MS)) return null
    const key = await getPublicKeyFromAddress(msg.from as Address)
    return (await verifySignature(key, signatureBytes(fromBase64.encode(env.sig)), utf8.encode(env.body))) ? msg : null
  } catch {
    return null
  }
}

export class Matchmaker {
  private transport: Transport
  private me: Peer | null = null
  private signer: KeyPairSigner | null = null
  private paired: Pairing | null = null
  /** Who we proposed to lately. They may accept after the line has moved on. */
  private asked = new Map<string, { peer: Peer; until: number }>()
  /** Signatures already handled, so a message can't be replayed while it's fresh. */
  private seen = new Map<string, number>()
  /** Signing and verifying are async; this keeps them, and so the messages, in order. */
  private work = Promise.resolve()
  private lastQueue = ''
  private timer: ReturnType<typeof setInterval>
  private sizeListeners = new Set<(count: number) => void>()
  private queueListeners = new Set<(peers: Peer[]) => void>()
  private pairListeners = new Set<(p: Pairing) => void>()
  private directListeners = new Set<(msg: Direct, from: Peer) => void>()

  constructor(transport: Transport) {
    this.transport = transport
    transport.start({ peers: () => this.notify(), direct: (msg) => this.receive(msg) })
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  /** Enter the queue. Pass the original `joinedAt` to keep your place after a failed match. */
  join({ wallet, session, stake, joinedAt = Date.now() }: { wallet: string; session: KeyPairSigner; stake: bigint; joinedAt?: number }) {
    this.me = { id: session.address, wallet, session: session.address, stake: stake.toString(), joinedAt }
    this.signer = session
    this.paired = null
    this.asked.clear()
    this.transport.track(this.me)
    this.tick()
  }

  leave() {
    // Pairing already took us out of the queue.
    if (this.me && !this.paired) this.transport.track(null)
    this.me = null
    this.signer = null
  }

  get queued() {
    return this.me
  }

  send(to: Peer, payload: Direct) {
    this.post(to.id, payload)
  }

  onQueueSize(fn: (count: number) => void) {
    this.sizeListeners.add(fn)
    fn(this.queue().length)
    return () => void this.sizeListeners.delete(fn)
  }

  /** Everyone waiting, including us while queued, oldest first. Fires when it changes. */
  onQueue(fn: (peers: Peer[]) => void) {
    this.queueListeners.add(fn)
    fn(this.queue())
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

  /** Other valid entries, one per id. */
  private others() {
    const peers = new Map<string, Peer>()
    for (const p of this.transport.peers()) if (p.id === p.session && p.id !== this.me?.id) peers.set(p.id, p)
    return [...peers.values()]
  }

  private queue() {
    const peers = this.others()
    if (this.me && !this.paired) peers.push(this.me)
    return peers.sort(byAge)
  }

  /** Our stake's line, oldest first, keeping only each wallet's oldest entry so nobody meets themselves. */
  private line(me: Peer) {
    const wallets = new Set<string>()
    return this.queue().filter((p) => {
      if (p.stake !== me.stake || wallets.has(p.wallet)) return false
      wallets.add(p.wallet)
      return true
    })
  }

  private notify() {
    const queue = this.queue()
    this.sizeListeners.forEach((fn) => fn(queue.length))
    const key = JSON.stringify(queue)
    if (key === this.lastQueue) return
    this.lastQueue = key
    this.queueListeners.forEach((fn) => fn(queue))
  }

  private tick() {
    const me = this.me
    if (me && !this.paired) {
      // Everyone sorts the same way, so the two oldest in a line pair up. The older one proposes.
      const line = this.line(me)
      const i = line.findIndex((p) => p.id === me.id)
      const next = i % 2 === 0 ? line[i + 1] : undefined
      const now = Date.now()
      for (const [id, a] of this.asked) if (now > a.until) this.asked.delete(id)
      if (next) this.asked.set(next.id, { peer: next, until: now + LINGER_MS })
      // Whoever we asked and has left the line may have accepted and lost the reply: keep asking a while.
      for (const { peer } of this.asked.values()) {
        if (peer.id === next?.id || !line.some((p) => p.id === peer.id)) this.post(peer.id, { type: 'propose' })
      }
    }
    this.notify()
  }

  private setPaired(p: Pairing) {
    this.paired = p
    this.asked.clear()
    this.transport.track(null)
    this.pairListeners.forEach((fn) => fn(p))
  }

  private post(to: string, payload: Direct) {
    const { me, signer } = this
    if (!me || !signer) return
    const body = JSON.stringify({ to, from: me.id, ts: Date.now(), payload } satisfies Message)
    this.serial(async () => {
      const sig = await signBytes(signer.keyPair.privateKey, utf8.encode(body))
      this.transport.send({ to, body, sig: toBase64.decode(sig) })
    })
  }

  private receive(env: Envelope) {
    const me = this.me
    if (!me || env.to !== me.id) return
    this.serial(async () => {
      if (this.seen.has(env.sig)) return
      const msg = await open(env)
      if (!msg || !this.me || this.me.id !== me.id) return
      const now = Date.now()
      for (const [sig, ts] of this.seen) if (now - ts > MAX_AGE_MS) this.seen.delete(sig)
      this.seen.set(env.sig, msg.ts)
      this.handle(msg.from, msg.payload, this.me)
    })
  }

  private handle(from: string, payload: Direct, me: Peer) {
    const paired = this.paired
    if (payload.type === 'propose') {
      if (paired) {
        // They are still proposing, so our accept was lost: say it again.
        if (paired.role === 'o' && paired.opponent.id === from) this.post(from, { type: 'accept' })
        return
      }
      // Only the peer right ahead of us may propose, when we are the second of its pair.
      const line = this.line(me)
      const i = line.findIndex((p) => p.id === me.id)
      const proposer = i % 2 === 1 ? line[i - 1] : undefined
      if (proposer?.id !== from) return
      this.post(from, { type: 'accept' })
      this.setPaired({ role: 'o', me, opponent: proposer })
      return
    }
    if (payload.type === 'accept') {
      const asked = this.asked.get(from)
      if (!paired && asked) return this.setPaired({ role: 'x', me, opponent: asked.peer })
      // A late accept from someone we no longer want: release them so they queue again.
      if (paired?.opponent.id !== from) this.post(from, { type: 'cancel' })
      return
    }
    // The rest only means something from our opponent.
    if (paired?.opponent.id === from) this.directListeners.forEach((fn) => fn(payload, paired.opponent))
  }

  private serial(fn: () => Promise<void>) {
    this.work = this.work.then(fn).catch((e) => console.warn('matchmaking:', e))
  }
}
