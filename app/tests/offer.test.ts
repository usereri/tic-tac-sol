import { beforeAll, describe, expect, it } from 'vitest'
import {
  createNoopSigner,
  generateKeyPairSigner,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  AccountRole,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { findGamePda, GameMode, getStartGameInstructionAsync } from '../src/program'
import { buildMessage, type Lifetime } from '../src/lib/solana'
import { checkOffer, type Offer, type OfferContext } from '../src/lib/offer'

const STAKE = 1_000_000n
const NONCE = 1234n
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111' as Address
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95' as Address
const REFUSED = /was refused/

let xWallet: KeyPairSigner, oWallet: KeyPairSigner, xSession: KeyPairSigner, oSession: KeyPairSigner
let lifetime: Lifetime

async function makeOffer(opts: { sessionO?: Address; stake?: bigint; mode?: GameMode; extra?: Instruction[]; lifetime?: Lifetime } = {}) {
  const ix = await getStartGameInstructionAsync({
    playerX: xWallet,
    playerO: createNoopSigner(oWallet.address),
    sessionX: xSession,
    sessionO: opts.sessionO ?? oSession.address,
    nonce: NONCE,
    stake: opts.stake ?? STAKE,
    mode: opts.mode ?? GameMode.Timed,
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
  mode: GameMode.Timed,
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
    await expect(checkOffer(await makeOffer({ sessionO: other.address }), ctx())).rejects.toThrow(/accounts differ/)
  })

  it('rejects an appended instruction', async () => {
    const extra = getTransferSolInstruction({ source: createNoopSigner(oWallet.address), destination: xWallet.address, amount: 5n })
    await expect(checkOffer(await makeOffer({ extra: [extra] }), ctx())).rejects.toThrow(REFUSED)
  })

  it('rejects a different mode', async () => {
    await expect(checkOffer(await makeOffer({ mode: GameMode.Relaxed }), ctx())).rejects.toThrow(REFUSED)
    await expect(checkOffer(await makeOffer(), ctx({ mode: GameMode.Relaxed }))).rejects.toThrow(REFUSED)
  })

  it('rejects a different stake', async () => {
    await expect(checkOffer(await makeOffer({ stake: STAKE * 2n }), ctx())).rejects.toThrow(REFUSED)
    await expect(checkOffer(await makeOffer(), ctx({ stake: STAKE * 2n }))).rejects.toThrow(REFUSED)
  })

  it('rejects when offer.nonce differs from the one in the message', async () => {
    const offer = await makeOffer()
    await expect(checkOffer({ ...offer, nonce: NONCE + 1n }, ctx())).rejects.toThrow(REFUSED)
  })

  it('rejects when offer.game does not match', async () => {
    const offer = await makeOffer()
    const other = (await generateKeyPairSigner()).address
    await expect(checkOffer({ ...offer, game: other }, ctx())).rejects.toThrow(REFUSED)
  })

  it('rejects when the opponent wallet differs (impersonation)', async () => {
    const mallory = await generateKeyPairSigner()
    const offer = await makeOffer()
    await expect(checkOffer(offer, ctx({ opponent: { wallet: mallory.address, session: xSession.address } }))).rejects.toThrow(REFUSED)
  })

  it("uses the message's blockhash and the offer's lastValidBlockHeight", async () => {
    const offer = await makeOffer()
    const other = await getAddressFromPublicKey((await generateKeyPairSigner()).keyPair.publicKey)
    const swapped = { blockhash: other as unknown as Blockhash, lastValidBlockHeight: 777n }
    const tx = await checkOffer({ ...offer, lifetime: swapped }, ctx())
    expect(tx.lifetimeConstraint).toEqual({ blockhash: lifetime.blockhash, lastValidBlockHeight: 777n })
  })

  it('accepts extra ComputeBudget and Lighthouse instructions that avoid O', async () => {
    const price = new Uint8Array(9)
    price[0] = 3
    new DataView(price.buffer).setBigUint64(1, 5000n, true)
    const budget: Instruction = { programAddress: COMPUTE_BUDGET, data: price }
    const lighthouse: Instruction = {
      programAddress: LIGHTHOUSE,
      accounts: [{ address: xWallet.address, role: AccountRole.READONLY }],
      data: new Uint8Array([1, 2, 3]),
    }
    const tx = await checkOffer(await makeOffer({ extra: [budget, lighthouse] }), ctx())
    expect(tx.lifetimeConstraint.blockhash).toBe(lifetime.blockhash)
  })

  it("rejects a Lighthouse instruction referencing O's wallet or session", async () => {
    for (const touched of [oWallet.address, oSession.address]) {
      const lighthouse: Instruction = {
        programAddress: LIGHTHOUSE,
        accounts: [{ address: touched, role: AccountRole.READONLY }],
        data: new Uint8Array([1]),
      }
      await expect(checkOffer(await makeOffer({ extra: [lighthouse] }), ctx())).rejects.toThrow(/touches your account/)
    }
  })

  it('rejects an unknown extra program', async () => {
    const unknown: Instruction = { programAddress: (await generateKeyPairSigner()).address, data: new Uint8Array([0]) }
    await expect(checkOffer(await makeOffer({ extra: [unknown] }), ctx())).rejects.toThrow(/unexpected instruction/)
  })

  it('rejects two game instructions', async () => {
    const ix = await getStartGameInstructionAsync({
      playerX: xWallet,
      playerO: createNoopSigner(oWallet.address),
      sessionX: xSession,
      sessionO: oSession.address,
      nonce: NONCE,
      stake: STAKE,
      mode: GameMode.Timed,
    })
    await expect(checkOffer(await makeOffer({ extra: [ix] }), ctx())).rejects.toThrow(/exactly one game instruction/)
  })
})
