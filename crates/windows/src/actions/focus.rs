//! Headed `SetFocus` with focused-element verification.
//!
//! UIA `SetFocus` moves the desktop foreground window (A3-4, A19-5), so
//! headless dispatch fails with `POLICY_DENIED`. Headed dispatch invokes
//! `set_focus` through the mutation classifier and verifies by comparing the
//! automation client's focused element to the target.

use agent_desktop_core::{
    Action, ActionResult, ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode,
    InteractionPolicy, StepMechanism, actions::action_request::ActionRequest,
};

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        Action, ActionRequest, ActionResult, ActionStep, AdapterError, Deadline, DeliverySemantics,
        ErrorCode, InteractionPolicy, StepMechanism,
    };
    use crate::actions::mutation::{classify_mutation, classify_success};
    use crate::tree::automation::{automation_client, failure_of};
    use crate::tree::element::UIAElement;

    use crate::tree::walk::walker_source::same_element;

    const SET_FOCUS_API: &str = "UIElement.SetFocus";
    const SET_FOCUS_OP: &str = "SetFocus";

    pub(crate) fn focus_element(
        element: &UIAElement,
        request: &ActionRequest,
        deadline: Deadline,
    ) -> Result<ActionResult, AdapterError> {
        if !request.policy.is_headed() {
            return Err(headless_denied(request.policy));
        }
        deadline.ensure_remaining()?;
        let delivered = invoke_focus(element)?;
        focus_from_delivery(
            request.policy,
            Ok(delivered),
            focus_matches_target(element)?,
        )
    }

    fn invoke_focus(element: &UIAElement) -> Result<bool, AdapterError> {
        match element.0.set_focus() {
            Ok(()) => classify_success(),
            Err(error) => classify_mutation(SET_FOCUS_OP, SET_FOCUS_API, &failure_of(&error)),
        }
    }

    fn focus_matches_target(element: &UIAElement) -> Result<bool, AdapterError> {
        let client = automation_client()?;
        match client.get_focused_element() {
            Ok(focused) => Ok(same_element(&client, element, &UIAElement::from(focused))),
            Err(_) => Ok(false),
        }
    }

    pub(crate) fn keyboard_focus_ready(element: &UIAElement) -> Result<bool, AdapterError> {
        if focus_matches_target(element)? {
            return Ok(true);
        }
        let active_caret = element
            .0
            .get_pattern::<uiautomation::patterns::UITextPattern>()
            .ok()
            .and_then(|pattern| pattern.get_caret_range().ok())
            .is_some_and(|(active, _)| active);
        Ok(active_caret)
    }

    pub(crate) fn controls_focused_list(
        element: &UIAElement,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        deadline.ensure_remaining()?;
        let controls = element.0.get_controller_for().unwrap_or_default();
        let client = automation_client()?;
        let (Ok(mut focused), Ok(walker)) =
            (client.get_focused_element(), client.get_raw_view_walker())
        else {
            return Ok(false);
        };
        use uiautomation::types::{ControlType, UIProperty};
        if focused.get_control_type().ok() == Some(ControlType::Edit) {
            return Ok(false);
        }
        let mut inside_list = false;
        for _ in 0..24 {
            deadline.ensure_remaining()?;
            inside_list |= focused.get_control_type().ok() == Some(ControlType::List);
            if inside_list {
                if controls
                    .iter()
                    .any(|c| client.compare_elements(c, &focused).unwrap_or(false))
                {
                    return Ok(true);
                }
                if let Ok(uiautomation::variants::Value::STRING(role)) = focused
                    .get_property_value(UIProperty::AriaRole)
                    .and_then(|v| v.get_value())
                    && role.split_whitespace().any(|role| role == "code")
                {
                    let condition = client.create_property_condition(
                        UIProperty::ControlType,
                        uiautomation::variants::Variant::from(ControlType::Edit as i32),
                        None,
                    );
                    let editors = condition.and_then(|condition| {
                        focused.find_all(uiautomation::types::TreeScope::Descendants, &condition)
                    });
                    return Ok(editors.is_ok_and(|editors| matches!(editors.as_slice(),[editor] if client.compare_elements(editor,&element.0).unwrap_or(false))));
                }
            }
            let Ok(parent) = walker.get_parent(&focused) else {
                break;
            };
            focused = parent;
        }
        Ok(false)
    }

    /// Builds the SetFocus result from a delivery/verification pair.
    ///
    /// Injected seam for unit tests that pin both compare outcomes without a
    /// live automation client.
    pub(crate) fn focus_from_delivery(
        policy: InteractionPolicy,
        delivery: Result<bool, AdapterError>,
        verified: bool,
    ) -> Result<ActionResult, AdapterError> {
        if !policy.is_headed() {
            return Err(headless_denied(policy));
        }
        let delivered = delivery?;
        if !delivered {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "SetFocus is not available on this element",
            )
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        Ok(ActionResult::from_execution(
            &Action::SetFocus,
            vec![
                ActionStep::succeeded(SET_FOCUS_API)
                    .with_mechanism(StepMechanism::SemanticApi)
                    .with_verified(verified),
            ],
        ))
    }

    pub(crate) fn headless_denied(policy: InteractionPolicy) -> AdapterError {
        AdapterError::policy_denied_for_policy(
            "SetFocus moves the desktop foreground window on Windows",
            policy,
        )
        .with_details(serde_json::json!({
            "foreground_effect": true,
            "evidence": ["A3-4", "A19-5"],
        }))
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{ActionRequest, ActionResult, AdapterError, Deadline};
    use crate::tree::element::UIAElement;

    pub(crate) fn focus_element(
        _element: &UIAElement,
        _request: &ActionRequest,
        _deadline: Deadline,
    ) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::not_supported("SetFocus"))
    }
}

pub(crate) use imp::focus_element;

#[cfg(target_os = "windows")]
pub(crate) use imp::{controls_focused_list, keyboard_focus_ready};

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::{focus_from_delivery, headless_denied};

#[cfg(all(test, target_os = "windows"))]
#[path = "focus_tests.rs"]
mod tests;
