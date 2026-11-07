import { createNoopSigner, getBase64Encoder, getTransactionDecoder, type Address, type TransactionSigner } from '@solana/kit'
import { findGamePda, getStartGameInstructionAsync } from '../program'
import { buildMessage, messageBytes, type Lifetime } from './solana'

/** X's partly-signed start_game, as received by O. */
export type Offer = { tx: string; game: Address; nonce: bigint; lifetime: Lifetime }

/** What O knows independently of the offer. */
export type OfferContext = {
  wallet: TransactionSigner
  session: Address
  opponent: { wallet: string; session: string }
  stake: bigint
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * O rebuilds the start_game transaction it expects (its own wallet and session, the opponent's,
 * the chosen stake) and signs only if X's offer is that exact message. Anything else — a swapped
 * session key, an extra instruction, a different stake — is refused.
 */
export async function checkOffer(offer: Offer, { wallet, session, opponent, stake }: OfferContext) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(offer.tx))
  const x = createNoopSigner(opponent.wallet as Address)
  const ix = await getStartGameInstructionAsync({
    playerX: x,
    playerO: wallet,
    sessionX: opponent.session as Address,
    sessionO: session,
    nonce: offer.nonce,
    stake,
  })
  const expected = messageBytes(await buildMessage(x, [ix], offer.lifetime))
  const [game] = await findGamePda({ playerX: x.address, nonce: offer.nonce })
  if (game !== offer.game || !sameBytes(expected, tx.messageBytes)) {
    throw new Error("Opponent's transaction doesn't match this match. Not signing.")
  }
  // The wire format doesn't carry the expiry, so restore it from the offer.
  return { ...tx, lifetimeConstraint: offer.lifetime }
}
