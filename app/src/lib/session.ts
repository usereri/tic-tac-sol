import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from '@solana/kit'

/**
 * One-off session wallets. A fresh keypair per game signs every move, so the player's
 * real wallet only signs once (start_game). The seed is kept in localStorage so a reload
 * can continue the game and the leftover gas deposit can be swept back afterwards.
 */
export type Session = { seed: string; signer: KeyPairSigner }

const key = (game: string, wallet: string) => `ttsol:session:${game}:${wallet}`

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string) {
  return new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)))
}

export async function createSession(): Promise<Session> {
  const seed = toHex(crypto.getRandomValues(new Uint8Array(32)))
  return { seed, signer: await createKeyPairSignerFromPrivateKeyBytes(fromHex(seed)) }
}

export function saveSession(game: string, wallet: string, session: Session) {
  localStorage.setItem(key(game, wallet), session.seed)
}

export async function loadSession(game: string, wallet: string): Promise<Session | null> {
  const seed = localStorage.getItem(key(game, wallet))
  if (!seed) return null
  return { seed, signer: await createKeyPairSignerFromPrivateKeyBytes(fromHex(seed)) }
}

export function forgetSession(game: string, wallet: string) {
  localStorage.removeItem(key(game, wallet))
}
