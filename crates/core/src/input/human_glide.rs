use super::human_input::HumanInput;
use super::human_path::{PressTiming, plan_pointer_path, plan_press};
use crate::{AdapterError, InteractionLease, Point, adapter::PlatformAdapter};

/// Moves the real cursor to `to` along a human-like path and returns how to
/// press once it arrives.
pub(crate) fn glide(
    adapter: &dyn PlatformAdapter,
    to: &Point,
    human: HumanInput,
    window: Option<&str>,
    lease: &InteractionLease,
) -> Result<PressTiming, AdapterError> {
    let mut rng = human.rng();
    let from = adapter.cursor_position()?;
    let path = plan_pointer_path(&from, to, human.pace, &mut rng);
    adapter.pointer_path(&path, window, lease)?;
    Ok(plan_press(human.pace, &mut rng))
}
