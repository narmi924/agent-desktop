//! Whether keyboard and mouse input now reaches the user's own desktop.
//!
//! While the screen is locked, or a UAC prompt or other secure desktop has the input, the input desktop is not
//! `Default`; synthesized keys would land on that desktop instead of the window the tool meant.

use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
};

const DESKTOP_READOBJECTS: u32 = 0x0001;
const NAME_UNITS: usize = 64;

/// True when input goes anywhere but the `Default` desktop, or when the input desktop cannot be opened at all.
pub(crate) fn input_desktop_locked() -> bool {
    input_desktop_name().is_none_or(|name| !is_user_desktop(&name))
}

pub(crate) fn is_user_desktop(name: &str) -> bool {
    name.eq_ignore_ascii_case("Default")
}

fn input_desktop_name() -> Option<String> {
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        return None;
    }
    let mut buffer = [0u16; NAME_UNITS];
    let mut needed = 0u32;
    let read = unsafe {
        GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            buffer.as_mut_ptr().cast(),
            (NAME_UNITS * 2) as u32,
            &mut needed,
        )
    };
    unsafe { CloseDesktop(desktop) };
    if read == 0 {
        return None;
    }
    let length = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(NAME_UNITS);
    Some(String::from_utf16_lossy(&buffer[..length]))
}

#[cfg(test)]
#[path = "lock_state_tests.rs"]
mod tests;
