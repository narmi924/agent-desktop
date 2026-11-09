//! Reads all of a node's children in one round trip and remembers their order,
//! so each sibling step after the first costs nothing.

use crate::tree::automation::{ERR_NONE, UiaFailure};
use crate::tree::element::UIAElement;
use std::cell::RefCell;
use std::collections::HashMap;
use uiautomation::core::UICacheRequest;

/// UI Automation answers `GetCachedChildren` for a node without children with
/// success and a null array, which the binding reports as an error whose code
/// is `S_OK`. Any other failure leaves the node to the live walk.
const NO_CACHED_CHILDREN: i32 = 0;

pub(crate) struct ChildBatch {
    request: UICacheRequest,
    next_siblings: RefCell<HashMap<Vec<i32>, Option<UIAElement>>>,
}

impl ChildBatch {
    pub(crate) fn new(request: UICacheRequest) -> Self {
        Self {
            request,
            next_siblings: RefCell::new(HashMap::new()),
        }
    }

    /// `None` means the batch could not be read and the caller should walk live.
    pub(crate) fn first_child(&self, node: &UIAElement) -> Option<Result<UIAElement, UiaFailure>> {
        let updated = node.0.build_updated_cache(&self.request).ok()?;
        let children: Vec<UIAElement> = match updated.get_cached_children() {
            Ok(children) => children.into_iter().map(UIAElement::from).collect(),
            Err(error) if error.code() == NO_CACHED_CHILDREN => Vec::new(),
            Err(_) => return None,
        };
        let Some(first) = children.first().cloned() else {
            return Some(Err(UiaFailure::Sentinel(ERR_NONE)));
        };
        let mut next_siblings = self.next_siblings.borrow_mut();
        for (index, child) in children.iter().enumerate() {
            match child.0.get_runtime_id() {
                Ok(id) if !id.is_empty() => {
                    next_siblings.insert(id, children.get(index + 1).cloned());
                }
                _ => return None,
            }
        }
        Some(Ok(first))
    }

    /// `None` means this node did not come from a batch.
    pub(crate) fn next_sibling(&self, node: &UIAElement) -> Option<Result<UIAElement, UiaFailure>> {
        let id = node.0.get_runtime_id().ok()?;
        let next = self.next_siblings.borrow_mut().remove(&id)?;
        Some(next.ok_or(UiaFailure::Sentinel(ERR_NONE)))
    }
}

#[cfg(test)]
#[path = "child_batch_tests.rs"]
mod tests;
