//! Finding a piece of text among recognized places.
//!
//! A place whose whole reading is the text beats a place where the text is
//! part of a longer line, so a search for a short button label does not land
//! on a sentence that happens to contain it. Every place of the best kind is
//! returned and the caller decides between them.
//!
//! Recognizers split a wide Han character into two narrow parts (把 into 扌
//! and 巴). A text of three or more characters still matches when up to one
//! character in three was read that way. Text of five or more characters
//! also matches with one character in five read as another or missing, up
//! to three, as long as the last character was read and the first one was
//! too, or, for text of eight or more, the second. Shorter text has to match
//! exactly, because a tolerance there would let a two-character label match
//! unrelated words.

use super::ocr_fold::{dash_free, fold, fold_char, is_cjk};
use super::ocr_line::OcrLine;
use super::ocr_merge::union;
use super::ocr_spot::OcrSpot;
use crate::Rect;

const NARROW: f64 = 0.75;
const WHOLE_WIDTH: f64 = 0.8;
const SPLIT_MIN_LENGTH: usize = 3;
const SPLIT_EVERY: usize = 3;
const DUPLICATE_OVERLAP: f64 = 0.5;
const EDIT_MIN_LENGTH: usize = 5;
const EDIT_EVERY: usize = 5;
const MAX_EDITS: usize = 3;
const LEADING_LOSS_MIN_LENGTH: usize = 8;

/// Han components that are never written on their own in running text, so a
/// recognizer that returns one has read the left half of a wider character.
const COMPONENTS: &str = "亻扌氵讠钅饣纟忄犭礻衤冫阝刂彳丬";

/// One place where the text was found.
#[derive(Debug, Clone)]
pub struct OcrMatch {
    /// The reading the text was found in.
    pub text: String,
    pub bounds: Rect,
    /// The reading is the text and nothing else.
    pub whole_line: bool,
}

struct Letter {
    ch: char,
    word: usize,
    narrow: bool,
}

/// Every place of the best kind that shows `query`, top to bottom.
pub(crate) fn find(spots: &[OcrSpot], query: &str) -> Vec<OcrMatch> {
    let needle = fold(query);
    if needle.is_empty() {
        return Vec::new();
    }
    let mut found: Vec<OcrMatch> = Vec::new();
    for spot in spots {
        let mut here: Vec<OcrMatch> = Vec::new();
        for reading in &spot.readings {
            for hit in find_in_line(reading, &needle, spot.bounds) {
                keep_best(&mut here, hit);
            }
        }
        found.extend(here);
    }
    let whole = found.iter().any(|hit| hit.whole_line);
    found.retain(|hit| hit.whole_line == whole);
    found.sort_by(|a, b| {
        a.bounds
            .y
            .total_cmp(&b.bounds.y)
            .then(a.bounds.x.total_cmp(&b.bounds.x))
    });
    found
}

fn keep_best(kept: &mut Vec<OcrMatch>, hit: OcrMatch) {
    match kept
        .iter_mut()
        .find(|other| overlap(other.bounds, hit.bounds) >= DUPLICATE_OVERLAP)
    {
        Some(other) if hit.whole_line && !other.whole_line => *other = hit,
        Some(_) => {}
        None => kept.push(hit),
    }
}

fn find_in_line(line: &OcrLine, needle: &[char], spot: Rect) -> Vec<OcrMatch> {
    let letters = letters(line);
    let reading = union(line.words.iter().map(|word| word.bounds));
    let budget = budget(needle.len());
    let mut hits = Vec::new();
    let mut start = 0;
    while start < letters.len() {
        let Some(end) = match_at(&letters, start, needle, &budget) else {
            start += 1;
            continue;
        };
        let bounds = union(
            line.words[letters[start].word..=letters[end - 1].word]
                .iter()
                .map(|word| word.bounds),
        );
        hits.push(OcrMatch {
            text: line.text.clone(),
            bounds,
            whole_line: start == 0
                && end == letters.len()
                && reading.width >= spot.width * WHOLE_WIDTH,
        });
        start = end;
    }
    hits
}

