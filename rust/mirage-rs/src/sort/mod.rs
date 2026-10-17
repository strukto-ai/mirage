mod key;
mod number;
mod version;

use std::cmp::Ordering;

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};
use key::Compare;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "mode")]
enum Config {
    /// Sort records into runs: once the buffered records reach `run_bytes`
    /// (each counting its length plus `RECORD_OVERHEAD`) the stream is busy
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
    /// `-c`: the first disorder refuses with its 1-based record number as
    /// the message and the record as the output.
    Check {
        compare: Compare,
        zero_terminated: bool,
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
        }),
        Config::Check {
            compare,
            zero_terminated,
        } => Box::new(Checker {
            compare,
            separator: separator(zero_terminated),
            partial: Vec::new(),
            previous: None,
            index: 0,
        }),
    })
}

fn separator(zero_terminated: bool) -> u8 {
    if zero_terminated { 0 } else { b'\n' }
}

const RECORD_OVERHEAD: usize = 64;

/// How much of a sorted run one `drain` writes, so a run is held once, as
/// its records, and never again as its output.
const PIECE: usize = 64 * 1024;

/// About how much work one `drain` or merge call does: a few milliseconds
/// even for keyed comparisons, so a host's loop is never held for a whole
/// run. A comparison counts by `cost`, so long records spend it sooner.
const STEP: usize = 4 * 1024;

/// A record's bytes that count as one more comparison's work, about what a
/// keyed comparison of two short records costs.
const COST_BYTES: usize = 256;

fn weight(record: &[u8]) -> usize {
    1 + record.len() / COST_BYTES
}

