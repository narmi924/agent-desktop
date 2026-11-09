use super::*;

const FROM: Point = Point { x: 100.0, y: 700.0 };
const TO: Point = Point {
    x: 1200.0,
    y: 240.0,
};

fn plan(seed: u64, pace: HumanPace) -> Vec<PathSample> {
    plan_pointer_path(&FROM, &TO, pace, &mut HumanRng::new(seed))
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
    let path = plan(3, HumanPace::Natural);
    let furthest = path
        .iter()
        .filter(|step| !step.correction)
        .map(|step| {
            let (dx, dy) = (TO.x - FROM.x, TO.y - FROM.y);
            ((step.x - FROM.x) * dy - (step.y - FROM.y) * dx).abs() / dx.hypot(dy)
        })
        .fold(0.0, f64::max);
    assert!(furthest > 20.0, "furthest deviation was {furthest}");
}

#[test]
fn the_motion_slows_down_before_arriving() {
    let path: Vec<_> = plan(11, HumanPace::Natural)
        .into_iter()
        .filter(|step| !step.correction)
        .collect();
    let speed = |pair: &[PathSample]| {
        let elapsed = (pair[1].at_ms - pair[0].at_ms).max(1) as f64;
        (pair[1].x - pair[0].x).hypot(pair[1].y - pair[0].y) / elapsed
    };
    let middle = speed(&path[path.len() / 2 - 1..=path.len() / 2]);
    let ending = speed(&path[path.len() - 3..path.len() - 1]);
    assert!(middle > ending * 2.0, "middle {middle}, ending {ending}");
}

#[test]
fn careful_is_slower_than_natural() {
    let total = |pace| plan(5, pace).last().unwrap().at_ms;
    assert!(total(HumanPace::Careful) > total(HumanPace::Natural));
}

#[test]
fn a_tiny_move_is_a_single_step() {
    let path = plan_pointer_path(&TO, &TO, HumanPace::Natural, &mut HumanRng::new(1));
    assert_eq!(path.len(), 1);
}
