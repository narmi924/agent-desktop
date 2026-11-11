//! Starts a packaged app through the system's application activation, which
//! is how the Start menu starts it and the only way that reports its process.
//! An instance counts as running only when one of its processes has a window:
//! system hosts run in a package's name without the app being open.

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ProcessId, system::launch_options::LaunchOptions,
    system::launch_result::LaunchResult,
};

use super::super::app_catalog::CatalogEntry;
use super::super::process_app_id::{RunningProcess, running_processes, window_owners};
use super::super::process_identity;

pub(super) fn launch(
    entry: &CatalogEntry,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    if !options.env.is_empty() || options.cwd.is_some() {
        return Err(super::before_launch(
            AdapterError::new(
                ErrorCode::InvalidArgs,
                "A packaged app takes no --env or --cwd; the system sets both",
            )
            .with_details(serde_json::json!({ "app_name": entry.name, "id": entry.id })),
        ));
    }
    let owners = window_owners(deadline).map_err(super::before_launch)?;
    let running: Vec<RunningProcess> = running_processes()
        .map_err(super::before_launch)?
        .into_iter()
        .filter(|process| {
            owners.contains(&process.pid)
                && process
                    .app_id
                    .as_deref()
                    .is_some_and(|app_id| app_id.eq_ignore_ascii_case(&entry.id))
        })
        .collect();
    let (pid, name) = match running.as_slice() {
        [] => {
            deadline.ensure_remaining().map_err(super::before_launch)?;
            let pid = imp::activate(&entry.id, &options.args).map_err(super::before_launch)?;
            (pid, process_name(pid).unwrap_or_else(|| entry.name.clone()))
        }
        [only] if options.attach_if_running => (only.pid, only.name.clone()),
        [only, ..] if !options.attach_if_running => {
            return Err(super::before_launch(
                AdapterError::new(ErrorCode::ActionFailed, "Application is already running")
                    .with_details(serde_json::json!({
                        "pid": only.pid,
                        "candidate_pids": running.iter().map(|process| process.pid).collect::<Vec<_>>(),
                    }))
                    .with_suggestion(
                        "Omit --no-attach to attach to the running instance, or close it first.",
                    ),
            ));
        }
        many => {
            return Err(super::before_launch(
                AdapterError::ambiguous_process_target(
                    "More than one process runs this packaged app",
                    &many.iter().map(|process| process.pid).collect::<Vec<_>>(),
                ),
            ));
        }
    };
    let token = process_identity::token_for_pid(pid)
        .map_err(super::after_launch)?
        .ok_or_else(|| {
            super::after_launch(
                AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "The activated app's process ended before it could be identified",
                )
                .with_details(serde_json::json!({ "pid": pid, "complete": false })),
            )
        })?;
    let window = super::observe_window(pid, &token, options, deadline)?;
    Ok(super::launch_result(&name, pid, token, window))
}

fn process_name(pid: ProcessId) -> Option<String> {
    super::super::app_ops::process_snapshot()
        .ok()?
        .into_iter()
        .find(|row| row.pid == pid)
        .map(|row| row.name)
}

#[cfg(target_os = "windows")]
mod imp {
    use agent_desktop_core::{AdapterError, ErrorCode, ProcessId};
    use windows::Win32::System::Com::{CLSCTX_LOCAL_SERVER, CoCreateInstance};
    use windows::Win32::UI::Shell::{
        AO_NONE, ApplicationActivationManager, IApplicationActivationManager,
    };
    use windows::core::HSTRING;

    pub(super) fn activate(app_id: &str, args: &[String]) -> Result<ProcessId, AdapterError> {
        let arguments = args
            .iter()
            .map(|arg| super::super::quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let manager: IApplicationActivationManager =
            unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) }
                .map_err(|error| activation_error("reach the app activation service", &error))?;
        let pid = unsafe {
            manager.ActivateApplication(&HSTRING::from(app_id), &HSTRING::from(arguments), AO_NONE)
        }
        .map_err(|error| activation_error("activate the app", &error))?;
        Ok(ProcessId::from(pid))
    }

    fn activation_error(action: &str, error: &windows::core::Error) -> AdapterError {
        AdapterError::new(ErrorCode::ActionFailed, format!("Cannot {action}")).with_platform_detail(
            format!("HRESULT 0x{:08X}: {}", error.code().0, error.message()),
        )
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use agent_desktop_core::{AdapterError, ProcessId};

    pub(super) fn activate(_app_id: &str, _args: &[String]) -> Result<ProcessId, AdapterError> {
        Err(AdapterError::not_supported("launch_app"))
    }
}
