use super::{
    DragArgs, operation_response, point_deadline, require_cursor_policy, require_pointer_capability,
};
use crate::{
    AppError, DragParams, Point, WindowInfo, adapter::PlatformAdapter, context::CommandContext,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowFrame {
    pub window: WindowInfo,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    #[serde(default)]
    pub region: Option<[u32; 4]>,
}

fn decode(token: &str) -> Result<WindowFrame, AppError> {
    let invalid = || {
        AppError::invalid_input(
            "Invalid window frame; capture the window again with the companion's view command",
        )
    };
    if token.len() > 65536 {
        return Err(invalid());
    }
    let frame: WindowFrame =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if frame.width == 0
        || frame.height == 0
        || !frame.scale.is_finite()
        || frame.scale <= 0.0
        || frame
            .window
            .process_instance
            .as_deref()
            .is_none_or(str::is_empty)
        || frame.window.id.is_empty()
    {
        return Err(invalid());
    }
    Ok(frame)
}

fn local_point(frame: &WindowFrame, endpoint: &super::DragEndpoint) -> Result<Point, AppError> {
    let Some((x, y)) = endpoint.xy else {
        return Err(AppError::invalid_input(
            "A window frame requires pixel coordinates",
        ));
    };
    let [left, top, width, height] = frame.region.unwrap_or([0, 0, frame.width, frame.height]);
    if left.checked_add(width).is_none_or(|n| n > frame.width)
        || top.checked_add(height).is_none_or(|n| n > frame.height)
        || endpoint.ref_id.is_some()
        || !x.is_finite()
        || !y.is_finite()
        || x.fract() != 0.0
        || y.fract() != 0.0
        || x < 0.0
        || y < 0.0
        || x >= width.into()
        || y >= height.into()
    {
        return Err(AppError::invalid_input(
            "Specify a point inside the captured image, not an element ref or screen coordinates",
        ));
    }
    Ok(Point {
        x: x + f64::from(left),
        y: y + f64::from(top),
    })
}

pub fn execute(
    args: DragArgs,
    source: &str,
    dest: &str,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    require_cursor_policy(context, "drag")?;
    require_pointer_capability(adapter)?;
    if context.wait_selector().is_some() {
        return Err(AppError::invalid_input(
            "Frame coordinates do not identify a UI element for a post-action wait",
        ));
    }
    let from = decode(source)?;
    let to = decode(dest)?;
    let deadline = point_deadline(args.timeout_ms)?;
    let params = DragParams {
        from: local_point(&from, &args.from)?,
        to: local_point(&to, &args.to)?,
        duration_ms: args.duration_ms,
        drop_delay_ms: args.drop_delay_ms,
    };
    params.validate(deadline)?;
    let lease = adapter.acquire_interaction_lease(deadline)?;
    operation_response(
        &adapter.drag_in_frames(params, [&from, &to], &lease)?,
        json!({"source_window":from.window.id,"destination_window":to.window.id}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_pixels_translate_to_window_pixels_and_cannot_escape_the_crop() {
        let frame: WindowFrame = serde_json::from_value(json!({
            "window":{"id":"w-42","title":"Drawing","app_name":"test","pid":42,"process_instance":"A","is_focused":false},
            "width":800,"height":600,"scale":1.75,"region":[320,150,80,60]
        })).unwrap();
        let endpoint = |x, y| super::super::DragEndpoint {
            ref_id: None,
            xy: Some((x, y)),
        };
        let p = local_point(&frame, &endpoint(10.0, 12.0)).unwrap();
        assert_eq!((p.x, p.y), (330.0, 162.0));
        assert!(local_point(&frame, &endpoint(80.0, 12.0)).is_err());
        assert!(
            local_point(
                &WindowFrame {
                    region: Some([u32::MAX, 0, 2, 2]),
                    ..frame
                },
                &endpoint(0.0, 0.0)
            )
            .is_err()
        );
    }
}
