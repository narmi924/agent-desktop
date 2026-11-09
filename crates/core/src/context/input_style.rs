use super::CommandContext;
use crate::HumanInput;

impl CommandContext {
    pub fn with_human(mut self, human: Option<HumanInput>) -> Self {
        self.options.human = human;
        self
    }

    pub fn human(&self) -> Option<HumanInput> {
        self.options.human
    }
}
