use clap::Parser;
use serde::Deserialize;
use std::path::PathBuf;

use super::WindowScope;

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OcrArgs {
    #[command(flatten)]
    #[serde(flatten)]
    pub scope: WindowScope,
    #[arg(
        long,
        value_name = "IMAGE.png",
        help = "Read this saved image instead of capturing a window"
    )]
    #[serde(default)]
    pub image: Option<PathBuf>,
    #[arg(
        long,
        value_name = "TEXT",
        help = "Report where this text appears: lines that are exactly the text win over lines that contain it; ignores spacing, case and punctuation"
    )]
    #[serde(default)]
    pub find: Option<String>,
    #[arg(
        long,
        value_name = "TAG",
        help = "Read with this language only, such as zh-Hans-CN or en-US (default: every installed OCR language, the user's first one most thoroughly)"
    )]
    #[serde(default)]
    pub lang: Option<String>,
    #[arg(
        long,
        value_name = "FACTOR",
        requires = "image",
        help = "Display scale the saved image was captured at, such as 1.5 (default: the primary display's)"
    )]
    #[serde(default)]
    pub scale: Option<f64>,
}
