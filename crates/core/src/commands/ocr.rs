use crate::{
    AppError, CommandContext, OcrPass, OcrSpot, OcrTone, PlatformAdapter,
    commands::screenshot::{ScreenshotArgs, capture_image},
    system::{ocr_match, ocr_merge},
};
use serde_json::{Value, json};
use std::path::PathBuf;

const MAX_IMAGE_BYTES: u64 = 96 * 1024 * 1024;

/// The sizes, relative to a 100% display, at which the primary language
/// reads the image, and how each copy is toned. Chosen by reading a
/// self-drawn window at 100%, 150% and 225% at nine sizes and three tones:
/// a darkened copy at twice and at one and a half times the design size
/// reads small and pale text best, a grey copy at one and a quarter splits
/// fewer wide characters, and the untouched capture keeps what a plain read
/// found.
const PRIMARY_PASSES: [(Option<f64>, OcrTone); 4] = [
    (Some(2.0), OcrTone::Dark),
    (Some(1.5), OcrTone::Dark),
    (None, OcrTone::Color),
    (Some(1.25), OcrTone::Gray),
];

pub struct OcrArgs {
    pub image: Option<PathBuf>,
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub find: Option<String>,
    pub language: Option<String>,
    /// The display scale a saved image was captured at.
    pub scale: Option<f64>,
}

/// Reads visible text from a window or a saved image, for interfaces that
/// expose no accessibility tree. Boxes are in image pixels.
pub fn execute(
    args: OcrArgs,
    adapter: &dyn PlatformAdapter,
    _context: &CommandContext,
) -> Result<Value, AppError> {
    let deadline = crate::Deadline::standard()?;
    let (png, scale) = match &args.image {
        Some(path) => (
            read_image(path)?,
            args.scale
                .unwrap_or_else(|| primary_display_scale(adapter, deadline)),
        ),
        None => {
            let image = capture_image(
                &ScreenshotArgs {
                    app: args.app.clone(),
                    window_id: args.window_id.clone(),
                    screen: None,
                    output_path: None,
                },
                adapter,
                deadline,
            )?;
            let scale = image.scale_factor;
            (image.data, scale)
        }
    };
    let languages = match &args.language {
        Some(tag) => vec![tag.clone()],
        None => adapter.recognition_languages(deadline)?,
    };
    let passes = plan_passes(&languages, scale);
    let readings = adapter.recognize_text(&png, &passes, deadline)?;
    let spots = ocr_merge::merge(&readings);
    Ok(render(&spots, args.find.as_deref(), passes.len()))
}

fn primary_display_scale(adapter: &dyn PlatformAdapter, deadline: crate::Deadline) -> f64 {
    adapter
        .list_displays(deadline)
        .ok()
        .and_then(|displays| {
            displays
                .iter()
                .find(|display| display.is_primary)
                .or(displays.first())
                .map(|display| display.scale)
        })
        .unwrap_or(1.0)
}

/// Every pass to run: the first language four times at different sizes and
/// tones, each further installed language once on the capture as it is, so
/// English words inside Chinese text are read by an English recognizer.
pub(crate) fn plan_passes(languages: &[String], display_scale: f64) -> Vec<OcrPass> {
    let display_scale = if display_scale.is_finite() && display_scale > 0.0 {
        display_scale
    } else {
        1.0
    };
    let mut passes = Vec::new();
    let primary = languages.first().cloned();
    for (size, tone) in PRIMARY_PASSES {
        passes.push(OcrPass {
            language: primary.clone(),
            scale: size.map_or(1.0, |size| size / display_scale),
            tone,
        });
    }
    for language in languages.iter().skip(1) {
        passes.push(OcrPass {
            language: Some(language.clone()),
            scale: 1.0,
            tone: OcrTone::Color,
        });
    }
    passes
}

fn read_image(path: &std::path::Path) -> Result<Vec<u8>, AppError> {
    let unreadable = || AppError::invalid_input("The image could not be read");
    if std::fs::metadata(path).map_err(|_| unreadable())?.len() > MAX_IMAGE_BYTES {
        return Err(AppError::invalid_input("The image is too large"));
    }
    std::fs::read(path).map_err(|_| unreadable())
}

pub(crate) fn render(spots: &[OcrSpot], find: Option<&str>, passes: usize) -> Value {
    let text = spots
        .iter()
        .filter_map(|spot| spot.readings.first())
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let lines: Vec<Value> = spots.iter().filter_map(render_spot).collect();
    let mut body = json!({ "text": text, "lines": lines, "passes": passes });
    if let Some(query) = find {
        let matches: Vec<Value> = ocr_match::find(spots, query)
            .into_iter()
            .map(|hit| {
                json!({
                    "text": hit.text,
                    "bounds": hit.bounds,
                    "center": {
                        "x": (hit.bounds.x + hit.bounds.width / 2.0).floor(),
                        "y": (hit.bounds.y + hit.bounds.height / 2.0).floor(),
                    },
                    "whole_line": hit.whole_line,
                })
            })
            .collect();
        body["matches"] = json!(matches);
    }
    body
}

fn render_spot(spot: &OcrSpot) -> Option<Value> {
    let shown = spot.readings.first()?;
    let mut line = json!({ "text": shown.text, "bounds": spot.bounds, "words": shown.words });
    let also: Vec<&str> = spot
        .readings
        .iter()
        .skip(1)
        .map(|reading| reading.text.as_str())
        .collect();
    if !also.is_empty() {
        line["also"] = json!(also);
    }
    Some(line)
}

#[cfg(test)]
#[path = "ocr_tests.rs"]
mod tests;
