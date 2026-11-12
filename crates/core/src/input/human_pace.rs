use super::human_rng::HumanRng;

/// How deliberately human-like input moves and types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HumanPace {
    Natural,
    Careful,
}

const SHORTEST_CORRECTION: f64 = 0.012;

impl HumanPace {
    pub fn name(self) -> &'static str {
        match self {
            Self::Natural => "natural",
            Self::Careful => "careful",
        }
    }

    pub(crate) fn motion_scale(self) -> f64 {
        match self {
            Self::Natural => 1.0,
            Self::Careful => 1.3,
        }
    }

    /// The share of the distance the first stroke covers. A natural hand
    /// usually stops a little short and now and then goes a little past; a
    /// careful one always stops short and closes the rest slowly.
    pub(crate) fn reach(self, rng: &mut HumanRng) -> f64 {
        let reach = match self {
            Self::Natural => rng.normal(0.95, 0.04).clamp(0.86, 1.04),
            Self::Careful => rng
                .normal(0.93, 0.03)
                .clamp(0.86, 1.0 - SHORTEST_CORRECTION),
        };
        if (1.0 - reach).abs() < SHORTEST_CORRECTION {
            1.0 - SHORTEST_CORRECTION
        } else {
            reach
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
            Self::Careful => 0.02,
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
