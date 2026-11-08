use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    tic_tac_sol::{
        accounts, instruction, Settings, Game, GameMode, GameStatus, Jackpot, CONFIG_SEED, EMPTY,
        ACTIVE_SEED, BoardEntry, Leaderboard, BOARD_SIZE, GAME_SEED, JACKPOT_SEED, LEADERBOARD_SEED, O, SLOT_HASHES_ID, START_GRACE_SLOTS, X,
    },
};

const SOL: u64 = 1_000_000_000;
const TX_FEE: u64 = 5_000;
const STAKE: u64 = 50_000_000;

fn active_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ACTIVE_SEED, wallet.as_ref()], &tic_tac_sol::id()).0
}

/// Size of an `ActiveGame` account: discriminator + game key.
const ACTIVE_LEN: usize = 8 + 32;

fn default_args() -> Settings {
    Settings {
        min_stake: 10_000_000,
        max_stake: 1_000_000_000,
        gas_deposit: 1_000_000,
        fee_refund: TX_FEE,
        turn_slots: 12,
        abandon_slots: 150,
        drain_floor_bps: 1_000,
        // No rake and no draw by default, so payouts are easy to check; tested on their own below.
        rake_bps: 0,
        draw_threshold: u64::MAX,
        draw_games: 10,
        relaxed_slots: 450,
    }
}

struct Player {
    wallet: Keypair,
    session: Keypair,
}

impl Player {
    fn new(svm: &mut LiteSVM) -> Self {
        let wallet = Keypair::new();
        svm.airdrop(&wallet.pubkey(), 10 * SOL).unwrap();
        Self {
            wallet,
            session: Keypair::new(),
        }
    }
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    config: Pubkey,
    jackpot: Pubkey,
    leaderboard: Pubkey,
    /// Mode of the games `start` creates.
    mode: GameMode,
}

struct Match {
    x: Player,
    o: Player,
    game: Pubkey,
}

