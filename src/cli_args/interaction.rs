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
        help = "With --headed, move the real cursor along a curved path, turn the wheel a line at a time and type one key at a time with uneven timing"
    )]
    pub human: Option<HumanPaceArg>,
    #[arg(
        long,
        global = true,
        requires = "human",
        help = "With --human, let typing strike a wrong key now and then and correct it; never in password, code or payment fields"
    )]
    pub typos: bool,
    #[arg(
        long,
        global = true,
        value_name = "N",
        requires = "human",
        help = "Reproduce one human-like motion and typing plan"
    )]
    pub seed: Option<u64>,
    #[arg(
        long,
        global = true,
        value_name = "PATH",
        help = "After a mutating command, report in data.receipt whether this file was created or changed"
    )]
    pub expect_file: Option<std::path::PathBuf>,
    #[arg(
        long,
        global = true,
        value_name = "MS",
        default_value_t = 3000,
        requires = "expect_file",
        help = "How long to wait for --expect-file to change"
    )]
    pub expect_within: u64,
    #[arg(
        long,
        global = true,
        value_name = "MS",
        help = "With --headed, wait until the keyboard and mouse have been idle this long before sending input"
    )]
    pub when_idle: Option<u64>,
}

impl InteractionArgs {
    pub(crate) fn guards(&self) -> agent_desktop_core::context::action_guards::ActionGuards {
        agent_desktop_core::context::action_guards::ActionGuards {
            expect_file: self.expect_file.clone(),
            expect_within_ms: self.expect_within,
            when_idle_ms: self.when_idle,
        }
    }

    pub(crate) fn human_input(&self) -> Option<HumanInput> {
        self.human.map(|pace| HumanInput {
            pace: match pace {
                HumanPaceArg::Natural => HumanPace::Natural,
                HumanPaceArg::Careful => HumanPace::Careful,
            },
            seed: self.seed,
            typos: self.typos,
        })
    }
}
