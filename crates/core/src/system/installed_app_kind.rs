use serde::{Deserialize, Serialize};

/// How an installed application starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstalledAppKind {
    /// A packaged application the system activates by its application id.
    Packaged,
    /// An executable started from its path, with the arguments its entry carries.
    Program,
}
