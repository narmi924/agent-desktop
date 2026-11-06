use crate::ref_action::ref_action_context::RefActionContext;
use crate::refs::resolve_saved_ref::{observe_whole_window, recorded_window};
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
    let tree = observe(tab, target, lease)?;
    if let Some(doc) = document {
        if doc.process != tab.process
            || doc.source.source_window_id != tab.source.source_window_id
            || !tree.is_exhaustive()
        {
            return Err(refused(
                "Cannot establish the complete form in the selected tab",
            ));
        }
        crate::refs::page_capture::confirm_document(
            &tree.into_accessibility_tree()?,
            doc,
            target.entry,
        )?;
    }
    Ok(())
}

pub(crate) fn observe(
    tab: &RefEntry,
    target: &RefActionContext<'_>,
    lease: &InteractionLease,
) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
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
    let window = recorded_window(target.adapter, tab, target.deadline)?;
    if window.process_instance != tab.process.process_instance {
        return Err(refused("The captured tab's process changed"));
    }
    let options = crate::adapter::TreeOptions {
        surface: tab.source.source_surface,
        force_renderer_accessibility: tab.source.renderer_accessibility_forced,
        ..Default::default()
    };
    let tree = observe_whole_window(
        target.adapter,
        &options,
        &window,
        target.deadline,
        Some(lease),
    )?;
    if !tree.is_exhaustive() {
        return Err(refused("Cannot establish all tabs in the captured window"));
    }
    // Browser history restores can change a tab's title or description while its native instance stays selected.
    let mut matches = tree
        .nodes
        .iter()
        .map(|n| &n.evidence)
        .filter(|n| n.identifiers.retained_object() == Some(captured));
    let Some(live) = matches.next() else {
        return Err(refused("The captured tab is no longer in the window"));
    };
    let selected = live
        .states
        .known()
        .is_some_and(|s| s.iter().any(|v| v == "selected"));
    if matches.next().is_some() || live.role.known().map(String::as_str) != Some("tab") || !selected
    {
        return Err(refused(
            "The captured document tab changed or is no longer selected",
        ));
    }
    target
        .adapter
        .validate_saved_ref_context(tab, Some(captured))?;
    Ok(tree)
}

pub(crate) fn resolve_choice(
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
