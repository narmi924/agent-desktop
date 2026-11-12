use super::human_pace::HumanPace;
use super::human_rng::HumanRng;

const NEIGHBOUR_KEYS: &[(char, &str)] = &[
    ('a', "sq"),
    ('b', "vn"),
    ('c', "xv"),
    ('d', "sf"),
    ('e', "wr"),
    ('f', "dg"),
    ('g', "fh"),
    ('h', "gj"),
    ('i', "uo"),
    ('j', "hk"),
    ('k', "jl"),
    ('l', "k"),
    ('m', "n"),
    ('n', "bm"),
    ('o', "ip"),
    ('p', "o"),
    ('q', "w"),
    ('r', "et"),
    ('s', "ad"),
    ('t', "ry"),
    ('u', "yi"),
    ('v', "cb"),
    ('w', "qe"),
    ('x', "zc"),
    ('y', "tu"),
    ('z', "x"),
];

const SAME_SOUND: &[(char, char)] = &[
    ('的', '得'),
    ('是', '事'),
    ('在', '再'),
    ('一', '已'),
    ('中', '钟'),
    ('文', '闻'),
    ('字', '自'),
    ('我', '卧'),
    ('有', '又'),
    ('和', '河'),
    ('不', '布'),
    ('个', '各'),
    ('出', '初'),
    ('现', '线'),
    ('也', '野'),
    ('上', '尚'),
    ('下', '夏'),
    ('大', '达'),
    ('小', '晓'),
    ('时', '十'),
];

/// One planned key action, `after_ms` after the previous one landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypingStep {
    Text { text: String, after_ms: u64 },
    Backspace { after_ms: u64 },
}

/// Plans uneven typing for `units`. With `allow_typos`, it may strike a wrong
/// key and correct it; applying every step always yields exactly the input.
/// The first unit is never wrong, so a caller can read the field after it.
pub fn plan_typing(
    units: &[String],
    pace: HumanPace,
    rng: &mut HumanRng,
    allow_typos: bool,
) -> Vec<TypingStep> {
    let mut steps = Vec::with_capacity(units.len());
    for (index, unit) in units.iter().enumerate() {
        let after_ms = if index == 0 {
            0
        } else {
            gap_before(units, index, pace, rng)
        };
        let wrong = (allow_typos && index > 0 && rng.chance(pace.typo_chance()))
            .then(|| wrong_key(unit, rng))
            .flatten();
        let Some(wrong) = wrong else {
            steps.push(text(unit, after_ms));
            continue;
        };
        steps.push(text(&wrong, after_ms));
        let typed_on = typed_before_noticing(units, index, rng);
        for later in &units[index + 1..index + 1 + typed_on] {
            steps.push(text(later, key_ms(pace, rng)));
        }
        let mut pause = rng.between(220.0, 600.0) as u64;
        for _ in 0..=typed_on {
            steps.push(TypingStep::Backspace { after_ms: pause });
            pause = (pace.key_base_ms() * rng.between(0.44, 0.7)) as u64;
        }
        steps.push(text(unit, rng.between(120.0, 280.0) as u64));
    }
    steps
}

fn text(unit: &str, after_ms: u64) -> TypingStep {
    TypingStep::Text {
        text: unit.to_owned(),
        after_ms,
    }
}

fn key_ms(pace: HumanPace, rng: &mut HumanRng) -> u64 {
    let drift = rng.unit() + rng.unit() + rng.unit() - 1.5;
    (pace.key_base_ms() * (drift * pace.key_spread()).exp()) as u64
}

fn gap_before(units: &[String], index: usize, pace: HumanPace, rng: &mut HumanRng) -> u64 {
    let multiplier = reach_cost(&units[index]);
    let mut gap = (key_ms(pace, rng) as f64 * multiplier) as u64;
    if ends_a_word(&units[index - 1]) {
        gap += (pace.word_gap_ms() * rng.unit()) as u64;
    }
    if rng.chance(pace.thinking_chance()) {
        gap += rng.between(300.0, 900.0) as u64;
    }
    gap
}

/// How much longer a key takes than a plain letter: a Chinese character is
/// composed from several keys, a symbol needs a stretch or Shift, and a digit
/// sits on the far row.
fn reach_cost(unit: &str) -> f64 {
    match single_char(unit) {
        Some(_) if is_cjk(unit) => 1.9,
        Some(ch) if ch.is_ascii_punctuation() && !",.".contains(ch) => 1.9,
        Some(ch) if ch.is_ascii_digit() => 1.25,
        _ => 1.0,
    }
}

fn typed_before_noticing(units: &[String], index: usize, rng: &mut HumanRng) -> usize {
    if is_cjk(&units[index]) {
        return 0;
    }
    let plain_after = units[index + 1..]
        .iter()
        .take_while(|unit| single_char(unit).is_some_and(|ch| !ch.is_control()))
        .count();
    plain_after.min((rng.unit() * 3.0) as usize)
}

fn wrong_key(unit: &str, rng: &mut HumanRng) -> Option<String> {
    let ch = single_char(unit)?;
    if let Some((_, similar)) = SAME_SOUND.iter().find(|(key, _)| *key == ch) {
        return Some(similar.to_string());
    }
    let lower = ch.to_ascii_lowercase();
    let (_, neighbours) = NEIGHBOUR_KEYS.iter().find(|(key, _)| *key == lower)?;
    let picked = neighbours
        .chars()
        .nth((rng.unit() * neighbours.len() as f64) as usize)?;
    Some(if ch.is_ascii_uppercase() {
        picked.to_ascii_uppercase().to_string()
    } else {
        picked.to_string()
    })
}

fn single_char(unit: &str) -> Option<char> {
    let mut chars = unit.chars();
    let first = chars.next()?;
    chars.next().is_none().then_some(first)
}

fn is_cjk(unit: &str) -> bool {
    single_char(unit).is_some_and(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

fn ends_a_word(unit: &str) -> bool {
    single_char(unit).is_some_and(|ch| ch.is_whitespace() || ",.;:!?，。；：！？".contains(ch))
}

#[cfg(test)]
#[path = "human_typing_tests.rs"]
mod tests;
