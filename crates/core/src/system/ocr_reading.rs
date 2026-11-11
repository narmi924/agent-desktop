use super::ocr_line::OcrLine;

/// What one pass read, with the language tag the recognizer actually used.
#[derive(Debug, Clone)]
pub struct OcrReading {
    pub language: String,
    pub lines: Vec<OcrLine>,
}
