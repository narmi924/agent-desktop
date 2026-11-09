use std::path::PathBuf;

/// Conditions wrapped around a mutating command.
#[derive(Debug, Clone, Default)]
pub struct ActionGuards {
    pub expect_file: Option<PathBuf>,
    pub expect_within_ms: u64,
    pub when_idle_ms: Option<u64>,
}
