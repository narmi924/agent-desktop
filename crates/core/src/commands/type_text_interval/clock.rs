use std::time::{Duration, Instant};

/// Spaces keystrokes an interval apart. The grid slides rather than catching
/// up: a keystroke that is slow to land, or waits for the interaction lease,
/// pushes the rest back instead of letting them go out in a rush.
pub(super) struct Clock {
    pub(super) interval: Duration,
    pub(super) due: Option<Instant>,
}

impl Clock {
    /// Waits until the next keystroke is due, and returns the slot it goes
    /// out in. The first keystroke goes at once.
    pub(super) fn wait(&mut self) -> Instant {
        let Some(due) = self.due else {
            return Instant::now();
        };
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        due
    }

    /// Schedules the next keystroke once the one sent in `slot` has landed.
    pub(super) fn delivered(&mut self, slot: Instant) {
        self.due = Some(next_due(slot, Instant::now(), self.interval));
    }
}

/// When the keystroke after the one sent in `slot` is due, given that it
/// landed at `now`: an interval after its slot, or half an interval after it
/// landed when it landed late, so two keystrokes never land a frame apart.
pub(super) fn next_due(slot: Instant, now: Instant, interval: Duration) -> Instant {
    (slot + interval).max(now + interval / 2)
}
