//! Drops files onto a window at a point chosen on a captured image or at the
//! centre of an element, without the pointer, the keyboard or the foreground.

use super::drag::frame::{frame_from_image, image_point, read_frame_image};
use super::frame_pointer::picture_changed;
use super::operation_response::operation_response;
use crate::{AppError, CommandContext, FileDrop, PlatformAdapter, Point};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The most files one drop carries.
pub const MAX_DROP_FILES: usize = 256;

/// Where the files land.
pub enum DropPlace<'a> {
    /// A point in the pixels of an image the companion's view command saved.
    Frame { image: &'a Path, x: f64, y: f64 },
    /// The centre of the element a snapshot ref names.
    Ref(&'a str),
}

pub struct DropFilesArgs<'a> {
    pub files: Vec<PathBuf>,
    pub place: DropPlace<'a>,
}

pub fn execute(
    args: DropFilesArgs<'_>,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let files = checked_files(args.files)?;
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let deadline = lease.deadline();
    let (window, point) = match args.place {
        DropPlace::Frame { image, x, y } => {
            let image = read_frame_image(image)?;
            let frame = frame_from_image(&image)?;
            let local = image_point(&frame, x, y)?;
            let point = adapter.frame_window_point(&frame, &local, deadline)?;
            if !adapter.frame_patch_matches(&frame, &image, &local, deadline)? {
                return Err(picture_changed());
            }
            (frame.window.id, point)
        }
        DropPlace::Ref(ref_id) => ref_place(ref_id, adapter, context, deadline)?,
    };
    let drop = FileDrop {
        files,
        window,
        point,
    };
    let report = adapter.drop_files(&drop, &lease)?;
    operation_response(
        &report,
        json!({ "window": drop.window, "files": drop.files.len() }),
    )
}

fn ref_place(
    ref_id: &str,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
    deadline: crate::Deadline,
) -> Result<(String, Point), AppError> {
    let (entry, handle) = super::helpers::resolve_ref_with_context(ref_id, adapter, context)?;
    let window = entry.source.source_window_id.ok_or_else(|| {
        AppError::invalid_input(format!(
            "{ref_id} was not captured from a window; take a window snapshot and use its ref"
        ))
    })?;
    let bounds = adapter
        .get_element_bounds(&handle, deadline)?
        .filter(|bounds| bounds.width > 0.0 && bounds.height > 0.0)
        .ok_or_else(|| AppError::invalid_input(format!("Element {ref_id} has no bounds")))?;
    Ok((
        window,
        Point {
            x: bounds.x + bounds.width / 2.0,
            y: bounds.y + bounds.height / 2.0,
        },
    ))
}

/// Makes every path absolute and refuses missing ones. A missing entry is
/// named by its index only, because the path itself may be private and this
/// error can reach a trace file.
fn checked_files(files: Vec<PathBuf>) -> Result<Vec<PathBuf>, AppError> {
    if files.is_empty() {
        return Err(AppError::invalid_input("Name at least one file to drop"));
    }
    if files.len() > MAX_DROP_FILES {
        return Err(AppError::invalid_input(format!(
            "One drop carries at most {MAX_DROP_FILES} files"
        )));
    }
    let mut missing = Vec::new();
    let mut absolute = Vec::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        match std::path::absolute(file) {
            Ok(path) if path.exists() => absolute.push(path),
            _ => missing.push(index),
        }
    }
    if !missing.is_empty() {
        return Err(AppError::invalid_input(format!(
            "{} of {} files do not exist (indexes: {missing:?})",
            missing.len(),
            files.len()
        )));
    }
    Ok(absolute)
}

#[cfg(test)]
#[path = "drop_files_tests.rs"]
mod tests;
