use super::ocr_tone::OcrTone;

/// One reading of an image: a recognition language and a resized, toned copy.
/// Boxes come back in the original image's pixels whatever `scale` is.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrPass {
    /// A language tag such as `zh-Hans-CN`; `None` is the user's first
    /// language that has a recognizer.
    pub language: Option<String>,
    /// The factor the copy is resized by before it is read.
    pub scale: f64,
    pub tone: OcrTone,
}
