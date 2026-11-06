use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid config value")]
    InvalidConfig,
    #[msg("Only the config admin can do this")]
    Unauthorized,
    #[msg("Players and session keys must all be different accounts")]
    DuplicateParticipant,
    #[msg("Game is not active")]
    GameNotActive,
    #[msg("Game is still active")]
    GameStillActive,
    #[msg("Cell index must be 0..=8")]
    InvalidCell,
    #[msg("Cell is occupied")]
    CellOccupied,
    #[msg("Cannot place on the cell your oldest mark just left")]
    CellJustVacated,
    #[msg("Signer is not the session key of the player to move")]
    NotYourTurn,
    #[msg("Turn deadline has passed")]
    TurnExpired,
    #[msg("Turn deadline has not passed yet")]
    TurnNotExpired,
    #[msg("Signer is not the session key of the waiting player")]
    NotClaimant,
    #[msg("Claim window closed; the game can only be settled as abandoned")]
    ClaimWindowClosed,
    #[msg("Game is not abandoned yet")]
    NotAbandoned,
    #[msg("Not enough lamports in the pot")]
    InsufficientPot,
    #[msg("Math overflow")]
    MathOverflow,
}
