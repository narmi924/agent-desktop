//! Clicks a point of a window by posting mouse messages to the window under
//! it. Nothing moves the cursor, nothing goes through `SendInput`, and no
//! window is activated, so the person keeps the mouse and the window in
//! front. The messages go to the deepest visible, enabled child window at the
//! point, in that window's own client coordinates, posted from that window's
//! DPI awareness (see `WindowDpiScope`).
//!
//! An app that reads the live button state, or hit-tests the real cursor
//! instead of the message's point, does nothing with such a click, and
//! Chromium already ignores posted keys (A4-4). Nothing here reads the app's
//! reaction, so a posted click is `delivered_unverified` and the caller
//! judges the effect.

use super::mouse_post_keep::{PostDesk, wait_for_take};
use crate::actions::foreground_keep::keep_foreground;
use crate::input::elevation::ensure_target_integrity_allows_input;
use crate::system::window::foreground_return;
use crate::system::window::window_ops::parse_handle;
use agent_desktop_core::{
    ActionResult, ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode, MouseButton,
    MouseEvent, MouseEventKind, OperationReport, OperationTarget, Point, ProcessId,
    commands::drag::frame::WindowFrame,
};
use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT, GetWindowDpiAwarenessContext, PhysicalToLogicalPointForPerMonitorDPI,
    SetThreadDpiAwarenessContext,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CS_DBLCLKS, GCL_STYLE, GetClassLongW, GetClassNameW, GetClientRect, GetWindowThreadProcessId,
    IsWindowVisible, PostMessageW, RealChildWindowFromPoint, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_RBUTTONDBLCLK,
    WM_RBUTTONDOWN, WM_RBUTTONUP,
};

const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;
const MK_MBUTTON: usize = 0x0010;
const MAX_CHILD_DEPTH: usize = 64;

/// One window message to post: its id and its two parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PostedMessage {
    pub(crate) message: u32,
    pub(crate) wparam: usize,
    pub(crate) lparam: isize,
}

/// `MAKELPARAM(x, y)`: x in the low word and y in the high word, each kept as
/// a signed 16-bit value so a point left of or above the client origin reads
/// back negative through `GET_X_LPARAM`/`GET_Y_LPARAM`.
pub(crate) fn pack_point(x: i32, y: i32) -> isize {
    let low = u32::from(x as i16 as u16);
    let high = u32::from(y as i16 as u16);
    ((high << 16) | low) as isize
}

/// The messages a real click at one point produces for the window under it:
/// the pointer arriving, then a press and a release per click. With
/// `double_clicks` (a window class with `CS_DBLCLKS`) every second press is
/// the double-click message, as Windows sends it. A press carries its button
/// in `wParam`; a release carries no button, since none is down after it.
pub(crate) fn click_messages(
    button: MouseButton,
    count: u32,
    double_clicks: bool,
    lparam: isize,
) -> Vec<PostedMessage> {
    let (down, up, double, held) = match button {
        MouseButton::Left => (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON),
        MouseButton::Right => (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON),
        MouseButton::Middle => (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON),
    };
    let mut messages = vec![PostedMessage {
        message: WM_MOUSEMOVE,
        wparam: 0,
        lparam,
    }];
    for press in 0..count {
        let message = if double_clicks && press % 2 == 1 {
            double
        } else {
            down
        };
        messages.push(PostedMessage {
            message,
            wparam: held,
            lparam,
        });
        messages.push(PostedMessage {
            message: up,
            wparam: 0,
            lparam,
        });
    }
    messages
}

/// Follows `child_at` from `top` down to the innermost window it names. A
/// window that names itself or nothing ends the walk, and so does the depth
/// bound, which keeps a window tree that changes during the walk from
/// looping.
pub(crate) fn deepest_window<H: Copy + PartialEq>(
    top: H,
    mut child_at: impl FnMut(H) -> Option<H>,
) -> H {
    let mut current = top;
    for _ in 0..MAX_CHILD_DEPTH {
        match child_at(current) {
            Some(child) if child != current => current = child,
            _ => break,
        }
    }
    current
}

/// The disposition of a click whose posting stopped at message `index`: the
/// pointer move alone presses nothing, so only a failure after the first
/// button message leaves part of the click delivered.
pub(crate) fn delivery_after_failure(index: usize) -> DeliverySemantics {
    if index <= 1 {
        DeliverySemantics::not_delivered()
    } else {
        DeliverySemantics::delivered_unverified()
    }
}

fn posted_result(receiver_class: &str, client: (i32, i32)) -> ActionResult {
    ActionResult::delivered_unverified("mouse-click")
        .with_steps(vec![ActionStep::succeeded("window_messages_posted")])
        .with_details(serde_json::json!({
            "delivery": "window_messages",
            "receiver_class": receiver_class,
            "client_point": { "x": client.0, "y": client.1 },
        }))
}

fn outside_client_area() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "This point is on a window border, title bar or scroll bar; a posted click reaches only the inside of a window",
    )
    .with_suggestion("Click there with --headed mouse-click --frame, which moves the real cursor")
    .with_disposition(DeliverySemantics::not_delivered())
}

fn window_disabled() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The window is disabled, so it takes no clicks; it usually waits for a dialog it opened",
    )
    .with_suggestion("Act on the dialog the window waits for")
    .with_disposition(DeliverySemantics::not_delivered())
}

