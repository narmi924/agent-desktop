//! Runs one OLE drag on its own thread and steers it from the calling thread.
//!
//! `DoDragDrop` waits for mouse messages before it asks the source anything.
//! The steering thread posts `WM_MOUSEMOVE` to the drag thread until OLE has
//! captured the mouse with its own window, then posts moves to that window
//! whose position is the drop point. OLE reads the position from the message,
//! so the real pointer never moves. After a short hover over the point the
//! source answers "drop", and the receiver gets an ordinary drop there.

use super::file_drop_data::shell_data_object;
use super::file_drop_import::{aim, times_asked};
use super::file_drop_source::{DropPhase, DropSource, DropState};
use crate::input::mouse::mouse_post::pack_point;
use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::System::Ole::{
    DROPEFFECT_COPY, DoDragDrop, OleInitialize, OleUninitialize,
};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, PostThreadMessageW, WM_MOUSEMOVE};

const MK_LBUTTON: usize = 0x0001;
const TICK: Duration = Duration::from_millis(15);
/// How long the drag rests over the point before it lets go, so receivers
/// that highlight a drop area or open a folder under the pointer can react.
pub(crate) const HOVER: Duration = Duration::from_millis(400);
const CANCEL_GRACE: Duration = Duration::from_millis(1500);

/// What one drag ended with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DropOutcome {
    pub(crate) result: i32,
    pub(crate) effect: u32,
    pub(crate) asked: u32,
    pub(crate) aimed: u32,
}

fn aimed() -> bool {
    times_asked() > 0
}

/// Drags `files` over `receiver` at the screen point `at`, in physical
/// pixels, and lets go there. `budget` bounds the whole drag.
pub(crate) fn drag_files_onto(
    files: Vec<PathBuf>,
    receiver: HWND,
    at: POINT,
    budget: Duration,
) -> Result<DropOutcome, AdapterError> {
    let state = Arc::new(DropState::default());
    let (started_tx, started_rx) = mpsc::channel::<Result<u32, AdapterError>>();
    let (done_tx, done_rx) = mpsc::channel::<(i32, u32)>();
    let receiver_raw = receiver as isize;
    let drag_state = state.clone();
    std::thread::Builder::new()
        .name("file-drop".into())
        .spawn(move || drag_thread(files, receiver_raw, drag_state, started_tx, done_tx))
        .map_err(|error| AdapterError::internal(format!("drop thread did not start: {error}")))?;
    let thread = started_rx
        .recv_timeout(budget)
        .map_err(|_| stuck("The drop did not start in time"))??;
    let started = Instant::now();
    let mut released = false;
    let mut cancelled_at: Option<Instant> = None;
    loop {
        if let Ok((result, effect)) = done_rx.try_recv() {
            return Ok(DropOutcome {
                result,
                effect,
                asked: state.asked(),
                aimed: times_asked(),
            });
        }
        let capture = state.capture();
        steer(thread, capture, at);
        if !released && capture != 0 && started.elapsed() >= HOVER {
            state.set_phase(DropPhase::Release);
            released = true;
        }
        if cancelled_at.is_none() && started.elapsed() >= budget {
            state.set_phase(DropPhase::Cancel);
            cancelled_at = Some(Instant::now());
        }
        if cancelled_at.is_some_and(|at| at.elapsed() >= CANCEL_GRACE) {
            return Err(stuck("The drop did not finish in time"));
        }
        std::thread::sleep(TICK);
    }
}

fn steer(thread: u32, capture: isize, at: POINT) {
    if capture == 0 {
        unsafe { PostThreadMessageW(thread, WM_MOUSEMOVE, MK_LBUTTON, 0) };
        return;
    }
    let window = capture as HWND;
    let mut client = at;
    if unsafe { ScreenToClient(window, &mut client) } == 0 {
        return;
    }
    unsafe {
        PostMessageW(
            window,
            WM_MOUSEMOVE,
            MK_LBUTTON,
            pack_point(client.x, client.y),
        )
    };
}

fn drag_thread(
    files: Vec<PathBuf>,
    receiver: isize,
    state: Arc<DropState>,
    started: mpsc::Sender<Result<u32, AdapterError>>,
    done: mpsc::Sender<(i32, u32)>,
) {
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if unsafe { OleInitialize(std::ptr::null()) } < 0 {
        let _ = started.send(Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "OLE could not start on the drop thread",
        )
        .with_disposition(DeliverySemantics::not_delivered())));
        return;
    }
    let outcome = shell_data_object(&files).map(|data| {
        let thread = unsafe { GetCurrentThreadId() };
        aim(receiver as HWND, thread);
        let _ = started.send(Ok(thread));
        let mut source = DropSource::new(state, aimed);
        let mut effect = 0u32;
        let result =
            unsafe { DoDragDrop(data.as_raw(), source.as_raw(), DROPEFFECT_COPY, &mut effect) };
        (result, effect)
    });
    match outcome {
        Ok(finished) => {
            let _ = done.send(finished);
        }
        Err(error) => {
            let _ = started.send(Err(error));
        }
    }
    unsafe { OleUninitialize() };
}

fn stuck(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::Timeout, message)
        .with_suggestion("Read the window to see whether the files arrived before dropping again")
        .with_disposition(DeliverySemantics::uncertain())
}

#[cfg(test)]
#[path = "file_drop_loop_tests.rs"]
mod tests;
