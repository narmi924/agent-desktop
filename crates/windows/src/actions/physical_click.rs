//! Physical click legs for `DoubleClick`, `TripleClick`, and `RightClick`:
//! headed policy, bounds midpoint, window-foreground verification,
//! elevation gate, then `SendInput` mouse synthesis.

use agent_desktop_core::{
    ActionStep, AdapterError, Deadline, HumanInput, InteractionPolicy, MouseButton, MouseEvent,
    MouseEventKind, Point, StepMechanism, plan_pointer_path, plan_press,
};

use crate::actions::physical_target::{
    delivery_point, ensure_click_delivery_ready, ensure_headed_click_policy,
    focus_lost_before_delivery, read_click_bounds,
};
use crate::input::mouse::synthesize_mouse;
use crate::tree::element::UIAElement;

const CLICK_LABEL: &str = "SendInput.click";

/// What click to perform — shared by the physical click legs and the
/// `click_from_gate` seam, so neither exceeds the 5-parameter cap.
pub(crate) struct ClickSpec {
    pub(crate) button: MouseButton,
    pub(crate) count: u32,
    pub(crate) human: Option<HumanInput>,
}

/// Preflight-established delivery gate: the target's live bounds and
/// whether its window was confirmed foreground before physical input
/// commits.
pub(crate) struct ClickGate {
    pub(crate) bounds: agent_desktop_core::Rect,
    pub(crate) foreground_ready: bool,
}

pub(crate) fn double_click_steps(
    element: &UIAElement,
    policy: InteractionPolicy,
    deadline: Deadline,
    verified_point: Option<Point>,
    human: Option<HumanInput>,
) -> Result<Vec<ActionStep>, AdapterError> {
    physical_click_steps(
        element,
        ClickSpec {
            button: MouseButton::Left,
            count: 2,
            human,
        },
        policy,
        deadline,
        verified_point.as_ref(),
    )
}

pub(crate) fn triple_click_steps(
    element: &UIAElement,
    policy: InteractionPolicy,
    deadline: Deadline,
    verified_point: Option<Point>,
    human: Option<HumanInput>,
) -> Result<Vec<ActionStep>, AdapterError> {
    physical_click_steps(
        element,
        ClickSpec {
            button: MouseButton::Left,
            count: 3,
            human,
        },
        policy,
        deadline,
        verified_point.as_ref(),
    )
}

pub(crate) fn right_click_steps(
    element: &UIAElement,
    policy: InteractionPolicy,
    deadline: Deadline,
    verified_point: Option<Point>,
    human: Option<HumanInput>,
) -> Result<Vec<ActionStep>, AdapterError> {
    physical_click_steps(
        element,
        ClickSpec {
            button: MouseButton::Right,
            count: 1,
            human,
        },
        policy,
        deadline,
        verified_point.as_ref(),
    )
}

pub(crate) fn physical_click_steps(
    element: &UIAElement,
    spec: ClickSpec,
    policy: InteractionPolicy,
    deadline: Deadline,
    verified_point: Option<&Point>,
) -> Result<Vec<ActionStep>, AdapterError> {
    ensure_headed_click_policy(policy)?;
    deadline.ensure_remaining()?;
    let foreground_ready = ensure_click_delivery_ready(element, deadline)?;
    let bounds = read_click_bounds(element)?;
    click_from_gate(
        ClickGate {
            bounds,
            foreground_ready,
        },
        verified_point,
        spec,
        deadline,
    )
    .map(|step| vec![step])
}

fn glide_and_click(
    event: MouseEvent,
    human: HumanInput,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let mut rng = human.rng();
    let from = crate::input::page_pointer::position().unwrap_or_else(|| event.point.clone());
    let path = plan_pointer_path(&from, &event.point, human.pace, &mut rng);
    crate::input::human_pointer::follow(&path, None, deadline)?;
    let press = plan_press(human.pace, &mut rng);
    std::thread::sleep(std::time::Duration::from_millis(press.settle_ms));
    crate::input::mouse::synthesize_click_held(event, press.hold_ms, deadline)
}

pub(crate) fn click_from_gate(
    gate: ClickGate,
    verified_point: Option<&Point>,
    spec: ClickSpec,
    deadline: Deadline,
) -> Result<ActionStep, AdapterError> {
    if !gate.foreground_ready {
        return Err(focus_lost_before_delivery());
    }
    let point = delivery_point(gate.bounds, verified_point)?;
    point.validate()?;
    let human = spec.human;
    let event = MouseEvent {
        kind: MouseEventKind::Click { count: spec.count },
        point,
        button: spec.button,
        modifiers: Vec::new(),
    };
    match human {
        Some(human) => glide_and_click(event, human, deadline)?,
        None => synthesize_mouse(event, deadline)?,
    }
    Ok(ActionStep::succeeded(CLICK_LABEL)
        .with_mechanism(StepMechanism::PhysicalSynthetic)
        .with_verified(false))
}

#[cfg(all(test, target_os = "windows"))]
#[path = "physical_click_tests.rs"]
mod tests;