impl Env {
    fn new(args: Settings) -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/tic_tac_sol.so"
        ));
        svm.add_program(tic_tac_sol::id(), bytes).unwrap();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10 * SOL).unwrap();
        let config = Pubkey::find_program_address(&[CONFIG_SEED], &tic_tac_sol::id()).0;
        let jackpot = Pubkey::find_program_address(&[JACKPOT_SEED], &tic_tac_sol::id()).0;
        let leaderboard = Pubkey::find_program_address(&[LEADERBOARD_SEED], &tic_tac_sol::id()).0;
        let mut env = Self {
            svm,
            admin,
            config,
            jackpot,
            leaderboard,
            mode: GameMode::Timed,
        };
        let ix = env.ix(
            instruction::InitConfig { args }.data(),
            accounts::InitConfig {
                admin: env.admin.pubkey(),
                config,
                jackpot,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let admin = env.admin.insecure_clone();
        env.send(ix, &[&admin]).unwrap();
        let ix = env.ix(
            instruction::InitLeaderboard {}.data(),
            accounts::InitLeaderboard {
                admin: admin.pubkey(),
                config,
                leaderboard,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        env.send(ix, &[&admin]).unwrap();
        env
    }

    fn ix(&self, data: Vec<u8>, metas: Vec<anchor_lang::solana_program::instruction::AccountMeta>) -> Instruction {
        Instruction::new_with_bytes(tic_tac_sol::id(), &data, metas)
    }

    /// Sends a tx paid by the first signer. On failure returns the program logs.
    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), Vec<String>> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res.map(|_| ()).map_err(|e| e.meta.logs)
    }

    fn balance(&self, key: &Pubkey) -> u64 {
        self.svm.get_balance(key).unwrap_or(0)
    }

    fn slot(&self) -> u64 {
        self.svm.get_sysvar::<Clock>().slot
    }

    fn warp(&mut self, slots: u64) {
        let slot = self.slot() + slots;
        self.svm.warp_to_slot(slot);
    }

    fn rent(&self, data_len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(data_len)
    }

    fn game(&self, game: &Pubkey) -> Game {
        let account = self.svm.get_account(game).unwrap();
        Game::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn board(&self) -> Leaderboard {
        let account = self.svm.get_account(&self.leaderboard).unwrap();
        Leaderboard::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    /// The wallet's leaderboard entry, if it's on the board.
    fn entry(&self, wallet: &Pubkey) -> Option<BoardEntry> {
        let b = self.board();
        b.entries[..b.len as usize].iter().find(|e| e.wallet == *wallet).copied()
    }

    fn lock_open(&self, wallet: &Pubkey) -> bool {
        self.svm.get_account(&active_pda(wallet)).map_or(false, |a| a.lamports > 0)
    }

    fn jackpot_rent(&self) -> u64 {
        self.rent(self.svm.get_account(&self.jackpot).unwrap().data.len())
    }

    fn jackpot(&self) -> Jackpot {
        let account = self.svm.get_account(&self.jackpot).unwrap();
        Jackpot::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn start_ix(&self, x: &Player, o: &Player, nonce: u64) -> (Instruction, Pubkey) {
        self.start_ix_with(x, o, nonce, STAKE)
    }

    fn start_ix_with(&self, x: &Player, o: &Player, nonce: u64, stake: u64) -> (Instruction, Pubkey) {
        let game = Pubkey::find_program_address(
            &[GAME_SEED, x.wallet.pubkey().as_ref(), &nonce.to_le_bytes()],
            &tic_tac_sol::id(),
        )
        .0;
        let ix = self.ix(
            instruction::StartGame { nonce, stake, mode: self.mode }.data(),
            accounts::StartGame {
                player_x: x.wallet.pubkey(),
                player_o: o.wallet.pubkey(),
                session_x: x.session.pubkey(),
                session_o: o.session.pubkey(),
                config: self.config,
                game,
                active_x: active_pda(&x.wallet.pubkey()),
                active_o: active_pda(&o.wallet.pubkey()),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        (ix, game)
    }

    fn start(&mut self) -> Match {
        let x = Player::new(&mut self.svm);
        let o = Player::new(&mut self.svm);
        let (ix, game) = self.start_ix(&x, &o, 1);
        self.send(ix, &[&x.wallet, &o.wallet]).unwrap();
        Match { x, o, game }
    }

    fn play_ix(&self, m: &Match, signer: &Pubkey, data: Vec<u8>) -> Instruction {
        self.ix(
            data,
            accounts::PlayGame {
                signer: *signer,
                game: m.game,
                player_x: m.x.wallet.pubkey(),
                player_o: m.o.wallet.pubkey(),
                jackpot: self.jackpot,
                config: self.config,
                active_x: active_pda(&m.x.wallet.pubkey()),
                active_o: active_pda(&m.o.wallet.pubkey()),
                leaderboard: self.leaderboard,
                slot_hashes: SLOT_HASHES_ID,
            }
            .to_account_metas(None),
        )
    }

    fn try_move(&mut self, m: &Match, signer: &Keypair, cell: u8) -> Result<(), Vec<String>> {
        let ix = self.play_ix(m, &signer.pubkey(), instruction::MakeMove { cell }.data());
        self.send(ix, &[signer])
    }

    /// Plays `cells` alternately, starting with whoever's turn it is.
    fn moves(&mut self, m: &Match, cells: &[u8]) {
        for &cell in cells {
            let session = match self.game(&m.game).turn {
                X => &m.x.session,
                _ => &m.o.session,
            };
            self.try_move(m, session, cell)
                .unwrap_or_else(|logs| panic!("move {cell} failed: {logs:#?}"));
        }
    }

    fn try_claim(&mut self, m: &Match, signer: &Keypair) -> Result<(), Vec<String>> {
        let ix = self.play_ix(m, &signer.pubkey(), instruction::ClaimTimeout {}.data());
        self.send(ix, &[signer])
    }

    fn try_settle(&mut self, m: &Match, signer: &Keypair) -> Result<(), Vec<String>> {
        let ix = self.play_ix(m, &signer.pubkey(), instruction::SettleAbandoned {}.data());
        self.send(ix, &[signer])
    }

    fn try_close(&mut self, m: &Match, payer: &Keypair) -> Result<(), Vec<String>> {
        let ix = self.ix(
            instruction::CloseGame {}.data(),
            accounts::CloseGame {
                game: m.game,
                player_x: m.x.wallet.pubkey(),
            }
            .to_account_metas(None),
        );
        self.send(ix, &[payer])
    }

    fn pot(&self, game: &Pubkey) -> u64 {
        let account = self.svm.get_account(game).unwrap();
        account.lamports - self.rent(account.data.len())
    }
}

fn assert_err(res: Result<(), Vec<String>>, code: &str) {
    let logs = res.expect_err(&format!("expected {code}"));
    assert!(
        logs.iter().any(|l| l.contains(&format!("Error Code: {code}"))),
        "expected {code}, got logs: {logs:#?}"
    );
}

#[test]
fn x_wins_and_takes_pot_minus_fees() {
    let mut env = Env::new(default_args());
    let x = Player::new(&mut env.svm);
    let o = Player::new(&mut env.svm);
    let (bx, bo) = (env.balance(&x.wallet.pubkey()), env.balance(&o.wallet.pubkey()));

    let (ix, game) = env.start_ix(&x, &o, 7);
    env.send(ix, &[&x.wallet, &o.wallet]).unwrap();
    let m = Match { x, o, game };

    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Active);
    assert_eq!(g.initial_pot, 100_000_000);
    assert_eq!(env.pot(&m.game), 100_000_000);
    assert_eq!(env.balance(&m.x.session.pubkey()), 1_000_000);

    // X: 0,1,2 (top row). O: 3,4.
    env.moves(&m, &[0, 3, 1, 4, 2]);

    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Won);
    assert_eq!(g.winner, X);
    assert_eq!(g.fees_paid, 5 * TX_FEE);
    assert_eq!(env.pot(&m.game), 0);
    // The escrow paid every move's fee: one-off wallets are untouched.
    assert_eq!(env.balance(&m.x.session.pubkey()), 1_000_000);
    assert_eq!(env.balance(&m.o.session.pubkey()), 1_000_000);

    env.try_close(&m, &m.o.wallet).unwrap();
    assert!(env.svm.get_account(&m.game).map_or(true, |a| a.lamports == 0));

    // The lock rent went back at game end, so it costs nothing net.
    // X: -stake -gas -start tx fee (2 signatures) +pot(0.1 - move fees). Game rent came back on close.
    assert_eq!(
        env.balance(&m.x.wallet.pubkey()),
        bx - 50_000_000 - 1_000_000 - 2 * TX_FEE + 100_000_000 - 5 * TX_FEE
    );
    // O: -stake -gas -stats rent -close tx fee.
    assert_eq!(
        env.balance(&m.o.wallet.pubkey()),
        bo - 50_000_000 - 1_000_000 - TX_FEE
    );
}

#[test]
fn oldest_mark_disappears() {
    let mut env = Env::new(default_args());
    let m = env.start();

    // X: 0,1,8  O: 3,4,7 — no lines.
    env.moves(&m, &[0, 3, 1, 4, 8, 7]);
    let g = env.game(&m.game);
    assert_eq!(g.marks(X), &[0, 1, 8]);

    // X's oldest (0) is about to vanish, so it can't be the target.
    assert_err(env.try_move(&m, &m.x.session, 0), "CellJustVacated");
    assert_err(env.try_move(&m, &m.x.session, 3), "CellOccupied");
    assert_err(env.try_move(&m, &m.x.session, 9), "InvalidCell");

    // X plays 2: 0 disappears, so 0-1-2 is not a win.
    env.moves(&m, &[2]);
    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Active);
    assert_eq!(g.board[0], EMPTY);
    assert_eq!(g.board[2], X);
    assert_eq!(g.marks(X), &[1, 8, 2]);

    // O plays 5: 3 disappears, so 3-4-5 is not a win.
    env.moves(&m, &[5]);
    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Active);
    assert_eq!(g.marks(O), &[4, 7, 5]);

    // X plays 0 again (its own vacated cell from an earlier move is fine): 1 disappears.
    env.moves(&m, &[0]);
    assert_eq!(env.game(&m.game).marks(X), &[8, 2, 0]);
}

#[test]
fn only_the_current_session_can_move() {
    let mut env = Env::new(default_args());
    let m = env.start();

    assert_err(env.try_move(&m, &m.o.session, 0), "NotYourTurn");
    // The Phantom wallet isn't the move key either.
    assert_err(env.try_move(&m, &m.x.wallet, 0), "NotYourTurn");
    env.moves(&m, &[0]);
    assert_err(env.try_move(&m, &m.x.session, 1), "NotYourTurn");
}

#[test]
fn start_game_rejects_duplicate_participants() {
    let mut env = Env::new(default_args());
    let x = Player::new(&mut env.svm);
    let o = Player {
        wallet: x.wallet.insecure_clone(),
        session: Keypair::new(),
    };
    // Same wallet on both sides: both lock accounts are the same PDA, so it fails before the handler.
    let (ix, _) = env.start_ix(&x, &o, 1);
    assert!(env.send(ix, &[&x.wallet]).is_err());

    let o = Player::new(&mut env.svm);
    let o = Player {
        wallet: o.wallet,
        session: x.session.insecure_clone(),
    };
    let (ix, _) = env.start_ix(&x, &o, 1);
    assert_err(env.send(ix, &[&x.wallet, &o.wallet]), "DuplicateParticipant");
}

#[test]
fn deadline_is_inclusive_then_move_expires() {
    let mut env = Env::new(default_args());
    let m = env.start();

    env.warp(12);
    env.moves(&m, &[0]); // exactly at the deadline: accepted
    env.warp(13);
    assert_err(env.try_move(&m, &m.o.session, 4), "TurnExpired");
}

#[test]
fn first_move_gets_the_start_grace() {
    let mut env = Env::new(default_args());
    let m = env.start();
    env.warp(12 + START_GRACE_SLOTS);
    assert_err(env.try_claim(&m, &m.o.session), "TurnNotExpired");
    env.moves(&m, &[0]); // last slot of the first turn: accepted
    env.warp(13); // O's turn has no grace
    assert_err(env.try_move(&m, &m.o.session, 4), "TurnExpired");
}

#[test]
fn timeout_after_moving_loses() {
    let mut env = Env::new(default_args());
    let lock_rent = env.rent(ACTIVE_LEN); // refunded when the game ends
    let m = env.start();
    let bx = env.balance(&m.x.wallet.pubkey());

    env.moves(&m, &[0, 4, 8]);
    // O's turn, O has moved before and goes idle.
    assert_err(env.try_claim(&m, &m.x.wallet), "TurnNotExpired");
    env.warp(13);
    assert_err(env.try_claim(&m, &m.o.session), "NotClaimant");
    env.try_claim(&m, &m.x.session).unwrap();

    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::WonByTimeout);
    assert_eq!(g.winner, X);
    assert_eq!(g.fees_paid, 4 * TX_FEE);
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + lock_rent + 100_000_000 - 4 * TX_FEE - TX_FEE);
}

