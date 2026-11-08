use std::borrow::Cow;
use std::collections::VecDeque;
use std::ops::Range;

use crate::{Stream, StreamError, number};
use serde::Deserialize;
use similar::{
    Algorithm, DiffOp, DiffTag, capture_diff_slices, capture_diff_slices_by_key, group_diff_ops,
    udiff::UnifiedHunkHeader,
};

const BINARY_PROBE_BYTES: usize = 4096;
const HINT: &[u8] = b"diff: Try 'diff --help' for more information.";

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Normal,
    Unified,
    Ed,
}
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    mode: Mode,
    #[serde(deserialize_with = "crate::saturating_usize")]
    context: usize,
    /// `-U` and `--unified` as typed, each value one character per byte
    /// and a bare `--unified` null; when given, they set `context`.
    unified: Option<Vec<Option<String>>>,
    ignore_case: bool,
    ignore_all_space: bool,
    ignore_space_change: bool,
    text: bool,
    brief: bool,
    old_label: String,
    new_label: String,
    old_header: String,
    new_header: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::Normal,
            context: 3,
            unified: None,
            ignore_case: false,
            ignore_all_space: false,
            ignore_space_change: false,
            text: false,
            brief: false,
            old_label: "a".into(),
            new_label: "b".into(),
            old_header: String::new(),
            new_header: String::new(),
        }
    }
}

/// The context `-U` and `--unified` give as diffutils 3.10 reads each one
/// typed: a bare `--unified` is 3, an empty value 0, and any other a whole
/// decimal past blanks with one sign, refused below 0, a value past
/// `intmax_t` the largest; the widest wins, and none is 3.
fn unified_context(typed: &[Option<String>]) -> Result<usize, StreamError> {
    let mut widest = None;
    for text in typed {
        let context = match text {
            None => 3,
            Some(text) => {
                let raw = crate::latin1_bytes(text)
                    .ok_or_else(|| StreamError::new("a -U value holds a character past U+00FF"))?;
                let value = if raw.is_empty() {
                    Some(0)
                } else {
                    number::signed_decimal(&raw).filter(|&value| value >= 0)
                };
                let Some(value) = value else {
                    let refused = [
                        b"diff: invalid context length '".as_slice(),
                        &raw,
                        b"'\n",
                        HINT,
                    ]
                    .concat();
                    return Err(StreamError::refusal(&refused, 2));
                };
                usize::try_from(value.min(i128::from(i64::MAX))).unwrap_or(usize::MAX)
            }
        };
        widest = widest.max(Some(context));
    }
    Ok(widest.unwrap_or(3))
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let mut config: Config = crate::parse_config(config)?;
    if let Some(typed) = &config.unified {
        config.context = unified_context(typed)?;
    }
    if config.brief {
        let ignores = config.ignore_case || config.ignore_all_space || config.ignore_space_change;
        return Ok(Box::new(Brief {
            config,
            held: [Vec::new(), Vec::new()],
            searched: [0; 2],
            ended: [false; 2],
            lines: if ignores { None } else { Some(false) },
            differ: None,
        }));
    }
    Ok(Box::new(Diff {
        config,
        inputs: [Vec::new(), Vec::new()],
        ended: [false; 2],
        pieces: VecDeque::new(),
        records: [Vec::new(), Vec::new()],
        groups: VecDeque::new(),
        ops: VecDeque::new(),
        stderr: Vec::new(),
        status: 0,
        equal: true,
    }))
}
struct Diff {
    config: Config,
    inputs: [Vec<u8>; 2],
    ended: [bool; 2],
    pieces: VecDeque<Piece>,
    records: [Vec<usize>; 2],
    groups: VecDeque<Vec<DiffOp>>,
    ops: VecDeque<DiffOp>,
    stderr: Vec<u8>,
    status: i32,
    equal: bool,
}

