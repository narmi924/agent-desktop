use crate::{AppError, AppInventoryQuery, adapter::PlatformAdapter};
use serde_json::{Value, json};

pub struct ListAppsArgs {
    pub app: Option<String>,
    pub timeout_ms: Option<u64>,
    pub installed: bool,
}

pub fn execute(args: ListAppsArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let deadline = crate::Deadline::after(
        args.timeout_ms
            .unwrap_or(crate::DEFAULT_OPERATION_TIMEOUT_MS),
    )?;
    if args.installed {
        return installed(args.app.as_deref(), adapter, deadline);
    }
    let query = args
        .app
        .as_deref()
        .map_or(AppInventoryQuery::All, AppInventoryQuery::NameOrAlias);
    let inventory = adapter.query_app_inventory(query, deadline)?;
    let mut output = json!({ "apps": inventory.apps });
    if !inventory.skipped.is_empty() {
        output["complete"] = json!(false);
        output["skipped"] = json!(inventory.skipped);
    }
    Ok(output)
}

/// The installed applications, filtered by name or id and sorted by name, so
/// two calls on the same machine list them in the same order.
fn installed(
    filter: Option<&str>,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<Value, AppError> {
    let mut apps: Vec<_> = adapter
        .list_installed_apps(deadline)?
        .into_iter()
        .filter(|app| filter.is_none_or(|wanted| app.matches_filter(wanted)))
        .collect();
    apps.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(json!({ "installed_apps": apps }))
}

#[cfg(test)]
#[path = "list_apps_tests.rs"]
mod tests;