#[test]
fn timeout_without_any_move_splits() {
    let mut env = Env::new(default_args());
    let lock_rent = env.rent(ACTIVE_LEN); // refunded when the game ends
    let m = env.start();
    let (bx, bo) = (env.balance(&m.x.wallet.pubkey()), env.balance(&m.o.wallet.pubkey()));

    // X never makes the first move.
    env.warp(13 + START_GRACE_SLOTS);
    env.try_claim(&m, &m.o.session).unwrap();

    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Split);
    let each = (100_000_000 - TX_FEE) / 2;
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + lock_rent + each);
    assert_eq!(env.balance(&m.o.wallet.pubkey()), bo + lock_rent + each);
}

#[test]
fn idle_on_first_turn_after_opponent_moved_splits() {
    let mut env = Env::new(default_args());
    let m = env.start();

    env.moves(&m, &[4]);
    env.warp(13);
    env.try_claim(&m, &m.x.session).unwrap();
    assert_eq!(env.game(&m.game).status, GameStatus::Split);
}

#[test]
fn both_left_anyone_settles_50_50() {
    let mut env = Env::new(default_args());
    let lock_rent = env.rent(ACTIVE_LEN); // refunded when the game ends
    let m = env.start();
    let (bx, bo) = (env.balance(&m.x.wallet.pubkey()), env.balance(&m.o.wallet.pubkey()));
    let cranker = Keypair::new();
    env.svm.airdrop(&cranker.pubkey(), SOL).unwrap();

    env.moves(&m, &[0, 4]);
    env.warp(13);
    assert_err(env.try_settle(&m, &m.x.session), "NotAbandoned");
    env.warp(150);
    assert_err(env.try_claim(&m, &m.o.session), "ClaimWindowClosed");
    env.try_settle(&m, &cranker).unwrap();

    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Split);
    // Two moves + the cranker's tx were refunded from the pot.
    let each = (100_000_000 - 3 * TX_FEE) / 2;
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + lock_rent + each);
    assert_eq!(env.balance(&m.o.wallet.pubkey()), bo + lock_rent + each);
    assert_eq!(env.balance(&cranker.pubkey()), SOL);
}

