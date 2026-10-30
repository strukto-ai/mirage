mod options;

use std::collections::BTreeMap;
use std::sync::Arc;

use memchr::memchr;
use serde::Deserialize;

use crate::{Stream, StreamError, parse_config, quoted};

const BLOCK: usize = 8192;
const WORK: usize = 16384;

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
struct Record {
    blocks: BTreeMap<usize, Arc<[u8]>>,
    tail: Vec<u8>,
    len: usize,
}

impl Record {
    fn extend(&mut self, mut bytes: &[u8]) {
        self.len += bytes.len();
        while !bytes.is_empty() {
            if self.tail.len() == BLOCK {
                let block = std::mem::replace(&mut self.tail, Vec::with_capacity(BLOCK));
                self.blocks.insert(self.blocks.len(), Arc::from(block));
            }
            let len = bytes.len().min(BLOCK - self.tail.len());
            self.tail.extend_from_slice(&bytes[..len]);
            bytes = &bytes[len..];
        }
    }

    fn seal(&mut self) {
        if !self.tail.is_empty() {
            self.blocks
                .insert(self.blocks.len(), Arc::from(std::mem::take(&mut self.tail)));
        }
    }

    fn retire(&mut self, work: &mut usize) -> bool {
        while let Some((_, block)) = self.blocks.last_key_value() {
            let cost = block.len().max(1);
            if *work < cost {
                *work = 0;
                return false;
            }
            self.blocks.pop_last();
            *work -= cost;
        }
        if self.tail.capacity() > 0 {
            let cost = self.tail.capacity();
            if *work < cost {
                *work = 0;
                return false;
            }
            self.tail = Vec::new();
            *work -= cost;
        }
        self.len = 0;
        true
    }

    fn decode(&self, reader: &mut Reader, at: usize, end: usize) -> (char, usize) {
        let first = reader.block(self, at)[at % BLOCK];
        if first < 128 {
            return (char::from(first), 1);
        }
        let width = match first {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return ('\u{fffd}', 1),
        };
        let len = width.min(end - at);
        let mut bytes = [0; 4];
        for (index, byte) in bytes[..len].iter_mut().enumerate() {
            *byte = reader.block(self, at + index)[(at + index) % BLOCK];
        }
        crate::utf8::scalar(&bytes[..len])
    }
}

#[derive(Default)]
struct Reader {
    index: usize,
    bytes: Option<Arc<[u8]>>,
}

impl Reader {
    fn block(&mut self, record: &Record, at: usize) -> &[u8] {
        let index = at / BLOCK;
        if self.index != index {
            self.index = index;
            self.bytes = None;
        }
        self.bytes
            .get_or_insert_with(|| Arc::clone(&record.blocks[&index]))
    }
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
}

enum Pending {
    None,
    Delimiter(usize),
    Raw {
        cursor: usize,
        end: usize,
    },
    Encoded {
        bytes: [u8; 4],
        cursor: usize,
        end: usize,
    },
}

enum Stage {
    Inspect {
        cursor: usize,
        has_delimiter: bool,
        first: Option<usize>,
        last: usize,
    },
    Pass(usize),
    Positions {
        cursor: usize,
        offset: usize,
        previous_end: Option<usize>,
        selection: Selection,
    },
    Fields {
        cursor: usize,
        end: usize,
        position: u64,
        selection: Selection,
        started: bool,
        selected: bool,
        emitted: bool,
        skip_blanks: bool,
    },
    Terminator,
    Release,
}

struct OutputRecord {
    record: Record,
    stage: Stage,
    pending: Pending,
    after_delimiter: Pending,
    reader: Reader,
    output_reader: Reader,
}

impl OutputRecord {
    fn new(mut record: Record, options: &Options) -> Self {
        record.seal();
        let stage = if options.mode == Mode::Fields {
            Stage::Inspect {
                cursor: 0,
                has_delimiter: false,
                first: None,
                last: 0,
            }
        } else {
            Stage::Positions {
                cursor: 0,
                offset: 0,
                previous_end: None,
                selection: Selection::default(),
            }
        };
        Self {
            record,
            stage,
            pending: Pending::None,
            after_delimiter: Pending::None,
            reader: Reader::default(),
            output_reader: Reader::default(),
        }
    }

    fn cancel(&mut self) {
        self.stage = Stage::Release;
        self.pending = Pending::None;
        self.after_delimiter = Pending::None;
    }

    fn retire(&mut self, work: &mut usize) -> bool {
        if let Some(bytes) = &self.reader.bytes {
            let cost = bytes.len().max(1);
            if *work < cost {
                *work = 0;
                return false;
            }
            self.reader.bytes = None;
            *work -= cost;
        }
        if let Some(bytes) = &self.output_reader.bytes {
            let cost = bytes.len().max(1);
            if *work < cost {
                *work = 0;
                return false;
            }
            self.output_reader.bytes = None;
            *work -= cost;
        }
        self.record.retire(work)
    }

