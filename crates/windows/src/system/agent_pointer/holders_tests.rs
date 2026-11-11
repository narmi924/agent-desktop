use super::{Swapped, add, clear, live, mark_restored, mark_swapped, swapped};

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-pointer-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn a_finished_holder_is_dropped_and_a_running_one_counted() {
    let root = scratch("holders");
    add(&root, 11, "started-a").unwrap();
    add(&root, 12, "started-b").unwrap();
    let running = |pid: u32, token: &str| pid == 11 && token == "started-a";
    assert_eq!(live(&root, running), 1);
    assert_eq!(live(&root, |_, _| false), 0);
    assert_eq!(live(&root, |_, _| true), 0, "dropped holders stay dropped");
    clear(&root);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_reused_pid_with_another_start_time_does_not_hold() {
    let root = scratch("reused");
    add(&root, 20, "first-process").unwrap();
    assert_eq!(live(&root, |_, token| token == "second-process"), 0);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_swapped_record_reads_back_until_it_is_cleared() {
    let root = scratch("swapped");
    assert_eq!(swapped(&root), None);
    let record = Swapped {
        keeper: 4242,
        token: "t-1".into(),
    };
    mark_swapped(&root, &record).unwrap();
    assert_eq!(swapped(&root), Some(record));
    mark_restored(&root);
    assert_eq!(swapped(&root), None);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn no_holder_directory_means_no_holder() {
    let root = scratch("empty");
    assert_eq!(live(&root, |_, _| true), 0);
}
