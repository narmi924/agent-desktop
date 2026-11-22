use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{InteractionLease, Modifier, MouseButton, OperationReport, Point};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::sync::Mutex;

struct PostCapture {
    picture_matches: bool,
    posted: Mutex<Vec<(String, Point, MouseEvent)>>,
}

impl PostCapture {
    fn new(picture_matches: bool) -> Self {
        Self {
            picture_matches,
            posted: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for PostCapture {}
impl ActionOps for PostCapture {}
impl SystemOps for PostCapture {
    crate::adapter::guarded_interaction_lease!();
}

impl InputOps for PostCapture {
    fn physical_pointer_refusal(&self) -> Option<AdapterError> {
        Some(AdapterError::not_supported("physical pointer"))
    }

    fn frame_patch_matches(
        &self,
        _frame: &crate::commands::drag::frame::WindowFrame,
        _image: &[u8],
        _local: &Point,
        _deadline: crate::Deadline,
    ) -> Result<bool, AdapterError> {
        Ok(self.picture_matches)
    }

    fn post_click_in_frame(
        &self,
        frame: &crate::commands::drag::frame::WindowFrame,
        local: &Point,
        event: &MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        self.posted
            .lock()
            .unwrap()
            .push((frame.window.id.clone(), local.clone(), event.clone()));
        Ok(crate::adapter::test_report())
    }
}

fn frame_image(name: &str) -> std::path::PathBuf {
    let token = URL_SAFE_NO_PAD.encode(
        json!({
            "window": {"id": "w-9", "title": "t", "app_name": "a", "pid": 9, "process_instance": "p", "is_focused": false},
            "width": 200, "height": 100, "scale": 2.0, "region": [20, 10, 100, 50]
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
        "agent-desktop-post-{}-{name}.png",
        std::process::id()
    ));
    std::fs::write(&path, png).unwrap();
    path
}

fn click(count: u32, modifiers: Vec<Modifier>) -> MouseEvent {
    MouseEvent {
        point: Point { x: 7.0, y: 5.0 },
        kind: MouseEventKind::Click { count },
        button: MouseButton::Left,
        modifiers,
    }
}

fn at(image: &std::path::Path) -> FramePointer<'_> {
    FramePointer {
        image,
        x: 7.0,
        y: 5.0,
    }
}

#[test]
fn a_posted_click_goes_to_the_captured_window_at_the_image_point_without_a_cursor() {
    let image = frame_image("posted");
    let adapter = PostCapture::new(true);
    let response = post_click(at(&image), click(1, Vec::new()), &adapter).unwrap();
    let posted = adapter.posted.lock().unwrap();
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].0, "w-9");
    assert_eq!((posted[0].1.x, posted[0].1.y), (27.0, 15.0));
    assert!(matches!(
        posted[0].2.kind,
        MouseEventKind::Click { count: 1 }
    ));
    assert_eq!(response["window"], "w-9");
    assert_eq!(response["disposition"]["delivery"], "delivered_unverified");
    std::fs::remove_file(image).ok();
}

#[test]
fn a_changed_picture_refuses_the_posted_click_before_anything_is_posted() {
    let image = frame_image("changed");
    let adapter = PostCapture::new(false);
    let error = post_click(at(&image), click(1, Vec::new()), &adapter).unwrap_err();
    assert_eq!(error.code(), "STALE_REF");
    assert!(adapter.posted.lock().unwrap().is_empty());
    std::fs::remove_file(image).ok();
}

#[test]
fn a_posted_click_cannot_hold_modifiers_or_be_anything_but_a_click() {
    let image = frame_image("refused");
    let adapter = PostCapture::new(true);
    let modified = post_click(at(&image), click(1, vec![Modifier::Shift]), &adapter);
    assert_eq!(modified.unwrap_err().code(), "INVALID_ARGS");
    let moved = post_click(
        at(&image),
        MouseEvent {
            kind: MouseEventKind::Move,
            ..click(1, Vec::new())
        },
        &adapter,
    );
    assert_eq!(moved.unwrap_err().code(), "INVALID_ARGS");
    let too_many = post_click(at(&image), click(101, Vec::new()), &adapter);
    assert_eq!(too_many.unwrap_err().code(), "INVALID_ARGS");
    assert!(adapter.posted.lock().unwrap().is_empty());
    std::fs::remove_file(image).ok();
}

#[test]
fn the_cursor_path_still_needs_headed_mode_while_the_posted_path_does_not() {
    let image = frame_image("headless");
    let adapter = PostCapture::new(true);
    let refused = execute(
        at(&image),
        click(1, Vec::new()),
        &adapter,
        &CommandContext::default(),
    );
    assert_eq!(refused.unwrap_err().code(), "POLICY_DENIED");
    assert!(post_click(at(&image), click(1, Vec::new()), &adapter).is_ok());
    std::fs::remove_file(image).ok();
}
