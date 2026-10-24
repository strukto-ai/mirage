use std::collections::VecDeque;

use serde::Deserialize;

use crate::records::{Records, Take};
use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    suppress: [bool; 3],
    check_order: Option<bool>,
    #[serde(deserialize_with = "crate::latin1")]
    delimiter: Vec<u8>,
    total: bool,
    zero_terminated: bool,
    /// Both files read the one standard input, a record each in turn.
    shared: bool,
    /// Both operands are `-`, which GNU closes twice.
    stdin_twice: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(Box::new(Comm {
        terminator: if config.zero_terminated { 0 } else { b'\n' },
        config,
        inputs: [Records::default(), Records::default()],
        lines: [None, None],
        pulls: VecDeque::from([0, 1]),
        warned: [false, false],
        counts: [0; 3],
        unpairable: false,
        stderr: Vec::new(),
        status: 0,
        done: false,
    }))
}

/// GNU comm's merge of two inputs, which `wants` names one at a time,
/// comparing records byte by byte. Each newly read record is checked
/// against its file's previous one: always under --check-order, where the
/// first disorder ends the run, never under --nocheck-order, and by
/// default only once a record unique to one file has printed, warning once
/// per file and closing with `input is not in sorted order`.
struct Comm {
    config: Config,
    terminator: u8,
    inputs: [Records; 2],
    lines: [Option<Vec<u8>>; 2],
    pulls: VecDeque<usize>,
    warned: [bool; 2],
    counts: [u64; 3],
    unpairable: bool,
    stderr: Vec<u8>,
    status: i32,
    done: bool,
}

impl Comm {
    fn source(&self, side: usize) -> usize {
        if self.config.shared { 0 } else { side }
    }

    /// Whether file `side`'s new record ends the run with its disorder.
    fn disordered(&mut self, side: usize, before: Option<Vec<u8>>) -> bool {
        let check = self.config.check_order;
        let (Some(line), Some(before)) = (&self.lines[side], before) else {
            return false;
        };
        if check == Some(false)
            || !(check == Some(true) || self.unpairable)
            || self.warned[side]
            || *line >= before
        {
            return false;
        }
        self.warned[side] = true;
        self.stderr.extend_from_slice(
            format!("comm: file {} is not in sorted order\n", side + 1).as_bytes(),
        );
        self.status = 1;
        check == Some(true)
    }

    fn close(&mut self, out: &mut Vec<u8>) {
        self.done = true;
        if self.config.stdin_twice {
            self.stderr
                .extend_from_slice(b"comm: -: Bad file descriptor\n");
            self.status = 1;
            return;
        }
        if self.config.total {
            for (count, hidden) in self.counts.iter().zip(self.config.suppress) {
                if !hidden {
                    out.extend_from_slice(count.to_string().as_bytes());
                    out.extend_from_slice(&self.config.delimiter);
                }
            }
            out.extend_from_slice(b"total");
            out.push(self.terminator);
        }
        if self.warned.contains(&true) {
            self.stderr
                .extend_from_slice(b"comm: input is not in sorted order\n");
        }
    }

    fn pump(&mut self, out: &mut Vec<u8>) {
        while !self.done {
            if let Some(&side) = self.pulls.front() {
                let source = self.source(side);
                let line = match self.inputs[source].next(self.terminator) {
                    Take::Wait => return,
                    Take::End => None,
                    Take::Record(line) => Some(line),
                };
                self.pulls.pop_front();
                let before = std::mem::replace(&mut self.lines[side], line);
                if self.disordered(side, before) {
                    self.done = true;
                }
                continue;
            }
            let column = match &self.lines {
                [None, None] => return self.close(out),
                [Some(left), Some(right)] if left == right => 3,
                [Some(left), Some(right)] if left < right => 1,
                [Some(_), None] => 1,
                _ => 2,
            };
            self.unpairable |= column != 3;
            self.counts[column - 1] += 1;
            if !self.config.suppress[column - 1] {
                let shown = self.config.suppress[..column - 1]
                    .iter()
                    .filter(|hidden| !**hidden);
                for _ in shown {
                    out.extend_from_slice(&self.config.delimiter);
                }
                out.extend_from_slice(
                    self.lines[usize::from(column == 2)]
                        .as_deref()
                        .unwrap_or_default(),
                );
                out.push(self.terminator);
            }
            if column != 2 {
                self.pulls.push_back(0);
            }
            if column != 1 {
                self.pulls.push_back(1);
            }
        }
    }
}

