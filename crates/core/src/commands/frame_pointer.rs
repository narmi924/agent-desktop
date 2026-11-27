use super::drag::frame::{frame_from_image, image_point, read_frame_image};
use super::operation_response::operation_response;
use super::point_resolve::{require_cursor_policy, require_pointer_capability};
use crate::{
    AdapterError, AppError, CommandContext, DeliverySemantics, MouseEvent, MouseEventKind,
    PlatformAdapter,
};
use serde_json::{Value, json};
use std::path::Path;

/// A point in a captured window image, in that image's pixels.
pub struct FramePointer<'a> {
    pub image: &'a Path,
    pub x: f64,
    pub y: f64,
}

pub(crate) fn picture_changed() -> AppError {
    AdapterError::stale_ref_because(
        "The picture around this point changed since the image was captured",
    )
    .with_disposition(DeliverySemantics::not_delivered())
    .with_suggestion("Capture the window again and choose the point on the new image")
    .into()
}

/// Sends pointer input to a point chosen on a captured image. The window must
/// still be the one captured, at the same size and scale, and the picture
/// around the point must still match what the image shows.
pub fn execute(
    target: FramePointer<'_>,
    mut event: MouseEvent,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    require_cursor_policy(context, "frame pointer input")?;
    require_pointer_capability(adapter)?;
    let image = read_frame_image(target.image)?;
    let frame = frame_from_image(&image)?;
    let local = image_point(&frame, target.x, target.y)?;
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let deadline = lease.deadline();
    event.point = adapter.frame_screen_point(&frame, &local, deadline)?;
    if !adapter.frame_patch_matches(&frame, &image, &local, deadline)? {
        return Err(picture_changed());
    }
    let click = matches!(event.kind, MouseEventKind::Click { .. });
    let point = event.point.clone();
    let report = crate::cursor_overlay::dispatch_mouse_event_with_cursor(
        adapter, context, event, click, &lease,
    )?;
    operation_response(
        &report,
        json!({"x": point.x, "y": point.y, "window": frame.window.id}),
    )
}

/// Clicks a point chosen on a captured image by posting window messages to
/// the window under it. The cursor and the foreground stay with the person,
/// so this needs no headed mode. The window and the picture around the point
/// are checked as for `execute`; whether the app acted on the click is not
/// read back.
pub fn post_click(
    target: FramePointer<'_>,
    event: MouseEvent,
    adapter: &dyn PlatformAdapter,
) -> Result<Value, AppError> {
    let MouseEventKind::Click { count } = event.kind else {
        return Err(AppError::invalid_input(
            "Only a click can be posted to a window",
        ));
    };
    crate::validate_mouse_click_count(count)?;
    if !event.modifiers.is_empty() {
        return Err(AppError::invalid_input(
            "A posted click cannot hold modifier keys; use --headed mouse-click --frame for a modified click",
        ));
    }
    let image = read_frame_image(target.image)?;
    let frame = frame_from_image(&image)?;
    let local = image_point(&frame, target.x, target.y)?;
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    if !adapter.frame_patch_matches(&frame, &image, &local, lease.deadline())? {
        return Err(picture_changed());
    }
    let report = adapter.post_click_in_frame(&frame, &local, &event, &lease)?;
    operation_response(&report, json!({"window": frame.window.id}))
}

#[cfg(test)]
#[path = "frame_pointer_tests.rs"]
mod tests;
