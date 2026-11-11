//! The keeper: a detached child of this binary that swaps the pointer, keeps
//! it swapped while any holder runs, and restores it once the last holder has
//! been gone for a moment. Its watcher, a second child, restores the pointer
//! if the keeper itself dies without doing so.

use std::path::Path;
use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, ProcessId};

use super::beacon::Beacon;
use super::holders::{self, Swapped};
use super::names::Role;
use super::{art, look, system_cursor};
use crate::system::process_identity;

/// How often the keeper looks at its holders.
const TICK: Duration = Duration::from_millis(50);

/// How long the pointer stays swapped after the last holder ends, so the
/// next command of a script started from a shell finds it still in place.
const GRACE: Duration = Duration::from_millis(300);

pub(crate) fn run(role: Role) -> Result<(), AdapterError> {
    let Some(root) = holders::root() else {
        return Ok(());
    };
    match role {
        Role::Keeper => keep(&root),
        Role::Watch { keeper, token } => {
            watch(&root, keeper, &token);
            Ok(())
        }
    }
}

fn holder_running(pid: u32, token: &str) -> bool {
    process_identity::matches_instance(ProcessId::new(pid), token).unwrap_or(false)
}

fn own_token() -> String {
    process_identity::token_for_pid(ProcessId::new(std::process::id()))
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn keep(root: &Path) -> Result<(), AdapterError> {
    let _ = crate::system::runtime::dpi::ensure_per_monitor_v2();
    let beacon = Beacon::for_root(root);
    let Some(_alive) = beacon.claim_keeper() else {
        return Ok(());
    };
    let (Some(swapped), Some(stop)) = (beacon.create_swapped(), beacon.create_stop()) else {
        return Ok(());
    };
    let token = own_token();
    let _ = super::client::spawn(&format!("watch:{}:{token}", std::process::id()));
    let png = look::image(&look::current()).unwrap_or_default();
    let art = art::render(&png, look::drawn_size(system_cursor::pointer_size()))
        .ok_or_else(|| AdapterError::internal("The agent pointer image could not be read"))?;
    let record = Swapped {
        keeper: std::process::id(),
        token,
    };
    let _ = holders::mark_swapped(root, &record);
    if let Err(error) = system_cursor::swap(&art) {
        let _ = system_cursor::restore();
        holders::mark_restored(root);
        return Err(error);
    }
    swapped.set();
    let mut quiet_since: Option<Instant> = None;
    loop {
        std::thread::sleep(TICK);
        if stop.is_set() {
            break;
        }
        if holders::live(root, holder_running) > 0 {
            quiet_since = None;
            continue;
        }
        if quiet_since.get_or_insert_with(Instant::now).elapsed() < GRACE {
            continue;
        }
        swapped.reset();
        if holders::live(root, holder_running) > 0 {
            swapped.set();
            quiet_since = None;
            continue;
        }
        break;
    }
    swapped.reset();
    let restored = system_cursor::restore();
    holders::mark_restored(root);
    restored
}

/// Waits for the keeper to end. A keeper that ended without clearing its
/// record left the pointer swapped, so the watcher restores it.
fn watch(root: &Path, keeper: u32, token: &str) {
    let pid = ProcessId::new(keeper);
    while !process_identity::wait_for_exit(pid, Duration::from_secs(3600)) {
        if !holder_running(keeper, token) {
            break;
        }
    }
    if holders::swapped(root).is_some_and(|record| record.keeper == keeper && record.token == token)
    {
        let _ = system_cursor::restore();
        holders::mark_restored(root);
    }
}
