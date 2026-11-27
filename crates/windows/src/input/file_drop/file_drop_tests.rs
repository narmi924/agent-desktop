use super::*;
use std::path::PathBuf;

fn outcome(result: i32, effect: u32, aimed: u32) -> DropOutcome {
    DropOutcome {
        result,
        effect,
        asked: 5,
        aimed,
    }
}

#[test]
fn an_accepted_drop_reports_the_effect_and_stays_unverified() {
    let result = dropped(outcome(DRAGDROP_S_DROP, 1, 3), "Qt622QWindowIcon").unwrap();
    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    let details = serde_json::to_value(&result).unwrap();
    assert_eq!(details["details"]["effect"], "copy");
    assert_eq!(details["details"]["delivery"], "ole_drop");
    assert_eq!(details["details"]["receiver_class"], "Qt622QWindowIcon");
}

#[test]
fn a_refusal_before_any_drop_is_not_delivered() {
    let error = dropped(outcome(DRAGDROP_S_CANCEL, 0, 3), "Edit").unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_drop_the_receiver_answered_with_no_effect_is_uncertain() {
    let error = dropped(outcome(DRAGDROP_S_DROP, 0, 3), "Edit").unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
}

#[test]
fn a_loop_that_never_asked_for_the_receiver_is_refused() {
    let error = dropped(outcome(DRAGDROP_S_CANCEL, 0, 0), "Edit").unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn effects_have_names() {
    assert_eq!(effect_name(0), "none");
    assert_eq!(effect_name(1), "copy");
    assert_eq!(effect_name(2), "move");
    assert_eq!(effect_name(4), "link");
    assert_eq!(effect_name(5), "mixed");
}

#[test]
fn files_from_two_folders_are_refused_before_dragging() {
    let base = std::env::temp_dir();
    let files = vec![base.join("a.txt"), base.join("sub").join("b.txt")];
    let error = file_drop_data::shared_folder(&files).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let same: Vec<PathBuf> = vec![base.join("a.txt"), base.join("b.txt")];
    assert_eq!(
        file_drop_data::shared_folder(&same).unwrap(),
        base.as_path()
    );
}

#[test]
fn a_point_outside_the_window_is_refused() {
    let desktop = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetDesktopWindow() };
    let error = check_window(
        desktop,
        POINT {
            x: -100_000,
            y: -100_000,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    let gone = check_window(std::ptr::null_mut(), POINT { x: 0, y: 0 }).unwrap_err();
    assert_eq!(gone.code, ErrorCode::WindowNotFound);
}

#[test]
fn a_window_that_registered_for_no_drops_is_refused_before_dragging() {
    let desktop = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetDesktopWindow() };
    assert!(!takes_drops(desktop, desktop));
    assert!(!takes_drops(std::ptr::null_mut(), desktop));
    let error = no_drop_target();
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}
