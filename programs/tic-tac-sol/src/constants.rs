use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config_v2";

#[constant]
pub const JACKPOT_SEED: &[u8] = b"jackpot_v2";

#[constant]
pub const GAME_SEED: &[u8] = b"game";

#[constant]
pub const ACTIVE_SEED: &[u8] = b"active";

#[constant]
pub const LEADERBOARD_SEED: &[u8] = b"leaderboard";

/// The turn clock speeds up with game time: every `TURN_STEP_EVERY_SLOTS` (~10 s) the turn gets
/// `TURN_STEP_SLOTS` shorter, starting from the config's `turn_slots`, never below `TURN_MIN_SLOTS` (~4.8 s).
pub const TURN_STEP_EVERY_SLOTS: u64 = 25;
pub const TURN_STEP_SLOTS: u64 = 2;
pub const TURN_MIN_SLOTS: u64 = 12;

/// Extra slots (~10 s) for the first move only: X learns the game started a few seconds after the
/// start transaction lands (O confirms it, then tells X), and the clock is already running by then.
pub const START_GRACE_SLOTS: u64 = 25;

/// The SlotHashes sysvar.
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

/// Wallets kept on the on-chain leaderboard.
pub const BOARD_SIZE: usize = 50;

/// Cell / player markers. `X` always moves first.
pub const EMPTY: u8 = 0;
pub const X: u8 = 1;
pub const O: u8 = 2;

/// Infinite mode: each player keeps at most this many marks on the board.
pub const MAX_MARKS: usize = 3;

pub const BPS_DENOMINATOR: u64 = 10_000;

pub const WIN_LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];
