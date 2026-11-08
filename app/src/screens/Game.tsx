import { useEffect, useMemo, useRef, useState } from 'react'
import { address as toAddress, type Address } from '@solana/kit'
import { Board, Mark } from '../components/Board'
import { Alert, Nav } from '../components/Chrome'
import { COORDS, short, sol } from '../lib/format'
import {
  abandonedAfter,
  canPlace,
  claimTimeout,
  settleAbandoned,
  closeGame,
  GameMode,
  GameStatus,
  makeMove,
  nextToFade,
  O,
  payouts,
  sweepSession,
  turnDeadline,
  useConfig,
  useGame,
  useSlot,
  useTabLock,
  winningLine,
  X,
  type Game as GameState,
} from '../lib/game'
import { loadSession, type Session } from '../lib/session'
import { allowedStakes, playHref, saveStake, type Mode } from '../lib/stakes'
import { describeError, explorerTx, SLOT_MS } from '../lib/solana'
import { useWallet } from '../lib/wallet'

type LogEntry = { n: number; player: number; cell: number; ms?: number; signature?: string }

/**
 * The board locks this many slots (~2 s) before the real deadline and the clock counts down to
 * that point, so a move sent at "0.1 s" still has time to land.
 */
const MARGIN_SLOTS = 5

const DEFAULT_TIMING = { turnSlots: 30n, relaxedSlots: 450n, abandonSlots: 150n }

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
  const tab = useTabLock(gameAddress && wallet ? `ttsol:game:${gameAddress}:${wallet.address}` : null)
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
  // Only the tab in charge of this game plays it; others watch until they take over.
  const me = !game || !session || tab.state !== 'mine' ? 0 : session.signer.address === game.sessionX ? X : session.signer.address === game.sessionO ? O : 0
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

  const timing = config ?? DEFAULT_TIMING
  const relaxed = game?.mode === GameMode.Relaxed
  const { deadline, window } = game ? turnDeadline(game, timing) : { deadline: 0n, window: timing.turnSlots }
  const slotsLeft = game && slot !== null ? Number(deadline - slot) : Number(window)
  // What the player sees: time until the board locks, MARGIN_SLOTS before the real deadline.
  const shownSlots = Math.max(0, slotsLeft - MARGIN_SLOTS)
  const shownWindow = Math.max(1, Number(window) - MARGIN_SLOTS)
  const secondsLeft = (shownSlots * SLOT_MS) / 1000
  const locked = shownSlots <= 0

  // Opponent missed the deadline: claim it (wins if they had moved before, else 50/50).
  // Past the claim window (both players were gone), or once a relaxed game ran out, either
  // player settles it 50/50, which also frees both wallets' one-game locks.
  const abandoned = game !== null && slot !== null && slot > abandonedAfter(game, timing)
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
  const ownGame = session && (session.signer.address === game.sessionX || session.signer.address === game.sessionO)
  const clock = relaxed
    ? `${Math.floor(secondsLeft / 60)}:${String(Math.floor(secondsLeft % 60)).padStart(2, '0')}`
    : `${secondsLeft.toFixed(1)} s`

  return (
    <div className="flex min-h-svh flex-col">
      <Nav meta={<><span>Game {short(gameAddress)}</span><span>{relaxed ? 'Relaxed · 3 min' : 'Timed'}</span><span>Move {String(game.moveCount + 1).padStart(2, '0')}</span></>} />
      {ownGame && tab.state === 'taken' && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b-[3px] border-ink bg-signal px-4 py-2 font-bold">
          <span>This game is open in another tab. Play it there, or move it here.</span>
          <button type="button" className="ghost w-auto min-h-[40px] px-4" onClick={tab.takeOver}>Play here</button>
        </div>
      )}
      <main className="grid flex-1 grid-cols-1 items-start gap-5 px-4 py-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)_minmax(0,320px)] lg:gap-8 lg:px-8 lg:py-5">
        <section className="flex flex-col gap-4 lg:gap-5">
          <div className="panel">
            <header><span className="label">Players</span><span className="code">{me ? `You are ${me === X ? 'X' : 'O'}` : 'X moves first'}</span></header>
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
              <header><span className="label">{relaxed ? 'Game time left' : 'Time left'}</span><span className="code hidden sm:inline">{relaxed ? 'no turn clock' : `slot ${shownWindow - shownSlots} / ${shownWindow}`}</span></header>
              <div className="body">
                <div className="num text-[26px] lg:text-[40px]">{clock}</div>
                <div className={`timer ${secondsLeft < (relaxed ? 15 : 2) ? 'urgent' : ''}`}><span style={{ width: `${Math.min(100, (shownSlots / shownWindow) * 100)}%` }} /></div>
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col items-center gap-3">
          {me !== 0 && (
            <div className="flex w-full max-w-[680px] items-center justify-center gap-2 text-[13px] font-bold uppercase tracking-[0.08em]">
              <span className="size-6"><Mark player={me} /></span>
              <span>You play {me === X ? 'X' : 'O'}{me === X ? ' · you move first' : ''}</span>
            </div>
          )}
          <Board
            className="w-full max-w-[min(680px,calc(100svh-190px))]"
            board={game.board}
            fading={fading}
            leaving={pending !== null ? fading : null}
            pending={pending !== null ? { cell: pending, player: me } : null}
            canPlay={(c) => myTurn && !locked && pending === null && canPlace(game, c)}
            onPlay={play}
          />
          <div className="m-0 w-full max-w-[680px] text-center text-[13px] text-ink-2">
            {error
              ? <Alert>{error}</Alert>
              : me === 0
                ? 'Spectating.'
                : myTurn
                  ? fading !== null ? `Your oldest mark at ${COORDS[fading]} disappears when you place.` : 'Your move.'
                  : locked && !relaxed
                    ? `${opp === X ? 'X' : 'O'} is out of time.`
                    : `Waiting for ${opp === X ? 'X' : 'O'}…`}
          </div>
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
          <span className="label">{game.status === GameStatus.Split && game.mode === GameMode.Relaxed ? 'Time ran out · split 50/50' : OUTCOME[game.status]} · move {String(moves).padStart(2, '0')}</span>
          {pay.jackpotWon > 0n && <span className="chip chip-ink self-start text-[13px]">Jackpot draw · this game won {sol(pay.jackpotWon, 4)} SOL</span>}
          <h1 className="mega text-[clamp(50px,8vw,120px)]">{headline}</h1>
          {me !== 0 && (
            <div>
              <span className="label">You played {me === X ? 'X' : 'O'} · </span>
              <span className="label">{mineAmount > 0n ? `Sent to ${walletAddress ? short(walletAddress) : 'your wallet'}` : 'You'}</span>
              <div className="num text-[clamp(30px,5vw,72px)]">{mineAmount > 0n ? `+${sol(mineAmount, 6)} SOL` : 'Better luck next time.'}</div>
            </div>
          )}
          <div className="panel">
            <header><span className="label">Ledger</span><span className="code">{moves} moves</span></header>
            <div className="body"><div className="kv">
              <span>Pot at start</span><span>{sol(game.initialPot, 6)} SOL</span>
              <span>Fees paid to Solana · {moves} moves</span><span>−{sol(game.feesPaid, 6)} SOL</span>
              {pay.jackpot > 0n && <><span>To the jackpot</span><span>−{sol(pay.jackpot, 6)} SOL</span></>}
              {pay.jackpotWon > 0n && <><span>Jackpot draw won</span><span>+{sol(pay.jackpotWon, 6)} SOL</span></>}
              <span>Paid to X</span><span>{sol(pay.x, 6)} SOL</span>
              <span>Paid to O</span><span>{sol(pay.o, 6)} SOL</span>
              <span>Gas deposit</span><span>returned to wallets</span>
            </div></div>
          </div>
          <span className="label">The whole game cost {sol(game.feesPaid, 6)} SOL in fees.</span>
          <PlayAgain stake={game.stake} mode={game.mode === GameMode.Relaxed ? 'relaxed' : 'timed'} />
          <div className="grid grid-cols-2 gap-4">
            <a className="ghost" href="#/">Home</a>
            {log[0]?.signature
              ? <a className="ghost" href={explorerTx(log[0].signature)} target="_blank" rel="noreferrer">Explorer ↗</a>
              : <a className="ghost" href="#/leaderboard">Leaderboard</a>}
          </div>
        </section>
      </main>
    </div>
  )
}

/** Play again, optionally at a different stake (e.g. step down after a big game). */
function PlayAgain({ stake, mode }: { stake: bigint; mode: Mode }) {
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
      <a className="btn" href={playHref(next, mode)}><span>Play again{mode === 'relaxed' ? ' · relaxed' : ''}</span><span className="tag">{sol(next, 2)} SOL</span></a>
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
