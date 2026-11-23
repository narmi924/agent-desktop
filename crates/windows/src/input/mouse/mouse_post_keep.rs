//! Keeps the user's foreground window in front across a posted click.
//!
//! A posted click can make its target activate itself. Measured: a WinForms
//! window shown without ever being activated came to the front, and stayed
//! there, when a posted click focused one of its buttons while a note held
//! the foreground. A post returns before the application reads it, so the
//! foreground is watched for [`WATCH`] after posting, and once a window of the
//! target's process takes it, `keep_foreground` puts the previous window back
//! as it does for headless element actions and reports `details.foreground`.

use std::time::{Duration, Instant};

use crate::actions::foreground_keep::{ForegroundDesk, taken_from};
use crate::system::window::foreground_return::{self, ForegroundWindow, Pointer};

/// How long after posting the target may take the foreground and still be
/// put back. An application that has not read its posted messages by then is
/// busy, and one that activates itself later keeps the foreground.
pub(crate) const WATCH: Duration = Duration::from_millis(200);
const WATCH_STEP: Duration = Duration::from_millis(10);

/// The posted click's target: the windows of its process, and the top-level
/// window the click went into.
pub(crate) struct PostDesk {
    pub(crate) target_pid: u32,
    pub(crate) target_root: isize,
}

impl ForegroundDesk for PostDesk {
    fn foreground(&self) -> Option<ForegroundWindow> {
        foreground_return::foreground_window()
    }

    fn pointer(&self) -> Option<Pointer> {
        foreground_return::pointer()
    }

    fn is_target(&self, window: ForegroundWindow) -> bool {
        (self.target_pid != 0 && window.pid == self.target_pid) || window.hwnd == self.target_root
    }

    fn still_owned(&self, window: ForegroundWindow) -> bool {
        foreground_return::still_owned(window)
    }

    fn bring_back(&self, window: ForegroundWindow) -> bool {
        foreground_return::bring_back(window)
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn pause(&self, length: Duration) {
        std::thread::sleep(length);
    }
}

/// Waits until the target has taken the foreground from `before`, or until
/// [`WATCH`] has passed. A target already in front has nothing to take.
pub(crate) fn wait_for_take<D: ForegroundDesk>(desk: &D, before: Option<ForegroundWindow>) {
    if before.is_some_and(|window| desk.is_target(window)) {
        return;
    }
    let until = desk.now() + WATCH;
    while taken_from(before, desk.foreground(), |window| desk.is_target(window)).is_none() {
        if desk.now() >= until {
            return;
        }
        desk.pause(WATCH_STEP);
    }
}

#[cfg(test)]
#[path = "mouse_post_keep_tests.rs"]
mod tests;
