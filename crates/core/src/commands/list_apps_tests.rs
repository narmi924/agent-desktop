use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, AppInfo};
use std::sync::atomic::{AtomicU32, Ordering};

struct AppsAdapter;

struct DeadlineAdapter {
    expected_timeout_ms: u64,
    app_listings: AtomicU32,
    window_listings: AtomicU32,
}

impl DeadlineAdapter {
    fn new(expected_timeout_ms: u64) -> Self {
        Self {
            expected_timeout_ms,
            app_listings: AtomicU32::new(0),
            window_listings: AtomicU32::new(0),
        }
    }
}

impl ObservationOps for AppsAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Ok(vec![
            AppInfo {
                name: "Finder".into(),
                pid: crate::ProcessId::new(1),
                bundle_id: Some("com.apple.finder".into()),
                process_instance: Some("test-instance".into()),
                presentation: None,
            },
            AppInfo {
                name: "TextEdit".into(),
                pid: crate::ProcessId::new(2),
                bundle_id: Some("com.apple.TextEdit".into()),
                process_instance: Some("test-instance".into()),
                presentation: None,
            },
        ])
    }
}

impl ObservationOps for DeadlineAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        self.app_listings.fetch_add(1, Ordering::SeqCst);
        assert_eq!(deadline.timeout_ms(), self.expected_timeout_ms);
        Ok(Vec::new())
    }
    fn list_windows(
        &self,
        _: &crate::WindowFilter,
        deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        self.window_listings.fetch_add(1, Ordering::SeqCst);
        assert_eq!(deadline.timeout_ms(), self.expected_timeout_ms);
        Ok(Vec::new())
    }
}
impl ActionOps for DeadlineAdapter {}
impl InputOps for DeadlineAdapter {}
impl SystemOps for DeadlineAdapter {}

impl ActionOps for AppsAdapter {}

impl InputOps for AppsAdapter {}

impl SystemOps for AppsAdapter {}

#[test]
fn app_filter_matches_by_name_case_insensitively() {
    let value = execute(
        ListAppsArgs {
            app: Some("text".into()),
            timeout_ms: None,
            installed: false,
        },
        &AppsAdapter,
    )
    .unwrap();

    let apps = value["apps"].as_array().unwrap();
    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0]["name"], "TextEdit");
}

#[test]
fn listing_timeout_reaches_both_adapter_deadlines() {
    for timeout_ms in [None, Some(37), Some(8000)] {
        let adapter =
            DeadlineAdapter::new(timeout_ms.unwrap_or(crate::DEFAULT_OPERATION_TIMEOUT_MS));
        execute(
            ListAppsArgs {
                app: None,
                timeout_ms,
                installed: false,
            },
            &adapter,
        )
        .unwrap();
        assert!(adapter.app_listings.load(Ordering::SeqCst) >= 1);
        crate::commands::list_windows::execute(
            crate::commands::list_windows::ListWindowsArgs {
                app: None,
                timeout_ms,
            },
            &adapter,
        )
        .unwrap();
        assert!(adapter.window_listings.load(Ordering::SeqCst) >= 1);
    }
}

struct IncompleteAdapter;
impl ObservationOps for IncompleteAdapter {
    fn list_apps_inventory(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::AppInventory, AdapterError> {
        Ok(crate::AppInventory {
            apps: AppsAdapter.list_apps(deadline)?,
            skipped: vec![json!({"pid":11,"field":"application_name"})],
        })
    }
}
impl ActionOps for IncompleteAdapter {}
impl InputOps for IncompleteAdapter {}
impl SystemOps for IncompleteAdapter {}

#[test]
fn list_apps_marks_skipped_records_even_when_filtered_to_no_matches() {
    for app in [None, Some("Missing".into())] {
        let value = execute(
            ListAppsArgs {
                app,
                timeout_ms: None,
                installed: false,
            },
            &IncompleteAdapter,
        )
        .unwrap();
        assert_eq!(value["complete"], false);
        assert_eq!(
            value["skipped"],
            json!([{"pid":11,"field":"application_name"}])
        );
    }
    let value = execute(
        ListAppsArgs {
            app: None,
            timeout_ms: None,
            installed: false,
        },
        &AppsAdapter,
    )
    .unwrap();
    assert!(value.get("complete").is_none());
    assert!(value.get("skipped").is_none());
}

struct AliasAdapter;
impl ObservationOps for AliasAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        AppsAdapter.list_apps(deadline)
    }
    fn list_apps_scoped(
        &self,
        name: &str,
        _bundle_id: Option<&str>,
        deadline: crate::Deadline,
    ) -> Result<Vec<AppInfo>, AdapterError> {
        let mut apps = self.list_apps(deadline)?;
        apps.retain(|app| name == "org.example.Files" && app.name == "Finder");
        Ok(apps)
    }
}
impl ActionOps for AliasAdapter {}
impl InputOps for AliasAdapter {}
impl SystemOps for AliasAdapter {}

