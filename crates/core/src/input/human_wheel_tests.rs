use super::*;
use crate::{MouseButton, Point};

const CAREFUL: HumanInput = HumanInput {
    pace: HumanPace::Careful,
    seed: Some(3),
    typos: false,
};

fn wheel(delta_x: f64, delta_y: f64) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Wheel { delta_x, delta_y },
        point: Point { x: 40.0, y: 60.0 },
        button: MouseButton::Left,
        modifiers: Vec::new(),
    }
}

fn lines_of(event: &MouseEvent) -> (f64, f64) {
    match event.kind {
        MouseEventKind::Wheel { delta_x, delta_y } => (delta_x, delta_y),
        _ => (0.0, 0.0),
    }
}

#[test]
fn the_notches_add_up_to_the_requested_scroll() {
    for seed in 0..100 {
        let plan = plan_wheel(2.0, -9.0, HumanPace::Natural, &mut HumanRng::new(seed));
        assert_eq!(plan.len(), 11, "seed {seed}");
        assert_eq!(plan.iter().map(|notch| notch.delta_y).sum::<f64>(), -9.0);
        assert_eq!(plan.iter().map(|notch| notch.delta_x).sum::<f64>(), 2.0);
        assert!(
            plan.iter()
                .all(|notch| notch.delta_x.abs() + notch.delta_y.abs() == 1.0)
        );
    }
}

#[test]
fn the_first_notch_is_immediate_and_strokes_are_separated_by_a_longer_gap() {
    for seed in 0..100 {
        let plan = plan_wheel(0.0, -12.0, HumanPace::Natural, &mut HumanRng::new(seed));
        assert_eq!(plan[0].after_ms, 0);
        let pauses = plan.iter().filter(|notch| notch.after_ms >= 240).count();
        assert!((2..=3).contains(&pauses), "seed {seed}: {pauses} pauses");
        assert!(plan[1..].iter().all(|notch| notch.after_ms >= 8));
    }
}

#[test]
fn careful_scrolls_slower_than_natural() {
    let total = |pace| {
        plan_wheel(0.0, 12.0, pace, &mut HumanRng::new(9))
            .iter()
            .map(|notch| notch.after_ms)
            .sum::<u64>()
    };
    assert!(total(HumanPace::Careful) > total(HumanPace::Natural));
}

#[test]
fn a_scroll_goes_out_one_line_at_a_time() {
    let mut sent = Vec::new();
    let report = roll(wheel(0.0, -3.0), CAREFUL, |event| {
        sent.push(lines_of(&event));
        Ok(OperationReport::pointer_dispatched(&event, false))
    });
    assert!(report.is_ok());
    assert_eq!(sent, vec![(0.0, -1.0); 3]);
}

#[test]
fn a_click_and_a_part_line_scroll_pass_through_untouched() {
    let click = MouseEvent {
        kind: MouseEventKind::Click { count: 1 },
        ..wheel(0.0, 0.0)
    };
    for event in [click, wheel(0.0, 0.5)] {
        let mut sent = Vec::new();
        roll(event.clone(), CAREFUL, |seen| {
            sent.push(seen.clone());
            Ok(OperationReport::pointer_dispatched(&seen, false))
        })
        .unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(lines_of(&sent[0]), lines_of(&event));
    }
}

#[test]
fn a_scroll_too_long_to_pace_is_refused_before_anything_moves() {
    let mut sent = 0;
    let error = roll(wheel(0.0, 16.0), CAREFUL, |event| {
        sent += 1;
        Ok(OperationReport::pointer_dispatched(&event, false))
    })
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(sent, 0);
}

#[test]
fn a_failure_part_way_reports_how_far_the_wheel_turned() {
    let mut sent = 0;
    let error = roll(wheel(0.0, 3.0), CAREFUL, |event| {
        sent += 1;
        if sent == 3 {
            return Err(AdapterError::stale_ref_because("The cursor moved")
                .with_details(serde_json::json!({ "phase": "before_input" })));
        }
        Ok(OperationReport::pointer_dispatched(&event, false))
    })
    .unwrap_err();
    let details = error.details.unwrap();
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(details["wheel_lines_sent"], 2);
    assert_eq!(details["wheel_lines"], 3);
    assert_eq!(details["phase"], "before_input");
}

#[test]
fn a_failure_on_the_first_notch_keeps_the_original_refusal() {
    let error = roll(wheel(0.0, 3.0), CAREFUL, |_| {
        Err(AdapterError::stale_ref_because("The cursor moved"))
    })
    .unwrap_err();
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(error.details.is_none());
}
