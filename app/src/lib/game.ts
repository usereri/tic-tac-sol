import { useEffect, useState } from 'react'
import { getBase64Encoder, isSolanaError, SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND, type Address, type KeyPairSigner, type TransactionSigner } from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  fetchConfig,
  fetchMaybeJackpot,
  findConfigPda,
  findJackpotPda,
  findActiveXPda,
  findActiveOPda,
  findLeaderboardPda,
  fetchMaybeActiveGame,
  fetchMaybeLeaderboard,
  getClaimTimeoutInstructionAsync,
  getSettleAbandonedInstructionAsync,
  getCloseGameInstruction,
  getGameDecoder,
  getGameSize,
  getJackpotSize,
  getMakeMoveInstructionAsync,
  GameMode,
  GameStatus,
  type Settings,
  type Game,
} from '../program'
import { rpc, rpcSubscriptions, send, type Sent } from './solana'

export const X = 1
export const O = 2
export { GameMode, GameStatus }
export type { Game }

/* ---------------- Reads ---------------- */

let configPromise: Promise<Settings> | null = null
export function getConfig() {
  configPromise ??= findConfigPda().then(([addr]) => fetchConfig(rpc, addr)).then((a) => a.data.args)
  return configPromise
}

export function useConfig() {
  const [config, setConfig] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    getConfig().then(setConfig, (e) => {
      configPromise = null
      setError(
        isSolanaError(e, SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND)
          ? "The game isn't set up on this network yet (no config account). Run init-config for this RPC."
          : `Can't reach the game program: ${e?.message ?? e}`,
      )
    })
  }, [])
  return { config, error }
}

export type JackpotView = { balance: bigint; drawLeft: number; lastWin: bigint }

export function useJackpot() {
  const [jackpot, setJackpot] = useState<JackpotView | null>(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      const [addr] = await findJackpotPda()
      const [account, rent] = await Promise.all([
        fetchMaybeJackpot(rpc, addr),
        rpc.getMinimumBalanceForRentExemption(BigInt(getJackpotSize())).send(),
      ])
      if (live && account.exists) {
        setJackpot({ balance: account.lamports - rent, drawLeft: account.data.drawLeft, lastWin: account.data.lastWin })
      }
    })().catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return jackpot
}

let gameRent: bigint | null = null
export async function getGameRent() {
  gameRent ??= await rpc.getMinimumBalanceForRentExemption(BigInt(getGameSize())).send()
  return gameRent
}

export type GameView = { game: Game; lamports: bigint }

const base64 = getBase64Encoder()
function decode(data: string) {
  return getGameDecoder().decode(base64.encode(data))
}

/**
 * Live game account: one fetch, then a websocket subscription. `closed` once close_game ran.
 * Slot-dedupes so an older update never overwrites a newer one.
 */
export function useGame(address: Address | null) {
  const [view, setView] = useState<GameView | null>(null)
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    if (!address) return
    const abort = new AbortController()
    let lastSlot = 0n
    const apply = (slot: bigint, lamports: bigint, data: string) => {
      if (slot < lastSlot) return
      lastSlot = slot
      if (!data || lamports === 0n) {
        setClosed(true)
        return
      }
      setView({ game: decode(data), lamports })
    }

    ;(async () => {
      const notifications = await rpcSubscriptions
        .accountNotifications(address, { commitment: 'confirmed', encoding: 'base64' })
        .subscribe({ abortSignal: abort.signal })
      const { context, value } = await rpc
        .getAccountInfo(address, { commitment: 'confirmed', encoding: 'base64' })
        .send()
      if (value) apply(context.slot, value.lamports, value.data[0])
      for await (const n of notifications) apply(n.context.slot, n.value.lamports, n.value.data[0])
    })().catch(() => {})

    return () => abort.abort()
  }, [address])

  return { view, closed }
}

