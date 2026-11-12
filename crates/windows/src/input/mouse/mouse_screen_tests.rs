use super::{ScreenRect, clamp_into, keep_on_screen};
use agent_desktop_core::Point;

const SECOND_MONITOR: ScreenRect = ScreenRect {
    left: -1280.0,
    top: 200.0,
    right: 0.0,
    bottom: 1224.0,
};

fn at(x: f64, y: f64) -> Point {
    Point { x, y }
}

#[test]
fn a_point_on_the_screen_is_left_alone() {
    assert_eq!(keep_on_screen(&at(640.0, 480.0)), at(640.0, 480.0));
}

#[test]
fn a_point_past_an_edge_lands_on_that_edge() {
    assert_eq!(keep_on_screen(&at(700.0, -24.0)), at(700.0, 0.0));
    assert_eq!(keep_on_screen(&at(1950.0, 1100.0)), at(1919.0, 1079.0));
}

#[test]
fn the_last_pixel_of_a_monitor_is_inside_it() {
    assert_eq!(
        clamp_into(&at(0.0, 1224.0), SECOND_MONITOR),
        at(-1.0, 1223.0)
    );
    assert_eq!(
        clamp_into(&at(-2000.0, 100.0), SECOND_MONITOR),
        at(-1280.0, 200.0)
    );
}
