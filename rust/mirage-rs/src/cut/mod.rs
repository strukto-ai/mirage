mod options;

use std::collections::VecDeque;

use memchr::memchr;
use serde::Deserialize;

use crate::{Stream, StreamError, parse_config, quoted};

const WORK: usize = 16384;
/// The block a long hold sets aside at a time.
#[cfg(not(test))]
const PARK: usize = 64 * 1024;
#[cfg(test)]
const PARK: usize = 4096;

/// The most of a record cut holds while a decision waits on the rest of
/// it: past it the run fails as the real one does once memory runs out.
#[cfg(not(test))]
const MAX_HELD: usize = 1 << 30;
#[cfg(test)]
const MAX_HELD: usize = 1 << 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Bytes,
    Characters,
    Fields,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Whitespace {
    Default,
    Trimmed,
}

/// cut's options as typed, `[name, text]` in typed order (`options::Typed`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    options: Vec<options::Typed>,
}

struct Options {
    mode: Mode,
    delimiter: Option<char>,
    complement: bool,
    only_delimited: bool,
    whitespace: Option<Whitespace>,
    no_partial: bool,
    output_delimiter: Vec<u8>,
    separator: u8,
}

impl Options {
    /// Whether an ASCII byte ends a field.
    fn ends_field(&self, byte: u8) -> bool {
        match self.whitespace {
            Some(_) => matches!(byte, b' ' | b'\t'),
            None => self.delimiter == Some(char::from(byte)),
        }
    }

    fn fast_record(&self, bytes: &[u8], ranges: &[Interval], out: &mut Vec<u8>) -> bool {
        let mut selection = Selection::default();
        let mut emitted = false;
        if self.mode == Mode::Fields {
            let Some(delimiter) = self.delimiter.filter(char::is_ascii) else {
                return false;
            };
            if self.whitespace.is_some() {
                return false;
            }
            let delimiter = delimiter as u8;
            if !bytes.contains(&delimiter) {
                if !self.only_delimited {
                    out.extend_from_slice(bytes);
                    out.push(self.separator);
                }
                return true;
            }
            if std::str::from_utf8(bytes).is_err() {
                return false;
            }
            let mut start = 0;
            for (field, end) in memchr::memchr_iter(delimiter, bytes)
                .chain(std::iter::once(bytes.len()))
                .enumerate()
            {
                if selection.contains(field as u64 + 1, ranges, self.complement) {
                    if emitted {
                        out.extend_from_slice(&self.output_delimiter);
                    }
                    out.extend_from_slice(&bytes[start..end]);
                    emitted = true;
                }
                start = end + 1;
            }
        } else {
            if !(self.mode == Mode::Bytes && !self.no_partial || bytes.is_ascii()) {
                return false;
            }
            let mut start = None;
            for position in 0..=bytes.len() {
                let selected = position < bytes.len()
                    && selection.contains(position as u64 + 1, ranges, self.complement);
                if selected && start.is_none() {
                    start = Some(position);
                }
                if !selected {
                    if let Some(from) = start.take() {
                        if emitted {
                            out.extend_from_slice(&self.output_delimiter);
                        }
                        out.extend_from_slice(&bytes[from..position]);
                        emitted = true;
                    }
                }
            }
        }
        out.push(self.separator);
        true
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Interval {
    pub(crate) first: u64,
    pub(crate) last: u64,
}

struct Words<'a> {
    program: &'a str,
    value: &'static str,
    range: &'static str,
    zero: &'static str,
    large: &'static str,
}

impl Words<'_> {
    fn refusal(&self, message: impl AsRef<str>) -> StreamError {
        let program = self.program;
        StreamError::new(format!(
            "{program}: {}\nTry '{program} --help' for more information.",
            message.as_ref()
        ))
    }
}

fn bound(spec: &[u8], cursor: &mut usize, words: &Words) -> Result<Option<u64>, StreamError> {
    let start = *cursor;
    let mut value = Some(0_u64);
    while let Some(byte @ b'0'..=b'9') = spec.get(*cursor) {
        value = value
            .and_then(|n| n.checked_mul(10))
            .and_then(|n| n.checked_add(u64::from(byte - b'0')))
            .filter(|n| *n < u64::MAX);
        *cursor += 1;
    }
    if *cursor == start {
        return Ok(None);
    }
    value.map(Some).ok_or_else(|| {
        words.refusal(format!(
            "{} '{}' is too large",
            words.large,
            quoted(&spec[start..*cursor])
        ))
    })
}

