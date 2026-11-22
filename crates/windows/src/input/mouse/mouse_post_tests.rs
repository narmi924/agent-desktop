use super::*;
use agent_desktop_core::DeliveryDisposition;

fn words(lparam: isize) -> (i16, i16) {
    let value = lparam as u32;
    ((value & 0xFFFF) as u16 as i16, (value >> 16) as u16 as i16)
}

#[test]
fn a_point_packs_x_low_and_y_high_and_reads_back_signed() {
    assert_eq!(pack_point(0x12, 0x34), 0x0034_0012);
    assert_eq!(words(pack_point(1279, 719)), (1279, 719));
    assert_eq!(pack_point(-1, 2), 0x0002_FFFF);
    assert_eq!(words(pack_point(-5, -7)), (-5, -7));
    assert!(
        pack_point(-1, -1) > 0,
        "the packed value is a zero-extended DWORD"
    );
}

#[test]
fn a_left_click_is_a_move_then_a_press_with_the_button_and_a_release_without() {
    let lparam = pack_point(40, 25);
    let messages = click_messages(MouseButton::Left, 1, false, lparam);
    let expected = [
        (WM_MOUSEMOVE, 0),
        (WM_LBUTTONDOWN, MK_LBUTTON),
        (WM_LBUTTONUP, 0),
    ];
    assert_eq!(
        messages
            .iter()
            .map(|m| (m.message, m.wparam))
            .collect::<Vec<_>>(),
        expected
    );
    assert!(messages.iter().all(|m| m.lparam == lparam));
}

#[test]
fn every_second_press_is_a_double_click_only_for_a_class_that_asks_for_them() {
    let presses = |double_clicks| {
        click_messages(MouseButton::Left, 3, double_clicks, 0)
            .iter()
            .map(|m| m.message)
            .filter(|message| *message != WM_LBUTTONUP && *message != WM_MOUSEMOVE)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        presses(true),
        [WM_LBUTTONDOWN, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN]
    );
    assert_eq!(
        presses(false),
        [WM_LBUTTONDOWN, WM_LBUTTONDOWN, WM_LBUTTONDOWN]
    );
}

#[test]
fn right_and_middle_clicks_use_their_own_messages_and_button_flags() {
    let right = click_messages(MouseButton::Right, 2, true, 0);
    assert_eq!(
        (right[1].message, right[1].wparam, right[3].message),
        (WM_RBUTTONDOWN, MK_RBUTTON, WM_RBUTTONDBLCLK)
    );
    assert_eq!(right[4].message, WM_RBUTTONUP);
    let middle = click_messages(MouseButton::Middle, 1, false, 0);
    assert_eq!(
        (middle[1].message, middle[1].wparam, middle[2].message),
        (WM_MBUTTONDOWN, MK_MBUTTON, WM_MBUTTONUP)
    );
}

#[test]
fn the_walk_ends_at_the_innermost_child_under_the_point() {
    let children = [(1, Some(2)), (2, Some(5)), (5, None)];
    let child_of = |window: i32| {
        children
            .iter()
            .find(|(w, _)| *w == window)
            .and_then(|(_, c)| *c)
    };
    assert_eq!(deepest_window(1, child_of), 5);
    assert_eq!(
        deepest_window(5, child_of),
        5,
        "a window without a child at the point keeps the click"
    );
    assert_eq!(
        deepest_window(7, Some),
        7,
        "a window naming itself ends the walk"
    );
}

#[test]
fn a_tree_that_keeps_naming_new_children_stops_at_the_depth_bound() {
    let mut asked = 0;
    let found = deepest_window(0usize, |window| {
        asked += 1;
        Some(window + 1)
    });
    assert_eq!(found, MAX_CHILD_DEPTH);
    assert_eq!(asked, MAX_CHILD_DEPTH);
}

#[test]
fn a_window_that_is_not_per_monitor_aware_gets_its_own_scaled_pixels() {
    assert_eq!(app_client_point((450, 225), 96, 216), (200, 100));
    assert_eq!(app_client_point((451, 226), 96, 216), (200, 100));
    assert_eq!(app_client_point((300, 150), 144, 216), (200, 100));
    assert_eq!(app_client_point((450, 225), 216, 216), (450, 225));
    assert_eq!(app_client_point((450, 225), 96, 0), (450, 225));
}

#[test]
fn only_a_failure_after_the_first_press_leaves_part_of_the_click_delivered() {
    assert_eq!(
        delivery_after_failure(0).delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(
        delivery_after_failure(1).delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert_eq!(
        delivery_after_failure(2).delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
}

#[test]
fn a_posted_click_reports_an_unverified_delivery_through_window_messages() {
    let report = posted_report(Point { x: 10.0, y: 20.0 }, "Button", (3, 4));
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert_eq!(value["details"]["delivery"], "window_messages");
    assert_eq!(value["details"]["receiver_class"], "Button");
    assert_eq!(value["details"]["client_point"]["x"], 3);
    assert!(value["steps"][0].get("mechanism").is_none());
}