enum Piece {
    Text(Cow<'static, [u8]>, usize),
    Range {
        input: usize,
        bytes: Range<usize>,
    },
    Rows {
        input: usize,
        lines: Range<usize>,
        prefix: &'static [u8],
        hint: bool,
        ed: bool,
    },
}

fn key<'a>(line: &&'a [u8], config: &Config) -> Cow<'a, [u8]> {
    if !config.ignore_case && !config.ignore_all_space && !config.ignore_space_change {
        return Cow::Borrowed(if config.mode == Mode::Ed {
            line.strip_suffix(b"\n").unwrap_or(line)
        } else {
            line
        });
    }
    let mut line = *line;
    let newline = line.ends_with(b"\n");
    if newline {
        line = &line[..line.len() - 1];
    }
    let lowercase;
    if config.ignore_case {
        lowercase = {
            let mut bytes = Vec::with_capacity(line.len());
            for chunk in line.utf8_chunks() {
                bytes.extend_from_slice(chunk.valid().to_lowercase().as_bytes());
                bytes.extend_from_slice(chunk.invalid());
            }
            bytes
        };
        line = &lowercase;
    }
    let mut out = Vec::new();
    let mut spaces = false;
    for &byte in line {
        if matches!(byte, b' ' | b'\t' | b'\r' | 0x0b | 0x0c) {
            if config.ignore_all_space {
                continue;
            }
            if config.ignore_space_change {
                spaces = true;
                continue;
            }
        }
        if spaces {
            out.push(b' ');
            spaces = false;
        }
        out.push(byte);
    }
    if newline && !config.ignore_all_space && !config.ignore_space_change && config.mode != Mode::Ed
    {
        out.push(b'\n');
    }
    Cow::Owned(out)
}
fn address(range: std::ops::Range<usize>) -> String {
    if range.is_empty() {
        range.start.to_string()
    } else if range.len() == 1 {
        (range.start + 1).to_string()
    } else {
        format!("{},{}", range.start + 1, range.end)
    }
}
impl Diff {
    fn compute(&mut self) {
        if !self.config.text
            && self
                .inputs
                .iter()
                .any(|bytes| bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0))
        {
            self.equal = self.inputs[0] == self.inputs[1];
            self.status = if self.equal { 0 } else { 1 };
            if !self.equal {
                self.text(
                    format!(
                        "Binary files {} and {} differ\n",
                        self.config.old_label, self.config.new_label
                    )
                    .into_bytes(),
                );
            }
            self.release_inputs();
            return;
        }
        let old: Vec<&[u8]> = self.inputs[0].split_inclusive(|b| *b == b'\n').collect();
        let new: Vec<&[u8]> = self.inputs[1].split_inclusive(|b| *b == b'\n').collect();
        let normalize = self.config.ignore_case
            || self.config.ignore_all_space
            || self.config.ignore_space_change
            || self.config.mode == Mode::Ed;
        let ops = if normalize {
            capture_diff_slices_by_key(Algorithm::Myers, &old, &new, |record| {
                key(record, &self.config)
            })
        } else {
            capture_diff_slices(Algorithm::Myers, &old, &new)
        };
        self.equal = ops.iter().all(|op| op.tag() == DiffTag::Equal);
        self.status = if self.equal { 0 } else { 1 };
        if self.config.mode == Mode::Ed {
            for (bytes, label) in [
                (&self.inputs[0], &self.config.old_label),
                (&self.inputs[1], &self.config.new_label),
            ] {
                if !bytes.is_empty() && !bytes.ends_with(b"\n") {
                    self.stderr.extend_from_slice(
                        format!("diff: {}: No newline at end of file\n\n", label).as_bytes(),
                    );
                    self.status = 2;
                }
            }
        }
        if self.equal {
            self.release_inputs();
            return;
        }
        for (index, lines) in [&old, &new].into_iter().enumerate() {
            let mut offset = 0;
            self.records[index].push(0);
            for line in lines {
                offset += line.len();
                self.records[index].push(offset);
            }
        }
        match self.config.mode {
            Mode::Unified => {
                let context = self
                    .config
                    .context
                    .min(old.len().max(new.len()))
                    .min(usize::MAX / 2);
                self.groups = group_diff_ops(ops, context).into();
                if !self.groups.is_empty() {
                    self.text(
                        format!(
                            "--- {}\n+++ {}\n",
                            if self.config.old_header.is_empty() {
                                &self.config.old_label
                            } else {
                                &self.config.old_header
                            },
                            if self.config.new_header.is_empty() {
                                &self.config.new_label
                            } else {
                                &self.config.new_header
                            },
                        )
                        .into_bytes(),
                    );
                }
            }
            Mode::Normal => self.ops = ops.into(),
            Mode::Ed => self.ops = ops.into_iter().rev().collect(),
        }
    }

    fn release_inputs(&mut self) {
        self.inputs = [Vec::new(), Vec::new()];
        self.records = [Vec::new(), Vec::new()];
    }

    fn text(&mut self, bytes: impl Into<Cow<'static, [u8]>>) {
        self.pieces.push_back(Piece::Text(bytes.into(), 0));
    }

    fn rows(
        &mut self,
        input: usize,
        lines: Range<usize>,
        prefix: &'static [u8],
        hint: bool,
        ed: bool,
    ) {
        if !lines.is_empty() {
            self.pieces.push_back(Piece::Rows {
                input,
                lines,
                prefix,
                hint,
                ed,
            });
        }
    }

    fn prepare(&mut self) {
        if self.ops.is_empty() {
            if let Some(group) = self.groups.pop_front() {
                self.text(format!("{}\n", UnifiedHunkHeader::new(&group)).into_bytes());
                self.ops = group.into();
                return;
            }
        }
        let Some(op) = self.ops.pop_front() else {
            return;
        };
        let a = op.old_range();
        let b = op.new_range();
        if self.config.mode == Mode::Unified {
            if op.tag() == DiffTag::Equal {
                self.rows(0, a, b" ", true, false);
            } else {
                self.rows(0, a, b"-", true, false);
                self.rows(1, b, b"+", true, false);
            }
            return;
        }
        if op.tag() == DiffTag::Equal {
            return;
        }
        let action = if a.is_empty() {
            'a'
        } else if b.is_empty() {
            'd'
        } else {
            'c'
        };
        if self.config.mode == Mode::Normal {
            self.text(
                format!("{}{}{}\n", address(a.clone()), action, address(b.clone())).into_bytes(),
            );
            let both = !a.is_empty() && !b.is_empty();
            self.rows(0, a, b"< ", true, false);
            if both {
                self.text(b"---\n".as_slice());
            }
            self.rows(1, b, b"> ", true, false);
        } else {
            self.text(format!("{}{}\n", address(a), action).into_bytes());
            if !b.is_empty() {
                let last = &self.inputs[1][self.records[1][b.end - 1]..self.records[1][b.end]];
                let dot = last == b".\n" || last == b".";
                self.rows(1, b, b"", false, true);
                if !dot {
                    self.text(b".\n".as_slice());
                }
            }
        }
    }

    fn render(&mut self, out: &mut Vec<u8>) {
        let end = out.len() + 65536;
        let mut steps = 0;
        while out.len() < end && self.busy() && steps < 4096 {
            steps += 1;
            let Some(piece) = self.pieces.pop_front() else {
                self.prepare();
                continue;
            };
            match piece {
                Piece::Text(bytes, at) => {
                    let to = bytes.len().min(at + end - out.len());
                    out.extend_from_slice(&bytes[at..to]);
                    if to < bytes.len() {
                        self.pieces.push_front(Piece::Text(bytes, to));
                    }
                }
                Piece::Range { input, mut bytes } => {
                    let to = bytes.end.min(bytes.start + end - out.len());
                    out.extend_from_slice(&self.inputs[input][bytes.start..to]);
                    bytes.start = to;
                    if !bytes.is_empty() {
                        self.pieces.push_front(Piece::Range { input, bytes });
                    }
                }
                Piece::Rows {
                    input,
                    mut lines,
                    prefix,
                    hint,
                    ed,
                } => {
                    let bytes =
                        self.records[input][lines.start]..self.records[input][lines.start + 1];
                    let value = &self.inputs[input][bytes.clone()];
                    lines.start += 1;
                    let more = !lines.is_empty();
                    if more {
                        self.pieces.push_front(Piece::Rows {
                            input,
                            lines,
                            prefix,
                            hint,
                            ed,
                        });
                    }
                    if ed && (value == b".\n" || value == b".") {
                        let text = if more {
                            b"..\n.\ns/.//\na\n".as_slice()
                        } else {
                            b"..\n.\ns/.//\n".as_slice()
                        };
                        self.pieces.push_front(Piece::Text(text.into(), 0));
                    } else {
                        if !value.ends_with(b"\n") {
                            let text = if hint {
                                b"\n\\ No newline at end of file\n".as_slice()
                            } else {
                                b"\n".as_slice()
                            };
                            self.pieces.push_front(Piece::Text(text.into(), 0));
                        }
                        self.pieces.push_front(Piece::Range { input, bytes });
                        if !prefix.is_empty() {
                            self.pieces.push_front(Piece::Text(prefix.into(), 0));
                        }
                    }
                }
            }
        }
        if !self.busy() {
            self.release_inputs();
        }
    }
}
impl Stream for Diff {
    fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("use indexed inputs"))
    }
    fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.ended != [true, true] {
            return Err(StreamError::new("diff needs both indexed inputs to end"));
        }
        Ok(())
    }
    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        _: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if index > 1 || self.ended[index] {
            return Err(StreamError::new("invalid or ended input"));
        }
        self.inputs[index].extend_from_slice(input);
        Ok(())
    }
    fn end_input(&mut self, index: usize, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if index > 1 || self.ended[index] {
            return Err(StreamError::new("invalid or ended input"));
        }
        self.ended[index] = true;
        if self.ended == [true, true] {
            self.compute();
        }
        Ok(())
    }
    fn wants(&self) -> Option<usize> {
        (0..2).find(|index| !self.ended[*index])
    }
    fn busy(&self) -> bool {
        !self.pieces.is_empty() || !self.ops.is_empty() || !self.groups.is_empty()
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.render(out);
        Ok(())
    }
    fn status(&self) -> i32 {
        self.status
    }
    /// `{"outcome": "equal" | "different", "context": N}`.
    fn metadata(&self, out: &mut Vec<u8>) {
        let outcome = if self.equal { "equal" } else { "different" };
        let metadata = serde_json::json!({"outcome": outcome, "context": self.config.context});
        out.extend_from_slice(metadata.to_string().as_bytes());
    }
    fn take_stderr(&mut self, out: &mut Vec<u8>) {
        out.append(&mut self.stderr);
    }
}

