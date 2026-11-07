import {
  address,
  createNoopSigner,
  decompileTransactionMessageFetchingLookupTables,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type Blockhash,
  type GetMultipleAccountsApi,
  type Rpc,
  type TransactionSigner,
} from '@solana/kit'
import { findGamePda, getStartGameInstructionAsync, TIC_TAC_SOL_PROGRAM_ADDRESS } from '../program'
import { rpc as defaultRpc, type Lifetime } from './solana'

/** X's partly-signed start_game, as received by O. */
export type Offer = { tx: string; game: Address; nonce: bigint; lifetime: Lifetime }

/** What O knows independently of the offer. */
export type OfferContext = {
  wallet: TransactionSigner
  session: Address
  opponent: { wallet: string; session: string }
  stake: bigint
}

/**
 * Wallets may add their own instructions when X signs (Phantom adds Lighthouse assertions and
 * priority-fee instructions), so the offer can't be compared byte for byte. These are the only
 * extra programs allowed, and they may not touch O's wallet or session.
 */
const EXTRA_PROGRAMS = new Set<string>([
  'ComputeBudget111111111111111111111111111111',
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', // Lighthouse
])

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function refuse(reason: string): never {
  throw new Error(`Opponent's start transaction was refused: ${reason}. Nothing was signed.`)
}

/**
 * O checks X's offer before signing: the fee payer is the opponent, there is exactly one
 * start_game with the accounts and data O expects (both wallets, both sessions, the chosen stake,
 * the nonce, the game), and anything else is a known wallet add-on that doesn't touch O.
 */
export async function checkOffer(
  offer: Offer,
  { wallet, session, opponent, stake }: OfferContext,
  rpc: Rpc<GetMultipleAccountsApi> = defaultRpc,
) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(offer.tx))
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
  const message = await decompileTransactionMessageFetchingLookupTables(compiled as never, rpc)

  const xWallet = address(opponent.wallet)
  if (message.feePayer.address !== xWallet) refuse('the fee payer is not your opponent')

  const expected = await getStartGameInstructionAsync({
    playerX: createNoopSigner(xWallet),
    playerO: wallet,
    sessionX: address(opponent.session),
    sessionO: session,
    nonce: offer.nonce,
    stake,
  })
  const [game] = await findGamePda({ playerX: xWallet, nonce: offer.nonce })
  if (game !== offer.game) refuse('it is for a different game')

  const ours = message.instructions.filter((ix) => ix.programAddress === TIC_TAC_SOL_PROGRAM_ADDRESS)
  if (ours.length !== 1) refuse('it does not contain exactly one game instruction')
  const [ix] = ours
  const accounts = (ix.accounts ?? []).map((a) => a.address)
  const expectedAccounts = expected.accounts.map((a) => a.address)
  if (accounts.length !== expectedAccounts.length || accounts.some((a, i) => a !== expectedAccounts[i])) {
    refuse('its accounts differ from this match (wallets, sessions or game)')
  }
  if (!ix.data || !sameBytes(ix.data, expected.data)) refuse('the stake or game data differ')

  const mine = new Set<string>([wallet.address, session])
  for (const other of message.instructions) {
    if (other === ix) continue
    if (!EXTRA_PROGRAMS.has(other.programAddress)) refuse(`it contains an unexpected instruction (${other.programAddress})`)
    if ((other.accounts ?? []).some((a) => mine.has(a.address))) refuse('a wallet add-on instruction touches your account')
  }

  // The wire format doesn't carry the expiry; use the message's blockhash and X's height.
  const blockhash = (message.lifetimeConstraint as { blockhash: Blockhash }).blockhash
  return { ...tx, lifetimeConstraint: { blockhash, lastValidBlockHeight: offer.lifetime.lastValidBlockHeight } }
}
