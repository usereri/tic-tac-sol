// Creates (or updates) the Config + Jackpot accounts, and the Leaderboard if it doesn't exist yet. Usage:
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
  fetchMaybeLeaderboard,
  findConfigPda,
  findLeaderboardPda,
  getInitConfigInstructionAsync,
  getInitLeaderboardInstructionAsync,
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
  turnSlots: BigInt(process.env.TURN_SLOTS ?? 30), // ≈ 12 s per turn at the start; 2 slots shorter every ~10 s of game time, down to 12 (≈ 4.8 s); the first move gets 25 extra slots
  abandonSlots: 150n, // ≈ 60 s
  drainFloorBps: 1_000, // 10%
  rakeBps: 200, // 2% of every pot to the jackpot
  drawThreshold: BigInt(process.env.DRAW_THRESHOLD ?? 500_000_000), // 0.5 SOL starts a draw...
  drawGames: 10, // ...over the next 10 games
  relaxedSlots: 450n, // ≈ 3 min for a whole relaxed game
}

const rpc = createSolanaRpc(rpcUrl)
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl)
const admin = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))))

const [configAddress] = await findConfigPda()
const [leaderboardAddress] = await findLeaderboardPda()
const [existing, leaderboard] = await Promise.all([
  fetchMaybeConfig(rpc, configAddress),
  fetchMaybeLeaderboard(rpc, leaderboardAddress),
])
const ixs: Instruction[] = [
  existing.exists
    ? await getUpdateConfigInstructionAsync({ admin, args: settings })
    : await getInitConfigInstructionAsync({ admin, args: settings }),
]
// The leaderboard outlives config versions; create it only the first time.
if (!leaderboard.exists) ixs.push(await getInitLeaderboardInstructionAsync({ admin }))

const { value: blockhash } = await rpc.getLatestBlockhash().send()
const tx = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(admin, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  ),
)
await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(tx, { commitment: 'confirmed' })
console.log(`${existing.exists ? 'Updated' : 'Created'} config ${configAddress} on ${rpcUrl}`)
if (!leaderboard.exists) console.log(`Created leaderboard ${leaderboardAddress}`)
console.log(`tx ${getSignatureFromTransaction(tx)}`)
