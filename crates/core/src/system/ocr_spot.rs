use super::ocr_line::OcrLine;
use crate::Rect;

/// One place in an image where text was read, with every distinct reading
/// the passes produced for it. The first reading is the one shown.
#[derive(Debug, Clone)]
pub struct OcrSpot {
    pub bounds: Rect,
    pub readings: Vec<OcrLine>,
}
