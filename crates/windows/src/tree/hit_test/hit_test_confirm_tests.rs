use super::imp::confirm_reach;
use agent_desktop_core::{AdapterError, adapter::hit_test::HitTestResult};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

fn cover() -> HitTestResult {
    HitTestResult::InterceptedBy {
        role: Some("group".into()),
        name: None,
        bounds: None,
    }
}

fn run(answers: Vec<HitTestResult>) -> (HitTestResult, usize, u32) {
    let queue = RefCell::new(VecDeque::from(answers));
    let probes = Cell::new(0usize);
    let pauses = Cell::new(0u32);
    let answer = confirm_reach(
        || -> Result<HitTestResult, AdapterError> {
            probes.set(probes.get() + 1);
            Ok(queue
                .borrow_mut()
                .pop_front()
                .unwrap_or(HitTestResult::Unknown))
        },
        || pauses.set(pauses.get() + 1),
    )
    .unwrap();
    (answer, probes.get(), pauses.get())
}

#[test]
fn a_reach_answered_from_a_stale_box_gives_way_to_the_refreshed_answer() {
    let (answer, probes, _) = run(vec![HitTestResult::ReachesTarget, cover()]);
    assert_eq!(answer, cover());
    assert_eq!(probes, 2);
}

#[test]
fn a_refresh_that_lands_late_still_overturns_the_reach() {
    let (answer, probes, pauses) = run(vec![
        HitTestResult::ReachesTarget,
        HitTestResult::ReachesTarget,
        cover(),
    ]);
    assert_eq!(answer, cover());
    assert_eq!(probes, 3);
    assert_eq!(pauses, 2);
}

#[test]
fn a_reach_that_holds_is_reported() {
    let (answer, probes, _) = run(vec![
        HitTestResult::ReachesTarget,
        HitTestResult::ReachesTarget,
        HitTestResult::ReachesTarget,
    ]);
    assert_eq!(answer, HitTestResult::ReachesTarget);
    assert_eq!(probes, 3);
}

#[test]
fn an_answer_that_blocks_the_click_is_not_asked_again() {
    let (answer, probes, pauses) = run(vec![cover()]);
    assert_eq!(answer, cover());
    assert_eq!(probes, 1);
    assert_eq!(pauses, 0);
}
