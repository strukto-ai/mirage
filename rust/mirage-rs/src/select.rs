use std::collections::VecDeque;

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

const WORK: usize = 16 * 1024;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    First,
    ExceptLast,
    Last,
    Skip,
    Reverse,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Unit {
    Bytes,
    Records,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    mode: Mode,
    unit: Unit,
    count: String,
    terminator: u8,
}

enum Phase {
    Reading,
    End,
    TrimHead,
    TrimTail,
    Emit,
    Retire,
    Done,
}

struct Block {
    data: Vec<u8>,
    start: usize,
    records: u64,
}

struct Select {
    mode: Mode,
    unit: Unit,
    terminator: u8,
    remaining: u64,
    limit: u64,
    phase: Phase,
    input: Vec<u8>,
    position: usize,
    consumed: usize,
    blocks: VecDeque<Block>,
    bytes: u64,
    records: u64,
    terminated: bool,
    first_window: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    if config.mode == Mode::Reverse && config.unit != Unit::Records {
        return Err(StreamError::new("reverse selection requires records"));
    }
    if config.count.is_empty() || !config.count.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(StreamError::new(
            "a selection count must be a non-negative decimal integer",
        ));
    }
    let count = config.count.bytes().fold(0_u64, |count, byte| {
        count
            .saturating_mul(10)
            .saturating_add(u64::from(byte - b'0'))
    });
    let mode = if config.mode == Mode::ExceptLast && count == 0 {
        Mode::Skip
    } else {
        config.mode
    };
    Ok(Box::new(Select {
        mode,
        unit: config.unit,
        terminator: config.terminator,
        remaining: count,
        limit: count,
        phase: Phase::Reading,
        input: Vec::new(),
        position: 0,
        consumed: 0,
        blocks: VecDeque::new(),
        bytes: 0,
        records: 0,
        terminated: true,
        first_window: true,
    }))
}

fn prefix(data: &[u8], unit: Unit, terminator: u8, wanted: u64) -> (usize, u64) {
    if wanted == 0 {
        return (0, 0);
    }
    if unit == Unit::Bytes {
        let length = data
            .len()
            .min(usize::try_from(wanted).unwrap_or(usize::MAX));
        return (length, length as u64);
    }
    let mut found = 0;
    for at in memchr::memchr_iter(terminator, data) {
        found += 1;
        if found == wanted {
            return (at + 1, found);
        }
    }
    (data.len(), found)
}

impl Select {
    fn reverse(&mut self) {
        if self.input.is_empty() {
            return;
        }
        if self.first_window {
            if self.input.last() == Some(&self.terminator) {
                self.remaining = self.remaining.saturating_add(1);
            }
            self.first_window = false;
        }
        let start = self.position.saturating_sub(WORK);
        for at in memchr::memrchr_iter(self.terminator, &self.input[start..self.position]) {
            self.remaining -= 1;
            if self.remaining == 0 {
                self.consumed = start + at + 1;
                return;
            }
        }
        self.position = start;
        if start == 0 {
            self.input.clear();
        }
    }

    fn held(&self) -> u64 {
        match self.unit {
            Unit::Bytes => self.bytes,
            Unit::Records => self.records,
        }
    }

    fn trim(&mut self, out: &mut Vec<u8>) {
        let over = self.held().saturating_sub(self.limit);
        if over == 0 {
            return;
        }
        let Some(block) = self.blocks.front_mut() else {
            return;
        };
        let data = &block.data[block.start..];
        let (length, records) = if self.unit == Unit::Bytes {
            (
                data.len().min(usize::try_from(over).unwrap_or(usize::MAX)),
                0,
            )
        } else if block.records < over {
            (data.len(), block.records)
        } else {
            prefix(data, self.unit, self.terminator, over)
        };
        if self.mode == Mode::ExceptLast {
            out.extend_from_slice(&data[..length]);
        }
        self.bytes -= length as u64;
        self.records -= records;
        block.records -= records;
        block.start += length;
        if block.start == block.data.len() {
            self.blocks.pop_front();
        }
    }

