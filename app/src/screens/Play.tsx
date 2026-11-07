import { useEffect, useRef, useState } from 'react'
import {
  createNoopSigner,
  type Address,
  type Blockhash,
} from '@solana/kit'
import { Mark } from '../components/Board'
import { Nav } from '../components/Chrome'
import { sol, short } from '../lib/format'
import { activeGameOf, useConfig } from '../lib/game'
import { joinMessage, matchmaker, type Direct, type JoinProof, type Pairing, type Peer } from '../lib/matchmaking'
import { createSession, saveSession, type Session } from '../lib/session'
import {
  buildPartiallySigned,
  CLUSTER,
  cosign,
  describeError,
  rpc,
  sendSigned,
  wireBase64,
  type Lifetime,
} from '../lib/solana'
import { signText, useWallet } from '../lib/wallet'
import { findGamePda, getStartGameInstructionAsync } from '../program'
import { checkOffer, type Offer } from '../lib/offer'

const SIGN_WINDOW_MS = 30_000
const WATCH_MS = 1500

type Phase = 'queued' | 'matched' | 'signing' | 'waiting' | 'ready' | 'sending'
/** A start transaction that may still land: follow it until its blockhash expires. */
type Watch = { game: Address; lastValidBlockHeight: bigint }

function go(game: string) {
  location.hash = `#/game/${game}`
}

