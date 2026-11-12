use super::*;

const FROM: Point = Point { x: 100.0, y: 700.0 };
const TO: Point = Point {
    x: 1200.0,
    y: 240.0,
};
const SMALL: f64 = 24.0;

fn plan(seed: u64, pace: HumanPace) -> Vec<PathSample> {
    plan_pointer_path(&FROM, &TO, SMALL, pace, &mut HumanRng::new(seed))
}

fn hop(seed: u64, width: f64) -> Vec<PathSample> {
    let near = Point {
        x: FROM.x + 60.0,
        y: FROM.y,
    };
    plan_pointer_path(
        &FROM,
        &near,
        width,
        HumanPace::Natural,
        &mut HumanRng::new(seed),
    )
}

fn along(step: &PathSample) -> f64 {
    let (dx, dy) = (TO.x - FROM.x, TO.y - FROM.y);
    ((step.x - FROM.x) * dx + (step.y - FROM.y) * dy) / dx.hypot(dy)
}

/// The longest time the cursor stays on one pixel before it is over the
/// target. Slowing to a crawl inside the target is arriving, not stopping.
fn longest_rest_ms(path: &[PathSample]) -> u64 {
    let mut moved_at = 0;
    let mut longest = 0;
    for pair in path.windows(2) {
        if (pair[1].x - TO.x).hypot(pair[1].y - TO.y) <= SMALL / 2.0 {
            break;
        }
        if (pair[1].x, pair[1].y) != (pair[0].x, pair[0].y) {
            moved_at = pair[1].at_ms;
        }
        longest = longest.max(pair[1].at_ms - moved_at);
    }
    longest
}

#[test]
fn a_path_always_ends_exactly_on_the_target() {
    for seed in 0..200 {
        let path = plan(seed, HumanPace::Natural);
        let last = path.last().unwrap();
        assert_eq!((last.x, last.y), (TO.x, TO.y), "seed {seed}");
    }
}

#[test]
fn the_same_seed_reproduces_the_same_path() {
    assert_eq!(plan(7, HumanPace::Careful), plan(7, HumanPace::Careful));
    assert_ne!(plan(7, HumanPace::Natural), plan(8, HumanPace::Natural));
}

#[test]
fn time_never_runs_backwards_and_positions_are_whole_pixels() {
    for seed in 0..50 {
        let path = plan(seed, HumanPace::Natural);
        assert!(path.windows(2).all(|pair| pair[0].at_ms <= pair[1].at_ms));
        assert!(
            path.iter()
                .all(|step| step.x.fract() == 0.0 && step.y.fract() == 0.0)
        );
    }
}

#[test]
fn the_route_bends_away_from_a_straight_line() {
    for seed in 0..50 {
        let furthest = plan(seed, HumanPace::Natural)
            .iter()
            .map(|step| {
                let (dx, dy) = (TO.x - FROM.x, TO.y - FROM.y);
                ((step.x - FROM.x) * dy - (step.y - FROM.y) * dx).abs() / dx.hypot(dy)
            })
            .fold(0.0, f64::max);
        assert!(
            (35.0..=175.0).contains(&furthest),
            "seed {seed}: furthest deviation was {furthest}"
        );
    }
}

#[test]
fn the_motion_slows_down_before_arriving() {
    let path = plan(11, HumanPace::Natural);
    let speed = |pair: &[PathSample]| {
        let elapsed = (pair[1].at_ms - pair[0].at_ms).max(1) as f64;
        (pair[1].x - pair[0].x).hypot(pair[1].y - pair[0].y) / elapsed
    };
    let fastest = path.windows(2).map(speed).fold(0.0, f64::max);
    let ending = speed(&path[path.len() - 3..path.len() - 1]);
    assert!(fastest > ending * 8.0, "fastest {fastest}, ending {ending}");
}

#[test]
fn the_cursor_never_stops_on_the_way() {
    for pace in [HumanPace::Natural, HumanPace::Careful] {
        for seed in 0..200 {
            let rest = longest_rest_ms(&plan(seed, pace));
            assert!(rest < 40, "{pace:?} seed {seed} rested {rest} ms");
        }
    }
}

