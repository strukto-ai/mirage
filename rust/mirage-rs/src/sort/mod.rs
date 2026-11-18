mod cost;
mod key;
mod modifiers;
pub(crate) mod number;
pub(crate) mod options;
mod random;
mod version;

use std::cmp::Ordering;

use serde::Deserialize;

use crate::{
    Stream, StreamError,
    constants::{MAX_HELD, OUTPUT},
    parse_config,
};
use cost::{COST_BYTES, weight};
use key::{Compare, Comparison};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "mode")]
enum Config {
    /// Sort records into runs: once the buffered records reach `run_bytes`
    /// (including the open record and `RECORD_OVERHEAD` per completed
    /// record) the stream is busy
    /// with that run, and every piece `drain` writes while it stays busy is
    /// one sorted run.
    Sort {
        compare: Compare,
        zero_terminated: bool,
        #[serde(deserialize_with = "crate::saturating_usize")]
        run_bytes: usize,
    },
    /// Merge `inputs` sorted runs, fed through `feed_input` as `wants`
    /// names them.
    Merge {
        compare: Compare,
        zero_terminated: bool,
        inputs: usize,
    },
    /// The first disorder refuses with its 1-based record number as the
    /// message, and the record as output unless checking quietly.
    Check {
        compare: Compare,
        zero_terminated: bool,
        #[serde(default)]
        quiet: bool,
    },
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(match parse_config::<Config>(config)? {
        Config::Sort {
            compare,
            zero_terminated,
            run_bytes,
        } => Box::new(Sorter {
            compare,
            separator: separator(zero_terminated),
            run_bytes,
            data: Vec::new(),
            spans: Vec::new(),
            scratch: Vec::new(),
            bounds: Vec::new(),
            scanned: 0,
            start: 0,
            size: 0,
            phase: Phase::Idle,
            ended: false,
            comparison: Comparison::default(),
        }),
        Config::Merge {
            compare,
            zero_terminated,
            inputs,
        } => Box::new(Merger {
            compare,
            separator: separator(zero_terminated),
            inputs: (0..inputs).map(|_| Input::default()).collect(),
            previous: None,
            paused: false,
            selection: Selection::default(),
            writing: None,
            comparison: Comparison::default(),
        }),
        Config::Check {
            compare,
            zero_terminated,
            quiet,
        } => Box::new(Checker {
            compare,
            quiet,
            separator: separator(zero_terminated),
            records: crate::records::Records::default(),
            previous: Vec::new(),
            index: 0,
            comparison: Comparison::default(),
            paused: false,
            copying: false,
        }),
    })
}

fn separator(zero_terminated: bool) -> u8 {
    if zero_terminated { 0 } else { b'\n' }
}

const RECORD_OVERHEAD: usize = 64;

fn append(buffer: &mut Vec<u8>, input: &[u8]) -> Result<(), StreamError> {
    let needed = buffer.len().saturating_add(input.len());
    if needed > buffer.capacity() {
        let grown = buffer
            .capacity()
            .saturating_mul(2)
            .min(MAX_HELD + MAX_HELD / 2);
        buffer
            .try_reserve_exact(needed.max(grown) - buffer.len())
            .map_err(|_| StreamError::refusal(b"sort: memory exhausted", 2))?;
    }
    buffer.extend_from_slice(input);
    Ok(())
}

fn write_record(
    data: &[u8],
    pos: &mut usize,
    end: usize,
    separator: u8,
    out: &mut Vec<u8>,
) -> bool {
    let full = out.len() + OUTPUT - out.len() % OUTPUT;
    let stop = end.min(*pos + full - out.len());
    out.extend_from_slice(&data[*pos..stop]);
    *pos = stop;
    if stop == end && out.len() < full {
        out.push(separator);
        true
    } else {
        false
    }
}

/// Work charged per call. Exact numeric and whole-record lexical
/// comparisons resume after this byte allowance.
const STEP: usize = 4 * 1024;

/// The most records one block sort orders, and the most weight: a block
/// of long records ends sooner.
const BLOCK: usize = 512;

