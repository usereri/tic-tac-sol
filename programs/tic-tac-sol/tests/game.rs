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
        accounts, instruction, Settings, Game, GameStatus, Jackpot, CONFIG_SEED, EMPTY,
        GAME_SEED, JACKPOT_SEED, O, X,
    },
};

const SOL: u64 = 1_000_000_000;
const TX_FEE: u64 = 5_000;
const STAKE: u64 = 50_000_000;

fn default_args() -> Settings {
    Settings {
        min_stake: 10_000_000,
        max_stake: 1_000_000_000,
        gas_deposit: 1_000_000,
        fee_refund: TX_FEE,
        turn_slots: 12,
        abandon_slots: 150,
        drain_floor_bps: 1_000,
        jackpot_every: 10,
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
        let mut env = Self {
            svm,
            admin,
            config,
            jackpot,
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
            instruction::StartGame { nonce, stake }.data(),
            accounts::StartGame {
                player_x: x.wallet.pubkey(),
                player_o: o.wallet.pubkey(),
                session_x: x.session.pubkey(),
                session_o: o.session.pubkey(),
                config: self.config,
                jackpot: self.jackpot,
                game,
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

    // X: -stake -gas -start tx fee (2 signatures) +pot(0.1 - move fees). Rent came back on close.
    assert_eq!(
        env.balance(&m.x.wallet.pubkey()),
        bx - 50_000_000 - 1_000_000 - 2 * TX_FEE + 100_000_000 - 5 * TX_FEE
    );
    // O: -stake -gas -close tx fee.
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
    let (ix, _) = env.start_ix(&x, &o, 1);
    assert_err(env.send(ix, &[&x.wallet]), "DuplicateParticipant");

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
fn timeout_after_moving_loses() {
    let mut env = Env::new(default_args());
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
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + 100_000_000 - 4 * TX_FEE - TX_FEE);
}

#[test]
fn timeout_without_any_move_splits() {
    let mut env = Env::new(default_args());
    let m = env.start();
    let (bx, bo) = (env.balance(&m.x.wallet.pubkey()), env.balance(&m.o.wallet.pubkey()));

    // X never makes the first move.
    env.warp(13);
    env.try_claim(&m, &m.o.session).unwrap();

    let g = env.game(&m.game);
    assert_eq!(g.status, GameStatus::Split);
    let each = (100_000_000 - TX_FEE) / 2;
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + each);
    assert_eq!(env.balance(&m.o.wallet.pubkey()), bo + each);
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
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + each);
    assert_eq!(env.balance(&m.o.wallet.pubkey()), bo + each);
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
fn drained_game_feeds_jackpot_and_next_game_gets_it() {
    // Inflate the refund so fees can burn the pot within a few moves:
    // 0.1 SOL pot, 0.0095 per move -> below the 10% floor on move 10.
    let mut env = Env::new(Settings {
        fee_refund: 9_500_000,
        jackpot_every: 1,
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
    assert_eq!(env.pot(&m.game), 0);
    assert_eq!(env.jackpot().drained_count, 1);
    let jackpot_rent = env.rent(env.svm.get_account(&env.jackpot).unwrap().data.len());
    assert_eq!(env.balance(&env.jackpot), jackpot_rent + leftover);

    // jackpot_every = 1: the very next game gets the jackpot.
    let next = env.start();
    let g = env.game(&next.game);
    assert_eq!(g.jackpot_bonus, leftover);
    assert_eq!(g.initial_pot, 100_000_000 + leftover);
    assert_eq!(env.pot(&next.game), 100_000_000 + leftover);
    let j = env.jackpot();
    assert_eq!(j.drained_count, 0);
    assert_eq!(j.total_paid_out, leftover);
    assert_eq!(env.balance(&env.jackpot), jackpot_rent);
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
    assert_eq!(env.balance(&m.x.wallet.pubkey()), bx + 500_000_000 - 5 * TX_FEE);
}
