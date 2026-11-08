use std::borrow::Cow;
use std::collections::VecDeque;
use std::ops::Range;

use crate::regex::{Options as RegexOptions, Regex, STEPS, Step, Syntax};
use crate::width::char_width;
use crate::{Stream, StreamError, number};
use serde::Deserialize;
use similar::{
    Algorithm, DiffOp, DiffTag, capture_diff_slices, capture_diff_slices_by_key, group_diff_ops,
    udiff::UnifiedHunkHeader,
};

const BINARY_PROBE_BYTES: usize = 4096;
const HINT: &[u8] = b"diff: Try 'diff --help' for more information.";
/// The widest `-W` mirage lays out: the reference takes any width and pads
/// every side-by-side row to half of it, so a wider one only writes blanks.
const WIDEST: usize = 1 << 16;
/// The bytes of a matched line a hunk header carries.
const FUNCTION_BYTES: usize = 40;
/// What `-p` looks for: a line that opens with a letter, `$` or `_`.
const C_FUNCTION: &[u8] = b"^[[:alpha:]$_]";

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Normal,
    Unified,
    Ed,
    Context,
    Rcs,
    Sides,
}
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    mode: Mode,
    #[serde(deserialize_with = "crate::saturating_usize")]
    context: usize,
    /// `-U`, `--unified`, `-C` and `--context` as typed, each value one
    /// character per byte and a bare long option null; when given, they set
    /// `context`.
    lengths: Option<Vec<Option<String>>>,
    ignore_case: bool,
    ignore_all_space: bool,
    ignore_space_change: bool,
    ignore_tab_expansion: bool,
    ignore_trailing_space: bool,
    strip_trailing_cr: bool,
    ignore_blank_lines: bool,
    /// `-I` patterns, one character per byte.
    ignore_lines: Vec<String>,
    /// `-F` patterns, one character per byte; `-p` is `show_c_function`.
    function_lines: Vec<String>,
    show_c_function: bool,
    expand_tabs: bool,
    initial_tab: bool,
    /// `-W` values as typed.
    widths: Vec<String>,
    suppress_common: bool,
    left_column: bool,
    text: bool,
    brief: bool,
    utf8: bool,
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
            lengths: None,
            ignore_case: false,
            ignore_all_space: false,
            ignore_space_change: false,
            ignore_tab_expansion: false,
            ignore_trailing_space: false,
            strip_trailing_cr: false,
            ignore_blank_lines: false,
            ignore_lines: Vec::new(),
            function_lines: Vec::new(),
            show_c_function: false,
            expand_tabs: false,
            initial_tab: false,
            widths: Vec::new(),
            suppress_common: false,
            left_column: false,
            text: false,
            brief: false,
            utf8: false,
            old_label: "a".into(),
            new_label: "b".into(),
            old_header: String::new(),
            new_header: String::new(),
        }
    }
}

fn refusal(parts: &[&[u8]]) -> StreamError {
    StreamError::refusal(&parts.concat(), 2)
}

fn typed_bytes(text: &str) -> Result<Vec<u8>, StreamError> {
    crate::latin1_bytes(text)
        .ok_or_else(|| StreamError::new("a diff value holds a character past U+00FF"))
}

/// The context the context and unified options give as diffutils 3.10
/// reads each one typed: a bare long option is 3, an empty value 0, and any
/// other a whole decimal past blanks with one sign, refused below 0, a value
/// past `intmax_t` the largest; the widest wins, and none is 3.
fn context_length(typed: &[Option<String>]) -> Result<usize, StreamError> {
    let mut widest = None;
    for text in typed {
        let context = match text {
            None => 3,
            Some(text) => {
                let raw = typed_bytes(text)?;
                let value = if raw.is_empty() {
                    Some(0)
                } else {
                    number::signed_decimal(&raw).filter(|&value| value >= 0)
                };
                let Some(value) = value else {
                    return Err(refusal(&[
                        b"diff: invalid context length '",
                        &raw,
                        b"'\n",
                        HINT,
                    ]));
                };
                usize::try_from(value.min(i128::from(i64::MAX))).unwrap_or(usize::MAX)
            }
        };
        widest = widest.max(Some(context));
    }
    Ok(widest.unwrap_or(3))
}

