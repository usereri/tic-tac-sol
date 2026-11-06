import { useEffect, useRef, useState } from 'react'
import {
  createNoopSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from '@solana/kit'
import { Mark } from '../components/Board'
import { Nav } from '../components/Chrome'
import { sol, short } from '../lib/format'
import { useConfig } from '../lib/game'
import { matchmaker, type Direct, type Pairing, type Peer } from '../lib/matchmaking'
import { createSession, saveSession, type Session } from '../lib/session'
import { buildPartiallySigned, cosign, describeError, rpc, sendSigned, wireBase64 } from '../lib/solana'
import { useWallet } from '../lib/wallet'
import { findGamePda, getStartGameInstructionAsync, TIC_TAC_SOL_PROGRAM_ADDRESS } from '../program'

const SIGN_WINDOW_MS = 20_000

type Phase = 'queued' | 'matched' | 'signing' | 'waiting' | 'ready' | 'sending'
type Offer = { tx: string; game: Address; nonce: bigint }

function go(game: string) {
  location.hash = `#/game/${game}`
}

/** O checks the offer before signing: right program, right game, our session key in it. */
function checkOffer(offer: Offer, txBase64: string, session: Address, expectedGame: Address) {
  if (offer.game !== expectedGame) throw new Error('Offer is for an unexpected game account')
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(txBase64))
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
  const keys = message.staticAccounts as readonly string[]
  if (!keys.includes(TIC_TAC_SOL_PROGRAM_ADDRESS) || !keys.includes(session) || !keys.includes(expectedGame)) {
    throw new Error('Offer does not match this match')
  }
  return tx
}

export function Play() {
  const { wallet } = useWallet()
  const { config } = useConfig()
  const [session, setSession] = useState<Session | null>(null)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [phase, setPhase] = useState<Phase>('queued')
  const [offer, setOffer] = useState<Offer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deadline, setDeadline] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const joinedAt = useRef(Date.now())
  const [queue, setQueue] = useState(0)

  const stake = config?.stake ?? 50_000_000n
  const gas = config?.gasDeposit ?? 1_000_000n

  // Enter the queue with a fresh one-off session wallet. Nothing is paid yet.
  useEffect(() => {
    if (!wallet) return
    let live = true
    createSession().then((s) => {
      if (!live) return
      setSession(s)
      matchmaker.join(wallet.address, s.signer.address, joinedAt.current)
    })
    return () => {
      live = false
      matchmaker.leave()
    }
  }, [wallet])

  useEffect(() => matchmaker.onQueueSize(setQueue), [])

  useEffect(
    () =>
      matchmaker.onPaired((p) => {
        setPairing(p)
        setPhase('matched')
        setError(null)
        setDeadline(Date.now() + SIGN_WINDOW_MS)
      }),
    [],
  )

  const requeue = (reason?: string) => {
    if (pairing) matchmaker.send(pairing.opponent, { type: 'cancel' })
    setPairing(null)
    setOffer(null)
    setDeadline(null)
    setPhase('queued')
    if (reason) setError(reason)
    if (wallet && session) matchmaker.join(wallet.address, session.signer.address, joinedAt.current)
  }

  useEffect(
    () =>
      matchmaker.onDirect((msg: Direct, from: Peer) => {
        if (!pairing || from.id !== pairing.opponent.id) return
        if (msg.type === 'offer' && pairing.role === 'o') {
          setOffer({ tx: msg.tx, game: msg.game as Address, nonce: BigInt(msg.nonce) })
          setPhase('ready')
        } else if (msg.type === 'started') {
          go(msg.game)
        } else if (msg.type === 'cancel') {
          requeue('Opponent left the match. Back in the queue, same place.')
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pairing, wallet, session],
  )

  // 20 s to get both signatures, then back to the queue (keeping our place).
  useEffect(() => {
    if (!deadline) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [deadline])
  useEffect(() => {
    if (deadline && now > deadline && phase !== 'sending') requeue('Signatures timed out. Back in the queue, same place.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now])

  // X: watch for the game account in case the "started" message is missed.
  useEffect(() => {
    if (phase !== 'waiting' || !offer) return
    const t = setInterval(async () => {
      const { value } = await rpc.getAccountInfo(offer.game, { encoding: 'base64' }).send()
      if (value) go(offer.game)
    }, 1000)
    return () => clearInterval(t)
  }, [phase, offer])

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
      })
      const tx = await buildPartiallySigned(wallet.signer, [ix])
      const [game] = await findGamePda({ playerX: wallet.address, nonce })
      saveSession(game, session)
      setOffer({ tx: '', game, nonce })
      matchmaker.send(pairing.opponent, { type: 'offer', tx: wireBase64(tx), game, nonce: nonce.toString() })
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
      const [expected] = await findGamePda({ playerX: pairing.opponent.wallet as Address, nonce: offer.nonce })
      const tx = checkOffer(offer, offer.tx, session.signer.address, expected)
      const signed = await cosign(tx, wallet.signer)
      saveSession(offer.game, session)
      await sendSigned(signed)
      matchmaker.send(pairing.opponent, { type: 'started', game: offer.game })
      go(offer.game)
    } catch (e) {
      setError(describeError(e))
      setPhase('ready')
    }
  }

  if (!wallet) {
    return (
      <div className="flex min-h-svh flex-col">
        <Nav />
        <main className="flex flex-1 flex-col gap-6 px-4 py-8 md:px-12">
          <h1 className="mega text-[clamp(40px,7vw,96px)]">Connect<br /><mark>first.</mark></h1>
          <p className="max-w-[560px] text-ink-2">Connect a wallet with the button in the top right to enter the queue. On localnet, pick "Dev wallet" — each browser tab gets its own funded player.</p>
          <a className="ghost max-w-[320px]" href="#/">Back</a>
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

  return (
    <div className="flex min-h-svh flex-col">
      <Nav meta={<><span>Queue · FIFO</span><span>{queue} waiting</span></>} />
      <main className="flex flex-1 flex-col gap-6 px-4 py-6 md:px-12 md:py-8">
        <span className="label">{pairing ? 'Paired first-in, first-out · nothing paid yet' : 'Looking for an opponent · nothing paid yet'}</span>
        <h1 className="mega text-[clamp(40px,7vw,96px)]">
          {pairing ? <>Match<br /><mark>found.</mark></> : <>In the<br /><mark>queue<span className="blink">_</span></mark></>}
        </h1>

        <div className="grid items-center gap-3 md:grid-cols-[1fr_120px_1fr] md:gap-6">
          <Slab player={iAmX || !pairing ? 1 : 2} who={`You · ${pairing ? (iAmX ? 'X' : 'O') : '?'}`} address={wallet.address} note={pairing ? (iAmX ? 'moves first' : 'moves second') : 'waiting'} active />
          <span className="text-center font-display text-[22px] font-black [font-stretch:125%] md:text-[56px]">VS</span>
          {opponent
            ? <Slab player={iAmX ? 2 : 1} who={`Opponent · ${iAmX ? 'O' : 'X'}`} address={opponent.wallet} note={`waited ${Math.max(0, Math.round((Date.now() - opponent.joinedAt) / 1000))} s`} />
            : <div className="panel"><header><span className="label">Opponent</span><span className="code">{queue <= 1 ? 'nobody else yet' : `${queue} in queue`}</span></header><div className="body"><span className="num text-[22px] md:text-[40px]">Searching<span className="blink">…</span></span></div></div>}
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
              <span>{phase === 'signing' || phase === 'sending' ? 'Signing…' : `Sign with ${wallet.kind === 'dev' ? 'dev wallet' : wallet.name}`}</span>
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
