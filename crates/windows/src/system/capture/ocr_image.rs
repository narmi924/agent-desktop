//! The copies of an image that text recognition reads: resized and toned
//! from one decode of the PNG.

use agent_desktop_core::{AdapterError, ErrorCode, OcrTone, Rect};

const DARK_POWER: f64 = 3.0;

/// Decoded pixels, four bytes each in red, green, blue, alpha order.
pub(crate) struct Pixels {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rgba: Vec<u8>,
}

/// A copy ready for the recognizer: four bytes per pixel in blue, green,
/// red, alpha order, or one byte per pixel when greyed.
pub(crate) struct Copy {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) gray: bool,
    pub(crate) bytes: Vec<u8>,
}

fn unreadable() -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, "The image is not a readable PNG")
}

pub(crate) fn decode(png: &[u8]) -> Result<Pixels, AdapterError> {
    use png::{ColorType, Decoder, Transformations};

    let mut decoder = Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| unreadable())?;
    let mut frame = vec![0; reader.output_buffer_size().ok_or_else(unreadable)?];
    let info = reader.next_frame(&mut frame).map_err(|_| unreadable())?;
    let channels = match info.color_type {
        ColorType::Rgba => 4,
        ColorType::Rgb => 3,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Grayscale => 1,
        ColorType::Indexed => return Err(unreadable()),
    };
    let count = (info.width as usize)
        .checked_mul(info.height as usize)
        .ok_or_else(unreadable)?;
    let mut rgba = Vec::with_capacity(count * 4);
    for sample in frame.chunks_exact(channels).take(count) {
        let pixel = match *sample {
            [r, g, b, a] => [r, g, b, a],
            [r, g, b] => [r, g, b, 255],
            [l, a] => [l, l, l, a],
            [l] => [l, l, l, 255],
            _ => [0, 0, 0, 0],
        };
        rgba.extend_from_slice(&pixel);
    }
    Ok(Pixels {
        width: info.width,
        height: info.height,
        rgba,
    })
}

/// The copy one pass reads. `scale` is already clamped by the caller.
pub(crate) fn prepare(pixels: &Pixels, scale: f64, tone: OcrTone) -> Copy {
    let (width, height) = scaled_size(pixels.width, pixels.height, scale);
    match tone {
        OcrTone::Color => {
            let channels: Vec<Vec<u8>> = (0..4)
                .map(|channel| {
                    let plane: Vec<u8> = pixels
                        .rgba
                        .iter()
                        .skip(channel)
                        .step_by(4)
                        .copied()
                        .collect();
                    resample(&plane, (pixels.width, pixels.height), (width, height))
                })
                .collect();
            let mut bytes = Vec::with_capacity(width as usize * height as usize * 4);
            for index in 0..(width as usize * height as usize) {
                bytes.extend_from_slice(&[
                    channels[2][index],
                    channels[1][index],
                    channels[0][index],
                    255,
                ]);
            }
            Copy {
                width,
                height,
                gray: false,
                bytes,
            }
        }
        OcrTone::Gray | OcrTone::Dark => {
            let plane: Vec<u8> = pixels.rgba.chunks_exact(4).map(luminance).collect();
            let mut bytes = resample(&plane, (pixels.width, pixels.height), (width, height));
            if tone == OcrTone::Dark {
                let table = dark_table();
                bytes
                    .iter_mut()
                    .for_each(|value| *value = table[*value as usize]);
            }
            Copy {
                width,
                height,
                gray: true,
                bytes,
            }
        }
    }
}

pub(crate) fn scaled_size(width: u32, height: u32, scale: f64) -> (u32, u32) {
    let size = |value: u32| ((f64::from(value) * scale).round() as u32).max(1);
    if (scale - 1.0).abs() < 1e-6 {
        (width, height)
    } else {
        (size(width), size(height))
    }
}

/// ITU-R BT.601 luma, the weighting most greyscale conversions use.
fn luminance(pixel: &[u8]) -> u8 {
    let [r, g, b] = [pixel[0], pixel[1], pixel[2]].map(u32::from);
    ((r * 299 + g * 587 + b * 114 + 500) / 1000) as u8
}

