//! Starts an application the Start menu lists, named by its id, its display
//! name or its executable's file name. An absolute path, and a bare program
//! name found in the system directories, keep their own launch path.

use std::path::Path;

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, system::launch_options::LaunchOptions,
    system::launch_result::LaunchResult,
};

use super::super::app_catalog::{self, CatalogEntry, CatalogTarget, Lookup, ProgramTarget};
use super::super::launch_path::{launch_identifier, resolve_executable, validate_launch_options};

const CANDIDATE_LIMIT: usize = 8;

/// `None` when `id` is a path or a system program the ordinary launch path
/// handles; otherwise the launch of the Start menu entry `id` names.
pub(super) fn launch_installed(
    id: &str,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<Option<LaunchResult>, AdapterError> {
    if handled_by_path(id) {
        return Ok(None);
    }
    let entries = app_catalog::load(deadline).map_err(super::before_launch)?;
    let entry = match app_catalog::find(&entries, id) {
        Lookup::Found(entry) => entry,
        Lookup::Missing => return Err(super::before_launch(not_installed(id))),
        Lookup::Ambiguous(hits) => return Err(super::before_launch(ambiguous(id, &hits))),
    };
    match &entry.target {
        CatalogTarget::Packaged => super::launch_packaged::launch(entry, options, deadline),
        CatalogTarget::Program(program) => launch_program(program, options, deadline),
    }
    .map(Some)
}

/// A separator makes `id` a path, except in the one id form the Apps folder
/// writes with one: a known folder's `{GUID}` followed by the program's path
/// inside it. Any other path, absolute or not, keeps the path rules and their
/// errors.
fn handled_by_path(id: &str) -> bool {
    if id.trim().is_empty() || id.chars().any(char::is_control) {
        return true;
    }
    if id.contains(['\\', '/']) && !id.starts_with('{') {
        return true;
    }
    launch_identifier(id).is_ok_and(|normalized| {
        Path::new(&normalized).is_absolute() || resolve_executable(&normalized).is_ok()
    })
}

/// Starts a shortcut's program. Without shortcut arguments it is an ordinary
/// path launch, attaching to a running instance as any path launch does. A
/// shortcut that passes arguments always starts its program with them, since a
/// running instance of the same executable was started for something else.
fn launch_program(
    program: &ProgramTarget,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    if !program.path.is_file() {
        return Err(super::before_launch(
            AdapterError::new(
                ErrorCode::AppNotFound,
                "The Start menu entry points at a program that is not on disk",
            )
            .with_details(serde_json::json!({ "path": program.path.to_string_lossy() })),
        ));
    }
    let mut merged = options.clone();
    if merged.cwd.is_none() {
        merged.cwd = program.path.parent().map(Path::to_path_buf);
    }
    let id = program.path.to_string_lossy().into_owned();
    let Some(arguments) = &program.arguments else {
        return super::launch_path_target(&id, &merged, deadline);
    };
    merged.args = app_catalog::split_arguments(arguments)
        .into_iter()
        .chain(options.args.iter().cloned())
        .collect();
    validate_launch_options(&merged).map_err(super::before_launch)?;
    let (pid, token) = super::create_process(&program.path, &merged, deadline)?;
    let window = super::observe_window(pid, &token, &merged, deadline)?;
    Ok(super::launch_result(&id, pid, token, window))
}

fn not_installed(id: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppNotFound,
        "No installed app or system program has this name",
    )
    .with_details(serde_json::json!({ "app_name": id }))
    .with_suggestion(
        "Run `agent-desktop list-apps --installed --app <part of the name>` and launch by a name or id it lists, or pass the program's full path.",
    )
}

fn ambiguous(id: &str, hits: &[&CatalogEntry]) -> AdapterError {
    let candidates: Vec<_> = hits
        .iter()
        .take(CANDIDATE_LIMIT)
        .map(|entry| serde_json::json!({ "name": entry.name, "id": entry.id }))
        .collect();
    AdapterError::new(
        ErrorCode::AmbiguousTarget,
        format!("{} installed apps match this name", hits.len()),
    )
    .with_details(serde_json::json!({ "app_name": id, "candidates": candidates }))
    .with_suggestion("Launch by one candidate's id.")
}

#[cfg(test)]
#[path = "launch_catalog_tests.rs"]
mod tests;