/// The `-W` width: each value typed a positive decimal, all of them one
/// width, 130 when none is typed.
fn output_width(typed: &[String]) -> Result<usize, StreamError> {
    let mut width = None;
    for text in typed {
        let raw = typed_bytes(text)?;
        let Some(value) = number::signed_decimal(&raw).filter(|&value| value > 0) else {
            return Err(refusal(&[b"diff: invalid width '", &raw, b"'\n", HINT]));
        };
        if width.is_some_and(|width| width != value) {
            return Err(refusal(&[b"diff: conflicting width options"]));
        }
        width = Some(value);
    }
    Ok(width.map_or(130, |width| {
        usize::try_from(width.min(WIDEST as i128)).unwrap_or(WIDEST)
    }))
}

/// Each pattern compiled as a basic expression, refused as the reference
/// refuses it: `diff: PATTERN: why`.
fn patterns(typed: &[String], utf8: bool) -> Result<Vec<Regex>, StreamError> {
    typed
        .iter()
        .map(|text| {
            let raw = typed_bytes(text)?;
            let options = RegexOptions {
                syntax: Syntax::Basic,
                ignore_case: false,
                utf8,
                word: false,
                line: false,
                terminator: b'\n',
                extents: false,
            };
            Regex::compile(std::slice::from_ref(&raw), &options)
                .map(|compiled| compiled.regex)
                .map_err(|why| refusal(&[b"diff: ", &raw, b": ", why.as_bytes()]))
        })
        .collect()
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let mut config: Config = crate::parse_config(config)?;
    if let Some(typed) = &config.lengths {
        config.context = context_length(typed)?;
    }
    let width = output_width(&config.widths)?;
    let ignore = patterns(&config.ignore_lines, config.utf8)?;
    let mut functions = patterns(&config.function_lines, config.utf8)?;
    if config.show_c_function {
        functions.extend(patterns(
            &[String::from_utf8_lossy(C_FUNCTION).into_owned()],
            config.utf8,
        )?);
    }
    // -B, -I and --strip-trailing-cr need the whole pair, so -q under one
    // of them takes the full diff and prints nothing.
    let whole = config.ignore_blank_lines || !ignore.is_empty() || config.strip_trailing_cr;
    if config.brief && !whole {
        let ignores = config.ignore_case
            || config.ignore_all_space
            || config.ignore_space_change
            || config.ignore_tab_expansion
            || config.ignore_trailing_space;
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
        layout: Layout::new(width),
        ignore,
        functions,
        found: None,
        scanned: 0,
        searching: None,
        pattern: 0,
        paused: false,
        marking: None,
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

/// The side-by-side columns for a width: where the right column starts,
/// how wide each one is, and where the gutter's mark goes, the mark centred
/// between the two and tabs counted at `tab` columns.
struct Layout {
    width: usize,
    half: usize,
    right: usize,
    mark: usize,
}
impl Layout {
    fn new(width: usize) -> Self {
        Self {
            width,
            half: 0,
            right: 0,
            mark: 0,
        }
    }

    fn with_tab(width: usize, tab: usize) -> Self {
        let offset = (width + tab + 3) / (2 * tab) * tab;
        let half = offset.saturating_sub(3).min(width.saturating_sub(offset));
        let right = if half > 0 { offset } else { width };
        Self {
            width,
            half,
            right,
            mark: (half + right).saturating_sub(1) / 2,
        }
    }
}

struct Diff {
    config: Config,
    layout: Layout,
    ignore: Vec<Regex>,
    functions: Vec<Regex>,
    /// The old line a hunk header last named, how far the search for one
    /// has read, and where a search that ran out of steps stopped.
    found: Option<usize>,
    scanned: usize,
    searching: Option<usize>,
    pattern: usize,
    /// Whether the last hunk has to wait for a search to resume.
    paused: bool,
    /// The pass over the changes `-B` and `-I` set aside, while it runs.
    marking: Option<Marking>,
    inputs: [Vec<u8>; 2],
    ended: [bool; 2],
    pieces: VecDeque<Piece>,
    records: [Vec<usize>; 2],
    groups: VecDeque<Vec<DiffOp>>,
    ops: VecDeque<(DiffOp, bool)>,
    stderr: Vec<u8>,
    status: i32,
    equal: bool,
}

/// How far `-B` and `-I` have read through a comparison's changes.
struct Marking {
    ops: Vec<DiffOp>,
    marked: Vec<(DiffOp, bool)>,
    at: usize,
    line: usize,
    pattern: usize,
}

/// How a printed line that lacks its newline ends: with the marker after a
/// newline, with a newline alone, or as it is.
#[derive(Clone, Copy, PartialEq)]
enum Ending {
    Marker,
    Newline,
    Bare,
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
        ending: Ending,
        ed: bool,
    },
    /// One side-by-side row per step: an operation's lines paired, the
    /// ignorable ones as if they were common.
    Sides {
        op: DiffOp,
        at: usize,
        ignorable: bool,
    },
}

fn is_white(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | 0x0b | 0x0c)
}

