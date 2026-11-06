use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, instructions::PlayGame, state::*};

/// The waiting player claims after the opponent missed the deadline. Signing proves
/// they're still there. If the idle player had moved before, the claimer wins;
/// if the idle player never moved, the pot is split.
pub fn handle_claim_timeout(ctx: Context<PlayGame>) -> Result<()> {
    let a = ctx.accounts;
    let slot = Clock::get()?.slot;

    require!(a.game.status == GameStatus::Active, ErrorCode::GameNotActive);
    let deadline = a.deadline()?;
    require!(slot > deadline, ErrorCode::TurnNotExpired);
    require!(
        slot <= deadline.saturating_add(a.config.args.abandon_slots),
        ErrorCode::ClaimWindowClosed
    );

    let idle = a.game.turn;
    let claimer = opponent(idle);
    require_keys_eq!(
        a.signer.key(),
        a.game.session_of(claimer),
        ErrorCode::NotClaimant
    );

    a.refund_signer()?;
    if a.game.has_moved(idle) {
        a.finish(GameStatus::WonByTimeout, claimer)
    } else {
        a.finish(GameStatus::Split, EMPTY)
    }
}

/// Nobody claimed within the claim window: both players left. Anyone can settle 50/50
/// and gets their tx fee back from the escrow.
pub fn handle_settle_abandoned(ctx: Context<PlayGame>) -> Result<()> {
    let a = ctx.accounts;
    let slot = Clock::get()?.slot;

    require!(a.game.status == GameStatus::Active, ErrorCode::GameNotActive);
    require!(
        slot > a.deadline()?.saturating_add(a.config.args.abandon_slots),
        ErrorCode::NotAbandoned
    );

    a.refund_signer()?;
    a.finish(GameStatus::Split, EMPTY)
}
