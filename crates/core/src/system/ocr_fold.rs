//! The comparison form of recognized text. Recognizers confuse `0` with `O`
//! and `I`, `1` and `|` with `l`, drop or add spaces, and mix full-width and
//! half-width punctuation, so text is compared without any of those
//! differences.

/// Text reduced to the letters that matter for comparison.
pub(crate) fn fold(text: &str) -> Vec<char> {
    let mut letters: Vec<char> = text.chars().filter_map(fold_char).collect();
    let keep = dash_free(&letters);
    let mut index = 0;
    letters.retain(|_| {
        index += 1;
        keep[index - 1]
    });
    letters
}

/// Which letters stay once dashes are dropped. A Chinese recognizer reads a
/// hyphen between letters or digits as 一, so 一 with an ASCII letter or digit
/// on both sides is treated as the punctuation it was.
pub(crate) fn dash_free(letters: &[char]) -> Vec<bool> {
    (0..letters.len())
        .map(|at| {
            let around = |ch: Option<&char>| ch.is_some_and(char::is_ascii_alphanumeric);
            !(letters[at] == '一'
                && at > 0
                && around(letters.get(at - 1))
                && around(letters.get(at + 1)))
        })
        .collect()
}

pub(crate) fn fold_char(ch: char) -> Option<char> {
    let ch = half_width(ch);
    if ch.is_whitespace() {
        return None;
    }
    let ch = match ch {
        'I' | '|' | '1' => 'l',
        '0' => 'o',
        other => other,
    };
    if is_punctuation(ch) {
        return None;
    }
    Some(ch.to_lowercase().next().unwrap_or(ch))
}

fn half_width(ch: char) -> char {
    match u32::from(ch) {
        code @ 0xFF01..=0xFF5E => char::from_u32(code - 0xFEE0).unwrap_or(ch),
        0x3000 => ' ',
        _ => ch,
    }
}

fn is_punctuation(ch: char) -> bool {
    ch.is_ascii_punctuation()
        || matches!(u32::from(ch),
            0x2000..=0x206F | 0x3001..=0x303F | 0xFE30..=0xFE4F | 0xFF61..=0xFF65 | 0x00B7)
}

/// Han, kana and hangul: scripts a Latin-script recognizer cannot read.
pub(crate) fn is_cjk(ch: char) -> bool {
    matches!(u32::from(ch),
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF)
}

/// Whether a language tag names a recognizer for Han, kana or hangul text.
pub(crate) fn is_cjk_language(tag: &str) -> bool {
    let primary = tag.split('-').next().unwrap_or(tag).to_ascii_lowercase();
    matches!(primary.as_str(), "zh" | "ja" | "ko")
}

/// Whether text looks like something this language's recognizer can read:
/// a CJK recognizer's line holds at least one CJK character, an English one
/// holds plain ASCII, and any other holds no CJK character. A recognizer
/// handed the other script returns confident nonsense, and this is how it is
/// told apart from a real reading.
pub(crate) fn fits_language(text: &str, tag: &str) -> bool {
    if is_cjk_language(tag) {
        return text.chars().any(is_cjk);
    }
    if tag.to_ascii_lowercase().starts_with("en") {
        return text.is_ascii();
    }
    !text.chars().any(is_cjk)
}
