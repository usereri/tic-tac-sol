use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

/// Moves lamports out of an account owned by this program.
pub fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let new_from = from
        .lamports()
        .checked_sub(amount)
        .ok_or(ErrorCode::InsufficientPot)?;
    let new_to = to
        .lamports()
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    **from.try_borrow_mut_lamports()? = new_from;
    **to.try_borrow_mut_lamports()? = new_to;
    Ok(())
}

/// Lamports held by a program account above its rent-exempt minimum.
pub fn spare_lamports(info: &AccountInfo) -> Result<u64> {
    let rent = Rent::get()?.minimum_balance(info.data_len());
    Ok(info.lamports().saturating_sub(rent))
}

/// The escrow pays the signer's real tx fee back, capped at what's left in the pot.
pub fn refund_fee(game: &mut Account<Game>, signer: &AccountInfo, fee_refund: u64) -> Result<()> {
    let game_info = game.to_account_info();
    let refund = fee_refund.min(spare_lamports(&game_info)?);
    move_lamports(&game_info, signer, refund)?;
    game.fees_paid = game
        .fees_paid
        .checked_add(refund)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}

/// True once fees have burned the pot below `drain_floor_bps` of the initial pot.
pub fn is_drained(game: &Account<Game>, drain_floor_bps: u16) -> Result<bool> {
    let pot = spare_lamports(&game.to_account_info())? as u128;
    let floor = game.initial_pot as u128 * drain_floor_bps as u128;
    Ok(pot * (BPS_DENOMINATOR as u128) < floor)
}

/// Pays out the whole pot according to `status` and ends the game.
/// The rent stays in the game account until `close_game`.
pub fn finish<'info>(
    game: &mut Account<'info, Game>,
    player_x: &AccountInfo<'info>,
    player_o: &AccountInfo<'info>,
    jackpot: &mut Account<'info, Jackpot>,
    status: GameStatus,
    winner: u8,
) -> Result<()> {
    require!(game.status == GameStatus::Active, ErrorCode::GameNotActive);

    let game_info = game.to_account_info();
    let pot = spare_lamports(&game_info)?;
    let (to_x, to_o, to_jackpot) = match status {
        GameStatus::Won | GameStatus::WonByTimeout if winner == X => (pot, 0, 0),
        GameStatus::Won | GameStatus::WonByTimeout => (0, pot, 0),
        GameStatus::Split => (pot / 2, pot / 2, pot % 2),
        GameStatus::Drained => (0, 0, pot),
        GameStatus::Active => return err!(ErrorCode::GameStillActive),
    };

    move_lamports(&game_info, player_x, to_x)?;
    move_lamports(&game_info, player_o, to_o)?;
    move_lamports(&game_info, &jackpot.to_account_info(), to_jackpot)?;

    if status == GameStatus::Drained {
        jackpot.drained_count = jackpot.drained_count.saturating_add(1);
    }
    game.status = status;
    game.winner = winner;

    emit!(GameEnded {
        game: game.key(),
        status,
        winner,
        to_x,
        to_o,
        to_jackpot,
        fees_paid: game.fees_paid,
        move_count: game.move_count,
    });
    Ok(())
}
