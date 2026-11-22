use crate::{AccessibilityNode, AdapterError, RefEntry};
use std::hash::{DefaultHasher, Hash, Hasher};

fn web_document(node: &AccessibilityNode) -> bool {
    node.role == "document"
        && node.identity.value.as_deref().is_some_and(|s| {
            s.starts_with("http://") || s.starts_with("https://") || s.starts_with("file:///")
        })
}

/// Two hashes of a page. The first covers every node's text, so it changes
/// when a label moves or a clock ticks. The second covers only the controls
/// and the shape of the tree, so text that is not a control may change under
/// it. A capture is confirmed by the first, or by the second when no other
/// control could be mistaken for the target.
pub(crate) fn fingerprint(node: &AccessibilityNode) -> String {
    format!(
        "page-shape:{:016x}:{:016x}",
        shape_hash(node, true),
        shape_hash(node, false)
    )
}

fn shape_hash(node: &AccessibilityNode, every_text: bool) -> u64 {
    fn visit(node: &AccessibilityNode, every_text: bool, hash: &mut DefaultHasher) {
        node.role.hash(hash);
        if every_text || node.role == "document" || super::ref_alloc::is_ref_able(node) {
            node.identity.name.hash(hash);
            node.identity.value.hash(hash);
            node.identity.description.hash(hash);
        }
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
            visit(child, every_text, hash);
        }
    }
    let mut hash = DefaultHasher::new();
    visit(node, every_text, &mut hash);
    hash.finish()
}

/// The part of a fingerprint that covers controls and shape only.
fn controls_part(fingerprint: &str) -> Option<&str> {
    let mut parts = fingerprint.strip_prefix("page-shape:")?.split(':');
    parts.next()?;
    parts.next()
}

/// How many nodes of the page look like `target`: same role and same name.
fn look_alikes(node: &AccessibilityNode, target: &RefEntry) -> usize {
    usize::from(node.role == target.identity.role && node.identity.name == target.identity.name)
        + node
            .children
            .iter()
            .map(|child| look_alikes(child, target))
            .sum::<usize>()
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

/// The web documents under `root`, one per page. A browser can list the page it draws twice, once under the window's
/// own child window with bounds at the window corner and once inside its view. Documents with the same title and
/// address are one page: the copy that `holds` the target is used, otherwise the copy deepest in the tree, whose
/// bounds are where the page is drawn.
fn pages<'a>(
    root: &'a AccessibilityNode,
    holds: &dyn Fn(&AccessibilityNode) -> bool,
) -> Vec<&'a AccessibilityNode> {
    fn docs<'a>(
        node: &'a AccessibilityNode,
        depth: usize,
        found: &mut Vec<(usize, &'a AccessibilityNode)>,
    ) {
        if web_document(node) {
            found.push((depth, node));
            return;
        }
        for child in &node.children {
            docs(child, depth + 1, found);
        }
    }
    let mut found = Vec::new();
    docs(root, 0, &mut found);
    let mut copies: Vec<Vec<(usize, &AccessibilityNode)>> = Vec::new();
    for entry in found {
        let same_page = |group: &&mut Vec<(usize, &AccessibilityNode)>| {
            group.first().is_some_and(|(_, first)| {
                first.identity.name == entry.1.identity.name
                    && first.identity.value == entry.1.identity.value
            })
        };
        match copies.iter_mut().find(same_page) {
            Some(group) => group.push(entry),
            None => copies.push(vec![entry]),
        }
    }
    copies
        .iter()
        .filter_map(|group| {
            group
                .iter()
                .filter(|(_, node)| holds(node))
                .max_by_key(|(depth, _)| *depth)
                .or_else(|| group.iter().max_by_key(|(depth, _)| *depth))
                .map(|(_, node)| *node)
        })
        .collect()
}

pub(crate) fn confirm_page_capture<'a>(
    root: &'a AccessibilityNode,
    document: &RefEntry,
    target: Option<&RefEntry>,
) -> Result<&'a AccessibilityNode, AdapterError> {
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
    let instance = match target {
        Some(target) => Some(
            target
                .identity
                .retained_object
                .as_deref()
                .filter(|s| s.starts_with("choice-instance:"))
                .ok_or_else(fail)?,
        ),
        None => None,
    };
    let holds = |node: &AccessibilityNode| match (target, instance) {
        (Some(target), Some(instance)) => matches(node, target, instance) == 1,
        _ => false,
    };
    let found = pages(root, &holds);
    let [doc] = found.as_slice() else {
        return Err(fail());
    };
    if let (Some(target), Some(instance)) = (target, instance) {
        if matches(doc, target, instance) != 1 {
            return Err(fail());
        }
    }
    if document.identity.role != "document" || document.identity.value != doc.identity.value {
        return Err(fail());
    }
    let live = fingerprint(doc);
    let saved = document.identity.retained_object.as_deref();
    let unchanged = saved == Some(live.as_str());
    let only_text_changed = saved.and_then(controls_part) == controls_part(&live)
        && controls_part(&live).is_some()
        && target.is_none_or(|target| look_alikes(doc, target) == 1);
    if !unchanged && !only_text_changed {
        return Err(fail());
    }
    Ok(doc)
}

#[cfg(test)]
#[path = "page_capture_tests.rs"]
mod tests;
