use super::human_input::HumanInput;
use super::human_path::{DEFAULT_TARGET_WIDTH, PressTiming, plan_pointer_path, plan_press};
use crate::{AdapterError, InteractionLease, Point, Rect, adapter::PlatformAdapter};

/// Where a glide ends: the point, how wide the control under it is, and the
/// window that has to stay in front while the cursor travels.
pub(crate) struct GlideTarget<'a> {
    pub(crate) to: &'a Point,
    pub(crate) width: f64,
    pub(crate) window: Option<&'a str>,
}

impl<'a> GlideTarget<'a> {
    /// A bare point with nothing known about what is under it.
    pub(crate) fn point(to: &'a Point) -> Self {
        Self {
            to,
            width: DEFAULT_TARGET_WIDTH,
            window: None,
        }
    }
}

/// The width a pointer has to hit inside `bounds`: its shorter side.
pub(crate) fn target_width(bounds: Option<&Rect>) -> f64 {
    bounds.map_or(DEFAULT_TARGET_WIDTH, |bounds| {
        bounds.width.min(bounds.height)
    })
}

/// Moves the real cursor to the target along a human-like path and returns
/// how to press once it arrives.
pub(crate) fn glide(
    adapter: &dyn PlatformAdapter,
    target: GlideTarget<'_>,
    human: HumanInput,
    lease: &InteractionLease,
) -> Result<PressTiming, AdapterError> {
    let mut rng = human.rng();
    let from = adapter.cursor_position()?;
    let path = plan_pointer_path(&from, target.to, target.width, human.pace, &mut rng);
    adapter.pointer_path(&path, target.window, lease)?;
    Ok(plan_press(human.pace, &mut rng))
}
