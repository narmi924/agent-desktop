//! Points this process's own OLE drag loop at the window a file drop is for.
//!
//! OLE finds the window under a drag by calling `WindowFromPoint` through the
//! import tables of `ole32.dll` and `combase.dll`. While a drop runs, those
//! table entries in this process name [`window_for_drop`], which answers with
//! the chosen receiver on the drop thread and forwards every other caller to
//! the real function. Nothing outside this process changes, so the receiving
//! application sees an ordinary drag from another program. The entries are
//! written back when the [`ImportRedirect`] is dropped.

use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicUsize, Ordering};
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Memory::{PAGE_READWRITE, VirtualProtect};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;

const MODULES: [&str; 2] = ["ole32.dll", "combase.dll"];
const FUNCTION: &[u8] = b"WindowFromPoint\0";
const IMPORT_DIRECTORY: usize = 1;
const DELAY_IMPORT_DIRECTORY: usize = 13;
const PE32_PLUS_MAGIC: u16 = 0x20b;

static RECEIVER: AtomicIsize = AtomicIsize::new(0);
static DROP_THREAD: AtomicU32 = AtomicU32::new(0);
static REAL: AtomicUsize = AtomicUsize::new(0);
static ASKED: AtomicU32 = AtomicU32::new(0);

type WindowFromPointFn = unsafe extern "system" fn(POINT) -> HWND;

/// The receiver on the drop thread, the real answer everywhere else.
unsafe extern "system" fn window_for_drop(point: POINT) -> HWND {
    let receiver = RECEIVER.load(Ordering::Acquire);
    if receiver != 0 && unsafe { GetCurrentThreadId() } == DROP_THREAD.load(Ordering::Acquire) {
        ASKED.fetch_add(1, Ordering::AcqRel);
        return receiver as HWND;
    }
    let real = REAL.load(Ordering::Acquire);
    if real == 0 {
        return std::ptr::null_mut();
    }
    let real: WindowFromPointFn = unsafe { std::mem::transmute(real) };
    unsafe { real(point) }
}

/// How many times the drop thread's drag loop asked which window is under it.
pub(crate) fn times_asked() -> u32 {
    ASKED.load(Ordering::Acquire)
}

/// Sets the window the drop thread's drag loop finds under every point.
pub(crate) fn aim(receiver: HWND, drop_thread: u32) {
    DROP_THREAD.store(drop_thread, Ordering::Release);
    RECEIVER.store(receiver as isize, Ordering::Release);
}

/// One import-table entry that now names [`window_for_drop`].
struct Slot {
    address: *mut usize,
    original: usize,
}

/// The redirected entries, restored when this is dropped.
pub(crate) struct ImportRedirect {
    slots: Vec<Slot>,
}

impl ImportRedirect {
    /// Redirects every entry the OLE modules hold for `WindowFromPoint`.
    /// Returns `None` when no entry was found, so the caller can refuse a drop
    /// it could not aim.
    pub(crate) fn install() -> Option<Self> {
        let user32: Vec<u16> = "user32.dll\0".encode_utf16().collect();
        let real = unsafe {
            let module = GetModuleHandleW(user32.as_ptr());
            if module.is_null() {
                return None;
            }
            GetProcAddress(module, FUNCTION.as_ptr())? as usize
        };
        REAL.store(real, Ordering::Release);
        ASKED.store(0, Ordering::Release);
        let replacement = window_for_drop as WindowFromPointFn as usize;
        let mut slots = Vec::new();
        for name in MODULES {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let base = unsafe { GetModuleHandleW(wide.as_ptr()) } as *const u8;
            if base.is_null() {
                continue;
            }
            for address in unsafe { import_slots(base, real) } {
                if let Some(slot) = unsafe { redirect(address, replacement) } {
                    slots.push(slot);
                }
            }
        }
        (!slots.is_empty()).then_some(Self { slots })
    }
}

