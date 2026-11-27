use super::*;

#[test]
fn the_hover_is_long_enough_for_a_receiver_to_react_and_short_for_a_person() {
    assert!(HOVER >= Duration::from_millis(200));
    assert!(HOVER <= Duration::from_secs(1));
    assert!(TICK < HOVER);
}

#[test]
fn a_drag_that_cannot_start_reports_without_dragging() {
    let missing = std::env::temp_dir().join("agent-desktop-no-such-drop-file.txt");
    let error = drag_files_onto(
        vec![missing],
        std::ptr::null_mut(),
        POINT { x: 0, y: 0 },
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}
