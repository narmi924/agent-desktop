//! Reads the desktop foreground window and the pointer, and puts a previous
//! foreground window back.
//!
//! Putting a window back never injects input. A background process may not
//! call `SetForegroundWindow` on its own, so the caller's thread joins the
//! input state of the thread that holds the foreground (`AttachThreadInput`),
//! raises the window, detaches, and reads the foreground again. A holder whose
//! thread does not answer `WM_NULL` is left alone, because attaching to a
//! thread that is not dispatching can stall the caller.

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
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GA_ROOT, GetAncestor, GetCursorPos, GetForegroundWindow,
        GetWindowThreadProcessId, IsWindow, SetForegroundWindow, WindowFromPoint,
    };

    const RAISE_SETTLE: Duration = Duration::from_millis(20);
    const RAISE_POLL: Duration = Duration::from_millis(2);

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

    /// Raises `window` over whatever holds the foreground now and reports
    /// whether it is the foreground window afterwards.
    pub(crate) fn bring_back(window: ForegroundWindow) -> bool {
        if !still_owned(window) {
            return false;
        }
        if foreground_window() == Some(window) {
            return true;
        }
        let holder = unsafe { GetForegroundWindow() };
        if !holder.is_null() && !crate::system::window::window_enum::window_is_responsive(holder) {
            return false;
        }
        let holder_thread = if holder.is_null() {
            0
        } else {
            unsafe { GetWindowThreadProcessId(holder, std::ptr::null_mut()) }
        };
        let own_thread = unsafe { GetCurrentThreadId() };
        let attached = holder_thread != 0
            && holder_thread != own_thread
            && unsafe { AttachThreadInput(own_thread, holder_thread, 1) } != 0;
        let hwnd = window.hwnd as HWND;
        unsafe {
            let _ = SetForegroundWindow(hwnd);
            let _ = BringWindowToTop(hwnd);
        }
        if attached {
            unsafe { AttachThreadInput(own_thread, holder_thread, 0) };
        }
        settled_on(window)
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
