/// How deliberately human-like input moves and types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HumanPace {
    Natural,
    Careful,
}

impl HumanPace {
    pub(crate) fn motion_scale(self) -> f64 {
        match self {
            Self::Natural => 1.0,
            Self::Careful => 1.55,
        }
    }

    pub(crate) fn overshoot_chance(self) -> f64 {
        match self {
            Self::Natural => 0.45,
            Self::Careful => 0.7,
        }
    }

    pub(crate) fn extra_correction_chance(self) -> f64 {
        match self {
            Self::Natural => 0.35,
            Self::Careful => 0.8,
        }
    }

    pub(crate) fn key_base_ms(self) -> f64 {
        match self {
            Self::Natural => 125.0,
            Self::Careful => 210.0,
        }
    }

    pub(crate) fn key_spread(self) -> f64 {
        match self {
            Self::Natural => 0.42,
            Self::Careful => 0.5,
        }
    }

    pub(crate) fn typo_chance(self) -> f64 {
        match self {
            Self::Natural => 0.05,
            Self::Careful => 0.09,
        }
    }

    pub(crate) fn thinking_chance(self) -> f64 {
        match self {
            Self::Natural => 0.03,
            Self::Careful => 0.07,
        }
    }

    pub(crate) fn word_gap_ms(self) -> f64 {
        match self {
            Self::Natural => 130.0,
            Self::Careful => 260.0,
        }
    }
}