#[test]
fn ended_game_rejects_moves_and_active_game_cannot_close() {
    let mut env = Env::new(default_args());
    let m = env.start();

    assert_err(env.try_close(&m, &m.x.wallet), "GameStillActive");
    env.moves(&m, &[0, 3, 1, 4, 2]);
    assert_err(env.try_move(&m, &m.o.session, 5), "GameNotActive");
    env.warp(13);
    assert_err(env.try_claim(&m, &m.o.session), "GameNotActive");
}

/// Picks the first legal cell that doesn't win for the player to move.
fn non_winning_cell(g: &Game) -> u8 {
    (0..9)
        .find(|&cell| {
            let mut next = g.clone();
            next.place(g.turn, cell).is_ok() && !next.has_won(g.turn)
        })
        .expect("every legal move wins")
}

#[test]
fn drained_game_feeds_jackpot() {
    // Inflate the refund so fees can burn the pot within a few moves:
    // 0.1 SOL pot, 0.0095 per move -> below the 10% floor on move 10.
    let mut env = Env::new(Settings {
        fee_refund: 9_500_000,
        ..default_args()
    });
    let m = env.start();

    for _ in 0..10 {
        let g = env.game(&m.game);
        assert_eq!(g.status, GameStatus::Active, "drained too early");
        env.moves(&m, &[non_winning_cell(&g)]);
    }
    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Drained);
    assert_eq!(g.move_count, 10);
    let leftover = 100_000_000 - 10 * 9_500_000;
    assert_eq!(g.raked, leftover);
    assert_eq!(env.pot(&m.game), 0);
    assert_eq!(env.balance(&env.jackpot), env.jackpot_rent() + leftover);
}