/** Current slot over the websocket; drives the turn clock. */
export function useSlot() {
  const [slot, setSlot] = useState<bigint | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    ;(async () => {
      setSlot(await rpc.getSlot({ commitment: 'processed' }).send())
      const stream = await rpcSubscriptions.slotNotifications().subscribe({ abortSignal: abort.signal })
      for await (const n of stream) setSlot(n.slot)
    })().catch(() => {})
    return () => abort.abort()
  }, [])
  return slot
}

/**
 * Keeps one tab in charge of a game. Another tab of the same browser that opens it sees `taken`
 * and can `takeOver`, which moves the game to it and sends the first tab to `taken`.
 */
export function useTabLock(name: string | null) {
  const [state, setState] = useState<'checking' | 'mine' | 'taken'>('checking')
  const [takeovers, setTakeovers] = useState(0)
  useEffect(() => {
    if (!name || !navigator.locks) return setState('mine')
    let release = () => {}
    const held = new Promise<void>((r) => (release = r))
    navigator.locks
      .request(name, takeovers > 0 ? { steal: true } : { ifAvailable: true }, async (lock) => {
        if (!lock) return setState('taken')
        setState('mine')
        await held
      })
      .catch(() => setState('taken')) // another tab took it over
    return () => release()
  }, [name, takeovers])
  return { state, takeOver: () => setTakeovers((n) => n + 1) }
}

/** The game this wallet is still playing, if any. The lock account only exists during a game. */
export async function activeGameOf(wallet: Address): Promise<Address | null> {
  const [pda] = await findActiveXPda({ playerX: wallet })
  const lock = await fetchMaybeActiveGame(rpc, pda)
  return lock.exists ? lock.data.game : null
}

export type LeaderRow = { wallet: Address; played: number; won: number; staked: bigint; paid: bigint }

/** The on-chain top-50 board (one shared account). */
export async function fetchLeaderboard(): Promise<LeaderRow[]> {
  const [pda] = await findLeaderboardPda()
  const board = await fetchMaybeLeaderboard(rpc, pda)
  if (!board.exists) return []
  return board.data.entries.slice(0, board.data.len).map((e) => ({
    wallet: e.wallet,
    played: e.played,
    won: e.won,
    staked: e.staked,
    paid: e.paid,
  }))
}

/* ---------------- Writes ---------------- */

type GameRef = { address: Address; game: Game }

async function playAccounts({ address, game }: GameRef) {
  const [[activeX], [activeO]] = await Promise.all([
    findActiveXPda({ playerX: game.playerX }),
    findActiveOPda({ playerO: game.playerO }),
  ])
  return { game: address, playerX: game.playerX, playerO: game.playerO, activeX, activeO }
}

export async function makeMove(session: KeyPairSigner, ref: GameRef, cell: number): Promise<Sent> {
  const ix = await getMakeMoveInstructionAsync({ signer: session, ...(await playAccounts(ref)), cell })
  return send(session, [ix])
}

export async function claimTimeout(session: KeyPairSigner, ref: GameRef): Promise<Sent> {
  const ix = await getClaimTimeoutInstructionAsync({ signer: session, ...(await playAccounts(ref)) })
  return send(session, [ix])
}

/** Both players left: 50/50 after the claim window. Any signer works; the escrow refunds its fee. */
export async function settleAbandoned(signer: KeyPairSigner, ref: GameRef): Promise<Sent> {
  const ix = await getSettleAbandonedInstructionAsync({ signer, ...(await playAccounts(ref)) })
  return send(signer, [ix])
}

/** Returns the game account's rent to X. Any signer can pay the fee. */
export async function closeGame(payer: TransactionSigner, ref: GameRef): Promise<Sent> {
  return send(payer, [getCloseGameInstruction({ game: ref.address, playerX: ref.game.playerX })])
}

