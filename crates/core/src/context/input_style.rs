use super::CommandContext;
use super::action_guards::ActionGuards;
use crate::HumanInput;

impl CommandContext {
    pub fn with_guards(mut self, guards: ActionGuards) -> Self {
        self.options.guards = guards;
        self
    }

    pub fn guards(&self) -> &ActionGuards {
        &self.options.guards
    }

    pub fn with_human(mut self, human: Option<HumanInput>) -> Self {
        self.options.human = human;
        self
    }

    pub fn human(&self) -> Option<HumanInput> {
        self.options.human
    }
}
