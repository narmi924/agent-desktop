use super::human_pace::HumanPace;
use super::human_rng::HumanRng;

/// A request for human-like physical input, reproducible when a seed is given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HumanInput {
    pub pace: HumanPace,
    pub seed: Option<u64>,
}

impl HumanInput {
    pub fn rng(&self) -> HumanRng {
        self.seed.map_or_else(HumanRng::from_clock, HumanRng::new)
    }
}
