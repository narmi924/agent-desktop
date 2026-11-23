use super::{ForegroundWindow, bring_back, foreground_window};
use crate::tree::automation::window_is_pumping;
use crate::tree::fixture::fixture_hung_after_probe::HungAfterProbeFixture;
use crate::tree::fixture::fixture_window::on_screen_stage;
use std::time::{Duration, Instant};

#[test]
fn returning_foreground_does_not_wait_for_a_stalled_previous_window() {
    let _stage = on_screen_stage();
    let fixture = HungAfterProbeFixture::create().expect("previous window");
    let previous = ForegroundWindow {
        hwnd: fixture.handle(),
        pid: std::process::id(),
    };
    let holder = foreground_window();
    assert_ne!(holder, Some(previous));
    fixture.hang_after_probe(1).expect("arm stall");
    fixture.resume_after(1800);
    assert!(window_is_pumping(previous.hwnd, 250));
    assert!(fixture.did_hang());

    let start = Instant::now();
    let restored = bring_back(previous, holder.unwrap_or(previous));
    let elapsed = start.elapsed();
    assert!(elapsed < Duration::from_secs(1), "return took {elapsed:?}");
    assert!(!restored, "the unresponsive window cannot receive typing");
}

#[test]
fn returning_foreground_is_bounded_when_the_previous_window_stalls_after_its_reply() {
    let _stage = on_screen_stage();
    let fixture = HungAfterProbeFixture::create().expect("previous window");
    let previous = ForegroundWindow {
        hwnd: fixture.handle(),
        pid: std::process::id(),
    };
    let holder = foreground_window();
    assert_ne!(holder, Some(previous));
    fixture.hang_after_probe(1).expect("arm stall");
    fixture.resume_after(1800);

    let start = Instant::now();
    let restored = bring_back(previous, holder.unwrap_or(previous));
    assert!(fixture.did_hang());
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(!restored);
}
