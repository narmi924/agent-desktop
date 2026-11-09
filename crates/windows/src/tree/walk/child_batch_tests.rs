use super::*;
use crate::tree::automation::{automation_client, root_from_hwnd};
use crate::tree::fixture::{HostedFixture, bootstrap};
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::{read_cached, read_live};
use crate::tree::walk::cache::build_children_cache_request;
use agent_desktop_core::Deadline;

const DEPTH: usize = 6;

fn fixture_root(fixture: &HostedFixture) -> UIAElement {
    root_from_hwnd(
        fixture.handle(),
        Deadline::standard().expect("a standard deadline"),
    )
    .expect("the fixture window resolves")
}

fn batch() -> ChildBatch {
    let client = automation_client().expect("a UIA client");
    ChildBatch::new(build_children_cache_request(&client).expect("the request builds"))
}

fn runtime_id(element: &UIAElement) -> Vec<i32> {
    element.0.get_runtime_id().expect("a runtime id")
}

fn batched_children(batch: &ChildBatch, node: &UIAElement) -> Vec<UIAElement> {
    let mut children = Vec::new();
    let mut step = batch
        .first_child(node)
        .expect("the batch reads the children, or that there are none");
    while let Ok(child) = step {
        step = batch
            .next_sibling(&child)
            .expect("a batched child knows its next sibling");
        children.push(child);
    }
    children
}

fn live_children(node: &UIAElement) -> Vec<UIAElement> {
    let walker = automation_client()
        .expect("a UIA client")
        .get_raw_view_walker()
        .expect("the raw view walker is available");
    let mut children = Vec::new();
    let mut step = walker.get_first_child(&node.0);
    while let Ok(child) = step {
        step = walker.get_next_sibling(&child);
        children.push(UIAElement::from(child));
    }
    children
}

fn assert_same_children(batch: &ChildBatch, node: &UIAElement, depth: usize) -> usize {
    let batched = batched_children(batch, node);
    let live = live_children(node);
    assert_eq!(
        batched.iter().map(runtime_id).collect::<Vec<_>>(),
        live.iter().map(runtime_id).collect::<Vec<_>>(),
        "the batch read different children, or the same children in another order, than the raw view walker"
    );
    let mut seen = batched.len();
    if depth > 0 {
        for child in &batched {
            seen += assert_same_children(batch, child, depth - 1);
        }
    }
    seen
}

#[test]
fn the_batch_reads_the_same_children_in_the_same_order_as_the_raw_view() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = fixture_root(&fixture);
    let seen = assert_same_children(&batch(), &root, DEPTH);
    assert!(seen > 1, "the fixture exposes more than one control");
}

#[test]
fn a_node_without_children_is_answered_by_the_batch_not_left_to_a_second_read() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = fixture_root(&fixture);
    let batch = batch();
    let mut pending = batched_children(&batch, &root);
    let mut leaves = 0;
    while let Some(node) = pending.pop() {
        let children = batched_children(&batch, &node);
        if children.is_empty() {
            leaves += 1;
        }
        pending.extend(children);
    }
    assert!(leaves > 0, "the fixture has controls without children");
}

#[test]
fn batched_children_carry_the_properties_the_walk_reads() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = fixture_root(&fixture);
    let children = batched_children(&batch(), &root);
    assert!(!children.is_empty(), "the fixture exposes child controls");
    for child in &children {
        let (cached, _) = read_cached(child);
        let (live, _) = read_live(child);
        for property in TreeProperty::WALK_SET {
            assert_eq!(
                cached.get(property),
                live.get(property),
                "{} disagreed between a batched child and a live read",
                property.as_str()
            );
        }
    }
}

#[test]
fn a_node_the_batch_never_read_is_left_to_the_live_walk() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = fixture_root(&fixture);
    assert!(
        batch().next_sibling(&root).is_none(),
        "a node that did not come from a batch must fall back to the live walk"
    );
}

#[test]
fn the_last_child_reports_the_end_of_its_siblings_once() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = fixture_root(&fixture);
    let batch = batch();
    let children = batched_children(&batch, &root);
    let last = children.last().expect("the fixture exposes child controls");
    assert!(
        batch.next_sibling(last).is_none(),
        "a sibling step is answered once and then forgotten, so the batch does not grow with the walk"
    );
}
