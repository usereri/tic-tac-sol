use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};

use crate::{constants::*, error::ErrorCode, escrow::*, state::*};

/// Signed by both players' wallets in one transaction, so either both stakes
/// go in and the game starts, or nobody pays anything.
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct StartGame<'info> {
    /// Moves first; pays the tx fee and the game account's rent (returned by `close_game`).
    #[account(mut)]
    pub player_x: Signer<'info>,
    #[account(mut)]
    pub player_o: Signer<'info>,
    /// CHECK: X's one-off wallet; only receives the gas deposit and is stored as X's move key.
    #[account(mut)]
    pub session_x: UncheckedAccount<'info>,
    /// CHECK: O's one-off wallet; only receives the gas deposit and is stored as O's move key.
    #[account(mut)]
    pub session_o: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [JACKPOT_SEED], bump = jackpot.bump)]
    pub jackpot: Account<'info, Jackpot>,
    #[account(
        init,
        payer = player_x,
        space = 8 + Game::INIT_SPACE,
        seeds = [GAME_SEED, player_x.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,
    pub system_program: Program<'info, System>,
}

impl<'info> StartGame<'info> {
    fn pay(&self, from: AccountInfo<'info>, to: AccountInfo<'info>, amount: u64) -> Result<()> {
        transfer(
            CpiContext::new(self.system_program.key(), Transfer { from, to }),
            amount,
        )
    }
}

pub fn handle_start_game(ctx: Context<StartGame>, nonce: u64) -> Result<()> {
    let a = &ctx.accounts;
    let keys = [
        a.player_x.key(),
        a.player_o.key(),
        a.session_x.key(),
        a.session_o.key(),
    ];
    for i in 0..keys.len() {
        for j in i + 1..keys.len() {
            require_keys_neq!(keys[i], keys[j], ErrorCode::DuplicateParticipant);
        }
    }

    let args = a.config.args;
    let game_info = a.game.to_account_info();
    a.pay(a.player_x.to_account_info(), game_info.clone(), args.stake)?;
    a.pay(a.player_o.to_account_info(), game_info.clone(), args.stake)?;
    a.pay(a.player_x.to_account_info(), a.session_x.to_account_info(), args.gas_deposit)?;
    a.pay(a.player_o.to_account_info(), a.session_o.to_account_info(), args.gas_deposit)?;

    // Direct lamport moves only after all CPIs.
    let jackpot = &mut ctx.accounts.jackpot;
    let mut jackpot_bonus = 0;
    if jackpot.drained_count >= args.jackpot_every {
        let jackpot_info = jackpot.to_account_info();
        jackpot_bonus = spare_lamports(&jackpot_info)?;
        move_lamports(&jackpot_info, &game_info, jackpot_bonus)?;
        jackpot.drained_count = 0;
        jackpot.total_paid_out = jackpot
            .total_paid_out
            .checked_add(jackpot_bonus)
            .ok_or(ErrorCode::MathOverflow)?;
    }

    let initial_pot = args
        .stake
        .checked_mul(2)
        .and_then(|p| p.checked_add(jackpot_bonus))
        .ok_or(ErrorCode::MathOverflow)?;

    let game = &mut ctx.accounts.game;
    game.set_inner(Game {
        player_x: keys[0],
        player_o: keys[1],
        session_x: keys[2],
        session_o: keys[3],
        status: GameStatus::Active,
        turn: X,
        winner: EMPTY,
        board: [EMPTY; 9],
        queue_x: [0; MAX_MARKS],
        queue_o: [0; MAX_MARKS],
        len_x: 0,
        len_o: 0,
        moved_x: false,
        moved_o: false,
        move_count: 0,
        initial_pot,
        jackpot_bonus,
        fees_paid: 0,
        last_action_slot: Clock::get()?.slot,
        nonce,
        bump: ctx.bumps.game,
    });

    emit!(GameStarted {
        game: game.key(),
        player_x: keys[0],
        player_o: keys[1],
        pot: initial_pot,
        jackpot_bonus,
    });
    Ok(())
}