#[test]
fn rake_goes_to_the_jackpot() {
    let mut env = Env::new(Settings {
        rake_bps: 200,
        ..default_args()
    });
    let m = env.start();
    let bx = env.balance(&m.x.wallet.pubkey());
    let lock_rent = env.rent(ACTIVE_LEN);
    env.moves(&m, &[0, 3, 1, 4, 2]); // X wins on its third move

    let pot = 2 * STAKE - 5 * TX_FEE;
    let rake = pot * 200 / 10_000;
    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Won);
    assert_eq!(g.raked, rake);
    assert_eq!(g.jackpot_won, 0);
    assert_eq!(env.balance(&env.jackpot), env.jackpot_rent() + rake);
    // X's three move fees were refunded to X's session, not X's wallet.
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + lock_rent + pot - rake);
}

#[test]
fn jackpot_draw_starts_at_the_threshold_and_pays_a_game_in_it() {
    // Every finished game rakes 1% of ~0.1 SOL = ~0.001 SOL. The first game fills the
    // jackpot past the threshold and starts a draw over the next 2 games.
    let mut env = Env::new(Settings {
        rake_bps: 100,
        draw_threshold: 900_000,
        draw_games: 2,
        ..default_args()
    });
    let first = env.start();
    env.moves(&first, &[0, 3, 1, 4, 2]);
    assert_eq!(env.jackpot().draw_left, 2);

    // One of the next two games wins; the last game of a draw always does.
    let mut winner = None;
    for _ in 0..2 {
        let in_jackpot = env.balance(&env.jackpot) - env.jackpot_rent();
        let m = env.start();
        let bx = env.balance(&m.x.wallet.pubkey());
        env.moves(&m, &[0, 3, 1, 4, 2]);
        let g = env.game(&m.game);
        if g.jackpot_won > 0 {
            // The game that wins the draw pays no rake and takes the whole jackpot.
            assert_eq!(g.raked, 0);
            assert_eq!(g.jackpot_won, in_jackpot);
            let paid = 2 * STAKE - 5 * TX_FEE + g.jackpot_won;
            assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + env.rent(ACTIVE_LEN) + paid);
            assert_eq!(env.entry(&m.x.wallet.pubkey()).unwrap().paid, paid);
            winner = Some(m.game);
            break;
        }
        assert_eq!(env.jackpot().draw_left, 1);
    }
    let game = winner.expect("the draw must pay out within its games");
    let j = env.jackpot();
    assert_eq!(j.draw_left, 0);
    assert_eq!(j.last_game, game);
    assert_eq!(j.total_paid_out, j.last_win);
    assert_eq!(env.balance(&env.jackpot), env.jackpot_rent());
}

#[test]
fn relaxed_game_has_no_turn_clock_and_splits_when_time_runs_out() {
    let mut env = Env::new(default_args());
    env.mode = GameMode::Relaxed;
    let m = env.start();
    assert_eq!(env.game(&m.game).mode, GameMode::Relaxed);

    // Long thinks are fine as long as the game's 450 slots aren't up.
    env.warp(200);
    env.moves(&m, &[0]);
    env.warp(200);
    env.moves(&m, &[4]);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    assert_err(env.try_settle(&m, &stranger), "NotAbandoned");
    env.warp(50); // slot 450 exactly: still playable
    env.moves(&m, &[8]);

    env.warp(1);
    let cell = non_winning_cell(&env.game(&m.game));
    assert_err(env.try_move(&m, &m.o.session, cell), "TurnExpired");
    // O had moved, but running out of time in relaxed mode is a split, never a loss.
    env.try_settle(&m, &stranger).unwrap();
    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Split);
    assert_eq!(g.winner, EMPTY);
}

#[test]
fn only_admin_updates_config() {
    let mut env = Env::new(default_args());
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let new_args = Settings {
        turn_slots: 15,
        ..default_args()
    };

    let update = |env: &Env, admin: &Pubkey| {
        env.ix(
            instruction::UpdateConfig { args: new_args }.data(),
            accounts::UpdateConfig {
                admin: *admin,
                config: env.config,
            }
            .to_account_metas(None),
        )
    };
    let ix = update(&env, &stranger.pubkey());
    assert_err(env.send(ix, &[&stranger]), "Unauthorized");

    let ix = update(&env, &env.admin.pubkey());
    let admin = env.admin.insecure_clone();
    env.send(ix, &[&admin]).unwrap();

    let bad = env.ix(
        instruction::UpdateConfig {
            args: Settings {
                gas_deposit: 1,
                ..default_args()
            },
        }
        .data(),
        accounts::UpdateConfig {
            admin: admin.pubkey(),
            config: env.config,
        }
        .to_account_metas(None),
    );
    assert_err(env.send(bad, &[&admin]), "InvalidConfig");
}

