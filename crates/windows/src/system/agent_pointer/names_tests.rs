use super::{Role, parse_role, root_key};
use std::path::Path;

#[test]
fn the_keeper_and_watcher_roles_parse_and_anything_else_is_no_role() {
    assert!(matches!(parse_role("keeper"), Some(Role::Keeper)));
    match parse_role("watch:4242:1733-abc") {
        Some(Role::Watch { keeper, token }) => {
            assert_eq!(keeper, 4242);
            assert_eq!(token, "1733-abc");
        }
        _ => panic!("expected a watcher role"),
    }
    assert!(parse_role("watch:x:1").is_none());
    assert!(parse_role("watch:12").is_none());
    assert!(parse_role("renderer").is_none());
}

#[test]
fn a_state_root_has_one_key_whatever_its_case() {
    let a = root_key(Path::new(r"C:\Users\A\.agent-desktop"));
    let b = root_key(Path::new(r"c:\users\a\.AGENT-DESKTOP"));
    let other = root_key(Path::new(r"D:\elsewhere"));
    assert_eq!(a, b);
    assert_ne!(a, other);
    assert_eq!(a.len(), 16);
}
