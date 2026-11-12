use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DragParams, InputOps,
    InteractionLease, KeyCombo, MouseEvent, OperationReport,
};

use crate::adapter::WindowsAdapter;

impl InputOps for WindowsAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let report = OperationReport::pointer_dispatched(&event, false);
        crate::input::mouse::synthesize_mouse(event, lease.deadline())?;
        Ok(report)
    }

    fn run_agent_pointer_child(&self) -> Option<Result<(), AdapterError>> {
        crate::system::agent_pointer::entry_from_env()
    }

    fn restore_agent_pointer(&self) -> Result<bool, AdapterError> {
        crate::system::agent_pointer::restore_now()
    }

    fn type_text_for_app(
        &self,
        process: agent_desktop_core::ProcessIdentity,
        text: &str,
        policy: agent_desktop_core::InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<agent_desktop_core::ActionResult, AdapterError> {
        crate::system::key_dispatch::type_for_app_impl(process, text, policy, lease.deadline())
    }

    fn pointer_in_window(
        &self,
        event: MouseEvent,
        window: &str,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        crate::input::page_pointer::dispatch(event, window, None, lease.deadline())
    }

    fn pointer_click_held_in_window(
        &self,
        event: MouseEvent,
        hold_ms: u64,
        window: &str,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        crate::input::page_pointer::dispatch(event, window, Some(hold_ms), lease.deadline())
    }

    #[cfg(target_os = "windows")]
    fn frame_screen_point(
        &self,
        frame: &agent_desktop_core::commands::drag::frame::WindowFrame,
        local: &agent_desktop_core::Point,
        deadline: Deadline,
    ) -> Result<agent_desktop_core::Point, AdapterError> {
        crate::input::drag_frame::screen_point(frame, local, deadline)
    }

    #[cfg(target_os = "windows")]
    fn frame_patch_matches(
        &self,
        frame: &agent_desktop_core::commands::drag::frame::WindowFrame,
        image: &[u8],
        local: &agent_desktop_core::Point,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        crate::input::drag_frame::patch_matches(frame, image, local, deadline)
    }

    fn stop_requested(&self) -> bool {
        crate::input::keyboard::escape_pressed()
    }

    fn supports_held_click(&self) -> bool {
        true
    }

    #[cfg(target_os = "windows")]
    fn user_idle_ms(&self) -> Result<u64, AdapterError> {
        use windows_sys::Win32::System::SystemInformation::GetTickCount;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return Err(AdapterError::internal(
                "the last input time could not be read",
            ));
        }
        Ok(u64::from(
            unsafe { GetTickCount() }.wrapping_sub(info.dwTime),
        ))
    }

    fn cursor_position(&self) -> Result<agent_desktop_core::Point, AdapterError> {
        crate::input::page_pointer::position()
            .ok_or_else(|| AdapterError::internal("the cursor position could not be read"))
    }

    fn pointer_path(
        &self,
        path: &[agent_desktop_core::PathSample],
        window: Option<&str>,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        crate::input::human_pointer::follow(path, window, lease.deadline())
    }

    fn mouse_click_held(
        &self,
        event: MouseEvent,
        hold_ms: u64,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let report = OperationReport::pointer_dispatched(&event, false);
        crate::input::mouse::synthesize_click_held(event, hold_ms, lease.deadline())?;
        Ok(report)
    }

    #[cfg(target_os = "windows")]
    fn drag_along(
        &self,
        params: DragParams,
        path: &[agent_desktop_core::PathSample],
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let report = OperationReport::drag_dispatched(&params);
        crate::input::drag::synthesize_along(params, path, lease.deadline())?;
        Ok(report)
    }

    /// A standalone key edge has no daemon to own the hold across a request
    /// boundary, so it rejects the same way macOS's `key_event` does -
    /// the atomic `press`/`type` composers live in the
    /// `execute_action` physical legs, not here.
    fn key_event(
        &self,
        combo: &KeyCombo,
        down: bool,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        crate::input::keyboard::reject_standalone_key_state(combo, down)
    }

    fn drag(
        &self,
        params: DragParams,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let report = OperationReport::drag_dispatched(&params);
        crate::input::drag::synthesize_drag(params, lease.deadline())?;
        Ok(report)
    }

    #[cfg(target_os = "windows")]
    fn drag_in_frames(
        &self,
        params: DragParams,
        frames: [&agent_desktop_core::commands::drag::frame::WindowFrame; 2],
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        crate::input::drag_frame::drag(params, frames, lease.deadline())
    }

    fn clear_clipboard(&self, lease: &InteractionLease) -> Result<OperationReport, AdapterError> {
        crate::input::clipboard::clear(lease.deadline())?;
        Ok(OperationReport::clipboard_written("clipboard-clear", false))
    }

    fn get_clipboard_content(
        &self,
        format: ClipboardFormat,
        deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        crate::input::clipboard::get_clipboard_content(format, deadline)
    }

    fn set_clipboard_content(
        &self,
        content: &ClipboardContent,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        crate::input::clipboard::set_content(content, lease.deadline())?;
        Ok(OperationReport::clipboard_written("clipboard-set", false))
    }
}
