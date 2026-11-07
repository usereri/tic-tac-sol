import {
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getUtf8Encoder,
  signatureBytes,
  signBytes,
  verifySignature,
  type Address,
  type KeyPairSigner,
  type ReadonlyUint8Array,
} from '@solana/kit'

/**
 * First-in, first-out matchmaking, one line per stake. Nothing touches the chain until two
 * players are paired.
 *
 * The pairing logic lives here and reaches other players through a `Transport`, so the same
 * rules run over a BroadcastChannel (local testing) or Supabase Realtime (devnet).
 *
 * Every queue entry carries a proof signed by the player's wallet, binding it to one session key,
 * stake and join time; entries without a valid proof are ignored. A peer's id is that session
 * address, and every direct message is signed with the session key, so nobody can join, propose,
 * cancel or start on another player's behalf. O's `checkOffer` still guards the transaction it
 * co-signs.
 */

/** The wallet's signature over `joinMessage(...)`, base58. */
export type JoinProof = { message: string; signature: string }

export type Peer = {
  /** The session address, so a message from this id must be signed by that key. */
  id: string
  wallet: string
  session: string
  /** Lamports, in decimal. */
  stake: string
  joinedAt: number
  proof: JoinProof
}

/** What the wallet signs to enter the queue. Shown to the player, so keep it readable. */
export function joinMessage(p: { wallet: string; session: string; stake: string; joinedAt: number; cluster: string }) {
  return `Tic-Tac-Sol: join the queue\nwallet: ${p.wallet}\nsession: ${p.session}\nstake: ${p.stake} lamports\ncluster: ${p.cluster}\njoined: ${p.joinedAt}`
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
const fromBase58 = getBase58Encoder()

const byAge = (a: Peer, b: Peer) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id)

async function verifies(signer: string, sig: ReadonlyUint8Array, data: string) {
  const key = await getPublicKeyFromAddress(signer as Address)
  return verifySignature(key, signatureBytes(sig), utf8.encode(data))
}

/** Whether the wallet really signed this entry's proof. */
async function proven({ wallet, proof }: Peer) {
  try {
    return await verifies(wallet, fromBase58.encode(proof.signature), proof.message)
  } catch {
    return false
  }
}

/** The message in `env` if its sender signed it within the last minute, else null. */
async function open(env: Envelope): Promise<Message | null> {
  try {
    const msg = JSON.parse(env.body) as Message
    if (msg.to !== env.to || typeof msg.payload?.type !== 'string' || !(Math.abs(Date.now() - msg.ts) <= MAX_AGE_MS)) return null
    return (await verifies(msg.from, fromBase64.encode(env.sig), env.body)) ? msg : null
  } catch {
    return null
  }
}

export class Matchmaker {
  private transport: Transport
  private cluster: string
  private me: Peer | null = null
  private signer: KeyPairSigner | null = null
  private paired: Pairing | null = null
  /** Who we proposed to lately. They may accept after the line has moved on. */
  private asked = new Map<string, { peer: Peer; until: number }>()
  /** Signatures already handled, so a message can't be replayed while it's fresh. */
  private seen = new Map<string, number>()
  /** Join proofs by signature and message: true or false once checked, null while checking. */
  private proofs = new Map<string, boolean | null>()
  /** Signing and verifying are async; this keeps them, and so the messages, in order. */
  private work = Promise.resolve()
  private lastQueue = ''
  private lastDuplicate: string | undefined
  private timer: ReturnType<typeof setInterval>
  private sizeListeners = new Set<(count: number) => void>()
  private queueListeners = new Set<(peers: Peer[]) => void>()
  private duplicateListeners = new Set<(other: Peer | null) => void>()
  private pairListeners = new Set<(p: Pairing) => void>()
  private directListeners = new Set<(msg: Direct, from: Peer) => void>()

  /** `cluster` must match what players sign in their join proofs. */
  constructor(transport: Transport, cluster: string) {
    this.transport = transport
    this.cluster = cluster
    transport.start({ peers: () => this.notify(), direct: (msg) => this.receive(msg) })
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  /**
   * Enter the queue with a proof signed by the wallet over `joinMessage(...)`. Rejoin with the
   * same `joinedAt` and proof to keep your place after a failed match.
   */
  join({ wallet, session, stake, joinedAt, proof }: { wallet: string; session: KeyPairSigner; stake: bigint; joinedAt: number; proof: JoinProof }) {
    const me = { id: session.address, wallet, session: session.address, stake: stake.toString(), joinedAt, proof }
    this.me = me
    this.signer = session
    this.paired = null
    this.asked.clear()
    this.transport.track(me)
    this.tick()
    this.serial(async () => {
      if (proof.message !== joinMessage({ ...me, cluster: this.cluster }) || !(await proven(me))) {
        console.warn('matchmaking: our join proof does not verify, so nobody will see us')
      }
    })
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

  /**
   * An older entry of our own wallet, from another tab or device, or null. While there is one
   * we wait behind it and are never paired. Fires now and whenever it changes.
   */
  onDuplicate(fn: (other: Peer | null) => void) {
    this.duplicateListeners.add(fn)
    fn(this.duplicate())
    return () => void this.duplicateListeners.delete(fn)
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
    for (const p of this.transport.peers()) if (p.id !== this.me?.id && this.valid(p)) peers.set(p.id, p)
    return [...peers.values()]
  }

  /** Whether the entry's wallet signed exactly its fields. The signature is checked once, in the background. */
  private valid(p: Peer) {
    if (p.id !== p.session || p.proof?.message !== joinMessage({ ...p, cluster: this.cluster })) return false
    const key = `${p.proof.signature} ${p.proof.message}`
    const known = this.proofs.get(key)
    if (known !== undefined) return known === true
    this.proofs.set(key, null)
    this.serial(async () => {
      const ok = await proven(p)
      this.proofs.set(key, ok)
      if (ok) this.notify()
    })
    return false
  }

  private queue() {
    const peers = this.others()
    if (this.me && !this.paired) peers.push(this.me)
    return peers.sort(byAge)
  }

  /** Our stake's line, oldest first. Only a wallet's oldest entry counts, so nobody meets themselves. */
  private line(me: Peer) {
    const wallets = new Set<string>()
    return this.queue().filter((p) => {
      const first = !wallets.has(p.wallet)
      wallets.add(p.wallet)
      return first && p.stake === me.stake
    })
  }

  private duplicate() {
    const me = this.me
    if (!me || this.paired) return null
    const first = this.queue().find((p) => p.wallet === me.wallet)
    return first && first.id !== me.id ? first : null
  }

  private notify() {
    const queue = this.queue()
    this.sizeListeners.forEach((fn) => fn(queue.length))
    const duplicate = this.duplicate()
    if (duplicate?.id !== this.lastDuplicate) {
      this.lastDuplicate = duplicate?.id
      this.duplicateListeners.forEach((fn) => fn(duplicate))
    }
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