    fn emit(&mut self, piece: Pending, separator: bool, options: &Options) {
        if separator && !options.output_delimiter.is_empty() {
            self.pending = Pending::Delimiter(0);
            self.after_delimiter = piece;
        } else {
            self.pending = piece;
        }
    }

    fn step(
        &mut self,
        options: &Options,
        ranges: &[Interval],
        out: &mut Vec<u8>,
        work: &mut usize,
    ) -> bool {
        while *work > 0 {
            match &mut self.pending {
                Pending::Delimiter(cursor) => {
                    let len = (*work).min(options.output_delimiter.len() - *cursor);
                    out.extend_from_slice(&options.output_delimiter[*cursor..*cursor + len]);
                    *cursor += len;
                    *work -= len;
                    if *cursor == options.output_delimiter.len() {
                        self.pending = std::mem::replace(&mut self.after_delimiter, Pending::None);
                    }
                    continue;
                }
                Pending::Raw { cursor, end } => {
                    let len = (*work).min(*end - *cursor).min(BLOCK - *cursor % BLOCK);
                    out.extend_from_slice(
                        &self.output_reader.block(&self.record, *cursor)
                            [*cursor % BLOCK..*cursor % BLOCK + len],
                    );
                    *cursor += len;
                    *work -= len;
                    if *cursor == *end {
                        self.pending = Pending::None;
                    }
                    continue;
                }
                Pending::Encoded { bytes, cursor, end } => {
                    let len = (*work).min(*end - *cursor);
                    out.extend_from_slice(&bytes[*cursor..*cursor + len]);
                    *cursor += len;
                    *work -= len;
                    if *cursor == *end {
                        self.pending = Pending::None;
                    }
                    continue;
                }
                Pending::None => {}
            }
            *work -= 1;
            match &mut self.stage {
                Stage::Inspect {
                    cursor,
                    has_delimiter,
                    first,
                    last,
                } => {
                    if *cursor < self.record.len {
                        let (ch, len) =
                            self.record
                                .decode(&mut self.reader, *cursor, self.record.len);
                        let blank = matches!(ch, ' ' | '\t');
                        *has_delimiter |= if options.whitespace.is_some() {
                            blank
                        } else {
                            Some(ch) == options.delimiter
                        };
                        if !blank {
                            if first.is_none() {
                                *first = Some(*cursor);
                            }
                            *last = *cursor + len;
                        }
                        *cursor += len;
                    } else if !*has_delimiter {
                        self.stage = if options.only_delimited {
                            Stage::Release
                        } else {
                            Stage::Pass(0)
                        };
                    } else if options.whitespace == Some(Whitespace::Trimmed)
                        && first.is_none()
                        && options.only_delimited
                    {
                        self.stage = Stage::Release;
                    } else {
                        let (start, end) = if options.whitespace == Some(Whitespace::Trimmed) {
                            (
                                first.unwrap_or(self.record.len),
                                if first.is_some() {
                                    *last
                                } else {
                                    self.record.len
                                },
                            )
                        } else {
                            (0, self.record.len)
                        };
                        self.stage = Stage::Fields {
                            cursor: start,
                            end,
                            position: 1,
                            selection: Selection::default(),
                            started: false,
                            selected: false,
                            emitted: false,
                            skip_blanks: false,
                        };
                    }
                }
                Stage::Pass(cursor) => {
                    if *cursor == self.record.len {
                        self.stage = Stage::Terminator;
                    } else {
                        self.pending = Pending::Raw {
                            cursor: *cursor,
                            end: self.record.len,
                        };
                        *cursor = self.record.len;
                    }
                }
                Stage::Positions {
                    cursor,
                    offset,
                    previous_end,
                    selection,
                } => {
                    if *cursor == self.record.len {
                        self.stage = Stage::Terminator;
                        continue;
                    }
                    let start = *offset;
                    let (piece, position, end) =
                        if options.mode == Mode::Bytes && !options.no_partial {
                            let start = *cursor;
                            *cursor += 1;
                            *offset = *cursor;
                            (
                                Pending::Raw {
                                    cursor: start,
                                    end: *cursor,
                                },
                                *cursor as u64,
                                *cursor,
                            )
                        } else {
                            let (ch, len) =
                                self.record
                                    .decode(&mut self.reader, *cursor, self.record.len);
                            *cursor += len;
                            let mut bytes = [0; 4];
                            let width = ch.encode_utf8(&mut bytes).len();
                            if options.mode == Mode::Characters {
                                *offset += 1;
                                (
                                    Pending::Encoded {
                                        bytes,
                                        cursor: 0,
                                        end: width,
                                    },
                                    *offset as u64,
                                    *offset,
                                )
                            } else {
                                *offset = offset.saturating_add(width);
                                (
                                    Pending::Raw {
                                        cursor: start.min(self.record.len),
                                        end: (*offset).min(self.record.len),
                                    },
                                    *offset as u64,
                                    *offset,
                                )
                            }
                        };
                    let in_bounds = options.mode != Mode::Bytes || end <= self.record.len;
                    if selection.contains(position, ranges, options.complement) && in_bounds {
                        let separated = previous_end.is_some_and(|previous| previous != start);
                        *previous_end = Some(end);
                        self.emit(piece, separated, options);
                    }
                }
                Stage::Fields {
                    cursor,
                    end,
                    position,
                    selection,
                    started,
                    selected,
                    emitted,
                    skip_blanks,
                } => {
                    if *skip_blanks {
                        if *cursor < *end
                            && matches!(
                                self.reader.block(&self.record, *cursor)[*cursor % BLOCK],
                                b' ' | b'\t'
                            )
                        {
                            *cursor += 1;
                        } else {
                            *skip_blanks = false;
                            *position = position.saturating_add(1);
                            *started = false;
                        }
                        continue;
                    }
                    if !*started {
                        *selected = selection.contains(*position, ranges, options.complement);
                        *started = true;
                        if *selected {
                            let separated = *emitted;
                            *emitted = true;
                            self.emit(Pending::None, separated, options);
                        }
                        continue;
                    }
                    if *cursor == *end {
                        self.stage = Stage::Terminator;
                        continue;
                    }
                    let (ch, len) = self.record.decode(&mut self.reader, *cursor, *end);
                    *cursor += len;
                    let delimiter = if options.whitespace.is_some() {
                        matches!(ch, ' ' | '\t')
                    } else {
                        Some(ch) == options.delimiter
                    };
                    if delimiter {
                        if options.whitespace.is_some() {
                            *skip_blanks = true;
                        } else {
                            *position = position.saturating_add(1);
                            *started = false;
                        }
                    } else if *selected {
                        let mut bytes = [0; 4];
                        let len = ch.encode_utf8(&mut bytes).len();
                        self.pending = Pending::Encoded {
                            bytes,
                            cursor: 0,
                            end: len,
                        };
                    }
                }
                Stage::Terminator => {
                    out.push(options.separator);
                    self.stage = Stage::Release;
                }
                Stage::Release => return self.retire(work),
            }
        }
        false
    }
}

