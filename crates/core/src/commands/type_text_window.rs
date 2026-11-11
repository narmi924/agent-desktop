//! `type --window-id`: text for the place that holds the keyboard in a named
//! window, for interfaces that draw their own fields and expose no ref to
//! type into. The window is brought forward first, so this needs `--headed`.

use crate::{AdapterError, AppError, adapter::PlatformAdapter, context::CommandContext};
use serde_json::Value;

const MAX_TEXT_LEN: usize = 10_000;

pub struct WindowTypeArgs {
    pub window_id: String,
    pub text: String,
}

pub fn execute(
    args: WindowTypeArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    super::helpers::validate_post_action_wait(context)?;
    if !context.is_headed() {
        return Err(AppError::invalid_input_with_suggestion(
            "Typing into a window without a ref needs --headed",
            "Add --headed: the window is brought to the front and the real keyboard types into the place that has focus.",
        ));
    }
    if context.human().is_some() {
        return Err(AppError::invalid_input(
            "--human paces typing into a ref only; type into a window without it",
        ));
    }
    if args.text.is_empty() {
        return Err(AppError::invalid_input("type text is missing"));
    }
    if args.text.len() > MAX_TEXT_LEN {
        return Err(AppError::invalid_input(format!(
            "Text exceeds maximum length of {MAX_TEXT_LEN} characters"
        )));
    }
    let budget = super::type_text::default_timeout_ms(&args.text);
    let deadline = crate::Deadline::from_duration(std::time::Duration::from_millis(budget))?;
    let window = crate::snapshot::resolve_window(adapter, None, Some(&args.window_id), deadline)?;
    let app = crate::system::app_lookup::resolve_app_owning(&window, adapter, deadline)?;
    let lease = adapter.acquire_interaction_lease(deadline)?;
    let live =
        crate::commands::helpers::revalidate_app_for_mutation(adapter, &app, lease.deadline())?;
    let process = crate::commands::helpers::process_identity(&live)?;
    let focused =
        crate::actions::headed_focus::focus_exact_window(&window, adapter, context, &lease)?;
    confirm_active(&focused, adapter, &lease)?;
    let result = adapter.type_text_for_app(
        process.clone(),
        &args.text,
        context.physical_input_policy(),
        &lease,
    )?;
    crate::cursor_overlay::follow_caret_after_key(adapter, context, Some(process.pid));
    let mut value = serde_json::to_value(result)?;
    value["window_id"] = Value::from(focused.id.clone());
    super::helpers::apply_scoped_post_action_wait(
        value,
        None,
        Some(args.window_id),
        adapter,
        context,
    )
}

/// The named window, not a sibling or a menu of another application, has to
/// be the active one before a key is sent.
fn confirm_active(
    window: &crate::WindowInfo,
    adapter: &dyn PlatformAdapter,
    lease: &crate::InteractionLease,
) -> Result<(), AppError> {
    let active = adapter
        .focused_window(lease.deadline())
        .map_err(AdapterError::unsent)?;
    if active.is_some_and(|active| active.id == window.id && active.pid == window.pid) {
        return Ok(());
    }
    Err(AdapterError::stale_ref_because(
        "The named window did not become the active window, so no text was typed",
    )
    .with_suggestion(
        "Close any dialog or menu in front of it, or click into the window first, then retry",
    )
    .with_details(serde_json::json!({
        "check": "window_active",
        "physical_delivery_started": false,
        "window_id": window.id,
    }))
    .with_disposition(crate::DeliverySemantics::not_delivered())
    .into())
}

#[cfg(test)]
#[path = "type_text_window_tests.rs"]
mod tests;
