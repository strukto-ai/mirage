use std::cmp::Ordering;
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
        phase: Phase::Pull,
        output: VecDeque::new(),
        busy: false,
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
    phase: Phase,
    output: VecDeque<Emit>,
    busy: bool,
}

const WORK: usize = 16384;

#[derive(Clone, Copy)]
enum Phase {
    Pull,
    Order(usize, usize),
    Prepare(usize),
    Copy(usize, usize),
    Compare(usize),
    Advance(usize),
    Done,
}

enum Part {
    Bytes(Vec<u8>),
    Line(usize),
    Delimiter,
    Terminator,
}
struct Emit {
    part: Part,
    at: usize,
}

enum Comparison {
    Done(Ordering),
    More(usize),
}

fn compare(left: &[u8], right: &[u8], at: usize, work: &mut usize) -> Comparison {
    let end = left.len().min(right.len()).min(at.saturating_add(*work));
    let order = left[at..end].cmp(&right[at..end]);
    *work -= end - at;
    if order != Ordering::Equal {
        Comparison::Done(order)
    } else if end == left.len().min(right.len()) {
        Comparison::Done(left.len().cmp(&right.len()))
    } else {
        Comparison::More(end)
    }
}

impl Comm {
    fn source(&self, side: usize) -> usize {
        if self.config.shared { 0 } else { side }
    }
    fn queue(&mut self, part: Part) {
        self.output.push_back(Emit { part, at: 0 });
    }

    fn close(&mut self) {
        self.done = true;
        self.phase = Phase::Done;
        if self.config.stdin_twice {
            self.stderr
                .extend_from_slice(b"comm: -: Bad file descriptor\n");
            self.status = 1;
            return;
        }
        if self.config.total {
            for column in 0..3 {
                if !self.config.suppress[column] {
                    self.queue(Part::Bytes(self.counts[column].to_string().into_bytes()));
                    self.queue(Part::Delimiter);
                }
            }
            self.queue(Part::Bytes(b"total".to_vec()));
            self.queue(Part::Terminator);
        }
        if self.warned.contains(&true) {
            self.stderr
                .extend_from_slice(b"comm: input is not in sorted order\n");
        }
    }

    fn emit(&mut self, out: &mut Vec<u8>, available: usize) {
        let mut item = self.output.pop_front().unwrap();
        let bytes = match &item.part {
            Part::Bytes(bytes) => bytes.as_slice(),
            Part::Line(side) => self.lines[*side].as_deref().unwrap(),
            Part::Delimiter => &self.config.delimiter,
            Part::Terminator => std::slice::from_ref(&self.terminator),
        };
        let end = bytes.len().min(item.at.saturating_add(available));
        out.extend_from_slice(&bytes[item.at..end]);
        if end < bytes.len() {
            item.at = end;
            self.output.push_front(item);
        }
    }

