use crate::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DragParams, InteractionLease,
    KeyCombo, MouseEvent, OperationReport,
};

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowFrame {
    pub window: crate::WindowInfo,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    #[serde(default)]
    pub region: Option<[u32; 4]>,
}

/// `get_clipboard`/`set_clipboard` were removed pre-1.0 in favor of
/// `get_clipboard_content`/`set_clipboard_content`; the C ABI
/// (`ad_get_clipboard`/`ad_set_clipboard`) is unaffected.
pub trait InputOps: Send + Sync {
    /// The reason physical pointer delivery cannot happen in this session, if
    /// it cannot. Commands that would aim a cursor ask before any geometry or
    /// actionability work, so a session without pointer input answers at once
    /// instead of spending its wait budget on a gesture it can never send.
    fn physical_pointer_refusal(&self) -> Option<AdapterError> {
        None
    }

    /// Whether a headed keyboard delivery needs the target window activated
    /// first. An adapter whose keys can be delivered without activating
    /// another window (a Wayland session, where the compositor refuses client
    /// activation) answers false, so core skips a window focus the session
    /// cannot grant.
    fn keyboard_needs_window_activation(&self) -> bool {
        true
    }

    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("mouse_event"))
    }

    fn pointer_in_window(
        &self,
        _event: MouseEvent,
        _window: &str,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported(
            "pointer input in a captured window",
        ))
    }

    /// Milliseconds since the person last used the keyboard or mouse.
    fn user_idle_ms(&self) -> Result<u64, AdapterError> {
        Err(AdapterError::not_supported("user idle time"))
    }

    /// Whether the person has pressed the stop key since this was last asked.
    fn stop_requested(&self) -> bool {
        false
    }

    fn cursor_position(&self) -> Result<crate::Point, AdapterError> {
        Err(AdapterError::not_supported("cursor position"))
    }

    /// Moves the real cursor along `path`. With `window`, stops unless that
    /// window stays in front and under the cursor.
    fn pointer_path(
        &self,
        _path: &[crate::PathSample],
        _window: Option<&str>,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("pointer path"))
    }

    fn mouse_click_held(
        &self,
        event: MouseEvent,
        _hold_ms: u64,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        self.mouse_event(event, lease)
    }

    fn drag_along(
        &self,
        params: DragParams,
        _path: &[crate::PathSample],
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        self.drag(params, lease)
    }

    fn key_event(
        &self,
        _combo: &KeyCombo,
        _down: bool,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("key_event"))
    }

    fn drag(
        &self,
        _params: DragParams,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("drag"))
    }

    fn drag_in_frames(
        &self,
        _params: DragParams,
        _frames: [&WindowFrame; 2],
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("drag in window frames"))
    }

    fn clear_clipboard(&self, _lease: &InteractionLease) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("clear_clipboard"))
    }

    /// Reads the requested clipboard representation. Returns `Ok(None)`
    /// when the pasteboard has no data of the requested shape (or, for
    /// `Auto`, no data at all) — a normal, non-error outcome distinct from
    /// `Err(not_supported)`, which means this platform never implements
    /// clipboard reads.
    fn get_clipboard_content(
        &self,
        _format: ClipboardFormat,
        _deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        Err(AdapterError::not_supported("get_clipboard_content"))
    }

    fn set_clipboard_content(
        &self,
        _content: &ClipboardContent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("set_clipboard_content"))
    }
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
