//! The applications installed for the current user, as the Start menu's
//! Apps folder lists them.
//!
//! The Apps folder is the one list that holds both packaged apps (activated
//! by their AppUserModelID) and desktop programs (Start menu shortcuts that
//! point at an executable, often with arguments of their own). A packaged
//! app's id is its AppUserModelID, the only kind of id with a `!` in it. Entries that
//! open a document, a folder, a script or a web address are not applications
//! and are left out.

use std::path::{Path, PathBuf};

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, InstalledApp, InstalledAppKind};

#[cfg(target_os = "windows")]
#[path = "app_catalog_shell.rs"]
mod shell;

/// One Apps folder item as the shell reports it, before it is classified.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RawItem {
    pub(crate) name: String,
    pub(crate) parsing_name: String,
    pub(crate) link_target: Option<String>,
    pub(crate) link_arguments: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CatalogEntry {
    pub(crate) name: String,
    pub(crate) id: String,
    pub(crate) target: CatalogTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CatalogTarget {
    Packaged,
    Program(ProgramTarget),
}

/// An executable and the arguments its Start menu shortcut passes to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProgramTarget {
    pub(crate) path: PathBuf,
    pub(crate) arguments: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Lookup<'a> {
    Found(&'a CatalogEntry),
    Missing,
    Ambiguous(Vec<&'a CatalogEntry>),
}

/// Turns one Apps folder item into an application, or `None` for an item that
/// opens a document, folder, script or address instead of starting a program.
pub(crate) fn classify(raw: RawItem) -> Option<CatalogEntry> {
    let name = raw.name.trim().to_string();
    let id = raw.parsing_name.trim().to_string();
    if name.is_empty() || id.is_empty() {
        return None;
    }
    let executable = raw
        .link_target
        .as_deref()
        .map(str::trim)
        .filter(|target| is_absolute_executable(target))
        .or_else(|| Some(id.as_str()).filter(|parsing| is_absolute_executable(parsing)));
    let Some(executable) = executable else {
        return id.contains('!').then_some(CatalogEntry {
            name,
            id,
            target: CatalogTarget::Packaged,
        });
    };
    let program = ProgramTarget {
        path: PathBuf::from(executable),
        arguments: non_blank(raw.link_arguments),
    };
    Some(CatalogEntry {
        name,
        id,
        target: CatalogTarget::Program(program),
    })
}

fn non_blank(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn is_absolute_executable(path: &str) -> bool {
    let bytes = path.as_bytes();
    let absolute = path.starts_with(r"\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\');
    absolute
        && Path::new(path)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
}

/// Finds the one entry a launch request names. The id wins over the display
/// name, and the display name over the executable's file name; within the
/// first rule that matches anything, two or more matches are ambiguous rather
/// than a guess.
pub(crate) fn find<'a>(entries: &'a [CatalogEntry], wanted: &str) -> Lookup<'a> {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return Lookup::Missing;
    }
    let lowered = wanted.to_lowercase();
    let stem = lowered.strip_suffix(".exe").unwrap_or(&lowered).to_string();
    let rules: [&dyn Fn(&CatalogEntry) -> bool; 3] = [
        &|entry| entry.id.eq_ignore_ascii_case(wanted),
        &|entry| entry.name.to_lowercase() == lowered,
        &|entry| executable_stem(entry).is_some_and(|own| own == stem),
    ];
    for rule in rules {
        let hits: Vec<&CatalogEntry> = entries.iter().filter(|entry| rule(entry)).collect();
        match hits.len() {
            0 => continue,
            1 => return Lookup::Found(hits[0]),
            _ => return Lookup::Ambiguous(hits),
        }
    }
    Lookup::Missing
}

fn executable_stem(entry: &CatalogEntry) -> Option<String> {
    match &entry.target {
        CatalogTarget::Program(program) => program
            .path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_lowercase()),
        CatalogTarget::Packaged => None,
    }
}

