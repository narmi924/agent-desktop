//! How `type` enters its text: where the caret goes first, and whether a
//! line break is the Enter key or the field is replaced.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, clap::ValueEnum, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CaretPlaceArg {
    Start,
    End,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PageEntryMode {
    Multiline,
    Replace,
    ReplaceMultiline,
}
