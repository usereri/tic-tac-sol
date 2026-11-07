use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const JACKPOT_SEED: &[u8] = b"jackpot";

#[constant]
pub const GAME_SEED: &[u8] = b"game";

#[constant]
pub const STATS_SEED: &[u8] = b"stats";

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