/// `-q`: whether two inputs differ, decided as they come. Without an
/// ignore option it is their bytes, matched as each arrives, so neither is
/// held past what the other has reached; with one it is their lines'
/// keys, a line of each at a time, once the start of each shows neither is
/// binary (a binary pair compares bytes). Once they differ, neither is
/// read further.
struct Brief {
    config: Config,
    held: [Vec<u8>; 2],
    /// How far each held line is known to have no newline, or where its
    /// newline is, so a long line is searched once.
    searched: [usize; 2],
    ended: [bool; 2],
    /// Whether lines' keys decide, None until the binary probe has run.
    lines: Option<bool>,
    differ: Option<bool>,
}

/// Where the line `held` holds from `at` ends: past its newline or, once
/// its input has ended, at its end. The search starts at `searched` and
/// leaves it at the newline, or at the end when there is none.
fn line_end(held: &[u8], at: usize, searched: &mut usize, ended: bool) -> Option<usize> {
    let from = at.max(*searched);
    match memchr::memchr(b'\n', &held[from..]) {
        Some(found) => {
            *searched = from + found;
            Some(from + found + 1)
        }
        None => {
            *searched = held.len();
            (ended && at < held.len()).then_some(held.len())
        }
    }
}

impl Brief {
    fn ready(&self, index: usize) -> bool {
        self.ended[index] || self.held[index].len() >= BINARY_PROBE_BYTES
    }

