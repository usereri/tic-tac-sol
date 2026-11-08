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

/// Closes a program-owned account, sending all its lamports to `to`. No-op if already closed.
pub fn close_account(info: &AccountInfo, to: &AccountInfo) -> Result<()> {
    if info.owner != &crate::ID {
        return Ok(());
    }
    move_lamports(info, to, info.lamports())?;
    info.assign(&anchor_lang::system_program::ID);
    info.resize(0)?;
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

/// A number nobody chose: the newest slot hash, mixed with the game key and the current slot.
/// Good enough for a devnet jackpot; a validator or a player timing the last move could bias it.
fn draw_roll(slot_hashes: &AccountInfo, game: &Pubkey) -> Result<u64> {
    let data = slot_hashes.try_borrow_data()?;
    let mut seed = [0u8; 8];
    // SlotHashes: a u64 count, then (slot: u64, hash: [u8; 32]) entries, newest first.
    let newest = data.get(16..48).unwrap_or(&[]);
    for (i, b) in newest.iter().chain(game.as_ref()).enumerate() {
        seed[i % 8] ^= b;
    }
    Ok(u64::from_le_bytes(seed) ^ Clock::get()?.slot)
}

/// Splits `amount` by `winner`: all to X, all to O, or halves (O gets the odd lamport).
fn shares(winner: u8, amount: u64) -> (u64, u64) {
    match winner {
        X => (amount, 0),
        O => (0, amount),
        _ => (amount / 2, amount - amount / 2),
    }
}

/// Pays out the whole pot according to `status` and ends the game. `rake_bps` of the pot goes to
/// the jackpot (all of it when drained). If a jackpot draw is running, this game may win it.
/// The rent stays in the game account until `close_game`.
pub fn finish<'info>(
    game: &mut Account<'info, Game>,
    player_x: &AccountInfo<'info>,
    player_o: &AccountInfo<'info>,
    jackpot: &mut Account<'info, Jackpot>,
    [active_x, active_o]: [&AccountInfo<'info>; 2],
    leaderboard: &mut Leaderboard,
    slot_hashes: &AccountInfo<'info>,
    args: &Settings,
    status: GameStatus,
    winner: u8,
) -> Result<()> {
    require!(game.status == GameStatus::Active, ErrorCode::GameNotActive);

    let game_info = game.to_account_info();
    let jackpot_info = jackpot.to_account_info();
    let pot = spare_lamports(&game_info)?;
    let rake = (pot as u128 * args.rake_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    let prize = pot - rake;
    let (mut to_x, mut to_o) = match status {
        GameStatus::Won | GameStatus::WonByTimeout | GameStatus::Split => shares(winner, prize),
        GameStatus::Drained => (0, 0),
        GameStatus::Active => return err!(ErrorCode::GameStillActive),
    };
    let to_jackpot = pot - to_x - to_o;

    move_lamports(&game_info, player_x, to_x)?;
    move_lamports(&game_info, player_o, to_o)?;
    move_lamports(&game_info, &jackpot_info, to_jackpot)?;

    // Each game of a running draw wins with chance 1/(games left), so every game in the draw
    // has the same chance and the last one always wins.
    let mut jackpot_won = 0;
    if jackpot.draw_left > 0 {
        if draw_roll(slot_hashes, &game.key())? % jackpot.draw_left as u64 == 0 {
            jackpot_won = spare_lamports(&jackpot_info)?;
            let (jx, jo) = shares(winner, jackpot_won);
            move_lamports(&jackpot_info, player_x, jx)?;
            move_lamports(&jackpot_info, player_o, jo)?;
            to_x += jx;
            to_o += jo;
            jackpot.draw_left = 0;
            jackpot.total_paid_out = jackpot.total_paid_out.saturating_add(jackpot_won);
            jackpot.last_game = game.key();
            jackpot.last_win = jackpot_won;
        } else {
            jackpot.draw_left -= 1;
        }
    } else if spare_lamports(&jackpot_info)? >= args.draw_threshold {
        jackpot.draw_left = args.draw_games;
    }

    let stake = game.stake;
    leaderboard.record(game.player_x, stake, winner == X, to_x);
    leaderboard.record(game.player_o, stake, winner == O, to_o);
    // Free both wallets for their next game and give the lock rent back.
    close_account(active_x, player_x)?;
    close_account(active_o, player_o)?;
    game.status = status;
    game.winner = winner;
    game.raked = to_jackpot;
    game.jackpot_won = jackpot_won;

    emit!(GameEnded {
        game: game.key(),
        status,
        winner,
        to_x,
        to_o,
        to_jackpot,
        jackpot_won,
        fees_paid: game.fees_paid,
        move_count: game.move_count,
    });
    Ok(())
}
