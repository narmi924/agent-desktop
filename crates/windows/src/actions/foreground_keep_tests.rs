use super::{
    ForegroundDesk, LeaveReason, RECHECK, RETRY_PAUSE, RETURN_BUDGET, Verdict, judge,
    keep_foreground, pointer_on_target, taken_from,
};
use crate::system::window::foreground_return::{ForegroundWindow, Pointer};
use agent_desktop_core::{Action, ActionResult, AdapterError, DeliverySemantics, ErrorCode};
use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant};

const NOTE: ForegroundWindow = ForegroundWindow { hwnd: 100, pid: 1 };
const FORM: ForegroundWindow = ForegroundWindow { hwnd: 200, pid: 2 };
const FORM_DIALOG: ForegroundWindow = ForegroundWindow { hwnd: 201, pid: 2 };
const CHAT: ForegroundWindow = ForegroundWindow { hwnd: 300, pid: 3 };

fn is_form(window: ForegroundWindow) -> bool {
    window.pid == FORM.pid
}

fn at(x: i32, y: i32, over: ForegroundWindow) -> Option<Pointer> {
    Some(Pointer {
        x,
        y,
        over: Some(over),
    })
}

struct FakeDesk {
    base: Instant,
    elapsed: Cell<Duration>,
    front: Cell<Option<ForegroundWindow>>,
    pointer: Cell<Option<Pointer>>,
    steals_on_pause: Cell<u32>,
    refuse_returns: bool,
    returns: RefCell<Vec<ForegroundWindow>>,
    pauses: RefCell<Vec<Duration>>,
}

impl FakeDesk {
    fn new() -> Self {
        Self {
            base: Instant::now(),
            elapsed: Cell::new(Duration::ZERO),
            front: Cell::new(Some(NOTE)),
            pointer: Cell::new(at(10, 10, NOTE)),
            steals_on_pause: Cell::new(0),
            refuse_returns: false,
            returns: RefCell::new(Vec::new()),
            pauses: RefCell::new(Vec::new()),
        }
    }

    fn steal(&self) {
        self.front.set(Some(FORM));
    }
}

impl ForegroundDesk for FakeDesk {
    fn foreground(&self) -> Option<ForegroundWindow> {
        self.front.get()
    }
    fn pointer(&self) -> Option<Pointer> {
        self.pointer.get()
    }
    fn is_target(&self, window: ForegroundWindow) -> bool {
        is_form(window)
    }
    fn still_owned(&self, _window: ForegroundWindow) -> bool {
        true
    }
    fn bring_back(&self, window: ForegroundWindow) -> bool {
        self.returns.borrow_mut().push(window);
        self.elapsed
            .set(self.elapsed.get() + Duration::from_millis(3));
        if !self.refuse_returns {
            self.front.set(Some(window));
        }
        !self.refuse_returns
    }
    fn now(&self) -> Instant {
        self.base + self.elapsed.get()
    }
    fn pause(&self, length: Duration) {
        self.pauses.borrow_mut().push(length);
        self.elapsed.set(self.elapsed.get() + length);
        if self.steals_on_pause.get() > 0 {
            self.steals_on_pause.set(self.steals_on_pause.get() - 1);
            self.steal();
        }
    }
}

fn delivered() -> Result<ActionResult, AdapterError> {
    Ok(ActionResult::delivered_unverified("set-value")
        .with_details(serde_json::json!({ "verification_scope": "element_value" })))
}

fn foreground_entry(result: &Result<ActionResult, AdapterError>) -> Option<serde_json::Value> {
    let details = match result {
        Ok(result) => result.details.as_ref(),
        Err(error) => error.details.as_ref(),
    };
    details
        .and_then(|details| details.get("foreground"))
        .cloned()
}

#[test]
fn an_unchanged_foreground_is_not_a_steal() {
    assert_eq!(taken_from(Some(NOTE), Some(NOTE), is_form), None);
}

