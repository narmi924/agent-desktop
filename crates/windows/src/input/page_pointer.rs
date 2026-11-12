use crate::system::window::window_ops::{is_root_foreground_window, parse_handle};
use crate::tree::hit_test::corroborate::window_from_point_root;
use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, MouseEvent, MouseEventKind, OperationReport, Point,
};
use windows_sys::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};

pub(super) fn refused(reason: &str, moved: bool) -> AdapterError {
    AdapterError::stale_ref_because(reason).with_disposition(if moved {
        DeliverySemantics::delivered_unverified()
    } else {
        DeliverySemantics::not_delivered()
    })
}

const CURSOR_SUGGESTION: &str = "The cursor was not where this action left it, so the action stopped. details.off_by is how far it was: a few pixels is a bumped mouse, more is a person or another program. Read the window again before repeating.";

/// A refusal because the cursor was somewhere other than where this action
/// had put it, with both positions and the stage the action had reached.
pub(super) fn cursor_elsewhere(
    reason: &str,
    phase: &str,
    (expected, found): (Option<&Point>, Option<&Point>),
    moved: bool,
) -> AdapterError {
    let off_by = expected
        .zip(found)
        .map(|(expected, found)| (expected.x - found.x).hypot(expected.y - found.y).round());
    refused(reason, moved)
        .with_details(serde_json::json!({
            "kind": "cursor_moved",
            "phase": phase,
            "expected": expected,
            "found": found,
            "off_by": off_by,
        }))
        .with_suggestion(CURSOR_SUGGESTION)
}

pub(crate) fn position() -> Option<Point> {
    let mut point = POINT::default();
    (unsafe { GetCursorPos(&mut point) } != 0).then_some(Point {
        x: f64::from(point.x),
        y: f64::from(point.y),
    })
}

pub(super) fn near(a: &Point, b: &Point) -> bool {
    (a.x - b.x).abs() <= 2.0 && (a.y - b.y).abs() <= 2.0
}

/// `hold_ms` keeps the button of a click down that long instead of the
/// shortest press.
pub(crate) fn dispatch(
    event: MouseEvent,
    window: &str,
    hold_ms: Option<u64>,
    deadline: Deadline,
) -> Result<OperationReport, AdapterError> {
    let hwnd = parse_handle(window);
    let check = |moved| {
        if !is_root_foreground_window(hwnd)
            || window_from_point_root(&event.point) != Some(hwnd as isize)
        {
            return Err(refused(
                "The pointer target is outside the active captured window",
                moved,
            ));
        }
        if crate::input::keyboard::escape_held()
            || [1, 2, 4]
                .iter()
                .any(|k| crate::input::keyboard::keyboard_send::key_is_down(*k))
        {
            return Err(refused(
                "Pointer input stopped by Escape or a held mouse button",
                moved,
            ));
        }
        deadline.ensure_remaining()
    };
    check(false)?;
    if !matches!(event.kind, MouseEventKind::Move) {
        let found = position();
        if !found.as_ref().is_some_and(|p| near(p, &event.point)) {
            return Err(cursor_elsewhere(
                "The cursor moved before pointer input",
                "before_input",
                (Some(&event.point), found.as_ref()),
                false,
            ));
        }
        let report = OperationReport::pointer_dispatched(&event, false);
        match hold_ms {
            Some(hold_ms) => super::mouse::synthesize_click_held(event, hold_ms, deadline)?,
            None => super::mouse::synthesize_mouse(event, deadline)?,
        }
        return Ok(report);
    }
    let start = position().ok_or_else(|| refused("Cannot read the cursor position", false))?;
    let distance = (start.x - event.point.x).hypot(start.y - event.point.y);
    let steps = ((distance / 55.0).ceil() as usize).clamp(1, 14);
    let mut previous = start.clone();
    for i in 1..=steps {
        check(i > 1)?;
        let found = position();
        if !found.as_ref().is_some_and(|p| near(p, &previous)) {
            return Err(cursor_elsewhere(
                "Cursor movement interrupted the pointer action",
                "moving",
                (Some(&previous), found.as_ref()),
                i > 1,
            ));
        }
        let t = i as f64 / steps as f64;
        let t = t * t * (3.0 - 2.0 * t);
        let point = Point {
            x: (start.x + (event.point.x - start.x) * t).round(),
            y: (start.y + (event.point.y - start.y) * t).round(),
        };
        super::mouse::synthesize_mouse(
            MouseEvent {
                point: point.clone(),
                ..event.clone()
            },
            deadline,
        )?;
        std::thread::sleep(std::time::Duration::from_millis(12));
        previous = point;
    }
    check(true)?;
    let found = position();
    if !found.as_ref().is_some_and(|p| near(p, &event.point)) {
        return Err(cursor_elsewhere(
            "The cursor did not reach the requested position",
            "arriving",
            (Some(&event.point), found.as_ref()),
            true,
        ));
    }
    Ok(OperationReport::pointer_dispatched(&event, true))
}
