use super::merge;
use crate::{OcrLine, OcrReading, OcrWord, Rect};

fn line(text: &str, x: f64, y: f64) -> OcrLine {
    OcrLine {
        text: text.into(),
        words: vec![OcrWord {
            text: text.into(),
            bounds: Rect {
                x,
                y,
                width: 20.0 * text.chars().count() as f64,
                height: 20.0,
            },
        }],
    }
}

fn reading(language: &str, lines: Vec<OcrLine>) -> OcrReading {
    OcrReading {
        language: language.into(),
        lines,
    }
}

#[test]
fn the_reading_most_passes_agree_on_is_shown_and_the_others_are_kept() {
    let spots = merge(&[
        reading("zh-Hans-CN", vec![line("王磊日月天", 100.0, 50.0)]),
        reading("zh-Hans-CN", vec![line("王磊明天", 101.0, 51.0)]),
        reading("zh-Hans-CN", vec![line("王磊明天", 99.0, 50.0)]),
    ]);
    assert_eq!(spots.len(), 1);
    assert_eq!(spots[0].readings[0].text, "王磊明天");
    assert_eq!(spots[0].readings[1].text, "王磊日月天");
    assert_eq!(spots[0].readings.len(), 2);
}

#[test]
fn an_english_reading_wins_for_latin_text_the_chinese_pass_misread() {
    let spots = merge(&[
        reading("zh-Hans-CN", vec![line("Pr0Ject Alpha", 0.0, 0.0)]),
        reading("en-US", vec![line("Project Alpha", 0.0, 0.0)]),
    ]);
    assert_eq!(spots[0].readings[0].text, "Project Alpha");
}

#[test]
fn nonsense_from_a_recognizer_of_the_wrong_script_never_wins_or_stands_alone() {
    let spots = merge(&[
        reading("zh-Hans-CN", vec![line("自绘窗口示例", 0.0, 0.0)]),
        reading(
            "en-US",
            vec![line("ääQ7fiVlJ", 0.0, 0.0), line("Fä5,", 400.0, 300.0)],
        ),
    ]);
    assert_eq!(spots.len(), 1);
    assert_eq!(spots[0].readings[0].text, "自绘窗口示例");
}

#[test]
fn a_place_only_one_pass_read_is_still_a_place() {
    let spots = merge(&[
        reading("zh-Hans-CN", vec![line("发送文件", 300.0, 500.0)]),
        reading(
            "zh-Hans-CN",
            vec![line("发送文件", 300.0, 500.0), line("发送", 900.0, 600.0)],
        ),
    ]);
    assert_eq!(spots.len(), 2);
    assert_eq!(spots[1].readings[0].text, "发送");
}

#[test]
fn lines_on_different_rows_stay_apart_and_come_out_top_to_bottom() {
    let spots = merge(&[reading(
        "zh-Hans-CN",
        vec![line("第二行", 0.0, 40.0), line("第一行", 0.0, 0.0)],
    )]);
    assert_eq!(spots.len(), 2);
    assert_eq!(spots[0].readings[0].text, "第一行");
}

#[test]
fn blank_and_punctuation_only_lines_are_dropped() {
    let spots = merge(&[reading("zh-Hans-CN", vec![line("：", 0.0, 0.0)])]);
    assert!(spots.is_empty());
}
