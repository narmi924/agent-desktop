use crate::commands::{helpers, operation_response::operation_response, point_resolve};
use crate::ref_action::{
    ref_action_context::RefActionContext, ref_action_wait_context::RefActionWaitContext,
    selected_tab,
};
use crate::{AdapterError, AppError, CommandContext, MouseEvent, MouseEventKind, PlatformAdapter};
use serde_json::{Value, json};

pub struct PagePointer<'a> {
    pub tab: &'a str,
    pub document: &'a str,
    pub receiver: Option<&'a str>,
}

pub fn execute(
    page: PagePointer<'_>,
    mut event: MouseEvent,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    point_resolve::require_cursor_policy(context, "page pointer input")?;
    point_resolve::require_pointer_capability(adapter)?;
    event.point.validate()?;
    if matches!(event.kind, MouseEventKind::Click { .. }) && page.receiver.is_none() {
        return Err(AppError::invalid_input(
            "Capture a receiver before clicking a page control",
        ));
    }
    if let MouseEventKind::Click { count } = event.kind {
        crate::validate_mouse_click_count(count)?;
    }
    let tab = helpers::selected_tab::load_tab(page.document, page.tab, context)?;
    let doc = helpers::load_ref_entry(page.document, context)?;
    let receiver = page
        .receiver
        .map(|id| helpers::selected_tab::load_tab(page.tab, id, context))
        .transpose()?;
    let lease = helpers::acquire_interaction_lease(adapter)?;
    let deadline = lease.deadline();
    let make_target = |entry, ref_id| {
        RefActionContext::new(
            RefActionWaitContext {
                adapter,
                entry,
                ref_id,
                context,
            },
            deadline,
        )
    };
    let page_bounds = |point: &crate::Point| -> Result<_, AdapterError> {
        let tree = selected_tab::observe(&tab, &make_target(&doc, page.document), &lease)?;
        if !tree.is_exhaustive() {
            return Err(AdapterError::stale_ref_because("The page is incomplete"));
        }
        let root = tree.into_accessibility_tree()?;
        let live = crate::refs::page_capture::confirm_page_capture(&root, &doc, receiver.as_ref())?;
        live.presentation
            .bounds
            .filter(|r| {
                point.x >= r.x
                    && point.x < r.x + r.width
                    && point.y >= r.y
                    && point.y < r.y + r.height
            })
            .ok_or_else(|| {
                AdapterError::stale_ref_because("The point is outside the captured document")
            })
    };
    let view = page_bounds(&event.point)?;
    let window = doc
        .source
        .source_window_id
        .as_deref()
        .ok_or_else(|| AppError::invalid_input("Expected a browser window"))?;
    let mut receiver_handle = None;
    if let (Some(entry), Some(id)) = (&receiver, page.receiver) {
        let handle = selected_tab::resolve_choice(&make_target(entry, id))?;
        let mut hit = adapter.hit_test(&handle, event.point.clone(), deadline)?;
        if !matches!(event.kind, MouseEventKind::Wheel { .. })
            && !matches!(hit, crate::adapter::hit_test::HitTestResult::ReachesTarget)
            && let Some(bounds) = adapter.get_element_bounds(&handle, deadline)?
        {
            for candidate in crate::actionability::candidate_points(bounds) {
                if candidate.x < view.x
                    || candidate.x >= view.x + view.width
                    || candidate.y < view.y
                    || candidate.y >= view.y + view.height
                {
                    continue;
                }
                hit = adapter.hit_test(&handle, candidate.clone(), deadline)?;
                if matches!(hit, crate::adapter::hit_test::HitTestResult::ReachesTarget) {
                    event.point = candidate;
                    break;
                }
            }
        }
        let miss = |hit| {
            AdapterError::stale_ref_because("The visible point does not reach the named control")
                .with_details(json!({"kind":"receiver_miss","hit":hit}))
                .with_disposition(crate::DeliverySemantics::not_delivered())
        };
        if !matches!(hit, crate::adapter::hit_test::HitTestResult::ReachesTarget) {
            return Err(miss(hit).into());
        }
        receiver_handle = Some(handle);
    }
    if !matches!(event.kind, MouseEventKind::Move) {
        adapter.pointer_in_window(
            MouseEvent {
                kind: MouseEventKind::Move,
                ..event.clone()
            },
            window,
            &lease,
        )?;
        // A hover can open a popup or replace the document before the button or wheel fires.
        page_bounds(&event.point)?;
        if let Some(handle) = receiver_handle {
            let hit = adapter.hit_test(&handle, event.point.clone(), deadline)?;
            if !matches!(hit, crate::adapter::hit_test::HitTestResult::ReachesTarget) {
                return Err(AdapterError::stale_ref_because(
                    "The cursor no longer reaches the captured receiver",
                )
                .with_disposition(crate::DeliverySemantics::not_delivered())
                .into());
            }
        }
    }
    let coordinates = json!({"x":event.point.x,"y":event.point.y});
    operation_response(
        &adapter.pointer_in_window(event, window, &lease)?,
        coordinates,
    )
}
