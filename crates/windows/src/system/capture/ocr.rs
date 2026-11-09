//! Text recognition through the OCR engine built into Windows.

use agent_desktop_core::{AdapterError, ErrorCode, OcrLine, OcrWord, Rect};
use windows::Globalization::Language;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::core::{Error, HSTRING};

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

pub(crate) fn recognize(png: &[u8], language: Option<&str>) -> Result<Vec<OcrLine>, AdapterError> {
    let stream = InMemoryRandomAccessStream::new().map_err(failed)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(failed)?;
    writer.WriteBytes(png).map_err(failed)?;
    writer
        .StoreAsync()
        .map_err(failed)?
        .join()
        .map_err(failed)?;
    writer.DetachStream().map_err(failed)?;
    stream.Seek(0).map_err(failed)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(failed)?
        .join()
        .map_err(failed)?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(failed)?
        .join()
        .map_err(failed)?;
    let result = engine(language)?
        .RecognizeAsync(&bitmap)
        .map_err(failed)?
        .join()
        .map_err(failed)?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(failed)? {
        let mut words = Vec::new();
        for word in line.Words().map_err(failed)? {
            let rect = word.BoundingRect().map_err(failed)?;
            words.push(OcrWord {
                text: word.Text().map_err(failed)?.to_string_lossy(),
                bounds: Rect {
                    x: f64::from(rect.X),
                    y: f64::from(rect.Y),
                    width: f64::from(rect.Width),
                    height: f64::from(rect.Height),
                },
            });
        }
        lines.push(OcrLine {
            text: line.Text().map_err(failed)?.to_string_lossy(),
            words,
        });
    }
    Ok(lines)
}
