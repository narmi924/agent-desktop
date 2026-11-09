use crate::context::CommandContext;
use crate::{AdapterError, AppError, DeliverySemantics, ErrorCode, PlatformAdapter};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

const IDLE_POLL: Duration = Duration::from_millis(100);
const IDLE_WAIT_LIMIT: Duration = Duration::from_secs(60);
const FILE_POLL: Duration = Duration::from_millis(50);

/// What a file looked like before the command ran.
pub struct FileMark {
    path: PathBuf,
    state: Option<(u64, Option<SystemTime>)>,
}

/// Runs before a mutating command: waits for the person to stop using the
/// computer when asked, and records the file the command is expected to change.
pub fn before_mutation(
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Option<FileMark>, AppError> {
    let guards = context.guards();
    if let Some(idle_ms) = guards.when_idle_ms.filter(|_| context.is_headed()) {
        wait_until_idle(adapter, idle_ms, IDLE_WAIT_LIMIT)?;
    }
    Ok(guards.expect_file.as_deref().map(|path| FileMark {
        path: path.to_owned(),
        state: file_state(path),
    }))
}

/// Adds a receipt saying whether the expected file really changed.
pub fn after_mutation(value: Value, mark: Option<FileMark>, context: &CommandContext) -> Value {
    let Some(mark) = mark else {
        return value;
    };
    let within = Duration::from_millis(context.guards().expect_within_ms);
    attach_receipt(value, &mark, within)
}

fn attach_receipt(mut value: Value, mark: &FileMark, within: Duration) -> Value {
    let until = Instant::now() + within;
    let mut state = file_state(&mark.path);
    while state == mark.state && Instant::now() < until {
        std::thread::sleep(FILE_POLL);
        state = file_state(&mark.path);
    }
    let changed = state.is_some() && state != mark.state;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "receipt".into(),
            json!({
                "verified": changed,
                "checks": [{
                    "kind": "file_changed",
                    "path": mark.path.to_string_lossy(),
                    "exists": state.is_some(),
                    "size": state.map(|(size, _)| size),
                    "changed": changed,
                }],
            }),
        );
    }
    value
}

fn file_state(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

fn wait_until_idle(
    adapter: &dyn PlatformAdapter,
    idle_ms: u64,
    limit: Duration,
) -> Result<(), AppError> {
    let until = Instant::now() + limit;
    loop {
        match adapter.user_idle_ms() {
            Err(error) if error.code == ErrorCode::PlatformNotSupported => return Ok(()),
            Err(error) => return Err(error.into()),
            Ok(idle) if idle >= idle_ms => return Ok(()),
            Ok(_) => {}
        }
        if Instant::now() >= until {
            return Err(AdapterError::new(
                ErrorCode::Timeout,
                "The computer stayed in use, so no physical input was sent",
            )
            .with_disposition(DeliverySemantics::not_delivered())
            .with_suggestion("Retry when the keyboard and mouse have been left alone")
            .into());
        }
        std::thread::sleep(IDLE_POLL);
    }
}

#[cfg(test)]
#[path = "action_guard_tests.rs"]
mod tests;
