use super::*;

#[test]
fn a_drop_takes_files_and_either_a_ref_or_a_framed_point() {
    let framed = DropFilesArgs::try_parse_from([
        "drop-files",
        "a.mp4",
        "b.mp4",
        "--frame",
        "shot.png",
        "--xy",
        "10,20",
    ])
    .unwrap();
    assert_eq!(framed.files.len(), 2);
    assert_eq!(framed.xy.as_deref(), Some("10,20"));
    let at_ref = DropFilesArgs::try_parse_from(["drop-files", "a.mp4", "--ref", "@s1:e3"]).unwrap();
    assert_eq!(at_ref.ref_id.as_deref(), Some("@s1:e3"));
}

#[test]
fn a_drop_without_files_or_a_place_or_with_both_places_is_refused() {
    assert!(DropFilesArgs::try_parse_from(["drop-files", "--ref", "@s1:e3"]).is_err());
    assert!(DropFilesArgs::try_parse_from(["drop-files", "a.mp4"]).is_err());
    assert!(DropFilesArgs::try_parse_from(["drop-files", "a.mp4", "--xy", "1,2"]).is_err());
    assert!(
        DropFilesArgs::try_parse_from([
            "drop-files",
            "a.mp4",
            "--ref",
            "@s1:e3",
            "--frame",
            "shot.png",
            "--xy",
            "1,2"
        ])
        .is_err()
    );
}

#[test]
fn a_batch_entry_names_the_ref_as_ref() {
    let entry: DropFilesArgs =
        serde_json::from_value(serde_json::json!({"files": ["a.mp4"], "ref": "@s1:e3"})).unwrap();
    assert_eq!(entry.ref_id.as_deref(), Some("@s1:e3"));
}