/// GNU's list of fields or positions, in the words of `program` (cut, or
/// numfmt's --field), its ranges sorted and merged.
pub(crate) fn intervals(
    spec: &[u8],
    mode: Mode,
    program: &str,
) -> Result<Vec<Interval>, StreamError> {
    let words = if mode == Mode::Fields {
        Words {
            program,
            value: "invalid field value",
            range: "invalid field range",
            zero: "fields are numbered from 1",
            large: "field number",
        }
    } else {
        Words {
            program,
            value: "invalid byte/character position",
            range: "invalid byte or character range",
            zero: "byte/character positions are numbered from 1",
            large: "byte/character offset",
        }
    };
    let mut cursor = 0;
    let mut ranges = Vec::new();
    loop {
        let low = bound(spec, &mut cursor, &words)?;
        let is_range = spec.get(cursor) == Some(&b'-');
        let mut high = None;
        if is_range {
            if low == Some(0) {
                return Err(words.refusal(words.zero));
            }
            cursor += 1;
            high = bound(spec, &mut cursor, &words)?;
            if spec.get(cursor) == Some(&b'-') {
                return Err(words.refusal(words.range));
            }
        }
        if spec
            .get(cursor)
            .is_some_and(|byte| !matches!(byte, b',' | b' ' | b'\t'))
        {
            return Err(words.refusal(format!("{} '{}'", words.value, quoted(&spec[cursor..]))));
        }
        let first = if is_range {
            if low.is_none() && high.is_none() {
                return Err(words.refusal("invalid range with no endpoint: -"));
            }
            low.unwrap_or(1)
        } else {
            match low {
                None | Some(0) => return Err(words.refusal(words.zero)),
                Some(n) => n,
            }
        };
        let last = if is_range {
            high.unwrap_or(u64::MAX)
        } else {
            first
        };
        if last < first {
            return Err(words.refusal("invalid decreasing range"));
        }
        ranges.push(Interval { first, last });
        if cursor == spec.len() {
            break;
        }
        cursor += 1;
    }
    ranges.sort_unstable_by_key(|range| range.first);
    let mut merged: Vec<Interval> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(previous) if range.first <= previous.last.saturating_add(1) => {
                previous.last = previous.last.max(range.last);
            }
            _ => merged.push(range),
        }
    }
    Ok(merged)
}

#[derive(Default)]
struct Selection {
    interval: usize,
}

impl Selection {
    fn contains(&mut self, position: u64, ranges: &[Interval], complement: bool) -> bool {
        while self.interval < ranges.len() && ranges[self.interval].last < position {
            self.interval += 1;
        }
        let selected = ranges
            .get(self.interval)
            .is_some_and(|range| range.first <= position);
        selected != complement
    }

    /// Whether no position from here on is selected.
    fn exhausted(&self, ranges: &[Interval], complement: bool) -> bool {
        !complement && self.interval == ranges.len()
    }

    /// The last position `contains` answers as it did for `position`,
    /// the position it was just asked.
    fn run_end(&self, position: u64, ranges: &[Interval]) -> u64 {
        match ranges.get(self.interval) {
            Some(range) if range.first <= position => range.last,
            Some(range) => range.first - 1,
            None => u64::MAX,
        }
    }
}

/// The character at the start of `bytes` as cut decodes a record, a byte
/// no UTF-8 starts being U+FFFD on its own; None while the rest of it is
/// still to come.
fn unit(bytes: &[u8], complete: bool) -> Option<(char, usize)> {
    let first = *bytes.first()?;
    let width = match first {
        0..=0x7f => return Some((char::from(first), 1)),
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return Some(('\u{fffd}', 1)),
    };
    if bytes.len() < width && !complete {
        return None;
    }
    Some(crate::utf8::scalar(&bytes[..width.min(bytes.len())]))
}

/// Where the first delimiter of `bytes` is, and how far a search that
/// found none got: up to a character still to come.
fn find_delimiter(bytes: &[u8], options: &Options, complete: bool) -> (Option<usize>, usize) {
    let found = match (options.whitespace, options.delimiter) {
        (Some(_), _) => memchr::memchr2(b' ', b'\t', bytes),
        (None, Some(ch)) if ch.is_ascii() => memchr(ch as u8, bytes),
        (None, None) => None,
        (None, Some(delimiter)) => {
            let mut at = 0;
            while let Some((ch, len)) = unit(&bytes[at..], complete) {
                if ch == delimiter {
                    return (Some(at), at);
                }
                at += len;
            }
            return (None, at);
        }
    };
    (found, found.unwrap_or(bytes.len()))
}