/// What comparing two records may cost: each can be read to its end.
fn cost(a: &[u8], b: &[u8]) -> usize {
    weight(a) + weight(b) - 1
}

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
        false
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
                }
            };
            return 0;
        }
        let mut end = next;
        let mut load = 0;
        while end < count && end - next < BLOCK && load < BLOCK {
            load += weight(self.record(self.spans[end]));
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
                let (a, b) = (
                    self.record(self.spans[right]),
                    self.record(self.spans[left]),
                );
                work += cost(a, b) - 1;
                self.compare.records(a, b) != Ordering::Less
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
        let Phase::Write { mut next, mut kept } = self.phase else {
            return;
        };
        let data = &self.data;
        let compare = &self.compare;
        let mut work = 0;
        let full = out.len() + PIECE;
        while next < self.spans.len() && out.len() < full && work < STEP {
            let (lo, hi) = self.spans[next];
            next += 1;
            if compare.unique
                && kept.is_some_and(|(k0, k1)| {
                    let (last, record) = (&data[k0..k1], &data[lo..hi]);
                    work += cost(last, record);
                    compare.records(last, record) == Ordering::Equal
                })
            {
                continue;
            }
            out.extend_from_slice(&data[lo..hi]);
            out.push(self.separator);
            kept = Some((lo, hi));
        }
        if next < self.spans.len() {
            self.phase = Phase::Write { next, kept };
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
        self.data.extend_from_slice(input);
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
}

impl Merger {
    fn pump(&mut self, out: &mut Vec<u8>) {
        self.paused = false;
        let mut work = 0;
        while self.wanted().is_none() {
            if work >= STEP {
                self.paused = true;
                return;
            }
            let mut chosen: Option<(usize, usize, usize)> = None;
            for index in 0..self.inputs.len() {
                let Some((lo, hi)) = self.inputs[index].head() else {
                    continue;
                };
                let better = match chosen {
                    None => true,
                    Some((best, b0, b1)) => {
                        let (a, b) = (
                            &self.inputs[index].buf[lo..hi],
                            &self.inputs[best].buf[b0..b1],
                        );
                        work += cost(a, b);
                        self.compare.records(a, b) == Ordering::Less
                    }
                };
                if better {
                    chosen = Some((index, lo, hi));
                }
            }
            let Some((index, lo, hi)) = chosen else {
                return;
            };
            let record = &self.inputs[index].buf[lo..hi];
            work += weight(record);
            let duplicate = self.compare.unique
                && self.previous.as_deref().is_some_and(|last| {
                    work += cost(last, record);
                    self.compare.records(last, record) == Ordering::Equal
                });
            if !duplicate {
                out.extend_from_slice(record);
                out.push(self.separator);
                if self.compare.unique {
                    self.previous = Some(record.to_vec());
                }
            }
            self.inputs[index].consume(hi, self.separator);
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
        slot.buf.extend_from_slice(input);
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
    separator: u8,
    partial: Vec<u8>,
    previous: Option<Vec<u8>>,
    index: u64,
}

impl Checker {
    fn record(&mut self, record: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.index += 1;
        if let Some(previous) = &self.previous {
            let order = self.compare.records(previous, record);
            if order == Ordering::Greater || (self.compare.unique && order == Ordering::Equal) {
                out.extend_from_slice(record);
                return Err(StreamError::new(self.index.to_string()));
            }
        }
        self.previous = Some(record.to_vec());
        Ok(())
    }
}

impl Stream for Checker {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut rest = input;
        while let Some(at) = memchr::memchr(self.separator, rest) {
            if self.partial.is_empty() {
                self.record(&rest[..at], out)?;
            } else {
                let mut record = std::mem::take(&mut self.partial);
                record.extend_from_slice(&rest[..at]);
                self.record(&record, out)?;
            }
            rest = &rest[at + 1..];
        }
        self.partial.extend_from_slice(rest);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.partial.is_empty() {
            let record = std::mem::take(&mut self.partial);
            self.record(&record, out)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{open, run};

    fn config(mode: &str, keys: &str, extra: &str) -> String {
        format!(
            r#"{{"mode":"{mode}","compare":{{"keys":{keys},"field_sep":null,"reverse":false,"unique":false,"stable":false}},"zero_terminated":false{extra}}}"#
        )
    }

    const WHOLE: &str = r#"[{"start_field":1,"start_char":1,"start_skip":false,"end_field":null,"end_char":null,"end_skip":false,"mods":{"numeric":false,"general_numeric":false,"human":false,"version":false,"month":false,"fold":false,"reverse":false,"dictionary":false,"ignore_nonprinting":false,"random":false}}]"#;

    #[test]
    fn sorts_bytes_and_keeps_a_missing_newline() {
        let cfg = config("sort", WHOLE, r#","run_bytes":8388608"#);
        assert_eq!(run("sort", &cfg, &[b"b\na\n\xff\nc"]).0, b"a\nb\nc\n\xff\n");
    }

    /// Every `drain` until the stream is idle, and how many it took.
    fn drain_run(stream: &mut dyn crate::Stream) -> (Vec<u8>, usize) {
        let mut out = Vec::new();
        let mut calls = 0;
        while stream.busy() {
            stream.drain(&mut out).unwrap();
            calls += 1;
        }
        (out, calls)
    }

    #[test]
    fn a_full_run_makes_the_stream_busy() {
        let cfg = config("sort", WHOLE, r#","run_bytes":130"#);
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed(b"c\na\n", &mut out).unwrap();
        assert!(out.is_empty() && stream.busy());
        assert!(stream.feed(b"b\n", &mut out).is_err());
        assert_eq!(drain_run(stream.as_mut()).0, b"a\nc\n");
        stream.feed(b"b\n", &mut out).unwrap();
        assert!(!stream.busy());
        stream.finish(&mut out).unwrap();
        assert_eq!(drain_run(stream.as_mut()).0, b"b\n");
        assert!(out.is_empty());
    }

    #[test]
    fn sorts_and_writes_a_run_in_bounded_steps() {
        let cfg = config("sort", WHOLE, r#","run_bytes":1073741824"#);
        let input: Vec<u8> = (0..30000)
            .rev()
            .flat_map(|n| format!("{n:05}\n").into_bytes())
            .collect();
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed(&input, &mut out).unwrap();
        assert!(!stream.busy());
        stream.finish(&mut out).unwrap();
        let mut pieces = 0;
        let mut calls = 0;
        while stream.busy() {
            let mut piece = Vec::new();
            stream.drain(&mut piece).unwrap();
            assert!(piece.len() < super::PIECE + 16);
            calls += 1;
            pieces += usize::from(!piece.is_empty());
            out.extend_from_slice(&piece);
        }
        assert_eq!(pieces, input.len().div_ceil(super::PIECE));
        assert!(calls > pieces);
        let want: Vec<u8> = (0..30000)
            .flat_map(|n| format!("{n:05}\n").into_bytes())
            .collect();
        assert_eq!(out, want);
    }

    #[test]
    fn the_stepped_merge_is_stable() {
        let keys = WHOLE.replace(r#""end_field":null"#, r#""end_field":1"#);
        let cfg = config("sort", &keys, r#","run_bytes":1073741824"#)
            .replace(r#""stable":false"#, r#""stable":true"#);
        let lines: Vec<String> = (0..5000)
            .map(|n| format!("{} {n}", (n * 7919) % 13))
            .collect();
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        let mut want = lines.clone();
        want.sort_by_key(|line| line.split(' ').next().unwrap().to_owned());
        let want: String = want.iter().map(|line| format!("{line}\n")).collect();
        assert_eq!(
            String::from_utf8(run("sort", &cfg, &[text.as_bytes()]).0).unwrap(),
            want
        );
    }

    #[test]
    fn a_full_run_waits_for_the_next_feed() {
        let cfg = config("sort", WHOLE, r#","run_bytes":130"#);
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed(b"d\nc\nb\na\n", &mut out).unwrap();
        assert_eq!(drain_run(stream.as_mut()).0, b"c\nd\n");
        stream.feed(b"", &mut out).unwrap();
        assert_eq!(drain_run(stream.as_mut()).0, b"a\nb\n");
        stream.finish(&mut out).unwrap();
        assert!(!stream.busy() && out.is_empty());
    }

    #[test]
    fn finish_writes_every_run_left() {
        let cfg = config("sort", WHOLE, r#","run_bytes":130"#);
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed(b"f\ne\nd\nc\nb\na\n", &mut out).unwrap();
        assert_eq!(drain_run(stream.as_mut()).0, b"e\nf\n");
        stream.finish(&mut out).unwrap();
        assert_eq!(drain_run(stream.as_mut()).0, b"c\nd\na\nb\n");
        assert!(out.is_empty());
    }

    #[test]
    fn counts_past_32_bits_saturate() {
        let keys = WHOLE
            .replace(r#""start_field":1"#, r#""start_field":2"#)
            .replace(r#""start_char":1"#, r#""start_char":4294967295"#)
            .replace(
                r#""end_field":null"#,
                r#""end_field":100000000000000000000"#,
            );
        let cfg = config("sort", &keys, r#","run_bytes":18446744073709551616"#)
            .replace(r#""stable":false"#, r#""stable":true"#);
        assert_eq!(run("sort", &cfg, &[b"zz b\naa a\n"]).0, b"zz b\naa a\n");
        assert!(open("base64", br#"{"mode":"encode","wrap":4294967296}"#).is_ok());
    }

    #[test]
    fn merges_a_long_record_once() {
        let cfg = config("merge", WHOLE, r#","inputs":2"#);
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let mut out = Vec::new();
        let long = vec![b'z'; 1 << 20];
        for piece in long.chunks(16 * 1024) {
            stream.feed_input(0, piece, &mut out).unwrap();
        }
        stream.feed_input(0, b"\n", &mut out).unwrap();
        stream.end_input(0, &mut out).unwrap();
        let short: Vec<u8> = (0..20000)
            .flat_map(|n| format!("a{n:05}\n").into_bytes())
            .collect();
        stream.feed_input(1, &short, &mut out).unwrap();
        out.extend(drain_run(stream.as_mut()).0);
        stream.end_input(1, &mut out).unwrap();
        out.extend(drain_run(stream.as_mut()).0);
        stream.finish(&mut out).unwrap();
        assert_eq!(&out[..short.len()], &short[..]);
        assert_eq!(out.len(), short.len() + long.len() + 1);
    }

    #[test]
    fn a_merge_call_does_bounded_work() {
        let keys = WHOLE.replace(r#""numeric":false"#, r#""numeric":true"#);
        let cfg = config("merge", &keys, r#","inputs":2"#);
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let mut out = Vec::new();
        let mut long = vec![b'9'; 32 * 1024];
        long.push(b'\n');
        stream.feed_input(0, &long, &mut out).unwrap();
        stream.end_input(0, &mut out).unwrap();
        let short = b"1\n".repeat(2000);
        // Each comparison may read the long number, so a call writes only
        // the few short records its work allows.
        let most = super::STEP / super::weight(&long) + 1;
        let mut calls = 1;
        stream.feed_input(1, &short, &mut out).unwrap();
        assert!(stream.busy() && out.len() <= most * 2);
        while stream.busy() {
            let mut piece = Vec::new();
            stream.drain(&mut piece).unwrap();
            assert!(piece.len() <= most * 2);
            out.extend(piece);
            calls += 1;
        }
        assert!(calls >= 2000 / most);
        stream.end_input(1, &mut out).unwrap();
        out.extend(drain_run(stream.as_mut()).0);
        stream.finish(&mut out).unwrap();
        assert_eq!(&out[..short.len()], &short[..]);
        assert_eq!(&out[short.len()..], &long[..]);
    }

    #[test]
    fn long_records_sort_in_smaller_blocks_and_stay_stable() {
        let keys = WHOLE.replace(r#""end_field":null"#, r#""end_field":1"#);
        let cfg = config("sort", &keys, r#","run_bytes":1073741824"#)
            .replace(r#""stable":false"#, r#""stable":true"#);
        let lines: Vec<String> = (0..3000)
            .map(|n| {
                let pad = if n % 50 == 0 {
                    "x".repeat(20_000)
                } else {
                    String::new()
                };
                format!("{} {n}{pad}", (n * 7919) % 13)
            })
            .collect();
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        let mut want = lines.clone();
        want.sort_by_key(|line| line.split(' ').next().unwrap().to_owned());
        let want: String = want.iter().map(|line| format!("{line}\n")).collect();
        assert_eq!(
            String::from_utf8(run("sort", &cfg, &[text.as_bytes()]).0).unwrap(),
            want
        );
    }

    #[test]
    fn a_separator_is_any_one_byte() {
        // GNU sort 9.7 in the pinned image: LC_ALL=C sort -t $'\xff' -k2,2.
        let keys = WHOLE
            .replace(r#""start_field":1"#, r#""start_field":2"#)
            .replace(r#""end_field":null"#, r#""end_field":2"#);
        let cfg = config("sort", &keys, r#","run_bytes":8388608"#)
            .replace(r#""field_sep":null"#, r#""field_sep":255"#);
        assert_eq!(
            run("sort", &cfg, &[b"a\xffz\nb\xffy\n"]).0,
            b"b\xffy\na\xffz\n"
        );
    }

    #[test]
    fn version_reads_the_key_as_d_and_i_leave_it() {
        // GNU sort 9.7 in the pinned image, LC_ALL=C.
        let input: &[u8] = b"ab\na-b\na\x01b\n";
        for (mods, unique, want) in [
            (r#""dictionary":true"#, true, &b"ab\n"[..]),
            (r#""ignore_nonprinting":true"#, true, b"ab\na-b\n"),
            (r#""dictionary":true"#, false, b"a\x01b\na-b\nab\n"),
            (r#""ignore_nonprinting":true"#, false, b"a\x01b\nab\na-b\n"),
        ] {
            let keys = WHOLE
                .replace(r#""version":false"#, r#""version":true"#)
                .replace(&mods.replace("true", "false"), mods);
            let mut cfg = config("sort", &keys, r#","run_bytes":8388608"#);
            if unique {
                cfg = cfg.replace(r#""unique":false"#, r#""unique":true"#);
            }
            assert_eq!(
                run("sort", &cfg, &[input]).0,
                want,
                "{mods} unique={unique}"
            );
        }
    }

    // GNU sort 9.7's `sort -V` of these lines, measured in the pinned image.
    const VERSIONS: &[&str] = &[
        "",
        ".",
        "..",
        ".1",
        ".a",
        ".f",
        ".hidden",
        "~~",
        "~",
        "0",
        "00",
        "001",
        "01",
        "1",
        "1.a",
        "1.a.b",
        "1e5",
        "1.0~rc1",
        "1.0~rc2",
        "1.0",
        "1.0a",
        "1.0-1",
        "1.0.1",
        "1.2",
        "1.5~",
        "1.5a",
        "1.5.5",
        "1.010",
        "1.10",
        "2.0.0~beta",
        "2.0.0",
        "2.0.0+git",
        "9",
        "10",
        "Ab",
        "Z",
        "a~",
        "a",
        "a.b.c",
        "a.tar",
    ];

    #[test]
    fn orders_versions_as_gnu_does() {
        let keys = WHOLE.replace(r#""version":false"#, r#""version":true"#);
        let cfg = config("sort", &keys, r#","run_bytes":8388608"#);
        let mut input: Vec<&str> = VERSIONS.to_vec();
        input.reverse();
        input.rotate_left(17);
        let text: String = input.iter().map(|line| format!("{line}\n")).collect();
        let want: String = VERSIONS.iter().map(|line| format!("{line}\n")).collect();
        assert_eq!(
            String::from_utf8(run("sort", &cfg, &[text.as_bytes()]).0).unwrap(),
            want
        );
    }

    #[test]
    fn merges_inputs_on_demand() {
        let cfg = config("merge", WHOLE, r#","inputs":2"#);
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let mut out = Vec::new();
        assert_eq!(stream.wants(), Some(0));
        stream.feed_input(0, b"a\nc", &mut out).unwrap();
        assert_eq!(stream.wants(), Some(1));
        stream.feed_input(1, b"b\n", &mut out).unwrap();
        assert_eq!(out, b"a\n");
        assert_eq!(stream.wants(), Some(0));
        stream.end_input(0, &mut out).unwrap();
        assert_eq!(out, b"a\nb\n");
        assert_eq!(stream.wants(), Some(1));
        stream.end_input(1, &mut out).unwrap();
        assert_eq!(stream.wants(), None);
        stream.finish(&mut out).unwrap();
        assert_eq!(out, b"a\nb\nc\n");
    }

    #[test]
    fn check_names_the_first_disorder() {
        let cfg = config("check", WHOLE, "");
        let (out, err) = run("sort", &cfg, &[b"a\nc\n", b"b\nd\n"]);
        assert_eq!(out, b"b");
        assert_eq!(err.map(|e| e.message), Some("3".into()));
    }
}
