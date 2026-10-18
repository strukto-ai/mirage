use std::cmp::Ordering;
use std::collections::VecDeque;
use std::sync::Arc;

use serde::Deserialize;

use crate::records::{Bytes, Input, Output, Piece, Read, STEP, scalar};
use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    suppressed: [bool; 3],
    check_order: Option<bool>,
    delimiter: String,
    total: bool,
    terminator: u8,
}

#[derive(Clone, Copy)]
enum After {
    First,
    Next,
    Compare,
}

enum Load {
    Read,
    Decode {
        raw: Bytes,
        offset: usize,
        decoded: Bytes,
    },
    Check {
        line: Arc<Bytes>,
        offset: usize,
    },
}

enum Phase {
    Load {
        side: usize,
        after: After,
        work: Load,
    },
    Compare(usize),
    AwaitFinish,
    Summary,
    Complete,
}

struct Comm {
    config: Config,
    inputs: [Input; 2],
    lines: [Option<Arc<Bytes>>; 2],
    previous: [Option<Arc<Bytes>>; 2],
    warned: [bool; 2],
    counts: [u64; 3],
    unpairable: bool,
    phase: Phase,
    wanted: Option<usize>,
    output: Output,
    retired: VecDeque<Arc<Bytes>>,
    retirement: Option<Bytes>,
    delimiter: Arc<Bytes>,
    terminator: Arc<Bytes>,
    stderr: Vec<u8>,
    status: i32,
}

fn compare(
    left: &Bytes,
    right: &Bytes,
    offset: &mut usize,
    budget: &mut usize,
) -> Option<Ordering> {
    let length = left.len().min(right.len());
    while *offset < length && *budget > 0 {
        let order = left.at(*offset).cmp(&right.at(*offset));
        *offset += 1;
        *budget -= 1;
        if order != Ordering::Equal {
            return Some(order);
        }
    }
    (*offset == length).then(|| left.len().cmp(&right.len()))
}

pub(crate) fn open(bytes: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(bytes)?;
    let delimiter = Arc::new(Bytes::new(config.delimiter.as_bytes()));
    let terminator = Arc::new(Bytes::new(&[config.terminator]));
    Ok(Box::new(Comm {
        config,
        inputs: std::array::from_fn(|_| Input::default()),
        lines: [None, None],
        previous: [None, None],
        warned: [false; 2],
        counts: [0; 3],
        unpairable: false,
        phase: Phase::Load {
            side: 0,
            after: After::First,
            work: Load::Read,
        },
        wanted: Some(0),
        output: Output::default(),
        retired: VecDeque::new(),
        retirement: None,
        delimiter,
        terminator,
        stderr: Vec::new(),
        status: 0,
    }))
}

impl Comm {
    fn retire(&mut self, budget: &mut usize) -> bool {
        while *budget > 0 {
            if let Some(mut bytes) = self.retirement.take() {
                if !bytes.retire(budget) {
                    self.retirement = Some(bytes);
                    return false;
                }
            } else if let Some(bytes) = self.retired.pop_front() {
                *budget -= 1;
                if let Ok(bytes) = Arc::try_unwrap(bytes) {
                    self.retirement = Some(bytes);
                }
            } else {
                return true;
            }
        }
        false
    }

    fn load(&mut self, side: usize, after: After) {
        self.phase = Phase::Load {
            side,
            after,
            work: Load::Read,
        };
    }

    fn loaded(&mut self, side: usize, line: Option<Arc<Bytes>>, after: After) {
        if let Some(previous) = self.previous[side].take() {
            self.retired.push_back(previous);
        }
        self.previous[side] = line.clone();
        if let Some(previous) = self.lines[side].take() {
            self.retired.push_back(previous);
        }
        self.lines[side] = line;
        match after {
            After::First => self.load(1, After::Compare),
            After::Next => self.load(1, After::Compare),
            After::Compare => self.phase = Phase::Compare(0),
        }
    }