/// Where a run is: its records are sorted a block at a time, the blocks
/// merged a step at a time, and the run then written a piece at a time.
enum Phase {
    Idle,
    Blocks {
        next: usize,
    },
    /// Merging the sorted runs `bounds` marks, in pairs, from `spans` into
    /// `scratch`: the pair whose left run is run `pair`, at `left`, `right`
    /// and `out`.
    Merge {
        pair: usize,
        left: usize,
        right: usize,
        out: usize,
    },
    /// Writing the sorted run: the next record and, for `-u`, the last one
    /// kept.
    Write {
        next: usize,
        kept: Option<(usize, usize)>,
        offset: Option<usize>,
    },
}

/// Records buffer until they fill a run; the stream is then busy and every
/// `drain` does a bounded step of sorting or writes a piece, until the run
/// is out. `feed` with no bytes starts the next run from what is already
/// buffered, and after `finish` from whatever is left.
struct Sorter {
    compare: Compare,
    separator: u8,
    run_bytes: usize,
    data: Vec<u8>,
    spans: Vec<(usize, usize)>,
    scratch: Vec<(usize, usize)>,
    /// Where each sorted run of `spans` starts, then where the last ends.
    bounds: Vec<usize>,
    /// `data[..scanned]` is split into records; the next starts at `start`.
    scanned: usize,
    start: usize,
    size: usize,
    phase: Phase,
    ended: bool,
    comparison: Comparison,
}

impl Sorter {
    /// Split buffered bytes into records, stopping once they fill a run;
    /// true when they did.
    fn scan(&mut self) -> bool {
        while let Some(at) = memchr::memchr(self.separator, &self.data[self.scanned..]) {
            let end = self.scanned + at;
            self.spans.push((self.start, end));
            self.size += end - self.start + RECORD_OVERHEAD;
            self.start = end + 1;
            self.scanned = self.start;
            if self.size >= self.run_bytes {
                return true;
            }
        }
        self.scanned = self.data.len();
        !self.spans.is_empty()
            && self.size.saturating_add(self.data.len() - self.start) >= self.run_bytes
    }

    /// Start a run from the buffered records: a full one, or once input
    /// has ended whatever is left.
    fn advance(&mut self) {
        if self.scan() {
            self.start_run();
            return;
        }
        if !self.ended {
            return;
        }
        if self.start < self.data.len() {
            self.spans.push((self.start, self.data.len()));
            self.start = self.data.len();
            self.scanned = self.start;
        }
        if self.spans.is_empty() {
            self.release();
        } else {
            self.start_run();
        }
    }

    fn start_run(&mut self) {
        self.bounds.clear();
        self.bounds.push(0);
        self.phase = Phase::Blocks { next: 0 };
    }

    fn release(&mut self) {
        self.data = Vec::new();
        self.spans = Vec::new();
        self.scratch = Vec::new();
        self.bounds = Vec::new();
        self.scanned = 0;
        self.start = 0;
    }

    fn record(&self, span: (usize, usize)) -> &[u8] {
        &self.data[span.0..span.1]
    }

    /// One bounded step of sorting, or one piece of output.
    fn step(&mut self, out: &mut Vec<u8>) {
        let mut work = 0;
        while work < STEP {
            match self.phase {
                Phase::Idle => return,
                Phase::Blocks { next } => work += self.sort_block(next),
                Phase::Merge { .. } => work += self.merge_step(STEP - work),
                Phase::Write { .. } => {
                    self.write(out);
                    return;
                }
            }
        }
    }

    /// Sort the block of spans from `next`, as many as BLOCK allows, or
    /// once every block is sorted start merging them; returns the work.
    fn sort_block(&mut self, next: usize) -> usize {
        let count = self.spans.len();
        if next >= count {
            self.phase = if self.bounds.len() > 2 {
                self.scratch.clear();
                self.scratch.resize(count, (0, 0));
                self.first_pair()
            } else {
                Phase::Write {
                    next: 0,
                    kept: None,
                    offset: None,
                }
            };
            return 0;
        }
        let mut end = next;
        let mut load = 0;
        while end < count && end - next < BLOCK && load < BLOCK {
            let weight = weight(self.record(self.spans[end]));
            if end > next && load + weight > BLOCK {
                break;
            }
            load += weight;
            end += 1;
        }
        let data = &self.data;
        let compare = &self.compare;
        self.spans[next..end]
            .sort_by(|&(a0, a1), &(b0, b1)| compare.records(&data[a0..a1], &data[b0..b1]));
        self.bounds.push(end);
        self.phase = Phase::Blocks { next: end };
        // A record meets about log2(BLOCK) others.
        load * 9
    }

