use super::human_pace::HumanPace;
use super::human_rng::HumanRng;

/// A request for human-like physical input, reproducible when a seed is given.
/// `typos` lets typing strike a wrong key now and then and correct it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HumanInput {
    pub pace: HumanPace,
    pub seed: Option<u64>,
    pub typos: bool,
}

impl HumanInput {
    pub fn rng(&self) -> HumanRng {
        self.seed.map_or_else(HumanRng::from_clock, HumanRng::new)
    }
}
