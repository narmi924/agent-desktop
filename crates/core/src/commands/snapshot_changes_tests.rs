use super::compare;
use crate::RefEntry;

fn entry(role: &str, name: &str, value: Option<&str>) -> RefEntry {
    let mut entry = crate::adapter::minimal_ref_entry(role, None);
    entry.identity.name = Some(name.into());
    entry.identity.value = value.map(str::to_owned);
    entry
}

fn diff(before: &[(&str, RefEntry)], after: &[(&str, RefEntry)]) -> serde_json::Value {
    compare(
        before.iter().map(|(id, item)| (*id, item)),
        after.iter().map(|(id, item)| (*id, item)),
        "s1",
    )
}

#[test]
fn a_new_control_is_reported_with_a_usable_ref() {
    let changes = diff(
        &[("@e1", entry("button", "Save", None))],
        &[
            ("@e1", entry("button", "Save", None)),
            ("@e2", entry("button", "Publish", None)),
        ],
    );
    assert_eq!(changes["added"][0]["ref"], "@s1:e2");
    assert_eq!(changes["added"][0]["name"], "Publish");
    assert_eq!(changes["unchanged"], 1);
}

#[test]
fn a_control_that_disappeared_is_reported() {
    let changes = diff(&[("@e1", entry("button", "Save", None))], &[]);
    assert_eq!(changes["removed"][0]["name"], "Save");
}

#[test]
fn a_changed_value_shows_before_and_after() {
    let changes = diff(
        &[("@e1", entry("textfield", "Title", Some("old")))],
        &[("@e7", entry("textfield", "Title", Some("new")))],
    );
    assert_eq!(changes["changed"][0]["before"]["value"], "old");
    assert_eq!(changes["changed"][0]["after"]["value"], "new");
    assert_eq!(changes["added"].as_array().unwrap().len(), 0);
}

#[test]
fn nothing_changed_is_all_empty() {
    let same = [("@e1", entry("link", "Home", None))];
    let changes = diff(&same, &same);
    assert_eq!(changes["unchanged"], 1);
    assert_eq!(changes["changed"].as_array().unwrap().len(), 0);
}

#[test]
fn controls_sharing_a_name_are_paired_in_document_order() {
    let mut disabled = entry("button", "", None);
    disabled.capabilities.states = vec!["disabled".into()];
    let enabled = entry("button", "", None);
    let changes = diff(
        &[("@e2", enabled.clone()), ("@e1", disabled.clone())],
        &[("@e1", disabled), ("@e2", enabled)],
    );
    assert_eq!(changes["changed"].as_array().unwrap().len(), 0);
    assert_eq!(changes["unchanged"], 2);
}
