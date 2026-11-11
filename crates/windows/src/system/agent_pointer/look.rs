//! Which pointer the agent shows while it holds the mouse and keyboard, read
//! from `AGENT_DESKTOP_POINTER`: `off`, one of the built-in looks, or the
//! path of a square PNG drawn on the same grid as the built-in ones.

use std::path::PathBuf;

pub(crate) const VARIABLE: &str = "AGENT_DESKTOP_POINTER";

const AMBER: &[u8] = include_bytes!("../../../assets/agent-pointer-amber.png");
const RED: &[u8] = include_bytes!("../../../assets/agent-pointer-red.png");
const GREEN: &[u8] = include_bytes!("../../../assets/agent-pointer-green.png");

/// Where the arrow tip sits in every look, as a share of the image width and
/// height: 112 of 352 pixels in the built-in images.
pub(crate) const TIP_SHARE: f64 = 112.0 / 352.0;

/// How wide the image is drawn, in multiples of the system pointer size. At
/// 225% the system pointer is 72 pixels and the image 176, which makes the
/// arrow inside the glow as large as the pointer it replaces.
pub(crate) const SIZE_PER_POINTER: f64 = 176.0 / 72.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Look {
    Off,
    BuiltIn(&'static str),
    File(PathBuf),
}

/// Parses the setting. Anything unrecognised falls back to the amber look,
/// so a typo never silently turns the signal off.
pub(crate) fn parse(value: Option<&str>) -> Look {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Look::BuiltIn("amber");
    };
    match value.to_ascii_lowercase().as_str() {
        "off" | "0" | "false" | "no" => Look::Off,
        "amber" | "a" => Look::BuiltIn("amber"),
        "red" | "b" => Look::BuiltIn("red"),
        "green" | "c" => Look::BuiltIn("green"),
        lower if lower.ends_with(".png") => Look::File(PathBuf::from(value)),
        _ => Look::BuiltIn("amber"),
    }
}

pub(crate) fn current() -> Look {
    parse(std::env::var(VARIABLE).ok().as_deref())
}

/// The PNG bytes for a look, or `None` when it is off or the file cannot be
/// read, in which case the built-in amber look is used instead.
pub(crate) fn image(look: &Look) -> Option<Vec<u8>> {
    match look {
        Look::Off => None,
        Look::BuiltIn("red") => Some(RED.to_vec()),
        Look::BuiltIn("green") => Some(GREEN.to_vec()),
        Look::BuiltIn(_) => Some(AMBER.to_vec()),
        Look::File(path) => Some(std::fs::read(path).unwrap_or_else(|_| AMBER.to_vec())),
    }
}

/// The drawn size in pixels for a system pointer of `pointer_px` pixels.
pub(crate) fn drawn_size(pointer_px: u32) -> u32 {
    ((f64::from(pointer_px.max(16)) * SIZE_PER_POINTER).round() as u32).clamp(32, 256)
}

#[cfg(test)]
#[path = "look_tests.rs"]
mod tests;
