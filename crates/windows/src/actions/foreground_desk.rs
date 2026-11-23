//! The live desktop behind [`crate::actions::foreground_keep`], and the one
//! entry every element action passes through.
//!
//! An action whose policy allows taking focus (`--headed`, and the focus
//! fallback `press` uses), and an action with no element, runs unchanged.

use agent_desktop_core::{
    ActionResult, AdapterError, InteractionLease, NativeHandle,
    actions::action_request::ActionRequest,
};

/// Whether the action must leave the user's foreground where it was.
pub(crate) fn keeps_foreground(request: &ActionRequest, handle: &NativeHandle) -> bool {
    !request.policy.allow_focus_steal && !handle.is_null()
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{ActionRequest, ActionResult, AdapterError, InteractionLease, NativeHandle};
    use crate::actions::dispatch::execute_action_impl;
    use crate::actions::foreground_keep::{ForegroundDesk, keep_foreground};
    use crate::system::window::foreground_return::{self, ForegroundWindow, Pointer};
    use crate::tree::element::{UIAElement, uia_element};
    use agent_desktop_core::Deadline;
    use std::cell::OnceCell;
    use std::time::{Duration, Instant};

    const ROOT_READ_MS: u64 = 250;

    struct LiveDesk<'a> {
        element: &'a UIAElement,
        target_pid: u32,
        target_root: OnceCell<Option<isize>>,
    }

    impl LiveDesk<'_> {
        fn target_root(&self) -> Option<isize> {
            *self.target_root.get_or_init(|| {
                let client = crate::tree::automation::automation_client().ok()?;
                let walker = client.get_raw_view_walker().ok()?;
                let deadline = Deadline::after(ROOT_READ_MS).ok()?;
                crate::tree::hit_test::corroborate::element_root_hwnd(
                    self.element,
                    &walker,
                    deadline,
                )
                .ok()
                .flatten()
            })
        }
    }

    impl ForegroundDesk for LiveDesk<'_> {
        fn foreground(&self) -> Option<ForegroundWindow> {
            foreground_return::foreground_window()
        }

        fn is_target(&self, window: ForegroundWindow) -> bool {
            window.pid == self.target_pid || self.target_root() == Some(window.hwnd)
        }

        fn pointer(&self) -> Option<Pointer> {
            foreground_return::pointer()
        }

        fn still_owned(&self, window: ForegroundWindow) -> bool {
            foreground_return::still_owned(window)
        }

        fn bring_back(&self, window: ForegroundWindow, taken: ForegroundWindow) -> bool {
            foreground_return::bring_back(window, taken)
        }

        fn now(&self) -> Instant {
            Instant::now()
        }

        fn pause(&self, length: Duration) {
            std::thread::sleep(length);
        }
    }

    fn target_pid(element: &UIAElement, request: &ActionRequest) -> Option<u32> {
        element
            .verified_process()
            .map(|(pid, _)| pid)
            .or_else(|| request.expected_process().map(|process| process.pid.get()))
            .or_else(|| element.0.get_process_id().ok())
            .filter(|&pid| pid != 0)
    }

    /// Runs one element action; a headless one keeps the user's foreground.
    pub(crate) fn execute_action_keeping_foreground(
        handle: &NativeHandle,
        request: ActionRequest,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        if !super::keeps_foreground(&request, handle) {
            return execute_action_impl(handle, request, lease);
        }
        let Ok(element) = uia_element(handle) else {
            return execute_action_impl(handle, request, lease);
        };
        let Some(target_pid) = target_pid(element, &request) else {
            return execute_action_impl(handle, request, lease);
        };
        let desk = LiveDesk {
            element,
            target_pid,
            target_root: OnceCell::new(),
        };
        keep_foreground(&desk, || execute_action_impl(handle, request, lease))
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{ActionRequest, ActionResult, AdapterError, InteractionLease, NativeHandle};

    pub(crate) fn execute_action_keeping_foreground(
        handle: &NativeHandle,
        request: ActionRequest,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        crate::actions::dispatch::execute_action_impl(handle, request, lease)
    }
}

pub(crate) use imp::execute_action_keeping_foreground;

#[cfg(test)]
#[path = "foreground_desk_tests.rs"]
mod tests;
