use super::*;

const SAMPLE: &str = "Hello, this is typed by hand. 中文也一个字一个字出现。";

fn units(text: &str) -> Vec<String> {
    text.chars().map(String::from).collect()
}

fn replay(steps: &[TypingStep]) -> String {
    let mut field: Vec<String> = Vec::new();
    for step in steps {
        match step {
            TypingStep::Text { text, .. } => field.push(text.clone()),
            TypingStep::Backspace { .. } => {
                field.pop();
            }
        }
    }
    field.concat()
}

#[test]
fn every_plan_ends_with_exactly_the_requested_text() {
    for seed in 0..500 {
        for pace in [HumanPace::Natural, HumanPace::Careful] {
            let steps = plan_typing(&units(SAMPLE), pace, &mut HumanRng::new(seed), true);
            assert_eq!(replay(&steps), SAMPLE, "seed {seed}");
        }
    }
}

#[test]
fn some_plans_contain_a_correction() {
    let corrected = (0..50).any(|seed| {
        plan_typing(
            &units(SAMPLE),
            HumanPace::Careful,
            &mut HumanRng::new(seed),
            true,
        )
        .iter()
        .any(|step| matches!(step, TypingStep::Backspace { .. }))
    });
    assert!(corrected);
}

#[test]
fn typos_can_be_turned_off_for_sensitive_fields() {
    for seed in 0..200 {
        let steps = plan_typing(
            &units(SAMPLE),
            HumanPace::Careful,
            &mut HumanRng::new(seed),
            false,
        );
        assert_eq!(steps.len(), SAMPLE.chars().count());
        assert!(
            steps
                .iter()
                .all(|step| matches!(step, TypingStep::Text { .. }))
        );
    }
}

#[test]
fn the_first_key_is_never_wrong_and_goes_at_once() {
    for seed in 0..500 {
        let steps = plan_typing(
            &units("query"),
            HumanPace::Careful,
            &mut HumanRng::new(seed),
            true,
        );
        assert_eq!(
            steps[0],
            TypingStep::Text {
                text: "q".into(),
                after_ms: 0
            }
        );
    }
}

#[test]
fn the_rhythm_is_uneven() {
    let steps = plan_typing(
        &units(SAMPLE),
        HumanPace::Natural,
        &mut HumanRng::new(9),
        false,
    );
    let gaps: std::collections::HashSet<u64> = steps
        .iter()
        .map(|step| match step {
            TypingStep::Text { after_ms, .. } | TypingStep::Backspace { after_ms } => *after_ms,
        })
        .collect();
    assert!(gaps.len() > 10);
}

#[test]
fn a_line_break_is_never_replaced_or_typed_early() {
    for seed in 0..300 {
        let steps = plan_typing(
            &units("ab\ncd"),
            HumanPace::Careful,
            &mut HumanRng::new(seed),
            true,
        );
        let breaks = steps
            .iter()
            .filter(|step| matches!(step, TypingStep::Text { text, .. } if text == "\n"))
            .count();
        assert_eq!(breaks, 1, "seed {seed}");
    }
}

#[test]
fn the_same_seed_reproduces_the_same_plan() {
    let plan = |seed| {
        plan_typing(
            &units(SAMPLE),
            HumanPace::Natural,
            &mut HumanRng::new(seed),
            true,
        )
    };
    assert_eq!(plan(4), plan(4));
}

fn mean_gap(text: &str) -> f64 {
    let (mut total, mut count) = (0u64, 0u64);
    for seed in 0..300 {
        let steps = plan_typing(
            &units(text),
            HumanPace::Natural,
            &mut HumanRng::new(seed),
            false,
        );
        for step in &steps[1..] {
            if let TypingStep::Text { after_ms, .. } = step {
                total += after_ms;
                count += 1;
            }
        }
    }
    total as f64 / count as f64
}

#[test]
fn symbols_and_digits_take_longer_than_letters() {
    let letters = mean_gap("abcdefghijklmnop");
    let digits = mean_gap("1234567890123456");
    let symbols = mean_gap("(){}[]=+*&^%$#@!");
    assert!(digits > letters * 1.1, "digits {digits}, letters {letters}");
    assert!(symbols > digits * 1.1, "symbols {symbols}, digits {digits}");
}
