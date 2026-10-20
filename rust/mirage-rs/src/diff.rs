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
        output: Vec::new(),
        stderr: Vec::new(),
        cursor: 0,
        status: 0,
        equal: true,
    }))
}
struct Diff {
    config: Config,
    inputs: [Vec<u8>; 2],
    ended: [bool; 2],
    output: Vec<u8>,
    stderr: Vec<u8>,
    cursor: usize,
    status: i32,
    equal: bool,
}

fn key(line: &&[u8], config: &Config) -> Vec<u8> {
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
    out
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
fn line(out: &mut Vec<u8>, prefix: &[u8], value: &[u8], hint: bool) {
    out.extend_from_slice(prefix);
    out.extend_from_slice(value);
    if !value.ends_with(b"\n") {
        out.push(b'\n');
        if hint {
            out.extend_from_slice(b"\\ No newline at end of file\n");
        }
    }
}
fn render_normal(out: &mut Vec<u8>, ops: &[DiffOp], old: &[&[u8]], new: &[&[u8]]) {
    for op in ops {
        if op.tag() == DiffTag::Equal {
            continue;
        }
        let a = op.old_range();
        let b = op.new_range();
        let action = if a.is_empty() {
            'a'
        } else if b.is_empty() {
            'd'
        } else {
            'c'
        };
        out.extend_from_slice(
            format!("{}{}{}\n", address(a.clone()), action, address(b.clone())).as_bytes(),
        );
        for record in &old[a.clone()] {
            line(out, b"< ", record, true);
        }
        if !a.is_empty() && !b.is_empty() {
            out.extend_from_slice(b"---\n");
        }
        for record in &new[b] {
            line(out, b"> ", record, true);
        }
    }
}
fn render_unified(
    out: &mut Vec<u8>,
    ops: &[DiffOp],
    old: &[&[u8]],
    new: &[&[u8]],
    config: &Config,
) {
    let context = config
        .context
        .min(old.len().max(new.len()))
        .min(usize::MAX / 2);
    let groups = group_diff_ops(ops.to_vec(), context);
    if groups.is_empty() {
        return;
    }
    out.extend_from_slice(
        format!(
            "--- {}\n+++ {}\n",
            if config.old_header.is_empty() {
                &config.old_label
            } else {
                &config.old_header
            },
            if config.new_header.is_empty() {
                &config.new_label
            } else {
                &config.new_header
            }
        )
        .as_bytes(),
    );
    for group in groups {
        if group.is_empty() {
            continue;
        }
        out.extend_from_slice(format!("{}\n", UnifiedHunkHeader::new(&group)).as_bytes());
        for op in group {
            if op.tag() == DiffTag::Equal {
                for record in &old[op.old_range()] {
                    line(out, b" ", record, true);
                }
            } else {
                for record in &old[op.old_range()] {
                    line(out, b"-", record, true);
                }
                for record in &new[op.new_range()] {
                    line(out, b"+", record, true);
                }
            }
        }
    }
}
fn render_ed(out: &mut Vec<u8>, ops: &[DiffOp], new: &[&[u8]]) {
    for op in ops.iter().rev() {
        if op.tag() == DiffTag::Equal {
            continue;
        }
        let a = op.old_range();
        let b = op.new_range();
        let action = if a.is_empty() {
            'a'
        } else if b.is_empty() {
            'd'
        } else {
            'c'
        };
        out.extend_from_slice(format!("{}{}\n", address(a), action).as_bytes());
        if b.is_empty() {
            continue;
        }
        let records = &new[b];
        let mut ended = false;
        for (i, record) in records.iter().enumerate() {
            if *record == b".\n" || *record == b"." {
                out.extend_from_slice(b"..\n.\ns/.//\n");
                ended = true;
                if i + 1 < records.len() {
                    out.extend_from_slice(b"a\n");
                    ended = false;
                }
            } else {
                line(out, b"", record, false);
            }
        }
        if !ended {
            out.extend_from_slice(b".\n");
        }
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
                self.output.extend_from_slice(
                    format!(
                        "Binary files {} and {} differ\n",
                        self.config.old_label, self.config.new_label
                    )
                    .as_bytes(),
                );
            }
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
            return;
        }
        match self.config.mode {
            Mode::Normal => render_normal(&mut self.output, &ops, &old, &new),
            Mode::Unified => render_unified(&mut self.output, &ops, &old, &new, &self.config),
            Mode::Ed => render_ed(&mut self.output, &ops, &new),
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
        self.cursor < self.output.len()
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let end = self.cursor.saturating_add(65536).min(self.output.len());
        out.extend_from_slice(&self.output[self.cursor..end]);
        self.cursor = end;
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
