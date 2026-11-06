use super::{RefArgs, execute_ref_action_dispatching, load_ref_entry};
use crate::{ActionRequest, AppError, PlatformAdapter, context::CommandContext};
use serde_json::Value;

pub(crate) fn execute_in_selected_tab(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    request: ActionRequest,
    context: &CommandContext,
    tab_ref: &str,
) -> Result<Value, AppError> {
    let tab = load_tab(&args.ref_id, tab_ref, context)?;
    dispatch_in_tab(args, adapter, request, context, &tab)
}

pub(crate) fn load_tab(
    target_ref: &str,
    tab_ref: &str,
    context: &CommandContext,
) -> Result<crate::RefEntry, AppError> {
    let parse = crate::refs::ref_token::resolve_ref_target;
    if parse(tab_ref)?.0 != parse(target_ref)?.0 {
        return Err(AppError::invalid_input(
            "Capture the control and selected tab in the same window snapshot",
        ));
    }
    load_ref_entry(tab_ref, context)
}

pub(crate) fn dispatch_in_tab(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    request: ActionRequest,
    context: &CommandContext,
    tab: &crate::RefEntry,
) -> Result<Value, AppError> {
    execute_ref_action_dispatching(args, adapter, request, context, |target, request, lease| {
        crate::ref_action::dispatch_resolved_landing(target, request, lease, Some((tab, None)))
            .map(|(result, _)| result)
    })
}