enum Pending {
    None,
    Delimiter(usize),
    Encoded {
        bytes: [u8; 4],
        cursor: usize,
        end: usize,
    },
}

impl Pending {
    fn encoded(raw: &[u8]) -> Self {
        let mut bytes = [0; 4];
        bytes[..raw.len()].copy_from_slice(raw);
        Self::Encoded {
            bytes,
            cursor: 0,
            end: raw.len(),
        }
    }

    fn character(ch: char) -> Self {
        Self::encoded(ch.encode_utf8(&mut [0; 4]).as_bytes())
    }
}

/// What a record has selected and not yet written: an output delimiter,
/// then the piece after it.
struct Output {
    pending: Pending,
    after_delimiter: Pending,
}

impl Output {
    fn emit(&mut self, piece: Pending, separated: bool, options: &Options) {
        if separated && !options.output_delimiter.is_empty() {
            self.pending = Pending::Delimiter(0);
            self.after_delimiter = piece;
        } else {
            self.pending = piece;
        }
    }

    /// Write what is pending within `work`; false when nothing was.
    fn flush(&mut self, options: &Options, out: &mut Vec<u8>, work: &mut usize) -> bool {
        match &mut self.pending {
            Pending::Delimiter(cursor) => {
                let len = (*work).min(options.output_delimiter.len() - *cursor);
                out.extend_from_slice(&options.output_delimiter[*cursor..*cursor + len]);
                *cursor += len;
                *work -= len;
                if *cursor == options.output_delimiter.len() {
                    self.pending = std::mem::replace(&mut self.after_delimiter, Pending::None);
                }
            }
            Pending::Encoded { bytes, cursor, end } => {
                let len = (*work).min(*end - *cursor);
                out.extend_from_slice(&bytes[*cursor..*cursor + len]);
                *cursor += len;
                *work -= len;
                if *cursor == *end {
                    self.pending = Pending::None;
                }
            }
            Pending::None => return false,
        }
        true
    }
}

/// Where -f is in a record.
struct Fields {
    position: u64,
    selection: Selection,
    started: bool,
    selected: bool,
    emitted: bool,
    /// A run of blanks is pending: it ends the field once a non-blank
    /// follows, and a trimmed record drops it at its end.
    blanks: bool,
    /// A trimmed record has shown no non-blank yet.
    leading: bool,
    delimited: bool,
    /// The record is held from its unread part on, searched `scan` bytes
    /// so far, until a delimiter or its end shows how it is cut.
    hold: bool,
    scan: usize,
}

enum Stage {
    /// -b or -c: `offset` counts the bytes or characters before the next
    /// one, `consumed` the record bytes read; a -b -n offset counts each
    /// character as it is written, so it can run ahead of them.
    Positions {
        offset: usize,
        consumed: usize,
        previous_end: Option<usize>,
        selection: Selection,
    },
    Fields(Fields),
    /// An undelimited record goes out as read.
    Pass,
    Terminator,
    Done,
}

enum Progress {
    Done,
    Hungry,
    Spent,
}

/// The bytes of a record read and not yet cut. A long hold sets them
/// aside a block at a time, so it grows without copying what it holds.
struct Held {
    bytes: Vec<u8>,
    at: usize,
    /// The record's last byte has been taken.
    complete: bool,
    parked: VecDeque<Vec<u8>>,
    parked_len: usize,
}

impl Held {
    fn take(&mut self, bytes: &[u8], complete: bool) -> Result<(), StreamError> {
        if self.parked_len + self.bytes.len() - self.at + bytes.len() > MAX_HELD {
            return Err(StreamError::refusal(b"cut: memory exhausted", 1));
        }
        if self.at * 2 >= self.bytes.len() {
            self.bytes.drain(..self.at);
            self.at = 0;
            crate::release_capacity(&mut self.bytes);
        }
        self.bytes.extend_from_slice(bytes);
        self.complete = complete;
        Ok(())
    }

    /// Whether every byte of the record is in `bytes`.
    fn ended(&self) -> bool {
        self.complete && self.parked.is_empty()
    }

    fn park(&mut self) {
        let mut block = std::mem::replace(&mut self.bytes, Vec::with_capacity(PARK + WORK));
        block.drain(..self.at);
        self.at = 0;
        self.parked_len += block.len();
        self.parked.push_back(block);
    }