    fn settle(&mut self) {
        if self.lines.is_none() {
            if !(self.ready(0) && self.ready(1)) {
                return;
            }
            let binary = !self.config.text
                && self
                    .held
                    .iter()
                    .any(|bytes| bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0));
            self.lines = Some(!binary);
        }
        let differ = if self.lines == Some(true) {
            self.settle_lines()
        } else {
            self.settle_bytes()
        };
        if differ.is_some() {
            self.differ = differ;
            self.held = [Vec::new(), Vec::new()];
        }
    }

    fn settle_bytes(&mut self) -> Option<bool> {
        let [old, new] = &mut self.held;
        let common = old.len().min(new.len());
        if old[..common] != new[..common] {
            return Some(true);
        }
        old.drain(..common);
        new.drain(..common);
        match (old.is_empty(), new.is_empty()) {
            (true, true) if self.ended == [true, true] => Some(false),
            (true, false) if self.ended[0] => Some(true),
            (false, true) if self.ended[1] => Some(true),
            _ => None,
        }
    }

    fn settle_lines(&mut self) -> Option<bool> {
        let mut at = [0, 0];
        let differ = loop {
            let old = line_end(&self.held[0], at[0], &mut self.searched[0], self.ended[0]);
            let new = line_end(&self.held[1], at[1], &mut self.searched[1], self.ended[1]);
            match (old, new) {
                (Some(old), Some(new)) => {
                    let lines = [&self.held[0][at[0]..old], &self.held[1][at[1]..new]];
                    if key(&lines[0], &self.config) != key(&lines[1], &self.config) {
                        break Some(true);
                    }
                    at = [old, new];
                }
                (None, None) if self.ended == [true, true] => break Some(false),
                (None, Some(_)) if self.ended[0] => break Some(true),
                (Some(_), None) if self.ended[1] => break Some(true),
                _ => break None,
            }
        };
        for ((held, searched), at) in self.held.iter_mut().zip(&mut self.searched).zip(at) {
            held.drain(..at);
            *searched = searched.saturating_sub(at);
        }
        differ
    }
}

