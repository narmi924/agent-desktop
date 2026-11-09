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
        help = "Report where this text appears; ignores spacing and case"
    )]
    #[serde(default)]
    pub find: Option<String>,
    #[arg(
        long,
        value_name = "TAG",
        help = "Language tag such as zh-Hans-CN or en-US (default: the user's languages)"
    )]
    #[serde(default)]
    pub lang: Option<String>,
}