impl Stream for Comm {
    fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("comm reads two inputs"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out);
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        if self.done {
            None
        } else {
            self.pulls.front().copied()
        }
    }

    fn feed_input(
        &mut self,
        side: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let source = self.source(side.min(1));
        self.inputs[source].push(input);
        self.pump(out);
        Ok(())
    }

    fn end_input(&mut self, side: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let source = self.source(side.min(1));
        self.inputs[source].end();
        self.pump(out);
        Ok(())
    }

    fn status(&self) -> i32 {
        self.status
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;

    fn comm(options: &str, left: &[u8], right: &[u8]) -> (Vec<u8>, Vec<u8>, i32) {
        let config = config(
            r#"{"suppress":[false,false,false],"check_order":null,"delimiter":"\t","total":false,"zero_terminated":false,"shared":false,"stdin_twice":false}"#,
            options,
        );
        let mut stream = open(config.as_bytes()).unwrap();
        let inputs = [left, right];
        let mut at = [0, 0];
        let mut out = Vec::new();
        while let Some(side) = stream.wants() {
            if at[side] == inputs[side].len() {
                stream.end_input(side, &mut out).unwrap();
            } else {
                let byte = &inputs[side][at[side]..at[side] + 1];
                stream.feed_input(side, byte, &mut out).unwrap();
                at[side] += 1;
            }
        }
        stream.finish(&mut out).unwrap();
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        (out, err, stream.status())
    }

    #[test]
    fn records_merge_byte_by_byte_into_columns() {
        let bytes = comm("{}", b"a\n\xff\n", b"\xfe\n");
        assert_eq!(bytes, (b"a\n\t\xfe\n\xff\n".to_vec(), vec![], 0));
        let options = r#"{"suppress":[true,false,false],"total":true,"delimiter":"|"}"#;
        assert_eq!(comm(options, b"a\nb", b"b\nc").0, b"|b\nc\n1|1|total\n");
    }

    #[test]
    fn disorder_warns_once_unpaired_lines_have_printed() {
        let warned = comm("{}", b"b\na\n", b"c\n");
        let notice = b"comm: file 1 is not in sorted order\ncomm: input is not in sorted order\n";
        assert_eq!(warned, (b"b\na\n\tc\n".to_vec(), notice.to_vec(), 1));
        let failed = comm(r#"{"check_order":true}"#, b"a\nc\nb\n", b"a\n");
        let line = b"comm: file 1 is not in sorted order\n";
        assert_eq!(failed, (b"\t\ta\nc\n".to_vec(), line.to_vec(), 1));
        let quiet = comm(r#"{"check_order":false}"#, b"b\na\n", b"c\n");
        assert_eq!((quiet.1, quiet.2), (vec![], 0));
    }

    #[test]
    fn a_shared_stdin_alternates_records_and_closes_twice() {
        let both = r#"{"shared":true,"stdin_twice":true,"total":true}"#;
        let defaults = r#"{"suppress":[false,false,false],"check_order":null,"delimiter":"\t","total":false,"zero_terminated":false,"shared":false,"stdin_twice":false}"#;
        let mut stream = open(config(defaults, both).as_bytes()).unwrap();
        let mut out = Vec::new();
        let mut fed = false;
        while let Some(side) = stream.wants() {
            if fed {
                stream.end_input(side, &mut out).unwrap();
            } else {
                stream.feed_input(side, b"a\na\nb\n", &mut out).unwrap();
                fed = true;
            }
        }
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        assert_eq!(out, b"\t\ta\nb\n");
        assert_eq!(err, b"comm: -: Bad file descriptor\n");
    }
}