#[test]
fn the_target_taking_the_foreground_is_a_steal() {
    assert_eq!(taken_from(Some(NOTE), Some(FORM), is_form), Some(FORM));
}

#[test]
fn a_move_to_another_application_is_not_the_targets_doing() {
    assert_eq!(taken_from(Some(NOTE), Some(CHAT), is_form), None);
}

#[test]
fn a_move_inside_the_target_application_is_left_alone() {
    assert_eq!(taken_from(Some(FORM), Some(FORM_DIALOG), is_form), None);
}

#[test]
fn no_foreground_window_is_not_a_steal() {
    assert_eq!(taken_from(Some(NOTE), None, is_form), None);
}

#[test]
fn a_resting_pointer_the_target_now_covers_is_not_the_user() {
    assert!(!pointer_on_target(
        at(10, 10, NOTE),
        at(10, 10, FORM),
        is_form
    ));
}

#[test]
fn a_pointer_moved_onto_the_target_may_be_the_user() {
    assert!(pointer_on_target(
        at(10, 10, NOTE),
        at(80, 40, FORM),
        is_form
    ));
}

#[test]
fn a_pointer_already_on_the_target_may_be_the_user() {
    assert!(pointer_on_target(
        at(10, 10, FORM),
        at(10, 10, FORM),
        is_form
    ));
}

#[test]
fn a_pointer_over_another_window_is_not_on_the_target() {
    assert!(!pointer_on_target(
        at(10, 10, NOTE),
        at(90, 90, CHAT),
        is_form
    ));
}

#[test]
fn an_unreadable_pointer_says_nothing() {
    assert!(!pointer_on_target(at(10, 10, NOTE), None, is_form));
}

#[test]
fn a_pointer_on_the_target_with_no_earlier_reading_may_be_the_user() {
    assert!(pointer_on_target(None, at(10, 10, FORM), is_form));
}

#[test]
fn the_previous_window_is_returned_when_the_pointer_is_elsewhere() {
    assert_eq!(judge(Some(NOTE), true, false), Verdict::Return(NOTE));
}

#[test]
fn a_pointer_on_the_target_leaves_the_foreground_alone() {
    let verdict = judge(Some(NOTE), true, true);
    assert_eq!(verdict, Verdict::Leave(LeaveReason::CursorOnTarget));
}

#[test]
fn nothing_is_returned_without_a_previous_window() {
    let verdict = judge(None, false, false);
    assert_eq!(verdict, Verdict::Leave(LeaveReason::NoPreviousWindow));
}

#[test]
fn a_closed_previous_window_is_not_raised() {
    let verdict = judge(Some(NOTE), false, false);
    assert_eq!(verdict, Verdict::Leave(LeaveReason::PreviousWindowGone));
}

#[test]
fn a_steal_during_the_action_is_returned_and_reported() {
    let desk = FakeDesk::new();
    let result = keep_foreground(&desk, || {
        desk.elapsed.set(Duration::from_millis(40));
        desk.steal();
        delivered()
    });
    assert_eq!(desk.front.get(), Some(NOTE));
    assert_eq!(desk.returns.borrow().as_slice(), &[NOTE]);
    assert_eq!(desk.pauses.borrow().as_slice(), &[RECHECK]);
    let details = result.as_ref().unwrap().details.clone().unwrap();
    assert_eq!(details["verification_scope"], "element_value");
    let entry = &details["foreground"];
    assert_eq!(entry["outcome"], "restored");
    assert_eq!(entry["taken_by"]["window_id"], "w-200");
    assert_eq!(entry["taken_by"]["pid"], 2);
    assert_eq!(entry["returned_to"]["window_id"], "w-100");
    assert_eq!(entry["away_ms"], 43);
}

#[test]
fn nothing_moved_means_nothing_waits() {
    let desk = FakeDesk::new();
    let result = keep_foreground(&desk, delivered);
    assert!(desk.pauses.borrow().is_empty());
    let details = result.unwrap().details.unwrap();
    assert_eq!(
        details,
        serde_json::json!({ "verification_scope": "element_value" })
    );
}

