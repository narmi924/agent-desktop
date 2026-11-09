use crate::Rect;
use serde::Serialize;

/// One recognized word with its box in image pixels.
#[derive(Debug, Clone, Serialize)]
pub struct OcrWord {
    pub text: String,
    pub bounds: Rect,
}
