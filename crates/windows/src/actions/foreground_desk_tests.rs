use super::keeps_foreground;
use agent_desktop_core::{Action, NativeHandle, actions::action_request::ActionRequest};

fn element() -> NativeHandle {
    NativeHandle::new(String::from("element"))
}

#[test]
fn a_headless_element_action_keeps_the_foreground() {
    let request = ActionRequest::headless(Action::SetValue("x".into()));
    assert!(keeps_foreground(&request, &element()));
}

#[test]
fn a_headed_action_may_take_the_foreground() {
    let request = ActionRequest::headed(Action::Click);
    assert!(!keeps_foreground(&request, &element()));
}

#[test]
fn a_focus_fallback_press_may_take_the_foreground() {
    let request = ActionRequest::focus_fallback(Action::Click);
    assert!(!keeps_foreground(&request, &element()));
}

#[test]
fn every_element_action_passes_through_the_foreground_keeper() {
    let adapter = include_str!("../adapter.rs");
    assert!(adapter.contains("foreground_desk::execute_action_keeping_foreground("));
    assert!(!adapter.contains("dispatch::execute_action_impl("));
}

#[test]
fn an_action_without_an_element_runs_unchanged() {
    let request = ActionRequest::headless(Action::Click);
    assert!(!keeps_foreground(&request, &NativeHandle::null()));
}