    fn unpark(&mut self) {
        let Some(block) = self.parked.pop_front() else {
            return;
        };
        self.parked_len -= block.len();
        if self.at == self.bytes.len() {
            self.bytes = block;
        } else {
            self.bytes.drain(..self.at);
            self.bytes.extend_from_slice(&block);
        }
        self.at = 0;
    }
}

/// A record too long for the fast path, cut as its bytes arrive. It holds
/// only what a decision still waits on: the rest of a character, the
/// bytes a -b -n offset ran ahead to, or, for -f, a first field until a
/// delimiter or the record's end shows whether the line is delimited.
struct Line {
    held: Held,
    stage: Stage,
    output: Output,
}

impl Line {
    fn new(options: &Options, ranges: &[Interval]) -> Self {
        let stage = if options.mode == Mode::Fields {
            // The first field waits when its fate turns on whether the
            // line is delimited: unselected without -s, it is the whole
            // undelimited line; selected under -s, it goes only if one
            // comes.
            let first = Selection::default().contains(1, ranges, options.complement);
            Stage::Fields(Fields {
                position: 1,
                selection: Selection::default(),
                started: false,
                selected: false,
                emitted: false,
                blanks: false,
                leading: options.whitespace == Some(Whitespace::Trimmed),
                delimited: false,
                hold: first == options.only_delimited,
                scan: 0,
            })
        } else {
            Stage::Positions {
                offset: 0,
                consumed: 0,
                previous_end: None,
                selection: Selection::default(),
            }
        };
        Self {
            held: Held {
                bytes: Vec::new(),
                at: 0,
                complete: false,
                parked: VecDeque::new(),
                parked_len: 0,
            },
            stage,
            output: Output {
                pending: Pending::None,
                after_delimiter: Pending::None,
            },
        }
    }

