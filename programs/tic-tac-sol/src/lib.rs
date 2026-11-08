pub mod constants;
pub mod error;
pub mod escrow;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("9CpwbHKTVd4ADSrtL9uhPnroVBKLddKLAcbvCWW8ZgF5");

#[program]
pub mod tic_tac_sol {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, args: Settings) -> Result<()> {
        crate::instructions::init_config::handle_init_config(ctx, args)
    }

    pub fn init_leaderboard(ctx: Context<InitLeaderboard>) -> Result<()> {
        crate::instructions::init_config::handle_init_leaderboard(ctx)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: Settings) -> Result<()> {
        crate::instructions::init_config::handle_update_config(ctx, args)
    }

    pub fn start_game(ctx: Context<StartGame>, nonce: u64, stake: u64, mode: GameMode) -> Result<()> {
        crate::instructions::start_game::handle_start_game(ctx, nonce, stake, mode)
    }

    pub fn make_move(ctx: Context<PlayGame>, cell: u8) -> Result<()> {
        crate::instructions::make_move::handle_make_move(ctx, cell)
    }

    pub fn claim_timeout(ctx: Context<PlayGame>) -> Result<()> {
        crate::instructions::timeout::handle_claim_timeout(ctx)
    }

    pub fn settle_abandoned(ctx: Context<PlayGame>) -> Result<()> {
        crate::instructions::timeout::handle_settle_abandoned(ctx)
    }

    pub fn close_game(ctx: Context<CloseGame>) -> Result<()> {
        crate::instructions::close_game::handle_close_game(ctx)
    }
}
