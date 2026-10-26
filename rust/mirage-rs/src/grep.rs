use std::collections::VecDeque;

use memchr::{memchr, memchr_iter, memrchr};
use serde::Deserialize;

use crate::regex::{Options, Regex, STEPS, Step, Syntax};
use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
enum BinaryFiles {
    #[default]
    Binary,
    Text,
    WithoutMatch,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// The pattern list, one entry per pattern; empty matches nothing.
    #[serde(deserialize_with = "crate::latin1_list")]
    patterns: Vec<Vec<u8>>,
    syntax: Syntax,
    #[serde(default)]
    ignore_case: bool,
    #[serde(default)]
    word: bool,
    #[serde(default)]
    line: bool,
    /// Lines are text under a UTF-8 locale.
    #[serde(default)]
    utf8: bool,
    #[serde(default)]
    invert: bool,
    #[serde(default)]
    line_numbers: bool,
    #[serde(default)]
    byte_offsets: bool,
    #[serde(default)]
    count: bool,
    #[serde(default)]
    files_with_matches: bool,
    #[serde(default)]
    files_without_match: bool,
    #[serde(default)]
    quiet: bool,
    #[serde(default)]
    only_matching: bool,
    #[serde(default, deserialize_with = "crate::saturating_u64_opt")]
    max_count: Option<u64>,
    #[serde(default, deserialize_with = "crate::saturating_u64")]
    after: u64,
    /// Lines held for leading context, at most this many at once.
    #[serde(default, deserialize_with = "crate::saturating_usize")]
    before: usize,
    #[serde(default)]
    binary: BinaryFiles,
    #[serde(default)]
    null_data: bool,
    /// -Z: a NUL follows each file name.
    #[serde(default)]
    null: bool,
    #[serde(default)]
    initial_tab: bool,
    /// The line between context groups, its newline included; none when
    /// no group is separated.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    separator: Option<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Begin {
    /// The name output lines and the binary-file notice carry.
    #[serde(deserialize_with = "crate::latin1")]
    label: Vec<u8>,
    #[serde(default)]
    show_filename: bool,
    /// The input's size, which -T sizes its fields to; none for a pipe.
    #[serde(default, deserialize_with = "crate::saturating_u64_opt")]
    size: Option<u64>,
    /// An earlier input printed lines, so this one's first context group
    /// opens with the separator.
    #[serde(default)]
    after_output: bool,
}

/// The digits of the largest signed 64-bit count, the width -T pads to when
/// the input's size is unknown.
const UNKNOWN_SIZE_WIDTH: usize = 19;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stop {
    Reading,
    /// No more lines, but the input's summary (-c, -L) still prints.
    Break,
    /// Nothing more for this input.
    Return,
}

struct Held {
    number: u64,
    offset: u64,
    text: Vec<u8>,
}

/// A line `open` began: its number and byte offset, whether it was
/// selected, and how many output pieces it produced.
#[derive(Clone, Copy)]
struct Opened {
    number: u64,
    offset: u64,
    hit: bool,
    written: usize,
}

/// A selected line under -o whose matches are being printed: its bounds
/// and where the next search starts.
struct Matches {
    start: usize,
    end: usize,
    at: usize,
    opened: Opened,
}

/// How far settling the whole lines of `pending` has got.
struct Scan {
    /// The first line not yet settled.
    pos: usize,
    /// The terminator of the last whole line.
    to: usize,
    /// The line being tested, when lines are tested one at a time.
    test: usize,
    matches: Option<Matches>,
}

struct Input {
    label: Vec<u8>,
    show: bool,
    width: usize,
    after_output: bool,
    /// Bytes after the last terminator fed.
    pending: Vec<u8>,
    /// A NUL was seen: the input is binary.
    nul: bool,
    // Counts and positions over the whole input are 64-bit, which a wasm
    // build's `usize` is not.
    count: u64,
    number: u64,
    offset: u64,
    last_printed: u64,
    after_until: u64,
    before: VecDeque<Held>,
    notified: bool,
    /// A -P search gave up at the backtracking limit: the input ends
    /// there and exits 2.
    failed: bool,
    stop: Stop,
    /// A scan that ran out of steps, which `drain` goes on with.
    scan: Option<Scan>,
    /// `finish` was called: the summary prints once the scan ends.
    finishing: bool,
}

