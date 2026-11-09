use super::fake_cursor::place;
use super::follow;
use crate::input::keyboard::keyboard_map::VK_ESCAPE;
use crate::input::keyboard::keyboard_send::key_state_fake_sink as keys;
use crate::input::mouse_send_fake_sink as mouse;
use agent_desktop_core::{Deadline, DeliverySemantics, PathSample, Point};

fn path() -> Vec<PathSample> {
    (0..5)
        .map(|index| PathSample {
            x: 10.0 + f64::from(index) * 5.0,
            y: 10.0,
            at_ms: 0,
            correction: false,
        })
        .collect()
}

fn start(user_moves_after: Option<usize>) {
    mouse::reset();
    keys::reset();
    place(Point { x: 10.0, y: 10.0 }, user_moves_after);
}

fn deadline() -> Deadline {
    Deadline::after(2_000).unwrap()
}

#[test]
fn every_sample_is_posted_in_order() {
    start(None);
    follow(&path(), None, deadline()).unwrap();
    assert_eq!(mouse::recorded().len(), 5);
}

#[test]
fn a_person_moving_the_mouse_stops_the_path() {
    start(Some(1));
    let error = follow(&path(), None, deadline()).unwrap_err();
    assert!(error.message.contains("interrupted"));
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(mouse::recorded().len(), 2);
}

#[test]
fn escape_stops_before_the_first_move() {
    start(None);
    keys::set_down(VK_ESCAPE);
    let error = follow(&path(), None, deadline()).unwrap_err();
    keys::reset();
    assert!(error.message.contains("Escape"));
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(mouse::recorded().is_empty());
}
