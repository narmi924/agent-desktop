use super::key_combo::KeyCombo;
use super::modifier::Modifier;

/// Where the caret is put in a field before text is typed into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaretPlace {
    Start,
    End,
}

impl CaretPlace {
    /// The key combo that moves the caret there in a text field of any length.
    pub fn key_combo(self) -> KeyCombo {
        KeyCombo {
            key: match self {
                Self::Start => "home",
                Self::End => "end",
            }
            .into(),
            modifiers: vec![Modifier::Ctrl],
        }
    }
}
