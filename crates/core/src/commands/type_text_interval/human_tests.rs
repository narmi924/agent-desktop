use super::{allows_typos, give_way, someone_else_typed};
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::tree::state::SECURE;
use crate::{AdapterError, ErrorCode, RefEntry};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Desk {
    idle: Mutex<VecDeque<u64>>,
    stop: AtomicBool,
}

impl ObservationOps for Desk {}
impl ActionOps for Desk {}
impl SystemOps for Desk {}
impl InputOps for Desk {
    fn user_idle_ms(&self) -> Result<u64, AdapterError> {
        let mut idle = self.idle.lock().unwrap();
        if idle.len() > 1 {
            Ok(idle.pop_front().unwrap_or(0))
        } else {
            Ok(idle.front().copied().unwrap_or(0))
        }
    }

    fn stop_requested(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
}

fn desk(idle: &[u64]) -> Desk {
    Desk {
        idle: Mutex::new(idle.iter().copied().collect()),
        stop: AtomicBool::new(false),
    }
}

fn sent_ago(ms: u64) -> Instant {
    Instant::now() - Duration::from_millis(ms)
}

#[test]
fn input_newer_than_the_burst_own_key_belongs_to_someone_else() {
    assert!(someone_else_typed(10, 200));
    assert!(!someone_else_typed(195, 200));
    assert!(!someone_else_typed(0, 25));
}

#[test]
fn typing_continues_at_once_when_the_last_input_was_its_own() {
    let started = Instant::now();
    give_way(&desk(&[200]), sent_ago(200), Duration::from_secs(5)).unwrap();
    assert!(started.elapsed() < Duration::from_millis(40));
}

#[test]
fn typing_waits_for_a_person_to_stop_and_then_continues() {
    let started = Instant::now();
    give_way(&desk(&[5, 100, 700]), sent_ago(300), Duration::from_secs(5)).unwrap();
    assert!(started.elapsed() >= Duration::from_millis(90));
}

#[test]
fn a_person_who_never_stops_ends_the_burst() {
    let error = give_way(&desk(&[1]), sent_ago(300), Duration::from_millis(120)).unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn escape_stops_typing_even_during_the_wait() {
    let waiting = desk(&[1]);
    waiting.stop.store(true, Ordering::SeqCst);
    let error = give_way(&waiting, sent_ago(300), Duration::from_secs(5)).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.to_string().contains("Escape"));
}

fn field(name: &str) -> RefEntry {
    crate::adapter::minimal_ref_entry("textfield", Some(name))
}

#[test]
fn an_ordinary_field_may_receive_corrected_mistakes() {
    assert!(allows_typos(&field("Title")));
    assert!(allows_typos(&field("备注")));
}

#[test]
fn a_secure_field_is_typed_exactly_whatever_its_name() {
    let mut entry = field("Title");
    entry.capabilities.states = vec![SECURE.to_string()];
    assert!(!allows_typos(&entry));
}

#[test]
fn secrets_codes_and_payment_details_are_recognized_by_their_label() {
    for name in [
        "Password",
        "Enter your PASSCODE",
        "Verification code",
        "Card number",
        "登录密码",
        "短信验证码",
        "银行卡号",
    ] {
        assert!(!allows_typos(&field(name)), "{name} must be typed exactly");
    }
}

#[test]
fn the_description_counts_as_part_of_the_label() {
    let mut entry = field("Code");
    entry.identity.description = Some("One-time code from your phone".into());
    assert!(!allows_typos(&entry));
}
