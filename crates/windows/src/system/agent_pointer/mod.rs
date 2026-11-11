//! The agent pointer: while this tool drives the real mouse and keyboard,
//! every system pointer shape becomes an arrow with a soft glow, so the
//! person at the machine can see that input is taken and should not be
//! touched. It is put back right after.
//!
//! Swapping a system pointer outlives the process that does it, so a keeper
//! process owns the swap. Commands register as holders before their first
//! real input; the keeper restores the person's own pointers once no holder
//! is running. A watcher restores them if the keeper dies, and every command
//! start checks for a swap that both left behind. `AGENT_DESKTOP_POINTER=off`
//! turns all of it off.

#[cfg(target_os = "windows")]
pub(crate) mod art;
#[cfg(target_os = "windows")]
pub(crate) mod beacon;
#[cfg(target_os = "windows")]
pub(crate) mod client;
pub(crate) mod holders;
#[cfg(target_os = "windows")]
pub(crate) mod keeper;
pub(crate) mod look;
pub(crate) mod names;
#[cfg(target_os = "windows")]
pub(crate) mod system_cursor;

use agent_desktop_core::AdapterError;

/// `Some` when this process was started as a keeper or a watcher, which then
/// never reaches the command line parser. Otherwise restores a pointer an
/// earlier keeper left swapped and returns `None`.
pub(crate) fn entry_from_env() -> Option<Result<(), AdapterError>> {
    let Ok(value) = std::env::var(names::ROLE) else {
        settle_stale();
        return None;
    };
    let role = names::parse_role(&value)?;
    Some(run(role))
}

#[cfg(target_os = "windows")]
fn run(role: names::Role) -> Result<(), AdapterError> {
    keeper::run(role)
}

#[cfg(not(target_os = "windows"))]
fn run(_role: names::Role) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("agent pointer"))
}

#[cfg(target_os = "windows")]
fn settle_stale() {
    client::settle_stale();
}

#[cfg(not(target_os = "windows"))]
fn settle_stale() {}

/// Shows the agent pointer before this process's first real input.
pub(crate) fn before_input() {
    #[cfg(target_os = "windows")]
    client::before_input();
}

/// Puts the person's own pointer back now. Whether a running keeper was
/// asked to stop.
#[cfg(target_os = "windows")]
pub(crate) fn restore_now() -> Result<bool, AdapterError> {
    client::restore_now()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn restore_now() -> Result<bool, AdapterError> {
    Err(AdapterError::not_supported("agent pointer"))
}
