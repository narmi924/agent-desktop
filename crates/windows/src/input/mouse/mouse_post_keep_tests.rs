use super::*;
use std::cell::{Cell, RefCell};

const NOTE: ForegroundWindow = ForegroundWindow { hwnd: 10, pid: 1 };
const TARGET: ForegroundWindow = ForegroundWindow { hwnd: 20, pid: 2 };

/// A desk whose clock moves only when it pauses, and whose foreground reads
/// come from a script: the last entry repeats.
struct ScriptedDesk {
    start: Instant,
    elapsed: Cell<Duration>,
    reads: RefCell<Vec<Option<ForegroundWindow>>>,
    read_count: Cell<usize>,
}

impl ScriptedDesk {
    fn new(reads: Vec<Option<ForegroundWindow>>) -> Self {
        Self {
            start: Instant::now(),
            elapsed: Cell::new(Duration::ZERO),
            reads: RefCell::new(reads),
            read_count: Cell::new(0),
        }
    }
}

impl ForegroundDesk for ScriptedDesk {
    fn foreground(&self) -> Option<ForegroundWindow> {
        let index = self.read_count.get();
        self.read_count.set(index + 1);
        let reads = self.reads.borrow();
        reads[index.min(reads.len() - 1)]
    }

    fn pointer(&self) -> Option<Pointer> {
        None
    }

    fn is_target(&self, window: ForegroundWindow) -> bool {
        window.pid == TARGET.pid
    }

    fn still_owned(&self, _window: ForegroundWindow) -> bool {
        true
    }

    fn bring_back(&self, _window: ForegroundWindow) -> bool {
        true
    }

    fn now(&self) -> Instant {
        self.start + self.elapsed.get()
    }

    fn pause(&self, length: Duration) {
        self.elapsed.set(self.elapsed.get() + length);
    }
}

#[test]
fn the_watch_ends_as_soon_as_the_target_takes_the_foreground() {
    let desk = ScriptedDesk::new(vec![Some(NOTE), Some(NOTE), Some(TARGET)]);
    wait_for_take(&desk, Some(NOTE));
    assert_eq!(desk.read_count.get(), 3);
    assert_eq!(desk.elapsed.get(), WATCH_STEP * 2);
}

#[test]
fn a_target_that_never_takes_the_foreground_is_watched_for_the_whole_window_only() {
    let desk = ScriptedDesk::new(vec![Some(NOTE)]);
    wait_for_take(&desk, Some(NOTE));
    assert!(desk.elapsed.get() >= WATCH);
    assert!(desk.elapsed.get() < WATCH + WATCH_STEP * 2);
}

#[test]
fn a_target_already_in_front_is_not_waited_for() {
    let desk = ScriptedDesk::new(vec![Some(TARGET)]);
    wait_for_take(&desk, Some(TARGET));
    assert_eq!(
        desk.elapsed.get(),
        Duration::ZERO,
        "nothing can be taken from the target"
    );
    let other = ScriptedDesk::new(vec![
        Some(NOTE),
        Some(ForegroundWindow { hwnd: 30, pid: 3 }),
    ]);
    wait_for_take(&other, Some(NOTE));
    assert!(
        other.elapsed.get() >= WATCH,
        "another program taking the foreground is not the target's doing"
    );
}