struct Cut {
    options: Options,
    ranges: Vec<Interval>,
    input: Vec<u8>,
    cursor: usize,
    record: Record,
    output: Option<OutputRecord>,
    ended: bool,
    cancelled: bool,
}

impl Cut {
    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut work = WORK;
        if self.cancelled {
            if let Some(output) = &mut self.output {
                if !output.retire(&mut work) {
                    return Ok(());
                }
                self.output = None;
            }
            self.record.retire(&mut work);
            return Ok(());
        }
        while work > 0 {
            if let Some(output) = &mut self.output {
                if output.step(&self.options, &self.ranges, out, &mut work) {
                    self.output = None;
                }
                continue;
            }
            if self.cursor < self.input.len() {
                let end = self.cursor + work.min(self.input.len() - self.cursor);
                let bytes = &self.input[self.cursor..end];
                let separator = memchr(self.options.separator, bytes);
                let len = separator.unwrap_or(bytes.len());
                if separator.is_some() && self.record.len == 0 {
                    let cost = (len + 1).saturating_mul(3 + self.options.output_delimiter.len());
                    if cost <= work && self.options.fast_record(&bytes[..len], &self.ranges, out) {
                        self.cursor += len + 1;
                        work -= cost;
                        continue;
                    }
                }
                self.record.extend(&bytes[..len]);
                self.cursor += len;
                work -= len;
                if separator.is_some() {
                    self.cursor += 1;
                    work -= 1;
                    self.output = Some(OutputRecord::new(
                        std::mem::take(&mut self.record),
                        &self.options,
                    ));
                }
            } else {
                self.input.clear();
                self.cursor = 0;
                if self.ended && self.record.len > 0 {
                    self.output = Some(OutputRecord::new(
                        std::mem::take(&mut self.record),
                        &self.options,
                    ));
                } else {
                    return Ok(());
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
        if self.cancelled {
            return self.output.is_some() || self.record.len > 0;
        }
        self.output.is_some()
            || self.cursor < self.input.len()
            || (self.ended && self.record.len > 0)
    }

    fn cancel(&mut self) -> bool {
        self.cancelled = true;
        self.input.clear();
        self.cursor = 0;
        if let Some(output) = &mut self.output {
            output.cancel();
        }
        true
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
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
        record: Record::default(),
        output: None,
        ended: false,
        cancelled: false,
    }))
}

#[cfg(test)]
mod tests;
