//! Moves the real cursor along a planned human-like path and stops if a person
//! takes the mouse, holds Escape or presses a button.

use super::keyboard::escape_held;
use super::keyboard::keyboard_send::key_is_down;
use super::mouse::mouse_coord::normalize_point;
use super::mouse::mouse_send::{move_input, post_mouse_inputs};
use super::page_pointer::{near, refused};
use crate::system::window::window_ops::{is_root_foreground_window, parse_handle};
use agent_desktop_core::{AdapterError, Deadline, PathSample, Point};
use std::time::{Duration, Instant};

const VK_LBUTTON: u16 = 1;
const VK_RBUTTON: u16 = 2;
const VK_MBUTTON: u16 = 4;

pub(crate) fn follow(
    path: &[PathSample],
    window: Option<&str>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let started = Instant::now();
    let guard = window.map(parse_handle);
    let mut previous = read_cursor();
    for (index, sample) in path.iter().enumerate() {
        let moved = index > 0;
        if let Some(wait) = Duration::from_millis(sample.at_ms).checked_sub(started.elapsed()) {
            std::thread::sleep(wait);
        }
        deadline.ensure_remaining()?;
        if escape_held()
            || [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
                .into_iter()
                .any(key_is_down)
        {
            return Err(refused(
                "Pointer input stopped by Escape or a held mouse button",
                moved,
            ));
        }
        if guard.is_some_and(|hwnd| !is_root_foreground_window(hwnd)) {
            return Err(refused("The captured window left the foreground", moved));
        }
        let current = read_cursor();
        if !current
            .as_ref()
            .zip(previous.as_ref())
            .is_some_and(|(now, before)| near(now, before))
        {
            return Err(refused(
                "Cursor movement interrupted the pointer action",
                moved,
            ));
        }
        let point = Point {
            x: sample.x,
            y: sample.y,
        };
        post_mouse_inputs(&[move_input(normalize_point(&point))]);
        note_posted(&point);
        previous = Some(point);
    }
    Ok(())
}

#[cfg(not(test))]
fn read_cursor() -> Option<Point> {
    super::page_pointer::position()
}

#[cfg(not(test))]
fn note_posted(_point: &Point) {}

#[cfg(test)]
use fake_cursor::{note_posted, read_cursor};

#[cfg(test)]
pub(crate) mod fake_cursor {
    use agent_desktop_core::Point;
    use std::cell::RefCell;

    thread_local! {
        static CURSOR: RefCell<Option<Point>> = const { RefCell::new(None) };
        static USER_MOVES_AFTER: RefCell<Option<usize>> = const { RefCell::new(None) };
    }

    pub(crate) fn place(point: Point, user_moves_after: Option<usize>) {
        CURSOR.with(|cell| *cell.borrow_mut() = Some(point));
        USER_MOVES_AFTER.with(|cell| *cell.borrow_mut() = user_moves_after);
    }

    pub(super) fn read_cursor() -> Option<Point> {
        CURSOR.with(|cell| cell.borrow().clone())
    }

    pub(super) fn note_posted(point: &Point) {
        let jump = USER_MOVES_AFTER.with(|cell| {
            let mut remaining = cell.borrow_mut();
            match *remaining {
                Some(0) => true,
                Some(count) => {
                    *remaining = Some(count - 1);
                    false
                }
                None => false,
            }
        });
        let landed = if jump {
            Point {
                x: point.x + 200.0,
                y: point.y + 200.0,
            }
        } else {
            point.clone()
        };
        CURSOR.with(|cell| *cell.borrow_mut() = Some(landed));
    }
}

#[cfg(test)]
#[path = "human_pointer_tests.rs"]
mod tests;
