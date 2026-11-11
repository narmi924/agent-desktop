use agent_desktop_core::{
    AppError, PlatformAdapter,
    commands::{
        check as check_command, clear as clear_command, click as click_command,
        collapse as collapse_command, double_click as double_click_command,
        expand as expand_command, focus as focus_command, helpers,
        right_click as right_click_command, scroll as scroll_command,
        scroll_to as scroll_to_command, select as select_command, set_value as set_value_command,
        toggle as toggle_command, triple_click as triple_click_command,
        type_text as type_text_command, uncheck as uncheck_command,
    },
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::{
    RefArgs,
    actions::{ClickArgs, ScrollArgs, SelectArgs, SetValueArgs, TypeArgs},
};
use crate::dispatch::parse::parse_direction;

pub(super) fn click(
    args: ClickArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let target = ref_args(args.target);
    match args.selected_tab {
        Some(tab) => click_command::in_selected_tab(target, adapter, context, &tab),
        None => click_command::execute(target, adapter, context),
    }
}

pub(super) fn page_option(
    args: crate::cli_args::actions::PageOptionArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    use crate::cli_args::actions::ChoiceOperation;
    use agent_desktop_core::{Action, Direction, commands::page_option};
    let action = match (args.operation, args.value) {
        (ChoiceOperation::Select, Some(value)) => Action::Select(value),
        (ChoiceOperation::Search, Some(value)) => Action::SetValue(value),
        (ChoiceOperation::Check, None) => Action::Check,
        (ChoiceOperation::Expand, None) => Action::Expand,
        (ChoiceOperation::Collapse, None) => Action::Collapse,
        (ChoiceOperation::ScrollDown, None) => Action::Scroll(Direction::Down, 3),
        (ChoiceOperation::ScrollUp, None) => Action::Scroll(Direction::Up, 3),
        (ChoiceOperation::Click, None) => Action::Click,
        _ => {
            return Err(AppError::invalid_input(
                "Only select and search require --value",
            ));
        }
    };
    page_option::execute(
        page_option::ChoiceTarget {
            control: &args.target,
            tab: &args.selected_tab,
            document: &args.document,
        },
        action,
        adapter,
        context,
    )
}

pub(super) fn double_click(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    double_click_command::execute(ref_args(args), adapter, context)
}

pub(super) fn triple_click(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    triple_click_command::execute(ref_args(args), adapter, context)
}

pub(super) fn right_click(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    right_click_command::execute(ref_args(args), adapter, context)
}

/// With `--window-id` there is no ref, so a lone positional is the text.
fn window_text(args: &mut TypeArgs) -> Result<Option<(String, String)>, AppError> {
    let Some(window_id) = args.window_id.clone() else {
        return Ok(None);
    };
    let text = match (args.ref_id.take(), args.text.take()) {
        (Some(text), None) | (None, Some(text)) => text,
        (Some(_), Some(_)) => {
            return Err(AppError::invalid_input(
                "Pass either a ref or --window-id, not both",
            ));
        }
        (None, None) => return Err(AppError::invalid_input("type text is missing")),
    };
    Ok(Some((window_id, text)))
}

pub(super) fn type_text(
    mut args: TypeArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    use crate::cli_args::actions::PageEntryMode;
    if let Some((window_id, text)) = window_text(&mut args)? {
        return agent_desktop_core::commands::type_text_window::execute(
            agent_desktop_core::commands::type_text_window::WindowTypeArgs { window_id, text },
            adapter,
            context,
        );
    }
    if args.entry_mode.is_some() && args.selected_tab.is_none() {
        return Err(AppError::invalid_input(
            "--entry-mode requires --selected-tab",
        ));
    }
    let mode = type_text_command::PageTypingMode {
        multiline: matches!(
            args.entry_mode,
            Some(PageEntryMode::Multiline | PageEntryMode::ReplaceMultiline)
        ),
        replace: matches!(
            args.entry_mode,
            Some(PageEntryMode::Replace | PageEntryMode::ReplaceMultiline)
        ),
    };
    let paced = args.interval_ms.is_some() || context.human().is_some();
    let timeout_ms = if paced {
        args.timeout_ms
    } else {
        helpers::normalize_action_timeout_ms(args.effective_timeout_ms())
    };
    let text = args
        .text
        .ok_or_else(|| AppError::invalid_input("type text is missing"))?;
    type_text_command::execute_with_tab(
        type_text_command::TypeArgs {
            ref_id: args.ref_id.unwrap_or_default(),
            text,
            timeout_ms,
            interval_ms: args.interval_ms,
        },
        args.selected_tab.as_deref().map(|tab| (tab, mode)),
        adapter,
        context,
    )
}

pub(super) fn set_value(
    args: SetValueArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let value = args
        .value
        .ok_or_else(|| AppError::invalid_input("set-value input is missing"))?;
    set_value_command::execute(
        set_value_command::SetValueArgs {
            ref_id: args.ref_id,
            selected_tab: args.selected_tab,
            value,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        },
        adapter,
        context,
    )
}

pub(super) fn clear(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    clear_command::execute(ref_args(args), adapter, context)
}

pub(super) fn focus(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    focus_command::execute(ref_args(args), adapter, context)
}

pub(super) fn toggle(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    toggle_command::execute(ref_args(args), adapter, context)
}

pub(super) fn check(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    check_command::execute(ref_args(args), adapter, context)
}

pub(super) fn uncheck(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    uncheck_command::execute(ref_args(args), adapter, context)
}

pub(super) fn expand(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    expand_command::execute(ref_args(args), adapter, context)
}

pub(super) fn collapse(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    collapse_command::execute(ref_args(args), adapter, context)
}

pub(super) fn select(
    args: SelectArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    select_command::execute(
        select_command::SelectArgs {
            ref_id: args.ref_id,
            value: args.value,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        },
        adapter,
        context,
    )
}

pub(super) fn scroll(
    args: ScrollArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    scroll_command::execute(
        scroll_command::ScrollArgs {
            ref_id: args.ref_id,
            direction: parse_direction(&args.direction)?,
            amount: args.amount,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        },
        adapter,
        context,
    )
}

pub(super) fn scroll_to(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    scroll_to_command::execute(ref_args(args), adapter, context)
}

fn ref_args(args: RefArgs) -> helpers::RefArgs {
    helpers::RefArgs {
        ref_id: args.ref_id,
        timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
    }
}
