use std::collections::BTreeMap;
use std::sync::Arc;

use memchr::memchr;
use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

const BLOCK: usize = 8192;
const WORK: usize = 16384;
const TRY: &str = "Try 'cut --help' for more information.";

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Bytes,
    Characters,
    Fields,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Whitespace {
    Default,
    Trimmed,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "crate::latin1")]
    list: Vec<u8>,
    mode: Mode,
    delimiter: Vec<u32>,
    complement: bool,
    only_delimited: bool,
    whitespace: Option<Whitespace>,
    no_partial: bool,
    output_delimiter: Option<OutputDelimiter>,
    zero_terminated: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum OutputDelimiter {
    Bytes {
        #[serde(deserialize_with = "crate::latin1")]
        value: Vec<u8>,
    },
    DeferredUtf8EncodingError,
}

enum OutputEncoding {
    Valid,
    RefuseAtRecord,
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

#[derive(Debug, PartialEq, Eq)]
struct Interval {
    first: u64,
    last: u64,
}

fn refusal(message: impl AsRef<str>) -> StreamError {
    StreamError::new(format!("cut: {}\n{TRY}", message.as_ref()))
}

fn quoted(text: &[u8]) -> String {
    let mut out = String::new();
    for &byte in text {
        match byte {
            7 => out.push_str("\\a"),
            8 => out.push_str("\\b"),
            b'\t' => out.push_str("\\t"),
            b'\n' => out.push_str("\\n"),
            11 => out.push_str("\\v"),
            12 => out.push_str("\\f"),
            b'\r' => out.push_str("\\r"),
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            32..=126 => out.push(char::from(byte)),
            _ => out.push_str(&format!("\\{byte:03o}")),
        }
    }
    out
}

struct Words {
    value: &'static str,
    range: &'static str,
    zero: &'static str,
    large: &'static str,
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
        refusal(format!(
            "{} '{}' is too large",
            words.large,
            quoted(&spec[start..*cursor])
        ))
    })
}

