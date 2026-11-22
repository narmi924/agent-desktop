//! Keeps the user's foreground window in front across a headless action.
//!
//! Some applications activate their own window when a control changes, for
//! example a `TextChanged` or `Click` handler that calls `Activate`. A
//! headless action must leave the user's foreground where it was, so when a
//! window of the target's process holds the foreground once the action
//! returns, the window that was in front before is put back and the result
//! says so in `details.foreground`. After a return the foreground is read once
//! more [`RECHECK`] later, in case the application activates itself again.
//! When nothing moved, nothing waits.
//!
//! The user may have switched to the target themselves. Without watching
//! input, the pointer tells: a user who clicked the target has the pointer on
//! it. So when the pointer is over a target window and either moved during the
//! action or was over a target window already, the foreground is left where it
//! is and reported as taken. A pointer resting where the target's window only
//! now covers it is the application's doing, so it does not stop the return.

use std::time::{Duration, Instant};

use agent_desktop_core::{ActionResult, AdapterError, DeliverySemantics};
use serde_json::{Value, json};

use crate::system::window::foreground_return::{ForegroundWindow, Pointer};

pub(crate) const RECHECK: Duration = Duration::from_millis(30);
pub(crate) const RETRY_PAUSE: Duration = Duration::from_millis(10);
pub(crate) const RETURN_BUDGET: u32 = 3;

/// What the action can see of the desktop and do to it.
pub(crate) trait ForegroundDesk {
    fn foreground(&self) -> Option<ForegroundWindow>;
    fn pointer(&self) -> Option<Pointer>;
    fn is_target(&self, window: ForegroundWindow) -> bool;
    fn still_owned(&self, window: ForegroundWindow) -> bool;
    fn bring_back(&self, window: ForegroundWindow) -> bool;
    fn now(&self) -> Instant;
    fn pause(&self, length: Duration);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LeaveReason {
    CursorOnTarget,
    NoPreviousWindow,
    PreviousWindowGone,
    ReturnRefused,
}

impl LeaveReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::CursorOnTarget => "cursor_on_target",
            Self::NoPreviousWindow => "no_previous_window",
            Self::PreviousWindowGone => "previous_window_gone",
            Self::ReturnRefused => "return_refused",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    Return(ForegroundWindow),
    Leave(LeaveReason),
}

/// The window the target took the foreground with, when it did: the
/// foreground moved, the new holder is the target's, and the previous holder
/// was not the target's own window.
pub(crate) fn taken_from(
    before: Option<ForegroundWindow>,
    now: Option<ForegroundWindow>,
    is_target: impl Fn(ForegroundWindow) -> bool,
) -> Option<ForegroundWindow> {
    let now = now?;
    if before == Some(now) || !is_target(now) || before.is_some_and(&is_target) {
        return None;
    }
    Some(now)
}

/// Whether the pointer says the user may have switched to the target: it is
/// over a target window now, and it moved since the action began or was over
/// a target window already then. An unreadable pointer says nothing.
pub(crate) fn pointer_on_target(
    before: Option<Pointer>,
    now: Option<Pointer>,
    is_target: impl Fn(ForegroundWindow) -> bool,
) -> bool {
    let Some(now) = now else {
        return false;
    };
    if !now.over.is_some_and(&is_target) {
        return false;
    }
    match before {
        None => true,
        Some(before) => {
            (before.x, before.y) != (now.x, now.y) || before.over.is_some_and(&is_target)
        }
    }
}

/// Whether to put `previous` back once the target has taken the foreground.
pub(crate) fn judge(
    previous: Option<ForegroundWindow>,
    previous_alive: bool,
    pointer_on_target: bool,
) -> Verdict {
    if pointer_on_target {
        return Verdict::Leave(LeaveReason::CursorOnTarget);
    }
    match previous {
        None => Verdict::Leave(LeaveReason::NoPreviousWindow),
        Some(_) if !previous_alive => Verdict::Leave(LeaveReason::PreviousWindowGone),
        Some(window) => Verdict::Return(window),
    }
}

/// The desktop as it was just before the action.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Start {
    pub(crate) at: Instant,
    pub(crate) before: Option<ForegroundWindow>,
    pub(crate) pointer: Option<Pointer>,
}