    fn pump(&mut self, out: &mut Vec<u8>) {
        let limit = out.len().saturating_add(WORK);
        let mut work = WORK;
        while work > 0 && out.len() < limit {
            work -= 1;
            if !self.output.is_empty() {
                self.emit(out, limit - out.len());
                continue;
            }
            match self.phase {
                Phase::Pull => {
                    if let Some(&side) = self.pulls.front() {
                        let source = self.source(side);
                        match self.inputs[source].peek_span(self.terminator) {
                            Take::Wait => {
                                self.busy = false;
                                return;
                            }
                            Take::End => {
                                self.pulls.pop_front();
                                self.lines[side] = None;
                            }
                            Take::Record(_) => {
                                let check = self.config.check_order;
                                self.phase = if check != Some(false)
                                    && (check == Some(true) || self.unpairable)
                                    && !self.warned[side]
                                    && self.lines[side].is_some()
                                {
                                    Phase::Order(side, 0)
                                } else {
                                    Phase::Prepare(side)
                                };
                            }
                        }
                    } else {
                        self.phase = Phase::Compare(0);
                    }
                }
                Phase::Order(side, at) => {
                    let source = self.source(side);
                    let Take::Record((line, _)) = self.inputs[source].peek_span(self.terminator)
                    else {
                        unreachable!()
                    };
                    match compare(line, self.lines[side].as_deref().unwrap(), at, &mut work) {
                        Comparison::More(at) => self.phase = Phase::Order(side, at),
                        Comparison::Done(order) => {
                            if order == Ordering::Less {
                                self.warned[side] = true;
                                self.stderr.extend_from_slice(
                                    format!("comm: file {} is not in sorted order\n", side + 1)
                                        .as_bytes(),
                                );
                                self.status = 1;
                                self.done = self.config.check_order == Some(true);
                            }
                            self.phase = if self.done {
                                Phase::Done
                            } else {
                                Phase::Prepare(side)
                            };
                        }
                    }
                }
                Phase::Prepare(side) => {
                    let source = self.source(side);
                    let Take::Record((line, _)) = self.inputs[source].peek_span(self.terminator)
                    else {
                        unreachable!()
                    };
                    let held = self.lines[side].get_or_insert_with(Vec::new);
                    if held.capacity() < line.len()
                        || held.capacity() > line.len().max(WORK).saturating_mul(2)
                    {
                        *held = Vec::with_capacity(line.len());
                    } else {
                        held.clear();
                    }
                    self.phase = Phase::Copy(side, 0);
                }
                Phase::Copy(side, at) => {
                    let source = self.source(side);
                    let Take::Record((line, _)) = self.inputs[source].peek_span(self.terminator)
                    else {
                        unreachable!()
                    };
                    let end = line.len().min(at.saturating_add(work));
                    self.lines[side]
                        .as_mut()
                        .unwrap()
                        .extend_from_slice(&line[at..end]);
                    work -= end - at;
                    if end == line.len() {
                        self.inputs[source].advance();
                        self.pulls.pop_front();
                        self.phase = Phase::Pull;
                    } else {
                        self.phase = Phase::Copy(side, end);
                    }
                }
                Phase::Compare(at) => {
                    let column = match &self.lines {
                        [None, None] => {
                            self.close();
                            continue;
                        }
                        [Some(left), Some(right)] => match compare(left, right, at, &mut work) {
                            Comparison::More(at) => {
                                self.phase = Phase::Compare(at);
                                continue;
                            }
                            Comparison::Done(Ordering::Less) => 1,
                            Comparison::Done(Ordering::Equal) => 3,
                            Comparison::Done(Ordering::Greater) => 2,
                        },
                        [Some(_), None] => 1,
                        _ => 2,
                    };
                    self.unpairable |= column != 3;
                    self.counts[column - 1] += 1;
                    if !self.config.suppress[column - 1] {
                        for before in 0..column - 1 {
                            if !self.config.suppress[before] {
                                self.queue(Part::Delimiter);
                            }
                        }
                        self.queue(Part::Line(usize::from(column == 2)));
                        self.queue(Part::Terminator);
                    }
                    self.phase = Phase::Advance(column);
                }
                Phase::Advance(column) => {
                    if column != 2 {
                        self.pulls.push_back(0);
                    }
                    if column != 1 {
                        self.pulls.push_back(1);
                    }
                    self.phase = Phase::Pull;
                }
                Phase::Done => {
                    self.busy = false;
                    return;
                }
            }
        }
        self.busy = true;
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
    fn busy(&self) -> bool {
        self.busy
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;

    fn bounded(options: &str, left: &[u8], right: &[u8]) -> (Vec<u8>, Vec<u8>, i32, usize) {
        let defaults = r#"{"suppress":[false,false,false],"check_order":null,"delimiter":"\t","total":false,"zero_terminated":false,"shared":false,"stdin_twice":false}"#;
        let mut stream = open(config(defaults, options).as_bytes()).unwrap();
        let inputs = [left, right];
        let mut fed = [false, false];
        let (mut out, mut turns) = (Vec::new(), 0);
        loop {
            let mut piece = Vec::new();
            if stream.busy() {
                stream.drain(&mut piece).unwrap();
            } else if let Some(side) = stream.wants() {
                if fed[side] {
                    stream.end_input(side, &mut piece).unwrap();
                } else {
                    stream.feed_input(side, inputs[side], &mut piece).unwrap();
                    fed[side] = true;
                }
            } else {
                break;
            }
            assert!(piece.len() <= WORK);
            out.extend_from_slice(&piece);
            turns += 1;
            assert!(turns < 10000);
        }
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        (out, err, stream.status(), turns)
    }

    #[test]
    fn giant_equal_prefixes_and_delimiters_resume_without_losing_columns() {
        let mut left = vec![b'x'; WORK * 8];
        left.extend_from_slice(b"a\n");
        let mut right = vec![b'x'; WORK * 8];
        right.extend_from_slice(b"b\n");
        let result = bounded("{}", &left, &right);
        assert_eq!(result.0, [left.clone(), b"\t".to_vec(), right].concat());
        assert_eq!((result.1, result.2), (Vec::new(), 0));
        assert!(result.3 > 20);
        let delimiter = "|".repeat(WORK * 3);
        let options = serde_json::json!({"delimiter":delimiter}).to_string();
        let result = bounded(&options, &left, &left);
        assert_eq!(result.0, [delimiter.repeat(2).into_bytes(), left].concat());
        assert!(result.3 > 20);
    }

    #[test]
    fn order_checks_and_suppressed_rows_still_spend_work() {
        let mut first = vec![b'x'; WORK * 8];
        first.extend_from_slice(b"b\n");
        let mut input = first.clone();
        input.extend(vec![b'x'; WORK * 8]);
        input.extend_from_slice(b"a\n");
        let result = bounded(r#"{"check_order":true}"#, &input, b"");
        assert_eq!(result.0, first);
        assert_eq!(result.1, b"comm: file 1 is not in sorted order\n");
        assert_eq!(result.2, 1);
        assert!(result.3 > 20);
        let input = b"a\n".repeat(WORK * 4);
        let result = bounded(
            r#"{"suppress":[true,true,true],"total":true}"#,
            &input,
            &input,
        );
        assert_eq!(result.0, b"total\n");
        assert_eq!(result.2, 0);
        assert!(result.3 > 20);
    }

    fn comm(options: &str, left: &[u8], right: &[u8]) -> (Vec<u8>, Vec<u8>, i32) {
        let config = config(
            r#"{"suppress":[false,false,false],"check_order":null,"delimiter":"\t","total":false,"zero_terminated":false,"shared":false,"stdin_twice":false}"#,
            options,
        );
        let mut stream = open(config.as_bytes()).unwrap();
        let inputs = [left, right];
        let mut at = [0, 0];
        let mut out = Vec::new();
        loop {
            while stream.busy() {
                stream.drain(&mut out).unwrap();
            }
            let Some(side) = stream.wants() else {
                break;
            };
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
