use serde::Serialize;

use crate::StreamError;

/// What one call into a codec past gzip did: the input it consumed, the
/// output it wrote, and whether its data ended or failed there.
#[derive(Default)]
pub(super) struct Step {
    pub(super) consumed: usize,
    pub(super) produced: usize,
    pub(super) ended: bool,
    pub(super) failure: Option<Failure>,
}

/// A decoder whose failures are its program's own lines. With `eof` no
/// input follows `input`, and a call that can make no progress then ends
/// or fails.
pub(super) trait Unpack: Send + Sync {
    fn unpack(&mut self, input: &[u8], output: &mut [u8], eof: bool) -> Step;
}

/// An encoder; with `eof` it flushes and ends its data.
pub(super) trait Pack: Send + Sync {
    fn pack(&mut self, input: &[u8], output: &mut [u8], eof: bool) -> Result<Step, StreamError>;
}

#[derive(Serialize)]
pub(super) struct Failure {
    pub(super) reasons: Vec<String>,
    pub(super) fatal: bool,
    pub(super) exit_code: i32,
    pub(super) keeps_output: bool,
    pub(super) first_header: bool,
}
