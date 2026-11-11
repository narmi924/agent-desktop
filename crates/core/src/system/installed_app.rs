use serde::{Deserialize, Serialize};

use crate::InstalledAppKind;

/// An application a person can start from the system's app list, whether or
/// not it runs now. `launch` accepts its `name` or its `id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledApp {
    pub name: String,
    pub id: String,
    pub kind: InstalledAppKind,
    /// The executable a program entry starts. Absent for a packaged app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Whether one of its processes has a window open now. Absent when the
    /// process list cannot tell, as for several entries that start one shared
    /// program with different arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_open: Option<bool>,
}

impl InstalledApp {
    /// Whether `filter` appears in the name or the id, ignoring case.
    pub fn matches_filter(&self, filter: &str) -> bool {
        let wanted = filter.trim().to_lowercase();
        wanted.is_empty()
            || self.name.to_lowercase().contains(&wanted)
            || self.id.to_lowercase().contains(&wanted)
    }
}