fn dark_table() -> [u8; 256] {
    let mut table = [0u8; 256];
    for (value, entry) in table.iter_mut().enumerate() {
        *entry = (255.0 * (value as f64 / 255.0).powf(DARK_POWER)).round() as u8;
    }
    table
}

/// Area averaging when shrinking, bilinear when enlarging, a copy otherwise.
pub(crate) fn resample(plane: &[u8], from: (u32, u32), to: (u32, u32)) -> Vec<u8> {
    if from == to {
        return plane.to_vec();
    }
    let (fw, fh) = (from.0 as usize, from.1 as usize);
    let (tw, th) = (to.0 as usize, to.1 as usize);
    let sx = fw as f64 / tw as f64;
    let sy = fh as f64 / th as f64;
    let mut out = vec![0u8; tw * th];
    if sx >= 1.0 && sy >= 1.0 {
        for y in 0..th {
            let (top, bottom) = span(y, sy, fh);
            for x in 0..tw {
                let (left, right) = span(x, sx, fw);
                let mut sum = 0u32;
                for row in top..bottom {
                    sum += plane[row * fw + left..row * fw + right]
                        .iter()
                        .map(|value| u32::from(*value))
                        .sum::<u32>();
                }
                let count = ((bottom - top) * (right - left)).max(1) as u32;
                out[y * tw + x] = ((sum + count / 2) / count) as u8;
            }
        }
        return out;
    }
    for y in 0..th {
        let source_y = ((y as f64 + 0.5) * sy - 0.5).clamp(0.0, (fh - 1) as f64);
        let (y0, wy) = (source_y.floor() as usize, source_y.fract());
        let y1 = (y0 + 1).min(fh - 1);
        for x in 0..tw {
            let source_x = ((x as f64 + 0.5) * sx - 0.5).clamp(0.0, (fw - 1) as f64);
            let (x0, wx) = (source_x.floor() as usize, source_x.fract());
            let x1 = (x0 + 1).min(fw - 1);
            let at = |row: usize, column: usize| f64::from(plane[row * fw + column]);
            let top = at(y0, x0) * (1.0 - wx) + at(y0, x1) * wx;
            let bottom = at(y1, x0) * (1.0 - wx) + at(y1, x1) * wx;
            out[y * tw + x] = (top * (1.0 - wy) + bottom * wy).round() as u8;
        }
    }
    out
}

/// The recognizer puts a space between every two words and reads each Han
/// character as a word of its own. Words join without a space where both
/// sides are CJK, so a Chinese line reads as written and English keeps its
/// spaces.
pub(crate) fn join_words(words: &[agent_desktop_core::OcrWord]) -> String {
    let mut text = String::new();
    for word in words {
        let joins = text.chars().last().is_some_and(is_wide)
            && word.text.chars().next().is_some_and(is_wide);
        if !text.is_empty() && !joins {
            text.push(' ');
        }
        text.push_str(&word.text);
    }
    text
}

fn is_wide(ch: char) -> bool {
    matches!(u32::from(ch),
        0x3000..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

/// The recognizer straightens text it believes is tilted and reports boxes
/// in the straightened image, turned by `angle_degrees` clockwise about the
/// image centre. A screen capture is never tilted, so a detected angle is the
/// recognizer's mistake and every box is turned back onto the pixels it
/// covers.
pub(crate) fn unrotate(rect: Rect, angle_degrees: f64, center: (f64, f64)) -> Rect {
    if angle_degrees == 0.0 || !angle_degrees.is_finite() {
        return rect;
    }
    let (sin, cos) = angle_degrees.to_radians().sin_cos();
    let (dx, dy) = (
        rect.x + rect.width / 2.0 - center.0,
        rect.y + rect.height / 2.0 - center.1,
    );
    let x = center.0 + dx * cos - dy * sin;
    let y = center.1 + dx * sin + dy * cos;
    Rect {
        x: x - rect.width / 2.0,
        y: y - rect.height / 2.0,
        ..rect
    }
}

fn span(index: usize, step: f64, limit: usize) -> (usize, usize) {
    let start = ((index as f64 * step).floor() as usize).min(limit - 1);
    let end = (((index + 1) as f64 * step).ceil() as usize).clamp(start + 1, limit);
    (start, end)
}

#[cfg(test)]
#[path = "ocr_image_tests.rs"]
mod tests;
