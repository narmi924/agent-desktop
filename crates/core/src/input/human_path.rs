use super::human_pace::HumanPace;
use super::human_rng::HumanRng;
use crate::{Point, Rect};
use std::f64::consts::TAU;

/// The target width assumed when the control under the point is not known.
pub const DEFAULT_TARGET_WIDTH: f64 = 36.0;

const MIN_STEP_MS: f64 = 7.0;
const STEP_SPREAD_MS: f64 = 6.0;
const NARROWEST_TARGET: f64 = 8.0;
const WIDEST_TARGET: f64 = 600.0;
const CORRECTION_DIFFICULTY: f64 = 3.0;
const FIRST_STROKE_ENDS: f64 = 0.74;
const SECOND_STROKE_STARTS: f64 = 0.56;
const WIDEST_BOW: f64 = 160.0;
const FURTHEST_LANDING: f64 = 0.42;
const STROKE_SKEW: f64 = 0.68;

/// One cursor position on a planned path, `at_ms` after the path starts.
/// `correction` marks the part where the hand is homing in on the target.
#[derive(Debug, Clone, PartialEq)]
pub struct PathSample {
    pub x: f64,
    pub y: f64,
    pub at_ms: u64,
    pub correction: bool,
}

/// How long to rest on the target and hold the button once the path ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PressTiming {
    pub settle_ms: u64,
    pub hold_ms: u64,
}

pub fn plan_press(pace: HumanPace, rng: &mut HumanRng) -> PressTiming {
    PressTiming {
        settle_ms: (rng.between(10.0, 45.0) * pace.motion_scale()) as u64,
        hold_ms: rng.between(80.0, 145.0) as u64,
    }
}

/// Where a click lands inside a control: spread around a point a little above
/// the middle, wider across than up and down, and never at the very edge. A
/// long control spreads no further than a few times its short side, so the
/// point stays near its middle.
pub fn plan_landing(bounds: &Rect, rng: &mut HumanRng) -> Point {
    let across = bounds.width.min(3.5 * bounds.height);
    let upright = bounds.height.min(3.5 * bounds.width);
    let limit = |share: f64| share.clamp(-FURTHEST_LANDING, FURTHEST_LANDING);
    let offset_x = limit(rng.normal(0.0, 0.23)) * across;
    let offset_y = limit(rng.normal(-0.1, 0.16)) * upright;
    Point {
        x: (bounds.x + bounds.width / 2.0 + offset_x).round(),
        y: (bounds.y + bounds.height / 2.0 + offset_y).round(),
    }
}

/// Plans one continuous move to `to`, a target `width` pixels across. The hand
/// speeds up, then slows; a small or distant target gets a second, shorter
/// stroke that starts before the first has ended, so the cursor homes in
/// without stopping. A close, large target is reached in a single stroke.
/// The last sample is always exactly `to`.
pub fn plan_pointer_path(
    from: &Point,
    to: &Point,
    width: f64,
    pace: HumanPace,
    rng: &mut HumanRng,
) -> Vec<PathSample> {
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let distance = dx.hypot(dy);
    if distance < 1.0 {
        return vec![sample(to.x, to.y, 0.0, false)];
    }
    let width = if width.is_finite() {
        width.clamp(NARROWEST_TARGET, WIDEST_TARGET)
    } else {
        DEFAULT_TARGET_WIDTH
    };
    let difficulty = (distance / width + 1.0).log2();
    let duration = pace.motion_scale() * (140.0 + 119.0 * difficulty) * rng.between(0.92, 1.12);
    let corrects = difficulty >= CORRECTION_DIFFICULTY;
    let reach = if corrects { pace.reach(rng) } else { 1.0 };
    let side = if corrects {
        rng.between(-0.25, 0.25) * width
    } else {
        0.0
    };
    let bow = (rng.between(0.04, 0.12) * distance).min(WIDEST_BOW)
        * if rng.chance(0.5) { -1.0 } else { 1.0 };
    let (phase_a, phase_b) = (rng.between(0.0, TAU), rng.between(0.0, TAU));
    let tremor = (distance * 0.004).min(1.5);
    let (normal_x, normal_y) = (-dy / distance, dx / distance);
    let mut path = Vec::new();
    let mut elapsed = 0.0;
    while elapsed < duration {
        let progress = elapsed / duration;
        let first = stroke(progress / FIRST_STROKE_ENDS);
        let second = stroke((progress - SECOND_STROKE_STARTS) / (1.0 - SECOND_STROKE_STARTS));
        let along = if corrects {
            reach * first + (1.0 - reach) * second
        } else {
            stroke(progress)
        };
        let arc = along.clamp(0.0, 1.0);
        let wobble = (1.0 - arc)
            * ((progress * 9.0 + phase_a).sin() + 0.6 * (progress * 23.0 + phase_b).sin())
            * tremor;
        let across = 4.0 * arc * (1.0 - arc) * bow + side * (first - second) + wobble;
        path.push(sample(
            from.x + dx * along + normal_x * across,
            from.y + dy * along + normal_y * across,
            elapsed,
            corrects && progress > SECOND_STROKE_STARTS,
        ));
        elapsed += MIN_STEP_MS + rng.unit() * STEP_SPREAD_MS;
    }
    path.push(sample(to.x, to.y, duration, corrects));
    path
}

/// The share of one stroke covered at `progress` through it: a minimum-jerk
/// rise skewed so the hand is fastest about a quarter of the way through and
/// spends the rest slowing down, held at 0 before and 1 after.
fn stroke(progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0).powf(STROKE_SKEW);
    t * t * t * (10.0 + t * (-15.0 + 6.0 * t))
}

fn sample(x: f64, y: f64, at_ms: f64, correction: bool) -> PathSample {
    PathSample {
        x: x.round(),
        y: y.round(),
        at_ms: at_ms.round() as u64,
        correction,
    }
}

#[cfg(test)]
#[path = "human_path_tests.rs"]
mod tests;