    fn step(
        &mut self,
        options: &Options,
        ranges: &[Interval],
        out: &mut Vec<u8>,
        work: &mut usize,
    ) -> Progress {
        while *work > 0 {
            if self.output.flush(options, out, work) {
                continue;
            }
            *work -= 1;
            let holding = matches!(&self.stage, Stage::Fields(fields) if fields.hold);
            // Less than a character left: what was set aside comes next.
            if self.held.bytes.len() - self.held.at < 4 && !holding {
                self.held.unpark();
            }
            // A hold reads the newest bytes; anything else reads what was
            // set aside first.
            let complete = if holding {
                self.held.complete
            } else {
                self.held.ended()
            };
            let rest = &self.held.bytes[self.held.at..];
            let window = &rest[..rest.len().min(*work + 1)];
            match &mut self.stage {
                Stage::Positions {
                    offset,
                    consumed,
                    previous_end,
                    selection,
                } => {
                    if !rest.is_empty() && selection.exhausted(ranges, options.complement) {
                        self.held.at = self.held.bytes.len();
                        continue;
                    }
                    if rest.is_empty() {
                        if !complete {
                            return Progress::Hungry;
                        }
                        self.stage = Stage::Terminator;
                        continue;
                    }
                    // A run of bytes that are one position each, all
                    // selected or all not, goes at once.
                    let run = if options.mode == Mode::Bytes && !options.no_partial {
                        window.len()
                    } else if options.mode == Mode::Characters || *offset == *consumed {
                        window
                            .iter()
                            .position(|byte| !byte.is_ascii())
                            .unwrap_or(window.len())
                    } else {
                        0
                    };
                    let position = *offset as u64 + 1;
                    let selected = selection.contains(position, ranges, options.complement);
                    if run > 0 && (!selected || previous_end.is_none_or(|end| end == *offset)) {
                        let same = selection.run_end(position, ranges) - position + 1;
                        let len = run.min(usize::try_from(same).unwrap_or(usize::MAX));
                        if selected {
                            out.extend_from_slice(&rest[..len]);
                            *previous_end = Some(*offset + len);
                        }
                        self.held.at += len;
                        *offset += len;
                        *consumed += len;
                        *work -= len - 1;
                        continue;
                    }
                    let start = *offset;
                    let piece = if options.mode == Mode::Bytes && !options.no_partial {
                        self.held.at += 1;
                        *offset += 1;
                        Pending::encoded(&rest[..1])
                    } else {
                        let Some((ch, len)) = unit(rest, complete) else {
                            return Progress::Hungry;
                        };
                        if options.mode == Mode::Characters {
                            self.held.at += len;
                            *offset += 1;
                            Pending::character(ch)
                        } else {
                            let end = *offset + ch.len_utf8();
                            if rest.len() < end - *consumed && !complete {
                                return Progress::Hungry;
                            }
                            let piece = rest.get(start - *consumed..end - *consumed);
                            let piece = piece.map(Pending::encoded);
                            self.held.at += len;
                            *consumed += len;
                            *offset = end;
                            // A piece past the record's end is never written.
                            let Some(piece) = piece else {
                                continue;
                            };
                            piece
                        }
                    };
                    if selection.contains(*offset as u64, ranges, options.complement) {
                        let separated = previous_end.is_some_and(|previous| previous != start);
                        *previous_end = Some(*offset);
                        self.output.emit(piece, separated, options);
                    }
                }
                Stage::Fields(fields) if fields.hold => {
                    let end = rest.len().min(fields.scan + *work + 1);
                    let whole = end == rest.len();
                    let (found, scanned) =
                        find_delimiter(&rest[fields.scan..end], options, complete && whole);
                    *work = work.saturating_sub(scanned);
                    let resolved = if found.is_some() {
                        fields.hold = false;
                        fields.delimited = true;
                        true
                    } else {
                        fields.scan += scanned;
                        if fields.scan < rest.len() {
                            if whole && !complete {
                                return Progress::Hungry;
                            }
                            continue;
                        }
                        if !complete {
                            if rest.len() >= PARK {
                                self.held.park();
                                fields.scan = 0;
                            }
                            return Progress::Hungry;
                        }
                        self.stage = if options.only_delimited {
                            Stage::Done
                        } else {
                            Stage::Pass
                        };
                        true
                    };
                    // What was set aside comes back before what is held.
                    if resolved && !self.held.parked.is_empty() {
                        self.held.park();
                    }
                }
                Stage::Fields(fields) => {
                    let blank = match rest.first() {
                        None if !complete => return Progress::Hungry,
                        first => first.is_some_and(|byte| matches!(byte, b' ' | b'\t')),
                    };
                    if fields.leading && !rest.is_empty() {
                        if blank {
                            self.held.at += 1;
                            fields.delimited = true;
                            continue;
                        }
                        fields.leading = false;
                    }
                    if fields.blanks {
                        if blank {
                            self.held.at += 1;
                            continue;
                        }
                        fields.blanks = false;
                        if !rest.is_empty() || options.whitespace != Some(Whitespace::Trimmed) {
                            fields.position = fields.position.saturating_add(1);
                            fields.started = false;
                        }
                    }
                    if !fields.started {
                        fields.selected =
                            fields
                                .selection
                                .contains(fields.position, ranges, options.complement);
                        fields.started = true;
                        if fields.selected {
                            let separated = fields.emitted;
                            fields.emitted = true;
                            self.output.emit(Pending::None, separated, options);
                        }
                        continue;
                    }
                    if rest.is_empty() {
                        self.stage =
                            if options.only_delimited && (!fields.delimited || fields.leading) {
                                Stage::Done
                            } else {
                                Stage::Terminator
                            };
                        continue;
                    }
                    if fields.delimited && fields.selection.exhausted(ranges, options.complement) {
                        self.held.at = self.held.bytes.len();
                        continue;
                    }
                    let run = window
                        .iter()
                        .position(|&byte| !byte.is_ascii() || options.ends_field(byte))
                        .unwrap_or(window.len());
                    if run > 0 {
                        if fields.selected {
                            out.extend_from_slice(&window[..run]);
                        }
                        self.held.at += run;
                        *work -= run - 1;
                        continue;
                    }
                    let Some((ch, len)) = unit(rest, complete) else {
                        return Progress::Hungry;
                    };
                    let delimiter = if options.whitespace.is_some() {
                        matches!(ch, ' ' | '\t')
                    } else {
                        Some(ch) == options.delimiter
                    };
                    if !fields.delimited {
                        // A first field streams while raw and decoded agree;
                        // a byte no UTF-8 is holds it until the line shows
                        // which it is written as.
                        let raw = ch == '\u{fffd}' && !rest.starts_with("\u{fffd}".as_bytes());
                        if raw && fields.selected && !delimiter && !options.only_delimited {
                            fields.hold = true;
                            fields.scan = 0;
                            continue;
                        }
                        fields.delimited = delimiter;
                    }
                    self.held.at += len;
                    if delimiter {
                        if options.whitespace.is_some() {
                            fields.blanks = true;
                        } else {
                            fields.position = fields.position.saturating_add(1);
                            fields.started = false;
                        }
                    } else if fields.selected {
                        self.output.pending = Pending::character(ch);
                    }
                }
                Stage::Pass => {
                    if rest.is_empty() {
                        self.stage = Stage::Terminator;
                        continue;
                    }
                    out.extend_from_slice(window);
                    self.held.at += window.len();
                    *work -= window.len() - 1;
                }
                Stage::Terminator => {
                    out.push(options.separator);
                    self.stage = Stage::Done;
                }
                Stage::Done => return Progress::Done,
            }
        }
        Progress::Spent
    }
}