/// grep over one input after another: the host walks the operands, reads
/// each one and starts it with `begin`; this stream selects its lines and
/// writes what GNU grep 3.11 prints for them. Each fed chunk is one block
/// of the binary-file probe, so the host cuts a large chunk into pieces of
/// at most 96 KiB.
struct Grep {
    config: Config,
    regex: Regex,
    terminator: u8,
    input: Option<Input>,
    stderr: Vec<u8>,
    /// Steps left in this call.
    budget: u64,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let terminator = if config.null_data { 0 } else { b'\n' };
    let options = Options {
        syntax: config.syntax,
        ignore_case: config.ignore_case,
        utf8: config.utf8,
        word: config.word,
        line: config.line,
        terminator,
        extents: config.only_matching,
    };
    let compiled = Regex::compile(&config.patterns, &options).map_err(StreamError::new)?;
    let mut stderr = Vec::new();
    for warning in compiled.warnings {
        stderr.extend_from_slice(b"grep: warning: ");
        stderr.extend_from_slice(warning.as_bytes());
        stderr.push(b'\n');
    }
    Ok(Box::new(Grep {
        config,
        regex: compiled.regex,
        terminator,
        input: None,
        stderr,
        budget: STEPS,
    }))
}

fn pad(out: &mut Vec<u8>, value: u64, width: usize) {
    let digits = value.to_string();
    out.resize(out.len() + width.saturating_sub(digits.len()), b' ');
    out.extend_from_slice(digits.as_bytes());
}

/// A buffer length as a 64-bit count.
fn wide(len: usize) -> u64 {
    u64::try_from(len).unwrap_or(u64::MAX)
}

impl Grep {
    fn input(&mut self) -> Result<&mut Input, StreamError> {
        self.input
            .as_mut()
            .ok_or_else(|| StreamError::new("grep stream fed before begin"))
    }

    fn name_end(&self) -> u8 {
        if self.config.null { 0 } else { b'\n' }
    }

    /// Spend `cost` of this call's steps.
    fn spend(&mut self, cost: usize) {
        self.budget = self.budget.saturating_sub(wide(cost));
    }

    /// Write one output line unless it is binary output, which GNU leaves
    /// out and reports once with the notice: any line once the input is
    /// binary, and under UTF-8 a line holding a byte no character owns.
    fn emit(
        config: &Config,
        input: &mut Input,
        stderr: &mut Vec<u8>,
        out: &mut Vec<u8>,
        text: &[u8],
        line: Option<(u64, bool, u64)>,
    ) {
        if config.binary != BinaryFiles::Text
            && (input.nul || (config.utf8 && std::str::from_utf8(text).is_err()))
        {
            Self::notice(config, input, stderr);
            return;
        }
        let Some((number, selected, offset)) = line else {
            out.extend_from_slice(text);
            return;
        };
        let separator = if selected { b':' } else { b'-' };
        if input.show {
            out.extend_from_slice(&input.label);
            out.push(if config.null { 0 } else { separator });
        }
        let mut fields = false;
        if config.line_numbers {
            pad(out, number, input.width);
            out.push(separator);
            fields = true;
        }
        if config.byte_offsets {
            pad(out, offset, input.width);
            out.push(separator);
            fields = true;
        }
        if config.initial_tab && (input.show || fields) && !text.is_empty() {
            out.push(b'\t');
        }
        out.extend_from_slice(text);
        out.push(if config.null_data { 0 } else { b'\n' });
    }

    fn notice(config: &Config, input: &mut Input, stderr: &mut Vec<u8>) {
        if config.binary == BinaryFiles::Binary && !input.notified {
            stderr.extend_from_slice(b"grep: ");
            stderr.extend_from_slice(&input.label);
            stderr.extend_from_slice(b": binary file matches\n");
            input.notified = true;
        }
    }

    /// Settle one line, `hay[start..end]`, which the pattern matches when
    /// `matched`, printing no -o matches.
    fn line(&mut self, hay: &[u8], start: usize, end: usize, matched: bool, out: &mut Vec<u8>) {
        if let Some(opened) = self.open_line(hay, start, end, matched, out) {
            self.close_line(hay, start, end, opened);
        }
    }

