use super::{Burst, TypeArgs, burst_around, deliver, execute_landing};
use crate::{
    Action, AdapterError, AppError, CommandContext, DeliverySemantics, KeyCombo, Modifier,
    PlatformAdapter, RefEntry, commands::helpers::RefArgs,
};

fn key(name: &str, modifiers: Vec<Modifier>) -> Action {
    Action::PressKey(KeyCombo {
        key: name.into(),
        modifiers,
    })
}
fn press(
    burst: &Burst,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
    action: Action,
) -> Result<(), AppError> {
    let mut request = context.request_base(action);
    request.focused_page_typing = true;
    deliver(adapter, burst, request, crate::DEFAULT_OPERATION_TIMEOUT_MS).map(|_| ())
}

pub(super) fn start(
    args: &TypeArgs,
    tab: &RefEntry,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Burst, AppError> {
    let entry = crate::commands::helpers::load_ref_entry(&args.ref_id, context)?;
    if !matches!(
        entry.identity.role.as_str(),
        "textfield" | "textarea" | "combobox"
    ) || entry
        .capabilities
        .states
        .iter()
        .any(|s| matches!(s.as_str(), "readonly" | "disabled" | "protected"))
    {
        return Err(AppError::invalid_input(
            "Expected a writable text field for replacement",
        ));
    }
    let mut select_all = context.request_base(key("a", vec![Modifier::Ctrl]));
    select_all.focused_page_typing = true;
    let (_, handle) = execute_landing(
        RefArgs {
            ref_id: args.ref_id.clone(),
            timeout_ms: None,
        },
        adapter,
        select_all,
        context,
        Some(tab),
    )?;
    let burst = burst_around(handle, &args.ref_id, context, adapter, Some(tab))?;
    press(&burst, adapter, context, key("forwarddelete", vec![]))
        .map_err(|e| partial(e, 0, super::keystroke_units(&args.text).len()))?;
    Ok(burst)
}

/// The rest of the editor belongs to this explicit full replacement. Removing it
/// drops any closing characters the editor inserted ahead of the caret.
pub(super) fn discard_tail(
    burst: &Burst,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<(), AppError> {
    press(
        burst,
        adapter,
        context,
        key("end", vec![Modifier::Ctrl, Modifier::Shift]),
    )?;
    press(burst, adapter, context, key("forwarddelete", vec![]))
}

/// Reset the new line before typing its requested indentation.
pub(super) fn start_line(
    burst: &Burst,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<(), AppError> {
    press(burst, adapter, context, key("home", vec![]))?;
    discard_tail(burst, adapter, context)
}

pub(super) fn partial(error: AppError, typed: usize, total: usize) -> AppError {
    let mut error = match error {
        AppError::Adapter(e) => e,
        other => AdapterError::internal(other.to_string()),
    };
    let mut details = error
        .details
        .take()
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = details.as_object_mut() {
        obj.insert("typed_keystrokes".into(), typed.into());
        obj.insert("keystrokes".into(), total.into());
        obj.insert("replacement_started".into(), true.into());
    }
    error
        .with_details(details)
        .with_disposition(DeliverySemantics::delivered_unverified())
        .into()
}