    fn consume(&mut self, out: &mut Vec<u8>) {
        let end = self.input.len().min(self.position.saturating_add(WORK));
        let data = &self.input[self.position..end];
        if matches!(self.mode, Mode::First | Mode::Skip) {
            let (length, units) = prefix(data, self.unit, self.terminator, self.remaining);
            self.remaining -= units;
            if self.mode == Mode::First {
                out.extend_from_slice(&data[..length]);
                self.position += length;
            } else {
                if self.remaining == 0 {
                    out.extend_from_slice(&data[length..]);
                }
                self.position = end;
            }
        } else {
            let records = if self.unit == Unit::Records {
                memchr::memchr_iter(self.terminator, data).count() as u64
            } else {
                0
            };
            self.bytes += data.len() as u64;
            self.records += records;
            if let Some(&last) = data.last() {
                self.terminated = last == self.terminator;
            }
            self.blocks.push_back(Block {
                data: data.to_vec(),
                start: 0,
                records,
            });
            self.position = end;
            self.trim(out);
        }
        self.consumed = self.position;
        if self.position == self.input.len() {
            self.input.clear();
            self.position = 0;
        }
    }

    fn step(&mut self, out: &mut Vec<u8>) {
        match self.phase {
            Phase::Retire => {
                for _ in 0..64 {
                    match self.blocks.pop_front() {
                        Some(block) => {
                            self.bytes -= (block.data.len() - block.start) as u64;
                            self.records -= block.records;
                        }
                        None => {
                            self.phase = Phase::Done;
                            break;
                        }
                    }
                }
            }
            Phase::Reading => {
                if self.mode == Mode::Reverse {
                    self.reverse();
                } else if self.held() > self.limit {
                    self.trim(out);
                } else if self.position < self.input.len() && !self.done() {
                    self.consume(out);
                }
            }
            Phase::End => {
                let extra = self.unit == Unit::Records
                    && !self.terminated
                    && self.records == self.limit
                    && self.limit > 0;
                self.phase = match self.mode {
                    Mode::First | Mode::Skip | Mode::Reverse => Phase::Done,
                    Mode::ExceptLast if extra => {
                        self.limit -= 1;
                        Phase::TrimHead
                    }
                    Mode::ExceptLast => Phase::Done,
                    Mode::Last if extra => {
                        self.limit -= 1;
                        Phase::TrimTail
                    }
                    Mode::Last => Phase::Emit,
                };
            }
            Phase::TrimHead | Phase::TrimTail => {
                if self.held() > self.limit {
                    self.trim(out);
                } else {
                    self.phase = if matches!(self.phase, Phase::TrimHead) {
                        Phase::Done
                    } else {
                        Phase::Emit
                    };
                }
            }
            Phase::Emit => match self.blocks.pop_front() {
                Some(block) => {
                    out.extend_from_slice(&block.data[block.start..]);
                    self.bytes -= (block.data.len() - block.start) as u64;
                    self.records -= block.records;
                }
                None => self.phase = Phase::Done,
            },
            Phase::Done => {}
        }
    }
}

impl Stream for Select {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.done() || (input.is_empty() && matches!(self.phase, Phase::Done)) {
            return Ok(());
        }
        if self.busy() || !matches!(self.phase, Phase::Reading) {
            return Err(StreamError::new("selection is not ready for input"));
        }
        self.input.clear();
        self.input.extend_from_slice(input);
        self.position = if self.mode == Mode::Reverse {
            input.len()
        } else {
            0
        };
        self.consumed = 0;
        self.step(out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.busy() {
            return Err(StreamError::new("selection still has pending input"));
        }
        self.phase = Phase::End;
        self.step(out);
        Ok(())
    }

    fn done(&self) -> bool {
        (matches!(self.mode, Mode::First | Mode::Reverse) && self.remaining == 0)
            || (self.mode == Mode::Last && self.limit == 0 && matches!(self.phase, Phase::Reading))
    }

    fn busy(&self) -> bool {
        match self.phase {
            Phase::Reading if self.mode == Mode::Reverse => !self.done() && self.position > 0,
            Phase::Reading => {
                !self.done() && (self.position < self.input.len() || self.held() > self.limit)
            }
            Phase::Done => false,
            _ => true,
        }
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }

    fn metadata(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(
            format!(
                "{{\"consumed\":{},\"retained\":{}}}",
                self.consumed, self.bytes
            )
            .as_bytes(),
        );
    }

