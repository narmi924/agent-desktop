//! The named kernel objects a keeper and its clients meet at: a mutex the
//! keeper holds for as long as it runs, an event set while the pointer is
//! swapped, and an event that asks the keeper to stop. Names carry a hash of
//! the state root, so separate `AGENT_DESKTOP_HOME` roots never share one.

use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, OpenMutexW, ResetEvent, SetEvent, WaitForSingleObject,
};

const SYNCHRONIZE: u32 = 0x0010_0000;
const EVENT_MODIFY_STATE: u32 = 0x0002;

pub(crate) struct Beacon {
    alive: Vec<u16>,
    swapped: Vec<u16>,
    stop: Vec<u16>,
}

/// An owned kernel handle, closed on drop.
pub(crate) struct Owned(pub(crate) HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

impl Owned {
    pub(crate) fn is_set(&self) -> bool {
        let state = unsafe { WaitForSingleObject(self.0, 0) };
        state == WAIT_OBJECT_0
    }

    pub(crate) fn set(&self) {
        unsafe { SetEvent(self.0) };
    }

    pub(crate) fn reset(&self) {
        unsafe { ResetEvent(self.0) };
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn opened(handle: HANDLE) -> Option<Owned> {
    (!handle.is_null()).then_some(Owned(handle))
}

impl Beacon {
    pub(crate) fn for_root(root: &Path) -> Self {
        let key = super::names::root_key(root);
        let name = |suffix: &str| wide(&format!("Local\\agent-desktop-pointer-{key}-{suffix}"));
        Self {
            alive: name("alive"),
            swapped: name("swapped"),
            stop: name("stop"),
        }
    }

    /// Claims the keeper's mutex. `None` when another keeper already holds
    /// it or the object cannot be made.
    pub(crate) fn claim_keeper(&self) -> Option<Owned> {
        use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
        let handle = unsafe { CreateMutexW(std::ptr::null(), 1, self.alive.as_ptr()) };
        let owned = opened(handle)?;
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return None;
        }
        Some(owned)
    }

    pub(crate) fn keeper_running(&self) -> bool {
        opened(unsafe { OpenMutexW(SYNCHRONIZE, 0, self.alive.as_ptr()) }).is_some()
    }

    pub(crate) fn create_swapped(&self) -> Option<Owned> {
        opened(unsafe { CreateEventW(std::ptr::null(), 1, 0, self.swapped.as_ptr()) })
    }

    pub(crate) fn create_stop(&self) -> Option<Owned> {
        let event = opened(unsafe { CreateEventW(std::ptr::null(), 1, 0, self.stop.as_ptr()) })?;
        event.reset();
        Some(event)
    }

    pub(crate) fn pointer_swapped(&self) -> bool {
        opened(unsafe { OpenEventW(SYNCHRONIZE, 0, self.swapped.as_ptr()) })
            .is_some_and(|event| event.is_set())
    }

    /// Asks a running keeper to restore and stop. Whether one was asked.
    pub(crate) fn ask_keeper_to_stop(&self) -> bool {
        match opened(unsafe { OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, 0, self.stop.as_ptr()) })
        {
            Some(event) => {
                event.set();
                true
            }
            None => false,
        }
    }
}
