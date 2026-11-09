use crate::HumanInput;

/// How a request should reach its element, beyond what its policy permits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ActionDelivery {
    pub(crate) scroll_by_viewport: bool,
    pub(crate) focused_page_typing: bool,
    pub(crate) human: Option<HumanInput>,
}
