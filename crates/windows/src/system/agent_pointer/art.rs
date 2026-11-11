//! The pointer image at the size the screen needs, as straight-alpha pixels
//! in blue, green, red, alpha order, top row first.

use super::look::TIP_SHARE;

pub(crate) struct Art {
    pub(crate) size: u32,
    pub(crate) bgra: Vec<u8>,
    pub(crate) hotspot: (u32, u32),
}

struct Decoded {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

fn decode(png: &[u8]) -> Option<Decoded> {
    use png::{ColorType, Decoder, Transformations};

    let mut decoder = Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut frame = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut frame).ok()?;
    let channels = match info.color_type {
        ColorType::Rgba => 4,
        ColorType::Rgb => 3,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Grayscale => 1,
        ColorType::Indexed => return None,
    };
    let count = (info.width as usize).checked_mul(info.height as usize)?;
    let mut rgba = Vec::with_capacity(count * 4);
    for sample in frame.chunks_exact(channels).take(count) {
        rgba.extend_from_slice(&match *sample {
            [r, g, b, a] => [r, g, b, a],
            [r, g, b] => [r, g, b, 255],
            [l, a] => [l, l, l, a],
            [l] => [l, l, l, 255],
            _ => [0, 0, 0, 0],
        });
    }
    Some(Decoded {
        width: info.width,
        height: info.height,
        rgba,
    })
}

/// Shrinks `png` to a `size` square by area averaging in premultiplied
/// space, so the soft glow keeps its colour at its fading edge.
pub(crate) fn render(png: &[u8], size: u32) -> Option<Art> {
    let source = decode(png)?;
    if source.width == 0 || source.height == 0 || size == 0 {
        return None;
    }
    let side = size as usize;
    let step_x = f64::from(source.width) / f64::from(size);
    let step_y = f64::from(source.height) / f64::from(size);
    let mut bgra = vec![0u8; side * side * 4];
    for y in 0..side {
        let (top, bottom) = span(y, step_y, source.height as usize);
        for x in 0..side {
            let (left, right) = span(x, step_x, source.width as usize);
            let mut sums = [0f64; 4];
            for row in top..bottom {
                for column in left..right {
                    let at = (row * source.width as usize + column) * 4;
                    let alpha = f64::from(source.rgba[at + 3]) / 255.0;
                    for (sum, value) in sums.iter_mut().zip(&source.rgba[at..at + 3]) {
                        *sum += f64::from(*value) * alpha;
                    }
                    sums[3] += alpha;
                }
            }
            let count = ((bottom - top) * (right - left)) as f64;
            let alpha = sums[3] / count;
            let out = (y * side + x) * 4;
            if alpha > 0.0 {
                for channel in 0..3 {
                    let straight = sums[channel] / count / alpha;
                    bgra[out + 2 - channel] = straight.round().clamp(0.0, 255.0) as u8;
                }
            }
            bgra[out + 3] = (alpha * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    let tip = (f64::from(size) * TIP_SHARE).round() as u32;
    Some(Art {
        size,
        bgra,
        hotspot: (tip, tip),
    })
}

fn span(index: usize, step: f64, limit: usize) -> (usize, usize) {
    let start = ((index as f64 * step).floor() as usize).min(limit - 1);
    let end = (((index + 1) as f64 * step).ceil() as usize).clamp(start + 1, limit);
    (start, end)
}

#[cfg(test)]
#[path = "art_tests.rs"]
mod tests;
