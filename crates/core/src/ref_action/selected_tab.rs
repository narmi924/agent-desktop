use crate::ref_action::ref_action_context::RefActionContext;
use crate::refs::resolve_saved_ref::observe_saved_ref;
use crate::{AdapterError, InteractionLease, RefEntry};

fn refused(message: &str) -> AdapterError {
    AdapterError::stale_ref_because(message).with_suggestion(
        "Capture the intended control and its selected tab together before acting.",
    )
}

pub(super) fn check(
    guard: Option<(&RefEntry, Option<&RefEntry>)>,
    target: &RefActionContext<'_>,
    lease: &InteractionLease,
) -> Result<(), AdapterError> {
    let Some((tab, document)) = guard else {
        return Ok(());
    };
    let captured = tab
        .identity
        .retained_object
        .as_deref()
        .filter(|token| token.starts_with("tab-instance:"))
        .ok_or_else(|| refused("The capture lacks a document tab instance"))?;
    if tab.identity.role != "tab"
        || !tab.capabilities.states.iter().any(|s| s == "selected")
        || tab.source.source_window_id.is_none()
        || tab.source.source_window_id != target.entry.source.source_window_id
        || tab.process.identity().is_none()
        || tab.process.identity() != target.entry.process.identity()
    {
        return Err(refused(
            "The captured tab was not selected in the control's window",
        ));
    }
    let (_, tree, index) =
        observe_saved_ref(target.adapter, tab, target.deadline, Some(lease), false).map_err(
            |err| {
                refused("Cannot establish the selected document tab")
                    .with_details(serde_json::json!({"cause": err.code, "message": err.message}))
            },
        )?;
    let live = &tree.nodes[index].evidence;
    if live.identifiers.retained_object() != Some(captured)
        || !live
            .states
            .known()
            .is_some_and(|states| states.iter().any(|s| s == "selected"))
    {
        return Err(refused(
            "The captured document tab changed or is no longer selected",
        ));
    }
    if let Some(doc) = document {
        if doc.process != tab.process
            || doc.source.source_window_id != tab.source.source_window_id
            || !tree.is_exhaustive()
        {
            return Err(refused(
                "Cannot establish the complete form in the selected tab",
            ));
        }
        crate::commands::page_option::confirm_document(
            &tree.into_accessibility_tree()?,
            doc,
            target.entry,
        )?;
    }
    Ok(())
}

pub(super) fn resolve_choice(
    target: &RefActionContext<'_>,
) -> Result<crate::NativeHandle, AdapterError> {
    let mut anchor = target.entry.clone();
    let id = anchor
        .identity
        .retained_object
        .as_deref()
        .filter(|s| s.starts_with("choice-instance:"))
        .ok_or_else(|| refused("This control has no captured native instance"))?;
    anchor.identity.retained_object = Some(format!("require:{id}"));
    target
        .adapter
        .resolve_locator_anchor(&anchor, target.deadline)
}
