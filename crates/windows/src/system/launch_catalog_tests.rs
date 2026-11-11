use super::*;

#[test]
fn paths_and_system_programs_keep_the_path_rules_and_names_go_to_the_app_list() {
    assert!(handled_by_path(r"C:\Program Files\App\app.exe"));
    assert!(handled_by_path(r"sub\app.exe"));
    assert!(handled_by_path("tools/app.exe"));
    assert!(handled_by_path("   "));
    assert!(!handled_by_path(
        r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\charmap.exe"
    ));
    assert!(!handled_by_path("计算器"));
    assert!(!handled_by_path("Google Chrome"));
    assert!(!handled_by_path(
        "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"
    ));
}

#[cfg(target_os = "windows")]
#[test]
fn a_bare_name_found_in_the_system_directories_keeps_the_path_rules() {
    assert!(handled_by_path("notepad"));
    assert!(handled_by_path("cmd.exe"));
}
