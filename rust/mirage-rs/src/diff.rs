use std::borrow::Cow;
use std::collections::VecDeque;
use std::ops::Range;

use crate::{Stream, StreamError};
use serde::Deserialize;
use similar::{
    Algorithm, DiffOp, DiffTag, capture_diff_slices, capture_diff_slices_by_key, group_diff_ops,
    udiff::UnifiedHunkHeader,
};

const BINARY_PROBE_BYTES: usize = 4096;

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

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = crate::parse_config(config)?;
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
            if !self.equal && !self.config.brief {
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
        if self.config.brief {
            self.equal = if normalize {
                old.len() == new.len()
                    && old
                        .iter()
                        .zip(&new)
                        .all(|(a, b)| key(a, &self.config) == key(b, &self.config))
            } else {
                old == new
            };
            self.status = if self.equal { 0 } else { 1 };
            self.release_inputs();
            return;
        }
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
    fn metadata(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(if self.equal {
            b"{\"outcome\":\"equal\"}"
        } else {
            b"{\"outcome\":\"different\"}"
        });
    }
    fn take_stderr(&mut self, out: &mut Vec<u8>) {
        out.append(&mut self.stderr);
    }
}
