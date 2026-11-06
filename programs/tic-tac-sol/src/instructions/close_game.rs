use anchor_lang::prelude::*;

use crate::{error::ErrorCode, state::*};

/// Anyone can close an ended game; its rent goes back to X, who paid it.
#[derive(Accounts)]
pub struct CloseGame<'info> {
    #[account(
        mut,
        close = player_x,
        constraint = game.status != GameStatus::Active @ ErrorCode::GameStillActive
    )]
    pub game: Account<'info, Game>,
    #[account(mut, address = game.player_x)]
    pub player_x: SystemAccount<'info>,
}

pub fn handle_close_game(_ctx: Context<CloseGame>) -> Result<()> {
    Ok(())
}