fn letters(line: &OcrLine) -> Vec<Letter> {
    let height = typical_height(line);
    let mut letters = Vec::new();
    for (index, word) in line.words.iter().enumerate() {
        let folded: Vec<char> = word.text.chars().filter_map(fold_char).collect();
        let narrow = folded.len() == 1 && word.bounds.width < height * NARROW;
        letters.extend(folded.into_iter().map(|ch| Letter {
            ch,
            word: index,
            narrow,
        }));
    }
    let keep = dash_free(&letters.iter().map(|letter| letter.ch).collect::<Vec<_>>());
    letters
        .into_iter()
        .zip(keep)
        .filter_map(|(letter, keep)| keep.then_some(letter))
        .collect()
}

fn typical_height(line: &OcrLine) -> f64 {
    let mut heights: Vec<f64> = line.words.iter().map(|word| word.bounds.height).collect();
    heights.sort_by(f64::total_cmp);
    heights.get(heights.len() / 2).copied().unwrap_or(0.0)
}

struct Budget {
    splits: usize,
    edits: usize,
}

fn budget(length: usize) -> Budget {
    Budget {
        splits: if length >= SPLIT_MIN_LENGTH {
            length / SPLIT_EVERY
        } else {
            0
        },
        edits: if length >= EDIT_MIN_LENGTH {
            (length / EDIT_EVERY).min(MAX_EDITS)
        } else {
            0
        },
    }
}

/// Where a match of `needle` that starts at `start` ends. The first
/// character has to be read right, whole or split, so a tolerance never
/// decides where a match begins.
fn match_at(letters: &[Letter], start: usize, needle: &[char], budget: &Budget) -> Option<usize> {
    let first = needle.first()?;
    let begins = letters.get(start).is_some_and(|letter| letter.ch == *first)
        || (budget.splits > 0 && is_cjk(*first) && split_pair(letters, start));
    if begins {
        return continue_match(letters, start, needle, budget.splits, budget.edits);
    }
    let second = needle.get(1)?;
    if needle.len() < LEADING_LOSS_MIN_LENGTH
        || budget.edits == 0
        || letters.get(start).is_none_or(|letter| letter.ch != *second)
    {
        return None;
    }
    continue_match(
        letters,
        start,
        &needle[1..],
        budget.splits,
        budget.edits - 1,
    )
}

fn continue_match(
    letters: &[Letter],
    at: usize,
    needle: &[char],
    splits: usize,
    edits: usize,
) -> Option<usize> {
    let Some((&wanted, rest)) = needle.split_first() else {
        return Some(at);
    };
    if letters.get(at).is_some_and(|letter| letter.ch == wanted)
        && let Some(end) = continue_match(letters, at + 1, rest, splits, edits)
    {
        return Some(end);
    }
    if splits > 0
        && is_cjk(wanted)
        && split_pair(letters, at)
        && let Some(end) = continue_match(letters, at + 2, rest, splits - 1, edits)
    {
        return Some(end);
    }
    if edits == 0 || rest.is_empty() {
        return None;
    }
    if at < letters.len()
        && let Some(end) = continue_match(letters, at + 1, rest, splits, edits - 1)
    {
        return Some(end);
    }
    continue_match(letters, at, rest, splits, edits - 1)
}

fn split_pair(letters: &[Letter], at: usize) -> bool {
    let (Some(left), Some(right)) = (letters.get(at), letters.get(at + 1)) else {
        return false;
    };
    is_cjk(left.ch)
        && is_cjk(right.ch)
        && left.word != right.word
        && (COMPONENTS.contains(left.ch) || (left.narrow && right.narrow))
}

fn overlap(a: Rect, b: Rect) -> f64 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if width <= 0.0 || height <= 0.0 {
        return 0.0;
    }
    let smaller = (a.width * a.height).min(b.width * b.height);
    if smaller <= 0.0 {
        return 0.0;
    }
    width * height / smaller
}

#[cfg(test)]
#[path = "ocr_match_tests.rs"]
mod tests;
