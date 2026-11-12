//! Whether the foreground input method would take a printable key.
//!
//! A virtual-key event reaches the input method before the application, so in
//! a composing mode a letter becomes pending composition text, which a field
//! exposes as its value although nothing was committed. Unicode input arrives
//! as `VK_PACKET`, which input methods do not compose.
//!
//! The method's own report is trusted only when it says it is open. Measured
//! with Microsoft Pinyin: a browser text field reports open with conversion
//! 1025 in Chinese mode and open with conversion 0 in English mode, while a
//! text field served through the Text Services Framework reports closed with
//! conversion 1 in both modes and composes in one of them. A closed report
//! under a composing language therefore says nothing, and the key is treated
//! as one the method would take.

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::HKL;

type MethodState = (Option<bool>, Option<u32>);

const IME_CMODE_NATIVE: u32 = 0x0001;
const IME_CMODE_FULLSHAPE: u32 = 0x0008;
const LANG_CHINESE: usize = 0x04;
const LANG_JAPANESE: usize = 0x11;
const LANG_KOREAN: usize = 0x12;

pub(crate) fn takes_printable_keys(window: HWND, layout: HKL) -> bool {
    let (open, conversion) = read_method_state(window);
    method_takes_keys(open, conversion, is_composing_language(layout))
}

fn method_takes_keys(
    open: Option<bool>,
    conversion: Option<u32>,
    composing_language: bool,
) -> bool {
    match (open, conversion) {
        (Some(true), Some(mode)) => mode & (IME_CMODE_NATIVE | IME_CMODE_FULLSHAPE) != 0,
        _ => composing_language,
    }
}

fn is_composing_language(layout: HKL) -> bool {
    matches!(
        layout as usize & 0x3ff,
        LANG_CHINESE | LANG_JAPANESE | LANG_KOREAN
    )
}

#[cfg(not(test))]
fn read_method_state(window: HWND) -> MethodState {
    use windows_sys::Win32::UI::Input::Ime::ImmGetDefaultIMEWnd;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SMTO_ABORTIFHUNG, SMTO_BLOCK, SendMessageTimeoutW, WM_IME_CONTROL,
    };
    const IMC_GETCONVERSIONMODE: usize = 0x0001;
    const IMC_GETOPENSTATUS: usize = 0x0005;
    const QUERY_TIMEOUT_MS: u32 = 100;

    let method_window = unsafe { ImmGetDefaultIMEWnd(window) };
    if method_window.is_null() {
        return (None, None);
    }
    let query = |command: usize| {
        let mut answer = 0usize;
        let answered = unsafe {
            SendMessageTimeoutW(
                method_window,
                WM_IME_CONTROL,
                command,
                0,
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                QUERY_TIMEOUT_MS,
                &mut answer,
            )
        };
        (answered != 0).then_some(answer)
    };
    (
        query(IMC_GETOPENSTATUS).map(|status| status != 0),
        query(IMC_GETCONVERSIONMODE).map(|mode| mode as u32),
    )
}

#[cfg(test)]
fn read_method_state(_window: HWND) -> MethodState {
    fake_state::current()
}

#[cfg(test)]
pub(super) mod fake_state {
    use super::MethodState;
    use std::cell::Cell;

    thread_local! {
        static STATE: Cell<MethodState> = const { Cell::new((Some(true), Some(0))) };
    }

    pub(in crate::input::keyboard) fn set(open: Option<bool>, conversion: Option<u32>) {
        STATE.with(|cell| cell.set((open, conversion)));
    }

    pub(super) fn current() -> MethodState {
        STATE.with(Cell::get)
    }
}

#[cfg(test)]
#[path = "input_method_tests.rs"]
mod tests;
