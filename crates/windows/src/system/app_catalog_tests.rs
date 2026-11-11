use super::*;

fn raw(name: &str, parsing: &str, target: Option<&str>, arguments: Option<&str>) -> RawItem {
    RawItem {
        name: name.into(),
        parsing_name: parsing.into(),
        link_target: target.map(Into::into),
        link_arguments: arguments.map(Into::into),
    }
}

fn catalog() -> Vec<CatalogEntry> {
    [
        raw(
            "计算器",
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
            None,
            None,
        ),
        raw(
            "Google Chrome",
            "Chrome",
            Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            Some("--source-shortcut-location=start-menu"),
        ),
        raw(
            "Google 日历",
            "Chrome._crx_kjbdgfilnfhdoflbpgamdcdgpehopbep",
            Some(r"C:\Program Files\Google\Chrome\Application\chrome_proxy.exe"),
            Some("--profile-directory=Default --app-id=kjbdgfilnfhdoflbpgamdcdgpehopbep"),
        ),
        raw(
            "字符映射表",
            r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\charmap.exe",
            Some(r"C:\WINDOWS\system32\charmap.exe"),
            None,
        ),
        raw("Release Notes", "a", Some(r"C:\Keil\notes.html"), None),
        raw("Release Notes", "b", Some(r"C:\Keil\other.html"), None),
        raw(
            "Python 3.12",
            "py312",
            Some(r"C:\Python312\python.exe"),
            None,
        ),
        raw(
            "Python 3.13",
            "py313",
            Some(r"C:\Python313\python.exe"),
            None,
        ),
    ]
    .into_iter()
    .filter_map(classify)
    .collect()
}

#[test]
fn packaged_apps_programs_and_non_apps_are_told_apart() {
    let entries = catalog();
    let calculator = &entries[0];
    assert_eq!(calculator.target, CatalogTarget::Packaged);
    let CatalogTarget::Program(chrome) = &entries[1].target else {
        panic!("Chrome is a program");
    };
    assert_eq!(
        chrome.path,
        PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    );
    assert_eq!(
        chrome.arguments.as_deref(),
        Some("--source-shortcut-location=start-menu")
    );
    assert!(entries.iter().all(|entry| entry.name != "Release Notes"));
    assert_eq!(entries.len(), 6);
}

#[test]
fn an_item_without_a_name_or_an_executable_is_not_an_app() {
    assert_eq!(classify(raw("", "x!App", None, None)), None);
    assert_eq!(
        classify(raw("Docs", r"D:\docs", Some(r"D:\docs"), None)),
        None
    );
    assert_eq!(
        classify(raw("Site", "https://nodejs.org/", None, None)),
        None
    );
    assert_eq!(
        classify(raw("Script", "s", Some(r"E:\pg\runpsql.bat"), None)),
        None
    );
    assert_eq!(
        classify(raw("Relative", "r", Some(r"tools\a.exe"), None)),
        None
    );
}

#[test]
fn a_launch_name_matches_the_id_then_the_name_then_the_executable() {
    let entries = catalog();
    let found = |wanted: &str| match find(&entries, wanted) {
        Lookup::Found(entry) => entry.name.clone(),
        other => panic!("{wanted}: {other:?}"),
    };
    assert_eq!(
        found("microsoft.windowscalculator_8wekyb3d8bbwe!app"),
        "计算器"
    );
    assert_eq!(found("计算器"), "计算器");
    assert_eq!(found("  google chrome "), "Google Chrome");
    assert_eq!(found("chrome"), "Google Chrome");
    assert_eq!(found("Chrome.exe"), "Google Chrome");
    assert_eq!(found("charmap"), "字符映射表");
}

#[test]
fn a_name_that_fits_two_entries_is_ambiguous_and_an_unknown_one_is_missing() {
    let entries = catalog();
    let Lookup::Ambiguous(hits) = find(&entries, "python") else {
        panic!("two Python programs share the executable name");
    };
    assert_eq!(hits.len(), 2);
    assert_eq!(find(&entries, "微信"), Lookup::Missing);
    assert_eq!(find(&entries, "   "), Lookup::Missing);
    assert_eq!(find(&entries, "计算"), Lookup::Missing);
}

#[test]
fn shortcut_arguments_split_the_way_the_c_runtime_reads_them() {
    assert_eq!(
        split_arguments("--profile-directory=Default --app-id=abc"),
        ["--profile-directory=Default", "--app-id=abc"]
    );
    assert_eq!(
        split_arguments(r#""C:\Program Files\idle.pyw" -n"#),
        [r"C:\Program Files\idle.pyw", "-n"]
    );
    assert_eq!(
        split_arguments(r#"/d /c "C:\Program Files\nodejs\install_tools.bat""#),
        ["/d", "/c", r"C:\Program Files\nodejs\install_tools.bat"]
    );
    assert_eq!(
        split_arguments(r#"a\\\"b "c""d" """#),
        [r#"a\"b"#, r#"c"d"#, ""]
    );
    assert_eq!(
        split_arguments(r"C:\dir\ trailing\\"),
        [r"C:\dir\", r"trailing\\"]
    );
    assert!(split_arguments("   ").is_empty());
}

#[cfg(target_os = "windows")]
#[test]
fn the_live_apps_folder_lists_named_applications_that_launch_can_find_by_id() {
    let entries = load(Deadline::after(20_000).expect("deadline")).expect("read the Apps folder");
    assert!(!entries.is_empty(), "the Apps folder listed no application");
    assert!(
        entries
            .iter()
            .all(|entry| !entry.name.is_empty() && !entry.id.is_empty())
    );
    let first = &entries[0];
    match find(&entries, &first.id) {
        Lookup::Found(found) => assert_eq!(found.id, first.id),
        other => panic!("{other:?}"),
    }
}
