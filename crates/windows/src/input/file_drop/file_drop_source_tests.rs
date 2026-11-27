use super::*;

#[test]
fn the_drag_goes_on_while_hovering() {
    assert_eq!(continue_answer(DropPhase::Hover, false, true), 0);
    assert_eq!(continue_answer(DropPhase::Hover, false, false), 0);
}

#[test]
fn a_release_drops_only_once_the_loop_was_aimed_at_the_receiver() {
    assert_eq!(
        continue_answer(DropPhase::Release, false, true),
        DRAGDROP_S_DROP
    );
    assert_eq!(
        continue_answer(DropPhase::Release, false, false),
        DRAGDROP_S_CANCEL
    );
}

#[test]
fn escape_and_cancel_end_the_drag_without_a_drop() {
    assert_eq!(
        continue_answer(DropPhase::Hover, true, true),
        DRAGDROP_S_CANCEL
    );
    assert_eq!(
        continue_answer(DropPhase::Release, true, true),
        DRAGDROP_S_CANCEL
    );
    assert_eq!(
        continue_answer(DropPhase::Cancel, false, true),
        DRAGDROP_S_CANCEL
    );
}

#[test]
fn the_shared_state_reports_its_phase() {
    let state = DropState::default();
    assert_eq!(state.phase(), DropPhase::Hover);
    state.set_phase(DropPhase::Release);
    assert_eq!(state.phase(), DropPhase::Release);
    state.set_phase(DropPhase::Cancel);
    assert_eq!(state.phase(), DropPhase::Cancel);
    assert_eq!(state.capture(), 0);
    assert_eq!(state.asked(), 0);
}
