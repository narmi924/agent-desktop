use super::RefMap;
use crate::RefEntry;

impl RefMap {
    pub(crate) fn entries(&self) -> impl Iterator<Item = (&str, &RefEntry)> {
        self.inner.iter().map(|(id, entry)| (id.as_str(), entry))
    }
}
