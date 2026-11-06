use super::keyboard_send::{KeyboardInputEvent, key_is_down, post_keyboard_inputs};
use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use windows_sys::Win32::UI::{
    Input::KeyboardAndMouse::*,
    WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
};

pub(crate) fn require_free_typing_keys() -> Result<(), AdapterError> {
    let reason = if super::escape_held() {
        "Typing stopped by Escape"
    } else if [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN]
        .into_iter()
        .any(key_is_down)
    {
        "Typing stopped because a modifier key is held"
    } else {
        return Ok(());
    };
    Err(AdapterError::new(ErrorCode::ActionFailed, reason)
        .with_disposition(DeliverySemantics::not_delivered()))
}

/// Sends a printable key only when the foreground layout maps it back to the requested character.
/// Other text uses the existing Unicode input path, including multi-character grapheme clusters.
pub(crate) fn type_layout_character(text: &str, deadline: Deadline) -> Result<bool, AdapterError> {
    let mut units = text.encode_utf16();
    let Some(unit) = units.next() else {
        return Ok(false);
    };
    if units.next().is_some() || unit < 32 {
        return Ok(false);
    }
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return Err(AdapterError::stale_ref_because(
            "The keyboard has no active window",
        ));
    }
    let thread = unsafe { GetWindowThreadProcessId(window, std::ptr::null_mut()) };
    let layout = unsafe { GetKeyboardLayout(thread) };
    let mapping = unsafe { VkKeyScanExW(unit, layout) };
    if mapping < 0 || (mapping >> 8) & !1 != 0 {
        return Ok(false);
    }
    let vk = (mapping & 255) as u16;
    let scan = unsafe { MapVirtualKeyExW(u32::from(vk), MAPVK_VK_TO_VSC, layout) } as u16;
    if scan == 0 {
        return Ok(false);
    }
    let layout_shift = (mapping >> 8) & 1 == 1;
    let mut state = [0u8; 256];
    state[usize::from(VK_CAPITAL)] = (unsafe { GetKeyState(i32::from(VK_CAPITAL)) } & 1) as u8;
    for shift in [layout_shift, !layout_shift] {
        state[usize::from(VK_SHIFT)] = if shift { 0x80 } else { 0 };
        let mut translated = [0u16; 4];
        let count = unsafe {
            ToUnicodeEx(
                u32::from(vk),
                u32::from(scan),
                state.as_ptr(),
                translated.as_mut_ptr(),
                4,
                4,
                layout,
            )
        };
        if count != 1 || translated[0] != unit {
            continue;
        }
        deadline.ensure_remaining()?;
        let shift_scan =
            unsafe { MapVirtualKeyExW(u32::from(VK_SHIFT), MAPVK_VK_TO_VSC, layout) } as u16;
        let down = |vk, scan| KeyboardInputEvent { vk, scan, flags: 0 };
        let up = |vk, scan| KeyboardInputEvent {
            vk,
            scan,
            flags: KEYEVENTF_KEYUP,
        };
        let key = [down(vk, scan), up(vk, scan)];
        if shift {
            post_keyboard_inputs(&[
                down(VK_SHIFT, shift_scan),
                key[0],
                key[1],
                up(VK_SHIFT, shift_scan),
            ]);
        } else {
            post_keyboard_inputs(&key);
        }
        return Ok(true);
    }
    Ok(false)
}
