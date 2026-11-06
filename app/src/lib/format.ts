export const LAMPORTS_PER_SOL = 1_000_000_000n

export function short(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

/** Lamports as SOL with a fixed number of decimals, without float rounding surprises. */
export function sol(lamports: bigint | number, decimals = 6) {
  const value = BigInt(lamports)
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / LAMPORTS_PER_SOL
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, decimals)
  return `${negative ? '−' : ''}${whole}${decimals ? '.' + frac : ''}`
}

export const COORDS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']