    /// Begin settling a line: count it, end the input where -q, -l or -L
    /// has its answer, and print its group separator, leading context and,
    /// without -o, the line itself. None when nothing more of it settles.
    fn open_line(
        &mut self,
        hay: &[u8],
        start: usize,
        end: usize,
        matched: bool,
        out: &mut Vec<u8>,
    ) -> Option<Opened> {
        let Grep {
            config,
            input: Some(input),
            stderr,
            ..
        } = self
        else {
            return None;
        };
        let text = &hay[start..end];
        input.number += 1;
        let number = input.number;
        let offset = input.offset;
        input.offset += wide(text.len()) + 1;
        let capped = config.max_count.is_some_and(|max| input.count >= max);
        let hit = matched != config.invert && !capped;
        if hit {
            input.count += 1;
            if config.quiet || config.files_without_match {
                input.stop = Stop::Return;
                return None;
            }
            if config.files_with_matches {
                out.extend_from_slice(&input.label);
                out.push(if config.null { 0 } else { b'\n' });
                input.stop = Stop::Return;
                return None;
            }
        }
        if config.count {
            if config.max_count.is_some_and(|max| input.count >= max) {
                input.stop = Stop::Break;
            }
            return None;
        }
        let mut written = 0;
        if hit {
            let first = input
                .before
                .iter()
                .find(|held| held.number > input.last_printed)
                .map_or(number, |held| held.number);
            if let Some(separator) = &config.separator {
                let gap = input.last_printed != 0 && first > input.last_printed + 1;
                if gap || (input.last_printed == 0 && input.after_output) {
                    Self::emit(config, input, stderr, out, separator, None);
                    written += 1;
                }
            }
            if !config.only_matching {
                let before = std::mem::take(&mut input.before);
                let printed = input.last_printed;
                for held in before.iter().filter(|held| held.number > printed) {
                    let line = Some((held.number, false, held.offset));
                    Self::emit(config, input, stderr, out, &held.text, line);
                    written += 1;
                }
                input.before = before;
            }
            input.last_printed = number;
            input.after_until = number.saturating_add(config.after);
            if !config.only_matching {
                let line = Some((number, true, offset));
                Self::emit(config, input, stderr, out, text, line);
                written += 1;
            }
        } else if number <= input.after_until {
            if !config.only_matching {
                let line = Some((number, false, offset));
                Self::emit(config, input, stderr, out, text, line);
                written += 1;
            }
            input.last_printed = number;
        }
        Some(Opened {
            number,
            offset,
            hit,
            written,
        })
    }

    /// Print one -o match, `hay[from..to]`, of the line `open_line` began
    /// at `start`.
    fn print_match(
        &mut self,
        hay: &[u8],
        start: usize,
        opened: &mut Opened,
        from: usize,
        to: usize,
        out: &mut Vec<u8>,
    ) {
        let Grep {
            config,
            input: Some(input),
            stderr,
            ..
        } = self
        else {
            return;
        };
        let line = Some((opened.number, true, opened.offset + wide(from - start)));
        Self::emit(config, input, stderr, out, &hay[from..to], line);
        opened.written += 1;
    }

    /// Finish settling a line: the binary notice for a selected line that
    /// printed nothing, the stops a binary input and -m make, and holding
    /// it for later leading context.
    fn close_line(&mut self, hay: &[u8], start: usize, end: usize, opened: Opened) {
        let Grep {
            config,
            input: Some(input),
            stderr,
            ..
        } = self
        else {
            return;
        };
        // A selected line with nothing to print (-o on an empty match) still
        // earns the notice.
        if opened.hit && opened.written == 0 && input.nul {
            Self::notice(config, input, stderr);
        }
        if input.nul && input.count > 0 && config.binary == BinaryFiles::Binary {
            input.stop = Stop::Return;
            return;
        }
        Self::hold(
            config,
            input,
            opened.number,
            opened.offset,
            &hay[start..end],
        );
        if config.max_count.is_some_and(|max| input.count >= max)
            && opened.number >= input.after_until
        {
            input.stop = Stop::Break;
        }
    }

