use super::render;
use crate::system::agent_pointer::look::{Look, image};

#[test]
fn the_built_in_image_shrinks_to_the_asked_size_with_the_tip_as_hotspot() {
    let png = image(&Look::BuiltIn("amber")).unwrap();
    let art = render(&png, 176).unwrap();
    assert_eq!(art.size, 176);
    assert_eq!(art.bgra.len(), 176 * 176 * 4);
    assert_eq!(art.hotspot, (56, 56));
    let at = |x: usize, y: usize| &art.bgra[(y * 176 + x) * 4..(y * 176 + x) * 4 + 4];
    assert_eq!(at(0, 0)[3], 0, "the corner is transparent");
    let inside = at(60, 75);
    assert!(
        inside[3] > 240 && inside[0] > 200,
        "the arrow body is opaque white"
    );
    let glow = at(45, 75);
    assert!(
        glow[3] > 0 && glow[2] > glow[0],
        "the glow left of the arrow is amber"
    );
}

#[test]
fn the_100_percent_size_keeps_the_tip_at_the_same_share() {
    let png = image(&Look::BuiltIn("green")).unwrap();
    let art = render(&png, 78).unwrap();
    assert_eq!(art.hotspot, (25, 25));
}

#[test]
fn bytes_that_are_not_a_png_give_no_art() {
    assert!(render(b"not a png", 64).is_none());
}
