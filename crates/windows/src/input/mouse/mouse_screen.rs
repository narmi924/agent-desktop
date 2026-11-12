//! Where the cursor can actually be.
//!
//! An absolute move to a point outside every monitor leaves the cursor on the
//! nearest edge. A planned path that bends past an edge is therefore posted
//! and compared at the position the cursor can reach, so the edge is not
//! mistaken for a person taking the mouse.

use agent_desktop_core::Point;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScreenRect {
    pub(crate) left: f64,
    pub(crate) top: f64,
    pub(crate) right: f64,
    pub(crate) bottom: f64,
}

pub(crate) fn keep_on_screen(point: &Point) -> Point {
    match nearest_monitor(point) {
        Some(screen) => clamp_into(point, screen),
        None => point.clone(),
    }
}

fn clamp_into(point: &Point, screen: ScreenRect) -> Point {
    Point {
        x: point
            .x
            .clamp(screen.left, (screen.right - 1.0).max(screen.left)),
        y: point
            .y
            .clamp(screen.top, (screen.bottom - 1.0).max(screen.top)),
    }
}

#[cfg(not(test))]
fn nearest_monitor(point: &Point) -> Option<ScreenRect> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint,
    };

    let monitor = unsafe {
        MonitorFromPoint(
            POINT {
                x: point.x.round() as i32,
                y: point.y.round() as i32,
            },
            MONITOR_DEFAULTTONEAREST,
        )
    };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    (unsafe { GetMonitorInfoW(monitor, &mut info) } != 0).then_some(ScreenRect {
        left: f64::from(info.rcMonitor.left),
        top: f64::from(info.rcMonitor.top),
        right: f64::from(info.rcMonitor.right),
        bottom: f64::from(info.rcMonitor.bottom),
    })
}

#[cfg(test)]
pub(crate) const TEST_SCREEN: ScreenRect = ScreenRect {
    left: 0.0,
    top: 0.0,
    right: 1920.0,
    bottom: 1080.0,
};

#[cfg(test)]
fn nearest_monitor(_point: &Point) -> Option<ScreenRect> {
    Some(TEST_SCREEN)
}

#[cfg(test)]
#[path = "mouse_screen_tests.rs"]
mod tests;
