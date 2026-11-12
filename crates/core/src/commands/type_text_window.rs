//! `type --window-id`: text for the place that holds the keyboard in a named
//! window, for interfaces that draw their own fields and expose no ref to
//! type into. The window is brought forward first, so this needs `--headed`.
//! With `--interval-ms` or `--human` the text goes one keystroke at a time;
//! nothing can be read back here, so a human pace never types a wrong key.
//! A line break is the Enter key and is only sent when the caller says Enter
//! starts a new line in this window.

use crate::{
    AdapterError, AppError, CaretPlace, DeliverySemantics, KeyCombo, TypingStep,
    adapter::PlatformAdapter, context::CommandContext, plan_typing,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const MAX_TEXT_LEN: usize = 10_000;

pub struct WindowTypeArgs {
    pub window_id: String,
    pub text: String,
    pub interval_ms: Option<u64>,
    pub multiline: bool,
    pub caret: Option<CaretPlace>,
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
    if args.text.is_empty() {
        return Err(AppError::invalid_input("type text is missing"));
    }
    if args.text.len() > MAX_TEXT_LEN {
        return Err(AppError::invalid_input(format!(
            "Text exceeds maximum length of {MAX_TEXT_LEN} characters"
        )));
    }
    if args.text.contains(['\r', '\n']) && !args.multiline {
        return Err(AppError::invalid_input_with_suggestion(
            "The text has a line break, and a typed line break is the Enter key",
            "Add --entry-mode multiline where Enter starts a new line, or type the lines one command at a time.",
        ));
    }
    let keys = planned_keys(&args, context);
    let paced = context.human().is_some() || args.interval_ms.is_some();
    let spread: u64 = keys.iter().map(|(_, after_ms)| after_ms).sum();
    let budget = super::type_text::default_timeout_ms(&args.text).saturating_add(spread);
    let deadline = crate::Deadline::from_duration(Duration::from_millis(budget))?;
    let window = crate::snapshot::resolve_window(adapter, None, Some(&args.window_id), deadline)?;
    let app = crate::system::app_lookup::resolve_app_owning(&window, adapter, deadline)?;
    let lease = adapter.acquire_interaction_lease(deadline)?;
    let live =
        crate::commands::helpers::revalidate_app_for_mutation(adapter, &app, lease.deadline())?;
    let process = crate::commands::helpers::process_identity(&live)?;
    let focused =
        crate::actions::headed_focus::focus_exact_window(&window, adapter, context, &lease)?;
    confirm_active(&focused, adapter, &lease)?;
    let policy = context.physical_input_policy();
    let started = Instant::now();
    if let Some(caret) = args.caret {
        adapter.press_key_for_app(process.clone(), &caret.key_combo(), policy, &lease)?;
    }
    let total = keys.len();
    let mut last = None;
    adapter.stop_requested();
    for (typed, (key, after_ms)) in keys.into_iter().enumerate() {
        std::thread::sleep(Duration::from_millis(after_ms));
        let sent = if adapter.stop_requested() {
            Err(stopped_by_escape())
        } else if is_line_break(&key) {
            adapter.press_key_for_app(process.clone(), &enter(), policy, &lease)
        } else {
            adapter.type_text_for_app(process.clone(), &key, policy, &lease)
        };
        let after_caret = args.caret.is_some();
        last = Some(sent.map_err(|error| partial(error, typed, total, after_caret))?);
    }
    let mut value = serde_json::to_value(last)?;
    if paced {
        value["keystrokes"] = json!(total);
        match context.human() {
            Some(human) => {
                value["human"] = json!({
                    "pace": human.pace.name(),
                    "typed_in_ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                });
            }
            None => value["interval_ms"] = json!(args.interval_ms),
        }
    }
    crate::cursor_overlay::follow_caret_after_key(adapter, context, Some(process.pid));
    value["window_id"] = Value::from(focused.id.clone());
    super::helpers::apply_scoped_post_action_wait(
        value,
        None,
        Some(args.window_id),
        adapter,
        context,
    )
}

fn enter() -> KeyCombo {
    KeyCombo {
        key: "return".into(),
        modifiers: Vec::new(),
    }
}

fn is_line_break(key: &str) -> bool {
    matches!(key, "\r" | "\n" | "\r\n")
}

/// What is sent, in order, with the pause before each: single keystrokes for
/// a paced run, otherwise each line whole with its line breaks between them.
fn planned_keys(args: &WindowTypeArgs, context: &CommandContext) -> Vec<(String, u64)> {
    let units = super::type_text_interval::keystroke_units(&args.text);
    if let Some(human) = context.human() {
        return plan_typing(&units, human.pace, &mut human.rng(), false)
            .into_iter()
            .filter_map(|step| match step {
                TypingStep::Text { text, after_ms } => Some((text, after_ms)),
                TypingStep::Backspace { .. } => None,
            })
            .collect();
    }
    if let Some(interval_ms) = args.interval_ms {
        return units
            .into_iter()
            .enumerate()
            .map(|(index, unit)| (unit, if index == 0 { 0 } else { interval_ms }))
            .collect();
    }
    let mut keys: Vec<(String, u64)> = Vec::new();
    for unit in units {
        match keys.last_mut() {
            Some((line, _)) if !is_line_break(line) && !is_line_break(&unit) => {
                line.push_str(&unit);
            }
            _ => keys.push((unit, 0)),
        }
    }
    keys
}

fn stopped_by_escape() -> AdapterError {
    AdapterError::new(crate::ErrorCode::ActionFailed, "Typing stopped by Escape")
        .with_disposition(DeliverySemantics::not_delivered())
}

/// Keys that already went out stay typed, so a later failure says how many.
/// A caret key that went out first counts as input even before the first
/// character.
fn partial(error: AdapterError, typed: usize, total: usize, after_caret: bool) -> AdapterError {
    if typed == 0 && !after_caret {
        return error;
    }
    let mut error = error;
    let mut details = error
        .details
        .take()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    details["typed_keystrokes"] = json!(typed);
    details["keystrokes"] = json!(total);
    error
        .with_details(details)
        .with_disposition(DeliverySemantics::delivered_unverified())
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