    fn hold(config: &Config, input: &mut Input, number: u64, offset: u64, text: &[u8]) {
        if config.before == 0 {
            return;
        }
        let mut held = if input.before.len() >= config.before {
            input
                .before
                .pop_front()
                .map(|held| held.text)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        held.clear();
        held.extend_from_slice(text);
        input.before.push_back(Held {
            number,
            offset,
            text: held,
        });
    }

    /// Settle the unmatched lines `hay[from..until]`, `until` just past a
    /// terminator, without matching them again.
    fn unmatched(&mut self, hay: &[u8], mut from: usize, until: usize, out: &mut Vec<u8>) {
        let term = self.terminator;
        loop {
            let Some(input) = self.input.as_ref() else {
                return;
            };
            if from >= until || input.stop != Stop::Reading {
                return;
            }
            // A line that prints or decides something on its own goes
            // through `line`.
            let alone = self.config.invert
                || input.number < input.after_until
                || (input.nul
                    && input.count > 0
                    && self.config.binary == BinaryFiles::Binary
                    && !self.config.count);
            if !alone {
                break;
            }
            let end = from + memchr(term, &hay[from..until]).unwrap_or(until - from - 1);
            self.line(hay, from, end, false, out);
            from = end + 1;
        }
        let config = &self.config;
        let Some(input) = self.input.as_mut() else {
            return;
        };
        let lines = memchr_iter(term, &hay[from..until]).count();
        // The last few stay for a later line's leading context.
        let mut kept = Vec::new();
        let mut end = until - 1;
        while kept.len() < config.before.min(lines) {
            let start = memrchr(term, &hay[from..end]).map_or(from, |at| from + at + 1);
            kept.push((start, end));
            end = start.saturating_sub(1);
        }
        // `kept` runs from the gap's last line back.
        for (back, &(start, end)) in kept.iter().enumerate().rev() {
            let number = input.number + wide(lines - back);
            let offset = input.offset + wide(start - from);
            Self::hold(config, input, number, offset, &hay[start..end]);
        }
        input.number += wide(lines);
        input.offset += wide(until - from);
    }

    /// End the input where a -P search gave up, in GNU grep's words.
    fn give_up(&mut self) {
        let Some(input) = self.input.as_mut() else {
            return;
        };
        self.stderr.extend_from_slice(b"grep: ");
        self.stderr.extend_from_slice(&input.label);
        self.stderr.extend_from_slice(b": ");
        self.stderr
            .extend_from_slice(crate::regex::EXCEEDED.as_bytes());
        self.stderr.push(b'\n');
        input.failed = true;
        input.stop = Stop::Return;
    }

    fn reading(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(|input| input.stop == Stop::Reading)
    }

    /// Whether a line about to be selected prints its matches, which must
    /// be found first.
    fn prints_matches(&self) -> bool {
        let config = &self.config;
        let capped = self
            .input
            .as_ref()
            .is_some_and(|input| config.max_count.is_some_and(|max| input.count >= max));
        config.only_matching
            && !config.invert
            && !config.count
            && !config.quiet
            && !config.files_with_matches
            && !config.files_without_match
            && !capped
    }

    /// Print the -o matches of the line `matches` holds, from where they
    /// left off; false when the call's steps ran out first.
    fn print_matches(&mut self, hay: &[u8], matches: &mut Matches, out: &mut Vec<u8>) -> bool {
        while matches.at <= matches.end {
            if self.budget == 0 {
                return false;
            }
            let at = matches.at;
            let found = self
                .regex
                .extent(hay, matches.start, at, matches.end, &mut self.budget);
            match found {
                Step::Paused => return false,
                Step::Done(None) => {
                    if self.regex.exceeded() {
                        self.give_up();
                    }
                    self.spend(matches.end - at);
                    return true;
                }
                Step::Done(Some((from, to))) if to > from => {
                    self.print_match(hay, matches.start, &mut matches.opened, from, to, out);
                    matches.at = to;
                }
                Step::Done(Some((from, _))) => {
                    matches.at = from + self.regex.unit_len(hay, from, matches.end);
                }
            }
            self.spend(matches.at - at);
        }
        true
    }

    /// Settle the lines `scan` covers, false when the call's steps ran out
    /// before they were all settled.
    fn scan(&mut self, hay: &[u8], scan: &mut Scan, out: &mut Vec<u8>) -> bool {
        let term = self.terminator;
        loop {
            if !self.reading() {
                return true;
            }
            if let Some(mut matches) = scan.matches.take() {
                if !self.print_matches(hay, &mut matches, out) {
                    scan.matches = Some(matches);
                    return false;
                }
                self.close_line(hay, matches.start, matches.end, matches.opened);
                scan.pos = matches.end + 1;
                scan.test = scan.pos;
                continue;
            }
            if scan.pos > scan.to {
                return true;
            }
            if self.budget == 0 {
                return false;
            }
            let hit = if self.regex.spans_records() {
                match self.regex.find(hay, scan.pos, scan.to, &mut self.budget) {
                    Step::Paused => return false,
                    Step::Done(found) => {
                        let hit = found.map(|at| {
                            let start = memrchr(term, &hay[scan.pos..at])
                                .map_or(scan.pos, |line| scan.pos + line + 1);
                            (start, at + memchr(term, &hay[at..=scan.to]).unwrap_or(0))
                        });
                        self.spend(hit.map_or(scan.to + 1, |(_, end)| end + 1) - scan.pos);
                        hit
                    }
                }
            } else {
                loop {
                    let start = scan.test;
                    if start > scan.to {
                        break None;
                    }
                    if self.budget == 0 {
                        return false;
                    }
                    let end =
                        start + memchr(term, &hay[start..=scan.to]).unwrap_or(scan.to - start);
                    match self.regex.matches(hay, start, end, &mut self.budget) {
                        Step::Paused => return false,
                        Step::Done(true) => break Some((start, end)),
                        Step::Done(false) if self.regex.exceeded() => {
                            self.give_up();
                            return true;
                        }
                        Step::Done(false) => {
                            self.spend(end + 1 - start);
                            scan.test = end + 1;
                        }
                    }
                }
            };
            let gap_end = hit.map_or(scan.to + 1, |(start, _)| start);
            self.unmatched(hay, scan.pos, gap_end, out);
            let Some((start, end)) = hit else {
                scan.pos = scan.to + 1;
                return true;
            };
            scan.pos = start;
            if !self.reading() {
                return true;
            }
            if self.prints_matches() {
                if let Some(opened) = self.open_line(hay, start, end, true, out) {
                    scan.matches = Some(Matches {
                        start,
                        end,
                        at: start,
                        opened,
                    });
                    continue;
                }
            } else {
                self.line(hay, start, end, true, out);
            }
            scan.pos = end + 1;
            scan.test = scan.pos;
        }
    }

    /// Go on with the scan of `pending`, a fresh budget of steps for it;
    /// once it ends its lines go, and after `finish` the summary prints.
    fn settle(&mut self, out: &mut Vec<u8>) {
        self.budget = STEPS;
        let Some(input) = self.input.as_mut() else {
            return;
        };
        let Some(mut scan) = input.scan.take() else {
            return;
        };
        let hay = std::mem::take(&mut input.pending);
        let ended = self.scan(&hay, &mut scan, out);
        let Some(input) = self.input.as_mut() else {
            return;
        };
        input.pending = hay;
        if !ended {
            input.scan = Some(scan);
            return;
        }
        input.pending.drain(..=scan.to);
        if input.finishing {
            self.summary(out);
        }
    }

    /// What an input prints once its lines are settled: -L's name or -c's
    /// count.
    fn summary(&mut self, out: &mut Vec<u8>) {
        let name_end = self.name_end();
        let config = &self.config;
        let Some(input) = self.input.as_mut() else {
            return;
        };
        let listed = config.files_without_match && !config.quiet;
        if config.max_count == Some(0) {
            if listed {
                out.extend_from_slice(&input.label);
                out.push(name_end);
            }
            input.count = 0;
            return;
        }
        if input.nul && config.binary == BinaryFiles::WithoutMatch {
            input.count = 0;
        }
        if input.stop != Stop::Return {
            if listed {
                out.extend_from_slice(&input.label);
                out.push(name_end);
            } else if config.count && !(config.quiet || config.files_with_matches) {
                if input.show {
                    out.extend_from_slice(&input.label);
                    out.push(if config.null { 0 } else { b':' });
                }
                out.extend_from_slice(input.count.to_string().as_bytes());
                out.push(b'\n');
            }
        }
        input.stop = Stop::Return;
    }
}

impl Stream for Grep {
    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let begin: Begin = parse_config(config)?;
        let width = if !self.config.initial_tab {
            0
        } else {
            begin.size.map_or(UNKNOWN_SIZE_WIDTH, |size| {
                size.saturating_add(u64::from(self.config.line_numbers))
                    .to_string()
                    .len()
            })
        };
        // GNU selects nothing under -m0 and reads nothing.
        let stop = if self.config.max_count == Some(0) {
            Stop::Return
        } else {
            Stop::Reading
        };
        self.input = Some(Input {
            label: begin.label,
            show: begin.show_filename,
            width,
            after_output: begin.after_output,
            pending: Vec::new(),
            nul: false,
            count: 0,
            number: 0,
            offset: 0,
            last_printed: 0,
            after_until: 0,
            before: VecDeque::new(),
            notified: false,
            failed: false,
            stop,
            scan: None,
            finishing: false,
        });
        Ok(())
    }

