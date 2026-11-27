use std::path::PathBuf;

use crate::Point;

/// Files dropped onto one window at a screen point in physical pixels, the
/// way a person drops them there from a file manager.
#[derive(Debug, Clone, PartialEq)]
pub struct FileDrop {
    pub files: Vec<PathBuf>,
    pub window: String,
    pub point: Point,
}
