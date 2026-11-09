use super::{Patch, patch_difference, same_picture};

fn image(width: u32, height: u32, value: u8) -> Vec<u8> {
    vec![value; (width * height * 4) as usize]
}

fn patch(pixels: &[u8], width: u32, height: u32, offset: (u32, u32)) -> Patch<'_> {
    Patch {
        pixels,
        width,
        height,
        offset,
    }
}

#[test]
fn identical_pictures_match() {
    let picture = image(100, 100, 120);
    let difference = patch_difference(
        patch(&picture, 100, 100, (0, 0)),
        patch(&picture, 100, 100, (0, 0)),
        (50, 50),
    );
    assert_eq!(difference, 0.0);
}

#[test]
fn a_changed_picture_is_outside_the_tolerance() {
    let (old, new) = (image(100, 100, 40), image(100, 100, 200));
    assert!(!same_picture(
        patch(&old, 100, 100, (0, 0)),
        patch(&new, 100, 100, (0, 0)),
        (50, 50),
    ));
}

#[test]
fn a_small_rendering_difference_still_matches() {
    let (old, new) = (image(100, 100, 120), image(100, 100, 124));
    assert!(same_picture(
        patch(&old, 100, 100, (0, 0)),
        patch(&new, 100, 100, (0, 0)),
        (50, 50),
    ));
}

#[test]
fn a_cropped_capture_is_compared_at_its_place_in_the_window() {
    let (crop, window) = (image(40, 40, 90), image(200, 200, 90));
    let difference = patch_difference(
        patch(&crop, 40, 40, (100, 100)),
        patch(&window, 200, 200, (0, 0)),
        (110, 110),
    );
    assert_eq!(difference, 0.0);
}

#[test]
fn no_overlap_never_counts_as_a_match() {
    let picture = image(10, 10, 90);
    assert!(!same_picture(
        patch(&picture, 10, 10, (500, 500)),
        patch(&picture, 10, 10, (0, 0)),
        (5, 5),
    ));
}
