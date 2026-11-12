use crate::adapter::hit_test::HitTestResult;
use crate::commands::{helpers, operation_response::operation_response, point_resolve};
use crate::ref_action::{
    ref_action_context::RefActionContext, ref_action_wait_context::RefActionWaitContext,
    selected_tab,
};
use crate::{AdapterError, AppError, CommandContext, MouseEvent, MouseEventKind, PlatformAdapter};
use serde_json::{Value, json};

/// The part of `bounds` that lies inside `view`, when any does.
fn overlap(bounds: &crate::Rect, view: &crate::Rect) -> Option<crate::Rect> {
    let x = bounds.x.max(view.x);
    let y = bounds.y.max(view.y);
    let width = (bounds.x + bounds.width).min(view.x + view.width) - x;
    let height = (bounds.y + bounds.height).min(view.y + view.height) - y;
    (width > 0.0 && height > 0.0).then_some(crate::Rect {
        x,
        y,
        width,
        height,
    })
}

struct ReceiverProbe<'a> {
    adapter: &'a dyn PlatformAdapter,
    handle: &'a crate::NativeHandle,
    view: &'a crate::Rect,
    bounds: Option<&'a crate::Rect>,
    deadline: crate::Deadline,
}

/// Settles the point a pointer event goes to on the receiver itself: a
/// human-like landing place when the request asks for one and it reaches the
/// control, the requested point when that does, otherwise the first visible
/// candidate that does. Returns the hit at the point it settled on.
fn reach_receiver(
    probe: ReceiverProbe<'_>,
    event: &mut MouseEvent,
    context: &CommandContext,
) -> Result<HitTestResult, AdapterError> {
    let ReceiverProbe {
        adapter,
        handle,
        view,
        bounds,
        deadline,
    } = probe;
    let test = |point: &crate::Point| adapter.hit_test(handle, point.clone(), deadline);
    if let (Some(human), Some(bounds), MouseEventKind::Click { .. }) =
        (context.human(), bounds, &event.kind)
        && let Some(visible) = overlap(bounds, view)
    {
        let landing = crate::plan_landing(&visible, &mut human.rng());
        if matches!(test(&landing)?, HitTestResult::ReachesTarget) {
            event.point = landing;
            return Ok(HitTestResult::ReachesTarget);
        }
    }
    let mut hit = test(&event.point)?;
    if matches!(event.kind, MouseEventKind::Wheel { .. })
        || matches!(hit, HitTestResult::ReachesTarget)
    {
        return Ok(hit);
    }
    for candidate in bounds
        .map(|bounds| crate::actionability::candidate_points(*bounds))
        .unwrap_or_default()
    {
        if candidate.x < view.x
            || candidate.x >= view.x + view.width
            || candidate.y < view.y
            || candidate.y >= view.y + view.height
        {
            continue;
        }
        hit = test(&candidate)?;
        if matches!(hit, HitTestResult::ReachesTarget) {
            event.point = candidate;
            break;
        }
    }
    Ok(hit)
}

pub struct PagePointer<'a> {
    pub tab: &'a str,
    pub document: &'a str,
    pub receiver: Option<&'a str>,
}

/// Re-reads the captured page after the hover, because a hover can open a popup
/// or replace the document before the button or wheel fires.
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
    let lease = point_resolve::acquire_pointer_lease(adapter, context)?;
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
    let mut receiver_bounds = None;
    if let (Some(entry), Some(id)) = (&receiver, page.receiver) {
        let handle = selected_tab::resolve_choice(&make_target(entry, id))?;
        if matches!(
            event.kind,
            MouseEventKind::Click { .. } | MouseEventKind::Move
        ) {
            receiver_bounds = adapter.get_element_bounds(&handle, deadline)?;
        }
        let miss = |hit| {
            AdapterError::stale_ref_because("The visible point does not reach the named control")
                .with_details(json!({"kind":"receiver_miss","hit":hit}))
                .with_disposition(crate::DeliverySemantics::not_delivered())
        };
        let hit = reach_receiver(
            ReceiverProbe {
                adapter,
                handle: &handle,
                view: &view,
                bounds: receiver_bounds.as_ref(),
                deadline,
            },
            &mut event,
            context,
        )?;
        if !matches!(hit, HitTestResult::ReachesTarget) {
            return Err(miss(hit).into());
        }
        receiver_handle = Some(handle);
    }
    let mut hold_ms = None;
    if let Some(human) = context.human() {
        let target = crate::input::human_glide::GlideTarget {
            to: &event.point,
            width: crate::input::human_glide::target_width(receiver_bounds.as_ref()),
            window: Some(window),
        };
        let press = crate::input::human_glide::glide(adapter, target, human, &lease)?;
        std::thread::sleep(std::time::Duration::from_millis(press.settle_ms));
        hold_ms = Some(press.hold_ms);
    } else if !matches!(event.kind, MouseEventKind::Move) {
        adapter.pointer_in_window(
            MouseEvent {
                kind: MouseEventKind::Move,
                ..event.clone()
            },
            window,
            &lease,
        )?;
    }
    if !matches!(event.kind, MouseEventKind::Move) {
        page_bounds(&event.point)?;
        if let Some(handle) = receiver_handle {
            let hit = adapter.hit_test(&handle, event.point.clone(), deadline)?;
            if !matches!(hit, HitTestResult::ReachesTarget) {
                return Err(AdapterError::stale_ref_because(
                    "The cursor no longer reaches the captured receiver",
                )
                .with_disposition(crate::DeliverySemantics::not_delivered())
                .into());
            }
        }
    }
    let coordinates = json!({"x":event.point.x,"y":event.point.y});
    let report = match (context.human(), hold_ms, &event.kind) {
        (_, Some(hold_ms), MouseEventKind::Click { .. }) => {
            adapter.pointer_click_held_in_window(event, hold_ms, window, &lease)
        }
        (Some(human), _, _) => crate::input::human_wheel::roll(event, human, |notch| {
            adapter.pointer_in_window(notch, window, &lease)
        }),
        _ => adapter.pointer_in_window(event, window, &lease),
    }?;
    operation_response(&report, coordinates)
}

#[cfg(test)]
#[path = "page_pointer_tests.rs"]
mod tests;
