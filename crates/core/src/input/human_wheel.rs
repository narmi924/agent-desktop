use super::human_input::HumanInput;
use super::human_pace::HumanPace;
use super::human_rng::HumanRng;
use crate::{
    AdapterError, DeliverySemantics, ErrorCode, MouseEvent, MouseEventKind, OperationReport,
};
use std::time::Duration;

/// The most wheel lines one human-paced command turns, so the whole scroll
/// stays inside one command's time budget.
const MAX_PACED_WHEEL_LINES: f64 = 15.0;

/// One wheel notch of a planned scroll, sent `after_ms` after the previous one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WheelNotch {
    pub delta_x: f64,
    pub delta_y: f64,
    pub after_ms: u64,
}

/// Plans a scroll the way a finger flicks a wheel: three to five notches in
/// quick succession, each a little later than the one before, then a longer
/// gap while the finger comes back for the next stroke. The notches add up
/// to the deltas.
pub fn plan_wheel(
    delta_x: f64,
    delta_y: f64,
    pace: HumanPace,
    rng: &mut HumanRng,
) -> Vec<WheelNotch> {
    let scale = pace.motion_scale();
    let turns = std::iter::repeat_n((0.0, delta_y.signum()), delta_y.abs().round() as usize).chain(
        std::iter::repeat_n((delta_x.signum(), 0.0), delta_x.abs().round() as usize),
    );
    let mut notches = Vec::new();
    let mut left_in_stroke = 0;
    let mut place_in_stroke = 0.0;
    for (delta_x, delta_y) in turns {
        let after_ms = if notches.is_empty() {
            0.0
        } else if left_in_stroke == 0 {
            rng.between(240.0, 350.0) * scale
        } else {
            rng.between(8.0, 30.0) * (1.0 + 0.18 * place_in_stroke) * scale
        };
        if left_in_stroke == 0 {
            left_in_stroke = rng.between(3.0, 5.99) as u32;
            place_in_stroke = 0.0;
        }
        left_in_stroke -= 1;
        place_in_stroke += 1.0;
        notches.push(WheelNotch {
            delta_x,
            delta_y,
            after_ms: after_ms as u64,
        });
    }
    notches
}

/// Sends a wheel event one notch at a time on a human rhythm. Any other event,
/// and a wheel delta that is not a whole number of lines, goes out unchanged.
pub(crate) fn roll(
    event: MouseEvent,
    human: HumanInput,
    mut send: impl FnMut(MouseEvent) -> Result<OperationReport, AdapterError>,
) -> Result<OperationReport, AdapterError> {
    let MouseEventKind::Wheel { delta_x, delta_y } = event.kind else {
        return send(event);
    };
    let lines = delta_x.abs() + delta_y.abs();
    if lines == 0.0 || delta_x.fract() != 0.0 || delta_y.fract() != 0.0 {
        return send(event);
    }
    if lines > MAX_PACED_WHEEL_LINES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("With --human, one command turns the wheel at most {MAX_PACED_WHEEL_LINES} lines"),
        )
        .with_suggestion("Scroll in several commands and read the window between them, or leave out --human for one long scroll.")
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let notches = plan_wheel(delta_x, delta_y, human.pace, &mut human.rng());
    let total = notches.len();
    let mut report = None;
    for (sent, notch) in notches.into_iter().enumerate() {
        std::thread::sleep(Duration::from_millis(notch.after_ms));
        let turned = send(MouseEvent {
            kind: MouseEventKind::Wheel {
                delta_x: notch.delta_x,
                delta_y: notch.delta_y,
            },
            ..event.clone()
        });
        match turned {
            Ok(done) => report = Some(done),
            Err(error) if sent == 0 => return Err(error),
            Err(error) => return Err(with_progress(error, sent, total)),
        }
    }
    report.ok_or_else(|| AdapterError::internal("a planned scroll had no wheel notch"))
}

/// Part of the scroll already landed, so the failure keeps its own details
/// and gains how far the wheel had turned.
fn with_progress(mut error: AdapterError, sent: usize, total: usize) -> AdapterError {
    let mut details = error
        .details
        .take()
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    details["wheel_lines_sent"] = serde_json::json!(sent);
    details["wheel_lines"] = serde_json::json!(total);
    error
        .with_details(details)
        .with_disposition(DeliverySemantics::delivered_unverified())
}

#[cfg(test)]
#[path = "human_wheel_tests.rs"]
mod tests;
