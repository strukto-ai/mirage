use std::io::{ErrorKind, Write};

use lzma_rust2::{Action, Status, XzOptions, XzStream, XzWriter};

use super::{Failure, Pack, Step, Unpack};
use crate::StreamError;

const MAGIC: &[u8] = b"\xfd7zXZ\0";
pub(super) const FORMAT: &str = "xz: ({}): File format not recognized";
pub(super) const CORRUPT: &str = "xz: ({}): Compressed data is corrupt";
pub(super) const TRUNCATED: &str = "xz: ({}): Unexpected end of input";
const UNSUPPORTED: &str = "xz: ({}): Unsupported options";

fn failure(reason: &str) -> Failure {
    Failure {
        reasons: vec![reason.into()],
        fatal: true,
        exit_code: 1,
        keeps_output: false,
        first_header: false,
    }
}

enum Part {
    Stream(Box<XzStream>),
    Padding(usize),
}

/// xz -d over concatenated streams and the zero padding between them, in
/// xz 5.8's words: the first stream must open with xz's magic, a later one
/// that does not is corrupt data, and one cut short is an unexpected end.
pub(super) struct Decoder {
    part: Part,
    streams: usize,
    checked: usize,
}

impl Decoder {
    pub(super) fn new() -> Self {
        Self {
            part: Part::Stream(Box::new(XzStream::new(false))),
            streams: 0,
            checked: 0,
        }
    }
}

impl Unpack for Decoder {
    fn unpack(&mut self, input: &[u8], output: &mut [u8], eof: bool) -> Step {
        let mut step = Step::default();
        loop {
            let data = &input[step.consumed..];
            match &mut self.part {
                Part::Padding(count) => {
                    let zeros = data.iter().take_while(|byte| **byte == 0).count();
                    *count += zeros;
                    step.consumed += zeros;
                    if zeros == data.len() && !eof {
                        return step;
                    }
                    if *count % 4 != 0 {
                        step.failure = Some(failure(CORRUPT));
                        return step;
                    }
                    if zeros == data.len() {
                        step.ended = true;
                        return step;
                    }
                    self.part = Part::Stream(Box::new(XzStream::new(false)));
                }
                Part::Stream(stream) => {
                    if self.streams == 0 && self.checked < MAGIC.len() {
                        let count = data.len().min(MAGIC.len() - self.checked);
                        let wanted = &MAGIC[self.checked..self.checked + count];
                        if data[..count] != *wanted || (eof && self.checked + count < MAGIC.len()) {
                            step.failure = Some(failure(FORMAT));
                            return step;
                        }
                        self.checked += count;
                    }
                    if step.produced == output.len() {
                        return step;
                    }
                    let (read, written) = (stream.total_in(), stream.total_out());
                    let action = if eof { Action::Finish } else { Action::Run };
                    let result = stream.process(data, &mut output[step.produced..], action);
                    let consumed = (stream.total_in() - read) as usize;
                    let produced = (stream.total_out() - written) as usize;
                    step.consumed += consumed;
                    step.produced += produced;
                    match result {
                        Ok(result) if result.status == Status::StreamEnd => {
                            self.streams += 1;
                            self.part = Part::Padding(0);
                        }
                        Ok(_) if consumed == 0 && produced == 0 => return step,
                        Ok(_) => {}
                        Err(err) => {
                            step.failure = Some(failure(match err.kind() {
                                ErrorKind::UnexpectedEof => TRUNCATED,
                                ErrorKind::Unsupported => UNSUPPORTED,
                                _ => CORRUPT,
                            }));
                            return step;
                        }
                    }
                }
            }
        }
    }
}

/// xz at a preset, 6 (xz's default) for -1, with xz's CRC64 check.
pub(super) struct Encoder {
    writer: Option<XzWriter<Vec<u8>>>,
    pending: Vec<u8>,
    at: usize,
}

impl Encoder {
    pub(super) fn new(level: i32) -> Result<Self, StreamError> {
        let preset = if level < 0 { 6 } else { level as u32 };
        let writer = XzWriter::new(Vec::new(), XzOptions::with_preset(preset))
            .map_err(|err| StreamError::new(err.to_string()))?;
        Ok(Self {
            writer: Some(writer),
            pending: Vec::new(),
            at: 0,
        })
    }
}

impl Pack for Encoder {
    fn pack(&mut self, input: &[u8], output: &mut [u8], eof: bool) -> Result<Step, StreamError> {
        let failed = |err: std::io::Error| StreamError::new(err.to_string());
        let mut step = Step::default();
        if let Some(writer) = self.writer.as_mut() {
            writer.write_all(input).map_err(failed)?;
            step.consumed = input.len();
            if eof {
                let writer = self.writer.take().expect("an open writer");
                self.pending.extend(writer.finish().map_err(failed)?);
            } else {
                self.pending.append(writer.inner_mut());
            }
        }
        step.produced = output.len().min(self.pending.len() - self.at);
        output[..step.produced].copy_from_slice(&self.pending[self.at..self.at + step.produced]);
        self.at += step.produced;
        if self.at == self.pending.len() {
            self.pending.clear();
            self.at = 0;
        }
        step.ended = self.writer.is_none() && self.pending.is_empty();
        Ok(step)
    }
}
