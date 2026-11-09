use crate::system::capture::png_codec::decode_png_to_bgra;
use crate::system::capture::screenshot::capture_window;
use crate::system::{
    display::scale_for_bounds,
    window::{window_ops::parse_handle, window_resolve::resolve_window_strict},
};
use crate::tree::hit_test::corroborate::window_from_point_root;
use agent_desktop_core::{
    AdapterError, Deadline, DragParams, ErrorCode, OperationReport, Point, Rect,
    commands::drag::frame::WindowFrame,
};

const PATCH_RADIUS: u32 = 24;
const PATCH_TOLERANCE: f64 = 10.0;

fn reject(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::StaleRef, message)
        .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

/// Finds the window rectangle the captured image covers. `PrintWindow` uses the
/// outer rectangle and Windows Graphics Capture can omit the invisible resize
/// borders, so the origin comes from whichever matches the captured size.
fn frame_origin(frame: &WindowFrame, deadline: Deadline) -> Result<Rect, AdapterError> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
    let window = resolve_window_strict(&frame.window, deadline)?;
    if window.title != frame.window.title
        || window.state.visible != Some(true)
        || window.state.minimized == Some(true)
    {
        return Err(reject(
            "Captured window is hidden, minimized or its title changed",
        ));
    }
    let bounds = window
        .bounds
        .ok_or_else(|| reject("Window has no live bounds"))?;
    if !frame
        .window
        .bounds
        .is_some_and(|original| original.width == bounds.width && original.height == bounds.height)
    {
        return Err(reject("Window size changed; capture a new frame"));
    }
    if scale_for_bounds(Some(bounds), deadline)? != frame.scale {
        return Err(reject("Window display scale changed; capture a new frame"));
    }
    let fits = |r: Rect| r.width == f64::from(frame.width) && r.height == f64::from(frame.height);
    let mut dwm = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            parse_handle(&window.id),
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut dwm as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        )
    } == 0;
    let visible = crate::system::runtime::win_rect::rect_of(&dwm);
    match (fits(bounds), ok && fits(visible)) {
        (true, true) if bounds != visible => Err(reject("Window frame origin is ambiguous")),
        (true, _) => Ok(bounds),
        (false, true) => Ok(visible),
        _ => Err(reject(
            "Window size changed or capture bounds cannot be mapped; capture a new frame",
        )),
    }
}

/// Converts a point in the captured image to the screen, refusing when the
/// window changed or something else now covers that point.
pub(crate) fn screen_point(
    frame: &WindowFrame,
    local: &Point,
    deadline: Deadline,
) -> Result<Point, AdapterError> {
    let origin = frame_origin(frame, deadline)?;
    let point = Point {
        x: origin.x + local.x,
        y: origin.y + local.y,
    };
    if window_from_point_root(&point) != Some(parse_handle(&frame.window.id) as isize) {
        return Err(reject("Another window covers this point"));
    }
    Ok(point)
}

/// Compares the picture around `local` with the same pixels in a fresh capture.
pub(crate) fn patch_matches(
    frame: &WindowFrame,
    image: &[u8],
    local: &Point,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let (saved, saved_width, saved_height) = decode_png_to_bgra(image, deadline)?;
    let live = capture_window(&frame.window, deadline)?;
    let (pixels, live_width, live_height) = decode_png_to_bgra(&live.data, deadline)?;
    if (live_width, live_height) != (frame.width, frame.height) {
        return Ok(false);
    }
    let [left, top, ..] = frame.region.unwrap_or([0, 0, frame.width, frame.height]);
    Ok(same_picture(
        Patch {
            pixels: &saved,
            width: saved_width,
            height: saved_height,
            offset: (left, top),
        },
        Patch {
            pixels: &pixels,
            width: live_width,
            height: live_height,
            offset: (0, 0),
        },
        (local.x as u32, local.y as u32),
    ))
}

fn same_picture(saved: Patch<'_>, live: Patch<'_>, centre: (u32, u32)) -> bool {
    patch_difference(saved, live, centre) <= PATCH_TOLERANCE
}

struct Patch<'a> {
    pixels: &'a [u8],
    width: u32,
    height: u32,
    offset: (u32, u32),
}

impl Patch<'_> {
    fn colour(&self, x: u32, y: u32) -> Option<[u8; 3]> {
        let (x, y) = (x.checked_sub(self.offset.0)?, y.checked_sub(self.offset.1)?);
        if x >= self.width || y >= self.height {
            return None;
        }
        let start = (y as usize * self.width as usize + x as usize) * 4;
        let pixel = self.pixels.get(start..start + 3)?;
        Some([pixel[0], pixel[1], pixel[2]])
    }
}

/// The mean per-channel difference over the square around `centre`, where both
/// images have pixels. No overlap counts as completely different.
fn patch_difference(saved: Patch<'_>, live: Patch<'_>, centre: (u32, u32)) -> f64 {
    let (mut total, mut samples) = (0u64, 0u64);
    for y in centre.1.saturating_sub(PATCH_RADIUS)..=centre.1 + PATCH_RADIUS {
        for x in centre.0.saturating_sub(PATCH_RADIUS)..=centre.0 + PATCH_RADIUS {
            let (Some(old), Some(new)) = (saved.colour(x, y), live.colour(x, y)) else {
                continue;
            };
            total += old
                .iter()
                .zip(new)
                .map(|(a, b)| u64::from(a.abs_diff(b)))
                .sum::<u64>();
            samples += 3;
        }
    }
    if samples == 0 {
        return f64::MAX;
    }
    total as f64 / samples as f64
}

pub(crate) fn drag(
    mut params: DragParams,
    frames: [&WindowFrame; 2],
    deadline: Deadline,
) -> Result<OperationReport, AdapterError> {
    let rects = [
        frame_origin(frames[0], deadline)?,
        frame_origin(frames[1], deadline)?,
    ];
    params.from = Point {
        x: rects[0].x + params.from.x,
        y: rects[0].y + params.from.y,
    };
    params.to = Point {
        x: rects[1].x + params.to.x,
        y: rects[1].y + params.to.y,
    };
    let points = [params.from.clone(), params.to.clone()];
    let check = || {
        for i in 0..2 {
            if rects[i] != frame_origin(frames[i], deadline)? {
                return Err(reject("A window moved during the gesture"));
            }
            if window_from_point_root(&points[i])
                != Some(parse_handle(&frames[i].window.id) as isize)
            {
                return Err(reject(
                    "Another window covers the source or destination point",
                ));
            }
        }
        Ok(())
    };
    let report = OperationReport::drag_dispatched(&params);
    super::drag::synthesize_checked(params, deadline, check)?;
    Ok(report)
}

#[cfg(test)]
#[path = "drag_frame_tests.rs"]
mod tests;
