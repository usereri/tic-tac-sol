import { useEffect, useState } from 'react'
import { getBase64Encoder, type Address, type KeyPairSigner, type TransactionSigner } from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  fetchConfig,
  fetchMaybeJackpot,
  findConfigPda,
  findJackpotPda,
  getClaimTimeoutInstructionAsync,
  getCloseGameInstruction,
  getGameDecoder,
  getGameSize,
  getJackpotSize,
  getMakeMoveInstructionAsync,
  GameStatus,
  type Settings,
  type Game,
} from '../program'
import { rpc, rpcSubscriptions, send, type Sent } from './solana'

export const X = 1
export const O = 2
export { GameStatus }
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
      setError(String(e?.message ?? e))
    })
  }, [])
  return { config, error }
}

export function useJackpot() {
  const [jackpot, setJackpot] = useState<{ balance: bigint; drained: number } | null>(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      const [addr] = await findJackpotPda()
      const [account, rent] = await Promise.all([
        fetchMaybeJackpot(rpc, addr),
        rpc.getMinimumBalanceForRentExemption(BigInt(getJackpotSize())).send(),
      ])
      if (live && account.exists) {
        setJackpot({ balance: account.lamports - rent, drained: account.data.drainedCount })
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

/* ---------------- Writes ---------------- */

type GameRef = { address: Address; game: Game }

function playAccounts({ address, game }: GameRef) {
  return { game: address, playerX: game.playerX, playerO: game.playerO }
}

export async function makeMove(session: KeyPairSigner, ref: GameRef, cell: number): Promise<Sent> {
  const ix = await getMakeMoveInstructionAsync({ signer: session, ...playAccounts(ref), cell })
  return send(session, [ix])
}

export async function claimTimeout(session: KeyPairSigner, ref: GameRef): Promise<Sent> {
  const ix = await getClaimTimeoutInstructionAsync({ signer: session, ...playAccounts(ref) })
  return send(session, [ix])
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

/** What each side got, derived from the final state (pot = initial pot − fees). */
export function payouts(game: Game) {
  const pot = game.initialPot - game.feesPaid
  switch (game.status) {
    case GameStatus.Won:
    case GameStatus.WonByTimeout:
      return game.winner === X ? { x: pot, o: 0n, jackpot: 0n } : { x: 0n, o: pot, jackpot: 0n }
    case GameStatus.Split:
      return { x: pot / 2n, o: pot / 2n, jackpot: pot % 2n }
    case GameStatus.Drained:
      return { x: 0n, o: 0n, jackpot: pot }
    default:
      return { x: 0n, o: 0n, jackpot: 0n }
  }
}
