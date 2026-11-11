use super::execute;
use crate::AdapterError;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};

struct Restoring {
    helper_running: bool,
}

impl ObservationOps for Restoring {}
impl ActionOps for Restoring {}
impl SystemOps for Restoring {}
impl InputOps for Restoring {
    fn restore_agent_pointer(&self) -> Result<bool, AdapterError> {
        Ok(self.helper_running)
    }
}

struct Unsupported;

impl ObservationOps for Unsupported {}
impl ActionOps for Unsupported {}
impl SystemOps for Unsupported {}
impl InputOps for Unsupported {}

#[test]
fn the_reply_says_the_pointer_is_back_and_whether_a_helper_was_stopped() {
    let value = execute(&Restoring {
        helper_running: true,
    })
    .unwrap();
    assert_eq!(value["restored"], true);
    assert_eq!(value["helper_stopped"], true);
    let value = execute(&Restoring {
        helper_running: false,
    })
    .unwrap();
    assert_eq!(value["helper_stopped"], false);
}

#[test]
fn a_platform_without_the_agent_pointer_says_so() {
    let error = execute(&Unsupported).unwrap_err();
    assert_eq!(error.code(), "PLATFORM_NOT_SUPPORTED");
}
