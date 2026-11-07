/**
 * First-in, first-out matchmaking. Nothing touches the chain until two players are paired.
 *
 * With VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY set, players on any device meet over
 * Supabase Realtime, one channel per cluster. Without them a BroadcastChannel pairs tabs of
 * the same browser, which is enough for local testing against surfpool.
 */
import { BroadcastTransport } from './matchmaking-broadcast'
import { Matchmaker } from './matchmaking-core'
import { SupabaseTransport } from './matchmaking-supabase'
import { CLUSTER } from './solana'

export { joinMessage, type Direct, type JoinProof, type Pairing, type Peer } from './matchmaking-core'

const SUPABASE_URL: string | undefined = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY

export const matchmaker = new Matchmaker(
  SUPABASE_URL && SUPABASE_KEY
    ? new SupabaseTransport(SUPABASE_URL, SUPABASE_KEY, `ttsol-queue-${CLUSTER}`)
    : new BroadcastTransport(),
  CLUSTER,
)

// Leave the queue when Vite hot-swaps this module, so no ghost of us stays in it.
import.meta.hot?.dispose(() => matchmaker.dispose())
