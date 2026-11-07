/**
 * Live check of Supabase matchmaking from Node: real SupabaseTransport and Matchmaker, separate
 * sockets per client. It uses its own cluster name, so it never meets real players.
 *
 *   VITE_SUPABASE_URL=https://<ref>.supabase.co 
 *   VITE_SUPABASE_ANON_KEY=<key> npx 
 *   tsx scripts/supabase-smoke.ts
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSigner, getBase58Decoder, getUtf8Encoder, signBytes, type KeyPairSigner } from '@solana/kit'
import { joinMessage, Matchmaker, type Direct, type Pairing, type Peer } from '../src/lib/matchmaking-core.ts'
import { SupabaseTransport } from '../src/lib/matchmaking-supabase.ts'

const CLUSTER = 'smoketest'
const URL = process.env.VITE_SUPABASE_URL
const KEY = process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY')

const t0 = performance.now()
const log = (s: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${s}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(label: string, ok: () => boolean, ms = 10_000) {
  const start = performance.now()
  while (!ok()) {
    if (performance.now() - start > ms) throw new Error(`timed out after ${ms} ms: ${label}`)
    await sleep(50)
  }
  log(`ok  ${label} (${Math.round(performance.now() - start)} ms)`)
}

function client() {
  const transport = new SupabaseTransport(URL!, KEY!, `ttsol-queue-${CLUSTER}`)
  return { transport, mm: new Matchmaker(transport, CLUSTER), subscribed: () => transport['subscribed'] as boolean }
}

/** A player whose "wallet" is a local keypair standing in for Phantom's signMessage. */
async function player(wallet?: KeyPairSigner) {
  const w = wallet ?? (await generateKeyPairSigner())
  const session = await generateKeyPairSigner()
  return {
    session,
    async entry(stake: bigint, joinedAt = Date.now(), signer = w) {
      const message = joinMessage({ wallet: w.address, session: session.address, stake: stake.toString(), joinedAt, cluster: CLUSTER })
      const signature = getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, getUtf8Encoder().encode(message)))
      return { wallet: w.address, session, stake, joinedAt, proof: { message, signature } }
    },
  }
}

if (process.argv.includes('--child')) {
  // Joins and then idles until it is killed without leaving.
  const c = client()
  const p = await player()
  await waitFor('child subscribed', c.subscribed)
  c.mm.join(await p.entry(4000n))
  console.log(`READY ${p.session.address}`)
  await new Promise(() => {})
}

const ids = (q: Peer[]) => q.map((p) => p.id)
let child: ReturnType<typeof spawn> | undefined
const spectator = client()
const a = client()
const b = client()
let queue: Peer[] = []
spectator.mm.onQueue((q) => (queue = q))
const pairs: Record<string, Pairing> = {}
const got: Record<string, { msg: Direct; from: Peer }[]> = { a: [], b: [] }
a.mm.onPaired((p) => (pairs.a = p))
b.mm.onPaired((p) => (pairs.b = p))
a.mm.onDirect((msg, from) => got.a.push({ msg, from }))
b.mm.onDirect((msg, from) => got.b.push({ msg, from }))

