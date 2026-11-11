//! The side of a command that is about to send real input: register as a
//! holder, start a keeper when none runs, and wait until the pointer shows.

use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, ProcessId};

use super::beacon::Beacon;
use super::holders;
use super::look::{self, Look};
use super::names;
use super::system_cursor;
use crate::system::cursor_overlay::image_identity;
use crate::system::process_identity;

/// How long the first input of a command waits for the pointer to change.
/// Input goes ahead without it rather than failing the action.
const SHOW_BUDGET: Duration = Duration::from_millis(1500);
const SHOW_POLL: Duration = Duration::from_millis(5);

/// A keeper that is ending as this command arrives releases its mutex
/// without swapping again; a new one is started once that is seen.
const RESPAWN_AFTER: Duration = Duration::from_millis(400);

static HELD: OnceLock<()> = OnceLock::new();

/// Called right before this process sends its first real key or mouse
/// event; every later call returns at once.
pub(crate) fn before_input() {
    HELD.get_or_init(|| {
        if let Err(error) = hold() {
            tracing::debug!(%error, "agent pointer: input goes ahead without the pointer swap");
        }
    });
}

fn token_of(pid: u32) -> Option<String> {
    process_identity::token_for_pid(ProcessId::new(pid))
        .ok()
        .flatten()
}

fn hold() -> Result<(), AdapterError> {
    if look::current() == Look::Off {
        return Ok(());
    }
    let executable = std::env::current_exe()
        .map_err(|_| AdapterError::internal("The running executable could not be resolved"))?;
    if !image_identity::is_agent_desktop_image(&executable) {
        return Ok(());
    }
    let root = holders::root()
        .ok_or_else(|| AdapterError::internal("The state directory could not be resolved"))?;
    register(&root)?;
    let beacon = Beacon::for_root(&root);
    let until = Instant::now() + SHOW_BUDGET;
    let mut spawned: Option<Instant> = None;
    while Instant::now() < until {
        if beacon.keeper_running() {
            if beacon.pointer_swapped() {
                return Ok(());
            }
        } else if spawned.is_none_or(|at| at.elapsed() >= RESPAWN_AFTER) {
            spawn("keeper")?;
            spawned = Some(Instant::now());
        }
        std::thread::sleep(SHOW_POLL);
    }
    Err(AdapterError::internal(
        "The agent pointer did not appear in time",
    ))
}

/// This process holds the pointer, and so does the process named by
/// `AGENT_DESKTOP_POINTER_HOLDER` when that one is running.
fn register(root: &Path) -> Result<(), AdapterError> {
    let failed = |error: std::io::Error| {
        AdapterError::internal("The agent pointer holder could not be recorded")
            .with_platform_detail(error.to_string())
    };
    let own = std::process::id();
    holders::add(root, own, &token_of(own).unwrap_or_default()).map_err(failed)?;
    if let Some(holder) = std::env::var(names::HOLDER)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        && let Some(token) = token_of(holder)
    {
        holders::add(root, holder, &token).map_err(failed)?;
    }
    Ok(())
}

/// Puts the person's own pointer back now, and stops a keeper that is
/// still running. Whether a keeper was asked to stop.
pub(crate) fn restore_now() -> Result<bool, AdapterError> {
    let Some(root) = holders::root() else {
        system_cursor::restore()?;
        return Ok(false);
    };
    let stopped = Beacon::for_root(&root).ask_keeper_to_stop();
    holders::clear(&root);
    system_cursor::restore()?;
    holders::mark_restored(&root);
    Ok(stopped)
}

/// Restores a pointer left swapped by a keeper that is no longer running,
/// for example when the keeper and its watcher were ended together. Costs
/// one file lookup when nothing was left behind.
pub(crate) fn settle_stale() {
    let Some(root) = holders::root() else {
        return;
    };
    let Some(record) = holders::swapped(&root) else {
        return;
    };
    let running = process_identity::matches_instance(ProcessId::new(record.keeper), &record.token)
        .unwrap_or(false);
    if !running && !Beacon::for_root(&root).keeper_running() {
        let _ = system_cursor::restore();
        holders::mark_restored(&root);
    }
}

/// Starts this binary as a keeper or watcher: detached, without a console,
/// inheriting no handles, and outside the caller's job so a shell or script
/// runner that kills its process tree on exit does not take it along.
pub(crate) fn spawn(role: &str) -> Result<(), AdapterError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
        DETACHED_PROCESS, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let image = std::env::current_exe()
        .map_err(|_| AdapterError::internal("The running executable could not be resolved"))?;
    let mut command_line: Vec<u16> = format!("\"{}\"", image.display())
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut environment: Vec<u16> = Vec::new();
    for (key, value) in std::env::vars() {
        if key.eq_ignore_ascii_case(names::ROLE) || key.eq_ignore_ascii_case(names::HOLDER) {
            continue;
        }
        environment.extend(format!("{key}={value}").encode_utf16());
        environment.push(0);
    }
    environment.extend(format!("{}={role}", names::ROLE).encode_utf16());
    environment.extend([0, 0]);
    let base = DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
    for flags in [base | CREATE_BREAKAWAY_FROM_JOB, base] {
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..unsafe { std::mem::zeroed() }
        };
        let mut information: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let started = unsafe {
            CreateProcessW(
                std::ptr::null(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                environment.as_mut_ptr().cast(),
                std::ptr::null(),
                &startup,
                &mut information,
            )
        };
        if started != 0 {
            unsafe {
                CloseHandle(information.hThread);
                CloseHandle(information.hProcess);
            }
            return Ok(());
        }
    }
    Err(
        AdapterError::internal("The agent pointer keeper could not be started")
            .with_platform_detail(std::io::Error::last_os_error().to_string()),
    )
}
