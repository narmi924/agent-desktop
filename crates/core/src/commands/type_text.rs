use crate::{
    AppError,
    actions::action::Action,
    adapter::PlatformAdapter,
    commands::helpers::{RefArgs, execute_ref_action_with_context},
    context::CommandContext,
};
use serde_json::Value;

const MAX_TEXT_LEN: usize = 10_000;
const TYPING_BUDGET_PER_CHAR_MS: u64 = 30;
const MAX_INTERVAL_MS: u64 = 2_000;

/// The budget in milliseconds for typing `text` when the caller names none:
/// the standard operation budget plus a fixed allowance for each character,
/// so a long payload is not cut off part way through by a budget sized for a
/// single click.
pub fn default_timeout_ms(text: &str) -> u64 {
    let characters = u64::try_from(text.chars().count()).unwrap_or(u64::MAX);
    crate::DEFAULT_OPERATION_TIMEOUT_MS
        .saturating_add(characters.saturating_mul(TYPING_BUDGET_PER_CHAR_MS))
}

/// The whole-command budget for `type --interval-ms`: the time the keystrokes
/// are spread over, plus each keystroke's own budget when the caller names one,
/// or the default budget for the text otherwise. A per-keystroke budget of `0`
/// means each keystroke tries once without waiting, under the default budget.
pub fn interval_budget_ms(text: &str, interval_ms: u64, per_keystroke_ms: Option<u64>) -> u64 {
    let per_keystroke_ms = per_keystroke_ms.filter(|per_keystroke_ms| *per_keystroke_ms > 0);
    let keystrokes =
        u64::try_from(super::type_text_interval::keystroke_units(text).len()).unwrap_or(u64::MAX);
    let spread = keystrokes.saturating_mul(interval_ms);
    match per_keystroke_ms {
        Some(per_keystroke_ms) => {
            spread.saturating_add(keystrokes.saturating_mul(per_keystroke_ms))
        }
        None => spread.saturating_add(default_timeout_ms(text)),
    }
}

pub struct TypeArgs {
    pub ref_id: String,
    pub text: String,
    pub timeout_ms: Option<u64>,
    /// Types one keystroke unit per interval instead of inserting the text at once.
    pub interval_ms: Option<u64>,
}

pub fn execute(
    args: TypeArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    execute_with_tab(args, None, adapter, context)
}

#[derive(Clone, Copy, Default)]
pub struct PageTypingMode {
    pub multiline: bool,
    pub replace: bool,
}

/// Physical typing needs keyboard focus on the target, so a headed run focuses
/// a field that was not focused when it was captured.
fn focus_when_unfocused(
    ref_id: &str,
    tab: Option<&crate::RefEntry>,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<(), AppError> {
    if !context.is_headed() {
        return Ok(());
    }
    let entry = super::helpers::load_ref_entry(ref_id, context)?;
    let capabilities = &entry.capabilities;
    let already_focused = capabilities.states.iter().any(|state| state == "focused");
    let can_focus = capabilities
        .available_actions
        .iter()
        .any(|action| action == "SetFocus");
    if already_focused || !can_focus {
        return Ok(());
    }
    let target = RefArgs {
        ref_id: ref_id.to_owned(),
        timeout_ms: None,
    };
    let request = context.request_base(Action::SetFocus);
    match tab {
        Some(tab) => {
            super::helpers::selected_tab::dispatch_in_tab(target, adapter, request, context, tab)?
        }
        None => execute_ref_action_with_context(target, adapter, request, context)?,
    };
    Ok(())
}

pub fn execute_with_tab(
    args: TypeArgs,
    binding: Option<(&str, PageTypingMode)>,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    if binding.is_some()
        && (args.interval_ms.is_none() || !context.is_headed() || args.text.is_empty())
    {
        return Err(AppError::invalid_input(
            "Typing in a selected tab requires text, --headed and --interval-ms",
        ));
    }
    if args.text.len() > MAX_TEXT_LEN {
        return Err(AppError::invalid_input(format!(
            "Text exceeds maximum length of {MAX_TEXT_LEN} characters"
        )));
    }

    let paced_ms = args.interval_ms.or(context.human().map(|_| 1));
    if let Some(interval_ms) = paced_ms {
        if !(1..=MAX_INTERVAL_MS).contains(&interval_ms) {
            return Err(AppError::invalid_input(format!(
                "interval_ms must be between 1 and {MAX_INTERVAL_MS}"
            )));
        }
        if !args.text.is_empty() {
            let mode = binding.map(|(_, mode)| mode).unwrap_or_default();
            let multiline = mode.multiline;
            if binding.is_some()
                && (args.text.contains('\t') || (!multiline && args.text.contains(['\r', '\n'])))
            {
                return Err(AppError::invalid_input(
                    "Use spaces for indentation and a multiline entry mode for line breaks",
                ));
            }
            let tab = binding
                .map(|(id, _)| id)
                .map(|id| super::helpers::selected_tab::load_tab(&args.ref_id, id, context))
                .transpose()?;
            focus_when_unfocused(&args.ref_id, tab.as_ref(), adapter, context)?;
            return super::type_text_interval::execute(
                args,
                interval_ms,
                adapter,
                context,
                tab.as_ref().map(|tab| (tab, mode)),
            );
        }
    }
    if !args.text.is_empty() {
        focus_when_unfocused(&args.ref_id, None, adapter, context)?;
    }
    let request = context.request_base(Action::TypeText(args.text));
    execute_ref_action_with_context(
        RefArgs {
            ref_id: args.ref_id,
            timeout_ms: args.timeout_ms,
        },
        adapter,
        request,
        context,
    )
}

#[cfg(test)]
#[path = "type_text_tests.rs"]
mod tests;
