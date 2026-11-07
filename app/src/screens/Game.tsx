import { useEffect, useMemo, useRef, useState } from 'react'
import { address as toAddress, type Address } from '@solana/kit'
import { Board, Mark } from '../components/Board'
import { Nav } from '../components/Chrome'
import { COORDS, short, sol } from '../lib/format'
import {
  canPlace,
  claimTimeout,
  settleAbandoned,
  closeGame,
  GameStatus,
  makeMove,
  nextToFade,
  O,
  payouts,
  sweepSession,
  useConfig,
  useGame,
  useSlot,
  winningLine,
  X,
  type Game as GameState,
} from '../lib/game'
import { loadSession, type Session } from '../lib/session'
import { allowedStakes, playHref, saveStake } from '../lib/stakes'
import { describeError, explorerTx, SLOT_MS } from '../lib/solana'
import { useWallet } from '../lib/wallet'

type LogEntry = { n: number; player: number; cell: number; ms?: number; signature?: string }

function parseAddress(raw: string): Address | null {
  try {
    return toAddress(raw)
  } catch {
    return null
  }
}

export function GameScreen({ id }: { id: string }) {
  const gameAddress = useMemo(() => parseAddress(id), [id])
  const { view, closed } = useGame(gameAddress)
  const slot = useSlot()
  const { config } = useConfig()
  const { wallet } = useWallet()
  const [session, setSession] = useState<Session | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [lastMs, setLastMs] = useState<number | null>(null)
  const prev = useRef<GameState | null>(null)
  const mine = useRef(new Map<number, { ms: number; signature: string }>())
  const claiming = useRef(false)

  useEffect(() => {
    if (gameAddress && wallet) loadSession(gameAddress, wallet.address).then(setSession)
  }, [gameAddress, wallet])

  const game = view?.game ?? null
  const me = !game || !session ? 0 : session.signer.address === game.sessionX ? X : session.signer.address === game.sessionO ? O : 0
  const active = game?.status === GameStatus.Active
  const myTurn = active && me !== 0 && game!.turn === me

  // Build the move log from account updates: a new mark is the cell that changed to the mover.
  useEffect(() => {
    if (!game) return
    const before = prev.current
    prev.current = game
    if (!before || game.moveCount <= before.moveCount) return
    const mover = before.turn
    const cell = [...game.board].findIndex((v, i) => v === mover && before.board[i] !== mover)
    if (cell < 0) return
    const n = game.moveCount
    const own = mine.current.get(n)
    setLog((l) => [{ n, player: mover, cell, ...own }, ...l].slice(0, 8))
    setPending(null)
  }, [game])

  const turnSlots = config?.turnSlots ?? 12n
  const deadline = game ? game.lastActionSlot + turnSlots : 0n
  const slotsLeft = game && slot !== null ? Number(deadline - slot) : Number(turnSlots)
  const secondsLeft = Math.max(0, (slotsLeft * SLOT_MS) / 1000)
  // Lock the board 2 slots early so a last-moment move doesn't land after the deadline.
  const locked = slotsLeft < 2

  // Opponent missed the deadline: claim it (wins if they had moved before, else 50/50).
  // Past the claim window (both players were gone) either player settles it 50/50, which also
  // frees both wallets' one-game locks.
  const abandoned = slotsLeft < -Number(config?.abandonSlots ?? 150n)
  useEffect(() => {
    if (!game || !session || !gameAddress || !active || me === 0) return
    if (slotsLeft >= 0 || claiming.current) return
    if (!abandoned && game.turn === me) return
    claiming.current = true
    const ref = { address: gameAddress, game }
    ;(abandoned ? settleAbandoned(session.signer, ref) : claimTimeout(session.signer, ref))
      .catch((e) => setError(describeError(e)))
      .finally(() => (claiming.current = false))
  }, [slotsLeft, abandoned, game, session, gameAddress, active, me])

  // After the game: X closes the account (rent back to X), then both sweep their session wallet.
  const cleaned = useRef(false)
  useEffect(() => {
    if (!game || active || !session || !gameAddress || me === 0 || cleaned.current) return
    cleaned.current = true
    const owner = me === X ? game.playerX : game.playerO
    const t = setTimeout(async () => {
      try {
        if (me === X && !closed) await closeGame(session.signer, { address: gameAddress, game })
      } catch { /* already closed by someone else */ }
      try {
        await sweepSession(session.signer, owner)
      } catch { /* nothing left to sweep */ }
    }, 4000)
    return () => clearTimeout(t)
  }, [game, active, session, gameAddress, me, closed])

  async function play(cell: number) {
    if (!game || !session || !gameAddress || !myTurn || pending !== null) return
    setPending(cell)
    setError(null)
    try {
      const sent = await makeMove(session.signer, { address: gameAddress, game }, cell)
      mine.current.set(game.moveCount + 1, { ms: sent.ms, signature: sent.signature })
      setLastMs(sent.ms)
      setLog((l) => l.map((e) => (e.n === game.moveCount + 1 ? { ...e, ms: sent.ms, signature: sent.signature } : e)))
    } catch (e) {
      setError(describeError(e))
      setPending(null)
    }
  }

  if (!gameAddress) return <Message title="Bad game link" text="That isn't a valid game address." />
  if (!game) return <Message title={closed ? 'Game closed' : 'Loading…'} text={closed ? 'This game has ended and its account was closed.' : 'Fetching the game account.'} />
  if (!active) return <Result game={game} me={me} walletAddress={wallet?.address} log={log} />

  const fading = myTurn ? nextToFade(game, me) : nextToFade(game, game.turn)
  const opp = me === X ? O : X

  return (
    <div className="flex min-h-svh flex-col">
      <Nav meta={<><span>Game {short(gameAddress)}</span><span>Move {String(game.moveCount + 1).padStart(2, '0')}</span></>} />
      <main className="grid flex-1 grid-cols-1 items-start gap-5 px-4 py-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)_minmax(0,320px)] lg:gap-8 lg:px-8 lg:py-5">
        <section className="flex flex-col gap-4 lg:gap-5">
          <div className="panel">
            <header><span className="label">Players</span><span className="code">X moves first</span></header>
            <div className="body">
              {[X, O].map((p) => (
                <div key={p} className="grid grid-cols-[36px_1fr] items-center gap-3">
                  <span className="size-9"><Mark player={p} /></span>
                  <div className="flex min-w-0 flex-col gap-1">
                    {game.turn === p
                      ? <span className="chip chip-on self-start">{p === me ? 'Your move' : 'Their move'}</span>
                      : <span className="label">{p === me ? 'You' : me ? 'Opponent' : `Player ${p === X ? 'X' : 'O'}`}</span>}
                    <span className="truncate">{short(p === X ? game.playerX : game.playerO)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-1 lg:gap-5">
            <div className="panel">
              <header><span className="label">Pot</span><span className="code hidden sm:inline">escrow PDA</span></header>
              <div className="body"><div className="num text-[26px] lg:text-[40px]">{sol(game.initialPot - game.feesPaid, 5)}</div><span className="label">SOL · started at {sol(game.initialPot, 5)}</span></div>
            </div>
            <div className="panel">
              <header><span className="label">Time left</span><span className="code hidden sm:inline">slot {Math.max(0, Number(turnSlots) - slotsLeft)} / {String(turnSlots)}</span></header>
              <div className="body">
                <div className="num text-[26px] lg:text-[40px]">{secondsLeft.toFixed(1)} s</div>
                <div className={`timer ${secondsLeft < 2 ? 'urgent' : ''}`}><span style={{ width: `${Math.min(100, (slotsLeft / Number(turnSlots)) * 100)}%` }} /></div>
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col items-center gap-3">
          <Board
            className="w-full max-w-[min(680px,calc(100svh-190px))]"
            board={game.board}
            fading={fading}
            pending={pending !== null ? { cell: pending, player: me } : null}
            canPlay={(c) => myTurn && !locked && pending === null && canPlace(game, c)}
            onPlay={play}
          />
          <p className="m-0 text-center text-[13px] text-ink-2">
            {error
              ? <span className="chip chip-ink normal-case">{error}</span>
              : me === 0
                ? 'Spectating.'
                : myTurn
                  ? fading !== null ? `Your oldest mark at ${COORDS[fading]} disappears when you place.` : 'Your move.'
                  : `Waiting for ${opp === X ? 'X' : 'O'}…`}
          </p>
        </section>

        <section className="flex flex-col gap-4 lg:gap-5">
          <div className="panel">
            <header><span className="label">Proof of speed</span><span className="code">live</span></header>
            <div className="body"><div className="kv">
              <span>Last confirm</span><span>{lastMs !== null ? `${lastMs} ms` : '—'}</span>
              <span>Fee per move</span><span>5,000 lamports</span>
              <span>Fees this game</span><span>{sol(game.feesPaid, 6)} SOL</span>
              <span>Popups since start</span><span>0</span>
            </div></div>
          </div>
          <MoveLog log={log} />
        </section>
      </main>
    </div>
  )
}

function MoveLog({ log }: { log: LogEntry[] }) {
  return (
    <div className="panel">
      <header><span className="label">Move log</span><span className="code">explorer ↗</span></header>
      <div className="body">
        {log.length === 0 ? <span className="text-ink-2">No moves yet.</span> : (
          <ul className="log m-0 list-none p-0">
            {log.map((e) => (
              <li key={e.n}>
                <span className="code">#{String(e.n).padStart(2, '0')}</span>
                <span className="size-5"><Mark player={e.player} /></span>
                <span>{COORDS[e.cell]}{e.signature && <> · <a href={explorerTx(e.signature)} target="_blank" rel="noreferrer">{short(e.signature)}</a></>}</span>
                <span className="code">{e.ms ? `${e.ms} ms` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const OUTCOME: Record<number, string> = {
  [GameStatus.Won]: 'Three in a row',
  [GameStatus.WonByTimeout]: 'Opponent ran out of time',
  [GameStatus.Split]: 'Nobody could finish · split 50/50',
  [GameStatus.Drained]: 'Fees burned 90% of the pot · rest to the jackpot',
}

function Result({ game, me, walletAddress, log }: { game: GameState; me: number; walletAddress?: string; log: LogEntry[] }) {
  const line = game.status === GameStatus.Won ? winningLine(game.board, game.winner) : null
  const pay = payouts(game)
  const mineAmount = me === X ? pay.x : me === O ? pay.o : 0n
  const winner = game.winner === X ? 'X' : game.winner === O ? 'O' : null
  const headline = winner ? <>{winner} <mark>wins.</mark></> : game.status === GameStatus.Drained ? <><mark>Drained.</mark></> : <>Split <mark>50/50.</mark></>
  const moves = game.moveCount

  return (
    <div className="flex min-h-svh flex-col">
      <Nav meta={<><span>Game over</span></>} />
      <main className="grid flex-1 grid-cols-1 items-start gap-6 px-4 py-6 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)] lg:gap-12 lg:px-12 lg:py-8">
        <Board className="w-full max-w-[min(460px,calc(100svh-180px))]" board={game.board} win={line} coords />
        <section className="flex min-w-0 flex-col gap-5">
          <span className="label">{OUTCOME[game.status]} · move {String(moves).padStart(2, '0')}</span>
          <h1 className="mega text-[clamp(50px,8vw,120px)]">{headline}</h1>
          {me !== 0 && (
            <div>
              <span className="label">{mineAmount > 0n ? `Sent to ${walletAddress ? short(walletAddress) : 'your wallet'}` : 'You'}</span>
              <div className="num text-[clamp(30px,5vw,72px)]">{mineAmount > 0n ? `+${sol(mineAmount, 6)} SOL` : 'Better luck next time.'}</div>
            </div>
          )}
          <div className="panel">
            <header><span className="label">Ledger</span><span className="code">{moves} moves</span></header>
            <div className="body"><div className="kv">
              <span>Pot at start</span><span>{sol(game.initialPot, 6)} SOL</span>
              <span>Fees paid to Solana · {moves} moves</span><span>−{sol(game.feesPaid, 6)} SOL</span>
              <span>Paid to X</span><span>{sol(pay.x, 6)} SOL</span>
              <span>Paid to O</span><span>{sol(pay.o, 6)} SOL</span>
              {pay.jackpot > 0n && <><span>To the jackpot</span><span>{sol(pay.jackpot, 6)} SOL</span></>}
              <span>Gas deposit</span><span>returned to wallets</span>
            </div></div>
          </div>
          <span className="label">The whole game cost {sol(game.feesPaid, 6)} SOL in fees.</span>
          <div className="grid items-end gap-4 sm:grid-cols-2">
            <PlayAgain stake={game.stake} />
            {log[0]?.signature
              ? <a className="ghost min-h-[68px]" href={explorerTx(log[0].signature)} target="_blank" rel="noreferrer">Last move on Explorer ↗</a>
              : <a className="ghost min-h-[68px]" href="#/">Home</a>}
          </div>
        </section>
      </main>
    </div>
  )
}

/** Play again, optionally at a different stake (e.g. step down after a big game). */
function PlayAgain({ stake }: { stake: bigint }) {
  const { config } = useConfig()
  const [next, setNext] = useState(stake)
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-4 gap-2" role="group" aria-label="Stake for the next game">
        {allowedStakes(config).map((s) => (
          <button key={String(s)} type="button" aria-pressed={s === next} onClick={() => { setNext(s); saveStake(s) }}
            className={`border-[3px] border-ink py-1 text-[13px] font-bold ${s === next ? 'bg-ink text-signal' : 'bg-panel hover:bg-signal'}`}>
            {sol(s, 2)}
          </button>
        ))}
      </div>
      <a className="btn" href={playHref(next)}><span>Play again</span><span className="tag">{sol(next, 2)} SOL</span></a>
    </div>
  )
}

function Message({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex min-h-svh flex-col">
      <Nav />
      <main className="flex flex-col gap-5 px-4 py-8 md:px-12">
        <h1 className="mega text-[clamp(40px,7vw,96px)]">{title}</h1>
        <p className="text-ink-2">{text}</p>
        <a className="ghost max-w-[320px]" href="#/">Home</a>
      </main>
    </div>
  )
}
