/// How a copy of the image is toned before it is read. Windows OCR, like most
/// engines, misses light text on a coloured fill in colour and pale text on a
/// pale fill until the copy is greyed or darkened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrTone {
    /// The pixels as captured.
    Color,
    /// Luminance only.
    Gray,
    /// Luminance with the mid and light tones pushed darker, so pale text on
    /// a pale fill gains contrast.
    Dark,
}
