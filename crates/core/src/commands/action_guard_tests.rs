use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use std::cell::Cell;

struct IdleAdapter {
    answers: std::sync::Mutex<Vec<Result<u64, ErrorCode>>>,
    asked: std::sync::atomic::AtomicUsize,
}

impl IdleAdapter {
    fn new(answers: Vec<Result<u64, ErrorCode>>) -> Self {
        Self {
            answers: std::sync::Mutex::new(answers),
            asked: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl ObservationOps for IdleAdapter {}
impl ActionOps for IdleAdapter {}
impl SystemOps for IdleAdapter {}
impl InputOps for IdleAdapter {
    fn user_idle_ms(&self) -> Result<u64, AdapterError> {
        self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut answers = self.answers.lock().unwrap();
        match answers.remove(0) {
            Ok(idle) => Ok(idle),
            Err(code) => Err(AdapterError::new(code, "unavailable")),
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("agent-desktop-guard-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("target.txt")
}

#[test]
fn input_waits_until_the_person_has_stopped() {
    let adapter = IdleAdapter::new(vec![Ok(10), Ok(40), Ok(900)]);
    wait_until_idle(&adapter, 800, Duration::from_secs(5)).unwrap();
    assert_eq!(adapter.asked.load(std::sync::atomic::Ordering::SeqCst), 3);
}

#[test]
fn a_busy_computer_refuses_without_sending_input() {
    let adapter = IdleAdapter::new(vec![Ok(0); 40]);
    let error = wait_until_idle(&adapter, 800, Duration::ZERO).unwrap_err();
    assert_eq!(error.code(), "TIMEOUT");
    assert!(error.to_string().contains("in use"));
}

#[test]
fn a_platform_without_idle_detection_does_not_block_input() {
    let adapter = IdleAdapter::new(vec![Err(ErrorCode::PlatformNotSupported)]);
    wait_until_idle(&adapter, 800, Duration::from_secs(5)).unwrap();
}

#[test]
fn a_receipt_confirms_a_file_the_command_changed() {
    let path = scratch("changed");
    std::fs::write(&path, b"old").unwrap();
    let mark = FileMark {
        path: path.clone(),
        state: file_state(&path),
    };
    std::fs::write(&path, b"new contents").unwrap();
    let value = attach_receipt(json!({"ok": true}), &mark, Duration::from_millis(500));
    assert_eq!(value["receipt"]["verified"], true);
    assert_eq!(value["receipt"]["checks"][0]["size"], 12);
}

#[test]
fn a_receipt_reports_a_file_that_never_changed() {
    let path = scratch("same");
    std::fs::write(&path, b"same").unwrap();
    let mark = FileMark {
        path: path.clone(),
        state: file_state(&path),
    };
    let value = attach_receipt(json!({"ok": true}), &mark, Duration::from_millis(60));
    assert_eq!(value["receipt"]["verified"], false);
    assert_eq!(value["receipt"]["checks"][0]["changed"], false);
}

#[test]
fn a_new_file_counts_as_changed() {
    let path = scratch("created");
    let _ = std::fs::remove_file(&path);
    let mark = FileMark {
        path: path.clone(),
        state: file_state(&path),
    };
    let created = Cell::new(false);
    std::fs::write(&path, b"x").unwrap();
    created.set(true);
    let value = attach_receipt(json!({}), &mark, Duration::from_millis(200));
    assert!(created.get());
    assert_eq!(value["receipt"]["verified"], true);
}