#[test]
fn app_filter_accepts_the_adapter_alias_for_a_listed_app() {
    let value = execute(
        ListAppsArgs {
            app: Some("org.example.Files".into()),
            timeout_ms: None,
            installed: false,
        },
        &AliasAdapter,
    )
    .unwrap();

    let apps = value["apps"].as_array().unwrap();
    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0]["name"], "Finder");
}

struct FailingScopeAdapter(AdapterError);
impl ObservationOps for FailingScopeAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        AppsAdapter.list_apps(deadline)
    }
    fn list_apps_scoped(
        &self,
        _name: &str,
        _bundle_id: Option<&str>,
        _deadline: crate::Deadline,
    ) -> Result<Vec<AppInfo>, AdapterError> {
        Err(self.0.clone())
    }
}
impl ActionOps for FailingScopeAdapter {}
impl InputOps for FailingScopeAdapter {}
impl SystemOps for FailingScopeAdapter {}

fn filtered_args() -> ListAppsArgs {
    ListAppsArgs {
        app: Some("text".into()),
        timeout_ms: None,
        installed: false,
    }
}

#[test]
fn app_filter_propagates_a_scoped_listing_failure() {
    let adapter = FailingScopeAdapter(AdapterError::new(
        crate::ErrorCode::Timeout,
        "scoped listing timed out",
    ));

    let error = execute(filtered_args(), &adapter).unwrap_err();

    assert_eq!(error.code(), "TIMEOUT");
}

#[test]
fn app_filter_ignores_a_scoped_listing_that_is_not_supported() {
    let adapter = FailingScopeAdapter(AdapterError::not_supported("list_apps_scoped"));

    let value = execute(filtered_args(), &adapter).unwrap();

    assert_eq!(value["apps"].as_array().unwrap().len(), 1);
}

struct InstalledAdapter;

impl ObservationOps for InstalledAdapter {
    fn list_installed_apps(
        &self,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::InstalledApp>, AdapterError> {
        let app = |name: &str, id: &str, kind, path: Option<&str>| crate::InstalledApp {
            name: name.into(),
            id: id.into(),
            kind,
            path: path.map(Into::into),
            window_open: Some(false),
        };
        Ok(vec![
            app(
                "记事本",
                "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
                crate::InstalledAppKind::Packaged,
                None,
            ),
            app(
                "Google Chrome",
                "Chrome",
                crate::InstalledAppKind::Program,
                Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            ),
            app(
                "计算器",
                "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
                crate::InstalledAppKind::Packaged,
                None,
            ),
        ])
    }
}
impl ActionOps for InstalledAdapter {}
impl InputOps for InstalledAdapter {}
impl SystemOps for InstalledAdapter {}

fn installed_args(app: Option<&str>) -> ListAppsArgs {
    ListAppsArgs {
        app: app.map(Into::into),
        timeout_ms: None,
        installed: true,
    }
}

#[test]
fn installed_apps_are_listed_by_name_with_their_kind_and_path() {
    let value = execute(installed_args(None), &InstalledAdapter).unwrap();

    let apps = value["installed_apps"].as_array().unwrap();
    let names: Vec<_> = apps
        .iter()
        .map(|app| app["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Google Chrome", "计算器", "记事本"]);
    assert_eq!(apps[0]["kind"], "program");
    assert_eq!(
        apps[0]["path"],
        r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    );
    assert_eq!(apps[1]["kind"], "packaged");
    assert!(apps[1].get("path").is_none());
    assert!(value.get("apps").is_none());
}

#[test]
fn installed_apps_filter_by_name_or_id_ignoring_case() {
    let by_name = execute(installed_args(Some("计算")), &InstalledAdapter).unwrap();
    assert_eq!(by_name["installed_apps"][0]["name"], "计算器");
    assert_eq!(by_name["installed_apps"].as_array().unwrap().len(), 1);

    let by_id = execute(installed_args(Some("NOTEPAD")), &InstalledAdapter).unwrap();
    assert_eq!(by_id["installed_apps"][0]["name"], "记事本");
    assert_eq!(by_id["installed_apps"].as_array().unwrap().len(), 1);
}

#[test]
fn installed_apps_are_refused_where_the_platform_has_no_app_list() {
    let error = execute(installed_args(None), &AppsAdapter).unwrap_err();

    assert_eq!(error.code(), "PLATFORM_NOT_SUPPORTED");
}