impl Stream for Brief {
    fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("use indexed inputs"))
    }
    fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.differ.is_none() {
            return Err(StreamError::new("diff needs both indexed inputs to end"));
        }
        Ok(())
    }
    fn wants(&self) -> Option<usize> {
        if self.differ.is_some() {
            return None;
        }
        let short = |index: usize| match self.lines {
            None => !self.ready(index),
            Some(false) => self.held[index].is_empty(),
            Some(true) => !self.held[index][self.searched[index]..].contains(&b'\n'),
        };
        (0..2).find(|index| !self.ended[*index] && short(*index))
    }
    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        _: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if index > 1 || self.ended[index] {
            return Err(StreamError::new("invalid or ended input"));
        }
        if self.differ.is_none() {
            self.held[index].extend_from_slice(input);
            self.settle();
        }
        Ok(())
    }
    fn end_input(&mut self, index: usize, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if index > 1 || self.ended[index] {
            return Err(StreamError::new("invalid or ended input"));
        }
        self.ended[index] = true;
        if self.differ.is_none() {
            self.settle();
        }
        Ok(())
    }
    fn status(&self) -> i32 {
        i32::from(self.differ == Some(true))
    }
    /// `{"outcome": "equal" | "different", "context": N}`.
    fn metadata(&self, out: &mut Vec<u8>) {
        let outcome = if self.differ == Some(true) {
            "different"
        } else {
            "equal"
        };
        let metadata = serde_json::json!({"outcome": outcome, "context": self.config.context});
        out.extend_from_slice(metadata.to_string().as_bytes());
    }
}

