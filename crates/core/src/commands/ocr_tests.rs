use super::find_matches;
use crate::{OcrLine, OcrWord, Rect};

fn word(text: &str, x: f64) -> OcrWord {
    OcrWord {
        text: text.into(),
        bounds: Rect {
            x,
            y: 10.0,
            width: 20.0,
            height: 12.0,
        },
    }
}

fn line(words: &[(&str, f64)]) -> OcrLine {
    OcrLine {
        text: words
            .iter()
            .map(|(text, _)| *text)
            .collect::<Vec<_>>()
            .join(" "),
        words: words.iter().map(|(text, x)| word(text, *x)).collect(),
    }
}

#[test]
fn chinese_split_into_single_characters_still_matches() {
    let lines = [line(&[
        ("请", 0.0),
        ("采", 20.0),
        ("取", 40.0),
        ("行", 60.0),
        ("动", 80.0),
    ])];
    let matches = find_matches(&lines, "采取行动");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["bounds"]["x"], 20.0);
    assert_eq!(matches[0]["bounds"]["width"], 80.0);
    assert_eq!(matches[0]["center"]["x"], 60.0);
}

#[test]
fn a_capital_i_read_for_a_lowercase_l_still_matches() {
    let lines = [line(&[("EngIish", 0.0), ("Mode", 20.0)])];
    assert_eq!(find_matches(&lines, "english").len(), 1);
}

#[test]
fn text_that_is_absent_finds_nothing() {
    let lines = [line(&[("Hello", 0.0)])];
    assert!(find_matches(&lines, "world").is_empty());
    assert!(find_matches(&lines, "   ").is_empty());
}

#[test]
fn repeated_text_reports_every_place() {
    let lines = [line(&[("OK", 0.0)]), line(&[("OK", 200.0)])];
    assert_eq!(find_matches(&lines, "ok").len(), 2);
}
