use agent_desktop_core::{HumanInput, HumanPace};
use clap::{Args, ValueEnum};

#[derive(Clone, Copy, Debug, ValueEnum)]
pub(crate) enum HumanPaceArg {
    Natural,
    Careful,
}

#[derive(Args, Debug, Default)]
pub(crate) struct InteractionArgs {
    #[arg(
        long,
        global = true,
        help = "Prefer physical delivery for natural input commands and permit focus/cursor side effects. Default is strict headless semantic delivery."
    )]
    pub headed: bool,
    #[arg(
        long,
        global = true,
        value_enum,
        value_name = "PACE",
        requires = "headed",
        help = "With --headed, move the real cursor along a curved path and type one key at a time with uneven timing and corrected mistakes"
    )]
    pub human: Option<HumanPaceArg>,
    #[arg(
        long,
        global = true,
        value_name = "N",
        requires = "human",
        help = "Reproduce one human-like motion and typing plan"
    )]
    pub seed: Option<u64>,
}

impl InteractionArgs {
    pub(crate) fn human_input(&self) -> Option<HumanInput> {
        self.human.map(|pace| HumanInput {
            pace: match pace {
                HumanPaceArg::Natural => HumanPace::Natural,
                HumanPaceArg::Careful => HumanPace::Careful,
            },
            seed: self.seed,
        })
    }
}