/** Sends everything left in a one-off session wallet back to the player's wallet. */
export async function sweepSession(session: KeyPairSigner, to: Address): Promise<Sent | null> {
  const { value } = await rpc.getBalance(session.address, { commitment: 'confirmed' }).send()
  const fee = 5_000n
  if (value <= fee) return null
  return send(session, [getTransferSolInstruction({ source: session, destination: to, amount: value - fee })])
}

/* ---------------- Rules (mirror of the program, for the UI) ---------------- */

// Same as the program's turn_slots_at: 2 slots shorter every 25 slots (~10 s) of game time,
// never below 12 (~4.8 s).
const TURN_STEP_EVERY_SLOTS = 25n
const TURN_STEP_SLOTS = 2n
const TURN_MIN_SLOTS = 12n
/** Extra slots for the first move: X hears about the game a few seconds after it starts. */
export const START_GRACE_SLOTS = 25n

/** Slots the player to move has, `elapsed` slots into the game. */
export function turnSlotsAt(start: bigint, elapsed: bigint) {
  const reduced = start - (elapsed / TURN_STEP_EVERY_SLOTS) * TURN_STEP_SLOTS
  const floor = TURN_MIN_SLOTS < start ? TURN_MIN_SLOTS : start
  return reduced > floor ? reduced : floor
}

/**
 * The program's `deadline()`: the last slot the player to move may act in, and how many slots
 * the current turn (timed) or the whole game (relaxed) had in total.
 */
export function turnDeadline(game: Game, config: Pick<Settings, 'turnSlots' | 'relaxedSlots'>) {
  if (game.mode === GameMode.Relaxed) {
    return { deadline: game.startedSlot + config.relaxedSlots, window: config.relaxedSlots }
  }
  const slots = turnSlotsAt(config.turnSlots, game.lastActionSlot - game.startedSlot)
  const window = game.moveCount === 0 ? slots + START_GRACE_SLOTS : slots
  return { deadline: game.lastActionSlot + window, window }
}

/** After this slot anyone may settle 50/50 (the program's `abandoned_after`). */
export function abandonedAfter(game: Game, config: Pick<Settings, 'turnSlots' | 'relaxedSlots' | 'abandonSlots'>) {
  const { deadline } = turnDeadline(game, config)
  return game.mode === GameMode.Relaxed ? deadline : deadline + config.abandonSlots
}

export const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]

export function marksOf(game: Game, player: number) {
  return player === X ? [...game.queueX.slice(0, game.lenX)] : [...game.queueO.slice(0, game.lenO)]
}

/** The cell that disappears on `player`'s next move, if they already have 3 marks. */
export function nextToFade(game: Game, player: number) {
  const marks = marksOf(game, player)
  return marks.length === 3 ? marks[0] : null
}

export function canPlace(game: Game, cell: number) {
  return game.board[cell] === 0
}

export function winningLine(board: ArrayLike<number>, player: number) {
  return WIN_LINES.find((line) => line.every((c) => board[c] === player)) ?? null
}

/** All to X, all to O, or halves with the odd lamport to O, like the program's `shares`. */
function shares(winner: number, amount: bigint) {
  if (winner === X) return { x: amount, o: 0n }
  if (winner === O) return { x: 0n, o: amount }
  return { x: amount / 2n, o: amount - amount / 2n }
}

/**
 * What each side got, from the final state: the pot (initial pot − fees) minus what went to the
 * jackpot, plus any jackpot this game won in a draw.
 */
export function payouts(game: Game) {
  if (game.status === GameStatus.Active) return { x: 0n, o: 0n, jackpot: 0n, jackpotWon: 0n }
  const prize = game.initialPot - game.feesPaid - game.raked
  const pot = game.status === GameStatus.Drained ? { x: 0n, o: 0n } : shares(game.winner, prize)
  const won = shares(game.winner, game.jackpotWon)
  return { x: pot.x + won.x, o: pot.o + won.o, jackpot: game.raked, jackpotWon: game.jackpotWon }
}