#[test]
fn a_large_target_close_by_is_reached_in_one_stroke() {
    for seed in 0..50 {
        assert!(hop(seed, 40.0).iter().all(|step| !step.correction));
    }
}

#[test]
fn a_small_distant_target_gets_a_closing_stroke() {
    for seed in 0..50 {
        assert!(
            plan(seed, HumanPace::Natural)
                .iter()
                .any(|step| step.correction)
        );
    }
}

#[test]
fn a_larger_target_is_reached_sooner() {
    let total = |width| {
        (0..40)
            .map(|seed| {
                plan_pointer_path(
                    &FROM,
                    &TO,
                    width,
                    HumanPace::Natural,
                    &mut HumanRng::new(seed),
                )
                .last()
                .unwrap()
                .at_ms
            })
            .sum::<u64>()
    };
    assert!(total(200.0) < total(20.0));
}

#[test]
fn careful_is_slower_than_natural() {
    let total = |pace| plan(5, pace).last().unwrap().at_ms;
    assert!(total(HumanPace::Careful) > total(HumanPace::Natural));
}

#[test]
fn a_careful_hand_never_goes_past_the_target_and_a_natural_one_sometimes_does() {
    let distance = (TO.x - FROM.x).hypot(TO.y - FROM.y);
    let passes = |pace| {
        (0..300)
            .filter(|seed| {
                plan(*seed, pace)
                    .iter()
                    .any(|step| along(step) > distance + 2.0)
            })
            .count()
    };
    assert_eq!(passes(HumanPace::Careful), 0);
    assert!(passes(HumanPace::Natural) > 0);
}

#[test]
fn a_tiny_move_is_a_single_step() {
    let path = plan_pointer_path(&TO, &TO, SMALL, HumanPace::Natural, &mut HumanRng::new(1));
    assert_eq!(path.len(), 1);
}

#[test]
fn a_width_that_is_not_a_number_falls_back_to_the_default() {
    let odd = plan_pointer_path(
        &FROM,
        &TO,
        f64::NAN,
        HumanPace::Natural,
        &mut HumanRng::new(2),
    );
    let usual = plan_pointer_path(
        &FROM,
        &TO,
        DEFAULT_TARGET_WIDTH,
        HumanPace::Natural,
        &mut HumanRng::new(2),
    );
    assert_eq!(odd, usual);
}

#[test]
fn a_click_lands_inside_the_control_away_from_its_edges_and_not_always_at_its_centre() {
    let button = Rect {
        x: 400.0,
        y: 300.0,
        width: 200.0,
        height: 60.0,
    };
    let mut centred = 0;
    let (mut left, mut right, mut above) = (0, 0, 0);
    for seed in 0..600 {
        let point = plan_landing(&button, &mut HumanRng::new(seed));
        assert!(
            (416.0..=584.0).contains(&point.x),
            "seed {seed}: x {}",
            point.x
        );
        assert!(
            (304.0..=356.0).contains(&point.y),
            "seed {seed}: y {}",
            point.y
        );
        centred += usize::from(point.x == 500.0 && point.y == 330.0);
        left += usize::from(point.x < 470.0);
        right += usize::from(point.x > 530.0);
        above += usize::from(point.y < 330.0);
    }
    assert!(centred < 10);
    assert!(left > 100 && right > 100, "left {left}, right {right}");
    assert!(
        above > 360,
        "a click sits above the middle more often than below: {above}"
    );
}

#[test]
fn a_long_row_is_clicked_near_its_middle_not_anywhere_along_it() {
    let row = Rect {
        x: 0.0,
        y: 0.0,
        width: 1600.0,
        height: 40.0,
    };
    for seed in 0..300 {
        let point = plan_landing(&row, &mut HumanRng::new(seed));
        assert!(
            (740.0..=860.0).contains(&point.x),
            "seed {seed}: x {}",
            point.x
        );
    }
}
