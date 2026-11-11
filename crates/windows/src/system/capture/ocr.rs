//! Text recognition through the OCR engine built into Windows. Each pass
//! reads its own resized, toned copy on its own thread, so several passes
//! cost about as much wall time as the slowest one.

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, OcrLine, OcrPass, OcrReading, OcrWord, Rect,
};
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::core::{Error, HSTRING};

use super::ocr_image::{self, Copy, Pixels};

fn failed(error: Error) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("Text recognition failed: {}", error.message()),
    )
}

fn engine(language: Option<&str>) -> Result<OcrEngine, AdapterError> {
    match language {
        Some(tag) => {
            let language = Language::CreateLanguage(&HSTRING::from(tag)).map_err(failed)?;
            OcrEngine::TryCreateFromLanguage(&language).map_err(|_| {
                AdapterError::new(
                    ErrorCode::InvalidArgs,
                    format!("No Windows OCR language pack is installed for {tag}"),
                )
            })
        }
        None => OcrEngine::TryCreateFromUserProfileLanguages().map_err(failed),
    }
}

/// Installed recognizer languages, the one Windows picks for the user's
/// profile first.
pub(crate) fn languages() -> Result<Vec<String>, AdapterError> {
    let mut tags = Vec::new();
    if let Ok(primary) = OcrEngine::TryCreateFromUserProfileLanguages()
        .and_then(|engine| engine.RecognizerLanguage())
        .and_then(|language| language.LanguageTag())
    {
        tags.push(primary.to_string_lossy());
    }
    for language in OcrEngine::AvailableRecognizerLanguages().map_err(failed)? {
        let tag = language.LanguageTag().map_err(failed)?.to_string_lossy();
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    if tags.is_empty() {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "No Windows OCR language pack is installed",
        ));
    }
    Ok(tags)
}

pub(crate) fn recognize(
    png: &[u8],
    passes: &[OcrPass],
    deadline: Deadline,
) -> Result<Vec<OcrReading>, AdapterError> {
    deadline.ensure_remaining()?;
    let pixels = ocr_image::decode(png)?;
    let largest = f64::from(OcrEngine::MaxImageDimension().map_err(failed)?);
    let results: Vec<Result<OcrReading, AdapterError>> = std::thread::scope(|scope| {
        let mut workers = Vec::with_capacity(passes.len());
        for pass in passes {
            let pixels = &pixels;
            workers.push(scope.spawn(move || read_pass(pixels, pass, largest)));
        }
        workers
            .into_iter()
            .map(|worker| {
                worker.join().unwrap_or_else(|_| {
                    Err(AdapterError::internal("A text recognition pass stopped"))
                })
            })
            .collect()
    });
    deadline.ensure_remaining()?;
    results.into_iter().collect()
}

fn read_pass(pixels: &Pixels, pass: &OcrPass, largest: f64) -> Result<OcrReading, AdapterError> {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let longest = f64::from(pixels.width.max(pixels.height));
    let scale = if pass.scale.is_finite() && pass.scale > 0.0 {
        pass.scale.min(largest / longest)
    } else {
        1.0
    };
    let started = std::time::Instant::now();
    let copy = ocr_image::prepare(pixels, scale, pass.tone);
    let engine = engine(pass.language.as_deref())?;
    let language = engine
        .RecognizerLanguage()
        .and_then(|language| language.LanguageTag())
        .map_err(failed)?
        .to_string_lossy();
    let bitmap = bitmap(&copy)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(failed)?
        .join()
        .map_err(failed)?;
    let angle = result
        .TextAngle()
        .and_then(|angle| angle.Value())
        .unwrap_or(0.0);
    let back_x = f64::from(pixels.width) / f64::from(copy.width);
    let back_y = f64::from(pixels.height) / f64::from(copy.height);
    let mut lines = Vec::new();
    for line in result.Lines().map_err(failed)? {
        let mut words = Vec::new();
        for word in line.Words().map_err(failed)? {
            let rect = word.BoundingRect().map_err(failed)?;
            let upright = ocr_image::unrotate(
                Rect {
                    x: f64::from(rect.X),
                    y: f64::from(rect.Y),
                    width: f64::from(rect.Width),
                    height: f64::from(rect.Height),
                },
                angle,
                (f64::from(copy.width) / 2.0, f64::from(copy.height) / 2.0),
            );
            words.push(OcrWord {
                text: word.Text().map_err(failed)?.to_string_lossy(),
                bounds: Rect {
                    x: upright.x * back_x,
                    y: upright.y * back_y,
                    width: upright.width * back_x,
                    height: upright.height * back_y,
                },
            });
        }
        lines.push(OcrLine {
            text: ocr_image::join_words(&words),
            words,
        });
    }
    tracing::debug!(
        language = %language,
        scale,
        tone = ?pass.tone,
        lines = lines.len(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "ocr: pass"
    );
    Ok(OcrReading { language, lines })
}

fn bitmap(copy: &Copy) -> Result<SoftwareBitmap, AdapterError> {
    let writer = DataWriter::new().map_err(failed)?;
    writer.WriteBytes(&copy.bytes).map_err(failed)?;
    let buffer = writer.DetachBuffer().map_err(failed)?;
    let format = if copy.gray {
        BitmapPixelFormat::Gray8
    } else {
        BitmapPixelFormat::Bgra8
    };
    let size = |value: u32| {
        i32::try_from(value)
            .map_err(|_| AdapterError::new(ErrorCode::InvalidArgs, "The image is too large"))
    };
    SoftwareBitmap::CreateCopyFromBuffer(&buffer, format, size(copy.width)?, size(copy.height)?)
        .map_err(failed)
}
