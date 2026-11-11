use super::find;
use crate::{OcrLine, OcrSpot, OcrWord, Rect};

fn word(text: &str, x: f64, y: f64, width: f64) -> OcrWord {
    OcrWord {
        text: text.into(),
        bounds: Rect {
            x,
            y,
            width,
            height: 20.0,
        },
    }
}

/// A line of single-character words laid out left to right, each `width`
/// wide, the way the recognizer reports Han text.
fn chars(text: &str, x: f64, y: f64, width: f64) -> OcrLine {
    let words: Vec<OcrWord> = text
        .chars()
        .enumerate()
        .map(|(index, ch)| word(&ch.to_string(), x + index as f64 * width, y, width))
        .collect();
    OcrLine {
        text: text.into(),
        words,
    }
}

fn spot(readings: Vec<OcrLine>) -> OcrSpot {
    let first = &readings[0];
    let bounds = super::union(first.words.iter().map(|word| word.bounds));
    OcrSpot { bounds, readings }
}

#[test]
fn a_whole_line_beats_the_same_text_inside_a_longer_line() {
    let spots = [
        spot(vec![chars("发送文件", 300.0, 500.0, 20.0)]),
        spot(vec![chars("发送", 900.0, 600.0, 20.0)]),
    ];
    let hits = find(&spots, "发送");
    assert_eq!(hits.len(), 1);
    assert!(hits[0].whole_line);
    assert_eq!(hits[0].bounds.x, 900.0);
}

#[test]
fn only_partial_matches_are_returned_when_no_line_is_the_text() {
    let spots = [spot(vec![chars("发送文件", 300.0, 500.0, 20.0)])];
    let hits = find(&spots, "发送");
    assert_eq!(hits.len(), 1);
    assert!(!hits[0].whole_line);
    assert_eq!(hits[0].bounds.width, 40.0);
}

#[test]
fn every_place_of_the_best_kind_is_returned() {
    let spots = [
        spot(vec![chars("产品讨论组", 70.0, 140.0, 20.0)]),
        spot(vec![chars("产品讨论组", 300.0, 20.0, 24.0)]),
    ];
    let hits = find(&spots, "产品讨论组");
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|hit| hit.whole_line));
    assert_eq!(hits[0].bounds.y, 20.0);
}

#[test]
fn any_reading_of_a_place_can_match() {
    let spots = [spot(vec![
        chars("王磊：日月天上午", 300.0, 90.0, 20.0),
        chars("王磊：明天上午", 300.0, 90.0, 22.0),
    ])];
    assert_eq!(find(&spots, "明天上午").len(), 1);
}

#[test]
fn a_character_read_as_a_component_and_its_partner_still_matches() {
    let spots = [spot(vec![chars("好的，我扌巴会议室", 700.0, 150.0, 20.0)])];
    assert_eq!(find(&spots, "我把会议室").len(), 1);
}

#[test]
fn a_character_read_as_two_narrow_halves_still_matches() {
    let mut line = chars("王磊明天上午", 0.0, 0.0, 20.0);
    line.text = "王磊日月天上午".into();
    line.words.insert(2, word("日", 40.0, 0.0, 9.0));
    line.words[3] = word("月", 49.0, 0.0, 9.0);
    let spots = [spot(vec![line])];
    assert_eq!(find(&spots, "王磊明天").len(), 1);
}

#[test]
fn two_wide_characters_are_not_taken_for_one_split_character() {
    let spots = [spot(vec![chars("日月天上午", 0.0, 0.0, 20.0)])];
    assert!(find(&spots, "明天上午").is_empty());
}

#[test]
fn a_two_character_label_never_matches_through_a_split() {
    let spots = [spot(vec![chars("扌巴手", 0.0, 0.0, 20.0)])];
    assert!(find(&spots, "把手").is_empty());
}

#[test]
fn letters_and_digits_the_recognizer_confuses_still_match() {
    let spots = [
        spot(vec![OcrLine {
            text: "Pr0Ject Alpha".into(),
            words: vec![
                word("Pr0Ject", 0.0, 0.0, 60.0),
                word("Alpha", 66.0, 0.0, 50.0),
            ],
        }]),
        spot(vec![OcrLine {
            text: "BuiId I482 passed".into(),
            words: vec![
                word("BuiId", 0.0, 40.0, 40.0),
                word("I482", 46.0, 40.0, 40.0),
                word("passed", 92.0, 40.0, 50.0),
            ],
        }]),
    ];
    assert!(find(&spots, "Project Alpha")[0].whole_line);
    assert!(find(&spots, "build 1482 passed")[0].whole_line);
}

