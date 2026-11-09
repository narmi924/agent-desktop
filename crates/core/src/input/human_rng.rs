use std::time::{SystemTime, UNIX_EPOCH};

/// A small deterministic generator, so one seed reproduces one motion.
#[derive(Debug, Clone)]
pub struct HumanRng(u32);

impl HumanRng {
    pub fn new(seed: u64) -> Self {
        Self((seed ^ (seed >> 32)) as u32)
    }

    pub fn from_clock() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos() as u64);
        Self::new(nanos)
    }

    pub(crate) fn unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut mixed = self.0;
        mixed = (mixed ^ (mixed >> 15)).wrapping_mul(mixed | 1);
        mixed ^= mixed.wrapping_add((mixed ^ (mixed >> 7)).wrapping_mul(mixed | 61));
        f64::from(mixed ^ (mixed >> 14)) / 4_294_967_296.0
    }

    pub(crate) fn between(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * self.unit()
    }

    pub(crate) fn chance(&mut self, probability: f64) -> bool {
        self.unit() < probability
    }
}
