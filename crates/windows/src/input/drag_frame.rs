use crate::system::{
    display::scale_for_bounds,
    window::{window_ops::parse_handle, window_resolve::resolve_window_strict},
};
use crate::tree::hit_test::corroborate::window_from_point_root;
use agent_desktop_core::{
    AdapterError, Deadline, DragParams, ErrorCode, OperationReport, Point, Rect,
    commands::drag::frame::WindowFrame,
};

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