#[test]
fn spacing_and_full_width_punctuation_are_ignored() {
    let spots = [spot(vec![chars("王磊：明天", 0.0, 0.0, 20.0)])];
    assert!(find(&spots, "王磊: 明天")[0].whole_line);
}

#[test]
fn unrelated_or_empty_text_finds_nothing() {
    let spots = [spot(vec![chars("文件传输助手", 0.0, 0.0, 20.0)])];
    assert!(find(&spots, "发送").is_empty());
    assert!(find(&spots, "  ").is_empty());
    assert!(find(&spots, "：").is_empty());
}

#[test]
fn an_english_reading_of_part_of_a_line_is_not_a_whole_line() {
    let spots = [spot(vec![
        chars("说明hello", 0.0, 0.0, 20.0),
        OcrLine {
            text: "hello".into(),
            words: vec![word("hello", 40.0, 0.0, 50.0)],
        },
    ])];
    let hits = find(&spots, "hello");
    assert_eq!(hits.len(), 1);
    assert!(!hits[0].whole_line);
}

#[test]
fn a_long_text_tolerates_one_character_in_five_read_as_another() {
    let spots = [spot(vec![chars("好的我把刽义室订在三楼", 0.0, 0.0, 20.0)])];
    let hits = find(&spots, "好的，我把会议室订在三楼");
    assert_eq!(hits.len(), 1);
    assert!(hits[0].whole_line);
}

#[test]
fn a_long_text_tolerates_a_missing_character() {
    let spots = [spot(vec![chars("王磊明天上午十开会", 0.0, 0.0, 20.0)])];
    assert_eq!(find(&spots, "王磊明天上午十点开会").len(), 1);
}

#[test]
fn a_misread_first_or_last_character_or_too_many_misreads_find_nothing() {
    let spots = [spot(vec![chars("干磊明天上午十卓桁会", 0.0, 0.0, 20.0)])];
    assert!(find(&spots, "王磊明天上午十点开会").is_empty());
    let spots = [spot(vec![chars("今日要闻三景", 0.0, 0.0, 20.0)])];
    assert!(find(&spots, "今日要闻三条").is_empty());
}

#[test]
fn text_shorter_than_five_characters_tolerates_no_misread() {
    let spots = [spot(vec![chars("输入肖息", 0.0, 0.0, 20.0)])];
    assert!(find(&spots, "输入消息").is_empty());
}

#[test]
fn a_hyphen_read_as_the_han_character_for_one_still_matches() {
    let spots = [spot(vec![OcrLine {
        text: "lnvoice INV 2026 一 1111".into(),
        words: vec![
            word("lnvoice", 0.0, 0.0, 60.0),
            word("INV", 66.0, 0.0, 30.0),
            word("2026", 100.0, 0.0, 40.0),
            word("一", 144.0, 0.0, 14.0),
            word("1111", 160.0, 0.0, 40.0),
        ],
    }])];
    assert_eq!(find(&spots, "INV-2026-1111").len(), 1);
    assert_eq!(find(&spots, "2026一1111").len(), 1);
}

#[test]
fn a_long_text_whose_first_letter_was_swallowed_still_matches_but_a_short_one_does_not() {
    let spots = [spot(vec![OcrLine {
        text: "lnvoice NV 2026 1111".into(),
        words: vec![
            word("lnvoice", 0.0, 0.0, 60.0),
            word("NV", 66.0, 0.0, 30.0),
            word("2026", 100.0, 0.0, 40.0),
            word("1111", 160.0, 0.0, 40.0),
        ],
    }])];
    let hits = find(&spots, "INV-2026-1111");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].bounds.x, 66.0);
    assert!(find(&spots, "INV-2026").is_empty());
}

#[test]
fn the_han_character_for_one_between_han_characters_is_kept() {
    let spots = [spot(vec![chars("第一名", 0.0, 0.0, 20.0)])];
    assert_eq!(find(&spots, "第一名").len(), 1);
    assert!(find(&spots, "第名").is_empty());
}