    fn step(&mut self, out: &mut Vec<u8>) {
        let mut budget = STEP;
        self.wanted = None;
        while budget > 0 {
            if !self.retire(&mut budget) {
                return;
            }
            self.output.write(out, &mut budget);
            if !self.output.empty() {
                return;
            }
            if matches!(self.phase, Phase::Summary) && !out.is_empty() {
                return;
            }
            budget = budget.saturating_sub(1);
            let phase = std::mem::replace(&mut self.phase, Phase::Complete);
            match phase {
                Phase::Load { side, after, work } => match work {
                    Load::Read => match self.inputs[side].read(self.config.terminator, &mut budget)
                    {
                        Read::Working => self.load(side, after),
                        Read::Waiting => {
                            self.load(side, after);
                            self.wanted = Some(side);
                            return;
                        }
                        Read::End => self.loaded(side, None, after),
                        Read::Record(raw) => {
                            self.phase = Phase::Load {
                                side,
                                after,
                                work: Load::Decode {
                                    raw,
                                    offset: 0,
                                    decoded: Bytes::default(),
                                },
                            }
                        }
                    },
                    Load::Decode {
                        raw,
                        mut offset,
                        mut decoded,
                    } => {
                        while offset < raw.len() && budget >= 4 {
                            let (value, size) = scalar(&raw, offset);
                            let mut encoded = [0; 4];
                            let value = value.encode_utf8(&mut encoded);
                            decoded.extend(value.as_bytes());
                            offset += size;
                            budget -= size.max(value.len());
                        }
                        let work = if offset == raw.len() {
                            self.retirement = Some(raw);
                            Load::Check {
                                line: Arc::new(decoded),
                                offset: 0,
                            }
                        } else {
                            budget = 0;
                            Load::Decode {
                                raw,
                                offset,
                                decoded,
                            }
                        };
                        self.phase = Phase::Load { side, after, work };
                    }
                    Load::Check { line, mut offset } => {
                        let check = self.config.check_order != Some(false)
                            && !self.warned[side]
                            && (self.config.check_order == Some(true) || self.unpairable);
                        let order = if check {
                            self.previous[side]
                                .as_ref()
                                .map_or(Some(Ordering::Equal), |previous| {
                                    compare(previous, &line, &mut offset, &mut budget)
                                })
                        } else {
                            Some(Ordering::Equal)
                        };
                        match order {
                            None => {
                                self.phase = Phase::Load {
                                    side,
                                    after,
                                    work: Load::Check { line, offset },
                                }
                            }
                            Some(Ordering::Greater) => {
                                self.warned[side] = true;
                                self.status = 1;
                                self.stderr.extend_from_slice(
                                    format!("comm: file {} is not in sorted order\n", side + 1)
                                        .as_bytes(),
                                );
                                if self.config.check_order == Some(true) {
                                    self.retired.push_back(line);
                                    self.phase = Phase::Complete;
                                } else {
                                    self.loaded(side, Some(line), after);
                                }
                            }
                            Some(_) => self.loaded(side, Some(line), after),
                        }
                    }
                },
                Phase::Compare(mut offset) => {
                    let order = match (&self.lines[0], &self.lines[1]) {
                        (None, None) => {
                            for line in self.previous.iter_mut().filter_map(Option::take) {
                                self.retired.push_back(line);
                            }
                            self.phase = Phase::AwaitFinish;
                            return;
                        }
                        (Some(_), None) => Some(Ordering::Less),
                        (None, Some(_)) => Some(Ordering::Greater),
                        (Some(left), Some(right)) => compare(left, right, &mut offset, &mut budget),
                    };
                    let Some(order) = order else {
                        self.phase = Phase::Compare(offset);
                        continue;
                    };
                    let column = match order {
                        Ordering::Less => 0,
                        Ordering::Greater => 1,
                        Ordering::Equal => 2,
                    };
                    self.unpairable |= column != 2;
                    self.counts[column] = self.counts[column].saturating_add(1);
                    if !self.config.suppressed[column] {
                        for earlier in 0..column {
                            if !self.config.suppressed[earlier] {
                                self.output.push(Piece::whole(self.delimiter.clone()));
                            }
                        }
                        let side = usize::from(column == 1);
                        self.output.push(Piece::whole(
                            self.lines[side]
                                .as_ref()
                                .expect("selected comm line")
                                .clone(),
                        ));
                        self.output.push(Piece::whole(self.terminator.clone()));
                    }
                    match column {
                        0 => self.load(0, After::Compare),
                        1 => self.load(1, After::Compare),
                        _ => self.load(0, After::Next),
                    }
                }
                Phase::AwaitFinish => {
                    self.phase = Phase::AwaitFinish;
                    return;
                }
                Phase::Summary => {
                    if self.warned.iter().any(|value| *value) {
                        self.stderr
                            .extend_from_slice(b"comm: input is not in sorted order\n");
                    }
                    self.phase = Phase::Complete;
                }
                Phase::Complete => {
                    for side in 0..2 {
                        if let Some(line) = self.lines[side].take() {
                            self.retired.push_back(line);
                        }
                        if let Some(line) = self.previous[side].take() {
                            self.retired.push_back(line);
                        }
                    }
                    if self.retired.is_empty() {
                        return;
                    }
                }
            }
        }
    }
}