#[cfg(test)]
mod unified_tests {
    use serde_json::json;

    fn opened(typed: serde_json::Value) -> Result<String, (String, i32)> {
        let config = json!({ "unified": typed }).to_string();
        match crate::open("diff", config.as_bytes()) {
            Ok(stream) => {
                let mut out = Vec::new();
                stream.metadata(&mut out);
                Ok(String::from_utf8(out).expect("json"))
            }
            Err(e) => Err((e.message, e.status)),
        }
    }

    #[test]
    fn the_widest_context_typed_wins_and_a_bad_one_is_refused() {
        let context = |typed| {
            opened(typed).map(|m| {
                serde_json::from_str::<serde_json::Value>(&m).expect("json")["context"].clone()
            })
        };
        assert_eq!(context(json!([" +5", null, "1"])), Ok(json!(5)));
        assert_eq!(context(json!(["", "-0"])), Ok(json!(0)));
        assert_eq!(
            context(json!(["99999999999999999999999"])),
            Ok(json!(i64::MAX))
        );
        let hint = "\ndiff: Try 'diff --help' for more information.";
        for typed in ["x", "-1", "1 ", "0x1"] {
            let refused = opened(json!(["2", typed])).err();
            assert_eq!(
                refused,
                Some((format!("diff: invalid context length '{typed}'{hint}"), 2))
            );
        }
    }
}

#[cfg(test)]
mod brief_tests {
    use serde_json::{Value, json};

    /// Run `-q` over two inputs fed `chunk` bytes at a time as the stream
    /// asks: the outcome, the status and how much of each input it read.
    fn brief(options: Value, inputs: [&[u8]; 2], chunk: usize) -> (String, i32, [usize; 2]) {
        let mut config = json!({ "brief": true });
        config
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let mut stream = crate::open("diff", config.to_string().as_bytes()).unwrap();
        let mut fed = [0; 2];
        let mut ended = [false; 2];
        let mut out = Vec::new();
        while let Some(index) = stream.wants() {
            assert!(!ended[index]);
            if fed[index] == inputs[index].len() {
                stream.end_input(index, &mut out).unwrap();
                ended[index] = true;
            } else {
                let end = (fed[index] + chunk).min(inputs[index].len());
                stream
                    .feed_input(index, &inputs[index][fed[index]..end], &mut out)
                    .unwrap();
                fed[index] = end;
            }
        }
        stream.finish(&mut out).unwrap();
        assert!(out.is_empty() && !stream.busy());
        let mut metadata = Vec::new();
        stream.metadata(&mut metadata);
        let outcome: Value = serde_json::from_slice(&metadata).unwrap();
        (
            outcome["outcome"].as_str().unwrap().to_owned(),
            stream.status(),
            fed,
        )
    }

    #[test]
    fn bytes_decide_without_an_ignore_option() {
        let cases: [(&[u8], &[u8], &str); 6] = [
            (b"", b"", "equal"),
            (b"a\nb\n", b"a\nb\n", "equal"),
            (b"a\nb\n", b"a\nc\n", "different"),
            (b"a\nb\n", b"a\nb\nc\n", "different"),
            (b"a\nb\nc\n", b"a\nb\n", "different"),
            (b"a\0b\n", b"a\0c\n", "different"),
        ];
        for (old, new, outcome) in cases {
            for chunk in [1, 3, 64] {
                let (got, status, _) = brief(json!({}), [old, new], chunk);
                assert_eq!(
                    (got.as_str(), status),
                    (outcome, i32::from(outcome != "equal"))
                );
            }
        }
        // As diffutils 3.10 compares under -q, ed's output style aside.
        let ed = brief(json!({"mode": "ed"}), [b"a", b"a\n"], 1);
        assert_eq!((ed.0.as_str(), ed.1), ("different", 1));
    }