#[test]
fn players_choose_the_stake_within_limits() {
    let mut env = Env::new(default_args());
    let lock_rent = env.rent(ACTIVE_LEN); // refunded when the game ends
    let x = Player::new(&mut env.svm);
    let o = Player::new(&mut env.svm);

    let (ix, _) = env.start_ix_with(&x, &o, 1, 9_999_999);
    assert_err(env.send(ix, &[&x.wallet, &o.wallet]), "InvalidStake");
    let (ix, _) = env.start_ix_with(&x, &o, 2, 1_000_000_001);
    assert_err(env.send(ix, &[&x.wallet, &o.wallet]), "InvalidStake");

    let (ix, game) = env.start_ix_with(&x, &o, 3, 250_000_000);
    env.send(ix, &[&x.wallet, &o.wallet]).unwrap();
    let g = env.game(&game);
    assert_eq!(g.stake, 250_000_000);
    assert_eq!(g.initial_pot, 500_000_000);
    assert_eq!(env.pot(&game), 500_000_000);

    let m = Match { x, o, game };
    let bx = env.balance(&m.x.wallet.pubkey());
    env.moves(&m, &[0, 3, 1, 4, 2]);
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + lock_rent + 500_000_000 - 5 * TX_FEE);
}

/// Asserts a wallet's leaderboard entry as (played, won, staked, paid).
fn assert_entry(env: &Env, wallet: &Pubkey, want: (u32, u32, u64, u64)) {
    let e = env.entry(wallet).expect("wallet missing from the leaderboard");
    assert_eq!((e.played, e.won, e.staked, e.paid), want);
}

#[test]
fn leaderboard_after_a_won_game_and_locks_refunded() {
    let mut env = Env::new(default_args());
    let x = Player::new(&mut env.svm);
    let o = Player::new(&mut env.svm);
    let (xw, ow) = (x.wallet.pubkey(), o.wallet.pubkey());
    let (bx, bo) = (env.balance(&xw), env.balance(&ow));
    let (ix, game) = env.start_ix(&x, &o, 1);
    env.send(ix, &[&x.wallet, &o.wallet]).unwrap();
    let m = Match { x, o, game };

    // During the game each player's lock exists, holds the game, and its rent was paid by that player.
    let lock_rent = env.rent(ACTIVE_LEN);
    for w in [&xw, &ow] {
        let acc = env.svm.get_account(&active_pda(w)).unwrap();
        assert_eq!(acc.lamports, lock_rent);
        assert_eq!(&acc.data[8..40], m.game.as_ref());
    }
    assert_eq!(env.board().len, 0);
    assert!(env.entry(&xw).is_none());

    env.moves(&m, &[0, 3, 1, 4, 2]);

    assert_eq!(env.board().len, 2);
    assert_entry(&env, &xw, (1, 1, STAKE, 2 * STAKE - 5 * TX_FEE));
    assert_entry(&env, &ow, (1, 0, STAKE, 0));
    assert!(!env.lock_open(&xw));
    assert!(!env.lock_open(&ow));

    // Game rent is refunded at close, lock rent already was: both are only down stake/gas/fees.
    env.try_close(&m, &m.o.wallet).unwrap();
    assert_eq!(
        env.balance(&xw),
        bx - STAKE - 1_000_000 - 2 * TX_FEE + 2 * STAKE - 5 * TX_FEE
    );
    assert_eq!(env.balance(&ow), bo - STAKE - 1_000_000 - TX_FEE);
}

#[test]
fn one_game_per_wallet() {
    let mut env = Env::new(default_args());
    let m = env.start(); // nonce 1
    let o2 = Player::new(&mut env.svm);
    let xw = m.x.wallet.pubkey();

    let (ix, _) = env.start_ix(&m.x, &o2, 2);
    assert_err(env.send(ix, &[&m.x.wallet, &o2.wallet]), "PlayerBusy");
    // A busy O is rejected too.
    let x2 = Player::new(&mut env.svm);
    let (ix, _) = env.start_ix(&x2, &m.o, 1);
    assert_err(env.send(ix, &[&x2.wallet, &m.o.wallet]), "PlayerBusy");
    // Failed starts left the existing lock alone.
    assert!(env.lock_open(&xw));

    env.moves(&m, &[0, 3, 1, 4, 2]);
    assert!(!env.lock_open(&xw));
    let (ix, game_b) = env.start_ix(&m.x, &o2, 2);
    env.send(ix, &[&m.x.wallet, &o2.wallet]).unwrap();
    let acc = env.svm.get_account(&active_pda(&xw)).unwrap();
    assert_eq!(&acc.data[8..40], game_b.as_ref());
    assert!(env.lock_open(&o2.wallet.pubkey()));
}

