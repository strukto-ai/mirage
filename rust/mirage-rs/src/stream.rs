use std::fmt;

use crate::constants::{KEPT, PIECE, STEPS};

/// One command's byte processing: bytes are pushed in chunk by chunk and its output is
/// appended to `out`, so the host keeps the I/O and the stream keeps only
/// the state the command needs between chunks. A host may free a stream
/// on another thread than the one that made it (Python's cycle collector
/// runs wherever it runs), so a stream is `Send + Sync`.
pub trait Stream: Send + Sync {
    /// Consume one chunk. Output written before an error stays in `out`.
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError>;

    /// End of input: flush whatever the stream held back.
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError>;

    /// For a stream that reads several inputs, the one it needs bytes from
    /// before it can write more; `None` once every input has ended or each
    /// has what it needs, as while the stream is `busy`.
    fn wants(&self) -> Option<usize> {
        None
    }

    /// Consume one chunk of input `index`.
    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let _ = index;
        self.feed(input, out)
    }

    /// Input `index` has ended.
    fn end_input(&mut self, index: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let _ = (index, out);
        Ok(())
    }

    /// Whether the stream has work or output left for `drain`: a stream
    /// that would otherwise hold the host for long does it a bounded step
    /// per `drain`, and the host yields between steps.
    fn busy(&self) -> bool {
        false
    }

    /// One bounded step of the work `busy` reports, and any output it
    /// writes.
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let _ = out;
        Ok(())
    }

    /// Stop processing and schedule bounded retirement through `drain`.
    /// False means the stream has no incremental cancellation protocol.
    fn cancel(&mut self) -> bool {
        false
    }

    /// For a stream that reads one input after another, start the next
    /// with its own configuration; `finish` ends each one.
    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let _ = config;
        Err(StreamError::new("this stream reads one input"))
    }

    /// Answer a yes-or-no question about one whole input in one call: the
    /// bytes fed since the last answer, then `input`. The next input starts
    /// empty. It is for a host asking once per name, where the calls of
    /// `begin`, `feed`, `finish` and `drain` would cost more than the work.
    fn test(&mut self, input: &[u8]) -> Result<bool, StreamError> {
        let _ = input;
        Err(StreamError::new("this stream answers no test"))
    }

    /// Whether the stream wants no more of the current input: the host
    /// stops reading it and calls `finish`.
    fn done(&self) -> bool {
        false
    }

    /// The command's exit status for the input so far.
    fn status(&self) -> i32 {
        0
    }

    /// Serialize the command's current typed progress, when it exposes one.
    fn metadata(&self, out: &mut Vec<u8>) {
        let _ = out;
    }

    /// Append what the command has written to stderr since the last call:
    /// warnings and notices, which do not stop it.
    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        let _ = err;
    }

    /// The host operation the stream waits on before it can go on, for a
    /// stream that reaches files and commands: a JSON header naming it,
    /// with the bytes it carries appended to `data`. None while it waits
    /// on none; each one taken is answered by `respond`.
    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let _ = data;
        None
    }

    /// The host's answer to the request taken last: a JSON reply and the
    /// bytes it carries.
    fn respond(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let _ = (reply, data, out);
        Err(StreamError::new("this stream makes no requests"))
    }

    /// `respond` from a host that gives up the bytes it carries, so a
    /// stream that keeps them, a file read whole, holds no second copy.
    fn respond_owned(
        &mut self,
        reply: &[u8],
        data: Vec<u8>,
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        self.respond(reply, &data, out)
    }
}

/// A refusal: the message is the command's own stderr wording, or what the
/// host reports it as (`sort -c` sends the disordered record's number),
/// and the status the command exits with. A refusal of a command's
/// options or operands holds its stderr one character per byte, so both
/// hosts write back the same bytes whether `open` fails with it or a
/// `Refused` stream reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamError {
    pub message: String,
    pub status: i32,
}

impl StreamError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: 1,
        }
    }

    /// The refusal of a command's options or operands: the bytes it writes
    /// to stderr, without the final newline, and its exit status.
    pub fn refusal(stderr: &[u8], status: i32) -> Self {
        Self {
            message: byte_text(stderr),
            status,
        }
    }

    /// The bytes the refusal writes to stderr.
    pub(crate) fn stderr(&self) -> Vec<u8> {
        latin1_bytes(&self.message).unwrap_or_else(|| self.message.as_bytes().to_vec())
    }
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StreamError {}

/// Bytes as a string of one character per byte, the form `latin1` reads
/// back and a refusal carries its stderr in.
pub(crate) fn byte_text(raw: &[u8]) -> String {
    raw.iter().map(|&b| char::from(b)).collect()
}

pub(crate) fn latin1_bytes(text: &str) -> Option<Vec<u8>> {
    text.chars()
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect()
}

/// What a host's `drain` call runs: bounded steps of the work `busy`
/// reports, until they have written a piece of output, the stream is no
/// longer busy, or `STEPS` of them have run. A stream whose steps write a
/// few bytes each (`cut`, `jq`) or none (`sort` before its output) then
/// crosses into the host, and on down a pipe, once per piece rather than
/// once per step, and the host still yields between calls.
pub fn drain_steps(stream: &mut dyn Stream, out: &mut Vec<u8>) -> Result<(), StreamError> {
    let start = out.len();
    for _ in 0..STEPS {
        stream.drain(out)?;
        if out.len() - start >= PIECE || !stream.busy() {
            break;
        }
    }
    Ok(())
}

/// Release a transient giant byte buffer once little of it remains. Keep
/// ordinary working chunks to avoid an allocation on every record.
pub fn release_capacity(buffer: &mut Vec<u8>) {
    let needed = buffer.len().max(KEPT);
    if buffer.capacity() / 4 > needed {
        buffer.shrink_to(needed);
    }
}

#[cfg(test)]
mod tests {
    use super::{Stream, StreamError, drain_steps};
    use crate::constants::{PIECE, STEPS};

    struct Steps {
        left: usize,
        width: usize,
        taken: usize,
    }

    impl Stream for Steps {
        fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
            Ok(())
        }
        fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
            Ok(())
        }
        fn busy(&self) -> bool {
            self.left > 0
        }
        fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
            self.left -= 1;
            self.taken += 1;
            out.resize(out.len() + self.width, b'x');
            if self.left == 1 && self.width == 3 {
                return Err(StreamError::new("refused"));
            }
            Ok(())
        }
    }

    fn drained(left: usize, width: usize) -> (usize, usize) {
        let mut stream = Steps {
            left,
            width,
            taken: 0,
        };
        let mut out = Vec::new();
        drain_steps(&mut stream, &mut out).expect("drain");
        (stream.taken, out.len())
    }

    #[test]
    fn a_call_gathers_small_steps_up_to_its_step_bound() {
        assert_eq!(drained(100, 10), (STEPS, STEPS * 10));
    }

    #[test]
    fn a_call_hands_back_once_it_holds_a_piece() {
        assert_eq!(drained(100, PIECE / 2), (2, PIECE));
        assert_eq!(drained(100, PIECE * 4), (1, PIECE * 4));
    }

    #[test]
    fn a_call_ends_with_the_work() {
        assert_eq!(drained(3, 10), (3, 30));
    }

    #[test]
    fn a_refusal_keeps_the_output_written_before_it() {
        let mut stream = Steps {
            left: 5,
            width: 3,
            taken: 0,
        };
        let mut out = Vec::new();
        assert!(drain_steps(&mut stream, &mut out).is_err());
        assert_eq!((stream.taken, out.len()), (4, 12));
    }
}
