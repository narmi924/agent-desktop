use super::human_pace::HumanPace;
use super::human_rng::HumanRng;
use crate::Point;
use std::f64::consts::TAU;

const MIN_STEP_MS: f64 = 7.0;
const STEP_SPREAD_MS: f64 = 6.0;
const OVERSHOOT_MIN_DISTANCE: f64 = 260.0;
const TARGET_WIDTH: f64 = 36.0;

/// One cursor position on a planned path, `at_ms` after the path starts.
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
        settle_ms: (rng.between(40.0, 130.0) * pace.motion_scale()) as u64,
        hold_ms: rng.between(55.0, 120.0) as u64,
    }
}

/// Plans a curved path that starts fast, slows near the target and may correct
/// a small miss. The last sample is always exactly `to`.
pub fn plan_pointer_path(
    from: &Point,
    to: &Point,
    pace: HumanPace,
    rng: &mut HumanRng,
) -> Vec<PathSample> {
    let distance = (to.x - from.x).hypot(to.y - from.y);
    if distance < 1.0 {
        return vec![sample(to.x, to.y, 0.0, false)];
    }
    let (along_x, along_y) = ((to.x - from.x) / distance, (to.y - from.y) / distance);
    let overshoots = distance > OVERSHOOT_MIN_DISTANCE && rng.chance(pace.overshoot_chance());
    let reach = if overshoots {
        rng.between(0.02, 0.055)
    } else {
        -rng.between(0.008, 0.028)
    };
    let side = rng.between(-7.0, 7.0);
    let aim = Point {
        x: (to.x + along_x * reach * distance - along_y * side).round(),
        y: (to.y + along_y * reach * distance + along_x * side).round(),
    };
    let scale = pace.motion_scale();
    let mut path = Vec::new();
    let mut clock = stroke(
        &mut path,
        Stroke {
            from,
            to: &aim,
            scale,
            start_ms: 0.0,
            correction: false,
        },
        rng,
    );
    let mut last = aim;
    if rng.chance(pace.extra_correction_chance()) {
        clock += rng.between(40.0, 130.0);
        let near = Point {
            x: (to.x + rng.between(-3.5, 3.5)).round(),
            y: (to.y + rng.between(-3.5, 3.5)).round(),
        };
        clock = stroke(
            &mut path,
            Stroke {
                from: &last,
                to: &near,
                scale: scale * 0.8,
                start_ms: clock,
                correction: true,
            },
            rng,
        );
        last = near;
    }
    clock += rng.between(40.0, 130.0);
    stroke(
        &mut path,
        Stroke {
            from: &last,
            to,
            scale: scale * 0.7,
            start_ms: clock,
            correction: true,
        },
        rng,
    );
    path
}

struct Stroke<'a> {
    from: &'a Point,
    to: &'a Point,
    scale: f64,
    start_ms: f64,
    correction: bool,
}

fn stroke(path: &mut Vec<PathSample>, plan: Stroke<'_>, rng: &mut HumanRng) -> f64 {
    let Stroke {
        from,
        to,
        scale,
        start_ms,
        correction,
    } = plan;
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let distance = dx.hypot(dy).max(1.0);
    let duration =
        scale * (90.0 + 135.0 * (distance / TARGET_WIDTH + 1.0).log2()) * rng.between(0.9, 1.15);
    let (normal_x, normal_y) = (-dy / distance, dx / distance);
    let bow_ratio = if correction {
        0.03
    } else {
        rng.between(0.05, 0.16)
    };
    let bow = bow_ratio * distance * if rng.chance(0.5) { -1.0 } else { 1.0 };
    let (phase_a, phase_b) = (rng.between(0.0, TAU), rng.between(0.0, TAU));
    let tremor = (distance * 0.006).min(2.4);
    let mut elapsed = 0.0;
    while elapsed < duration {
        let progress = elapsed / duration;
        let eased = minimum_jerk(progress.powf(0.88));
        let wobble = (1.0 - eased)
            * ((progress * 9.0 + phase_a).sin() + 0.6 * (progress * 23.0 + phase_b).sin())
            * tremor;
        let offset = 4.0 * eased * (1.0 - eased) * bow + wobble;
        path.push(sample(
            from.x + dx * eased + normal_x * offset,
            from.y + dy * eased + normal_y * offset,
            start_ms + elapsed,
            correction,
        ));
        elapsed += MIN_STEP_MS + rng.unit() * STEP_SPREAD_MS;
    }
    path.push(sample(to.x, to.y, start_ms + duration, correction));
    start_ms + duration
}

fn minimum_jerk(t: f64) -> f64 {
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
