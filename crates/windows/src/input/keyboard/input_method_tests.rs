use super::{IME_CMODE_FULLSHAPE, IME_CMODE_NATIVE, fake_state, method_takes_keys};
use crate::input::keyboard::keyboard_send::keyboard_send_fake_sink as sink;
use crate::input::keyboard::type_layout_character;
use agent_desktop_core::Deadline;

#[test]
fn composing_and_full_width_modes_take_printable_keys() {
    assert!(method_takes_keys(Some(true), Some(IME_CMODE_NATIVE), false));
    assert!(method_takes_keys(Some(true), Some(1025), false));
    assert!(method_takes_keys(
        Some(true),
        Some(IME_CMODE_FULLSHAPE),
        false
    ));
}

#[test]
fn a_closed_or_alphanumeric_method_leaves_real_keys_enabled() {
    assert!(!method_takes_keys(
        Some(false),
        Some(IME_CMODE_NATIVE),
        true
    ));
    assert!(!method_takes_keys(Some(true), Some(0), true));
}

#[test]
fn an_unreadable_method_falls_back_only_for_composing_languages() {
    assert!(method_takes_keys(None, None, true));
    assert!(method_takes_keys(Some(true), None, true));
    assert!(!method_takes_keys(None, None, false));
}

#[test]
fn a_printable_key_never_reaches_a_composing_input_method() {
    sink::reset();
    fake_state::set(Some(true), Some(IME_CMODE_NATIVE));
    let typed = type_layout_character("a", Deadline::after(1_000).expect("deadline"));
    fake_state::set(Some(false), None);
    assert!(!typed.expect("layout typing decision"));
    assert!(
        sink::recorded().is_empty(),
        "the letter must take the Unicode path instead of becoming composition text"
    );
}
