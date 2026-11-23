use super::*;
use agent_desktop_core::MouseButton;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, DPI_AWARENESS_CONTEXT_SYSTEM_AWARE,
    DPI_AWARENESS_CONTEXT_UNAWARE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, GetWindowRect,
    MSG, PostThreadMessageW, RegisterClassW, TranslateMessage, WM_QUIT, WNDCLASSW, WS_POPUP,
};

const WIDTH: i32 = 160;
const HEIGHT: i32 = 120;
const CLIENT_X: i32 = 40;
const CLIENT_Y: i32 = 30;
static PRESSED_AT: AtomicIsize = AtomicIsize::new(-1);

unsafe extern "system" fn record_press(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_LBUTTONDOWN {
        PRESSED_AT.store(lparam, Ordering::SeqCst);
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// A window that is never shown, created under one DPI awareness on a thread
/// of its own that pumps its messages until the fixture is dropped.
struct HiddenWindow {
    window: isize,
    thread: u32,
    pump: Option<std::thread::JoinHandle<()>>,
}

impl HiddenWindow {
    fn open(context: DPI_AWARENESS_CONTEXT, class: &str) -> Self {
        let context = context as isize;
        let class: Vec<u16> = class.encode_utf16().chain([0]).collect();
        let (sender, receiver) = std::sync::mpsc::channel();
        let pump = std::thread::spawn(move || unsafe {
            SetThreadDpiAwarenessContext(context as DPI_AWARENESS_CONTEXT);
            let instance = GetModuleHandleW(std::ptr::null());
            let definition = WNDCLASSW {
                lpfnWndProc: Some(record_press),
                hInstance: instance,
                lpszClassName: class.as_ptr(),
                ..std::mem::zeroed()
            };
            RegisterClassW(&definition);
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                200,
                150,
                WIDTH,
                HEIGHT,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            sender
                .send((window as isize, GetCurrentThreadId()))
                .unwrap();
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            DestroyWindow(window);
        });
        let (window, thread) = receiver.recv().unwrap();
        Self {
            window,
            thread,
            pump: Some(pump),
        }
    }
}

impl Drop for HiddenWindow {
    fn drop(&mut self) {
        unsafe { PostThreadMessageW(self.thread, WM_QUIT, 0, 0) };
        if let Some(pump) = self.pump.take() {
            pump.join().ok();
        }
    }
}

/// Posts a click at the physical screen point that shows client point
/// `CLIENT_X`,`CLIENT_Y` of a hidden window created under `context`, from a
/// per-monitor thread as the command runs, and returns the point the window
/// received.
fn received_by(context: DPI_AWARENESS_CONTEXT, name: &str) -> (i32, i32) {
    PRESSED_AT.store(-1, Ordering::SeqCst);
    let class = format!("AgentDesktopPostDpi-{}-{name}", std::process::id());
    let fixture = HiddenWindow::open(context, &class);
    let window = fixture.window as HWND;
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let mut frame = RECT::default();
    assert_ne!(unsafe { GetWindowRect(window, &mut frame) }, 0);
    let scale = f64::from(frame.right - frame.left) / f64::from(WIDTH);
    let physical = POINT {
        x: frame.left + (f64::from(CLIENT_X) * scale).round() as i32,
        y: frame.top + (f64::from(CLIENT_Y) * scale).round() as i32,
    };
    let click = MouseEvent {
        point: Point { x: 0.0, y: 0.0 },
        kind: MouseEventKind::Click { count: 1 },
        button: MouseButton::Left,
        modifiers: Vec::new(),
    };
    let (receiver, client) =
        post_at(window, physical, &click, Deadline::standard().unwrap()).unwrap();
    assert_eq!(receiver, window);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while PRESSED_AT.load(Ordering::SeqCst) == -1 && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let lparam = PRESSED_AT.load(Ordering::SeqCst) as u32;
    assert_ne!(lparam as isize, -1, "{name}: no press arrived");
    let got = (
        i32::from((lparam & 0xFFFF) as u16 as i16),
        i32::from((lparam >> 16) as u16 as i16),
    );
    assert_eq!(
        (client.x, client.y),
        got,
        "{name}: the reported point is the one the window received"
    );
    got
}

#[test]
fn a_posted_click_arrives_at_the_client_point_shown_whatever_the_window_dpi_awareness() {
    for (context, name) in [
        (DPI_AWARENESS_CONTEXT_UNAWARE, "unaware"),
        (DPI_AWARENESS_CONTEXT_SYSTEM_AWARE, "system-aware"),
        (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, "per-monitor"),
    ] {
        let (x, y) = received_by(context, name);
        assert!(
            (x - CLIENT_X).abs() <= 1 && (y - CLIENT_Y).abs() <= 1,
            "{name}: the window received {x},{y} for {CLIENT_X},{CLIENT_Y}"
        );
    }
}