fn intervals(spec: &[u8], mode: Mode) -> Result<Vec<Interval>, StreamError> {
    let words = if mode == Mode::Fields {
        Words {
            value: "invalid field value",
            range: "invalid field range",
            zero: "fields are numbered from 1",
            large: "field number",
        }
    } else {
        Words {
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
                return Err(refusal(words.zero));
            }
            cursor += 1;
            high = bound(spec, &mut cursor, &words)?;
            if spec.get(cursor) == Some(&b'-') {
                return Err(refusal(words.range));
            }
        }
        if spec
            .get(cursor)
            .is_some_and(|byte| !matches!(byte, b',' | b' ' | b'\t'))
        {
            return Err(refusal(format!(
                "{} '{}'",
                words.value,
                quoted(&spec[cursor..])
            )));
        }
        let first = if is_range {
            if low.is_none() && high.is_none() {
                return Err(refusal("invalid range with no endpoint: -"));
            }
            low.unwrap_or(1)
        } else {
            match low {
                None | Some(0) => return Err(refusal(words.zero)),
                Some(n) => n,
            }
        };
        let last = if is_range {
            high.unwrap_or(u64::MAX)
        } else {
            first
        };
        if last < first {
            return Err(refusal("invalid decreasing range"));
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
        match std::str::from_utf8(&bytes[..len]) {
            Ok(text) => (text.chars().next().expect("one character"), len),
            Err(error) => ('\u{fffd}', error.error_len().unwrap_or(len)),
        }
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
    output_encoding: OutputEncoding,
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
                self.record.extend(&bytes[..len]);
                self.cursor += len;
                work -= len;
                if separator.is_some() {
                    self.cursor += 1;
                    work -= 1;
                    self.check_output_encoding()?;
                    self.output = Some(OutputRecord::new(
                        std::mem::take(&mut self.record),
                        &self.options,
                    ));
                }
            } else {
                self.input.clear();
                self.cursor = 0;
                if self.ended && self.record.len > 0 {
                    self.check_output_encoding()?;
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

    fn check_output_encoding(&self) -> Result<(), StreamError> {
        match self.output_encoding {
            OutputEncoding::Valid => Ok(()),
            OutputEncoding::RefuseAtRecord => {
                Err(StreamError::new("cut: cannot encode output delimiter"))
            }
        }
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
    let config: Config = parse_config(config)?;
    let [character] = config.delimiter.as_slice() else {
        return Err(StreamError::new(
            "cut: the delimiter must be a single character",
        ));
    };
    let character = char::from_u32(*character);
    let ranges = intervals(&config.list, config.mode)?;
    let (output_delimiter, output_encoding) = match config.output_delimiter {
        Some(OutputDelimiter::Bytes { value }) => (value, OutputEncoding::Valid),
        Some(OutputDelimiter::DeferredUtf8EncodingError) => {
            (Vec::new(), OutputEncoding::RefuseAtRecord)
        }
        None => {
            let delimiter = if config.mode != Mode::Fields {
                String::new()
            } else if config.whitespace.is_some() {
                "\t".to_owned()
            } else {
                character.map_or_else(String::new, |ch| ch.to_string())
            };
            (delimiter.into_bytes(), OutputEncoding::Valid)
        }
    };
    Ok(Box::new(Cut {
        options: Options {
            mode: config.mode,
            delimiter: character,
            complement: config.complement,
            only_delimited: config.only_delimited,
            whitespace: config.whitespace,
            no_partial: config.no_partial,
            output_delimiter,
            separator: if config.zero_terminated { 0 } else { b'\n' },
        },
        ranges,
        input: Vec::new(),
        cursor: 0,
        record: Record::default(),
        output: None,
        ended: false,
        output_encoding,
        cancelled: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn config(list: &str, mode: &str) -> Value {
        json!({
            "list": list.as_bytes().iter().map(|byte| char::from(*byte)).collect::<String>(),
            "mode": mode,
            "delimiter": [9],
            "complement": false,
            "only_delimited": false,
            "whitespace": null,
            "no_partial": false,
            "output_delimiter": null,
            "zero_terminated": false,
        })
    }

    fn output(text: &str) -> Value {
        json!({"kind": "bytes", "value": text.as_bytes().iter().map(|byte| char::from(*byte)).collect::<String>()})
    }

    fn execute(config: &Value, input: &[u8], split: usize) -> Vec<u8> {
        let mut stream = open(&serde_json::to_vec(config).unwrap()).unwrap();
        let mut output = Vec::new();
        for chunk in input.chunks(split.max(1)) {
            let mut step = Vec::new();
            stream.feed(chunk, &mut step).unwrap();
            assert!(step.len() <= WORK);
            output.extend(step);
            while stream.busy() {
                let mut step = Vec::new();
                stream.drain(&mut step).unwrap();
                assert!(step.len() <= WORK);
                output.extend(step);
            }
        }
        let mut step = Vec::new();
        stream.finish(&mut step).unwrap();
        assert!(step.len() <= WORK);
        output.extend(step);
        while stream.busy() {
            let mut step = Vec::new();
            stream.drain(&mut step).unwrap();
            assert!(step.len() <= WORK);
            output.extend(step);
        }
        output
    }

    #[test]
    fn merges_sorted_intervals_once() {
        assert_eq!(
            intervals(b"3,1-2,2-4,8,6-7,12-", Mode::Bytes).unwrap(),
            [
                Interval { first: 1, last: 4 },
                Interval { first: 6, last: 8 },
                Interval {
                    first: 12,
                    last: u64::MAX
                },
            ]
        );
        assert_eq!(
            intervals(b"4294967296-", Mode::Characters).unwrap(),
            [Interval {
                first: 4294967296,
                last: u64::MAX
            },]
        );
    }

    #[test]
    fn list_refusals_preserve_scan_precedence() {
        let cases = [
            ("2-3x", "invalid field value 'x'"),
            ("abc", "invalid field value 'abc'"),
            ("0", "fields are numbered from 1"),
            ("3-1", "invalid decreasing range"),
            ("", "fields are numbered from 1"),
            ("1,2x", "invalid field value 'x'"),
            ("2 ", "fields are numbered from 1"),
            ("1-2-3", "invalid field range"),
            ("1,", "fields are numbered from 1"),
            (",1", "fields are numbered from 1"),
            ("1,,2", "fields are numbered from 1"),
            ("-", "invalid range with no endpoint: -"),
            ("- 1", "invalid range with no endpoint: -"),
            ("-,x", "invalid range with no endpoint: -"),
            (
                "1-0018446744073709551615",
                "field number '0018446744073709551615' is too large",
            ),
            ("0-x", "fields are numbered from 1"),
            ("0x", "invalid field value 'x'"),
            ("0,x", "fields are numbered from 1"),
            ("-0", "invalid decreasing range"),
            ("3-1-2", "invalid field range"),
            ("3-1 x", "invalid decreasing range"),
            ("1\r", "invalid field value '\\r'"),
        ];
        for (spec, expected) in cases {
            let error = intervals(spec.as_bytes(), Mode::Fields).unwrap_err();
            assert_eq!(error.message, format!("cut: {expected}\n{TRY}"), "{spec:?}");
        }
        for mode in [Mode::Bytes, Mode::Characters] {
            for (spec, expected) in [
                ("0", "byte/character positions are numbered from 1"),
                ("1-2-3", "invalid byte or character range"),
                ("2-3x", "invalid byte/character position 'x'"),
                (
                    "99999999999999999999x",
                    "byte/character offset '99999999999999999999' is too large",
                ),
            ] {
                assert_eq!(
                    intervals(spec.as_bytes(), mode).unwrap_err().message,
                    format!("cut: {expected}\n{TRY}")
                );
            }
        }
    }

    #[test]
    fn quotes_raw_list_bytes_and_accepts_unlimited_leading_zeros() {
        for (spec, expected) in [
            ("2-3é", "\\303\\251"),
            ("1,é", "\\303\\251"),
            ("xé", "x\\303\\251"),
            ("1,2\\x", "\\\\x"),
            ("1,2'x", "\\'x"),
            ("1,2\tx", "x"),
            ("1,2\nx", "\\nx"),
            ("x\x01y", "x\\001y"),
            ("😀", "\\360\\237\\230\\200"),
        ] {
            assert_eq!(
                intervals(spec.as_bytes(), Mode::Fields)
                    .unwrap_err()
                    .message,
                format!("cut: invalid field value '{expected}'\n{TRY}")
            );
        }
        assert_eq!(
            intervals(b"2\xff", Mode::Fields).unwrap_err().message,
            format!("cut: invalid field value '\\377'\n{TRY}")
        );
        let zeros = "0".repeat(5000);
        assert_eq!(
            execute(
                &config(&format!("{zeros}2-{zeros}3"), "fields"),
                b"a\tb\tc\n",
                1
            ),
            b"b\tc\n"
        );
        let nines = "9".repeat(5000);
        assert_eq!(
            intervals(format!("1-{nines}").as_bytes(), Mode::Fields)
                .unwrap_err()
                .message,
            format!("cut: field number '{nines}' is too large\n{TRY}")
        );
        assert!(intervals(b"18446744073709551614", Mode::Fields).is_ok());
    }

    #[test]
    fn selections_follow_input_order_with_complement_and_separators() {
        for mode in ["bytes", "characters"] {
            for (list, expected) in [
                ("2-5", b"bcde\n".as_slice()),
                ("1-3,2-4", b"abcd\n"),
                ("3-", b"cdef\n"),
                ("3,1", b"ac\n"),
            ] {
                assert_eq!(execute(&config(list, mode), b"abcdef", 1), expected);
            }
            let mut options = config("2-3", mode);
            options["complement"] = json!(true);
            options["output_delimiter"] = output(":");
            assert_eq!(execute(&options, b"abcde\n\n", 2), b"a:de\n\n");
        }
        let mut options = config("3,1", "fields");
        assert_eq!(execute(&options, b"a\tb\tc\nraw\n", 1), b"a\tc\nraw\n");
        options["complement"] = json!(true);
        assert_eq!(execute(&options, b"a\tb\tc\td\n", 2), b"b\td\n");
    }

    #[test]
    fn replacement_decoding_and_no_partial_offsets_survive_every_split() {
        let cases: &[&[u8]] = &[
            b"\xff\xfeabc",
            b"\xe2\x82x",
            b"\xed\xa0\x80x",
            b"\xf4\x90\x80\x80x",
            b"\xef\xbb\xbfhi",
            "aé😀z".as_bytes(),
            b"\xe6\x95",
        ];
        for &input in cases {
            let expected = [String::from_utf8_lossy(input).as_bytes(), b"\n"].concat();
            for split in 1..=input.len() {
                assert_eq!(execute(&config("1-", "characters"), input, split), expected);
            }
        }
        let mut options = config("3", "bytes");
        options["no_partial"] = json!(true);
        assert_eq!(execute(&options, b"\xffabc\n", 1), b"\xffab\n");
        options["list"] = json!("4");
        assert_eq!(execute(&options, b"\xffabc\n", 2), b"c\n");
        options["list"] = json!("2,5");
        options["output_delimiter"] = output(":");
        assert_eq!(execute(&options, "éxé".as_bytes(), 1), "é:é\n".as_bytes());
    }

    #[test]
    fn fields_preserve_raw_passthrough_and_empty_fields() {
        let mut options = config("2", "fields");
        assert_eq!(
            execute(&options, b"\xffabc\nx\t\xffz\na\t\n\t\n", 1),
            b"\xffabc\n\xef\xbf\xbdz\n\n\n"
        );
        options["only_delimited"] = json!(true);
        assert_eq!(execute(&options, b"raw\na\tb\n", 1), b"b\n");
        options["delimiter"] = json!([233]);
        options["output_delimiter"] = output("|");
        options["list"] = json!("1,3");
        assert_eq!(execute(&options, "aébéc".as_bytes(), 1), b"a|c\n");
    }

    #[test]
    fn whitespace_extensions_keep_trimmed_and_boundary_fields() {
        let mut options = config("1,2,3", "fields");
        options["whitespace"] = json!("default");
        assert_eq!(execute(&options, b" \ta  b\t \n\t \n", 1), b"\ta\tb\n\t\n");
        options["whitespace"] = json!("trimmed");
        assert_eq!(
            execute(&options, b" \ta  b\t \n\t \nraw\n", 1),
            b"a\tb\n\nraw\n"
        );
        options["only_delimited"] = json!(true);
        assert_eq!(execute(&options, b"\t \nraw\n a b \n", 2), b"a\tb\n");
    }

    #[test]
    fn zero_records_and_unterminated_records_keep_terminators() {
        let mut options = config("2", "fields");
        options["delimiter"] = json!([44]);
        options["zero_terminated"] = json!(true);
        assert_eq!(execute(&options, b"a,b\0c,d\0e,f", 1), b"b\0d\0f\0");
        assert!(execute(&options, b"", 1).is_empty());
        assert_eq!(execute(&options, b"\0", 1), b"\0");
    }

    #[test]
    fn raw_delimiter_sentinels_never_match_replacement_decoding() {
        let mut options = config("1", "fields");
        options["delimiter"] = json!([0xdcff]);
        for input in [b"a\xffb\n".as_slice(), "a\u{fffd}b\n".as_bytes()] {
            assert_eq!(execute(&options, input, 1), input);
        }
        options["only_delimited"] = json!(true);
        assert!(execute(&options, b"a\xffb\n", 1).is_empty());
        options["mode"] = json!("bytes");
        assert_eq!(execute(&options, b"a\xffb\n", 1), b"a\n");
        options["mode"] = json!("characters");
        assert_eq!(execute(&options, b"a\xffb\n", 1), b"a\n");
        options["mode"] = json!("fields");
        options["delimiter"] = json!([0xfffd]);
        assert_eq!(execute(&options, b"a\xffb\n", 1), b"a\n");
    }

    #[test]
    fn output_encoding_refusal_is_deferred_until_a_complete_or_final_record() {
        let mut options = config("1", "fields");
        options["only_delimited"] = json!(true);
        options["output_delimiter"] = json!({"kind": "deferred_utf8_encoding_error"});
        let bytes = serde_json::to_vec(&options).unwrap();
        let mut stream = open(&bytes).unwrap();
        let mut out = Vec::new();
        stream.feed(b"plain", &mut out).unwrap();
        assert!(out.is_empty());
        assert!(stream.finish(&mut out).is_err());
        assert!(out.is_empty());
        let mut stream = open(&bytes).unwrap();
        stream.finish(&mut out).unwrap();
        let mut stream = open(&bytes).unwrap();
        assert!(stream.feed(b"\n", &mut out).is_err());
        assert!(out.is_empty());
    }

    fn cancellable_cut() -> Cut {
        Cut {
            options: Options {
                mode: Mode::Bytes,
                delimiter: Some('\t'),
                complement: false,
                only_delimited: false,
                whitespace: None,
                no_partial: true,
                output_delimiter: Vec::new(),
                separator: b'\n',
            },
            ranges: intervals(b"1-", Mode::Bytes).unwrap(),
            input: Vec::new(),
            cursor: 0,
            record: Record::default(),
            output: None,
            ended: false,
            output_encoding: OutputEncoding::Valid,
            cancelled: false,
        }
    }

    fn retained_blocks(stream: &Cut) -> usize {
        let mut count = stream.record.blocks.len() + usize::from(stream.record.tail.capacity() > 0);
        if let Some(output) = &stream.output {
            count += output.record.blocks.len()
                + usize::from(output.record.tail.capacity() > 0)
                + usize::from(output.reader.bytes.is_some())
                + usize::from(output.output_reader.bytes.is_some());
        }
        count
    }

    fn drain_cancellation(stream: &mut Cut) {
        let mut steps = 0;
        let mut out = Vec::new();
        while stream.busy() {
            let before = retained_blocks(stream);
            stream.drain(&mut out).unwrap();
            let after = retained_blocks(stream);
            assert!(after <= before);
            assert!(before - after <= WORK / BLOCK);
            assert!(out.is_empty());
            assert_eq!(out.capacity(), 0);
            steps += 1;
        }
        assert!(steps > 1);
        assert_eq!(retained_blocks(stream), 0);
        assert!(stream.cancel());
        assert!(!stream.busy());
        stream.feed(b"ignored\n", &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        assert!(out.is_empty());
        assert_eq!(out.capacity(), 0);
    }

    #[test]
    fn cancel_retains_a_partial_record_until_bounded_empty_drains_retire_it() {
        let mut stream = cancellable_cut();
        let data = vec![b'x'; 2 * 1024 * 1024 + 101];
        let mut out = Vec::new();
        for chunk in data.chunks(WORK) {
            stream.feed(chunk, &mut out).unwrap();
            while stream.busy() {
                stream.drain(&mut out).unwrap();
            }
        }
        assert!(out.is_empty());
        assert_eq!(stream.record.len, data.len());
        let before = retained_blocks(&stream);
        let input_capacity = stream.input.capacity();
        assert!(before > 256);
        assert!(stream.cancel());
        assert_eq!(retained_blocks(&stream), before);
        assert_eq!(stream.input.capacity(), input_capacity);
        assert!(stream.busy());
        assert!(stream.cancel());
        assert_eq!(retained_blocks(&stream), before);
        stream.feed(b"ignored\n", &mut out).unwrap();
        assert_eq!(retained_blocks(&stream), before);
        drain_cancellation(&mut stream);
    }

    #[test]
    fn cancel_mid_output_discards_pending_bytes_and_retires_cached_blocks_in_budget() {
        let mut stream = cancellable_cut();
        let data = vec![b'x'; 2 * 1024 * 1024];
        let mut out = Vec::new();
        for chunk in data.chunks(WORK) {
            stream.feed(chunk, &mut out).unwrap();
            while stream.busy() {
                stream.drain(&mut out).unwrap();
            }
        }
        stream.feed(b"\n", &mut out).unwrap();
        stream.drain(&mut out).unwrap();
        assert!(!out.is_empty());
        let output = stream.output.as_ref().unwrap();
        assert!(output.reader.bytes.is_some());
        assert!(output.output_reader.bytes.is_some());
        let before = retained_blocks(&stream);
        assert!(before > 256);
        assert!(stream.cancel());
        assert_eq!(retained_blocks(&stream), before);
        drain_cancellation(&mut stream);
    }

    #[test]
    fn huge_records_and_output_delimiters_drain_in_bounded_steps() {
        for mode in ["bytes", "characters", "fields"] {
            let mut options = config("1-", mode);
            let input = [vec![b'x'; 2 * 1024 * 1024], b"\n".to_vec()].concat();
            assert_eq!(execute(&options, &input, 16384), input);
            if mode == "fields" {
                options["delimiter"] = json!([120]);
                options["list"] = json!("1,3");
                options["output_delimiter"] = output(&"y".repeat(3 * WORK));
                assert_eq!(
                    execute(&options, b"xxx\n", 1),
                    [vec![b'y'; 3 * WORK], b"\n".to_vec()].concat()
                );
            }
        }
    }
}
