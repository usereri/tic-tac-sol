# Tic-Tac-Sol

Infinite tic-tac-toe on Solana. Both players stake the same amount (they pick it: 0.01–0.25 SOL in the app, config allows 0.01–1 SOL), every move is an on-chain transaction, and the escrow pays every move's fee.

## Rules

- Each player keeps at most 3 marks. Placing a 4th removes your oldest one first, and you can't place on the cell it just left.
- Three in a row wins the pot, minus the real tx fees paid during the game and a 2% rake to the jackpot.
- Two modes, picked on the home page; players are only matched within the same stake and mode.
- **Relaxed:** no turn clock. The whole game has `relaxed_slots` (450 ≈ 3 min); when it runs out, anyone can settle it 50/50.
- **Timed:** the turn deadline speeds up with game time: a turn starts at `turn_slots` (30 slots ≈ 12 s); every 25 slots (≈ 10 s) since the game started it gets 2 slots shorter, never below 12 slots (≈ 4.8 s). The first move gets 25 extra slots (≈ 10 s), because X only hears the game started a few seconds after the start transaction lands.
  - Idle player had moved before → the waiting player claims the pot (`claim_timeout`).
  - Idle player never moved → 50/50 split.
  - Nobody claims within `abandon_slots` after the deadline → anyone can settle 50/50 (`settle_abandoned`).
- Safety net: if fees ever burn the pot below 10% of its initial value, the rest goes to the jackpot.
- Jackpot draw: once the jackpot holds `draw_threshold` (0.5 SOL), one of the next `draw_games` (10) games to finish wins all of it (its winner, or both halves on a split). Each game in the draw wins with chance 1/(games left), so every game has the same chance and the last one always wins. The randomness is the newest slot hash mixed with the game key and slot: fine for devnet, but a validator or a player timing the finishing move could bias it. A VRF oracle is the production fix.
- In the app, the board locks 2 s before the real deadline and the clock counts down to that point, so a last-moment move still lands.

## Program

`programs/tic-tac-sol` (Anchor 1.x)

| Instruction | Signer | Notes |
| --- | --- | --- |
| `init_config(args)` / `update_config(args)` | admin | Creates/tunes `Config` and creates `Jackpot` (seeds `config_v2`, `jackpot_v2`) |
| `init_leaderboard` | admin | Creates the `Leaderboard` once; it survives config versions |
| `start_game(nonce, stake, mode)` | both players' wallets | Atomic: stake must be within `min_stake..=max_stake`; both stakes in, both one-off wallets funded with `gas_deposit`, game PDA `["game", player_x, nonce]` created |
| (start_game) | | Also creates each wallet's one-game lock `["active", wallet]` and rejects a wallet that is already in a game (`PlayerBusy`). The lock is closed when the game ends and its rent goes back to the player |
| `make_move(cell)` | one-off wallet of the player to move | Escrow pays the fee back to the signer |
| `claim_timeout` | one-off wallet of the waiting player | Within the claim window after a missed deadline |
| `settle_abandoned` | anyone | After the claim window (timed) or once a relaxed game runs out, 50/50. Signer's fee is refunded |
| `close_game` | anyone | Ended games only. Rent goes back to X |

Every game end records both wallets (games played/won, SOL staked/paid) on a shared top-50 `Leaderboard` account `["leaderboard"]`, created and paid for by the admin with `init_leaderboard`. It's keyed by the real wallet, never the one-off session key, and feeds the in-app leaderboard (`#/leaderboard`). When the board is full, a newcomer replaces the lowest-net entry only if it's doing better. Players pay no net rent: the game account's rent returns to X on `close_game`, and each lock's rent returns at game end.

The pot is always the game account's lamports above its rent-exempt minimum. Events `GameStarted`, `MoveMade` and `GameEnded` carry everything the UI needs.