    fn feed(&mut self, block: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let probe = self.config.binary != BinaryFiles::Text && !self.config.null_data;
        let without_match = self.config.binary == BinaryFiles::WithoutMatch;
        let term = self.terminator;
        let input = self.input()?;
        if input.scan.is_some() {
            return Err(StreamError::new("grep stream fed while busy"));
        }
        if input.stop != Stop::Reading {
            return Ok(());
        }
        if probe && !input.nul && memchr(0, block).is_some() {
            input.nul = true;
            if without_match {
                input.pending.clear();
                input.stop = Stop::Break;
                return Ok(());
            }
        }
        let start = input.pending.len();
        input.pending.extend_from_slice(block);
        if input.nul {
            for byte in &mut input.pending[start..] {
                if *byte == 0 {
                    *byte = b'\n';
                }
            }
        }
        let Some(last) = memrchr(term, &input.pending[start..]) else {
            return Ok(());
        };
        input.scan = Some(Scan {
            pos: 0,
            to: start + last,
            test: 0,
            matches: None,
        });
        self.settle(out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let term = self.terminator;
        let input = self.input()?;
        if input.scan.is_some() {
            return Err(StreamError::new("grep stream finished while busy"));
        }
        input.finishing = true;
        if input.stop == Stop::Reading && !input.pending.is_empty() {
            input.pending.push(term);
            input.scan = Some(Scan {
                pos: 0,
                to: input.pending.len() - 1,
                test: 0,
                matches: None,
            });
            self.settle(out);
        } else {
            self.summary(out);
        }
        Ok(())
    }

    fn busy(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(|input| input.scan.is_some())
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.settle(out);
        Ok(())
    }

    fn done(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(|input| input.stop != Stop::Reading)
    }

    fn status(&self) -> i32 {
        match &self.input {
            Some(input) if input.failed => 2,
            input => i32::from(input.as_ref().is_none_or(|input| input.count == 0)),
        }
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}

#[cfg(test)]
mod tests {
    use crate::open;

    /// Run `chunks` as one input; stdout, stderr and the status.
    fn grep(config: &str, chunks: &[&[u8]]) -> (String, String, i32) {
        let mut stream = open("grep", config.as_bytes()).expect("opens");
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        stream.begin(br#"{"label":"in"}"#).expect("begins");
        let mut out = Vec::new();
        for chunk in chunks {
            if stream.done() {
                break;
            }
            stream.feed(chunk, &mut out).expect("feeds");
            while stream.busy() {
                stream.drain(&mut out).expect("drains");
            }
        }
        stream.finish(&mut out).expect("finishes");
        while stream.busy() {
            stream.drain(&mut out).expect("drains");
        }
        stream.take_stderr(&mut err);
        let text = |bytes: Vec<u8>| String::from_utf8_lossy(&bytes).into_owned();
        (text(out), text(err), stream.status())
    }

    #[test]
    fn perl_patterns_print_their_keep_trimmed_matches() {
        let config = r#"{"patterns":["id=\\K\\d+"],"syntax":"perl","only_matching":true}"#;
        let (out, _, status) = grep(config, &[b"id=42 id=7\nnone\n"]);
        assert_eq!(out, "42\n7\n");
        assert_eq!(status, 0);
    }

    #[test]
    fn perl_word_and_line_wrap_the_pattern_as_gnu_does() {
        let word = r#"{"patterns":["ab"],"syntax":"perl","word":true}"#;
        assert_eq!(grep(word, &[b"ab\nabc\nx ab y\n"]).0, "ab\nx ab y\n");
        let line = r#"{"patterns":["a|ab"],"syntax":"perl","line":true}"#;
        assert_eq!(grep(line, &[b"ab\nabc\n"]).0, "ab\n");
    }

    #[test]
    fn perl_takes_one_pattern_and_refuses_in_pcre2s_words() {
        let two = r#"{"patterns":["a","b"],"syntax":"perl"}"#;
        assert_eq!(
            open("grep", two.as_bytes())
                .err()
                .map(|err| err.to_string()),
            Some("the -P option only supports a single pattern".to_string())
        );
        let bad = r#"{"patterns":["a("],"syntax":"perl"}"#;
        assert_eq!(
            open("grep", bad.as_bytes())
                .err()
                .map(|err| err.to_string()),
            Some("missing closing parenthesis".to_string())
        );
    }

    #[test]
    fn perl_ends_the_input_where_a_search_gives_up() {
        let config = r#"{"patterns":["^(a|a)+\\1c|^ok"],"syntax":"perl"}"#;
        let mut hay = vec![b'a'; 40];
        hay.extend_from_slice(b"xc\nok\n");
        let (out, err, status) = grep(config, &[&hay]);
        assert_eq!(out, "");
        assert_eq!(err, "grep: in: exceeded PCRE's backtracking limit\n");
        assert_eq!(status, 2);
    }

    #[test]
    fn perl_searches_charge_their_backtracking_between_steps() {
        let config = r#"{"patterns":["^(a|a)+\\1c|x$"],"syntax":"perl","count":true}"#;
        let mut stream = open("grep", config.as_bytes()).expect("opens");
        stream.begin(br#"{"label":"in"}"#).expect("begins");
        let mut out = Vec::new();
        let data = format!("{}x\n", "a".repeat(16)).repeat(64);
        stream.feed(data.as_bytes(), &mut out).expect("feeds");
        let mut calls = 1;
        while stream.busy() {
            stream.drain(&mut out).expect("drains");
            calls += 1;
        }
        stream.finish(&mut out).expect("finishes");
        while stream.busy() {
            stream.drain(&mut out).expect("drains");
        }
        assert!(calls > 8, "64 costly lines took {calls} calls");
        assert_eq!(out, b"64\n");
    }

    #[test]
    fn context_groups_are_separated() {
        let config = r#"{"patterns":["a"],"syntax":"basic","line_numbers":true,"after":1,"separator":"--\n"}"#;
        let (out, _, status) = grep(config, &[b"a\nb\nc\nd\na\n"]);
        assert_eq!(out, "1:a\n2-b\n--\n5:a\n");
        assert_eq!(status, 0);
    }

    #[test]
    fn a_line_may_span_chunks_and_end_without_a_newline() {
        let config = r#"{"patterns":["bc"],"syntax":"basic","byte_offsets":true}"#;
        let (out, _, _) = grep(config, &[b"x\na", b"bc\nzz\nb", b"c"]);
        assert_eq!(out, "2:abc\n9:bc\n");
    }

    #[test]
    fn max_count_stops_after_its_trailing_context() {
        let config =
            r#"{"patterns":["a"],"syntax":"basic","max_count":1,"after":1,"separator":"--\n"}"#;
        let (out, _, _) = grep(config, &[b"a\na\nb\n"]);
        assert_eq!(out, "a\na\n");
    }

    #[test]
    fn a_nul_makes_the_input_binary() {
        let config = r#"{"patterns":["a"],"syntax":"basic"}"#;
        let (out, err, status) = grep(config, &[b"a\0\na\n"]);
        assert_eq!((out.as_str(), status), ("", 0));
        assert_eq!(err, "grep: in: binary file matches\n");
        let config = r#"{"patterns":["a"],"syntax":"basic","count":true,"binary":"without-match"}"#;
        assert_eq!(
            grep(config, &[b"a\n", b"\0a\n"]),
            ("0\n".into(), String::new(), 1)
        );
    }

    #[test]
    fn a_stray_byte_under_utf8_is_left_out_with_the_notice() {
        let config = r#"{"patterns":["h"],"syntax":"basic","utf8":true,"line_numbers":true}"#;
        let (out, err, _) = grep(config, &[b"h\xff\nhello\n"]);
        assert_eq!(out, "2:hello\n");
        assert_eq!(err, "grep: in: binary file matches\n");
    }

    #[test]
    fn listing_and_counting() {
        let count = r#"{"patterns":["a"],"syntax":"basic","count":true,"invert":true}"#;
        assert_eq!(grep(count, &[b"a\nb\nc\n"]).0, "2\n");
        let listed = r#"{"patterns":["a"],"syntax":"basic","files_with_matches":true}"#;
        assert_eq!(grep(listed, &[b"b\na\n"]).0, "in\n");
        let unlisted =
            r#"{"patterns":["a"],"syntax":"basic","files_without_match":true,"max_count":0}"#;
        assert_eq!(grep(unlisted, &[b"a\n"]), ("in\n".into(), String::new(), 1));
    }

    #[test]
    fn only_matching_prints_each_longest_match() {
        let config =
            r#"{"patterns":["b","abc"],"syntax":"basic","only_matching":true,"byte_offsets":true}"#;
        let (out, _, _) = grep(config, &[b"xabc b\n"]);
        assert_eq!(out, "1:abc\n5:b\n");
    }

    #[test]
    fn null_data_records_end_at_nul() {
        let config = r#"{"patterns":["^b"],"syntax":"basic","null_data":true}"#;
        let (out, _, _) = grep(config, &[b"a\nb\0b\nc\0"]);
        assert_eq!(out, "b\nc\0");
    }

    #[test]
    fn quiet_wants_no_more_input_once_a_line_is_selected() {
        let mut stream = open(
            "grep",
            br#"{"patterns":["a"],"syntax":"basic","quiet":true}"#,
        )
        .expect("opens");
        stream.begin(br#"{"label":"in"}"#).expect("begins");
        let mut out = Vec::new();
        stream.feed(b"b\na\n", &mut out).expect("feeds");
        assert!(stream.done() && out.is_empty());
        assert_eq!(stream.status(), 0);
    }

    #[test]
    fn a_refused_pattern_and_a_warning() {
        let refused = open("grep", br#"{"patterns":["a\\{1"],"syntax":"basic"}"#).err();
        assert_eq!(refused.map(|err| err.message), Some("Unmatched \\{".into()));
        let (_, err, _) = grep(r#"{"patterns":["*a"],"syntax":"extended"}"#, &[b"a\n"]);
        assert_eq!(err, "grep: warning: * at start of expression\n");
    }

    #[test]
    fn a_slow_search_hands_back_control_between_steps() {
        let config = r#"{"patterns":["^(a*)*\\1b$"],"syntax":"extended"}"#;
        let mut stream = open("grep", config.as_bytes()).expect("opens");
        stream.begin(br#"{"label":"in"}"#).expect("begins");
        let mut out = Vec::new();
        let line = format!("{}!\n", "a".repeat(60));
        stream.feed(line.as_bytes(), &mut out).expect("feeds");
        for _ in 0..3 {
            assert!(stream.busy());
            stream.drain(&mut out).expect("drains");
        }
        assert!(out.is_empty());
        assert!(stream.feed(b"b\n", &mut out).is_err());
    }

    #[test]
    fn a_paused_search_resumes_where_it_stopped() {
        let config = r#"{"patterns":["^(a*)*\\1b$"],"syntax":"extended","count":true}"#;
        let slow = format!("{}!\n", "a".repeat(17));
        let (out, _, status) = grep(config, &[slow.as_bytes(), b"aab\nb\n"]);
        assert_eq!((out.as_str(), status), ("2\n", 0));
    }

    #[test]
    fn a_huge_after_context_saturates() {
        let config = r#"{"patterns":["x"],"syntax":"basic","after":18446744073709551615,"separator":"--\n"}"#;
        assert_eq!(grep(config, &[b"x\nnext\n"]).0, "x\nnext\n");
    }

    #[test]
    fn only_matching_on_a_long_line_prints_between_steps() {
        let config = r#"{"patterns":["a"],"syntax":"basic","only_matching":true}"#;
        let mut stream = open("grep", config.as_bytes()).expect("opens");
        stream.begin(br#"{"label":"in"}"#).expect("begins");
        let mut out = Vec::new();
        let line = format!("{}a{}a\n", "x".repeat(1 << 21), "x".repeat(8));
        stream.feed(line.as_bytes(), &mut out).expect("feeds");
        let mut calls = 1;
        while stream.busy() {
            stream.drain(&mut out).expect("drains");
            calls += 1;
        }
        assert!(calls > 2, "the long line took {calls} calls");
        assert_eq!(out, b"a\na\n");
    }

    #[test]
    fn a_line_matched_by_one_pattern_skips_the_slow_ones() {
        let config = r#"{"patterns":[".","^(a*)*\\1b$"],"syntax":"extended","quiet":true}"#;
        let mut stream = open("grep", config.as_bytes()).expect("opens");
        stream.begin(br#"{"label":"in"}"#).expect("begins");
        let mut out = Vec::new();
        let line = format!("{}!\n", "a".repeat(60));
        stream.feed(line.as_bytes(), &mut out).expect("feeds");
        assert!(!stream.busy() && stream.done());
        assert_eq!(stream.status(), 0);
    }

    #[test]
    fn fields_size_to_inputs_past_four_gibibytes() {
        let config =
            r#"{"patterns":["x"],"syntax":"basic","line_numbers":true,"initial_tab":true}"#;
        let mut stream = open("grep", config.as_bytes()).expect("opens");
        stream
            .begin(br#"{"label":"in","size":5000000000}"#)
            .expect("begins");
        let mut out = Vec::new();
        stream.feed(b"x\n", &mut out).expect("feeds");
        assert_eq!(out, b"         1:\tx\n");
    }
}
