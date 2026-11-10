/// The output a host's `drain` call gathers before it hands back.
pub const PIECE: usize = 16 * 1024;

/// The bounded steps one host `drain` call runs at most.
pub const STEPS: usize = 8;

/// The most output one call or step writes before it yields.
pub(crate) const OUTPUT: usize = 64 * 1024;

/// The units of work one call does before it yields.
pub(crate) const WORK: usize = 16 * 1024;

/// The steps one `drain` of a script engine runs before the host may yield.
pub(crate) const DRAIN_STEPS: usize = 20_000;

/// How much output, or what one file or pipe holds, waits before it goes
/// to the host.
pub(crate) const FLUSH: usize = 64 * 1024;

/// The capacity a buffer keeps between records; a larger one is released.
pub(crate) const KEPT: usize = 64 * 1024;

/// How many links one path may pass through, as the kernel allows.
pub(crate) const MAX_LINKS: usize = 40;

/// The most one run holds of a record, a line or what it gathers: past it
/// the run fails as the real command does once memory runs out.
#[cfg(not(test))]
pub(crate) const MAX_HELD: usize = 1 << 30;
#[cfg(test)]
pub(crate) const MAX_HELD: usize = 1 << 19;