struct Cut {
    options: Options,
    ranges: Vec<Interval>,
    input: Vec<u8>,
    cursor: usize,
    line: Option<Line>,
    /// The line waits on bytes the input has not given yet.
    hungry: bool,
    ended: bool,
    cancelled: bool,
}

impl Cut {
    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut work = WORK;
        while work > 0 {
            if let Some(line) = &mut self.line {
                match line.step(&self.options, &self.ranges, out, &mut work) {
                    Progress::Done => {
                        self.line = None;
                        continue;
                    }
                    Progress::Spent => return Ok(()),
                    Progress::Hungry if work == 0 => {
                        self.hungry = true;
                        return Ok(());
                    }
                    Progress::Hungry => self.hungry = true,
                }
            }
            if self.cursor < self.input.len() {
                let end = self.cursor + work.min(self.input.len() - self.cursor);
                let bytes = &self.input[self.cursor..end];
                let separator = memchr(self.options.separator, bytes);
                let len = separator.unwrap_or(bytes.len());
                if separator.is_some() && self.line.is_none() {
                    let cost = (len + 1).saturating_mul(3 + self.options.output_delimiter.len());
                    if cost <= work && self.options.fast_record(&bytes[..len], &self.ranges, out) {
                        self.cursor += len + 1;
                        work -= cost;
                        continue;
                    }
                }
                let line = self
                    .line
                    .get_or_insert_with(|| Line::new(&self.options, &self.ranges));
                line.held.take(&bytes[..len], separator.is_some())?;
                self.hungry = false;
                self.cursor += len + usize::from(separator.is_some());
                work -= len.max(1);
            } else {
                self.input.clear();
                self.cursor = 0;
                match &mut self.line {
                    Some(line) if self.ended && !line.held.complete => {
                        line.held.complete = true;
                        self.hungry = false;
                    }
                    _ => return Ok(()),
                }
            }
        }
        Ok(())
    }
}

impl Stream for Cut {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.cancelled {
            return Ok(());
        }
        if self.busy() {
            return Err(StreamError::new(
                "cut: drain pending work before feeding input",
            ));
        }
        if self.cursor == self.input.len() {
            self.input.clear();
            self.cursor = 0;
        }
        self.input.extend_from_slice(input);
        self.step(out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.ended = true;
        self.step(out)
    }

    fn busy(&self) -> bool {
        !self.cancelled
            && (self.cursor < self.input.len()
                || self
                    .line
                    .as_ref()
                    .is_some_and(|line| !self.hungry || (self.ended && !line.held.complete)))
    }

    fn cancel(&mut self) -> bool {
        self.cancelled = true;
        self.input = Vec::new();
        self.cursor = 0;
        self.line = None;
        true
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.cancelled {
            return Ok(());
        }
        self.step(out)
    }
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { options } = parse_config(config)?;
    let selection = options::read(&options)?;
    let ranges = intervals(&selection.list, selection.mode, "cut")?;
    let output_delimiter = selection.output_delimiter.unwrap_or_else(|| {
        if selection.mode != Mode::Fields {
            Vec::new()
        } else if selection.whitespace.is_some() {
            b"\t".to_vec()
        } else {
            selection
                .delimiter
                .map_or_else(String::new, |ch| ch.to_string())
                .into_bytes()
        }
    });
    Ok(Box::new(Cut {
        options: Options {
            mode: selection.mode,
            delimiter: selection.delimiter,
            complement: selection.complement,
            only_delimited: selection.only_delimited,
            whitespace: selection.whitespace,
            no_partial: selection.no_partial,
            output_delimiter,
            separator: if selection.zero_terminated { 0 } else { b'\n' },
        },
        ranges,
        input: Vec::new(),
        cursor: 0,
        line: None,
        hungry: false,
        ended: false,
        cancelled: false,
    }))
}

#[cfg(test)]
mod tests;