#[test]
fn a_second_activation_after_the_return_is_returned_too() {
    let desk = FakeDesk::new();
    desk.steals_on_pause.set(1);
    let result = keep_foreground(&desk, || {
        desk.steal();
        delivered()
    });
    assert_eq!(desk.front.get(), Some(NOTE));
    assert_eq!(desk.returns.borrow().len(), 2);
    assert_eq!(foreground_entry(&result).unwrap()["outcome"], "restored");
}

#[test]
fn a_resting_pointer_does_not_stop_the_return() {
    let desk = FakeDesk::new();
    let result = keep_foreground(&desk, || {
        desk.steal();
        desk.pointer.set(at(10, 10, FORM));
        delivered()
    });
    assert_eq!(desk.front.get(), Some(NOTE));
    assert_eq!(foreground_entry(&result).unwrap()["outcome"], "restored");
}

#[test]
fn a_pointer_moved_onto_the_target_reports_the_foreground_taken() {
    let desk = FakeDesk::new();
    let result = keep_foreground(&desk, || {
        desk.pointer.set(at(300, 200, FORM));
        desk.steal();
        delivered()
    });
    assert!(desk.returns.borrow().is_empty());
    assert_eq!(desk.front.get(), Some(FORM));
    let entry = foreground_entry(&result).unwrap();
    assert_eq!(entry["outcome"], "taken");
    assert_eq!(entry["reason"], "cursor_on_target");
}

#[test]
fn a_refused_return_stops_after_its_budget_and_reports_taken() {
    let mut desk = FakeDesk::new();
    desk.refuse_returns = true;
    let result = keep_foreground(&desk, || {
        desk.steal();
        delivered()
    });
    assert_eq!(desk.returns.borrow().len(), RETURN_BUDGET as usize);
    let retries = vec![RETRY_PAUSE; RETURN_BUDGET as usize];
    assert_eq!(*desk.pauses.borrow(), retries);
    let entry = foreground_entry(&result).unwrap();
    assert_eq!(entry["outcome"], "taken");
    assert_eq!(entry["reason"], "return_refused");
}

#[test]
fn a_switch_to_another_application_is_never_undone() {
    let desk = FakeDesk::new();
    let result = keep_foreground(&desk, || {
        desk.front.set(Some(CHAT));
        delivered()
    });
    assert_eq!(desk.front.get(), Some(CHAT));
    assert!(foreground_entry(&result).is_none());
}

#[test]
fn an_action_that_sent_nothing_is_not_judged() {
    let desk = FakeDesk::new();
    let refused = AdapterError::new(ErrorCode::PolicyDenied, "refused")
        .with_disposition(DeliverySemantics::not_delivered());
    let result = keep_foreground(&desk, || {
        desk.steal();
        Err(refused)
    });
    assert!(desk.returns.borrow().is_empty());
    assert!(foreground_entry(&result).is_none());
}

#[test]
fn a_failed_delivery_still_returns_and_reports_on_the_error() {
    let desk = FakeDesk::new();
    let failed = AdapterError::new(ErrorCode::ActionFailed, "readback failed")
        .with_disposition(DeliverySemantics::delivered_unverified());
    let result = keep_foreground(&desk, || {
        desk.steal();
        Err(failed)
    });
    assert_eq!(desk.front.get(), Some(NOTE));
    assert_eq!(foreground_entry(&result).unwrap()["outcome"], "restored");
}

#[test]
fn an_already_satisfied_action_is_not_judged() {
    let desk = FakeDesk::new();
    let result = keep_foreground(&desk, || {
        desk.steal();
        Ok(ActionResult::from_execution(&Action::Check, Vec::new()))
    });
    assert!(desk.returns.borrow().is_empty());
    assert!(foreground_entry(&result).is_none());
}