    #[test]
    fn a_long_line_is_searched_once_as_it_comes() {
        let old = [vec![b'a'; 1 << 21], b"\nb\n".to_vec()].concat();
        let new = old.to_ascii_uppercase();
        let (outcome, _, _) = brief(json!({"ignore_case": true}), [&old, &new], 16);
        assert_eq!(outcome, "equal");
    }

    #[test]
    fn a_difference_stops_reading_both_inputs() {
        let old = vec![b'x'; 1 << 20];
        let mut new = old.clone();
        new[100] = b'y';
        let (outcome, _, fed) = brief(json!({}), [&old, &new], 4096);
        assert_eq!(outcome, "different");
        assert_eq!(fed, [4096, 4096]);
        let longer = [old.as_slice(), b"z"].concat();
        let (outcome, _, fed) = brief(json!({}), [&old, &longer], 4096);
        assert_eq!(outcome, "different");
        assert_eq!(fed, [old.len(), old.len() + 1]);
    }

    #[test]
    fn ignore_options_compare_line_keys_once_neither_is_binary() {
        let cases: [(Value, &[u8], &[u8], &str); 8] = [
            (json!({"ignore_case": true}), b"A\nb\n", b"a\nB\n", "equal"),
            (json!({"ignore_case": true}), b"a", b"a\n", "different"),
            (
                json!({"ignore_all_space": true}),
                b"a b\n",
                b"ab\n",
                "equal",
            ),
            (json!({"ignore_all_space": true}), b"a", b"a\n", "equal"),
            (
                json!({"ignore_all_space": true}),
                b"a\n",
                b"a\n\n",
                "different",
            ),
            (
                json!({"ignore_space_change": true}),
                b"a b\n",
                b"a  b\n",
                "equal",
            ),
            (
                json!({"ignore_space_change": true}),
                b"a\n",
                b"a\nb\n",
                "different",
            ),
            (
                json!({"ignore_case": true}),
                b"A\0\n",
                b"a\0\n",
                "different",
            ),
        ];
        for (options, old, new, outcome) in cases {
            for chunk in [1, 2, 4096] {
                let (got, _, _) = brief(options.clone(), [old, new], chunk);
                assert_eq!(got, outcome, "{options} {old:?} {new:?} by {chunk}");
            }
        }
        let text = brief(
            json!({"ignore_case": true, "text": true}),
            [b"A\0\n", b"a\0\n"],
            1,
        );
        assert_eq!(text.0, "equal");
    }

    #[test]
    fn line_keys_hold_a_line_of_each_at_a_time() {
        let old: Vec<u8> = (0..20_000)
            .flat_map(|n| format!("Line {n}\n").into_bytes())
            .collect();
        let mut new = old.to_ascii_lowercase();
        let at = new.len() / 2;
        new[at] = b'#';
        let (outcome, _, fed) = brief(json!({"ignore_case": true}), [&old, &new], 4096);
        assert_eq!(outcome, "different");
        assert!(fed[0] < at + 2 * 4096 && fed[1] < at + 2 * 4096, "{fed:?}");
    }

    #[test]
    fn a_whole_diff_reads_one_input_then_the_other() {
        let mut stream = crate::open("diff", b"{}").unwrap();
        let mut out = Vec::new();
        assert_eq!(stream.wants(), Some(0));
        stream.feed_input(0, b"a\n", &mut out).unwrap();
        stream.end_input(0, &mut out).unwrap();
        assert_eq!(stream.wants(), Some(1));
        stream.end_input(1, &mut out).unwrap();
        assert_eq!(stream.wants(), None);
        assert_eq!(stream.status(), 1);
    }
}