try {
  log(`connecting 3 clients to ${URL}`)
  await waitFor('all three SUBSCRIBED', () => spectator.subscribed() && a.subscribed() && b.subscribed())

  const pa = await player()
  const pb = await player()
  const aEntry = await pa.entry(1000n)
  a.mm.join(aEntry)
  b.mm.join(await pb.entry(2000n))
  await waitFor('spectator sees A and B (different stakes, verified proofs)', () => ids(queue).includes(pa.session.address) && ids(queue).includes(pb.session.address))
  const hb = a.transport['hb'] as number
  await sleep(3000)
  if (pairs.a || pairs.b) throw new Error('different stakes paired')
  log('ok  no pairing across stakes after 3 s')
  // Each client sees its own entry, so it re-tracks only on the 5 s heartbeat, not every second.
  if ((a.transport['hb'] as number) - hb > 1) throw new Error(`A re-tracked ${(a.transport['hb'] as number) - hb} times in 3 s`)
  log(`ok  no redundant re-tracks (hb ${hb} → ${a.transport['hb']})`)

  const forger = client()
  const pf = await player()
  await waitFor('forger SUBSCRIBED', forger.subscribed)
  log('    forger joins with a proof signed by the wrong wallet (its own warning below is expected)')
  forger.mm.join(await pf.entry(1000n, Date.now(), await generateKeyPairSigner()))
  await sleep(3000)
  if (ids(queue).includes(pf.session.address)) throw new Error('entry with a forged proof is visible')
  const raw = Object.values(spectator.transport['channel']!.presenceState()).flat() as unknown as Peer[]
  log(`ok  forged-proof entry ignored (it is in presence: ${raw.some((p) => p.id === pf.session.address)})`)
  forger.mm.dispose()

  b.mm.leave()
  await waitFor('B gone from the queue after leave (untrack)', () => !ids(queue).includes(pb.session.address))

  b.mm.join(await pb.entry(1000n))
  await waitFor('A and B pair at the same stake', () => !!pairs.a && !!pairs.b)
  log(`    A is ${pairs.a.role.toUpperCase()}, B is ${pairs.b.role.toUpperCase()}; opponents match: ${pairs.a.opponent.id === pb.session.address && pairs.b.opponent.id === pa.session.address}`)
  await waitFor('queue empty once paired', () => queue.length === 0)

  const [x, o, xn, on] = pairs.a.role === 'x' ? [a, b, 'a', 'b'] : [b, a, 'b', 'a']
  x.mm.send(pairs[xn].opponent, { type: 'offer', tx: 'dummy', game: 'G', nonce: '1', blockhash: 'h', lastValidBlockHeight: '1' })
  await waitFor('signed offer X → O', () => got[on].some((g) => g.msg.type === 'offer' && g.from.id === pairs[xn].me.id))
  o.mm.send(pairs[on].opponent, { type: 'started', game: 'G' })
  await waitFor('signed started O → X', () => got[xn].some((g) => g.msg.type === 'started'))

  // A client whose socket stays open but whose heartbeat stops: presence keeps it, we must not.
  const frozen = client()
  const pz = await player()
  await waitFor('frozen client SUBSCRIBED', frozen.subscribed)
  frozen.mm.join(await pz.entry(3000n))
  await waitFor('spectator sees the soon-frozen client', () => ids(queue).includes(pz.session.address))
  clearInterval(frozen.transport['timer'])
  clearInterval(frozen.mm['timer'])
  log('    heartbeat stopped, socket left open')
  await waitFor('frozen client expires (15 s heartbeat timeout)', () => !ids(queue).includes(pz.session.address), 25_000)
  const stillInPresence = Object.values(spectator.transport['channel']!.presenceState()).flat().some((p: any) => p.id === pz.session.address)
  log(`    still in Supabase presence when it expired: ${stillInPresence}`)
  frozen.transport.close()

  // A client process killed without leaving.
  child = spawn(process.execPath, [...process.execArgv, process.argv[1], '--child'], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
  let childId = ''
  child.stdout!.on('data', (d) => (childId ||= /READY (\w+)/.exec(String(d))?.[1] ?? ''))
  await waitFor('child process joined', () => !!childId, 15_000)
  await waitFor('spectator sees the child process', () => ids(queue).includes(childId), 15_000)
  child.kill('SIGKILL')
  log('    child killed with SIGKILL')
  await waitFor('killed child disappears', () => !ids(queue).includes(childId), 25_000)

  log('ALL CHECKS PASSED')
  process.exitCode = 0
} catch (e) {
  log(`FAILED: ${(e as Error).message}`)
  process.exitCode = 1
} finally {
  child?.kill('SIGKILL')
  ;[spectator, a, b].forEach((c) => c.mm.dispose())
  await sleep(500)
  process.exit()
}
