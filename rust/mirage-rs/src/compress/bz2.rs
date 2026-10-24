use bzip2::{Action, Compress, Compression, Decompress, Error, Status};

use super::{Failure, Pack, Step, Unpack};
use crate::StreamError;

pub(super) const NOT_BZIP2: &str = "bzip2: ({}) is not a bzip2 file.";
pub(super) const INTEGRITY: &str = "\nbzip2: Data integrity error when decompressing.
\tInput file = ({}), output file = (stdout)

It is possible that the compressed file(s) have become corrupted.
You can use the -tvv option to test integrity of such files.

You can use the `bzip2recover' program to attempt to recover
data from undamaged sections of corrupted files.
";
pub(super) const ENDS: &str = "\nbzip2: Compressed file ends unexpectedly;
\tperhaps it is corrupted?  *Possible* reason follows.
bzip2: Inappropriate ioctl for device
\tInput file = ({}), output file = (stdout)

It is possible that the compressed file(s) have become corrupted.
You can use the -tvv option to test integrity of such files.

You can use the `bzip2recover' program to attempt to recover
data from undamaged sections of corrupted files.
";

fn failure(reason: &str) -> Failure {
    Failure {
        reasons: vec![reason.into()],
        fatal: true,
        exit_code: 2,
        keeps_output: false,
        first_header: false,
    }
}

/// bzip2 -d over concatenated streams, in bzip2 1.0.8's words. A stream
/// that follows a whole one and does not start with bzip2's magic is
/// ignored; bzip2 also warns that it ignored it, which mirage does not.
pub(super) struct Decoder {
    stream: Option<Decompress>,
    streams: usize,
}

impl Decoder {
    pub(super) fn new() -> Self {
        Self {
            stream: Some(Decompress::new(false)),
            streams: 0,
        }
    }
}

impl Unpack for Decoder {
    fn unpack(&mut self, input: &[u8], output: &mut [u8], eof: bool) -> Step {
        let mut step = Step::default();
        loop {
            let data = &input[step.consumed..];
            let Some(stream) = self.stream.as_mut() else {
                if data.is_empty() {
                    step.ended = eof;
                    return step;
                }
                self.stream = Some(Decompress::new(false));
                continue;
            };
            if step.produced == output.len() {
                return step;
            }
            let (read, written) = (stream.total_in(), stream.total_out());
            let status = stream.decompress(data, &mut output[step.produced..]);
            let consumed = (stream.total_in() - read) as usize;
            let produced = (stream.total_out() - written) as usize;
            step.consumed += consumed;
            step.produced += produced;
            match status {
                Ok(Status::StreamEnd) => {
                    self.stream = None;
                    self.streams += 1;
                }
                Ok(_) if consumed == 0 && produced == 0 => {
                    if eof {
                        step.failure = Some(failure(ENDS));
                    }
                    return step;
                }
                Ok(_) => {}
                Err(Error::DataMagic) if self.streams > 0 => {
                    step.consumed = input.len();
                    step.ended = true;
                    return step;
                }
                Err(Error::DataMagic) => {
                    step.failure = Some(failure(NOT_BZIP2));
                    return step;
                }
                Err(_) => {
                    step.failure = Some(failure(INTEGRITY));
                    return step;
                }
            }
        }
    }
}

/// bzip2 at a level, 9 (bzip2's default) for -1.
pub(super) struct Encoder {
    stream: Compress,
}

impl Encoder {
    pub(super) fn new(level: i32) -> Self {
        Self {
            stream: Compress::new(
                Compression::new(if level < 1 { 9 } else { level as u32 }),
                0,
            ),
        }
    }
}

impl Pack for Encoder {
    fn pack(&mut self, input: &[u8], output: &mut [u8], eof: bool) -> Result<Step, StreamError> {
        let (read, written) = (self.stream.total_in(), self.stream.total_out());
        let status = self
            .stream
            .compress(
                input,
                output,
                if eof { Action::Finish } else { Action::Run },
            )
            .map_err(|err| StreamError::new(err.to_string()))?;
        Ok(Step {
            consumed: (self.stream.total_in() - read) as usize,
            produced: (self.stream.total_out() - written) as usize,
            ended: status == Status::StreamEnd,
            failure: None,
        })
    }
}