/// Splits a shortcut's argument string the way the C runtime does, so each
/// argument reaches the program unchanged after it is quoted again: a quote
/// toggles quoting, `""` inside quotes is a literal quote, and backslashes are
/// literal except in front of a quote.
pub(crate) fn split_arguments(line: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                let mut run = 1;
                while chars.peek() == Some(&'\\') {
                    chars.next();
                    run += 1;
                }
                if chars.peek() == Some(&'"') {
                    current.extend(std::iter::repeat_n('\\', run / 2));
                    if run % 2 == 1 {
                        chars.next();
                        current.push('"');
                    }
                } else {
                    current.extend(std::iter::repeat_n('\\', run));
                }
                started = true;
            }
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                current.push('"');
            }
            '"' => {
                quoted = !quoted;
                started = true;
            }
            ' ' | '\t' if !quoted => {
                if started {
                    arguments.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            other => {
                current.push(other);
                started = true;
            }
        }
    }
    if started {
        arguments.push(current);
    }
    arguments
}

/// Reads the Apps folder. The shell is asked from a thread of its own in a
/// single-threaded apartment, which is what its folder objects expect.
pub(crate) fn load(deadline: Deadline) -> Result<Vec<CatalogEntry>, AdapterError> {
    deadline.ensure_remaining()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("agent-desktop-app-catalog".into())
        .spawn(move || {
            let _ = sender.send(read_items());
        })
        .map_err(|error| {
            AdapterError::internal(format!("Cannot start the app list reader: {error}"))
        })?;
    let items = receiver.recv_timeout(deadline.remaining()).map_err(|_| {
        AdapterError::new(
            ErrorCode::Timeout,
            "The installed app list was not read within the deadline",
        )
        .with_suggestion("Retry with a longer --timeout-ms.")
    })??;
    Ok(items.into_iter().filter_map(classify).collect())
}

#[cfg(target_os = "windows")]
fn read_items() -> Result<Vec<RawItem>, AdapterError> {
    shell::read_apps_folder()
}

#[cfg(not(target_os = "windows"))]
fn read_items() -> Result<Vec<RawItem>, AdapterError> {
    Err(AdapterError::not_supported("list_installed_apps"))
}

/// The installed applications with whether each one has a window open: a
/// program's processes found by executable path, a packaged app's by its
/// AppUserModelID. A process without a window does not count, since system
/// hosts run for packaged apps that are not open.
pub(crate) fn installed_apps(deadline: Deadline) -> Result<Vec<InstalledApp>, AdapterError> {
    let entries = load(deadline)?;
    let owners = super::process_app_id::window_owners(deadline)?;
    let running: Vec<_> = super::process_app_id::running_processes()?
        .into_iter()
        .filter(|process| owners.contains(&process.pid))
        .collect();
    let shared = shared_executables(&entries);
    Ok(entries
        .into_iter()
        .map(|entry| {
            let (kind, path, running) = match &entry.target {
                CatalogTarget::Packaged => (
                    InstalledAppKind::Packaged,
                    None,
                    running.iter().any(|process| {
                        process
                            .app_id
                            .as_deref()
                            .is_some_and(|app_id| app_id.eq_ignore_ascii_case(&entry.id))
                    }),
                ),
                CatalogTarget::Program(program) => (
                    InstalledAppKind::Program,
                    Some(program.path.to_string_lossy().into_owned()),
                    running.iter().any(|process| {
                        process
                            .image
                            .as_deref()
                            .is_some_and(|image| same_path(image, &program.path))
                    }),
                ),
            };
            let shares_program = path
                .as_deref()
                .is_some_and(|path| shared.contains(&path.to_lowercase()));
            InstalledApp {
                name: entry.name,
                id: entry.id,
                kind,
                path,
                window_open: Some(running).filter(|_| !shares_program),
            }
        })
        .collect())
}

/// Executables that two or more entries start: the process list shows the
/// program running, but not which entry started it.
fn shared_executables(entries: &[CatalogEntry]) -> std::collections::HashSet<String> {
    let mut seen = std::collections::HashSet::new();
    let mut shared = std::collections::HashSet::new();
    for entry in entries {
        if let CatalogTarget::Program(program) = &entry.target {
            let key = program.path.to_string_lossy().to_lowercase();
            if !seen.insert(key.clone()) {
                shared.insert(key);
            }
        }
    }
    shared
}

pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

#[cfg(test)]
#[path = "app_catalog_tests.rs"]
mod tests;
