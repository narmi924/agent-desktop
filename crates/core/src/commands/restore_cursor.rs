//! Puts the person's own mouse pointer back after a run that was cut short
//! left the agent pointer on screen, and stops the helper that shows it.

use crate::{AppError, adapter::PlatformAdapter};
use serde_json::{Value, json};

pub fn execute(adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let stopped = adapter.restore_agent_pointer()?;
    Ok(json!({ "restored": true, "helper_stopped": stopped }))
}

#[cfg(test)]
#[path = "restore_cursor_tests.rs"]
mod tests;
