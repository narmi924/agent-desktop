//! Several passes over the same image read the same place differently: one
//! splits a character into its parts, another reads it whole; one misses a
//! button, another finds it. Lines are grouped by position, and every
//! distinct reading of a place is kept so a search can match any of them.

use super::ocr_fold::{fits_language, fold};
use super::ocr_line::OcrLine;
use super::ocr_reading::OcrReading;
use super::ocr_spot::OcrSpot;
use crate::Rect;

const SHARED_HEIGHT: f64 = 0.5;
const SHARED_WIDTH: f64 = 0.5;

struct Candidate {
    line: OcrLine,
    bounds: Rect,
    fits: bool,
    primary: bool,
    key: String,
}

/// Groups the lines of every reading by position. `readings[0]` is the
/// primary language's first pass; readings in other languages only add to
/// places, they never create one from text their script cannot hold.
pub(crate) fn merge(readings: &[OcrReading]) -> Vec<OcrSpot> {
    let primary = readings.first().map(|reading| reading.language.as_str());
    let mut groups: Vec<Vec<Candidate>> = Vec::new();
    for reading in readings {
        for line in &reading.lines {
            let Some(candidate) = candidate(line, &reading.language, primary) else {
                continue;
            };
            match groups.iter_mut().find(|group| {
                group
                    .iter()
                    .any(|member| same_place(member.bounds, candidate.bounds))
            }) {
                Some(group) => group.push(candidate),
                None => groups.push(vec![candidate]),
            }
        }
    }
    let mut spots: Vec<OcrSpot> = groups.into_iter().filter_map(spot).collect();
    spots.sort_by(|a, b| {
        a.bounds
            .y
            .total_cmp(&b.bounds.y)
            .then(a.bounds.x.total_cmp(&b.bounds.x))
    });
    spots
}

fn candidate(line: &OcrLine, language: &str, primary: Option<&str>) -> Option<Candidate> {
    let key: String = fold(&line.text).into_iter().collect();
    if key.is_empty() || line.words.is_empty() {
        return None;
    }
    Some(Candidate {
        bounds: line_bounds(line),
        fits: fits_language(&line.text, language),
        primary: primary == Some(language),
        key,
        line: line.clone(),
    })
}

fn spot(group: Vec<Candidate>) -> Option<OcrSpot> {
    if !group.iter().any(|member| member.primary || member.fits) {
        return None;
    }
    let votes = |key: &str| group.iter().filter(|member| member.key == key).count();
    let mut order: Vec<usize> = (0..group.len()).collect();
    order.sort_by(|&a, &b| {
        let (a, b) = (&group[a], &group[b]);
        votes(&b.key).cmp(&votes(&a.key)).then(b.fits.cmp(&a.fits))
    });
    let mut seen: Vec<&str> = Vec::new();
    let mut readings = Vec::new();
    let mut bounds = None;
    for index in order {
        let member = &group[index];
        if seen.contains(&member.key.as_str()) {
            continue;
        }
        seen.push(&member.key);
        bounds.get_or_insert(member.bounds);
        readings.push(member.line.clone());
    }
    Some(OcrSpot {
        bounds: bounds?,
        readings,
    })
}

fn same_place(a: Rect, b: Rect) -> bool {
    let shared = |start_a: f64, len_a: f64, start_b: f64, len_b: f64| {
        (start_a + len_a).min(start_b + len_b) - start_a.max(start_b)
    };
    let height = a.height.min(b.height);
    let width = a.width.min(b.width);
    height > 0.0
        && width > 0.0
        && shared(a.y, a.height, b.y, b.height) >= height * SHARED_HEIGHT
        && shared(a.x, a.width, b.x, b.width) >= width * SHARED_WIDTH
}

pub(crate) fn line_bounds(line: &OcrLine) -> Rect {
    union(line.words.iter().map(|word| word.bounds))
}

pub(crate) fn union(boxes: impl Iterator<Item = Rect>) -> Rect {
    let (mut left, mut top, mut right, mut bottom) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for rect in boxes {
        left = left.min(rect.x);
        top = top.min(rect.y);
        right = right.max(rect.x + rect.width);
        bottom = bottom.max(rect.y + rect.height);
    }
    if left > right {
        return Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
    }
    Rect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
}

#[cfg(test)]
#[path = "ocr_merge_tests.rs"]
mod tests;
