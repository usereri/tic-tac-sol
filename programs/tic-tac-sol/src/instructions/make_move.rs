use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, escrow::*, state::*};

/// Accounts shared by every instruction that can end a game.
#[derive(Accounts)]
pub struct PlayGame<'info> {
    /// The one-off session wallet (for moves and claims) or any wallet (for `settle_abandoned`).
    /// Pays the tx fee and gets it refunded from the escrow.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, Game>,
    #[account(mut, address = game.player_x)]
    pub player_x: SystemAccount<'info>,
    #[account(mut, address = game.player_o)]
    pub player_o: SystemAccount<'info>,
    #[account(mut, seeds = [JACKPOT_SEED], bump = jackpot.bump)]
    pub jackpot: Account<'info, Jackpot>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: X's one-game lock; closed (rent to X) when the game ends.
    #[account(mut, seeds = [ACTIVE_SEED, game.player_x.as_ref()], bump)]
    pub active_x: UncheckedAccount<'info>,
    /// CHECK: O's one-game lock; closed (rent to O) when the game ends.
    #[account(mut, seeds = [ACTIVE_SEED, game.player_o.as_ref()], bump)]
    pub active_o: UncheckedAccount<'info>,
    #[account(mut, seeds = [LEADERBOARD_SEED], bump = leaderboard.bump)]
    pub leaderboard: Box<Account<'info, Leaderboard>>,
}

impl<'info> PlayGame<'info> {
    pub fn deadline(&self) -> Result<u64> {
        let grace = if self.game.move_count == 0 { START_GRACE_SLOTS } else { 0 };
        self.game
            .last_action_slot
            .checked_add(turn_slots_at(
                self.config.args.turn_slots,
                self.game.last_action_slot.saturating_sub(self.game.started_slot),
            ))
            .and_then(|d| d.checked_add(grace))
            .ok_or(error!(ErrorCode::MathOverflow))
    }

    pub fn refund_signer(&mut self) -> Result<()> {
        refund_fee(
            &mut self.game,
            &self.signer.to_account_info(),
            self.config.args.fee_refund,
        )
    }

    pub fn finish(&mut self, status: GameStatus, winner: u8) -> Result<()> {
        finish(
            &mut self.game,
            &self.player_x.to_account_info(),
            &self.player_o.to_account_info(),
            &mut self.jackpot,
            [&self.active_x.to_account_info(), &self.active_o.to_account_info()],
            &mut self.leaderboard,
            status,
            winner,
        )
    }
}

pub fn handle_make_move(ctx: Context<PlayGame>, cell: u8) -> Result<()> {
    let a = ctx.accounts;
    let slot = Clock::get()?.slot;

    require!(a.game.status == GameStatus::Active, ErrorCode::GameNotActive);
    require!(slot <= a.deadline()?, ErrorCode::TurnExpired);
    let player = a.game.turn;
    require_keys_eq!(
        a.signer.key(),
        a.game.session_of(player),
        ErrorCode::NotYourTurn
    );

    a.refund_signer()?;
    let removed = a.game.place(player, cell)?;
    emit!(MoveMade {
        game: a.game.key(),
        player,
        cell,
        removed,
        move_count: a.game.move_count,
        fees_paid: a.game.fees_paid,
    });

    if a.game.has_won(player) {
        return a.finish(GameStatus::Won, player);
    }
    if is_drained(&a.game, a.config.args.drain_floor_bps)? {
        return a.finish(GameStatus::Drained, EMPTY);
    }
    a.game.turn = opponent(player);
    a.game.last_action_slot = slot;
    Ok(())
}