#[test]
fn splits_credit_both_halves_and_close_locks() {
    let mut env = Env::new(default_args());

    // Timeout without any move.
    let m = env.start();
    env.warp(13 + START_GRACE_SLOTS);
    env.try_claim(&m, &m.o.session).unwrap();
    let each = (2 * STAKE - TX_FEE) / 2;
    for w in [m.x.wallet.pubkey(), m.o.wallet.pubkey()] {
        assert_entry(&env, &w, (1, 0, STAKE, each));
        assert!(!env.lock_open(&w));
    }

    // Abandoned game settled by a cranker.
    let m = env.start();
    let cranker = Keypair::new();
    env.svm.airdrop(&cranker.pubkey(), SOL).unwrap();
    env.moves(&m, &[0, 4]);
    env.warp(150 + 13);
    env.try_settle(&m, &cranker).unwrap();
    assert_eq!(env.game(&m.game).status, GameStatus::Split);
    let each = (2 * STAKE - 3 * TX_FEE) / 2;
    for w in [m.x.wallet.pubkey(), m.o.wallet.pubkey()] {
        assert_entry(&env, &w, (1, 0, STAKE, each));
        assert!(!env.lock_open(&w));
    }
    assert_eq!(env.board().len, 4);
}

#[test]
fn drained_game_records_play_but_no_payout() {
    let mut env = Env::new(Settings {
        fee_refund: 9_500_000,
        ..default_args()
    });
    let m = env.start();
    for _ in 0..10 {
        let g = env.game(&m.game);
        env.moves(&m, &[non_winning_cell(&g)]);
    }
    assert_eq!(env.game(&m.game).status, GameStatus::Drained);
    for w in [m.x.wallet.pubkey(), m.o.wallet.pubkey()] {
        assert_entry(&env, &w, (1, 0, STAKE, 0));
        assert!(!env.lock_open(&w));
    }
}

#[test]
fn leaderboard_accumulates_across_games() {
    let mut env = Env::new(default_args());
    let x = Player::new(&mut env.svm);
    let o = Player::new(&mut env.svm);
    let (xw, ow) = (x.wallet.pubkey(), o.wallet.pubkey());

    let (ix, game) = env.start_ix_with(&x, &o, 1, STAKE);
    env.send(ix, &[&x.wallet, &o.wallet]).unwrap();
    let m1 = Match { x, o, game };
    env.moves(&m1, &[0, 3, 1, 4, 2]); // X wins
    let paid1 = 2 * STAKE - 5 * TX_FEE;

    let (ix, game) = env.start_ix_with(&m1.x, &m1.o, 2, 200_000_000);
    env.send(ix, &[&m1.x.wallet, &m1.o.wallet]).unwrap();
    let m2 = Match { x: m1.x, o: m1.o, game };
    env.moves(&m2, &[0, 3, 1, 4]); // no line yet; X to move
    env.warp(13);
    // X idle after having moved: O claims the timeout win.
    env.try_claim(&m2, &m2.o.session).unwrap();
    let g = env.game(&m2.game);
    assert_eq!(g.status, GameStatus::WonByTimeout);
    assert_eq!(g.winner, O);
    let paid2 = 400_000_000 - g.fees_paid;

    // One entry per wallet, summed over both games.
    assert_eq!(env.board().len, 2);
    assert_entry(&env, &xw, (2, 1, STAKE + 200_000_000, paid1));
    assert_entry(&env, &ow, (2, 1, STAKE + 200_000_000, paid2));
}

#[test]
fn full_leaderboard_evicts_only_for_a_better_newcomer() {
    let mut env = Env::new(default_args());
    // 25 games, X wins each: 25 winners (net > 0) and 25 losers (net = -STAKE) fill the board.
    let mut losers = Vec::new();
    for _ in 0..BOARD_SIZE / 2 {
        let m = env.start();
        env.moves(&m, &[0, 3, 1, 4, 2]);
        losers.push(m.o.wallet.pubkey());
    }
    let b = env.board();
    assert_eq!(b.len as usize, BOARD_SIZE);
    let wallets = |b: &Leaderboard| -> Vec<Pubkey> { b.entries.iter().map(|e| e.wallet).collect() };
    let before = wallets(&b);

    // Big-stake game, X wins: the winner (net > 0) evicts one of the -STAKE losers,
    // while its loser (net = -4*STAKE) is worse than everyone and stays off.
    let x = Player::new(&mut env.svm);
    let o = Player::new(&mut env.svm);
    let (ix, game) = env.start_ix_with(&x, &o, 1, 200_000_000);
    env.send(ix, &[&x.wallet, &o.wallet]).unwrap();
    let m = Match { x, o, game };
    env.moves(&m, &[0, 3, 1, 4, 2]);

    let b = env.board();
    assert_eq!(b.len as usize, BOARD_SIZE);
    assert!(env.entry(&m.o.wallet.pubkey()).is_none(), "worse newcomer must not enter");
    assert_entry(&env, &m.x.wallet.pubkey(), (1, 1, 200_000_000, 400_000_000 - 5 * TX_FEE));
    let after = wallets(&b);
    let evicted: Vec<_> = before.iter().filter(|w| !after.contains(w)).collect();
    assert_eq!(evicted.len(), 1);
    assert!(losers.contains(evicted[0]), "the lowest-net entry is the one evicted");
    // Locks are closed even when a wallet didn't make the board.
    assert!(!env.lock_open(&m.o.wallet.pubkey()));

    // A split (net ~ -fee/2, better than -STAKE) also beats the remaining losers, for both players.
    let m = env.start();
    env.warp(13 + START_GRACE_SLOTS);
    env.try_claim(&m, &m.o.session).unwrap();
    assert_eq!(env.board().len as usize, BOARD_SIZE);
    assert!(env.entry(&m.x.wallet.pubkey()).is_some());
    assert!(env.entry(&m.o.wallet.pubkey()).is_some());
}

