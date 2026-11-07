import type { Settings } from '../program'

/** Stake choices (lamports per player). Players are only matched with the same stake. */
export const STAKES = [10_000_000n, 50_000_000n, 100_000_000n, 250_000_000n]
export const DEFAULT_STAKE = 50_000_000n

const KEY = 'ttsol:stake'

/** The presets the on-chain config allows. */
export function allowedStakes(config: Settings | null) {
  if (!config) return STAKES
  return STAKES.filter((s) => s >= config.minStake && s <= config.maxStake)
}

export function savedStake() {
  try {
    const v = localStorage.getItem(KEY)
    return v && STAKES.includes(BigInt(v)) ? BigInt(v) : DEFAULT_STAKE
  } catch {
    return DEFAULT_STAKE
  }
}

export function saveStake(stake: bigint) {
  try {
    localStorage.setItem(KEY, stake.toString())
  } catch { /* private mode */ }
}

/** `#/play/<lamports>`; falls back to the saved choice. */
export function playHref(stake: bigint) {
  return `#/play/${stake}`
}

export function parseStake(raw: string | undefined) {
  if (!raw || !/^\d+$/.test(raw)) return savedStake()
  return BigInt(raw)
}
