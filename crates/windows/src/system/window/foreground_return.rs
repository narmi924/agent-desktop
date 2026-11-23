//! Reads the desktop foreground window and the pointer, and puts a previous
//! foreground window back.
//!
//! Requests foreground activation of a responsive window and checks the
//! result. Windows can refuse activation by a background process.

/// A top-level window and the process that owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ForegroundWindow {
    pub(crate) hwnd: isize,
    pub(crate) pid: u32,
}

impl ForegroundWindow {
    /// The id `list-windows` prints for this window.
    pub(crate) fn window_id(self) -> String {
        format!("w-{}", self.hwnd as usize)
    }
}

/// Where the pointer is, in physical screen pixels, and the top-level window
/// under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Pointer {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) over: Option<ForegroundWindow>,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{ForegroundWindow, Pointer};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GA_ROOT, GetAncestor, GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId,
        IsWindow, SetForegroundWindow, WindowFromPoint,
    };

    const RAISE_SETTLE: Duration = Duration::from_millis(20);
    const RAISE_POLL: Duration = Duration::from_millis(2);
    const RESPONSE_WAIT_MS: u64 = 50;

    /// The top-level window in front. `GetForegroundWindow` can name a child
    /// control while UI Automation focus settles, so the root is used.
    pub(crate) fn foreground_window() -> Option<ForegroundWindow> {
        root_window(unsafe { GetForegroundWindow() })
    }

    pub(crate) fn pointer() -> Option<Pointer> {
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return None;
        }
        Some(Pointer {
            x: point.x,
            y: point.y,
            over: root_window(unsafe { WindowFromPoint(point) }),
        })
    }

    fn root_window(hwnd: HWND) -> Option<ForegroundWindow> {
        if hwnd.is_null() {
            return None;
        }
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        window_of(if root.is_null() { hwnd } else { root })
    }

    fn window_of(hwnd: HWND) -> Option<ForegroundWindow> {
        let mut pid = 0_u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        (pid != 0).then_some(ForegroundWindow {
            hwnd: hwnd as isize,
            pid,
        })
    }

    /// Whether the window still exists and is owned by the same process, so a
    /// recycled handle is never raised. A window can hold the foreground
    /// while hidden, so visibility is not asked.
    pub(crate) fn still_owned(window: ForegroundWindow) -> bool {
        let hwnd = window.hwnd as HWND;
        let alive = unsafe { IsWindow(hwnd) != 0 };
        alive && window_of(hwnd).is_some_and(|live| live.pid == window.pid)
    }

    /// Requests the previous window only while the observed target still holds the foreground.
    pub(crate) fn bring_back(window: ForegroundWindow, taken: ForegroundWindow) -> bool {
        if !still_owned(window)
            || !crate::tree::automation::window_is_pumping(window.hwnd, RESPONSE_WAIT_MS)
        {
            return false;
        }
        let current = foreground_window();
        if current == Some(window) {
            return true;
        }
        if current != Some(taken) || !still_owned(window) {
            return false;
        }
        (unsafe { SetForegroundWindow(window.hwnd as HWND) } != 0)
            && settled_on(window)
            && crate::tree::automation::window_is_pumping(window.hwnd, RESPONSE_WAIT_MS)
            && foreground_window() == Some(window)
    }

    fn settled_on(window: ForegroundWindow) -> bool {
        let until = Instant::now() + RAISE_SETTLE;
        loop {
            if foreground_window() == Some(window) {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(RAISE_POLL);
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::{bring_back, foreground_window, pointer, still_owned};

#[cfg(all(test, target_os = "windows"))]
#[path = "foreground_return_tests.rs"]
mod tests;
