//! Replacing every system pointer shape with the agent pointer, and putting
//! the person's own pointer scheme back.
//!
//! `SetSystemCursor` changes the shape for every application until it is
//! changed again, so the swap outlives the process that made it. Restoring
//! asks Windows to reload the scheme from the person's settings
//! (`SPI_SETCURSORS`), which brings back their own pointers, not the
//! defaults.

use agent_desktop_core::{AdapterError, ErrorCode};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateBitmap, CreateDIBSection, DIB_RGB_COLORS,
    DeleteObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CopyIcon, CreateIconIndirect, DestroyIcon, HICON, ICONINFO, SPI_SETCURSORS, SetSystemCursor,
    SystemParametersInfoW,
};

use super::art::Art;

/// Arrow, text beam, wait, cross, up arrow, the four resize shapes, move,
/// unavailable, hand, working in background, help, pin and person. Leaving
/// one out would show the person's own pointer whenever the agent's pointer
/// passes over that kind of target.
const SHAPES: [u32; 16] = [
    32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650,
    32651, 32671, 32672,
];

fn failed(what: &str) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, format!("{what} failed"))
        .with_platform_detail(std::io::Error::last_os_error().to_string())
}

/// Builds one pointer from the art. The caller destroys it.
fn create(art: &Art) -> Result<HICON, AdapterError> {
    let side = art.size as i32;
    let mut header: BITMAPINFO = unsafe { std::mem::zeroed() };
    header.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: side,
        biHeight: -side,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..unsafe { std::mem::zeroed() }
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let color = unsafe {
        CreateDIBSection(
            std::ptr::null_mut(),
            &header,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        )
    };
    if color.is_null() || bits.is_null() {
        return Err(failed("CreateDIBSection"));
    }
    unsafe {
        std::ptr::copy_nonoverlapping(art.bgra.as_ptr(), bits.cast::<u8>(), art.bgra.len());
    }
    let mask = unsafe { CreateBitmap(side, side, 1, 1, std::ptr::null()) };
    if mask.is_null() {
        unsafe { DeleteObject(color) };
        return Err(failed("CreateBitmap"));
    }
    let info = ICONINFO {
        fIcon: 0,
        xHotspot: art.hotspot.0,
        yHotspot: art.hotspot.1,
        hbmMask: mask,
        hbmColor: color,
    };
    let cursor = unsafe { CreateIconIndirect(&info) };
    unsafe {
        DeleteObject(mask);
        DeleteObject(color);
    }
    if cursor.is_null() {
        return Err(failed("CreateIconIndirect"));
    }
    Ok(cursor)
}

/// Shows the agent pointer for every shape. A shape that cannot be set is
/// skipped rather than failing the rest.
pub(crate) fn swap(art: &Art) -> Result<usize, AdapterError> {
    let pointer = create(art)?;
    let mut set = 0;
    for shape in SHAPES {
        let copy = unsafe { CopyIcon(pointer) };
        if copy.is_null() {
            continue;
        }
        if unsafe { SetSystemCursor(copy, shape) } != 0 {
            set += 1;
        } else {
            unsafe { DestroyIcon(copy) };
        }
    }
    unsafe { DestroyIcon(pointer) };
    if set == 0 {
        return Err(failed("SetSystemCursor"));
    }
    Ok(set)
}

/// Reloads the person's own pointer scheme.
pub(crate) fn restore() -> Result<(), AdapterError> {
    if unsafe { SystemParametersInfoW(SPI_SETCURSORS, 0, std::ptr::null_mut(), 0) } == 0 {
        return Err(failed("SystemParametersInfoW(SPI_SETCURSORS)"));
    }
    Ok(())
}

/// The system pointer size in pixels on the primary display.
pub(crate) fn pointer_size() -> u32 {
    use windows_sys::Win32::UI::HiDpi::{GetDpiForSystem, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::SM_CYCURSOR;
    let dpi = unsafe { GetDpiForSystem() };
    let size = unsafe { GetSystemMetricsForDpi(SM_CYCURSOR, dpi) };
    u32::try_from(size).unwrap_or(32)
}
