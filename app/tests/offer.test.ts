import { beforeAll, describe, expect, it } from 'vitest'
import {
  createNoopSigner,
  generateKeyPairSigner,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { findGamePda, getStartGameInstructionAsync } from '../src/program'
import { buildMessage, type Lifetime } from '../src/lib/solana'
import { checkOffer, type Offer, type OfferContext } from '../src/lib/offer'

const STAKE = 1_000_000n
const NONCE = 1234n

let xWallet: KeyPairSigner, oWallet: KeyPairSigner, xSession: KeyPairSigner, oSession: KeyPairSigner
let lifetime: Lifetime

async function makeOffer(opts: { sessionO?: Address; stake?: bigint; extra?: Instruction[]; lifetime?: Lifetime } = {}) {
  const ix = await getStartGameInstructionAsync({
    playerX: xWallet,
    playerO: createNoopSigner(oWallet.address),
    sessionX: xSession,
    sessionO: opts.sessionO ?? oSession.address,
    nonce: NONCE,
    stake: opts.stake ?? STAKE,
  })
  const message = await buildMessage(xWallet, [ix, ...(opts.extra ?? [])], opts.lifetime ?? lifetime)
  const tx = await partiallySignTransactionMessageWithSigners(message)
  const [game] = await findGamePda({ playerX: xWallet.address, nonce: NONCE })
  const offer: Offer = { tx: getBase64EncodedWireTransaction(tx), game, nonce: NONCE, lifetime }
  return offer
}

const ctx = (over: Partial<OfferContext> = {}): OfferContext => ({
  wallet: oWallet,
  session: oSession.address,
  opponent: { wallet: xWallet.address, session: xSession.address },
  stake: STAKE,
  ...over,
})

beforeAll(async () => {
  ;[xWallet, oWallet, xSession, oSession] = await Promise.all([1, 2, 3, 4].map(() => generateKeyPairSigner()))
  const hash = await getAddressFromPublicKey((await generateKeyPairSigner()).keyPair.publicKey)
  lifetime = { blockhash: hash as unknown as Blockhash, lastValidBlockHeight: 100n }
})

describe('checkOffer', () => {
  it('accepts a valid offer and restores the lifetime and X signature', async () => {
    const tx = await checkOffer(await makeOffer(), ctx())
    expect(tx.lifetimeConstraint).toEqual(lifetime)
    expect(tx.signatures[xWallet.address]).toBeTruthy()
    expect(tx.signatures[oWallet.address] ?? null).toBeNull()
  })

  it('rejects when X swaps sessionO for another key', async () => {
    const other = await generateKeyPairSigner()
    await expect(checkOffer(await makeOffer({ sessionO: other.address }), ctx())).rejects.toThrow(/Not signing/)
  })

  it('rejects an appended instruction', async () => {
    const extra = getTransferSolInstruction({ source: createNoopSigner(oWallet.address), destination: xWallet.address, amount: 5n })
    await expect(checkOffer(await makeOffer({ extra: [extra] }), ctx())).rejects.toThrow(/Not signing/)
  })

  it('rejects a different stake', async () => {
    await expect(checkOffer(await makeOffer({ stake: STAKE * 2n }), ctx())).rejects.toThrow(/Not signing/)
    await expect(checkOffer(await makeOffer(), ctx({ stake: STAKE * 2n }))).rejects.toThrow(/Not signing/)
  })

  it('rejects when offer.nonce differs from the one in the message', async () => {
    const offer = await makeOffer()
    await expect(checkOffer({ ...offer, nonce: NONCE + 1n }, ctx())).rejects.toThrow(/Not signing/)
  })

  it('rejects when offer.game does not match', async () => {
    const offer = await makeOffer()
    const other = (await generateKeyPairSigner()).address
    await expect(checkOffer({ ...offer, game: other }, ctx())).rejects.toThrow(/Not signing/)
  })

  it('rejects when the opponent wallet differs (impersonation)', async () => {
    const mallory = await generateKeyPairSigner()
    const offer = await makeOffer()
    await expect(checkOffer(offer, ctx({ opponent: { wallet: mallory.address, session: xSession.address } }))).rejects.toThrow(/Not signing/)
  })

  it('rejects when the offer lifetime blockhash differs from the message', async () => {
    const offer = await makeOffer()
    const other = await getAddressFromPublicKey((await generateKeyPairSigner()).keyPair.publicKey)
    const swapped = { blockhash: other as unknown as Blockhash, lastValidBlockHeight: 100n }
    await expect(checkOffer({ ...offer, lifetime: swapped }, ctx())).rejects.toThrow(/Not signing/)
  })
})
