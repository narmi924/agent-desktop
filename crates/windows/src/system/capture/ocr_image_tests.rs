use super::{Pixels, prepare, resample, scaled_size, unrotate};
use agent_desktop_core::OcrTone;
use agent_desktop_core::Rect;

fn pixels(width: u32, height: u32, rgba: [u8; 4]) -> Pixels {
    Pixels {
        width,
        height,
        rgba: rgba.repeat((width * height) as usize),
    }
}

#[test]
fn halving_averages_each_block_of_four() {
    let plane = [0, 100, 200, 100, 50, 50, 50, 50];
    assert_eq!(resample(&plane, (4, 2), (2, 1)), vec![50, 100]);
}

#[test]
fn enlarging_keeps_flat_areas_flat_and_edges_in_between() {
    let plane = [0, 200];
    let out = resample(&plane, (2, 1), (4, 1));
    assert_eq!(out.first(), Some(&0));
    assert_eq!(out.last(), Some(&200));
    assert!(out[1] > 0 && out[2] < 200);
}

#[test]
fn white_text_on_a_green_button_becomes_light_on_mid_grey() {
    let green = prepare(&pixels(2, 2, [7, 193, 96, 255]), 1.0, OcrTone::Gray);
    let white = prepare(&pixels(2, 2, [255, 255, 255, 255]), 1.0, OcrTone::Gray);
    assert!(green.gray);
    assert_eq!(green.bytes, vec![126; 4]);
    assert_eq!(white.bytes, vec![255; 4]);
}

#[test]
fn the_dark_tone_widens_the_gap_between_pale_text_and_a_pale_fill() {
    let text = prepare(&pixels(1, 1, [192, 192, 192, 255]), 1.0, OcrTone::Dark).bytes[0];
    let fill = prepare(&pixels(1, 1, [245, 245, 245, 255]), 1.0, OcrTone::Dark).bytes[0];
    assert!(i32::from(fill) - i32::from(text) > 100);
}

#[test]
fn the_colour_copy_is_blue_green_red_order_and_opaque() {
    let copy = prepare(&pixels(1, 1, [10, 20, 30, 0]), 1.0, OcrTone::Color);
    assert!(!copy.gray);
    assert_eq!(copy.bytes, vec![30, 20, 10, 255]);
}

#[test]
fn a_scaled_copy_has_the_rounded_size() {
    assert_eq!(scaled_size(2479, 1642, 2.0 / 2.25), (2204, 1460));
    assert_eq!(scaled_size(100, 50, 1.0), (100, 50));
    assert_eq!(scaled_size(1, 1, 0.1), (1, 1));
}

#[test]
fn boxes_from_a_wrongly_straightened_reading_are_turned_back() {
    let rect = |x: f64, y: f64| Rect {
        x,
        y,
        width: 28.0,
        height: 26.0,
    };
    let center = (1104.0, 767.0);
    let left = unrotate(rect(148.0, 588.0), 1.4, center);
    let right = unrotate(rect(2041.0, 1408.0), 1.4, center);
    assert!((left.y - 565.0).abs() < 3.0, "{}", left.y);
    assert!((left.x - 152.0).abs() < 3.0, "{}", left.x);
    assert!((right.y - 1432.0).abs() < 3.0, "{}", right.y);
    assert!((right.x - 2024.0).abs() < 3.0, "{}", right.x);
    assert_eq!(unrotate(rect(5.0, 6.0), 0.0, center).y, 6.0);
}

#[test]
fn han_words_join_without_spaces_and_english_keeps_them() {
    let word = |text: &str| agent_desktop_core::OcrWord {
        text: text.into(),
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        },
    };
    let line =
        |texts: &[&str]| super::join_words(&texts.iter().map(|t| word(t)).collect::<Vec<_>>());
    assert_eq!(line(&["王", "磊", "：", "明", "天"]), "王磊：明天");
    assert_eq!(line(&["Build", "1482", "passed"]), "Build 1482 passed");
    assert_eq!(line(&["发", "送", "v2", "版", "本"]), "发送 v2 版本");
}
