use super::{plan_passes, render};
use crate::system::ocr_merge::merge;
use crate::{OcrLine, OcrReading, OcrTone, OcrWord, Rect};

fn word(text: &str, x: f64) -> OcrWord {
    OcrWord {
        text: text.into(),
        bounds: Rect {
            x,
            y: 10.0,
            width: 20.0,
            height: 20.0,
        },
    }
}

fn line(words: &[(&str, f64)]) -> OcrLine {
    OcrLine {
        text: words.iter().map(|(text, _)| *text).collect(),
        words: words.iter().map(|(text, x)| word(text, *x)).collect(),
    }
}

#[test]
fn the_first_language_reads_four_copies_and_each_other_language_one() {
    let languages = vec!["zh-Hans-CN".to_string(), "en-US".to_string()];
    let passes = plan_passes(&languages, 2.25);
    assert_eq!(passes.len(), 5);
    assert!((passes[0].scale - 2.0 / 2.25).abs() < 1e-9);
    assert_eq!(passes[0].tone, OcrTone::Dark);
    assert!((passes[1].scale - 1.5 / 2.25).abs() < 1e-9);
    assert_eq!(passes[1].tone, OcrTone::Dark);
    assert_eq!(passes[2].scale, 1.0);
    assert_eq!(passes[2].tone, OcrTone::Color);
    assert!((passes[3].scale - 1.25 / 2.25).abs() < 1e-9);
    assert_eq!(passes[3].tone, OcrTone::Gray);
    assert_eq!(passes[4].language.as_deref(), Some("en-US"));
    assert_eq!(passes[4].scale, 1.0);
    assert!(
        passes[..4]
            .iter()
            .all(|pass| pass.language.as_deref() == Some("zh-Hans-CN"))
    );
}

#[test]
fn small_text_on_a_100_percent_display_is_read_enlarged() {
    let passes = plan_passes(&["en-US".to_string()], 1.0);
    assert_eq!(passes.len(), 4);
    assert_eq!(passes[0].scale, 2.0);
    assert_eq!(passes[1].scale, 1.5);
}

#[test]
fn an_unknown_display_scale_is_treated_as_100_percent() {
    let passes = plan_passes(&["en-US".to_string()], f64::NAN);
    assert_eq!(passes[0].scale, 2.0);
}

#[test]
fn the_reply_shows_one_text_per_place_lists_other_readings_and_finds_by_any() {
    let spots = merge(&[
        OcrReading {
            language: "zh-Hans-CN".into(),
            lines: vec![line(&[
                ("输", 0.0),
                ("入", 20.0),
                ("氵", 40.0),
                ("肖", 50.0),
                ("息", 60.0),
            ])],
        },
        OcrReading {
            language: "zh-Hans-CN".into(),
            lines: vec![line(&[
                ("输", 0.0),
                ("入", 20.0),
                ("消", 40.0),
                ("息", 60.0),
            ])],
        },
        OcrReading {
            language: "zh-Hans-CN".into(),
            lines: vec![line(&[
                ("输", 0.0),
                ("入", 20.0),
                ("消", 40.0),
                ("息", 60.0),
            ])],
        },
    ]);
    let body = render(&spots, Some("输入消息"), 3);
    assert_eq!(body["text"], "输入消息");
    assert_eq!(body["lines"][0]["also"][0], "输入氵肖息");
    assert_eq!(body["passes"], 3);
    assert_eq!(body["matches"].as_array().map(Vec::len), Some(1));
    assert_eq!(body["matches"][0]["whole_line"], true);
    assert_eq!(body["matches"][0]["center"]["x"], 40.0);
}