export function Play({ stake }: { stake: bigint }) {
  const { wallet } = useWallet()
  const { config } = useConfig()
  const [session, setSession] = useState<Session | null>(null)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [phase, setPhase] = useState<Phase>('queued')
  const [offer, setOffer] = useState<Offer | null>(null)
  const [watch, setWatch] = useState<Watch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deadline, setDeadline] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [queue, setQueue] = useState<Peer[]>([])
  const joinedAt = useRef(Date.now())
  const proof = useRef<JoinProof | null>(null)
  /** Why we're not in the queue right now, if we aren't. */
  const [out, setOut] = useState<'joining' | 'sign' | 'away' | 'duplicate' | null>('joining')
  const [busyGame, setBusyGame] = useState<Address | null>(null)

  // Listeners subscribe once and read the latest state from here, so a message that
  // arrives right after pairing (before React re-renders) is not dropped.
  const live = useRef({ wallet, session, pairing, phase })
  live.current = { wallet, session, pairing, phase }

  const gas = config?.gasDeposit ?? 1_000_000n
  const inRange = !config || (stake >= config.minStake && stake <= config.maxStake)

  /**
   * Enter the queue. The wallet signs the queue entry once (a message popup, no fee), so nobody
   * can queue in someone else's name. `fresh` starts a new place at the back and needs a new signature.
   */
  const join = async (fresh = false) => {
    const { wallet, session } = live.current
    if (!wallet || !session) return
    if (fresh) {
      joinedAt.current = Date.now()
      proof.current = null
    }
    setOut('joining')
    setError(null)
    try {
      // One active game per wallet, enforced on-chain: send the player back to it.
      const active = await activeGameOf(wallet.address)
      if (active) {
        setBusyGame(active)
        return
      }
      if (!proof.current) {
        const message = joinMessage({
          wallet: wallet.address,
          session: session.signer.address,
          stake: stake.toString(),
          joinedAt: joinedAt.current,
          cluster: CLUSTER,
        })
        proof.current = { message, signature: await signText(wallet, message) }
      }
      matchmaker.join({ wallet: wallet.address, session: session.signer, stake, joinedAt: joinedAt.current, proof: proof.current })
      setOut(null)
    } catch (e) {
      setError(describeError(e))
      setOut('sign')
    }
  }

  // Enter the queue with a fresh one-off session wallet. Nothing is paid yet.
  useEffect(() => {
    if (!wallet || !inRange) return
    let alive = true
    createSession().then((s) => {
      if (!alive) return
      live.current.session = s
      setSession(s)
      join()
    })
    return () => {
      alive = false
      matchmaker.leave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, stake, inRange])

  // The same wallet already waits in another tab or on another device: only the oldest entry plays.
  useEffect(
    () =>
      matchmaker.onDuplicate((other) => {
        if (!other) return
        matchmaker.leave()
        setOut('duplicate')
      }),
    [],
  )

  useEffect(() => matchmaker.onQueue((peers) => setQueue(peers.filter((p) => p.stake === stake.toString()))), [stake])

  useEffect(
    () =>
      matchmaker.onPaired((p) => {
        live.current.pairing = p
        setPairing(p)
        setPhase('matched')
        setError(null)
        setDeadline(Date.now() + SIGN_WINDOW_MS)
      }),
    [],
  )

  /**
   * After a failed match the player who did their part keeps their place. Whoever was supposed
   * to sign and didn't is taken out of the queue until they confirm they're back.
   */
  const requeue = (reason: string, notify: boolean) => {
    const { pairing, phase } = live.current
    const stalled = (pairing?.role === 'x' && (phase === 'matched' || phase === 'signing')) || (pairing?.role === 'o' && phase === 'ready')
    if (pairing && notify) matchmaker.send(pairing.opponent, { type: 'cancel' })
    live.current.pairing = null
    setPairing(null)
    setOffer(null)
    setDeadline(null)
    setPhase('queued')
    if (stalled) {
      matchmaker.leave()
      setOut('away')
      setError(`${reason} You didn't sign in time, so you're out of the queue.`)
      return
    }
    join().then(() => setError(`${reason} Back in the queue, same place.`))
  }

  useEffect(
    () =>
      matchmaker.onDirect((msg: Direct, from: Peer) => {
        const { pairing, phase } = live.current
        if (!pairing || from.id !== pairing.opponent.id) return
        if (msg.type === 'offer' && pairing.role === 'o') {
          setOffer({
            tx: msg.tx,
            game: msg.game as Address,
            nonce: BigInt(msg.nonce),
            lifetime: { blockhash: msg.blockhash as Blockhash, lastValidBlockHeight: BigInt(msg.lastValidBlockHeight) },
          })
          setPhase('ready')
        } else if (msg.type === 'started') {
          go(msg.game)
        } else if (msg.type === 'cancel' && phase !== 'sending') {
          requeue('Opponent left the match.', false)
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // 30 s to get both signatures.
  useEffect(() => {
    if (!deadline) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [deadline])
  useEffect(() => {
    if (deadline && now > deadline && phase !== 'sending') requeue('Signatures timed out.', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now])

  // A start transaction we signed can land after we gave up (a slow wallet popup on the
  // other side). Keep looking for the game until its blockhash expires, even from the queue.
  useEffect(() => {
    if (!watch) return
    const t = setInterval(async () => {
      try {
        const [{ value }, height] = await Promise.all([
          rpc.getAccountInfo(watch.game, { encoding: 'base64' }).send(),
          rpc.getBlockHeight().send(),
        ])
        if (value) go(watch.game)
        else if (height > watch.lastValidBlockHeight) setWatch(null)
      } catch { /* try again next tick */ }
    }, WATCH_MS)
    return () => clearInterval(t)
  }, [watch])

  async function signAsX() {
    if (!wallet || !session || !pairing) return
    setPhase('signing')
    setError(null)
    try {
      const nonce = BigInt(Date.now())
      const ix = await getStartGameInstructionAsync({
        playerX: wallet.signer,
        playerO: createNoopSigner(pairing.opponent.wallet as Address),
        sessionX: session.signer.address,
        sessionO: pairing.opponent.session as Address,
        nonce,
        stake,
      })
      const tx = await buildPartiallySigned(wallet.signer, [ix])
      const [game] = await findGamePda({ playerX: wallet.address, nonce })
      saveSession(game, wallet.address, session)
      const lifetime = tx.lifetimeConstraint as Lifetime
      setOffer({ tx: '', game, nonce, lifetime })
      setWatch({ game, lastValidBlockHeight: lifetime.lastValidBlockHeight })
      matchmaker.send(pairing.opponent, {
        type: 'offer',
        tx: wireBase64(tx),
        game,
        nonce: nonce.toString(),
        blockhash: lifetime.blockhash,
        lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
      })
      setPhase('waiting')
    } catch (e) {
      setError(describeError(e))
      setPhase('matched')
    }
  }

  async function signAsO() {
    if (!wallet || !session || !pairing || !offer) return
    setPhase('sending')
    setError(null)
    try {
      const tx = await checkOffer(offer, { wallet: wallet.signer, session: session.signer.address, opponent: pairing.opponent, stake })
      const signed = await cosign(tx, wallet.signer)
      saveSession(offer.game, wallet.address, session)
      setWatch({ game: offer.game, lastValidBlockHeight: offer.lifetime.lastValidBlockHeight })
      await sendSigned(signed)
      matchmaker.send(pairing.opponent, { type: 'started', game: offer.game })
      go(offer.game)
    } catch (e) {
      setError(describeError(e))
      setPhase('ready')
    }
  }

  if (!wallet || !inRange) {
    return (
      <div className="flex min-h-svh flex-col">
        <Nav />
        <main className="flex flex-1 flex-col gap-6 px-4 py-8 md:px-12">
          <h1 className="mega text-[clamp(40px,7vw,96px)]">{wallet ? <>Stake not<br /><mark>allowed.</mark></> : <>Connect<br /><mark>first.</mark></>}</h1>
          <p className="max-w-[560px] text-ink-2">
            {wallet
              ? `Stakes must be between ${sol(config!.minStake, 2)} and ${sol(config!.maxStake, 2)} SOL.`
              : 'Connect a wallet with the button in the top right to enter the queue. On localnet, pick "Dev wallet" — each browser tab gets its own funded player.'}
          </p>
          <a className="ghost max-w-[320px]" href="#/">Back</a>
        </main>
      </div>
    )
  }

  if (busyGame) {
    return (
      <div className="flex min-h-svh flex-col">
        <Nav />
        <main className="flex flex-1 flex-col gap-6 px-4 py-8 md:px-12">
          <h1 className="mega text-[clamp(40px,7vw,96px)]">Game in<br /><mark>progress.</mark></h1>
          <p className="max-w-[560px] text-ink-2">This wallet is already playing a game. One game per wallet at a time: finish it first.</p>
          <a className="btn max-w-[420px]" href={`#/game/${busyGame}`}><span>Resume game</span><span className="tag">{short(busyGame)}</span></a>
        </main>
      </div>
    )
  }

  const left = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0
  const opponent = pairing?.opponent
  const iAmX = pairing?.role === 'x'
  const mySigned = (iAmX && (phase === 'waiting' || phase === 'sending')) || (!iAmX && phase === 'sending')
  const theirSigned = !iAmX && (phase === 'ready' || phase === 'sending')
  const canSign = (iAmX && phase === 'matched') || (!iAmX && phase === 'ready')
  const count = queue.length

  return (
    <div className="flex min-h-svh flex-col">
      <Nav meta={<><span>Queue · FIFO · {sol(stake, 2)} SOL</span><span>{count} waiting</span></>} />
      <main className="flex flex-1 flex-col gap-6 px-4 py-6 md:px-12 md:py-8">
        <span className="label">{pairing ? 'Paired first-in, first-out · nothing paid yet' : `Looking for an opponent at ${sol(stake, 2)} SOL · nothing paid yet`}</span>
        <h1 className="mega text-[clamp(40px,7vw,96px)]">
          {pairing ? <>Match<br /><mark>found.</mark></> : <>In the<br /><mark>queue<span className="blink">_</span></mark></>}
        </h1>

        <div className="grid items-center gap-3 md:grid-cols-[1fr_120px_1fr] md:gap-6">
          <Slab player={iAmX || !pairing ? 1 : 2} who={`You · ${pairing ? (iAmX ? 'X' : 'O') : '?'}`} address={wallet.address} note={pairing ? (iAmX ? 'moves first' : 'moves second') : 'waiting'} active />
          <span className="text-center font-display text-[22px] font-black [font-stretch:125%] md:text-[56px]">VS</span>
          {opponent
            ? <Slab player={iAmX ? 2 : 1} who={`Opponent · ${iAmX ? 'O' : 'X'}`} address={opponent.wallet} note={`waited ${Math.max(0, Math.round((Date.now() - opponent.joinedAt) / 1000))} s`} />
            : out
              ? <OutPanel out={out} onJoin={() => join(out === 'away')} />
              : <div className="panel"><header><span className="label">Opponent</span><span className="code">{count <= 1 ? 'nobody else yet' : `${count} in queue`}</span></header><div className="body"><span className="num text-[22px] md:text-[40px]">Searching<span className="blink">…</span></span></div></div>}
        </div>

        <div className="grid items-start gap-5 md:grid-cols-[1fr_1fr_420px] md:gap-7">
          <div className="panel hidden md:flex">
            <header><span className="label">Stakes</span><span className="code">one atomic tx</span></header>
            <div className="body"><div className="kv">
              <span>Stake each</span><span>{sol(stake, 2)} SOL</span>
              <span>Pot</span><span>{sol(stake * 2n, 2)} SOL</span>
              <span>Gas deposit (refunded)</span><span>{sol(gas, 3)} SOL</span>
            </div></div>
          </div>
          <span className="label text-center md:hidden">Stake {sol(stake, 2)} · pot {sol(stake * 2n, 2)} · gas deposit {sol(gas, 3)} (refunded)</span>
          <div className="panel">
            <header><span className="label">Signatures</span><span className="code">{pairing ? `${left} s left` : '—'}</span></header>
            <div className="body">
              <div className="timer"><span style={{ width: `${pairing ? (left / (SIGN_WINDOW_MS / 1000)) * 100 : 0}%` }} /></div>
              <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2">
                <span>You</span>{mySigned ? <span className="chip chip-on">Signed</span> : <span className={`chip chip-line ${canSign ? 'blink' : ''}`}>{canSign ? 'Sign now' : 'Waiting'}</span>}
                <span>Opponent</span>{theirSigned ? <span className="chip chip-on">Signed</span> : <span className="chip chip-line">{iAmX ? 'Signs after you' : 'Signing first'}</span>}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3.5">
            <button type="button" className="btn text-[18px]" disabled={!canSign} onClick={iAmX ? signAsX : signAsO}>
              <span>{phase === 'signing' || phase === 'sending' ? 'Signing…' : 'Sign & stake'}</span>
              <span className="tag">{sol(stake + gas, 3)} SOL</span>
            </button>
            <span className="label text-center">{error ?? 'Nothing is paid unless both sign'}</span>
            <a className="ghost" href="#/">Leave queue</a>
          </div>
        </div>
      </main>
    </div>
  )
}

const OUT_TEXT = {
  joining: { title: 'Sign to join', text: 'Approve the message in your wallet. It proves this queue entry is yours. No fee.', action: null },
  sign: { title: 'Not in the queue', text: 'The queue entry needs your wallet signature. No fee.', action: 'Sign & join' },
  away: { title: 'Still there?', text: "You missed your turn to sign, so you're out of the queue.", action: "I'm back" },
  duplicate: { title: 'Already queued', text: 'This wallet is already waiting in another tab or on another device. Close it to play here.', action: 'Try again' },
} as const

function OutPanel({ out, onJoin }: { out: keyof typeof OUT_TEXT; onJoin: () => void }) {
  const { title, text, action } = OUT_TEXT[out]
  return (
    <div className="panel">
      <header><span className="label">Opponent</span><span className="code">{out === 'joining' ? 'waiting for wallet' : 'not queued'}</span></header>
      <div className="body">
        <span className="num text-[22px] md:text-[34px]">{title}{out === 'joining' && <span className="blink">…</span>}</span>
        <span className="text-ink-2">{text}</span>
        {action && <button type="button" className="ghost" onClick={onJoin}>{action}</button>}
      </div>
    </div>
  )
}

function Slab({ player, who, address, note, active }: { player: number; who: string; address: string; note: string; active?: boolean }) {
  return (
    <div className="panel" style={active ? { background: 'var(--color-signal)' } : undefined}>
      <header><span className="label text-ink">{who}</span><span className="code text-ink">{note}</span></header>
      <div className="body flex-row items-center gap-4 md:gap-6 md:p-[22px]">
        <span className="size-[46px] shrink-0 md:size-[110px]"><Mark player={player} /></span>
        <span className="num min-w-0 truncate text-[22px] md:text-[40px]">{short(address)}</span>
      </div>
    </div>
  )
}
