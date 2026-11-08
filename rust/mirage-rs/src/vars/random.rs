use super::*;

/// bash 5.2's generator: Park-Miller's minimal standard stepped through
/// Schrage's method, so `RANDOM=42` is the same sequence everywhere.
const RANDOM_A: i64 = 16807;
const RANDOM_Q: i64 = 127_773;
const RANDOM_R: i64 = 2836;
const RANDOM_M: i64 = 0x7FFF_FFFF;
const RANDOM_ZERO_SEED: i64 = 123_459_876;
const RANDOM_MAX: u32 = 32767;

/// One step of the generator, a zero state stepping from the fixed seed.
fn step_state(state: u32) -> u32 {
    let ret = if state == 0 {
        RANDOM_ZERO_SEED
    } else {
        i64::from(state)
    };
    let high = ret / RANDOM_Q;
    let low = ret - RANDOM_Q * high;
    let step = RANDOM_A * low - RANDOM_R * high;
    (if step < 0 { step + RANDOM_M } else { step }) as u32
}

/// One draw: step until the value, the state's 16-bit halves folded to 15
/// bits, differs from the last one, as bash does.
pub(super) fn draw(mut state: u32, last: u32) -> (u32, u32) {
    loop {
        state = step_state(state);
        let value = ((state >> 16) ^ (state & 0xFFFF)) & RANDOM_MAX;
        if value != last {
            return (state, value);
        }
    }
}

/// An arithmetic evaluation's reads of `$RANDOM`. A read before the
/// expression assigns `RANDOM` draws from the session; once it assigns one,
/// the assignment is still pending, so reads draw from a scratch generator
/// seeded the way the writer will seed the session, and
/// `Store::settle` replays them once it has.
#[derive(Debug, Default)]
pub struct Draws {
    pub(super) seeded: Option<String>,
    pub(super) state: u32,
    pub(super) last: u32,
    pub(super) count: usize,
}

impl Store {
    /// Whether `RANDOM` is special here: not hidden, not ended.
    pub(super) fn random_special(&self, name: &str) -> bool {
        name == RANDOM && !self.hidden(name) && self.random_seed != Seed::Off
    }

    /// One `$RANDOM` read: a draw from the generator, or None once it is
    /// no longer special, or hidden. A value the host seeded is consumed on
    /// its first read; a seed that does not evaluate is an arithmetic error.
    pub fn next_random(&mut self) -> Result<Option<u32>, arith::Error> {
        let stored = self.scalar(RANDOM).map(<[u8]>::to_vec);
        if !self.random_special(RANDOM) || (stored.is_none() && self.random_seed != Seed::Fresh) {
            return Ok(None);
        }
        let reseed = match (&stored, &self.random_seed) {
            (Some(word), Seed::Word(seed)) if word == seed => None,
            (Some(word), _) => Some(self.seed_from(word)?),
            (None, _) => None,
        };
        let (state, last) = match (reseed, self.random_state) {
            (Some(seed), _) => (seed, 0),
            (None, None) => ((self.ids)(), 0),
            (None, Some(state)) => (state, self.random_last),
        };
        let (state, value) = draw(state, last);
        self.random_state = Some(state);
        self.random_last = value;
        let word = value.to_string().into_bytes();
        let var = match self.vars.get(RANDOM) {
            Some(existing) => existing.holding(Some(Value::Scalar(word.clone()))),
            None => Var::scalar(word.clone()),
        };
        self.place(RANDOM, Some(Arc::new(var)));
        self.random_seed = Seed::Word(word);
        Ok(Some(value))
    }

    /// A seed word as the generator's state: evaluated as arithmetic,
    /// without the generator on offer, modulo 2^32.
    fn seed_from(&mut self, word: &[u8]) -> Result<u32, arith::Error> {
        let mut reading = Reading::plain(self);
        let outcome = reading.evaluate(word, None, false, &[], false);
        outcome.value.map(|value| value as u32)
    }

    /// Seed the generator at a `RANDOM=` write: the word's value
    /// modulo 2^32, the sequence restarting.
    pub fn seed_random(&mut self, word: Vec<u8>, state: u32) {
        self.random_state = Some(state);
        self.random_seed = Seed::Word(word);
        self.random_last = 0;
    }

    /// Whether a write to RANDOM seeds it now.
    pub fn seeds_random(&self, name: &str) -> bool {
        name == RANDOM && self.random_seed != Seed::Off
    }

    /// Replay an evaluation's scratch draws on the generator, once the
    /// writer landed the seed it assigned: the session ends seeded and advanced by
    /// every read since, as bash's does.
    pub fn settle(&mut self, draws: &mut Draws) -> Result<(), arith::Error> {
        let Some(seeded) = draws.seeded.take() else {
            return Ok(());
        };
        if self.random_seed != Seed::Word(seeded.into_bytes()) {
            return Ok(());
        }
        for _ in 0..std::mem::take(&mut draws.count) {
            self.next_random()?;
        }
        Ok(())
    }
}