impl Drop for ImportRedirect {
    fn drop(&mut self) {
        RECEIVER.store(0, Ordering::Release);
        DROP_THREAD.store(0, Ordering::Release);
        for slot in &self.slots {
            unsafe { write_slot(slot.address, slot.original) };
        }
    }
}

unsafe fn redirect(address: *mut usize, replacement: usize) -> Option<Slot> {
    let original = unsafe { address.read_volatile() };
    unsafe { write_slot(address, replacement) }.then_some(Slot { address, original })
}

unsafe fn write_slot(address: *mut usize, value: usize) -> bool {
    let size = std::mem::size_of::<usize>();
    let mut old = 0u32;
    if unsafe { VirtualProtect(address.cast(), size, PAGE_READWRITE, &mut old) } == 0 {
        return false;
    }
    unsafe { address.write_volatile(value) };
    unsafe { VirtualProtect(address.cast(), size, old, &mut old) };
    true
}

unsafe fn read_u16(base: *const u8, offset: usize) -> u16 {
    unsafe { base.add(offset).cast::<u16>().read_unaligned() }
}

unsafe fn read_u32(base: *const u8, offset: usize) -> u32 {
    unsafe { base.add(offset).cast::<u32>().read_unaligned() }
}

unsafe fn read_usize(base: *const u8, offset: usize) -> usize {
    unsafe { base.add(offset).cast::<usize>().read_unaligned() }
}

/// The relative address of data directory `index` of a loaded 64-bit image.
unsafe fn directory(base: *const u8, index: usize) -> Option<usize> {
    let headers = unsafe { read_u32(base, 0x3c) } as usize;
    let optional = headers + 24;
    if unsafe { read_u16(base, optional) } != PE32_PLUS_MAGIC {
        return None;
    }
    let rva = unsafe { read_u32(base, optional + 112 + index * 8) } as usize;
    (rva != 0).then_some(rva)
}

/// Import-table entries of one loaded module that resolve to `real` or, in
/// delay-load tables, are bound by the name `WindowFromPoint`.
unsafe fn import_slots(base: *const u8, real: usize) -> Vec<*mut usize> {
    let mut found = Vec::new();
    if let Some(imports) = unsafe { directory(base, IMPORT_DIRECTORY) } {
        let mut descriptor = imports;
        while unsafe { read_u32(base, descriptor + 12) } != 0 {
            let mut thunk = unsafe { read_u32(base, descriptor + 16) } as usize;
            while unsafe { read_usize(base, thunk) } != 0 {
                if unsafe { read_usize(base, thunk) } == real {
                    found.push(unsafe { base.add(thunk) } as *mut usize);
                }
                thunk += 8;
            }
            descriptor += 20;
        }
    }
    if let Some(delayed) = unsafe { directory(base, DELAY_IMPORT_DIRECTORY) } {
        let mut descriptor = delayed;
        while unsafe { read_u32(base, descriptor + 4) } != 0 {
            let table = unsafe { read_u32(base, descriptor + 12) } as usize;
            let names = unsafe { read_u32(base, descriptor + 16) } as usize;
            let mut index = 0;
            loop {
                let entry = unsafe { read_usize(base, names + index * 8) };
                if entry == 0 {
                    break;
                }
                let slot = table + index * 8;
                let by_name = entry & (1 << 63) == 0
                    && unsafe { name_at(base, entry + 2) } == &FUNCTION[..FUNCTION.len() - 1];
                if by_name || unsafe { read_usize(base, slot) } == real {
                    found.push(unsafe { base.add(slot) } as *mut usize);
                }
                index += 1;
            }
            descriptor += 32;
        }
    }
    found
}

unsafe fn name_at<'a>(base: *const u8, offset: usize) -> &'a [u8] {
    unsafe { std::ffi::CStr::from_ptr(base.add(offset).cast()) }.to_bytes()
}

#[cfg(test)]
#[path = "file_drop_import_tests.rs"]
mod tests;
