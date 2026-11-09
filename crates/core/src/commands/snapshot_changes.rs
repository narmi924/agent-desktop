use crate::refs::refs_store::RefStore;
use crate::{AppError, CommandContext, RefEntry};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

type Key = (String, String);

/// Adds what changed since an earlier snapshot of the same window: controls
/// that appeared, disappeared, or changed value or state.
pub fn attach(mut value: Value, since: &str, context: &CommandContext) -> Result<Value, AppError> {
    let Some(current_id) = value["snapshot_id"].as_str().map(str::to_owned) else {
        return Ok(value);
    };
    let store = RefStore::for_session(context.session_id())?;
    let before = store.load_snapshot(since)?;
    let after = store.load_snapshot(&current_id)?;
    value["changes"] = compare(before.entries(), after.entries(), &current_id);
    Ok(value)
}

fn key(entry: &RefEntry) -> Key {
    (
        entry.identity.role.clone(),
        entry.identity.name.clone().unwrap_or_default(),
    )
}

fn condition(entry: &RefEntry) -> Value {
    json!({ "value": entry.identity.value, "states": entry.capabilities.states })
}

/// Refs are allocated depth-first, so their numbers give document order.
fn in_document_order<'a>(
    entries: impl Iterator<Item = (&'a str, &'a RefEntry)>,
) -> Vec<(&'a str, &'a RefEntry)> {
    let mut ordered: Vec<(&str, &RefEntry)> = entries.collect();
    ordered.sort_by_key(|(id, _)| {
        id.trim_start_matches("@e")
            .parse::<u64>()
            .unwrap_or(u64::MAX)
    });
    ordered
}

fn compare<'a>(
    before: impl Iterator<Item = (&'a str, &'a RefEntry)>,
    after: impl Iterator<Item = (&'a str, &'a RefEntry)>,
    snapshot_id: &str,
) -> Value {
    let mut old: HashMap<Key, VecDeque<&RefEntry>> = HashMap::new();
    for (_, entry) in in_document_order(before) {
        old.entry(key(entry)).or_default().push_back(entry);
    }
    let (mut added, mut changed, mut unchanged) = (Vec::new(), Vec::new(), 0usize);
    for (id, entry) in in_document_order(after) {
        let reference = format!("@{snapshot_id}:{}", id.trim_start_matches('@'));
        let summary = json!({
            "ref": reference,
            "role": entry.identity.role,
            "name": entry.identity.name,
        });
        match old.get_mut(&key(entry)).and_then(VecDeque::pop_front) {
            None => added.push(summary),
            Some(previous) if condition(previous) != condition(entry) => changed.push(json!({
                "ref": reference,
                "role": entry.identity.role,
                "name": entry.identity.name,
                "before": condition(previous),
                "after": condition(entry),
            })),
            Some(_) => unchanged += 1,
        }
    }
    let removed: Vec<Value> = old
        .into_iter()
        .flat_map(|((role, name), left)| {
            left.into_iter()
                .map(move |_| json!({ "role": role, "name": name }))
        })
        .collect();
    json!({
        "added": added,
        "removed": removed,
        "changed": changed,
        "unchanged": unchanged,
    })
}

#[cfg(test)]
#[path = "snapshot_changes_tests.rs"]
mod tests;
