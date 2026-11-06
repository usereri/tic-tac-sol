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
