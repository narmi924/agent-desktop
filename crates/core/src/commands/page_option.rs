use crate::commands::helpers::{RefArgs, execute_ref_action_dispatching, load_ref_entry};
use crate::{Action, AppError, CommandContext, PlatformAdapter};
use serde_json::Value;

pub struct ChoiceTarget<'a> {
    pub control: &'a str,
    pub tab: &'a str,
    pub document: &'a str,
}

pub fn execute(
    choice: ChoiceTarget<'_>,
    action: Action,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    if context.is_headed() {
        return Err(AppError::invalid_input(
            "A page choice requires semantic delivery",
        ));
    }
    let ChoiceTarget {
        control: target,
        tab,
        document,
    } = choice;
    let parse = crate::refs::ref_token::resolve_ref_target;
    let snapshot = parse(target)?.0;
    if parse(tab)?.0 != snapshot || parse(document)?.0 != snapshot {
        return Err(AppError::invalid_input(
            "Capture the tab, document and choice together",
        ));
    }
    let tab = load_ref_entry(tab, context)?;
    let doc = load_ref_entry(document, context)?;
    let args = RefArgs {
        ref_id: target.to_string(),
        timeout_ms: None,
    };
    let by_viewport = matches!(action, Action::Scroll(_, _));
    let mut request = context.request_base(action);
    request.scroll_by_viewport = by_viewport;
    execute_ref_action_dispatching(args, adapter, request, context, |target, request, lease| {
        crate::ref_action::dispatch_resolved_landing(
            target,
            request,
            lease,
            Some((&tab, Some(&doc))),
        )
        .map(|(result, _)| result)
    })
}

#[cfg(test)]
#[path = "page_option_tests.rs"]
mod tests;
