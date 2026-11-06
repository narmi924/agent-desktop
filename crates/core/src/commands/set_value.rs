use crate::{
    AppError,
    actions::action::Action,
    adapter::PlatformAdapter,
    commands::helpers::{
        RefArgs, execute_ref_action_with_context, selected_tab::execute_in_selected_tab,
    },
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
    let target = RefArgs {
        ref_id: args.ref_id,
        timeout_ms: args.timeout_ms,
    };
    match args.selected_tab {
        Some(tab) => execute_in_selected_tab(target, adapter, request, context, &tab),
        None => execute_ref_action_with_context(target, adapter, request, context),
    }
}

#[cfg(test)]
#[path = "set_value_tests.rs"]
mod tests;