Default config for devnet: min_stake `10_000_000`, max_stake `1_000_000_000`, gas_deposit `1_000_000`, fee_refund `5_000`, turn_slots `30` (start of the speeding-up clock), abandon_slots `150`, drain_floor_bps `1_000`, rake_bps `200`, draw_threshold `500_000_000`, draw_games `10`, relaxed_slots `450`.

## Develop

```sh
anchor build
anchor test   # runs the LiteSVM tests in programs/tic-tac-sol/tests
```

Deploy to devnet:

```sh
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

The program keypair lives in `target/deploy/tic_tac_sol-keypair.json`, and `target/` is gitignored. Back the keypair up, or the program ID changes on the next deploy.

## App (`app/`)

Vite + React + TypeScript + Tailwind v4, `@solana/kit` with a Codama-generated client in `app/src/program`.

Run it against a local surfpool:

```sh
# 1. local network; deploys the program and redeploys when target/deploy changes
NO_DNA=1 surfpool start --no-tui --offline --watch

# 2. create the config (once per fresh surfpool). TURN_SLOTS=150 gives ~60 s turns for manual testing
cd app && npm install
npx tsx scripts/init-config.ts            # or: TURN_SLOTS=150 npx tsx scripts/init-config.ts

# 3. dev server (reads app/.env.local, see app/.env.example)
npm run dev
```

Open http://localhost:5173 in **two tabs**, pick **Connect → Dev wallet (localnet)** in each (every tab gets its own airdropped keypair), and press **Enter queue** in both. The tabs pair through a `BroadcastChannel`, so local matchmaking only works between tabs of the same browser.

After changing the program: `anchor build`, then `npm run codegen` in `app/` to regenerate the client.

## Deploy (devnet + GitHub Pages)

`.github/workflows/pages.yml` builds `app/` for devnet and publishes it to https://usereri.github.io/tic-tac-sol/ on every push to `main` that touches `app/`.

One-time setup:

1. **Pages source:** Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. **Repository variables:** Settings → Secrets and variables → Actions → **Variables** tab. All of these are public values baked into the site:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — needed for cross-device matchmaking.
   - `VITE_RPC_URL`, `VITE_WS_URL` — optional. They default to the public devnet endpoints; set them to a dedicated devnet RPC if the public one rate-limits.
3. **Program on devnet** (from the repo root, with a devnet-funded `~/.config/solana/id.json`):
   ```sh
   solana config set --url devnet
   anchor deploy --provider.cluster devnet
   cd app && RPC_URL=https://api.devnet.solana.com npx tsx scripts/init-config.ts
   ```

Players need Phantom (or another Wallet Standard wallet) switched to devnet; the dev wallet only exists on localnet.

### Matchmaking (Supabase Realtime)

Without Supabase env vars the app pairs tabs of one browser (`BroadcastChannel`). With them it pairs across devices over Supabase Realtime presence + broadcast, on channel `ttsol-queue-<cluster>`. No tables are needed.

1. Create a project at https://supabase.com/dashboard (free tier is enough).
2. Project Settings → API Keys: copy the **Project URL** → `VITE_SUPABASE_URL` and the **anon / publishable** key → `VITE_SUPABASE_ANON_KEY`. Never use the `service_role` / secret key; it would ship in the public bundle.
3. Realtime → Settings: keep public channel access allowed (the default).
4. Free projects pause after about a week idle; open the dashboard before a demo.

For local cross-device testing, put both variables in `app/.env.local`.

Entering the queue asks the wallet to sign a short message (no fee) naming the wallet, session key, stake and join time; other clients drop entries whose signature doesn't verify, so nobody can queue in someone else's name. A player who doesn't sign the start transaction in time is taken out of the queue until they press "I'm back". Players are only matched with others who picked the same stake. Matchmaking messages are signed with each player's one-off session key, and O signs the start transaction only if it is byte-for-byte the one O expects (`checkOffer` in `Play.tsx`): its own wallet and session, the opponent's, and the chosen stake.

### Tests

```sh
anchor test            # program (LiteSVM)
cd app && npm test     # matchmaking logic (vitest)
```
