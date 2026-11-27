use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, InteractionLease, OperationReport};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::sync::Mutex;

struct DropCapture {
    picture_matches: bool,
    dropped: Mutex<Vec<FileDrop>>,
}

impl DropCapture {
    fn new(picture_matches: bool) -> Self {
        Self {
            picture_matches,
            dropped: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for DropCapture {}
impl ActionOps for DropCapture {}
impl SystemOps for DropCapture {
    crate::adapter::guarded_interaction_lease!();
}

impl InputOps for DropCapture {
    fn frame_window_point(
        &self,
        _frame: &crate::commands::drag::frame::WindowFrame,
        local: &Point,
        _deadline: crate::Deadline,
    ) -> Result<Point, AdapterError> {
        Ok(Point {
            x: local.x + 1000.0,
            y: local.y + 500.0,
        })
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

    fn drop_files(
        &self,
        drop: &FileDrop,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        self.dropped.lock().unwrap().push(drop.clone());
        Ok(crate::adapter::test_report())
    }
}

fn scratch(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("agent-desktop-drop-{}-{name}", std::process::id()));
    std::fs::write(&path, b"x").unwrap();
    path
}

fn frame_image(name: &str) -> PathBuf {
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
        "agent-desktop-drop-frame-{}-{name}.png",
        std::process::id()
    ));
    std::fs::write(&path, png).unwrap();
    path
}

fn run(adapter: &DropCapture, files: Vec<PathBuf>, image: &Path) -> Result<Value, AppError> {
    execute(
        DropFilesArgs {
            files,
            place: DropPlace::Frame {
                image,
                x: 10.0,
                y: 20.0,
            },
        },
        adapter,
        &CommandContext::default(),
    )
}

#[test]
fn drops_every_file_on_the_framed_window_at_the_screen_point() {
    let adapter = DropCapture::new(true);
    let image = frame_image("ok");
    let (first, second) = (scratch("a.txt"), scratch("b.txt"));
    let value = run(&adapter, vec![first.clone(), second.clone()], &image).unwrap();
    let dropped = adapter.dropped.lock().unwrap();
    assert_eq!(dropped.len(), 1);
    assert_eq!(dropped[0].window, "w-9");
    assert_eq!(dropped[0].files, vec![first, second]);
    assert!(dropped[0].point.x > 1000.0 && dropped[0].point.y > 500.0);
    assert_eq!(value["files"], 2);
    assert_eq!(value["window"], "w-9");
}

#[test]
fn refuses_a_picture_that_changed_before_dropping() {
    let adapter = DropCapture::new(false);
    let image = frame_image("changed");
    let error = run(&adapter, vec![scratch("c.txt")], &image).unwrap_err();
    assert_eq!(error.code(), "STALE_REF");
    assert!(adapter.dropped.lock().unwrap().is_empty());
}

#[test]
fn names_missing_files_by_index_only() {
    let adapter = DropCapture::new(true);
    let image = frame_image("missing");
    let secret = std::env::temp_dir().join("agent-desktop-drop-no-such-secret-name.txt");
    let error = run(&adapter, vec![scratch("d.txt"), secret], &image).unwrap_err();
    assert_eq!(error.code(), "INVALID_ARGS");
    let message = error.to_string();
    assert!(message.contains("indexes: [1]"));
    assert!(!message.contains("secret"));
    assert!(adapter.dropped.lock().unwrap().is_empty());
}

#[test]
fn refuses_an_empty_drop() {
    let adapter = DropCapture::new(true);
    let image = frame_image("empty");
    let error = run(&adapter, Vec::new(), &image).unwrap_err();
    assert_eq!(error.code(), "INVALID_ARGS");
}

#[test]
fn makes_relative_files_absolute() {
    let adapter = DropCapture::new(true);
    let image = frame_image("relative");
    let name = format!("agent-desktop-drop-rel-{}.txt", std::process::id());
    let here = std::env::current_dir().unwrap().join(&name);
    std::fs::write(&here, b"x").unwrap();
    let result = run(&adapter, vec![PathBuf::from(&name)], &image);
    std::fs::remove_file(&here).unwrap();
    result.unwrap();
    assert!(adapter.dropped.lock().unwrap()[0].files[0].is_absolute());
}
