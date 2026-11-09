use super::{
    DragArgs, operation_response, point_deadline, require_cursor_policy, require_pointer_capability,
};
pub use crate::adapter::input::WindowFrame;
use crate::{AppError, DragParams, Point, adapter::PlatformAdapter, context::CommandContext};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

const FRAME_KEYWORD: &[u8] = b"agent-desktop-frame\0";
const PNG_SIGNATURE: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10];
const FRAME_CHUNK_OFFSET: usize = 33;
const MAX_FRAME_IMAGE_BYTES: u64 = 96 * 1024 * 1024;

fn invalid_image() -> AppError {
    AppError::invalid_input("Use an unedited PNG produced by the companion's view command")
}

pub(crate) fn read_frame_image(path: &std::path::Path) -> Result<Vec<u8>, AppError> {
    let size = std::fs::metadata(path).map_err(|_| invalid_image())?.len();
    if size > MAX_FRAME_IMAGE_BYTES {
        return Err(invalid_image());
    }
    std::fs::read(path).map_err(|_| invalid_image())
}

/// Reads the window identity the capture stored right after the PNG header.
pub(crate) fn frame_from_image(png: &[u8]) -> Result<WindowFrame, AppError> {
    let header = FRAME_CHUNK_OFFSET + 8;
    if png.len() < header
        || !png.starts_with(PNG_SIGNATURE)
        || &png[FRAME_CHUNK_OFFSET + 4..header] != b"tEXt"
    {
        return Err(invalid_image());
    }
    let mut size = [0u8; 4];
    size.copy_from_slice(&png[FRAME_CHUNK_OFFSET..FRAME_CHUNK_OFFSET + 4]);
    let size = u32::from_be_bytes(size) as usize;
    let body = png.get(header..header + size).ok_or_else(invalid_image)?;
    let token = body.strip_prefix(FRAME_KEYWORD).ok_or_else(invalid_image)?;
    decode(std::str::from_utf8(token).map_err(|_| invalid_image())?)
}

pub(crate) fn image_point(frame: &WindowFrame, x: f64, y: f64) -> Result<Point, AppError> {
    local_point(
        frame,
        &super::DragEndpoint {
            ref_id: None,
            xy: Some((x, y)),
        },
    )
}

/// Accepts either a frame token or the path of a captured image. An image also
/// lets the drag confirm the picture still matches before the button goes down.
fn load_frame(source: &str) -> Result<(WindowFrame, Option<Vec<u8>>), AppError> {
    let path = std::path::Path::new(source);
    if source.len() < 1024 && path.is_file() {
        let image = read_frame_image(path)?;
        return Ok((frame_from_image(&image)?, Some(image)));
    }
    Ok((decode(source)?, None))
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
    let (from, from_image) = load_frame(source)?;
    let (to, to_image) = load_frame(dest)?;
    let deadline = point_deadline(args.timeout_ms)?;
    let params = DragParams {
        from: local_point(&from, &args.from)?,
        to: local_point(&to, &args.to)?,
        duration_ms: args.duration_ms,
        drop_delay_ms: args.drop_delay_ms,
    };
    params.validate(deadline)?;
    let lease = adapter.acquire_interaction_lease(deadline)?;
    for (frame, image, point) in [
        (&from, &from_image, &params.from),
        (&to, &to_image, &params.to),
    ] {
        if let Some(image) = image
            && !adapter.frame_patch_matches(frame, image, point, deadline)?
        {
            return Err(crate::AdapterError::stale_ref_because(
                "The picture around a drag point changed since the image was captured",
            )
            .with_disposition(crate::DeliverySemantics::not_delivered())
            .into());
        }
    }
    operation_response(
        &adapter.drag_in_frames(params, [&from, &to], &lease)?,
        json!({"source_window":from.window.id,"destination_window":to.window.id}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_with_chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(&[0, 0, 0, 13]);
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0; 13]);
        png.extend_from_slice(&[0; 4]);
        png.extend_from_slice(&(body.len() as u32).to_be_bytes());
        png.extend_from_slice(kind);
        png.extend_from_slice(body);
        png.extend_from_slice(&[0; 4]);
        png
    }

    fn token() -> String {
        URL_SAFE_NO_PAD.encode(
            json!({
                "window":{"id":"w-1","title":"t","app_name":"a","pid":1,"process_instance":"p","is_focused":false},
                "width":10,"height":10,"scale":1.0
            })
            .to_string(),
        )
    }

    #[test]
    fn a_captured_image_carries_its_window() {
        let mut body = FRAME_KEYWORD.to_vec();
        body.extend_from_slice(token().as_bytes());
        let frame = frame_from_image(&png_with_chunk(b"tEXt", &body)).unwrap();
        assert_eq!(frame.window.id, "w-1");
    }

    #[test]
    fn an_ordinary_png_is_refused() {
        assert!(frame_from_image(&png_with_chunk(b"IDAT", b"pixels")).is_err());
        assert!(frame_from_image(&png_with_chunk(b"tEXt", b"Comment\0hello")).is_err());
    }

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