    fn first_pair(&self) -> Phase {
        Phase::Merge {
            pair: 0,
            left: 0,
            right: self.bounds[1],
            out: 0,
        }
    }

    /// Merge the current pass for up to `budget` work, a tie taking the
    /// left run so the sort stays stable; returns the work done.
    fn merge_step(&mut self, budget: usize) -> usize {
        let Phase::Merge {
            mut pair,
            mut left,
            mut right,
            mut out,
        } = self.phase
        else {
            return budget;
        };
        let runs = self.bounds.len() - 1;
        let mut work = 0;
        while work < budget {
            if pair >= runs {
                std::mem::swap(&mut self.spans, &mut self.scratch);
                let count = self.spans.len();
                let mut bounds: Vec<usize> = self.bounds.iter().copied().step_by(2).collect();
                if bounds.last() != Some(&count) {
                    bounds.push(count);
                }
                self.bounds = bounds;
                self.phase = if self.bounds.len() > 2 {
                    self.first_pair()
                } else {
                    self.scratch = Vec::new();
                    Phase::Write {
                        next: 0,
                        kept: None,
                        offset: None,
                    }
                };
                return work;
            }
            let mid = self.bounds[pair + 1];
            let hi = self.bounds[(pair + 2).min(runs)];
            if out == hi {
                pair += 2;
                left = hi;
                right = self.bounds[(pair + 1).min(runs)];
                continue;
            }
            let take_left = if left >= mid {
                false
            } else if right >= hi {
                true
            } else {
                let (a0, a1) = self.spans[right];
                let (b0, b1) = self.spans[left];
                let Some(order) = self.comparison.step(
                    &self.compare,
                    &self.data[a0..a1],
                    &self.data[b0..b1],
                    &mut work,
                    budget,
                ) else {
                    break;
                };
                order != Ordering::Less
            };
            self.scratch[out] = if take_left {
                left += 1;
                self.spans[left - 1]
            } else {
                right += 1;
                self.spans[right - 1]
            };
            out += 1;
            work += 1;
        }
        self.phase = Phase::Merge {
            pair,
            left,
            right,
            out,
        };
        work
    }

    fn write(&mut self, out: &mut Vec<u8>) {
        let Phase::Write {
            mut next,
            mut kept,
            mut offset,
        } = self.phase
        else {
            return;
        };
        let mut work = 0;
        let full = out.len() + OUTPUT - out.len() % OUTPUT;
        while next < self.spans.len() && out.len() < full && work < STEP {
            let (lo, hi) = self.spans[next];
            if offset.is_none() && self.compare.unique {
                if let Some((k0, k1)) = kept {
                    let Some(order) = self.comparison.step(
                        &self.compare,
                        &self.data[k0..k1],
                        &self.data[lo..hi],
                        &mut work,
                        STEP,
                    ) else {
                        break;
                    };
                    if order == Ordering::Equal {
                        next += 1;
                        continue;
                    }
                }
            }
            if write_record(
                &self.data,
                offset.get_or_insert(lo),
                hi,
                self.separator,
                out,
            ) {
                kept = Some((lo, hi));
                offset = None;
                next += 1;
            }
        }
        if next < self.spans.len() {
            self.phase = Phase::Write { next, kept, offset };
            return;
        }
        self.phase = Phase::Idle;
        self.spans.clear();
        self.size = 0;
        if self.ended {
            // Once input has ended no feed comes to start the next run, so
            // start it here; `advance` releases when nothing is left.
            self.advance();
            return;
        }
        self.data.drain(..self.start);
        crate::release_capacity(&mut self.data);
        self.scanned -= self.start;
        self.start = 0;
    }

    fn idle(&self) -> Result<(), StreamError> {
        match self.phase {
            Phase::Idle => Ok(()),
            _ => Err(StreamError::new("sort: a run is still being sorted")),
        }
    }
}

