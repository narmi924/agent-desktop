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
        return Err(AdapterError::stale_ref_because(
            "The picture around this point changed since the image was captured",
        )
        .with_disposition(DeliverySemantics::not_delivered())
        .with_suggestion("Capture the window again and choose the point on the new image")
        .into());
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
