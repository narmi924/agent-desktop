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

pub fn execute(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    execute_ref_action_with_context(args, adapter, context.request_base(Action::Click), context)
}

pub fn in_selected_tab(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
    tab: &str,
) -> Result<Value, AppError> {
    execute_in_selected_tab(
        args,
        adapter,
        context.request_base(Action::Click),
        context,
        tab,
    )
}