impl Stream for Sorter {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.idle()?;
        append(&mut self.data, input)?;
        self.advance();
        Ok(())
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.idle()?;
        self.ended = true;
        self.advance();
        Ok(())
    }

    fn busy(&self) -> bool {
        !matches!(self.phase, Phase::Idle)
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }
}

/// One merge input: its bytes, where its next record starts and, once
/// found, where it ends, so a long record is searched once.
#[derive(Default)]
struct Input {
    buf: Vec<u8>,
    pos: usize,
    ended: bool,
    end: Option<usize>,
    searched: usize,
}

impl Input {
    fn locate(&mut self, separator: u8) {
        if self.end.is_some() {
            return;
        }
        let from = self.searched.max(self.pos);
        match memchr::memchr(separator, &self.buf[from..]) {
            Some(at) => self.end = Some(from + at),
            None => self.searched = self.buf.len(),
        }
    }

    fn head(&self) -> Option<(usize, usize)> {
        match self.end {
            Some(end) => Some((self.pos, end)),
            None if self.ended && self.pos < self.buf.len() => Some((self.pos, self.buf.len())),
            None => None,
        }
    }

    fn consume(&mut self, hi: usize, separator: u8) {
        self.pos = (hi + 1).min(self.buf.len());
        self.end = None;
        self.searched = self.pos;
        if self.pos * 2 > self.buf.len() {
            self.buf.drain(..self.pos);
            crate::release_capacity(&mut self.buf);
            self.searched -= self.pos;
            self.pos = 0;
        }
        self.locate(separator);
    }
}

/// `sort -m`: the next record is always the smallest head, a tie going to
/// the earlier input; `-u` drops a record equal to the last one written.
/// A call merges up to STEP work, then the stream is busy until `drain`s
/// finish what the inputs hold.
struct Merger {
    compare: Compare,
    separator: u8,
    inputs: Vec<Input>,
    previous: Option<Vec<u8>>,
    paused: bool,
    selection: Selection,
    writing: Option<(usize, usize, usize)>,
    comparison: Comparison,
}

#[derive(Default)]
struct Selection {
    next: usize,
    chosen: Option<(usize, usize, usize)>,
}

impl Merger {
    fn pump(&mut self, out: &mut Vec<u8>) {
        self.paused = false;
        let mut work = 0;
        let full = out.len() + OUTPUT - out.len() % OUTPUT;
        loop {
            if let Some((index, mut pos, hi)) = self.writing {
                let start = pos;
                let done = write_record(&self.inputs[index].buf, &mut pos, hi, self.separator, out);
                if self.compare.unique {
                    self.previous
                        .get_or_insert_with(Vec::new)
                        .extend_from_slice(&self.inputs[index].buf[start..pos]);
                }
                self.writing = Some((index, pos, hi));
                if done {
                    if let Some(previous) = &mut self.previous {
                        crate::release_capacity(previous);
                    }
                    self.inputs[index].consume(hi, self.separator);
                    self.writing = None;
                    work += 1;
                }
            }
            if out.len() == full || work >= STEP {
                self.paused = true;
                return;
            }
            if self.writing.is_some() {
                continue;
            }
            if self.wanted().is_some() {
                return;
            }
            while self.selection.next < self.inputs.len() {
                let index = self.selection.next;
                let Some((lo, hi)) = self.inputs[index].head() else {
                    self.selection.next += 1;
                    continue;
                };
                let better = match self.selection.chosen {
                    None => true,
                    Some((best, b0, b1)) => {
                        let Some(order) = self.comparison.step(
                            &self.compare,
                            &self.inputs[index].buf[lo..hi],
                            &self.inputs[best].buf[b0..b1],
                            &mut work,
                            STEP,
                        ) else {
                            self.paused = true;
                            return;
                        };
                        order == Ordering::Less
                    }
                };
                if better {
                    self.selection.chosen = Some((index, lo, hi));
                }
                self.selection.next += 1;
                if work >= STEP {
                    self.paused = true;
                    return;
                }
            }
            let Some((index, lo, hi)) = self.selection.chosen else {
                return;
            };
            if self.compare.unique {
                if let Some(previous) = &self.previous {
                    let Some(order) = self.comparison.step(
                        &self.compare,
                        previous,
                        &self.inputs[index].buf[lo..hi],
                        &mut work,
                        STEP,
                    ) else {
                        self.paused = true;
                        return;
                    };
                    if order == Ordering::Equal {
                        self.inputs[index].consume(hi, self.separator);
                        self.selection = Selection::default();
                        continue;
                    }
                }
                let previous = self.previous.get_or_insert_with(Vec::new);
                previous.clear();
                if previous.capacity() < hi - lo {
                    *previous = Vec::new();
                    previous.reserve_exact(hi - lo);
                }
            }
            self.selection = Selection::default();
            self.writing = Some((index, lo, hi));
        }
    }

