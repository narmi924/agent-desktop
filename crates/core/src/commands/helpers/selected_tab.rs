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
    let parse = crate::refs::ref_token::resolve_ref_target;
    if parse(tab_ref)?.0 != parse(&args.ref_id)?.0 {
        return Err(AppError::invalid_input(
            "Capture the control and selected tab in the same window snapshot",
        ));
    }
    let tab = load_ref_entry(tab_ref, context)?;
    execute_ref_action_dispatching(args, adapter, request, context, |target, request, lease| {
        crate::ref_action::dispatch_resolved_landing(target, request, lease, Some(&tab))
            .map(|(result, _)| result)
    })
}
