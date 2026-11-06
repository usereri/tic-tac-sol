use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::*};

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Jackpot::INIT_SPACE, seeds = [JACKPOT_SEED], bump)]
    pub jackpot: Account<'info, Jackpot>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ ErrorCode::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn validate(args: &Settings) -> Result<()> {
    let min_wallet = Rent::get()?.minimum_balance(0);
    require!(args.stake > 0, ErrorCode::InvalidConfig);
    require!(args.gas_deposit >= min_wallet, ErrorCode::InvalidConfig);
    require!(args.turn_slots > 0, ErrorCode::InvalidConfig);
    require!(args.abandon_slots > 0, ErrorCode::InvalidConfig);
    require!(
        (args.drain_floor_bps as u64) < BPS_DENOMINATOR,
        ErrorCode::InvalidConfig
    );
    require!(args.jackpot_every > 0, ErrorCode::InvalidConfig);
    Ok(())
}

pub fn handle_init_config(ctx: Context<InitConfig>, args: Settings) -> Result<()> {
    validate(&args)?;
    ctx.accounts.config.set_inner(Config {
        admin: ctx.accounts.admin.key(),
        args,
        bump: ctx.bumps.config,
    });
    ctx.accounts.jackpot.set_inner(Jackpot {
        drained_count: 0,
        total_paid_out: 0,
        bump: ctx.bumps.jackpot,
    });
    Ok(())
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: Settings) -> Result<()> {
    validate(&args)?;
    ctx.accounts.config.args = args;
    Ok(())
}
