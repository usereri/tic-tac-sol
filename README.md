# Tic-Tac-Sol

Infinite tic-tac-toe on Solana. Each player stakes 0.05 SOL, every move is an on-chain transaction, and the escrow pays every move's fee.

## Rules

- Each player keeps at most 3 marks. Placing a 4th removes your oldest one first, and you can't place on the cell it just left.
- Three in a row wins the whole pot, minus the real tx fees paid during the game.
- Turn deadline is `turn_slots` (12 slots ≈ 5 s) after the previous action.
  - Idle player had moved before → the waiting player claims the pot (`claim_timeout`).
  - Idle player never moved → 50/50 split.
  - Nobody claims within `abandon_slots` after the deadline → anyone can settle 50/50 (`settle_abandoned`).
- Safety net: if fees ever burn the pot below 10% of its initial value, the rest goes to the jackpot. After `jackpot_every` (10) such games, the next game gets the whole jackpot added to its pot.

## Program

`programs/tic-tac-sol` (Anchor 1.x)

| Instruction | Signer | Notes |
| --- | --- | --- |
| `init_config(args)` / `update_config(args)` | admin | Creates/tunes `Config` and creates `Jackpot` |
| `start_game(nonce)` | both players' wallets | Atomic: both stakes in, both one-off wallets funded with `gas_deposit`, game PDA `["game", player_x, nonce]` created |
| `make_move(cell)` | one-off wallet of the player to move | Escrow pays the fee back to the signer |
| `claim_timeout` | one-off wallet of the waiting player | Within the claim window after a missed deadline |
| `settle_abandoned` | anyone | After the claim window, 50/50. Signer's fee is refunded |
| `close_game` | anyone | Ended games only. Rent goes back to X |

The pot is always the game account's lamports above its rent-exempt minimum. Events `GameStarted`, `MoveMade` and `GameEnded` carry everything the UI needs.

Default config for devnet: stake `50_000_000`, gas_deposit `1_000_000`, fee_refund `5_000`, turn_slots `12`, abandon_slots `150`, drain_floor_bps `1_000`, jackpot_every `10`.

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
