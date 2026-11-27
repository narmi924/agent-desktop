//! The drag source of a file drop: a minimal COM `IDropSource` whose answers
//! come from [`DropState`] instead of the mouse buttons, so the drag ends when
//! the drop loop says so and not when a person releases a button.

use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicIsize, AtomicU8, AtomicU32, Ordering};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetCapture;
use windows_sys::core::{GUID, HRESULT};

pub(crate) const DRAGDROP_S_DROP: HRESULT = 0x0004_0100;
pub(crate) const DRAGDROP_S_CANCEL: HRESULT = 0x0004_0101;
const S_OK: HRESULT = 0;
const E_NOINTERFACE: HRESULT = 0x8000_4002_u32 as HRESULT;
const IID_IUNKNOWN: GUID = GUID::from_u128(0x00000000_0000_0000_c000_000000000046);
const IID_IDROPSOURCE: GUID = GUID::from_u128(0x00000121_0000_0000_c000_000000000046);

/// Where the drag stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum DropPhase {
    Hover = 0,
    Release = 1,
    Cancel = 2,
}

/// What the drop loop and the drag source share.
#[derive(Default)]
pub(crate) struct DropState {
    phase: AtomicU8,
    capture: AtomicIsize,
    asked: AtomicU32,
}

impl DropState {
    pub(crate) fn set_phase(&self, phase: DropPhase) {
        self.phase.store(phase as u8, Ordering::Release);
    }

    pub(crate) fn phase(&self) -> DropPhase {
        match self.phase.load(Ordering::Acquire) {
            1 => DropPhase::Release,
            2 => DropPhase::Cancel,
            _ => DropPhase::Hover,
        }
    }

    /// The window OLE captured the mouse with, once its loop has started.
    pub(crate) fn capture(&self) -> isize {
        self.capture.load(Ordering::Acquire)
    }

    /// How many times the drag loop asked whether to go on.
    pub(crate) fn asked(&self) -> u32 {
        self.asked.load(Ordering::Acquire)
    }
}

/// The answer to `QueryContinueDrag`. Escape cancels, as it does for a
/// person; a release is allowed only once the loop has aimed at the receiver.
pub(crate) fn continue_answer(phase: DropPhase, escape: bool, aimed: bool) -> HRESULT {
    if escape || phase == DropPhase::Cancel {
        return DRAGDROP_S_CANCEL;
    }
    match phase {
        DropPhase::Release if aimed => DRAGDROP_S_DROP,
        DropPhase::Release => DRAGDROP_S_CANCEL,
        _ => S_OK,
    }
}

#[repr(C)]
struct DropSourceVtbl {
    query_interface:
        unsafe extern "system" fn(*mut DropSource, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut DropSource) -> u32,
    release: unsafe extern "system" fn(*mut DropSource) -> u32,
    query_continue_drag: unsafe extern "system" fn(*mut DropSource, i32, u32) -> HRESULT,
    give_feedback: unsafe extern "system" fn(*mut DropSource, u32) -> HRESULT,
}

/// A COM object laid out as `IDropSource`. It lives on the stack of the drop
/// thread for the whole `DoDragDrop` call, so its reference count only
/// answers OLE and never frees it.
#[repr(C)]
pub(crate) struct DropSource {
    vtbl: *const DropSourceVtbl,
    refs: AtomicU32,
    state: Arc<DropState>,
    aimed: fn() -> bool,
}

static VTBL: DropSourceVtbl = DropSourceVtbl {
    query_interface,
    add_ref,
    release,
    query_continue_drag,
    give_feedback,
};

impl DropSource {
    pub(crate) fn new(state: Arc<DropState>, aimed: fn() -> bool) -> Self {
        Self {
            vtbl: &VTBL,
            refs: AtomicU32::new(1),
            state,
            aimed,
        }
    }

    pub(crate) fn as_raw(&mut self) -> *mut c_void {
        (self as *mut Self).cast()
    }
}

unsafe extern "system" fn query_interface(
    this: *mut DropSource,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> HRESULT {
    if out.is_null() || iid.is_null() {
        return E_NOINTERFACE;
    }
    let iid = unsafe { *iid };
    if same_guid(&iid, &IID_IUNKNOWN) || same_guid(&iid, &IID_IDROPSOURCE) {
        unsafe { add_ref(this) };
        unsafe { *out = this.cast() };
        return S_OK;
    }
    unsafe { *out = std::ptr::null_mut() };
    E_NOINTERFACE
}

fn same_guid(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

unsafe extern "system" fn add_ref(this: *mut DropSource) -> u32 {
    unsafe { &*this }.refs.fetch_add(1, Ordering::AcqRel) + 1
}

unsafe extern "system" fn release(this: *mut DropSource) -> u32 {
    let source = unsafe { &*this };
    source
        .refs
        .fetch_sub(1, Ordering::AcqRel)
        .saturating_sub(1)
        .max(1)
}

unsafe extern "system" fn query_continue_drag(
    this: *mut DropSource,
    escape_pressed: i32,
    _keys: u32,
) -> HRESULT {
    let source = unsafe { &*this };
    source.state.asked.fetch_add(1, Ordering::AcqRel);
    let capture = unsafe { GetCapture() };
    if !capture.is_null() {
        source
            .state
            .capture
            .store(capture as isize, Ordering::Release);
    }
    continue_answer(source.state.phase(), escape_pressed != 0, (source.aimed)())
}

unsafe extern "system" fn give_feedback(_this: *mut DropSource, _effect: u32) -> HRESULT {
    S_OK
}

#[cfg(test)]
#[path = "file_drop_source_tests.rs"]
mod tests;
