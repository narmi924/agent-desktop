use crate::{AccessibilityNode, AdapterError, RefEntry};
use std::hash::{DefaultHasher, Hash, Hasher};

fn web_document(node: &AccessibilityNode) -> bool {
    node.role == "document"
        && node.identity.value.as_deref().is_some_and(|s| {
            s.starts_with("http://") || s.starts_with("https://") || s.starts_with("file:///")
        })
}

pub(crate) fn fingerprint(node: &AccessibilityNode) -> String {
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
    confirm_page_capture(root, document, Some(target)).map(|_| ())
}

pub(crate) fn confirm_page_capture<'a>(
    root: &'a AccessibilityNode,
    document: &RefEntry,
    target: Option<&RefEntry>,
) -> Result<&'a AccessibilityNode, AdapterError> {
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
    if let Some(target) = target {
        let instance = target
            .identity
            .retained_object
            .as_deref()
            .filter(|s| s.starts_with("choice-instance:"))
            .ok_or_else(fail)?;
        if matches(doc, target, instance) != 1 {
            return Err(fail());
        }
    }
    if document.identity.role != "document"
        || document.identity.value != doc.identity.value
        || document.identity.retained_object.as_deref() != Some(&fingerprint(doc))
    {
        return Err(fail());
    }
    Ok(doc)
}
