use crate::commands::helpers::{RefArgs, execute_ref_action_dispatching, load_ref_entry};
use crate::{
    AccessibilityNode, Action, AdapterError, AppError, CommandContext, PlatformAdapter, RefEntry,
};
use serde_json::Value;
use std::hash::{DefaultHasher, Hash, Hasher};

fn web_document(node: &AccessibilityNode) -> bool {
    node.role == "document"
        && node.identity.value.as_deref().is_some_and(|s| {
            s.starts_with("http://") || s.starts_with("https://") || s.starts_with("file:///")
        })
}

fn fingerprint(node: &AccessibilityNode) -> String {
    fn visit(node: &AccessibilityNode, hash: &mut DefaultHasher) {
        node.role.hash(hash);
        node.identity.name.hash(hash);
        node.identity.value.hash(hash);
        node.identity.description.hash(hash);
        node.identity
            .retained_object
            .as_deref()
            .filter(|s| s.starts_with("choice-instance:"))
            .hash(hash);
        node.children.len().hash(hash);
        node.presentation.available_actions.hash(hash);
        for state in &node.presentation.states {
            if matches!(
                state.as_str(),
                "selected" | "checked" | "mixed" | "disabled" | "expanded" | "collapsed"
            ) {
                state.hash(hash);
            }
        }
        for child in &node.children {
            visit(child, hash);
        }
    }
    let mut hash = DefaultHasher::new();
    visit(node, &mut hash);
    format!("page-shape:{:016x}", hash.finish())
}

pub(crate) fn stamp_documents(node: &mut AccessibilityNode) {
    if web_document(node) {
        if node
            .identity
            .retained_object
            .as_deref()
            .is_none_or(|id| id.starts_with("choice-instance:"))
        {
            node.identity.retained_object = Some(fingerprint(node));
        }
        return;
    }
    for child in &mut node.children {
        stamp_documents(child);
    }
}

pub(crate) fn confirm_document(
    root: &AccessibilityNode,
    document: &RefEntry,
    target: &RefEntry,
) -> Result<(), AdapterError> {
    fn docs<'a>(node: &'a AccessibilityNode, found: &mut Vec<&'a AccessibilityNode>) {
        if web_document(node) {
            found.push(node);
            return;
        }
        for child in &node.children {
            docs(child, found);
        }
    }
    fn matches(node: &AccessibilityNode, entry: &RefEntry, instance: &str) -> usize {
        usize::from(
            node.identity.retained_object.as_deref() == Some(instance)
                && node.role == entry.identity.role
                && node.identity.name == entry.identity.name,
        ) + node
            .children
            .iter()
            .map(|c| matches(c, entry, instance))
            .sum::<usize>()
    }
    let fail = || {
        AdapterError::stale_ref_because(
            "The captured form, choice or document changed; inspect it before acting",
        )
    };
    let mut found = Vec::new();
    docs(root, &mut found);
    let [doc] = found.as_slice() else {
        return Err(fail());
    };
    let instance = target
        .identity
        .retained_object
        .as_deref()
        .filter(|s| s.starts_with("choice-instance:"))
        .ok_or_else(fail)?;
    if document.identity.role != "document"
        || document.identity.value != doc.identity.value
        || document.identity.retained_object.as_deref() != Some(&fingerprint(doc))
        || matches(doc, target, instance) != 1
    {
        return Err(fail());
    }
    Ok(())
}

pub struct ChoiceTarget<'a> {
    pub control: &'a str,
    pub tab: &'a str,
    pub document: &'a str,
}

pub fn execute(
    choice: ChoiceTarget<'_>,
    action: Action,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    if context.is_headed() {
        return Err(AppError::invalid_input(
            "A page choice requires semantic delivery",
        ));
    }
    let ChoiceTarget {
        control: target,
        tab,
        document,
    } = choice;
    let parse = crate::refs::ref_token::resolve_ref_target;
    let snapshot = parse(target)?.0;
    if parse(tab)?.0 != snapshot || parse(document)?.0 != snapshot {
        return Err(AppError::invalid_input(
            "Capture the tab, document and choice together",
        ));
    }
    let tab = load_ref_entry(tab, context)?;
    let doc = load_ref_entry(document, context)?;
    let args = RefArgs {
        ref_id: target.to_string(),
        timeout_ms: None,
    };
    let by_viewport = matches!(action, Action::Scroll(_, _));
    let mut request = context.request_base(action);
    request.scroll_by_viewport = by_viewport;
    execute_ref_action_dispatching(args, adapter, request, context, |target, request, lease| {
        crate::ref_action::dispatch_resolved_landing(
            target,
            request,
            lease,
            Some((&tab, Some(&doc))),
        )
        .map(|(result, _)| result)
    })
}

#[cfg(test)]
#[path = "page_option_tests.rs"]
mod tests;
