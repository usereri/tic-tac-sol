import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransactionMessageWithSigners,
  partiallySignTransactionWithSigners,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  assertIsFullySignedTransaction,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  compileTransaction,
  type Blockhash,
  type Instruction,
  type Signature,
  type Transaction,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type TransactionSigner,
} from '@solana/kit'

export const CLUSTER = (import.meta.env.VITE_CLUSTER ?? 'localnet') as 'localnet' | 'devnet'
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8899'
export const WS_URL: string = import.meta.env.VITE_WS_URL ?? 'ws://127.0.0.1:8900'
export const CHAIN = `solana:${CLUSTER}` as const

export const rpc = createSolanaRpc(RPC_URL)
export const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL)
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })

/** Approximate slot time, used only to show seconds in the UI. */
export const SLOT_MS = 400

export type Sent = { signature: Signature; ms: number }

export function explorerTx(signature: string) {
  const cluster = CLUSTER === 'localnet' ? `custom&customUrl=${encodeURIComponent(RPC_URL)}` : CLUSTER
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`
}

export type Lifetime = { blockhash: Blockhash; lastValidBlockHeight: bigint }

/** A v0 message. Pass `lifetime` to rebuild a known message byte for byte (see Play's checkOffer). */
export async function buildMessage(feePayer: TransactionSigner, instructions: Instruction[], lifetime?: Lifetime) {
  const blockhash = lifetime ?? (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
}

export async function sendSigned(tx: Transaction): Promise<Sent> {
  assertIsFullySignedTransaction(tx)
  assertIsSendableTransaction(tx)
  assertIsTransactionWithBlockhashLifetime(tx)
  const started = performance.now()
  await sendAndConfirm(tx, { commitment: 'confirmed' })
  return { signature: getSignatureFromTransaction(tx), ms: Math.round(performance.now() - started) }
}

/** Builds, signs (all signers attached to the instructions) and sends. Returns time to confirm. */
export async function send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<Sent> {
  const tx = await signTransactionMessageWithSigners(await buildMessage(feePayer, instructions))
  return sendSigned(tx)
}

/** Signs with whichever attached signers can sign now; the rest (noop signers) stay empty. */
export async function buildPartiallySigned(feePayer: TransactionSigner, instructions: Instruction[]) {
  return partiallySignTransactionMessageWithSigners(await buildMessage(feePayer, instructions))
}

/** The exact bytes a wallet signs for this message. */
export function messageBytes(message: Parameters<typeof compileTransaction>[0]) {
  return compileTransaction(message).messageBytes
}

export async function cosign(tx: Transaction, signer: TransactionSigner) {
  return partiallySignTransactionWithSigners([signer as TransactionPartialSigner | TransactionModifyingSigner], tx)
}

export function wireBase64(tx: Transaction) {
  return getBase64EncodedWireTransaction(tx)
}

/** Readable message for a failed transaction (program error, rejection, etc.). */
export function describeError(err: unknown): string {
  const e = err as { message?: string; context?: { logs?: string[] }; cause?: unknown }
  const logs = e?.context?.logs ?? (e?.cause as { context?: { logs?: string[] } })?.context?.logs
  const anchor = logs?.map((l) => /Error Message: (.*)$/.exec(l)?.[1]).find(Boolean)
  if (anchor) return anchor
  if (/reject/i.test(e?.message ?? '')) return 'Signature request rejected in the wallet.'
  return e?.message ?? String(err)
}
