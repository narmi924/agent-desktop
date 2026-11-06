use crate::{
    AppError,
    actions::action::Action,
    adapter::PlatformAdapter,
    commands::helpers::{RefArgs, execute_ref_action_dispatching, load_ref_entry},
    context::CommandContext,
};
use serde_json::Value;

pub struct SetValueArgs {
    pub ref_id: String,
    pub value: String,
    pub selected_tab: Option<String>,
    pub timeout_ms: Option<u64>,
}

pub fn execute(
    args: SetValueArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let request = context.request_base(Action::SetValue(args.value));
    let tab = args
        .selected_tab
        .as_deref()
        .map(|tab_ref| {
            let parse = crate::refs::ref_token::resolve_ref_target;
            if parse(tab_ref)?.0 != parse(&args.ref_id)?.0 {
                return Err(AppError::invalid_input(
                    "Capture the editor and selected tab in the same window snapshot",
                ));
            }
            load_ref_entry(tab_ref, context)
        })
        .transpose()?;
    execute_ref_action_dispatching(
        RefArgs {
            ref_id: args.ref_id,
            timeout_ms: args.timeout_ms,
        },
        adapter,
        request,
        context,
        |target, request, lease| {
            crate::ref_action::dispatch_resolved_landing(target, request, lease, tab.as_ref())
                .map(|(result, _)| result)
        },
    )
}

#[cfg(test)]
#[path = "set_value_tests.rs"]
mod tests;