    fn wanted(&self) -> Option<usize> {
        (0..self.inputs.len())
            .find(|&index| !self.inputs[index].ended && self.inputs[index].head().is_none())
    }

    fn idle(&self) -> Result<(), StreamError> {
        if self.paused {
            return Err(StreamError::new("sort: a merge is still running"));
        }
        Ok(())
    }
}

impl Stream for Merger {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(0, input, out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.idle()?;
        for input in &mut self.inputs {
            input.ended = true;
        }
        self.pump(out);
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        if self.paused { None } else { self.wanted() }
    }

    fn busy(&self) -> bool {
        self.paused
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.paused {
            self.pump(out);
        }
        Ok(())
    }

    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        self.idle()?;
        let slot = self
            .inputs
            .get_mut(index)
            .ok_or_else(|| StreamError::new("no such merge input"))?;
        append(&mut slot.buf, input)?;
        slot.locate(self.separator);
        self.pump(out);
        Ok(())
    }

    fn end_input(&mut self, index: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.idle()?;
        let slot = self
            .inputs
            .get_mut(index)
            .ok_or_else(|| StreamError::new("no such merge input"))?;
        slot.ended = true;
        self.pump(out);
        Ok(())
    }
}

struct Checker {
    compare: Compare,
    quiet: bool,
    separator: u8,
    records: crate::records::Records,
    previous: Vec<u8>,
    index: u64,
    comparison: Comparison,
    paused: bool,
    copying: bool,
}

impl Checker {
    fn pump(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.paused = false;
        let mut work = 0;
        while work < STEP {
            let crate::records::Take::Record((record, _)) = self.records.peek_span(self.separator)
            else {
                return Ok(());
            };
            if !self.copying {
                if self.index > 0 {
                    let Some(order) = self.comparison.step(
                        &self.compare,
                        &self.previous,
                        record,
                        &mut work,
                        STEP,
                    ) else {
                        break;
                    };
                    if order == Ordering::Greater
                        || (self.compare.unique && order == Ordering::Equal)
                    {
                        if !self.quiet {
                            out.extend_from_slice(record);
                        }
                        return Err(StreamError::new((self.index + 1).to_string()));
                    }
                }
                self.previous.clear();
                if self.previous.capacity() < record.len() {
                    self.previous = Vec::with_capacity(record.len());
                }
                self.copying = true;
            }
            if work >= STEP {
                break;
            }
            let copy = &mut self.previous;
            let end = record.len().min(copy.len() + (STEP - work) * COST_BYTES);
            work += 1 + (end - copy.len()) / COST_BYTES;
            copy.extend_from_slice(&record[copy.len()..end]);
            if end == record.len() {
                self.copying = false;
                self.index += 1;
                self.records.advance();
            }
        }
        self.paused = true;
        Ok(())
    }

    fn idle(&self) -> Result<(), StreamError> {
        if self.paused {
            Err(StreamError::new("sort: a check is still running"))
        } else {
            Ok(())
        }
    }
}

impl Stream for Checker {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.idle()?;
        self.records
            .push(input)
            .map_err(|_| StreamError::refusal(b"sort: memory exhausted", 2))?;
        self.pump(out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.idle()?;
        self.records.end();
        self.pump(out)
    }

    fn busy(&self) -> bool {
        self.paused
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.paused { self.pump(out) } else { Ok(()) }
    }
}

#[cfg(test)]
mod tests;
