// Creates (or updates) the Config + Jackpot accounts. Usage:
//   RPC_URL=http://127.0.0.1:8899 [TURN_SLOTS=12] npx tsx scripts/init-config.ts [path/to/admin-keypair.json]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
} from '@solana/kit'
import {
  fetchMaybeConfig,
  findConfigPda,
  getInitConfigInstructionAsync,
  getUpdateConfigInstructionAsync,
  type SettingsArgs,
} from '../src/program'

const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8899'
const wsUrl = process.env.WS_URL ?? rpcUrl.replace(/^http/, 'ws').replace(/:8899\b/, ':8900')
const keypairPath = process.argv[2] ?? `${homedir()}/.config/solana/id.json`

const settings: SettingsArgs = {
  minStake: 10_000_000n, // 0.01 SOL
  maxStake: 1_000_000_000n, // 1 SOL
  gasDeposit: 1_000_000n, // 0.001 SOL, keeps the one-off wallet rent-exempt
  feeRefund: 5_000n, // the real base fee per signature
  turnSlots: BigInt(process.env.TURN_SLOTS ?? 12), // ≈ 5 s; raise it locally for slow manual testing
  abandonSlots: 150n, // ≈ 60 s
  drainFloorBps: 1_000, // 10%
  jackpotEvery: 10,
}

const rpc = createSolanaRpc(rpcUrl)
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl)
const admin = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))))

const [configAddress] = await findConfigPda()
const existing = await fetchMaybeConfig(rpc, configAddress)
const ix: Instruction = existing.exists
  ? await getUpdateConfigInstructionAsync({ admin, args: settings })
  : await getInitConfigInstructionAsync({ admin, args: settings })

const { value: blockhash } = await rpc.getLatestBlockhash().send()
const tx = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(admin, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  ),
)
await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(tx, { commitment: 'confirmed' })
console.log(`${existing.exists ? 'Updated' : 'Created'} config ${configAddress} on ${rpcUrl}`)
console.log(`tx ${getSignatureFromTransaction(tx)}`)