impl Stream for Comm {
    fn cancel(&mut self) -> bool {
        for input in &mut self.inputs {
            self.retired.push_back(Arc::new(input.cancel()));
        }
        if let Phase::Load { work, .. } = std::mem::replace(&mut self.phase, Phase::Complete) {
            match work {
                Load::Decode { raw, decoded, .. } => {
                    self.retired.push_back(Arc::new(raw));
                    self.retired.push_back(Arc::new(decoded));
                }
                Load::Check { line, .. } => self.retired.push_back(line),
                Load::Read => {}
            }
        }
        self.output = Output::default();
        self.wanted = None;
        true
    }

    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(0, input, out)
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if matches!(self.phase, Phase::AwaitFinish) {
            if self.config.total {
                let mut first = true;
                for column in 0..3 {
                    if self.config.suppressed[column] {
                        continue;
                    }
                    if !first {
                        self.output.push(Piece::whole(self.delimiter.clone()));
                    }
                    first = false;
                    self.output.push(Piece::whole(Arc::new(Bytes::new(
                        self.counts[column].to_string().as_bytes(),
                    ))));
                }
                if !first {
                    self.output.push(Piece::whole(self.delimiter.clone()));
                }
                self.output
                    .push(Piece::whole(Arc::new(Bytes::new(b"total"))));
                self.output.push(Piece::whole(self.terminator.clone()));
            }
            self.phase = Phase::Summary;
            self.step(out);
        }
        Ok(())
    }
    fn wants(&self) -> Option<usize> {
        self.wanted
    }
    fn busy(&self) -> bool {
        self.wanted.is_none()
            && (!self.output.empty()
                || !self.retired.is_empty()
                || self.retirement.is_some()
                || matches!(self.phase, Phase::Complete)
                    && (self.lines.iter().any(Option::is_some)
                        || self.previous.iter().any(Option::is_some))
                || !matches!(self.phase, Phase::Complete | Phase::AwaitFinish))
    }
    fn done(&self) -> bool {
        matches!(self.phase, Phase::Complete)
            && self.output.empty()
            && self.retired.is_empty()
            && self.retirement.is_none()
            && self.lines.iter().all(Option::is_none)
            && self.previous.iter().all(Option::is_none)
    }
    fn feed_input(
        &mut self,
        side: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let Some(source) = self.inputs.get_mut(side) else {
            return Err(StreamError::new("invalid comm input"));
        };
        source.feed(input);
        self.step(out);
        Ok(())
    }
    fn end_input(&mut self, side: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let Some(source) = self.inputs.get_mut(side) else {
            return Err(StreamError::new("invalid comm input"));
        };
        source.end();
        self.step(out);
        Ok(())
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }
    fn status(&self) -> i32 {
        self.status
    }
    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}
