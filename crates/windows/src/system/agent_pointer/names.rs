//! Names shared by the keeper, its watcher and their clients.

use std::path::Path;

/// Marks a child of this binary as the keeper (`keeper`) or as the watcher
/// of a keeper (`watch:<pid>:<start token>`).
pub(crate) const ROLE: &str = "AGENT_DESKTOP_POINTER_ROLE";

/// A process that holds the pointer on behalf of the commands it starts,
/// such as a script runner, so the pointer stays swapped between them.
pub(crate) const HOLDER: &str = "AGENT_DESKTOP_POINTER_HOLDER";

pub(crate) enum Role {
    Keeper,
    Watch { keeper: u32, token: String },
}

pub(crate) fn parse_role(value: &str) -> Option<Role> {
    if value == "keeper" {
        return Some(Role::Keeper);
    }
    let rest = value.strip_prefix("watch:")?;
    let (pid, token) = rest.split_once(':')?;
    Some(Role::Watch {
        keeper: pid.parse().ok()?,
        token: token.to_owned(),
    })
}

/// A short stable key for a state root, case-insensitive like the paths.
pub(crate) fn root_key(root: &Path) -> String {
    let text = root.to_string_lossy().to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
#[path = "names_tests.rs"]
mod tests;
