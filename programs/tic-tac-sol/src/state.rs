use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Settings {
    /// Smallest stake (lamports, per player) a game may use.
    pub min_stake: u64,
    /// Largest stake (lamports, per player) a game may use.
    pub max_stake: u64,
    /// Lamports each player sends to their one-off session wallet (must keep it rent-exempt).
    pub gas_deposit: u64,
    /// Lamports the escrow pays back to whoever signs a move / claim (the real tx fee).
    pub fee_refund: u64,
    /// Slots a player has to make their move.
    pub turn_slots: u64,
    /// Slots after a missed deadline during which the waiting player may claim; after that anyone can settle 50/50.
    pub abandon_slots: u64,
    /// The game ends as drained once the pot falls below this share of the initial pot.
    pub drain_floor_bps: u16,
    /// The jackpot is added to the next game after this many drained games.
    pub jackpot_every: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub args: Settings,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Jackpot {
    /// Drained games that contributed since the last payout.
    pub drained_count: u8,
    pub total_paid_out: u64,
    pub bump: u8,
}

/// One-game-per-wallet lock, PDA `["active", wallet]`. Created by start_game (the player pays
/// its rent) and closed when the game ends, so the rent goes straight back to the player.
#[account]
#[derive(InitSpace)]
pub struct ActiveGame {
    pub game: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct BoardEntry {
    pub wallet: Pubkey,
    pub played: u32,
    pub won: u32,
    pub staked: u64,
    /// Total paid out to this wallet (wins and splits).
    pub paid: u64,
}

impl BoardEntry {
    pub fn net(&self) -> i128 {
        self.paid as i128 - self.staked as i128
    }
}

/// Top wallets by net SOL. One shared account paid for by the admin, so players pay no rent for stats.
#[account]
#[derive(InitSpace)]
pub struct Leaderboard {
    pub len: u8,
    pub bump: u8,
    pub entries: [BoardEntry; BOARD_SIZE],
}

impl Leaderboard {
    /// Adds one finished game for `wallet`. When the board is full, a newcomer replaces
    /// the lowest-net entry only if it's doing better.
    pub fn record(&mut self, wallet: Pubkey, stake: u64, won: bool, paid: u64) {
        let len = self.len as usize;
        let found = self.entries[..len].iter().position(|e| e.wallet == wallet);
        let mut entry = found.map_or(BoardEntry { wallet, ..Default::default() }, |i| self.entries[i]);
        entry.played = entry.played.saturating_add(1);
        entry.won = entry.won.saturating_add(won as u32);
        entry.staked = entry.staked.saturating_add(stake);
        entry.paid = entry.paid.saturating_add(paid);

        match found {
            Some(i) => self.entries[i] = entry,
            None if len < BOARD_SIZE => {
                self.entries[len] = entry;
                self.len += 1;
            }
            None => {
                let (worst, lowest) = self
                    .entries
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, e)| e.net())
                    .map(|(i, e)| (i, e.net()))
                    .unwrap();
                if entry.net() > lowest {
                    self.entries[worst] = entry;
                }
            }
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum GameStatus {
    Active,
    /// Three in a row.
    Won,
    /// The idle player had moved before and missed a deadline; the waiting player claimed.
    WonByTimeout,
    /// Fees burned the pot below the drain floor; the rest went to the jackpot.
    Drained,
    /// Pot split 50/50 (idle player never moved, or both players left).
    Split,
}

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub player_x: Pubkey,
    pub player_o: Pubkey,
    pub session_x: Pubkey,
    pub session_o: Pubkey,
    pub status: GameStatus,
    /// `X` or `O`.
    pub turn: u8,
    /// `X`, `O`, or `EMPTY` when there is no winner.
    pub winner: u8,
    pub board: [u8; 9],
    /// Cells of each player's marks, oldest first.
    pub queue_x: [u8; MAX_MARKS],
    pub queue_o: [u8; MAX_MARKS],
    pub len_x: u8,
    pub len_o: u8,
    pub moved_x: bool,
    pub moved_o: bool,
    pub move_count: u32,
    pub initial_pot: u64,
    /// Lamports each player staked, chosen by the players within the config limits.
    pub stake: u64,
    pub jackpot_bonus: u64,
    pub fees_paid: u64,
    pub last_action_slot: u64,
    pub nonce: u64,
    pub bump: u8,
}

pub fn opponent(player: u8) -> u8 {
    if player == X {
        O
    } else {
        X
    }
}

impl Game {
    pub fn session_of(&self, player: u8) -> Pubkey {
        if player == X {
            self.session_x
        } else {
            self.session_o
        }
    }

    pub fn has_moved(&self, player: u8) -> bool {
        if player == X {
            self.moved_x
        } else {
            self.moved_o
        }
    }

    pub fn marks(&self, player: u8) -> &[u8] {
        if player == X {
            &self.queue_x[..self.len_x as usize]
        } else {
            &self.queue_o[..self.len_o as usize]
        }
    }

    /// Places `player`'s mark on `cell`. If the player already has `MAX_MARKS` marks,
    /// their oldest one is removed first and that cell can't be chosen on this move.
    /// Returns the removed cell, if any.
    pub fn place(&mut self, player: u8, cell: u8) -> Result<Option<u8>> {
        require!((cell as usize) < self.board.len(), ErrorCode::InvalidCell);

        let (mut queue, mut len) = if player == X {
            (self.queue_x, self.len_x as usize)
        } else {
            (self.queue_o, self.len_o as usize)
        };

        let mut removed = None;
        if len == MAX_MARKS {
            let oldest = queue[0];
            require!(cell != oldest, ErrorCode::CellJustVacated);
            require!(self.board[cell as usize] == EMPTY, ErrorCode::CellOccupied);
            self.board[oldest as usize] = EMPTY;
            queue.copy_within(1..MAX_MARKS, 0);
            len -= 1;
            removed = Some(oldest);
        } else {
            require!(self.board[cell as usize] == EMPTY, ErrorCode::CellOccupied);
        }

        self.board[cell as usize] = player;
        queue[len] = cell;
        len += 1;

        if player == X {
            self.queue_x = queue;
            self.len_x = len as u8;
            self.moved_x = true;
        } else {
            self.queue_o = queue;
            self.len_o = len as u8;
            self.moved_o = true;
        }
        self.move_count = self.move_count.saturating_add(1);
        Ok(removed)
    }

    pub fn has_won(&self, player: u8) -> bool {
        WIN_LINES
            .iter()
            .any(|line| line.iter().all(|&c| self.board[c] == player))
    }
}

#[event]
pub struct GameStarted {
    pub game: Pubkey,
    pub player_x: Pubkey,
    pub player_o: Pubkey,
    pub pot: u64,
    pub jackpot_bonus: u64,
}

#[event]
pub struct MoveMade {
    pub game: Pubkey,
    pub player: u8,
    pub cell: u8,
    pub removed: Option<u8>,
    pub move_count: u32,
    pub fees_paid: u64,
}

#[event]
pub struct GameEnded {
    pub game: Pubkey,
    pub status: GameStatus,
    pub winner: u8,
    pub to_x: u64,
    pub to_o: u64,
    pub to_jackpot: u64,
    pub fees_paid: u64,
    pub move_count: u32,
}