/// What happened to the foreground during one action.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct ForegroundTally {
    pub(crate) taken_by: Option<ForegroundWindow>,
    pub(crate) returned_to: Option<ForegroundWindow>,
    pub(crate) away: Duration,
    pub(crate) attempts: u32,
    pub(crate) left: Option<LeaveReason>,
    recheck_due: bool,
}

/// Runs the action and keeps the foreground where it was before it.
pub(crate) fn keep_foreground<D: ForegroundDesk>(
    desk: &D,
    run: impl FnOnce() -> Result<ActionResult, AdapterError>,
) -> Result<ActionResult, AdapterError> {
    let start = Start {
        at: desk.now(),
        before: desk.foreground(),
        pointer: desk.pointer(),
    };
    let outcome = run();
    if !sent_something(&outcome) {
        return outcome;
    }
    let tally = settle(desk, &start);
    attach(outcome, report(&tally))
}

fn sent_something(outcome: &Result<ActionResult, AdapterError>) -> bool {
    let disposition = match outcome {
        Ok(result) => result.disposition(),
        Err(error) => error.disposition,
    };
    disposition != DeliverySemantics::not_delivered()
}

/// Reads the foreground once and returns it when the target holds it. Only a
/// return leads to another read, [`RECHECK`] later.
pub(crate) fn settle<D: ForegroundDesk>(desk: &D, start: &Start) -> ForegroundTally {
    let mut tally = ForegroundTally::default();
    let mut fine_since = start.at;
    loop {
        let Some(taken) = taken_from(start.before, desk.foreground(), |w| desk.is_target(w)) else {
            if !tally.recheck_due {
                break;
            }
            tally.recheck_due = false;
            fine_since = desk.now();
            desk.pause(RECHECK);
            continue;
        };
        tally.taken_by.get_or_insert(taken);
        let previous_alive = start.before.is_some_and(|window| desk.still_owned(window));
        let on_target = pointer_on_target(start.pointer, desk.pointer(), |w| desk.is_target(w));
        match judge(start.before, previous_alive, on_target) {
            Verdict::Leave(reason) => {
                tally.left = Some(reason);
                break;
            }
            Verdict::Return(_) if tally.attempts >= RETURN_BUDGET => {
                tally.left = Some(LeaveReason::ReturnRefused);
                break;
            }
            Verdict::Return(previous) => {
                tally.attempts += 1;
                if desk.bring_back(previous) {
                    tally.away += desk.now().saturating_duration_since(fine_since);
                    tally.returned_to = Some(previous);
                    tally.recheck_due = true;
                } else {
                    desk.pause(RETRY_PAUSE);
                }
            }
        }
    }
    tally
}

fn window_json(window: ForegroundWindow) -> Value {
    json!({ "window_id": window.window_id(), "pid": window.pid })
}

/// The `details.foreground` entry, or `None` when the target never took the
/// foreground.
pub(crate) fn report(tally: &ForegroundTally) -> Option<Value> {
    let taken_by = tally.taken_by?;
    Some(match (tally.left, tally.returned_to) {
        (None, Some(returned_to)) => json!({
            "outcome": "restored",
            "taken_by": window_json(taken_by),
            "returned_to": window_json(returned_to),
            "away_ms": u64::try_from(tally.away.as_millis()).unwrap_or(u64::MAX),
        }),
        (left, _) => json!({
            "outcome": "taken",
            "taken_by": window_json(taken_by),
            "reason": left.unwrap_or(LeaveReason::ReturnRefused).as_str(),
        }),
    })
}

fn with_foreground(details: Option<Value>, entry: Value) -> Value {
    match details {
        None => json!({ "foreground": entry }),
        Some(Value::Object(mut map)) => {
            map.insert("foreground".into(), entry);
            Value::Object(map)
        }
        Some(other) => json!({ "action_details": other, "foreground": entry }),
    }
}

pub(crate) fn attach(
    outcome: Result<ActionResult, AdapterError>,
    entry: Option<Value>,
) -> Result<ActionResult, AdapterError> {
    let Some(entry) = entry else {
        return outcome;
    };
    match outcome {
        Ok(mut result) => {
            result.details = Some(with_foreground(result.details.take(), entry));
            Ok(result)
        }
        Err(mut error) => {
            error.details = Some(with_foreground(error.details.take(), entry));
            Err(error)
        }
    }
}

#[cfg(test)]
#[path = "foreground_keep_tests.rs"]
mod tests;
