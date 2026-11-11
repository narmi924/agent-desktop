use super::{Look, drawn_size, image, parse};

#[test]
fn the_amber_look_is_the_default_and_a_typo_keeps_the_signal_on() {
    assert_eq!(parse(None), Look::BuiltIn("amber"));
    assert_eq!(parse(Some("  ")), Look::BuiltIn("amber"));
    assert_eq!(parse(Some("purple")), Look::BuiltIn("amber"));
}

#[test]
fn off_turns_the_pointer_swap_off() {
    for value in ["off", "OFF", "0", "false", "no"] {
        assert_eq!(parse(Some(value)), Look::Off, "{value}");
    }
    assert!(image(&Look::Off).is_none());
}

#[test]
fn each_built_in_look_and_a_png_path_are_recognised() {
    assert_eq!(parse(Some("red")), Look::BuiltIn("red"));
    assert_eq!(parse(Some("C")), Look::BuiltIn("green"));
    assert_eq!(
        parse(Some(r"D:\looks\mine.PNG")),
        Look::File(r"D:\looks\mine.PNG".into())
    );
}

#[test]
fn an_unreadable_png_falls_back_to_the_amber_image() {
    let fallback = image(&Look::File("Z:/missing/pointer.png".into()));
    assert_eq!(fallback, image(&Look::BuiltIn("amber")));
}

#[test]
fn the_image_is_drawn_in_proportion_to_the_system_pointer() {
    assert_eq!(drawn_size(72), 176);
    assert_eq!(drawn_size(32), 78);
    assert_eq!(drawn_size(48), 117);
    assert_eq!(drawn_size(400), 256);
}