/// Posts a click at `local`, a point of the captured window in its own
/// pixels, to the window under that point, and keeps the user's foreground
/// window in front (see `mouse_post_keep`).
pub(crate) fn post_click(
    frame: &WindowFrame,
    local: &Point,
    event: &MouseEvent,
    deadline: Deadline,
) -> Result<OperationReport, AdapterError> {
    let origin = crate::input::drag_frame::frame_origin(frame, deadline)?;
    let screen = Point {
        x: origin.x + local.x,
        y: origin.y + local.y,
    };
    let at = POINT {
        x: screen.x.round() as i32,
        y: screen.y.round() as i32,
    };
    let top = parse_handle(&frame.window.id);
    let desk = PostDesk {
        target_pid: window_process(top).get(),
        target_root: top as isize,
    };
    let before = foreground_return::foreground_window();
    let result = keep_foreground(&desk, || {
        let (receiver, client) = post_at(top, at, event, deadline)?;
        wait_for_take(&desk, before);
        Ok(posted_result(&class_name(receiver), (client.x, client.y)))
    })?;
    Ok(OperationReport::new(
        result,
        OperationTarget::Pointer { point: screen },
    ))
}

/// Posts a click at `physical`, a screen point in physical pixels inside
/// `top`, to the deepest window under it, and returns that window and the
/// client point it was given in its own pixels.
pub(crate) fn post_at(
    top: HWND,
    physical: POINT,
    event: &MouseEvent,
    deadline: Deadline,
) -> Result<(HWND, POINT), AdapterError> {
    let MouseEventKind::Click { count } = event.kind else {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Only a click can be posted to a window",
        ));
    };
    agent_desktop_core::validate_mouse_click_count(count)?;
    if unsafe { IsWindowEnabled(top) } == 0 {
        return Err(window_disabled());
    }
    let receiver = deepest_window(top, |parent| child_at(parent, physical));
    let _scope = WindowDpiScope::enter(receiver).ok_or_else(scale_unknown)?;
    let client = own_client_point(receiver, physical)
        .filter(|client| inside_client_area(receiver, *client))
        .ok_or_else(outside_client_area)?;
    ensure_target_integrity_allows_input(window_process(receiver))?;
    deadline.ensure_remaining()?;
    let messages = click_messages(
        event.button.clone(),
        count,
        has_double_clicks(receiver),
        pack_point(client.x, client.y),
    );
    post_all(receiver, &messages)?;
    Ok((receiver, client))
}

/// Puts this thread in a window's DPI awareness until it is dropped, so the
/// points read and posted here are in the pixels that window works in.
/// Windows translates a posted mouse message's point from the posting
/// thread's awareness to the receiving window's: a per-monitor thread that
/// posted 120,69 to a DPI-unaware window at 225 % had it arrive as 53,31,
/// while the same post from a DPI-unaware thread arrived as 120,69. So the
/// point is computed, and the click posted, inside the receiver's scope.
struct WindowDpiScope {
    previous: DPI_AWARENESS_CONTEXT,
}

impl WindowDpiScope {
    fn enter(window: HWND) -> Option<Self> {
        let context = unsafe { GetWindowDpiAwarenessContext(window) };
        if context.is_null() {
            return None;
        }
        let previous = unsafe { SetThreadDpiAwarenessContext(context) };
        (!previous.is_null()).then_some(Self { previous })
    }
}

impl Drop for WindowDpiScope {
    fn drop(&mut self) {
        unsafe { SetThreadDpiAwarenessContext(self.previous) };
    }
}

/// `physical`, a screen point in physical pixels, as a client point of
/// `window` in the window's own pixels. Runs inside that window's scope.
fn own_client_point(window: HWND, physical: POINT) -> Option<POINT> {
    let mut point = physical;
    let mapped = unsafe {
        PhysicalToLogicalPointForPerMonitorDPI(window, &mut point) != 0
            && ScreenToClient(window, &mut point) != 0
    };
    mapped.then_some(point)
}

fn inside_client_area(window: HWND, client: POINT) -> bool {
    let mut area = RECT::default();
    let read = unsafe { GetClientRect(window, &mut area) } != 0;
    read && (0..area.right).contains(&client.x) && (0..area.bottom).contains(&client.y)
}

pub(crate) fn child_at(parent: HWND, physical: POINT) -> Option<HWND> {
    let _scope = WindowDpiScope::enter(parent)?;
    let client = own_client_point(parent, physical)?;
    let child = unsafe { RealChildWindowFromPoint(parent, client) };
    if child.is_null() || child == parent {
        return None;
    }
    let usable = unsafe { IsWindowVisible(child) != 0 && IsWindowEnabled(child) != 0 };
    usable.then_some(child)
}

fn scale_unknown() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The window's DPI awareness could not be taken on, so the point it would receive is unknown",
    )
    .with_suggestion("Click there with --headed mouse-click --frame, which moves the real cursor")
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn window_process(window: HWND) -> ProcessId {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, &mut pid) };
    ProcessId::new(pid)
}

fn has_double_clicks(window: HWND) -> bool {
    let style = unsafe { GetClassLongW(window, GCL_STYLE) };
    style & CS_DBLCLKS != 0
}

pub(crate) fn class_name(window: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..usize::try_from(length).unwrap_or(0)])
}

fn post_all(window: HWND, messages: &[PostedMessage]) -> Result<(), AdapterError> {
    for (index, message) in messages.iter().enumerate() {
        if unsafe { PostMessageW(window, message.message, message.wparam, message.lparam) } == 0 {
            return Err(crate::system::runtime::hresult::win32_last_error(
                "Posting a mouse message to the window failed",
            )
            .with_disposition(delivery_after_failure(index)));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "mouse_post_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mouse_post_dpi_tests.rs"]
mod dpi_tests;
