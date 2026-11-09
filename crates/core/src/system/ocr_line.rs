use super::ocr_word::OcrWord;
use serde::Serialize;

/// One line of recognized text in reading order.
#[derive(Debug, Clone, Serialize)]
pub struct OcrLine {
    pub text: String,
    pub words: Vec<OcrWord>,
}