    fn cancel(&mut self) -> bool {
        self.input.clear();
        self.position = 0;
        self.phase = Phase::Retire;
        true
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{open, run};

    #[test]
    fn record_selection_is_independent_of_input_chunks() {
        for (mode, input, expected) in [
            (
                "first",
                b"a\nbb\nccc\nlast".as_slice(),
                b"a\nbb\n".as_slice(),
            ),
            ("skip", b"a\nbb\nccc\nlast", b"ccc\nlast"),
            ("except_last", b"a\nbb\nccc\nlast", b"a\nbb\n"),
            ("last", b"a\nbb\nccc\nlast", b"ccc\nlast"),
            ("except_last", b"a\nbb\nccc\n", b"a\n"),
            ("last", b"a\nbb\nccc\n", b"bb\nccc\n"),
        ] {
            let config =
                json!({"mode":mode,"unit":"records","count":"2","terminator":10}).to_string();
            for size in 1..=input.len() {
                let chunks: Vec<_> = input.chunks(size).collect();
                let (output, error) = run("select", &config, &chunks);
                assert_eq!(error, None, "{mode} {size}");
                assert_eq!(output, expected, "{mode} {size}");
            }
        }
    }

    #[test]
    fn byte_windows_and_nul_records_keep_raw_input() {
        for (mode, expected) in [
            ("first", b"a\xff".as_slice()),
            ("skip", b"\0cd"),
            ("last", b"cd"),
            ("except_last", b"a\xff\0"),
        ] {
            let config = json!({"mode":mode,"unit":"bytes","count":"2","terminator":0}).to_string();
            assert_eq!(run("select", &config, &[b"a\xff", b"\0cd"]).0, expected);
        }
        assert_eq!(
            run(
                "select",
                r#"{"mode":"last","unit":"records","count":"1","terminator":0}"#,
                &[b"a\0b"]
            )
            .0,
            b"b"
        );
    }

    #[test]
    fn early_exit_reports_the_exact_consumed_prefix() {
        let mut stream = open(
            "select",
            br#"{"mode":"first","unit":"records","count":"1","terminator":10}"#,
        )
        .unwrap();
        let mut output = Vec::new();
        stream.feed(b"a\nb\n", &mut output).unwrap();
        assert_eq!(output, b"a\n");
        assert!(stream.done());
        assert!(!stream.busy());
        let mut metadata = Vec::new();
        stream.metadata(&mut metadata);
        assert_eq!(metadata, b"{\"consumed\":2,\"retained\":0}");
    }

    #[test]
    fn reverse_windows_keep_the_count_across_pulls() {
        for (windows, cut) in [
            ([b"\nlast".as_slice(), b"a\nbb\nccc".as_slice()], 5),
            ([b"ccc\n".as_slice(), b"a\nbb\n".as_slice()], 2),
        ] {
            let mut stream = open(
                "select",
                br#"{"mode":"reverse","unit":"records","count":"2","terminator":10}"#,
            )
            .unwrap();
            let mut output = Vec::new();
            for window in windows {
                stream.feed(window, &mut output).unwrap();
                while stream.busy() {
                    stream.drain(&mut output).unwrap();
                }
            }
            assert!(stream.done());
            assert!(output.is_empty());
            let mut metadata = Vec::new();
            stream.metadata(&mut metadata);
            let progress: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
            assert_eq!(progress["consumed"], cut);
        }
    }

    #[test]
    fn a_giant_record_emits_and_retires_in_bounded_pieces() {
        let mut stream = open(
            "select",
            br#"{"mode":"last","unit":"records","count":"1","terminator":10}"#,
        )
        .unwrap();
        let input = vec![b'x'; 1024 * 1024];
        let mut output = Vec::new();
        stream.feed(&input, &mut output).unwrap();
        while stream.busy() {
            stream.drain(&mut output).unwrap();
        }
        stream.finish(&mut output).unwrap();
        let mut size = 0;
        while stream.busy() {
            output.clear();
            stream.drain(&mut output).unwrap();
            assert!(output.len() <= super::WORK);
            size += output.len();
        }
        assert_eq!(size, input.len());
        assert!(stream.cancel());
        while stream.busy() {
            stream.drain(&mut output).unwrap();
        }
    }
}
