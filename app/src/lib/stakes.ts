import type { Settings } from '../program'

/** Stake choices (lamports per player). Players are only matched with the same stake. */
export const STAKES = [10_000_000n, 50_000_000n, 100_000_000n, 250_000_000n]
export const DEFAULT_STAKE = 50_000_000n

const KEY = 'ttsol:stake'
const MODE_KEY = 'ttsol:mode'

/** `timed`: a speeding-up clock per turn. `relaxed`: no turn clock, 3 min for the whole game. */
export type Mode = 'timed' | 'relaxed'

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

export function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'relaxed' ? 'relaxed' : 'timed'
  } catch {
    return 'timed'
  }
}

export function saveMode(mode: Mode) {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch { /* private mode */ }
}

/** `#/play/<lamports>`, plus `/relaxed` for a relaxed game. */
export function playHref(stake: bigint, mode: Mode = 'timed') {
  return mode === 'relaxed' ? `#/play/${stake}/relaxed` : `#/play/${stake}`
}

export function parseMode(raw: string | undefined): Mode {
  return raw === 'relaxed' ? 'relaxed' : 'timed'
}

export const MODE_LABEL: Record<Mode, string> = { timed: 'Timed', relaxed: 'Relaxed · 3 min' }

export function parseStake(raw: string | undefined) {
  if (!raw || !/^\d+$/.test(raw)) return savedStake()
  return BigInt(raw)
}
