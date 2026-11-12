use super::{confirm_page_capture, fingerprint};
use crate::{AccessibilityNode, RefEntry};
use serde_json::json;

fn page() -> AccessibilityNode {
    let mut doc: AccessibilityNode = serde_json::from_value(json!({
        "role":"document","value":"https://example.invalid/quiz",
        "children":[
            {"role":"statictext","name":"Time left 09:58"},
            {"role":"heading","name":"Question 1","children":[{"role":"statictext","name":"Question 1"}]},
            {"role":"radiobutton","name":"Option A","available_actions":["Click","Select"]},
            {"role":"radiobutton","name":"Option B","available_actions":["Click","Select"]},
            {"role":"button","name":"Next","available_actions":["Click"]},
            {"role":"button","name":"Next","available_actions":["Click"]}
        ]
    }))
    .unwrap();
    for (index, child) in doc.children.iter_mut().enumerate() {
        child.identity.retained_object = Some(format!("choice-instance:{index}"));
    }
    doc
}

fn captured(doc: &AccessibilityNode) -> RefEntry {
    let mut saved = crate::adapter::minimal_ref_entry("document", None);
    saved.identity.value = doc.identity.value.clone();
    saved.identity.retained_object = Some(fingerprint(doc));
    saved
}

fn target(doc: &AccessibilityNode, index: usize) -> RefEntry {
    let node = &doc.children[index];
    let mut entry = crate::adapter::minimal_ref_entry(&node.role, node.identity.name.as_deref());
    entry.identity.retained_object = node.identity.retained_object.clone();
    entry
}

fn tick(doc: &mut AccessibilityNode) {
    doc.children[0].identity.name = Some("Time left 09:57".into());
}

#[test]
fn a_ticking_clock_does_not_make_a_page_stale_for_the_wheel() {
    let mut doc = page();
    let saved = captured(&doc);
    tick(&mut doc);
    assert!(confirm_page_capture(&doc, &saved, None).is_ok());
}

#[test]
fn a_ticking_clock_does_not_stop_a_click_on_a_control_nothing_else_looks_like() {
    let mut doc = page();
    let saved = captured(&doc);
    let option = target(&doc, 3);
    tick(&mut doc);
    assert!(confirm_page_capture(&doc, &saved, Some(&option)).is_ok());
}

#[test]
fn changed_text_still_stops_a_click_on_a_control_that_has_a_look_alike() {
    let mut doc = page();
    let saved = captured(&doc);
    let second_next = target(&doc, 5);
    assert!(confirm_page_capture(&doc, &saved, Some(&second_next)).is_ok());
    tick(&mut doc);
    assert!(confirm_page_capture(&doc, &saved, Some(&second_next)).is_err());
}

#[test]
fn a_control_that_changed_its_name_state_or_number_makes_the_page_stale() {
    let saved = captured(&page());
    let mut renamed = page();
    renamed.children[4].identity.name = Some("Submit".into());
    assert!(confirm_page_capture(&renamed, &saved, None).is_err());
    let mut ticked = page();
    ticked.children[2].presentation.states = vec!["selected".into()];
    assert!(confirm_page_capture(&ticked, &saved, None).is_err());
    let mut grown = page();
    grown.children.push(grown.children[0].clone());
    assert!(confirm_page_capture(&grown, &saved, None).is_err());
}

#[test]
fn another_address_makes_the_page_stale_even_with_the_same_controls() {
    let mut doc = page();
    let saved = captured(&doc);
    doc.identity.value = Some("https://example.invalid/other".into());
    assert!(confirm_page_capture(&doc, &saved, None).is_err());
}
