use clap::Parser;
use serde::Deserialize;

#[derive(Parser, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DropFilesArgs {
    /// Files to drop, all from one folder; the receiving app gets copies of them, the originals stay
    #[arg(required = true, value_name = "FILE")]
    pub files: Vec<std::path::PathBuf>,
    /// Drop at the centre of this element ref
    #[arg(long = "ref", value_name = "REF", conflicts_with_all = ["frame", "xy"], required_unless_present = "frame")]
    #[serde(default, rename = "ref")]
    pub ref_id: Option<String>,
    /// Captured window image from the companion's view command; --xy is then in that image's pixels
    #[arg(long, value_name = "IMAGE.png", requires = "xy")]
    #[serde(default)]
    pub frame: Option<std::path::PathBuf>,
    /// Drop point as x,y in the pixels of the --frame image
    #[arg(long, requires = "frame")]
    #[serde(default)]
    pub xy: Option<String>,
}

#[cfg(test)]
#[path = "file_drop_tests.rs"]
mod tests;
