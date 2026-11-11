//! Who is holding the agent pointer on screen, and the record that it is
//! swapped at all.
//!
//! Each process about to send real input writes one file named after its
//! pid, holding the start-time token that tells a reused pid apart. The
//! keeper keeps the pointer swapped while any of those processes is still
//! running, so a script that runs many commands in a row keeps one pointer
//! from first to last step, and a killed process stops holding it the moment
//! it is gone.

use std::path::{Path, PathBuf};

const HOLDERS: &str = "holders";
const SWAPPED: &str = "swapped.json";

pub(crate) fn root() -> Option<PathBuf> {
    agent_desktop_core::session::agent_desktop_dir()
        .ok()
        .map(|dir| dir.join("pointer"))
}

pub(crate) fn add(root: &Path, pid: u32, token: &str) -> std::io::Result<()> {
    let dir = root.join(HOLDERS);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(pid.to_string()), token)
}

/// Counts the holders still running and removes the rest.
pub(crate) fn live(root: &Path, running: impl Fn(u32, &str) -> bool) -> usize {
    let Ok(entries) = std::fs::read_dir(root.join(HOLDERS)) else {
        return 0;
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let pid = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.parse::<u32>().ok());
        let token = std::fs::read_to_string(&path).unwrap_or_default();
        match pid {
            Some(pid) if running(pid, token.trim()) => count += 1,
            _ => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    count
}

pub(crate) fn clear(root: &Path) {
    let _ = std::fs::remove_dir_all(root.join(HOLDERS));
}

/// The keeper that swapped the pointer, written before the swap and removed
/// after the restore. Finding it while that keeper is not running means the
/// pointer was left swapped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Swapped {
    pub(crate) keeper: u32,
    pub(crate) token: String,
}

pub(crate) fn mark_swapped(root: &Path, swapped: &Swapped) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let body = serde_json::json!({ "keeper": swapped.keeper, "token": swapped.token });
    std::fs::write(root.join(SWAPPED), body.to_string())
}

pub(crate) fn swapped(root: &Path) -> Option<Swapped> {
    let body = std::fs::read(root.join(SWAPPED)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    Some(Swapped {
        keeper: u32::try_from(value.get("keeper")?.as_u64()?).ok()?,
        token: value.get("token")?.as_str()?.to_owned(),
    })
}

pub(crate) fn mark_restored(root: &Path) {
    let _ = std::fs::remove_file(root.join(SWAPPED));
}

#[cfg(test)]
#[path = "holders_tests.rs"]
mod tests;
