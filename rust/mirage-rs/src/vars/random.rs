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
