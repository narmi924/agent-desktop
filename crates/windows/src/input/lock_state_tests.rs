use super::{input_desktop_locked, is_user_desktop};

#[test]
fn only_the_default_desktop_counts_as_the_users_own() {
    assert!(is_user_desktop("Default"));
    assert!(is_user_desktop("default"));
    assert!(!is_user_desktop("Winlogon"));
    assert!(!is_user_desktop("Screen-saver"));
    assert!(!is_user_desktop(""));
}

#[test]
fn an_unlocked_test_session_reads_as_unlocked() {
    assert!(!input_desktop_locked());
}
