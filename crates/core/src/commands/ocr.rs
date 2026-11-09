use crate::{
    AppError, CommandContext, OcrLine, PlatformAdapter, Rect,
    commands::screenshot::{ScreenshotArgs, capture_png},
};
use serde_json::{Value, json};
use std::path::PathBuf;

const MAX_IMAGE_BYTES: u64 = 96 * 1024 * 1024;

pub struct OcrArgs {
    pub image: Option<PathBuf>,
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub find: Option<String>,
    pub language: Option<String>,
}

/// Reads visible text from a window or a saved image, for interfaces that
/// expose no accessibility tree. Boxes are in image pixels.
pub fn execute(
    args: OcrArgs,
    adapter: &dyn PlatformAdapter,
    _context: &CommandContext,
) -> Result<Value, AppError> {
    let deadline = crate::Deadline::standard()?;
    let png = match &args.image {
        Some(path) => read_image(path)?,
        None => capture_png(
            &ScreenshotArgs {
                app: args.app.clone(),
                window_id: args.window_id.clone(),
                screen: None,
                output_path: None,
            },
            adapter,
            deadline,
        )?,
    };
    let lines = adapter.recognize_text(&png, args.language.as_deref(), deadline)?;
    Ok(render(&lines, args.find.as_deref()))
}

fn read_image(path: &std::path::Path) -> Result<Vec<u8>, AppError> {
    let unreadable = || AppError::invalid_input("The image could not be read");
    if std::fs::metadata(path).map_err(|_| unreadable())?.len() > MAX_IMAGE_BYTES {
        return Err(AppError::invalid_input("The image is too large"));
    }
    std::fs::read(path).map_err(|_| unreadable())
}

fn render(lines: &[OcrLine], find: Option<&str>) -> Value {
    let text = lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let mut body = json!({ "text": text, "lines": lines });
    if let Some(query) = find {
        body["matches"] = json!(find_matches(lines, query));
    }
    body
}

/// OCR splits Chinese into single characters and confuses `I` with `l`, so
/// matching ignores spacing and case and treats those letters as one.
fn normalize(text: &str) -> Vec<char> {
    text.chars()
        .filter(|ch| !ch.is_whitespace())
        .map(|ch| match ch {
            'I' | '|' => 'l',
            other => other.to_lowercase().next().unwrap_or(other),
        })
        .collect()
}

fn find_matches(lines: &[OcrLine], query: &str) -> Vec<Value> {
    let needle = normalize(query);
    if needle.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for line in lines {
        let mut letters = Vec::new();
        let mut owner = Vec::new();
        for (index, word) in line.words.iter().enumerate() {
            for letter in normalize(&word.text) {
                letters.push(letter);
                owner.push(index);
            }
        }
        for start in 0..letters.len().saturating_sub(needle.len() - 1) {
            if letters[start..start + needle.len()] != needle[..] {
                continue;
            }
            let bounds = union(
                line.words[owner[start]..=owner[start + needle.len() - 1]]
                    .iter()
                    .map(|word| word.bounds),
            );
            found.push(json!({
                "text": line.text,
                "bounds": bounds,
                "center": {
                    "x": (bounds.x + bounds.width / 2.0).floor(),
                    "y": (bounds.y + bounds.height / 2.0).floor(),
                },
            }));
        }
    }
    found
}

fn union(boxes: impl Iterator<Item = Rect>) -> Rect {
    let (mut left, mut top, mut right, mut bottom) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for rect in boxes {
        left = left.min(rect.x);
        top = top.min(rect.y);
        right = right.max(rect.x + rect.width);
        bottom = bottom.max(rect.y + rect.height);
    }
    Rect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
}

#[cfg(test)]
#[path = "ocr_tests.rs"]
mod tests;
