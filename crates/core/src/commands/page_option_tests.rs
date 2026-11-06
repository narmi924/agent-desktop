use super::{ChoiceTarget, execute};
use crate::refs::page_capture::{confirm_document, fingerprint, stamp_documents};
use crate::{AccessibilityNode, Action, CommandContext};
use serde_json::json;

#[test]
fn page_choices_do_not_fall_back_to_physical_delivery() {
    let error = execute(
        ChoiceTarget {
            control: "",
            tab: "",
            document: "",
        },
        Action::Click,
        &crate::adapter::NoopAdapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();
    assert!(error.to_string().contains("requires semantic delivery"));
}

#[test]
fn identical_controls_need_the_unchanged_document_and_one_live_instance() {
    let mut doc: AccessibilityNode = serde_json::from_value(json!({
        "role":"document","value":"https://example.invalid/form",
        "children":[{"role":"statictext","name":"Billing"},{"role":"group"},
                    {"role":"statictext","name":"Shipping"},{"role":"group"}]
    }))
    .unwrap();
    doc.identity.retained_object = Some("choice-instance:document".into());
    doc.children[1].identity.retained_object = Some("choice-instance:a".into());
    doc.children[3].identity.retained_object = Some("choice-instance:b".into());
    let mut capture = doc.clone();
    stamp_documents(&mut capture);
    let mut saved = crate::adapter::minimal_ref_entry("document", None);
    saved.identity.value = capture.identity.value;
    saved.identity.retained_object = capture.identity.retained_object;
    let mut target = crate::adapter::minimal_ref_entry("group", None);
    target.identity.retained_object = doc.children[3].identity.retained_object.clone();
    assert!(confirm_document(&doc, &saved, &target).is_ok());
    doc.children.swap(0, 2);
    assert!(confirm_document(&doc, &saved, &target).is_err());
    doc.children.swap(0, 2);
    doc.identity.value = Some("https://example.invalid/other".into());
    assert!(confirm_document(&doc, &saved, &target).is_err());
    doc.identity.value.clone_from(&saved.identity.value);
    doc.children[1].identity.retained_object = target.identity.retained_object.clone();
    saved.identity.retained_object = Some(fingerprint(&doc));
    assert!(confirm_document(&doc, &saved, &target).is_err());
}