#[test]
fn turn_slots_speed_up_to_a_floor() {
    use tic_tac_sol::turn_slots_at;
    for elapsed in [0, 1, 24] {
        assert_eq!(turn_slots_at(30, elapsed), 30);
    }
    for elapsed in [25, 40, 49] {
        assert_eq!(turn_slots_at(30, elapsed), 28);
    }
    assert_eq!(turn_slots_at(30, 50), 26);
    assert_eq!(turn_slots_at(30, 224), 14);
    assert_eq!(turn_slots_at(30, 225), 12);
    assert_eq!(turn_slots_at(30, 10_000_000), 12);
    assert_eq!(turn_slots_at(30, u64::MAX), 12);
    // A small start is never raised: the floor is min(12, start).
    for elapsed in [0, 75, 1_000, u64::MAX] {
        assert_eq!(turn_slots_at(5, elapsed), 5);
    }
    assert_eq!(turn_slots_at(12, 1_000), 12);
    assert_eq!(turn_slots_at(14, 1_000), 12);
}

/// Plays moves, each as late as allowed (but never past `target`), until the last action is
/// exactly `target` slots after the game started.
fn play_until_elapsed(env: &mut Env, m: &Match, target: u64) {
    loop {
        let g = env.game(&m.game);
        let elapsed = g.last_action_slot - g.started_slot;
        if elapsed >= target {
            assert_eq!(elapsed, target);
            return;
        }
        let window = (30 - 2 * (elapsed / 25).min(15)).max(12);
        env.warp(window.min(target - elapsed));
        let cell = non_winning_cell(&g);
        env.moves(m, &[cell]);
    }
}

fn mover_and_waiting<'a>(env: &Env, m: &'a Match) -> (&'a Player, &'a Player) {
    match env.game(&m.game).turn {
        X => (&m.x, &m.o),
        _ => (&m.o, &m.x),
    }
}

#[test]
fn turn_window_follows_the_accelerating_clock() {
    let args = Settings {
        turn_slots: 30,
        ..default_args()
    };

    // First move: the full 30 slots plus the start grace, inclusive.
    let mut env = Env::new(args.clone());
    let m = env.start();
    env.warp(30 + START_GRACE_SLOTS);
    env.moves(&m, &[0]);

    let mut env = Env::new(args.clone());
    let m = env.start();
    env.warp(30 + START_GRACE_SLOTS + 1);
    assert_err(env.try_move(&m, &m.x.session, 0), "TurnExpired");

    // 200 slots in the window is 14: +14 is accepted, +15 is not.
    let mut env = Env::new(args.clone());
    let m = env.start();
    play_until_elapsed(&mut env, &m, 200);
    env.warp(15);
    let (mover, _) = mover_and_waiting(&env, &m);
    let cell = non_winning_cell(&env.game(&m.game));
    assert_err(env.try_move(&m, &mover.session, cell), "TurnExpired");

    let mut env = Env::new(args);
    let m = env.start();
    play_until_elapsed(&mut env, &m, 200);
    let (mover, waiting) = mover_and_waiting(&env, &m);
    env.warp(14);
    assert_err(env.try_claim(&m, &waiting.session), "TurnNotExpired");
    let cell = non_winning_cell(&env.game(&m.game));
    env.try_move(&m, &mover.session, cell).unwrap(); // exactly at +14: accepted

    // Past 225 slots the floor of 12 applies.
    play_until_elapsed(&mut env, &m, 300);
    assert_eq!(env.game(&m.game).status, GameStatus::Active);
    let (mover, waiting) = mover_and_waiting(&env, &m);
    env.warp(12);
    assert_err(env.try_claim(&m, &waiting.session), "TurnNotExpired");
    let cell = non_winning_cell(&env.game(&m.game));
    env.try_move(&m, &mover.session, cell).unwrap(); // exactly at +12: accepted

    let (mover, waiting) = mover_and_waiting(&env, &m);
    env.warp(13);
    let cell = non_winning_cell(&env.game(&m.game));
    assert_err(env.try_move(&m, &mover.session, cell), "TurnExpired");
    env.try_claim(&m, &waiting.session).unwrap();
    assert_eq!(env.game(&m.game).status, GameStatus::WonByTimeout);
}
