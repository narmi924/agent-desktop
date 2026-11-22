use super::*;
use agent_desktop_core::{
    ActionOps, AdapterError, Deadline, InputOps, InteractionLease, ObservationOps, OperationReport,
    OperationTarget, SystemOps, commands::drag::frame::WindowFrame,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::sync::Mutex;

#[derive(Default)]
struct PostedOnly {
    posted: Mutex<Vec<Point>>,
    moved: Mutex<u32>,
}

impl ObservationOps for PostedOnly {}
impl ActionOps for PostedOnly {}

impl SystemOps for PostedOnly {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }
}

impl InputOps for PostedOnly {
    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        *self.moved.lock().unwrap() += 1;
        Err(AdapterError::not_supported("the real cursor"))
    }

    fn frame_patch_matches(
        &self,
        _frame: &WindowFrame,
        _image: &[u8],
        _local: &Point,
        _deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        Ok(true)
    }

    fn post_click_in_frame(
        &self,
        _frame: &WindowFrame,
        local: &Point,
        _event: &MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        self.posted.lock().unwrap().push(local.clone());
        Ok(OperationReport::delivered_unverified(
            "mouse-click",
            OperationTarget::Pointer {
                point: local.clone(),
            },
        ))
    }
}

fn frame_image() -> std::path::PathBuf {
    let token = URL_SAFE_NO_PAD.encode(
        serde_json::json!({
            "window": {"id": "w-3", "title": "t", "app_name": "a", "pid": 3, "process_instance": "p", "is_focused": false},
            "width": 40, "height": 30, "scale": 1.0
        })
        .to_string(),
    );
    let mut text = b"agent-desktop-frame\0".to_vec();
    text.extend_from_slice(token.as_bytes());
    let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13];
    png.extend_from_slice(b"IHDR");
    png.extend_from_slice(&[0; 17]);
    png.extend_from_slice(&(text.len() as u32).to_be_bytes());
    png.extend_from_slice(b"tEXt");
    png.extend_from_slice(&text);
    png.extend_from_slice(&[0; 4]);
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-dispatch-post-{}.png",
        std::process::id()
    ));
    std::fs::write(&path, png).unwrap();
    path
}

fn click_args(image: &std::path::Path, post: bool) -> MouseClickArgs {
    serde_json::from_value(serde_json::json!({
        "xy": "12,8",
        "frame": image,
        "post": post,
    }))
    .unwrap()
}

#[test]
fn mouse_click_post_reaches_the_posted_click_without_headed_mode_or_the_cursor() {
    let image = frame_image();
    let adapter = PostedOnly::default();
    let headless = CommandContext::default();
    let reply = mouse_click(click_args(&image, true), &adapter, &headless).unwrap();
    assert_eq!(reply["window"], "w-3");
    let posted = adapter.posted.lock().unwrap().clone();
    assert_eq!(posted.len(), 1);
    assert_eq!((posted[0].x, posted[0].y), (12.0, 8.0));
    assert_eq!(*adapter.moved.lock().unwrap(), 0);
    let cursor = mouse_click(click_args(&image, false), &adapter, &headless).unwrap_err();
    assert_eq!(
        cursor.code(),
        "POLICY_DENIED",
        "without --post the frame click still needs --headed"
    );
    assert_eq!(adapter.posted.lock().unwrap().len(), 1);
    std::fs::remove_file(image).ok();
}
