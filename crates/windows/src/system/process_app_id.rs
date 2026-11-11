//! What each running process is: its executable path and, for a packaged
//! app, its AppUserModelID. A process this user cannot open reports neither.

use std::path::PathBuf;

use agent_desktop_core::{AdapterError, ProcessId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunningProcess {
    pub(crate) pid: ProcessId,
    pub(crate) name: String,
    pub(crate) image: Option<PathBuf>,
    pub(crate) app_id: Option<String>,
}

/// The processes that own a visible top-level window, a hosted app counted
/// as the owner of its frame.
pub(crate) fn window_owners(
    deadline: agent_desktop_core::Deadline,
) -> Result<std::collections::HashSet<ProcessId>, AdapterError> {
    Ok(super::window::window_ops::list_windows_live(
        &agent_desktop_core::WindowFilter {
            focused_only: false,
            app: None,
        },
        deadline,
    )?
    .into_iter()
    .filter(|window| window.state.visible != Some(false))
    .map(|window| window.pid)
    .collect())
}

pub(crate) fn running_processes() -> Result<Vec<RunningProcess>, AdapterError> {
    Ok(super::app_ops::process_snapshot()?
        .into_iter()
        .map(|row| {
            let (image, app_id) = imp::describe(row.pid);
            RunningProcess {
                pid: row.pid,
                name: row.name,
                image,
                app_id,
            }
        })
        .collect())
}

#[cfg(target_os = "windows")]
mod imp {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    use agent_desktop_core::ProcessId;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };

    const APP_ID_CAPACITY: usize = 130;

    struct Process(HANDLE);

    impl Drop for Process {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub(super) fn describe(pid: ProcessId) -> (Option<PathBuf>, Option<String>) {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, u32::from(pid)) };
        if handle.is_null() {
            return (None, None);
        }
        let process = Process(handle);
        (image_path(&process), app_user_model_id(&process))
    }

    fn image_path(process: &Process) -> Option<PathBuf> {
        let mut buffer = vec![0_u16; 32_768];
        let mut size = buffer.len() as u32;
        let ok =
            unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut size) };
        (ok != 0 && size > 0).then(|| {
            PathBuf::from(OsString::from_wide(
                &buffer[..(size as usize).min(buffer.len())],
            ))
        })
    }

    fn app_user_model_id(process: &Process) -> Option<String> {
        let mut buffer = vec![0_u16; APP_ID_CAPACITY];
        let mut length = buffer.len() as u32;
        let status =
            unsafe { GetApplicationUserModelId(process.0, &mut length, buffer.as_mut_ptr()) };
        if status != 0 {
            return None;
        }
        let end = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end])).filter(|id| !id.is_empty())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use std::path::PathBuf;

    use agent_desktop_core::ProcessId;

    pub(super) fn describe(_pid: ProcessId) -> (Option<PathBuf>, Option<String>) {
        (None, None)
    }
}