fn key<'a>(line: &&'a [u8], config: &Config) -> Cow<'a, [u8]> {
    if !config.ignore_case
        && !config.ignore_all_space
        && !config.ignore_space_change
        && !config.ignore_tab_expansion
        && !config.ignore_trailing_space
    {
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
    let expanded;
    if config.ignore_tab_expansion && !config.ignore_all_space && !config.ignore_space_change {
        expanded = {
            let mut bytes = Vec::with_capacity(line.len());
            for &byte in line {
                if byte == b'\t' {
                    bytes.resize((bytes.len() / 8 + 1) * 8, b' ');
                } else {
                    bytes.push(byte);
                }
            }
            bytes
        };
        line = &expanded;
    }
    let mut out = Vec::new();
    let mut spaces = false;
    for &byte in line {
        if is_white(byte) {
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
    let trailing =
        config.ignore_all_space || config.ignore_space_change || config.ignore_trailing_space;
    if config.ignore_trailing_space {
        let kept = out.iter().rposition(|b| !is_white(*b)).map_or(0, |i| i + 1);
        out.truncate(kept);
    }
    if newline && !trailing && config.mode != Mode::Ed {
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

/// A line's text as `-t` writes it: each tab spaced out to the next stop
/// of eight, counted from the text's start.
fn expanded(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for &byte in text {
        if byte == b'\t' {
            out.resize((out.len() / 8 + 1) * 8, b' ');
        } else {
            out.push(byte);
        }
    }
    out
}

/// Line `index` of `input`, its newline kept.
fn record<'a>(
    inputs: &'a [Vec<u8>; 2],
    records: &[Vec<usize>; 2],
    input: usize,
    index: usize,
) -> &'a [u8] {
    &inputs[input][records[input][index]..records[input][index + 1]]
}

/// Whether `-B` or `-I` set a line aside: blank once compared, or matched
/// by a pattern from `pattern` on, which holds its place when the search
/// runs out of steps.
fn ignorable_line(
    config: &Config,
    ignore: &mut [Regex],
    line: &[u8],
    pattern: &mut usize,
    budget: &mut u64,
) -> Step<bool> {
    let text = line.strip_suffix(b"\n").unwrap_or(line);
    if config.ignore_blank_lines && key(&text, config).is_empty() {
        return Step::Done(true);
    }
    while let Some(regex) = ignore.get_mut(*pattern) {
        match regex.matches(text, 0, text.len(), budget) {
            Step::Paused => return Step::Paused,
            Step::Done(true) => {
                *pattern = 0;
                return Step::Done(true);
            }
            Step::Done(false) => *pattern += 1,
        }
    }
    *pattern = 0;
    Step::Done(false)
}

impl Diff {
    fn line(&self, input: usize, index: usize) -> &[u8] {
        record(&self.inputs, &self.records, input, index)
    }

    /// The old line a hunk starting at `start` names: the last one before
    /// it that a pattern matches, read back to where the last search
    /// stopped, else the one found before. Paused when the steps run out,
    /// and the same call picks the search back up.
    fn function(&mut self, start: usize) -> Step<Option<Vec<u8>>> {
        let Self {
            functions,
            inputs,
            records,
            scanned,
            found,
            searching,
            pattern,
            ..
        } = self;
        if functions.is_empty() {
            return Step::Done(None);
        }
        let mut budget = STEPS;
        let mut index = searching.take().unwrap_or(start);
        'lines: while index > *scanned {
            let line = record(inputs, records, 0, index - 1);
            let text = line.strip_suffix(b"\n").unwrap_or(line);
            while let Some(regex) = functions.get_mut(*pattern) {
                match regex.matches(text, 0, text.len(), &mut budget) {
                    Step::Paused => {
                        *searching = Some(index);
                        return Step::Paused;
                    }
                    Step::Done(true) => {
                        *pattern = 0;
                        *found = Some(index - 1);
                        break 'lines;
                    }
                    Step::Done(false) => *pattern += 1,
                }
            }
            *pattern = 0;
            index -= 1;
        }
        *scanned = (*scanned).max(start);
        let Some(found) = *found else {
            return Step::Done(None);
        };
        let line = record(inputs, records, 0, found);
        let text = line.strip_suffix(b"\n").unwrap_or(line);
        let text = &text[..text.len().min(FUNCTION_BYTES)];
        let kept = text
            .iter()
            .rposition(|b| !b.is_ascii_whitespace())
            .map_or(0, |i| i + 1);
        Step::Done(Some(text[..kept].to_vec()))
    }

    fn compute(&mut self) {
        if self.config.strip_trailing_cr {
            for input in &mut self.inputs {
                let mut out = Vec::with_capacity(input.len());
                let mut at = 0;
                while at < input.len() {
                    let byte = input[at];
                    let ends = input.get(at + 1).is_none_or(|next| *next == b'\n');
                    if !(byte == b'\r' && ends) {
                        out.push(byte);
                    }
                    at += 1;
                }
                *input = out;
            }
        }
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
            || self.config.ignore_tab_expansion
            || self.config.ignore_trailing_space
            || self.config.mode == Mode::Ed;
        let filters = self.config.ignore_blank_lines || !self.config.ignore_lines.is_empty();
        let ops = if normalize {
            capture_diff_slices_by_key(Algorithm::Myers, &old, &new, |record| {
                key(record, &self.config)
            })
        } else {
            capture_diff_slices(Algorithm::Myers, &old, &new)
        };
        for (index, lines) in [&old, &new].into_iter().enumerate() {
            let mut offset = 0;
            self.records[index].push(0);
            for line in lines {
                offset += line.len();
                self.records[index].push(offset);
            }
        }
        if filters {
            self.marking = Some(Marking {
                marked: Vec::with_capacity(ops.len()),
                ops,
                at: 0,
                line: 0,
                pattern: 0,
            });
        } else {
            self.settle(ops.into_iter().map(|op| (op, false)).collect());
        }
    }

    /// Mark what `-B` and `-I` set aside, a bounded slice of pattern work
    /// at a time, and settle the comparison once every change is read.
    fn mark(&mut self) {
        let Some(mut marking) = self.marking.take() else {
            return;
        };
        let Diff {
            config,
            ignore,
            inputs,
            records,
            ..
        } = self;
        let mut budget = STEPS;
        while let Some(op) = marking.ops.get(marking.at).copied() {
            let (old, new) = (op.old_range(), op.new_range());
            let mut set_aside = op.tag() != DiffTag::Equal;
            while set_aside && marking.line < old.len() + new.len() {
                let (input, index) = if marking.line < old.len() {
                    (0, old.start + marking.line)
                } else {
                    (1, new.start + marking.line - old.len())
                };
                let line = record(inputs, records, input, index);
                match ignorable_line(config, ignore, line, &mut marking.pattern, &mut budget) {
                    Step::Paused => {
                        self.marking = Some(marking);
                        return;
                    }
                    Step::Done(true) => marking.line += 1,
                    Step::Done(false) => set_aside = false,
                }
            }
            marking.marked.push((op, set_aside));
            marking.at += 1;
            marking.line = 0;
        }
        self.settle(marking.marked);
    }

    /// What follows once every change is marked: the status, and the
    /// hunks left to print.
    fn settle(&mut self, marked: Vec<(DiffOp, bool)>) {
        self.equal = marked
            .iter()
            .all(|(op, ignorable)| op.tag() == DiffTag::Equal || *ignorable);
        self.status = if self.equal { 0 } else { 1 };
        if self.config.mode == Mode::Ed && !self.config.brief {
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
        if self.config.brief || (self.equal && self.config.mode != Mode::Sides) {
            self.release_inputs();
            return;
        }
        match self.config.mode {
            Mode::Unified | Mode::Context => {
                let lines = self.records[0].len().max(self.records[1].len()) - 1;
                let context = self.config.context.min(lines).min(usize::MAX / 2);
                let ignorable: std::collections::HashSet<(usize, usize)> = marked
                    .iter()
                    .filter(|(_, ignorable)| *ignorable)
                    .map(|(op, _)| (op.old_range().start, op.new_range().start))
                    .collect();
                let ops: Vec<DiffOp> = marked.into_iter().map(|(op, _)| op).collect();
                self.groups = group_diff_ops(ops, context)
                    .into_iter()
                    .filter(|group| {
                        group.iter().any(|op| {
                            op.tag() != DiffTag::Equal
                                && !ignorable
                                    .contains(&(op.old_range().start, op.new_range().start))
                        })
                    })
                    .collect();
                if !self.groups.is_empty() {
                    let (old_mark, new_mark): (&[u8], &[u8]) = if self.config.mode == Mode::Unified
                    {
                        (b"--- ", b"+++ ")
                    } else {
                        (b"*** ", b"--- ")
                    };
                    let named = |header: &String, label: &String| {
                        if header.is_empty() { label } else { header }.clone()
                    };
                    let lines = [
                        [
                            old_mark,
                            named(&self.config.old_header, &self.config.old_label).as_bytes(),
                        ]
                        .concat(),
                        [
                            new_mark,
                            named(&self.config.new_header, &self.config.new_label).as_bytes(),
                        ]
                        .concat(),
                    ];
                    for line in lines {
                        self.text([line, b"\n".to_vec()].concat());
                    }
                }
            }
            Mode::Normal | Mode::Rcs => {
                self.ops = marked
                    .into_iter()
                    .filter(|(op, ignorable)| op.tag() != DiffTag::Equal && !ignorable)
                    .collect()
            }
            Mode::Ed => {
                self.ops = marked
                    .into_iter()
                    .rev()
                    .filter(|(op, ignorable)| op.tag() != DiffTag::Equal && !ignorable)
                    .collect()
            }
            Mode::Sides => {
                self.layout = Layout::with_tab(
                    self.layout.width,
                    if self.config.expand_tabs { 1 } else { 8 },
                );
                self.ops = marked.into();
            }
        }
    }

    fn release_inputs(&mut self) {
        self.inputs = [Vec::new(), Vec::new()];
        self.records = [Vec::new(), Vec::new()];
    }

    fn text(&mut self, bytes: impl Into<Cow<'static, [u8]>>) {
        self.pieces.push_back(Piece::Text(bytes.into(), 0));
    }

    fn rows(&mut self, input: usize, lines: Range<usize>, prefix: &'static [u8], ending: Ending) {
        if !lines.is_empty() {
            self.pieces.push_back(Piece::Rows {
                input,
                lines,
                prefix,
                ending,
                ed: false,
            });
        }
    }

    /// The prefix a line takes, `-T` turning the space that ends it into a
    /// tab (a unified context line's lone space becoming the tab).
    fn prefix(&self, plain: &'static [u8]) -> &'static [u8] {
        if !self.config.initial_tab {
            return plain;
        }
        match plain {
            b"< " => b"<\t",
            b"> " => b">\t",
            b" " => b"\t",
            b"-" => b"-\t",
            b"+" => b"+\t",
            b"  " => b" \t",
            b"- " => b"-\t",
            b"+ " => b"+\t",
            b"! " => b"!\t",
            other => other,
        }
    }

    fn prepare(&mut self) {
        if self.ops.is_empty() {
            if let Some(start) = self.groups.front().map(|group| group[0].old_range().start) {
                let Step::Done(function) = self.function(start) else {
                    self.paused = true;
                    return;
                };
                let group = self.groups.pop_front().expect("a group is queued");
                let suffix = function.map(|text| [b" ".as_slice(), &text].concat());
                if self.config.mode == Mode::Context {
                    self.context_hunk(&group, suffix.unwrap_or_default());
                    return;
                }
                let header = format!("{}", UnifiedHunkHeader::new(&group)).into_bytes();
                self.text([header, suffix.unwrap_or_default(), b"\n".to_vec()].concat());
                self.ops = group.into_iter().map(|op| (op, false)).collect();
                return;
            }
        }
        let Some((op, ignorable)) = self.ops.pop_front() else {
            return;
        };
        if self.config.mode == Mode::Sides {
            self.pieces.push_back(Piece::Sides {
                op,
                at: 0,
                ignorable,
            });
            return;
        }
        let a = op.old_range();
        let b = op.new_range();
        if self.config.mode == Mode::Unified {
            if op.tag() == DiffTag::Equal {
                self.rows(0, a, self.prefix(b" "), Ending::Marker);
            } else {
                self.rows(0, a, self.prefix(b"-"), Ending::Marker);
                self.rows(1, b, self.prefix(b"+"), Ending::Marker);
            }
            return;
        }
        if self.config.mode == Mode::Rcs {
            if !a.is_empty() {
                self.text(format!("d{} {}\n", a.start + 1, a.len()).into_bytes());
            }
            if !b.is_empty() {
                self.text(format!("a{} {}\n", a.end, b.len()).into_bytes());
                self.rows(1, b, b"", Ending::Bare);
            }
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
            self.rows(0, a, self.prefix(b"< "), Ending::Marker);
            if both {
                self.text(b"---\n".as_slice());
            }
            self.rows(1, b, self.prefix(b"> "), Ending::Marker);
        } else {
            self.text(format!("{}{}\n", address(a), action).into_bytes());
            if !b.is_empty() {
                let last = self.line(1, b.end - 1);
                let dot = last == b".\n" || last == b".";
                self.pieces.push_back(Piece::Rows {
                    input: 1,
                    lines: b,
                    prefix: b"",
                    ending: Ending::Newline,
                    ed: true,
                });
                if !dot {
                    self.text(b".\n".as_slice());
                }
            }
        }
    }

    /// One hunk in the context format: the old range and its lines when the
    /// hunk takes any out, then the new range and its lines when it puts
    /// any in, a changed line marked `!` on both sides.
    fn context_hunk(&mut self, group: &[DiffOp], suffix: Vec<u8>) {
        let start = |op: &DiffOp, old: bool| {
            if old {
                op.old_range().start
            } else {
                op.new_range().start
            }
        };
        let end = |op: &DiffOp, old: bool| {
            if old {
                op.old_range().end
            } else {
                op.new_range().end
            }
        };
        self.text([b"***************".as_slice(), &suffix, b"\n"].concat());
        for (old, mark, tail) in [
            (true, b"*** ".as_slice(), b" ****".as_slice()),
            (false, b"--- ".as_slice(), b" ----".as_slice()),
        ] {
            let first = group.first().map_or(0, |op| start(op, old));
            let last = group.last().map_or(0, |op| end(op, old));
            let range = address(first..last);
            self.text([mark, range.as_bytes(), tail, b"\n"].concat());
            let changed = group.iter().any(|op| match op.tag() {
                DiffTag::Equal => false,
                DiffTag::Delete => old,
                DiffTag::Insert => !old,
                DiffTag::Replace => true,
            });
            if !changed {
                continue;
            }
            for op in group {
                let prefix: &'static [u8] = match op.tag() {
                    DiffTag::Equal => b"  ",
                    DiffTag::Delete => b"- ",
                    DiffTag::Insert => b"+ ",
                    DiffTag::Replace => b"! ",
                };
                let lines = if old { op.old_range() } else { op.new_range() };
                self.rows(
                    usize::from(!old),
                    lines,
                    self.prefix(prefix),
                    Ending::Marker,
                );
            }
        }
    }

    /// The text of one half of a side-by-side row from column `from`, as
    /// much as fits by `to`; trailing blanks are left to the padding. The
    /// column it ends at.
    fn half(&self, text: &[u8], from: usize, to: usize, out: &mut Vec<u8>) -> usize {
        let mut column = from;
        let mut written = out.len();
        let mut end = from;
        // Read as the column fills, so a long line costs only what is shown.
        let units: Box<dyn Iterator<Item = (u32, &[u8])> + '_> = if self.config.utf8 {
            Box::new(text.utf8_chunks().flat_map(|chunk| {
                let valid = chunk.valid();
                valid
                    .char_indices()
                    .map(move |(at, c)| (u32::from(c), &valid.as_bytes()[at..at + c.len_utf8()]))
                    .chain(chunk.invalid().chunks(1).map(|byte| (0x80, byte)))
            }))
        } else {
            Box::new(text.chunks(1).map(|byte| (u32::from(byte[0]), byte)))
        };
        for (cp, bytes) in units {
            if cp == u32::from(b'\t') {
                let next = from + ((column - from) / 8 + 1) * 8;
                if next > to {
                    break;
                }
                if self.config.expand_tabs {
                    out.resize(out.len() + (next - column), b' ');
                } else {
                    out.push(b'\t');
                }
                column = next;
                continue;
            }
            let width = if cp >= 0x80 && !self.config.utf8 {
                0
            } else {
                char_width(cp) as usize
            };
            if column + width > to {
                break;
            }
            out.extend_from_slice(bytes);
            column += width;
            if !(cp == u32::from(b' ') || cp == 0x0b || cp == 0x0c || cp == u32::from(b'\r')) {
                written = out.len();
                end = column;
            }
        }
        out.truncate(written);
        end
    }

    /// Padding from column `from` to `to`: tabs to each stop on the way,
    /// then blanks; blanks alone under `-t`.
    fn pad(&self, from: usize, to: usize, out: &mut Vec<u8>) {
        let mut column = from;
        if !self.config.expand_tabs {
            while (column / 8 + 1) * 8 <= to {
                out.push(b'\t');
                column = (column / 8 + 1) * 8;
            }
        }
        out.resize(out.len() + to.saturating_sub(column), b' ');
    }

    /// One side-by-side row: the old line, the gutter's mark and the new
    /// line, either one absent; it ends with a newline when either line
    /// has one.
    fn side_row(&self, left: Option<&[u8]>, mark: u8, right: Option<&[u8]>) -> Vec<u8> {
        let layout = &self.layout;
        let mut out = Vec::new();
        let strip = |line: &[u8]| line.strip_suffix(b"\n").unwrap_or(line).to_vec();
        let mut column = 0;
        if let Some(line) = left {
            column = self.half(&strip(line), 0, layout.half, &mut out);
        }
        if mark == b' ' && self.config.left_column {
            self.pad(column, layout.mark, &mut out);
            out.push(b'(');
            if left.is_some_and(|line| line.ends_with(b"\n")) {
                out.push(b'\n');
            }
            return out;
        }
        if mark != b' ' {
            self.pad(column, layout.mark, &mut out);
            out.push(mark);
            column = layout.mark + 1;
        }
        let right_text = right.map(strip).filter(|text| !text.is_empty());
        if let Some(text) = right_text {
            self.pad(column, layout.right, &mut out);
            self.half(&text, layout.right, layout.right + layout.half, &mut out);
        }
        if [left, right]
            .into_iter()
            .flatten()
            .any(|line| line.ends_with(b"\n"))
        {
            out.push(b'\n');
        }
        out
    }

    /// The next row of a side-by-side operation, None once it has none.
    fn side(&self, op: &DiffOp, at: usize, ignorable: bool) -> Option<Vec<u8>> {
        let a = op.old_range();
        let b = op.new_range();
        let left = (at < a.len()).then(|| self.line(0, a.start + at));
        let right = (at < b.len()).then(|| self.line(1, b.start + at));
        if left.is_none() && right.is_none() {
            return None;
        }
        let common = op.tag() == DiffTag::Equal || ignorable;
        if common && self.config.suppress_common {
            return Some(Vec::new());
        }
        let mark = match (left, right) {
            (Some(_), Some(_)) if common => b' ',
            (Some(l), Some(r)) => match (l.ends_with(b"\n"), r.ends_with(b"\n")) {
                (false, true) => b'\\',
                (true, false) => b'/',
                _ => b'|',
            },
            (Some(_), None) if common => b'(',
            (None, Some(_)) if common => b')',
            (Some(_), None) => b'<',
            _ => b'>',
        };
        Some(self.side_row(left, mark, right))
    }

    fn render(&mut self, out: &mut Vec<u8>) {
        let end = out.len() + 65536;
        let mut steps = 0;
        while out.len() < end && self.busy() && steps < 4096 {
            steps += 1;
            let Some(piece) = self.pieces.pop_front() else {
                self.prepare();
                if std::mem::take(&mut self.paused) {
                    return;
                }
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
                Piece::Sides { op, at, ignorable } => {
                    if let Some(row) = self.side(&op, at, ignorable) {
                        self.pieces.push_front(Piece::Sides {
                            op,
                            at: at + 1,
                            ignorable,
                        });
                        if !row.is_empty() {
                            self.pieces.push_front(Piece::Text(row.into(), 0));
                        }
                    }
                }
                Piece::Rows {
                    input,
                    mut lines,
                    prefix,
                    ending,
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
                            ending,
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
                        continue;
                    }
                    let newline = value.ends_with(b"\n");
                    let tail: &'static [u8] = match (newline, ending) {
                        (true, _) => b"\n",
                        (false, Ending::Marker) => b"\n\\ No newline at end of file\n",
                        (false, Ending::Newline) => b"\n",
                        (false, Ending::Bare) => b"",
                    };
                    self.pieces.push_front(Piece::Text(tail.into(), 0));
                    let text = bytes.start..bytes.end - usize::from(newline);
                    if self.config.expand_tabs {
                        let wide = expanded(&self.inputs[input][text]);
                        self.pieces.push_front(Piece::Text(wide.into(), 0));
                    } else {
                        self.pieces.push_front(Piece::Range { input, bytes: text });
                    }
                    if !prefix.is_empty() {
                        self.pieces.push_front(Piece::Text(prefix.into(), 0));
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
        self.marking.is_some()
            || !self.pieces.is_empty()
            || !self.ops.is_empty()
            || !self.groups.is_empty()
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.mark();
        if self.marking.is_none() {
            self.render(out);
        }
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
        let config = json!({ "lengths": typed }).to_string();
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
