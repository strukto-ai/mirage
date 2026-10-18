// Adapted from grep-searcher 0.1.14, grep-printer 0.2.2, and grep-matcher 0.1.7.
// https://github.com/BurntSushi/ripgrep/tree/14.1.1/crates
// Licensed under MIT. See licenses/third_party/ripgrep.txt.
use std::collections::VecDeque;
use std::ops::{Deref, Range};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::rg_matcher::{CaptureRequirement, Matches, Options, Program, Search};
use crate::{Stream, StreamError, parse_config};

const WORK: usize = 16 * 1024;
const INPUT_LIMIT: usize = 96 * 1024;
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    pattern: String,
    never_match: bool,
    ignore_case: bool,
    smart_case: bool,
    whole_word: bool,
    line_regexp: bool,
    fixed_string: bool,
    unicode: bool,
    ban_nul: bool,
    multiline: bool,
    multiline_dotall: bool,
    crlf: bool,
    null_data: bool,
    invert: bool,
    line_numbers: bool,
    column: bool,
    vimgrep: bool,
    byte_offsets: bool,
    only_matching: bool,
    #[serde(deserialize_with = "template_bytes")]
    replace: Option<Arc<Vec<u8>>>,
    trim: bool,
    #[serde(deserialize_with = "crate::saturating_u64_opt")]
    max_columns: Option<u64>,
    max_columns_preview: bool,
    null: bool,
    quiet: bool,
    count_only: bool,
    count_matches: bool,
    include_zero: bool,
    files_only: bool,
    files_without_match: bool,
    heading: bool,
    passthru: bool,
    #[serde(deserialize_with = "crate::saturating_u64_opt")]
    max_count: Option<u64>,
    stop_on_nonmatch: bool,
    stats: bool,
    json: bool,
    #[serde(deserialize_with = "crate::saturating_u64")]
    context_after: u64,
    #[serde(deserialize_with = "crate::saturating_usize")]
    context_before: usize,
    #[serde(deserialize_with = "crate::latin1_opt")]
    context_separator: Option<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1")]
    field_match_separator: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1")]
    field_context_separator: Vec<u8>,
    #[serde(deserialize_with = "crate::saturating_usize_opt")]
    regex_size_limit: Option<usize>,
    #[serde(deserialize_with = "crate::saturating_usize_opt")]
    dfa_size_limit: Option<usize>,
    #[serde(skip)]
    max_capture_name: usize,
    #[serde(skip)]
    record_context: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            never_match: false,
            ignore_case: false,
            smart_case: false,
            whole_word: false,
            line_regexp: false,
            fixed_string: false,
            unicode: true,
            ban_nul: true,
            multiline: false,
            multiline_dotall: false,
            crlf: false,
            null_data: false,
            invert: false,
            line_numbers: false,
            column: false,
            vimgrep: false,
            byte_offsets: false,
            only_matching: false,
            replace: None,
            trim: false,
            max_columns: None,
            max_columns_preview: false,
            null: false,
            quiet: false,
            count_only: false,
            count_matches: false,
            include_zero: false,
            files_only: false,
            files_without_match: false,
            heading: false,
            passthru: false,
            max_count: None,
            stop_on_nonmatch: false,
            stats: false,
            json: false,
            context_after: 0,
            context_before: 0,
            context_separator: Some(b"--".to_vec()),
            field_match_separator: b":".to_vec(),
            field_context_separator: b"-".to_vec(),
            regex_size_limit: None,
            dfa_size_limit: None,
            max_capture_name: 0,
            record_context: false,
        }
    }
}

impl Config {
    fn terminator(&self) -> u8 {
        if self.null_data { 0 } else { b'\n' }
    }
    fn end(&self) -> &'static [u8] {
        if self.null_data {
            b"\0"
        } else if self.crlf {
            b"\r\n"
        } else {
            b"\n"
        }
    }
    fn context(&self) -> bool {
        !self.summary() && !self.passthru && (self.context_before > 0 || self.context_after > 0)
    }
    fn summary(&self) -> bool {
        self.quiet
            || self.count_only
            || self.count_matches
            || self.files_only
            || self.files_without_match
    }
    fn counts(&self) -> bool {
        self.stats || self.json
    }
    fn granular(&self) -> bool {
        self.column || self.vimgrep || self.replace.is_some() || self.only_matching
    }
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Begin {
    #[serde(deserialize_with = "crate::latin1")]
    name: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1_opt")]
    label: Option<Vec<u8>>,
    binary_mode: String,
    binary_offset: Option<u64>,
    binary_converted: bool,
    binary_skipped: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Metadata {
    binary_offset: Option<u64>,
    binary_converted: Option<bool>,
    binary_skipped: Option<bool>,
    searched: Option<u64>,
}

#[derive(Default, Serialize)]
struct Tally {
    selected: bool,
    binary: bool,
    skipped: bool,
    matches: u64,
    matched_lines: u64,
    searched: u64,
    nul: Option<u64>,
}

#[derive(Clone)]
struct Record {
    data: Arc<Vec<u8>>,
    content: Range<usize>,
    full_end: usize,
    number: u64,
    offset: u64,
    cr: bool,
    terminated: bool,
    matches: Arc<Matches>,
    found: Range<usize>,
    matched: bool,
}

impl Record {
    fn hit(&self, invert: bool) -> bool {
        self.matched != invert
    }
}

#[derive(Clone, Copy)]
struct Line {
    start: usize,
    end: usize,
    full_end: usize,
    cr: bool,
}

#[derive(Clone, Copy)]
struct Region {
    first: usize,
    last: usize,
    from: usize,
    to: usize,
}

#[derive(Default)]
struct Utf8 {
    left: u8,
    low: u8,
    high: u8,
    invalid: bool,
}

impl Utf8 {
    fn push(&mut self, byte: u8) {
        if self.invalid {
            return;
        }
        if self.left > 0 {
            if byte < self.low || byte > self.high {
                self.invalid = true;
                return;
            }
            self.left -= 1;
            self.low = 0x80;
            self.high = 0xbf;
            return;
        }
        (self.left, self.low, self.high) = match byte {
            0..=0x7f => (0, 0x80, 0xbf),
            0xc2..=0xdf => (1, 0x80, 0xbf),
            0xe0 => (2, 0xa0, 0xbf),
            0xe1..=0xec | 0xee..=0xef => (2, 0x80, 0xbf),
            0xed => (2, 0x80, 0x9f),
            0xf0 => (3, 0x90, 0xbf),
            0xf1..=0xf3 => (3, 0x80, 0xbf),
            0xf4 => (3, 0x80, 0x8f),
            _ => {
                self.invalid = true;
                (0, 0x80, 0xbf)
            }
        };
    }
}

enum Piece {
    Bytes {
        data: Arc<Vec<u8>>,
        range: Range<usize>,
    },
    Json {
        data: Arc<Vec<u8>>,
        range: Range<usize>,
        scan: usize,
        valid: Utf8,
        stage: u8,
    },
}

impl Piece {
    fn bytes(data: Vec<u8>) -> Self {
        let end = data.len();
        Self::Bytes {
            data: Arc::new(data),
            range: 0..end,
        }
    }
    fn slice(data: Arc<Vec<u8>>, range: Range<usize>) -> Self {
        Self::Bytes { data, range }
    }
    fn json(data: Arc<Vec<u8>>, range: Range<usize>) -> Self {
        let scan = range.start;
        Self::Json {
            data,
            range,
            scan,
            valid: Utf8::default(),
            stage: 0,
        }
    }
    fn poll(&mut self, out: &mut Vec<u8>, budget: &mut usize) -> bool {
        match self {
            Self::Bytes { data, range } => {
                let end = range.end.min(range.start.saturating_add(*budget));
                out.extend_from_slice(&data[range.start..end]);
                *budget -= end - range.start;
                range.start = end;
                range.start == range.end
            }
            Self::Json {
                data,
                range,
                scan,
                valid,
                stage,
            } => {
                if *stage == 0 {
                    let end = range.end.min(scan.saturating_add(*budget));
                    for &byte in &data[*scan..end] {
                        valid.push(byte);
                    }
                    *budget -= end - *scan;
                    *scan = end;
                    if end < range.end {
                        return false;
                    }
                    let prefix = if valid.invalid || valid.left != 0 {
                        b"{\"bytes\":\"".as_slice()
                    } else {
                        b"{\"text\":\""
                    };
                    if *budget < prefix.len() {
                        return false;
                    }
                    out.extend_from_slice(prefix);
                    *budget -= prefix.len();
                    *stage = 1;
                }
                let binary = valid.invalid || valid.left != 0;
                while range.start < range.end && *budget >= 8 {
                    if binary {
                        let len = (range.end - range.start).min(3);
                        let a = data[range.start];
                        let b = if len > 1 { data[range.start + 1] } else { 0 };
                        let c = if len > 2 { data[range.start + 2] } else { 0 };
                        out.extend_from_slice(&[
                            BASE64[(a >> 2) as usize],
                            BASE64[(((a & 3) << 4) | (b >> 4)) as usize],
                            if len > 1 {
                                BASE64[(((b & 15) << 2) | (c >> 6)) as usize]
                            } else {
                                b'='
                            },
                            if len > 2 {
                                BASE64[(c & 63) as usize]
                            } else {
                                b'='
                            },
                        ]);
                        range.start += len;
                        *budget -= 4;
                    } else {
                        let byte = data[range.start];
                        match byte {
                            b'"' => out.extend_from_slice(b"\\\""),
                            b'\\' => out.extend_from_slice(b"\\\\"),
                            8 => out.extend_from_slice(b"\\b"),
                            9 => out.extend_from_slice(b"\\t"),
                            10 => out.extend_from_slice(b"\\n"),
                            12 => out.extend_from_slice(b"\\f"),
                            13 => out.extend_from_slice(b"\\r"),
                            0..=31 => {
                                const HEX: &[u8; 16] = b"0123456789abcdef";
                                out.extend_from_slice(&[
                                    b'\\',
                                    b'u',
                                    b'0',
                                    b'0',
                                    HEX[(byte >> 4) as usize],
                                    HEX[(byte & 15) as usize],
                                ]);
                            }
                            _ => out.push(byte),
                        }
                        range.start += 1;
                        *budget -= 6;
                    }
                }
                if range.start < range.end || *budget < 2 {
                    return false;
                }
                out.extend_from_slice(b"\"}");
                *budget -= 2;
                true
            }
        }
    }
}

struct Buffer<T: Copy> {
    values: Vec<T>,
    previous: Option<Vec<T>>,
    start: usize,
}

impl<T: Copy> Buffer<T> {
    fn new() -> Self {
        Self {
            values: Vec::new(),
            previous: None,
            start: 0,
        }
    }

    fn reserve(&mut self, additional: usize, budget: &mut usize) -> bool {
        loop {
            if self.previous.is_none() {
                if self.values.capacity().saturating_sub(self.values.len()) >= additional {
                    return true;
                }
                let capacity = self
                    .len()
                    .saturating_mul(2)
                    .saturating_add(additional)
                    .max(64);
                self.previous = Some(std::mem::replace(
                    &mut self.values,
                    Vec::with_capacity(capacity),
                ));
            }
            let previous = self.previous.as_ref().unwrap();
            let start = self.start + self.values.len();
            let end = previous.len().min(start.saturating_add(*budget));
            let copied = end - start;
            self.values.extend_from_slice(&previous[start..end]);
            *budget -= copied;
            if end < previous.len() {
                return false;
            }
            self.previous = None;
            self.start = 0;
        }
    }

    fn append(&mut self, input: &[T], budget: &mut usize) -> usize {
        if !self.reserve(input.len(), budget) {
            return 0;
        }
        let count = input.len().min(*budget);
        self.values.extend_from_slice(&input[..count]);
        *budget -= count;
        count
    }

    fn take(&mut self) -> Vec<T> {
        debug_assert!(self.previous.is_none());
        debug_assert_eq!(self.start, 0);
        std::mem::take(&mut self.values)
    }

    fn consume(&mut self, count: usize) {
        debug_assert!(self.previous.is_none());
        debug_assert!(count <= self.len());
        self.start += count;
        if self.start == self.values.len() {
            self.values.clear();
            self.start = 0;
        }
    }
}

impl<T: Copy> Deref for Buffer<T> {
    type Target = [T];

    fn deref(&self) -> &Self::Target {
        &self.previous.as_deref().unwrap_or(&self.values)[self.start..]
    }
}

struct Reference {
    dollar: usize,
    start: usize,
    at: usize,
    brace: bool,
    number: Option<u32>,
}

/// Capture-reference grammar follows grep-matcher 0.1.7 interpolate.rs.
/// Matching and printer selection follow grep-searcher 0.1.14 and grep-printer 0.2.2.
/// The MIT copyright and license notice accompanies this module.
struct Replacement {
    record: Record,
    range: Range<usize>,
    found: Range<usize>,
    template: Arc<Vec<u8>>,
    index: usize,
    position: usize,
    template_at: usize,
    copied: Option<Range<usize>>,
    stage: u8,
    out: Buffer<u8>,
    spans: Buffer<(usize, usize)>,
    span_start: usize,
    reference: Option<Reference>,
    max_capture_name: usize,
}

impl Replacement {
    fn new(
        record: Record,
        template: Arc<Vec<u8>>,
        range: Range<usize>,
        found: Range<usize>,
        max_capture_name: usize,
    ) -> Self {
        Self {
            index: found.start,
            position: range.start,
            record,
            range,
            found,
            template,
            template_at: 0,
            copied: None,
            stage: 0,
            out: Buffer::new(),
            spans: Buffer::new(),
            span_start: 0,
            reference: None,
            max_capture_name,
        }
    }
    fn append(&mut self, range: &mut Range<usize>, budget: &mut usize) {
        let end = range.end.min(range.start.saturating_add(*budget));
        range.start += self.out.append(&self.record.data[range.start..end], budget);
    }
    fn poll(&mut self, program: &Program, budget: &mut usize) -> bool {
        while *budget > 0 {
            if !self.out.reserve(1, budget) || !self.spans.reserve(1, budget) || *budget == 0 {
                return false;
            }
            if let Some(mut range) = self.copied.take() {
                self.append(&mut range, budget);
                if !range.is_empty() {
                    self.copied = Some(range);
                    return false;
                }
                if *budget == 0 {
                    return false;
                }
            }
            if self.index >= self.found.end {
                if self.position < self.range.end {
                    self.copied = Some(self.position..self.range.end);
                    self.position = self.range.end;
                    continue;
                }
                return true;
            }
            let mat = &self.record.matches[self.index];
            if self.stage == 0 {
                self.copied = Some(self.position..mat.start);
                self.position = mat.end;
                self.stage = 1;
                self.template_at = 0;
                self.span_start = self.out.len() + self.copied.as_ref().map_or(0, Range::len);
                continue;
            }
            if let Some(mut reference) = self.reference.take() {
                while reference.at < self.template.len() && *budget > 0 {
                    let byte = self.template[reference.at];
                    if !byte.is_ascii_alphanumeric() && byte != b'_' {
                        break;
                    }
                    reference.number = reference.number.and_then(|n| {
                        if !byte.is_ascii_digit() {
                            return None;
                        }
                        n.checked_mul(10)?.checked_add((byte - b'0') as u32)
                    });
                    reference.at += 1;
                    *budget -= 1;
                }
                if *budget == 0 {
                    self.reference = Some(reference);
                    return false;
                }
                if reference.at == reference.start
                    || reference.brace && self.template.get(reference.at) != Some(&b'}')
                {
                    self.out.values.push(b'$');
                    self.template_at = reference.dollar + 1;
                } else {
                    let capture = reference.number.map(|n| n as usize).or_else(|| {
                        if reference.at - reference.start > self.max_capture_name {
                            return None;
                        }
                        std::str::from_utf8(&self.template[reference.start..reference.at])
                            .ok()
                            .and_then(|name| program.capture_index(name))
                    });
                    self.copied = capture
                        .and_then(|i| self.record.matches.capture(self.index, i))
                        .map(|(a, b)| a..b);
                    self.template_at = reference.at + usize::from(reference.brace);
                }
                *budget -= 1;
                continue;
            }
            if self.template_at >= self.template.len() {
                self.spans.values.push((self.span_start, self.out.len()));
                self.index += 1;
                self.stage = 0;
                *budget -= 1;
                continue;
            }
            let at = self.template_at;
            let byte = self.template[at];
            if byte != b'$' {
                self.out.values.push(byte);
                self.template_at += 1;
                *budget -= 1;
                continue;
            }
            if self.template.get(at + 1) == Some(&b'$') {
                self.out.values.push(b'$');
                self.template_at += 2;
                *budget -= 1;
                continue;
            }
            let brace = self.template.get(at + 1) == Some(&b'{');
            let start = at + if brace { 2 } else { 1 };
            self.reference = Some(Reference {
                dollar: at,
                start,
                at: start,
                brace,
                number: Some(0),
            });
            *budget -= 1;
        }
        false
    }
}

fn template_bytes<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Arc<Vec<u8>>>, D::Error> {
    crate::latin1_opt(deserializer).map(|bytes| bytes.map(Arc::new))
}

enum Spans {
    None,
    One(usize, usize),
    Matches(Arc<Matches>, Range<usize>),
    Replaced(Arc<Vec<(usize, usize)>>),
}

impl Spans {
    fn is_empty(&self) -> bool {
        match self {
            Self::None => true,
            Self::One(start, end) => {
                debug_assert!(end >= start);
                false
            }
            Self::Matches(_, range) => range.is_empty(),
            Self::Replaced(spans) => spans.is_empty(),
        }
    }
    fn remaining(&self, from: usize, to: usize) -> usize {
        match self {
            Self::None => 0,
            Self::One(start, _) => usize::from(from <= *start && *start < to),
            Self::Matches(matches, range) => {
                let spans = &matches[range.clone()];
                spans.partition_point(|m| m.start < to) - spans.partition_point(|m| m.start < from)
            }
            Self::Replaced(spans) => {
                spans.partition_point(|&(s, _)| s < to) - spans.partition_point(|&(s, _)| s < from)
            }
        }
    }
}

struct Printed {
    data: Arc<Vec<u8>>,
    range: Range<usize>,
    number: u64,
    column: Option<u64>,
    offset: u64,
    selected: bool,
    terminated: bool,
    cr: bool,
    use_configured_ending: bool,
    spans: Spans,
    count: usize,
    trim_at: usize,
    preview_at: usize,
    preview_chars: u64,
    grapheme: Option<crate::rg_grapheme::Grapheme>,
    stage: u8,
}

impl Printed {
    fn plain(record: &Record, selected: bool, column: Option<u64>) -> Self {
        Self {
            data: record.data.clone(),
            range: record.content.clone(),
            number: record.number,
            column,
            offset: record.offset,
            selected,
            terminated: record.terminated,
            cr: record.cr,
            use_configured_ending: false,
            spans: Spans::None,
            count: 0,
            trim_at: record.content.start,
            preview_at: record.content.start,
            preview_chars: 0,
            grapheme: None,
            stage: 0,
        }
    }
    fn poll(
        &mut self,
        config: &Config,
        label: &Option<Vec<u8>>,
        pieces: &mut VecDeque<Piece>,
        budget: &mut usize,
    ) -> bool {
        if self.stage == 0 {
            if config.trim {
                while self.trim_at < self.range.end
                    && *budget > 0
                    && self.data[self.trim_at].is_ascii_whitespace()
                {
                    self.trim_at += 1;
                    *budget -= 1;
                }
                if *budget == 0 {
                    return false;
                }
            }
            self.range.start = self.trim_at;
            self.preview_at = self.trim_at;
            self.stage = 1;
        }
        let exceeded = config.max_columns.is_some_and(|limit| {
            limit > 0
                && self.range.len() as u64 + u64::from(self.terminated) + u64::from(self.cr) > limit
        });
        if exceeded && config.max_columns_preview {
            let limit = config.max_columns.unwrap_or(0);
            while self.preview_at < self.range.end && self.preview_chars < limit && *budget > 0 {
                if self.grapheme.is_none() {
                    self.grapheme = Some(crate::rg_grapheme::Grapheme::new(
                        &self.data,
                        self.preview_at,
                        self.range.end,
                    ));
                }
                let Some(end) = self.grapheme.as_mut().unwrap().step(&self.data, budget) else {
                    return false;
                };
                self.preview_at = end;
                self.preview_chars += 1;
                self.grapheme = None;
            }
            if self.preview_at < self.range.end && self.preview_chars < limit {
                return false;
            }
        }
        let sep = if self.selected {
            &config.field_match_separator
        } else {
            &config.field_context_separator
        };
        let mut head = Vec::new();
        if let Some(label) = label {
            head.extend_from_slice(label);
            head.extend_from_slice(if config.null { b"\0" } else { sep });
        }
        if config.line_numbers {
            head.extend_from_slice(self.number.to_string().as_bytes());
            head.extend_from_slice(sep);
        }
        if let Some(column) = self.column {
            head.extend_from_slice(column.to_string().as_bytes());
            head.extend_from_slice(sep);
        }
        if config.byte_offsets {
            head.extend_from_slice(self.offset.to_string().as_bytes());
            head.extend_from_slice(sep);
        }
        pieces.push_back(Piece::bytes(head));
        if exceeded {
            let granular = config.granular() && self.selected && !self.spans.is_empty();
            if config.max_columns_preview {
                pieces.push_back(Piece::slice(
                    self.data.clone(),
                    self.range.start..self.preview_at,
                ));
                if granular {
                    let remaining = self.spans.remaining(self.preview_at, self.range.end);
                    pieces.push_back(Piece::bytes(
                        format!(
                            " [... {remaining} more {}]",
                            if remaining == 1 { "match" } else { "matches" }
                        )
                        .into_bytes(),
                    ));
                } else {
                    pieces.push_back(Piece::bytes(b" [... omitted end of long line]".to_vec()));
                }
            } else {
                let notice = if !granular || config.only_matching {
                    if self.selected {
                        b"[Omitted long matching line]".to_vec()
                    } else {
                        b"[Omitted long context line]".to_vec()
                    }
                } else {
                    format!("[Omitted long line with {} matches]", self.count).into_bytes()
                };
                pieces.push_back(Piece::bytes(notice));
            }
            self.terminated = false;
        } else {
            pieces.push_back(Piece::slice(self.data.clone(), self.range.clone()));
        }
        pieces.push_back(Piece::bytes(
            if config.crlf
                && !config.null_data
                && self.terminated
                && !self.cr
                && !self.use_configured_ending
            {
                b"\n".to_vec()
            } else {
                config.end().to_vec()
            },
        ));
        true
    }
}

struct JsonRecord {
    record: Record,
    selected: bool,
    name: Arc<Vec<u8>>,
    index: usize,
    stage: u8,
    base: usize,
}

impl JsonRecord {
    fn poll(&mut self, config: &Config, pieces: &mut VecDeque<Piece>) -> bool {
        if self.stage == 0 {
            pieces.push_back(Piece::bytes(if self.selected {
                b"{\"type\":\"match\",\"data\":{\"path\":".to_vec()
            } else {
                b"{\"type\":\"context\",\"data\":{\"path\":".to_vec()
            }));
            pieces.push_back(Piece::json(self.name.clone(), 0..self.name.len()));
            pieces.push_back(Piece::bytes(b",\"lines\":".to_vec()));
            pieces.push_back(Piece::json(
                self.record.data.clone(),
                self.record.content.start..self.record.full_end,
            ));
            let line = if config.line_numbers {
                self.record.number.to_string()
            } else {
                "null".to_owned()
            };
            pieces.push_back(Piece::bytes(
                format!(
                    ",\"line_number\":{line},\"absolute_offset\":{},\"submatches\":[",
                    self.record.offset
                )
                .into_bytes(),
            ));
            self.stage = 1;
            return false;
        }
        if (self.selected != config.invert) && self.index < self.record.found.end {
            let mat = &self.record.matches[self.index];
            pieces.push_back(Piece::bytes(if self.index == self.record.found.start {
                b"{\"match\":".to_vec()
            } else {
                b",{\"match\":".to_vec()
            }));
            pieces.push_back(Piece::json(self.record.data.clone(), mat.start..mat.end));
            pieces.push_back(Piece::bytes(
                format!(
                    ",\"start\":{},\"end\":{}}}",
                    mat.start - self.base,
                    mat.end - self.base
                )
                .into_bytes(),
            ));
            self.index += 1;
            return false;
        }
        pieces.push_back(Piece::bytes(b"]}}\n".to_vec()));
        true
    }
}

enum ContextMatches {
    Pending,
    Copy(Vec<u8>),
    Search(Box<Search>),
    Ready,
}

struct LineJob {
    record: Record,
    context_matches: ContextMatches,
    selected: bool,
    index: usize,
    replacement: Option<Replacement>,
    replaced: Option<Arc<Vec<u8>>>,
    spans: Arc<Vec<(usize, usize)>>,
    printed: Option<Printed>,
    json: Option<JsonRecord>,
    stage: u8,
}

impl LineJob {
    fn new(record: Record, selected: bool) -> Self {
        Self {
            index: record.found.start,
            record,
            context_matches: ContextMatches::Pending,
            selected,
            replacement: None,
            replaced: None,
            spans: Arc::new(Vec::new()),
            printed: None,
            json: None,
            stage: 0,
        }
    }
    fn poll(
        &mut self,
        config: &Config,
        program: &Program,
        label: &Option<Vec<u8>>,
        name: &Arc<Vec<u8>>,
        pieces: &mut VecDeque<Piece>,
        budget: &mut usize,
    ) -> bool {
        if matches!(self.context_matches, ContextMatches::Pending) {
            self.context_matches = if config.multiline
                && config.invert
                && !self.selected
                && (config.granular() || config.json)
            {
                ContextMatches::Copy(Vec::with_capacity(
                    self.record.full_end - self.record.content.start,
                ))
            } else {
                ContextMatches::Ready
            };
        }
        if let ContextMatches::Copy(data) = &mut self.context_matches {
            let from = self.record.content.start + data.len();
            let end = self.record.full_end.min(from.saturating_add(*budget));
            data.extend_from_slice(&self.record.data[from..end]);
            *budget -= end - from;
            if end < self.record.full_end {
                return false;
            }
            self.context_matches =
                ContextMatches::Search(Box::new(program.start(std::mem::take(data), true)));
            return false;
        }
        if let ContextMatches::Search(search) = &mut self.context_matches {
            let complete = search.step(program, *budget);
            *budget = 0;
            if !complete {
                return false;
            }
            let data = search.take_haystack();
            let mut matches = search.take_matches();
            if matches.last().is_some_and(|mat| mat.start >= data.len()) {
                matches.pop();
            }
            self.record.content = 0..self.record.content.len();
            self.record.full_end = data.len();
            self.record.data = Arc::new(data);
            self.record.found = 0..matches.len();
            self.record.matches = Arc::new(matches);
            self.index = 0;
            self.context_matches = ContextMatches::Ready;
            return false;
        }
        if config.json {
            if self.json.is_none() {
                self.json = Some(JsonRecord {
                    record: self.record.clone(),
                    selected: self.selected,
                    name: name.clone(),
                    index: self.record.found.start,
                    stage: 0,
                    base: self.record.content.start,
                });
            }
            return self.json.as_mut().unwrap().poll(config, pieces);
        }
        if let Some(printed) = self.printed.as_mut() {
            if !printed.poll(config, label, pieces, budget) {
                return false;
            }
            self.printed = None;
            return self.stage == 3;
        }
        let has_matches = (self.selected != config.invert) && !self.record.found.is_empty();
        if self.stage == 0 && has_matches && config.replace.is_some() {
            let end =
                self.record.content.end + usize::from(self.record.cr && !self.record.terminated);
            self.replacement = Some(Replacement::new(
                self.record.clone(),
                config.replace.clone().unwrap(),
                self.record.content.start..end,
                self.record.found.clone(),
                config.max_capture_name,
            ));
            self.stage = 1;
        }
        if self.stage == 1 {
            if !self.replacement.as_mut().unwrap().poll(program, budget) {
                return false;
            }
            let mut result = self.replacement.take().unwrap();
            self.replaced = Some(Arc::new(result.out.take()));
            self.spans = Arc::new(result.spans.take());
            self.stage = 2;
        }
        if config.only_matching
            && (!self.selected || !config.invert)
            && !self.record.found.is_empty()
        {
            if self.index >= self.record.found.end {
                return true;
            }
            let mat = &self.record.matches[self.index];
            let mut printed = Printed::plain(&self.record, self.selected, None);
            let (start, end) = if let Some(data) = &self.replaced {
                printed.data = data.clone();
                self.spans[self.index - self.record.found.start]
            } else {
                (
                    mat.start.min(self.record.content.end),
                    mat.end.min(self.record.content.end),
                )
            };
            let relative = if self.replaced.is_some() {
                start
            } else {
                start - self.record.content.start
            };
            printed.range = start..end;
            printed.trim_at = start;
            printed.terminated = false;
            printed.cr = false;
            printed.offset = self.record.offset + relative as u64;
            if config.column && self.selected {
                printed.column = Some(relative as u64 + 1);
            }
            printed.spans = Spans::One(start, end);
            printed.count = 1;
            self.printed = Some(printed);
            self.index += 1;
            self.stage = if self.index >= self.record.found.end {
                3
            } else {
                2
            };
            return false;
        }
        if self.stage == 0 {
            self.stage = 2;
        }
        if self.stage == 2 {
            let mut printed = Printed::plain(&self.record, self.selected, None);
            printed.count = if has_matches && config.granular() {
                self.record.found.len()
            } else {
                0
            };
            if let Some(data) = &self.replaced {
                printed.data = data.clone();
                printed.range = 0..data.len();
                printed.trim_at = 0;
                printed.terminated = false;
                printed.cr = false;
                printed.spans = Spans::Replaced(self.spans.clone());
            } else if has_matches && config.granular() {
                printed.spans =
                    Spans::Matches(self.record.matches.clone(), self.record.found.clone());
            }
            let column_at = if config.vimgrep && has_matches {
                let index = self.index - self.record.found.start;
                if self.replaced.is_some() {
                    self.spans[index].0
                } else {
                    self.record.matches[self.index].start - self.record.content.start
                }
            } else if has_matches {
                if self.replaced.is_some() {
                    self.spans[0].0
                } else {
                    self.record.matches[self.record.found.start].start - self.record.content.start
                }
            } else {
                0
            };
            if config.column && self.selected && has_matches {
                printed.column = Some(column_at as u64 + 1);
            }
            if config.vimgrep && self.selected && has_matches {
                printed.offset += column_at as u64;
            }
            if config.vimgrep && self.selected && has_matches {
                self.index += 1;
                self.stage = if self.index >= self.record.found.end {
                    3
                } else {
                    2
                };
            } else {
                self.stage = 3;
            }
            self.printed = Some(printed);
            return false;
        }
        self.stage == 3
    }
}

enum Job {
    Line(LineJob),
    Region(RegionJob),
}

impl Job {
    fn poll(
        &mut self,
        config: &Config,
        program: &Program,
        label: &Option<Vec<u8>>,
        name: &Arc<Vec<u8>>,
        pieces: &mut VecDeque<Piece>,
        budget: &mut usize,
    ) -> bool {
        match self {
            Self::Line(job) => job.poll(config, program, label, name, pieces, budget),
            Self::Region(job) => job.poll(config, program, label, name, pieces, budget),
        }
    }
}

struct RegionJob {
    data: Arc<Vec<u8>>,
    matches: Arc<Matches>,
    lines: Arc<Vec<Line>>,
    region: Region,
    match_at: usize,
    line_at: usize,
    printed: Option<Printed>,
    json: Option<JsonRecord>,
    replacement: Option<Replacement>,
    replaced: Option<Arc<Vec<u8>>>,
    spans: Arc<Vec<(usize, usize)>>,
    replacement_at: usize,
    replacement_end: usize,
    replacement_number: usize,
    per_match_initialized: bool,
    rendered_prefix_at: usize,
    rendered_prefix_lines: usize,
    stage: u8,
}

impl RegionJob {
    fn new(multi: &Multi, mut region: Region) -> Self {
        if multi
            .matches
            .get(region.to.saturating_sub(1))
            .is_some_and(|m| m.start == multi.data.len() && m.end == m.start)
        {
            region.to -= 1;
        }
        Self {
            data: multi.data.clone(),
            matches: multi.matches.clone(),
            lines: multi.lines.clone(),
            region,
            match_at: region.from,
            line_at: region.first,
            printed: None,
            json: None,
            replacement: None,
            replaced: None,
            spans: Arc::new(Vec::new()),
            replacement_at: 0,
            replacement_end: 0,
            replacement_number: 0,
            per_match_initialized: false,
            rendered_prefix_at: 0,
            rendered_prefix_lines: 0,
            stage: 0,
        }
    }
    fn record(&self, index: usize) -> Record {
        let line = self.lines[index];
        Record {
            data: self.data.clone(),
            content: line.start..line.end,
            full_end: line.full_end,
            number: index as u64 + 1,
            offset: line.start as u64,
            cr: line.cr,
            terminated: line.full_end > line.end + usize::from(line.cr),
            matches: self.matches.clone(),
            found: 0..0,
            matched: false,
        }
    }
    fn containing_line(&self, at: usize) -> usize {
        self.lines
            .partition_point(|line| line.start <= at)
            .saturating_sub(1)
    }
    fn poll(
        &mut self,
        config: &Config,
        program: &Program,
        label: &Option<Vec<u8>>,
        name: &Arc<Vec<u8>>,
        pieces: &mut VecDeque<Piece>,
        budget: &mut usize,
    ) -> bool {
        if let Some(printed) = self.printed.as_mut() {
            if !printed.poll(config, label, pieces, budget) {
                return false;
            }
            self.printed = None;
            return false;
        }
        let first = self.lines[self.region.first];
        let last = self.lines[self.region.last];
        let first_column = self
            .matches
            .get(self.region.from)
            .filter(|_| self.region.from < self.region.to)
            .map_or(1, |mat| mat.start - first.start + 1);
        if config.json {
            if self.json.is_none() {
                let record = Record {
                    data: self.data.clone(),
                    content: first.start..last.end,
                    full_end: last.full_end,
                    number: self.region.first as u64 + 1,
                    offset: first.start as u64,
                    cr: last.cr,
                    terminated: last.full_end > last.end + usize::from(last.cr),
                    matches: self.matches.clone(),
                    found: self.region.from..self.region.to,
                    matched: true,
                };
                self.json = Some(JsonRecord {
                    record,
                    selected: true,
                    name: name.clone(),
                    index: self.region.from,
                    stage: 0,
                    base: first.start,
                });
            }
            return self.json.as_mut().unwrap().poll(config, pieces);
        }
        if self.region.from == self.region.to {
            if self.line_at > self.region.last {
                return true;
            }
            self.printed = Some(Printed::plain(&self.record(self.line_at), true, None));
            self.line_at += 1;
            return false;
        }
        if self.stage == 0 && config.replace.is_some() {
            let record = Record {
                data: self.data.clone(),
                content: first.start..last.end,
                full_end: last.full_end,
                number: self.region.first as u64 + 1,
                offset: first.start as u64,
                cr: last.cr,
                terminated: last.full_end > last.end + usize::from(last.cr),
                matches: self.matches.clone(),
                found: self.region.from..self.region.to,
                matched: true,
            };
            self.replacement = Some(Replacement::new(
                record,
                config.replace.clone().unwrap(),
                first.start..last.full_end,
                self.region.from..self.region.to,
                config.max_capture_name,
            ));
            self.stage = 1;
        }
        if self.stage == 1 {
            if !self.replacement.as_mut().unwrap().poll(program, budget) {
                return false;
            }
            let mut replacement = self.replacement.take().unwrap();
            self.replaced = Some(Arc::new(replacement.out.take()));
            self.spans = Arc::new(replacement.spans.take());
            self.stage = 2;
        }
        if config.vimgrep && !config.only_matching {
            if self.match_at >= self.region.to {
                return true;
            }
            let (data, base, end, begin, finish) = if let Some(data) = &self.replaced {
                let (begin, finish) = self.spans[self.match_at - self.region.from];
                (data.clone(), first.start, data.len(), begin, finish)
            } else {
                let mat = &self.matches[self.match_at];
                (self.data.clone(), 0, last.full_end, mat.start, mat.end)
            };
            if !self.per_match_initialized {
                self.replacement_at = if self.replaced.is_some() {
                    0
                } else {
                    first.start
                };
                self.replacement_end = self.replacement_at;
                self.replacement_number = 0;
                self.per_match_initialized = true;
            }
            if self.replacement_at >= end || self.replacement_at >= finish {
                self.match_at += 1;
                self.per_match_initialized = false;
                return false;
            }
            while self.replacement_end < end
                && *budget > 0
                && data[self.replacement_end] != config.terminator()
            {
                self.replacement_end += 1;
                *budget -= 1;
            }
            if self.replacement_end < end && *budget == 0 {
                return false;
            }
            let full_end = self.replacement_end + usize::from(self.replacement_end < end);
            if full_end <= begin {
                self.replacement_at = full_end;
                self.replacement_end = full_end;
                self.replacement_number += 1;
                return false;
            }
            let replaced = self.replaced.is_some();
            let terminated = self.replacement_end < end;
            let cr = config.crlf
                && !config.null_data
                && (!replaced || terminated)
                && self.replacement_end > self.replacement_at
                && data[self.replacement_end - 1] == b'\r';
            let content_end = self.replacement_end - usize::from(cr);
            let mut printed = Printed::plain(
                &self.record(self.region.first),
                true,
                if config.column {
                    Some(begin.saturating_sub(self.replacement_at) as u64 + 1)
                } else {
                    None
                },
            );
            printed.data = data;
            printed.range = self.replacement_at..content_end;
            printed.trim_at = self.replacement_at;
            printed.number = self.region.first as u64 + self.replacement_number as u64 + 1;
            printed.offset = (base + self.replacement_at) as u64;
            printed.cr = cr && !replaced;
            printed.terminated = terminated && !replaced;
            printed.count = 1;
            printed.spans = Spans::One(begin, finish);
            self.printed = Some(printed);
            self.match_at += 1;
            self.per_match_initialized = false;
            return false;
        }
        if config.only_matching {
            if self.match_at >= self.region.to {
                return true;
            }
            let mat = &self.matches[self.match_at];
            if let Some(data) = &self.replaced {
                let (start, end) = self.spans[self.match_at - self.region.from];
                if start == end {
                    self.match_at += 1;
                    return false;
                }
                if self.replacement_end == 0 {
                    while self.rendered_prefix_at < start && *budget > 0 {
                        if data[self.rendered_prefix_at] == config.terminator() {
                            self.rendered_prefix_lines += 1;
                        }
                        self.rendered_prefix_at += 1;
                        *budget -= 1;
                    }
                    if self.rendered_prefix_at < start {
                        return false;
                    }
                    self.replacement_at = start;
                    self.replacement_end = start;
                }
                while self.replacement_end < end
                    && *budget > 0
                    && data[self.replacement_end] != config.terminator()
                {
                    self.replacement_end += 1;
                    *budget -= 1;
                }
                if self.replacement_end < end && *budget == 0 {
                    return false;
                }
                let source_line = self.containing_line(mat.start);
                let record = self.record(source_line);
                let mut printed = Printed::plain(
                    &record,
                    true,
                    if config.column {
                        Some((start + 1) as u64)
                    } else {
                        None
                    },
                );
                printed.data = data.clone();
                let cr = config.crlf
                    && !config.null_data
                    && self.replacement_end > self.replacement_at
                    && data.get(self.replacement_end) == Some(&config.terminator())
                    && data[self.replacement_end - 1] == b'\r';
                printed.range = self.replacement_at..self.replacement_end - usize::from(cr);
                printed.trim_at = self.replacement_at;
                printed.terminated = false;
                printed.cr = false;
                printed.offset = first.start as u64 + start as u64;
                printed.number = self.region.first as u64
                    + self.rendered_prefix_lines as u64
                    + self.replacement_number as u64
                    + 1;
                printed.spans = Spans::One(start, end);
                printed.count = 1;
                self.printed = Some(printed);
                if self.replacement_end >= end {
                    self.match_at += 1;
                    self.replacement_end = 0;
                    self.replacement_number = 0;
                } else {
                    self.replacement_end += 1;
                    self.replacement_at = self.replacement_end;
                    self.replacement_number += 1;
                }
                return false;
            }
            if mat.start == mat.end {
                self.match_at += 1;
                return false;
            }
            let first_line = self.containing_line(mat.start);
            let last_line = self.containing_line(mat.end.max(mat.start + 1).saturating_sub(1));
            if self.line_at < first_line {
                self.line_at = first_line;
            }
            let index = self.line_at;
            let record = self.record(index);
            let begin = mat.start.max(record.content.start).min(record.content.end);
            let end = mat.end.min(record.content.end).max(begin);
            let column = if config.column {
                Some((mat.start - first.start + 1) as u64)
            } else {
                None
            };
            let mut printed = Printed::plain(&record, true, column);
            printed.range = begin..end;
            printed.trim_at = begin;
            printed.terminated = false;
            printed.offset = mat.start as u64;
            printed.spans = Spans::One(begin, end);
            printed.count = 1;
            self.printed = Some(printed);
            if index >= last_line {
                self.match_at += 1;
                self.line_at = 0;
            } else {
                self.line_at += 1;
            }
            return false;
        }
        if let Some(data) = &self.replaced {
            if self.replacement_at >= data.len() {
                return true;
            }
            while self.replacement_end < data.len()
                && *budget > 0
                && data[self.replacement_end] != config.terminator()
            {
                self.replacement_end += 1;
                *budget -= 1;
            }
            if self.replacement_end < data.len() && *budget == 0 {
                return false;
            }
            let index = self.region.first + self.replacement_number;
            let record = self.record(index.min(self.lines.len() - 1));
            let mut printed = Printed::plain(
                &record,
                true,
                if config.column {
                    Some(first_column as u64)
                } else {
                    None
                },
            );
            printed.data = data.clone();
            let terminated = self.replacement_end < data.len();
            let cr = config.crlf
                && !config.null_data
                && terminated
                && self.replacement_end > self.replacement_at
                && data[self.replacement_end - 1] == b'\r';
            printed.range = self.replacement_at..self.replacement_end - usize::from(cr);
            printed.trim_at = self.replacement_at;
            printed.number = index as u64 + 1;
            printed.terminated = terminated;
            printed.cr = cr;
            printed.use_configured_ending = true;
            printed.spans = Spans::Replaced(self.spans.clone());
            printed.count = self.spans.len();
            self.printed = Some(printed);
            self.replacement_number += 1;
            self.replacement_at = self.replacement_end.saturating_add(1);
            self.replacement_end = self.replacement_at;
            return false;
        }
        if self.line_at > self.region.last {
            return true;
        }
        let record = self.record(self.line_at);
        self.printed = Some(Printed::plain(
            &record,
            true,
            if config.column {
                Some(first_column as u64)
            } else {
                None
            },
        ));
        self.line_at += 1;
        false
    }
}

struct Multi {
    data: Arc<Vec<u8>>,
    matches: Arc<Matches>,
    lines: Arc<Vec<Line>>,
    growing_lines: Buffer<Line>,
    regions: Buffer<Region>,
    at: usize,
    line_start: usize,
    match_at: usize,
    plan_at: usize,
    region_at: usize,
    kept: usize,
    last_selected: Option<usize>,
    remaining: usize,
    summary_at: usize,
    covered: usize,
    stop_at: Option<usize>,
    stop_region: Option<usize>,
    stage: u8,
}

impl Multi {
    fn new(data: Vec<u8>, matches: Matches) -> Self {
        Self {
            data: Arc::new(data),
            matches: Arc::new(matches),
            lines: Arc::new(Vec::new()),
            growing_lines: Buffer::new(),
            regions: Buffer::new(),
            at: 0,
            line_start: 0,
            match_at: 0,
            plan_at: 0,
            region_at: 0,
            kept: 0,
            last_selected: None,
            remaining: 0,
            summary_at: 0,
            covered: 0,
            stop_at: None,
            stop_region: None,
            stage: 0,
        }
    }
    fn line_at(&self, at: usize) -> usize {
        self.lines
            .partition_point(|line| line.start <= at)
            .saturating_sub(1)
    }
    fn prepare(&mut self, config: &Config, budget: &mut usize) -> bool {
        if self.stage >= 2 {
            return true;
        }
        if self.stage == 0 {
            while self.at < self.data.len() && *budget > 0 {
                let at = self.at;
                if self.data[at] == config.terminator()
                    && (!self.growing_lines.reserve(1, budget) || *budget == 0)
                {
                    return false;
                }
                self.at += 1;
                *budget -= 1;
                if self.data[at] == config.terminator() {
                    let cr = config.crlf
                        && !config.null_data
                        && at > self.line_start
                        && self.data[at - 1] == b'\r';
                    self.growing_lines.values.push(Line {
                        start: self.line_start,
                        end: at - usize::from(cr),
                        full_end: at + 1,
                        cr,
                    });
                    self.line_start = at + 1;
                }
            }
            if self.at < self.data.len() {
                return false;
            }
            if self.line_start < self.data.len() {
                if !self.growing_lines.reserve(1, budget) || *budget == 0 {
                    return false;
                }
                *budget -= 1;
                let end = self.data.len();
                let cr = config.crlf && !config.null_data && self.data[end - 1] == b'\r';
                self.growing_lines.values.push(Line {
                    start: self.line_start,
                    end: end - usize::from(cr),
                    full_end: end,
                    cr,
                });
            }
            self.lines = Arc::new(self.growing_lines.take());
            self.stage = 1;
        }
        while self.match_at < self.matches.len() && *budget > 0 {
            if !self.regions.reserve(1, budget) || *budget == 0 {
                return false;
            }
            let mat = &self.matches[self.match_at];
            if self.lines.is_empty()
                || mat.start >= self.data.len() && self.data.last() == Some(&config.terminator())
            {
                self.match_at = self.matches.len();
                break;
            }
            let first = self.line_at(mat.start);
            let last = self.line_at(mat.end.max(mat.start + 1).saturating_sub(1));
            if config.stop_on_nonmatch && !config.invert && self.stop_at.is_none() {
                if let Some(previous) = self.regions.last().filter(|region| region.last + 1 < first)
                {
                    self.stop_at = Some(previous.last + 1);
                    self.stop_region = Some(self.regions.len());
                }
            }
            if self.regions.last().is_some_and(|region| {
                region.last >= first
                    || !config.record_context && region.last.saturating_add(1) == first
            }) {
                let region = self.regions.values.last_mut().unwrap();
                region.last = region.last.max(last);
                region.to = self.match_at + 1;
            } else {
                self.regions.values.push(Region {
                    first,
                    last,
                    from: self.match_at,
                    to: self.match_at + 1,
                });
            }
            self.match_at += 1;
            *budget -= 1;
        }
        if self.match_at < self.matches.len() {
            return false;
        }
        self.stage = 2;
        true
    }
    fn count(
        &mut self,
        config: &Config,
        tally: &mut Tally,
        count: &mut u64,
        budget: &mut usize,
    ) -> bool {
        if self.summary_at == 0 {
            if let Some(end) = self.stop_region {
                self.regions.values.truncate(end);
            }
        }
        let limit = config
            .max_count
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(usize::MAX);
        while self.summary_at < self.regions.len() && *budget > 0 {
            let region = self.regions[self.summary_at];
            self.covered += region.last - region.first + 1;
            if !config.invert
                && (if config.summary() && !config.record_context {
                    tally.matches < limit as u64
                } else {
                    self.summary_at < limit
                })
            {
                self.kept += 1;
                tally.matched_lines += (region.last - region.first + 1) as u64;
                let omitted = self
                    .matches
                    .get(region.to.saturating_sub(1))
                    .is_some_and(|m| m.start == self.data.len() && m.end == m.start);
                tally.matches += (region.to - region.from - usize::from(omitted)) as u64;
            }
            self.summary_at += 1;
            *budget -= 1;
        }
        if self.summary_at < self.regions.len() {
            return false;
        }
        let units = if config.invert {
            self.lines.len().saturating_sub(self.covered)
        } else {
            self.regions.len()
        };
        if config.invert {
            self.kept = units.min(limit);
        }
        self.remaining = self.kept;
        tally.selected = self.kept > 0
            && (config.record_context || !config.summary() || config.invert || tally.matches > 0);
        if config.invert {
            tally.matched_lines = self.kept as u64;
        }
        *count = if config.record_context {
            if config.invert {
                if config.only_matching && config.count_only {
                    0
                } else {
                    self.kept as u64
                }
            } else if config.count_matches || config.only_matching {
                tally.matches
            } else {
                tally.matched_lines
            }
        } else if config.invert {
            0
        } else {
            tally.matches
        };
        self.stage = 3;
        true
    }
    fn record(&self, index: usize, found: Range<usize>) -> Record {
        let line = self.lines[index];
        Record {
            data: self.data.clone(),
            content: line.start..line.end,
            full_end: line.full_end,
            number: index as u64 + 1,
            offset: line.start as u64,
            cr: line.cr,
            terminated: line.full_end > line.end + usize::from(line.cr),
            matches: self.matches.clone(),
            matched: !found.is_empty(),
            found,
        }
    }
}

struct Input {
    name: Arc<Vec<u8>>,
    label: Option<Vec<u8>>,
    notice_label: Option<Vec<u8>>,
    binary_converted: bool,
    tally: Tally,
    searched_override: Option<u64>,
    pending: Buffer<u8>,
    queued: VecDeque<u8>,
    record: Vec<u8>,
    scan: usize,
    record_end: Option<usize>,
    search: Option<Search>,
    scratch: Option<Search>,
    searching_number: u64,
    searching_offset: u64,
    searching_cr: bool,
    searching_terminated: bool,
    number: u64,
    offset: u64,
    count: u64,
    selected: u64,
    before: VecDeque<Record>,
    flush_before: VecDeque<Record>,
    ready: Option<Job>,
    trailing: Option<Job>,
    jobs: VecDeque<Job>,
    pieces: VecDeque<Piece>,
    after: u64,
    last_printed: Option<u64>,
    stop_seen: bool,
    stop_armed: bool,
    finishing: bool,
    finalized: bool,
    done: bool,
    multi: Option<Multi>,
}

impl Input {
    fn new(begin: Begin, config: &Config) -> Self {
        Self {
            name: Arc::new(begin.name),
            notice_label: begin.label.clone(),
            label: if config.heading && !config.summary() {
                None
            } else {
                begin.label
            },
            binary_converted: begin.binary_converted,
            tally: Tally {
                nul: begin.binary_offset,
                skipped: begin.binary_skipped,
                ..Tally::default()
            },
            searched_override: None,
            pending: Buffer::new(),
            queued: VecDeque::new(),
            record: Vec::new(),
            scan: 0,
            record_end: None,
            search: None,
            scratch: None,
            searching_number: 0,
            searching_offset: 0,
            searching_cr: false,
            searching_terminated: false,
            number: 0,
            offset: 0,
            count: 0,
            selected: 0,
            before: VecDeque::new(),
            flush_before: VecDeque::new(),
            ready: None,
            trailing: None,
            jobs: VecDeque::new(),
            pieces: VecDeque::new(),
            after: 0,
            last_printed: None,
            stop_seen: false,
            stop_armed: false,
            finishing: false,
            finalized: false,
            done: config.max_count == Some(0) || begin.binary_skipped,
            multi: None,
        }
    }
    fn append(&mut self, input: &[u8]) {
        if self.pending.values.capacity() == 0
            && self.pending.previous.is_none()
            && self.queued.is_empty()
        {
            self.pending.values = input.to_vec();
            return;
        }
        if self.pending.previous.is_none()
            && self.queued.is_empty()
            && self
                .pending
                .values
                .capacity()
                .saturating_sub(self.pending.values.len())
                >= input.len()
        {
            self.pending.values.extend_from_slice(input);
            return;
        }
        if self.pending.previous.is_none() && self.queued.is_empty() {
            let capacity = self.pending.len().saturating_add(INPUT_LIMIT);
            if self.queued.capacity() < capacity {
                self.queued = VecDeque::with_capacity(capacity);
            }
            self.pending.reserve(INPUT_LIMIT, &mut 0);
        }
        debug_assert!(self.queued.capacity() - self.queued.len() >= input.len());
        self.queued.extend(input);
        // A feed can precede drain. This rate retires the old allocation before
        // incoming bytes fill its replacement, without a per-chunk allocation.
        self.collect(&mut (input.len() * 2 + WORK));
    }

    fn collect(&mut self, budget: &mut usize) -> bool {
        if !self.pending.reserve(0, budget) {
            return false;
        }
        while !self.queued.is_empty() && *budget > 0 {
            let bytes = self.queued.as_slices().0;
            let copied = self.pending.append(bytes, budget);
            self.queued.drain(..copied);
        }
        self.pending.previous.is_none() && self.queued.is_empty()
    }

    fn notice(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(label) = &self.notice_label {
            out.extend_from_slice(label);
            out.extend_from_slice(b": ");
        }
        out.extend_from_slice(
            format!(
                "binary file matches (found \"\\0\" byte around offset {})\n",
                self.tally.nul.unwrap_or(0)
            )
            .as_bytes(),
        );
        out
    }
    fn listed(&mut self, config: &Config) {
        if !config.quiet && self.tally.selected == config.files_only {
            self.pieces
                .push_back(Piece::slice(self.name.clone(), 0..self.name.len()));
            self.pieces.push_back(Piece::bytes(if config.null {
                b"\0".to_vec()
            } else {
                config.end().to_vec()
            }));
        }
    }
    fn finalize(&mut self, config: &Config) {
        if self.finalized {
            return;
        }
        self.finalized = true;
        if let Some(searched) = self.searched_override {
            self.tally.searched = searched;
        } else if let Some(offset) = self.tally.nul {
            self.tally.searched = offset;
        }
        if config.max_count == Some(0) || self.tally.skipped {
            return;
        }
        if config.files_only || config.files_without_match || config.quiet {
            self.listed(config);
        } else if config.count_only || config.count_matches {
            if config.multiline && !config.record_context && config.invert {
                self.tally.selected = false;
                return;
            }
            if self.tally.selected || config.include_zero {
                let mut head = Vec::new();
                if let Some(label) = &self.label {
                    head.extend_from_slice(label);
                    head.push(if config.null { 0 } else { b':' });
                }
                head.extend_from_slice(self.count.to_string().as_bytes());
                head.extend_from_slice(config.end());
                self.pieces.push_back(Piece::bytes(head));
            }
        }
    }
    fn hold(&mut self, record: Record, config: &Config) {
        if config.context() && config.context_before > 0 {
            if self.before.len() == config.context_before {
                self.before.pop_front();
            }
            self.before.push_back(record);
        }
    }
    fn schedule(&mut self, record: Record, selected: bool, config: &Config) {
        self.last_printed = Some(record.number);
        self.jobs
            .push_back(Job::Line(LineJob::new(record, selected)));
        if self.jobs.len() > 1 {
            debug_assert!(self.jobs.len() <= 2);
        }
        let _ = config;
    }
    fn accept(&mut self, record: Record, config: &Config) {
        let hit = record.hit(config.invert);
        if config.quiet || config.files_only || config.files_without_match {
            if hit {
                self.tally.selected = true;
                if config.counts() {
                    self.tally.matched_lines += 1;
                    if !config.invert {
                        self.tally.matches += record.found.len() as u64;
                    }
                    self.selected += 1;
                    if config.max_count.is_some_and(|n| self.selected >= n) {
                        self.done = true;
                    }
                } else {
                    self.done = true;
                }
            }
            return;
        }
        if self.binary_converted && !hit && !config.count_only && !config.count_matches {
            return;
        }
        if !hit && self.stop_armed {
            if !config.count_only && !config.count_matches && (config.passthru || self.after > 0) {
                self.schedule(record, false, config);
            }
            self.done = true;
            return;
        }
        if !hit
            && config.stop_on_nonmatch
            && config.invert
            && !config.passthru
            && self.stop_seen
            && !self.stop_armed
        {
            self.stop_armed = true;
            self.hold(record, config);
            return;
        }
        let selecting = config.max_count.is_none_or(|n| self.selected < n);
        if hit && selecting {
            self.stop_seen = true;
            if config.stop_on_nonmatch && (!config.invert || config.passthru) {
                self.stop_armed = true;
            }
            self.selected += 1;
            self.tally.selected = true;
            if config.counts() {
                self.tally.matched_lines += 1;
                if !config.invert {
                    self.tally.matches += record.found.len() as u64;
                }
            }
            if config.count_only || config.count_matches {
                self.count += if !config.invert && (config.count_matches || config.only_matching) {
                    record.found.len() as u64
                } else if config.invert && config.only_matching && config.count_only {
                    0
                } else {
                    1
                };
            } else if self.binary_converted {
                self.tally.binary = true;
                self.pieces.push_back(Piece::bytes(self.notice()));
                self.done = true;
            } else if config.context() {
                let first = self.before.front().map_or(record.number, |r| r.number);
                if self.last_printed.is_some_and(|last| first > last + 1) {
                    if let Some(separator) = &config.context_separator {
                        let mut out = separator.clone();
                        out.extend_from_slice(config.end());
                        self.pieces.push_back(Piece::bytes(out));
                    }
                }
                self.flush_before = std::mem::take(&mut self.before);
                self.ready = Some(Job::Line(LineJob::new(record, true)));
                self.after = config.context_after;
            } else {
                self.schedule(record, true, config);
            }
        } else if config.passthru {
            if !selecting {
                self.done = true;
                return;
            }
            self.schedule(record, false, config);
        } else if self.after > 0 {
            self.after -= 1;
            self.schedule(record, hit, config);
        } else {
            self.hold(record, config);
        }
        if config.max_count.is_some_and(|n| self.selected >= n) && self.after == 0 {
            self.done = true;
        }
    }
}

struct Rg {
    config: Config,
    program: Program,
    input: Option<Input>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let mut config: Config = parse_config(config)?;
    let patterns = if config.never_match {
        Vec::new()
    } else {
        config.pattern.split('\n').map(str::to_owned).collect()
    };
    let options = Options {
        capture_requirement: if !config.summary()
            && !config.json
            && config
                .replace
                .as_ref()
                .is_some_and(|template| template.contains(&b'$'))
        {
            CaptureRequirement::All
        } else {
            CaptureRequirement::WholeMatch
        },
        ignore_case: config.ignore_case,
        smart_case: config.smart_case,
        unicode: config.unicode,
        multiline: config.multiline,
        dotall: config.multiline && config.multiline_dotall,
        crlf: config.crlf,
        whole_word: config.whole_word,
        line_regexp: config.line_regexp,
        fixed: config.fixed_string,
        null_data: config.null_data,
        ban_nul: config.ban_nul,
        regex_size_limit: config.regex_size_limit,
        dfa_size_limit: config.dfa_size_limit,
    };
    let program = Program::with_options(&patterns, options)?;
    config.multiline = program.is_multiline();
    config.record_context = program.uses_record_context();
    if config.json {
        config.context_separator = None;
    }
    config.max_capture_name = program
        .capture_names()
        .map(|(name, _)| name.len())
        .max()
        .unwrap_or(0);
    Ok(Box::new(Rg {
        config,
        program,
        input: None,
    }))
}

impl Rg {
    fn input(&mut self) -> Result<&mut Input, StreamError> {
        self.input
            .as_mut()
            .ok_or_else(|| StreamError::new("rg stream fed before begin"))
    }
    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let config = &self.config;
        let program = &self.program;
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| StreamError::new("rg stream fed before begin"))?;
        let mut budget = WORK;
        while budget > 0 {
            if !input.collect(&mut budget) || budget == 0 {
                break;
            }
            if let Some(piece) = input.pieces.front_mut() {
                if piece.poll(out, &mut budget) {
                    input.pieces.pop_front();
                }
                if budget < 8 {
                    break;
                }
                continue;
            }
            if let Some(job) = input.jobs.front_mut() {
                if job.poll(
                    config,
                    program,
                    &input.label,
                    &input.name,
                    &mut input.pieces,
                    &mut budget,
                ) {
                    input.jobs.pop_front();
                }
                budget = budget.saturating_sub(1);
                continue;
            }
            if let Some(record) = input.flush_before.pop_front() {
                input.schedule(record, false, config);
                budget -= 1;
                continue;
            }
            if let Some(job) = input.ready.take() {
                input.last_printed = Some(match &job {
                    Job::Line(line) => line.record.number,
                    Job::Region(region) => region.region.last as u64 + 1,
                });
                input.jobs.push_back(job);
                budget -= 1;
                continue;
            }
            if let Some(job) = input.trailing.take() {
                input.jobs.push_back(job);
                budget -= 1;
                continue;
            }
            if input.done {
                if input.finishing {
                    input.finalize(config);
                }
                break;
            }
            if let Some(search) = input.search.as_mut() {
                if !search.step(program, budget) {
                    break;
                }
                let mut search = input.search.take().unwrap();
                let mut matches = search.take_matches();
                let mut data = search.take_haystack();
                input.scratch = Some(search);
                if config.multiline {
                    input.multi = Some(Multi::new(data, matches));
                } else {
                    let content = data.len();
                    if input.searching_cr {
                        data.push(b'\r');
                    }
                    if input.searching_terminated {
                        data.push(config.terminator());
                    }
                    let matched = !matches.is_empty();
                    if !input.searching_terminated
                        && !input.searching_cr
                        && matches
                            .last()
                            .is_some_and(|m| m.start == content && m.end == content)
                    {
                        matches.pop();
                    }
                    let count = matches.len();
                    let full_end = data.len();
                    let record = Record {
                        data: Arc::new(data),
                        content: 0..content,
                        full_end,
                        number: input.searching_number,
                        offset: input.searching_offset,
                        cr: input.searching_cr,
                        terminated: input.searching_terminated,
                        matches: Arc::new(matches),
                        found: 0..count,
                        matched,
                    };
                    input.accept(record, config);
                }
                break;
            }
            if let Some(multi) = input.multi.as_mut() {
                if !multi.prepare(config, &mut budget) {
                    break;
                }
                if multi.stage == 2 {
                    if !multi.count(config, &mut input.tally, &mut input.count, &mut budget) {
                        break;
                    }
                    if config.summary() {
                        input.done = true;
                        continue;
                    }
                    if input.binary_converted {
                        if input.tally.selected {
                            input.tally.binary = true;
                            input.pieces.push_back(Piece::bytes(input.notice()));
                        }
                        input.done = true;
                        continue;
                    }
                }
                if multi.plan_at >= multi.lines.len() {
                    input.done = true;
                    continue;
                }
                let index = multi.plan_at;
                while multi.region_at < multi.regions.len()
                    && multi.regions[multi.region_at].last < index
                {
                    multi.region_at += 1;
                }
                let region = multi
                    .regions
                    .get(multi.region_at)
                    .copied()
                    .filter(|r| r.first <= index && index <= r.last);
                let selected = if config.invert {
                    region.is_none() && (multi.remaining > 0 || input.after > 0)
                } else {
                    region.is_some() && (multi.region_at < multi.kept || input.after > 0)
                };
                if config.invert && selected {
                    multi.remaining = multi.remaining.saturating_sub(1);
                }
                let line = multi.lines[index];
                let from = multi.matches.partition_point(|m| m.start < line.start);
                let to = multi
                    .matches
                    .partition_point(|m| m.end <= line.full_end)
                    .max(from);
                let mut record = multi.record(index, from..to);
                if config.record_context {
                    record.matched = region.is_some();
                    record.found = region.map_or(0..0, |region| region.from..region.to);
                    if !record.terminated
                        && !record.cr
                        && record.found.end > record.found.start
                        && multi.matches[record.found.end - 1].start == multi.data.len()
                    {
                        record.found.end -= 1;
                    }
                }
                multi.plan_at += 1;
                if selected {
                    input.selected += 1;
                    if config.counts()
                        && config.max_count.is_some_and(|limit| input.selected > limit)
                    {
                        if let Some(region) = region.filter(|_| !config.invert) {
                            input.tally.matched_lines += (region.last - region.first + 1) as u64;
                            let omitted = multi
                                .matches
                                .get(region.to.saturating_sub(1))
                                .is_some_and(|mat| {
                                    mat.start == multi.data.len() && mat.end == mat.start
                                });
                            input.tally.matches +=
                                (region.to - region.from - usize::from(omitted)) as u64;
                        } else {
                            input.tally.matched_lines += 1;
                        }
                    }
                    if config.context() {
                        let first = input.before.front().map_or(record.number, |r| r.number);
                        if input.last_printed.is_some_and(|last| first > last + 1) {
                            if let Some(separator) = &config.context_separator {
                                let mut bytes = separator.clone();
                                bytes.extend_from_slice(config.end());
                                input.pieces.push_back(Piece::bytes(bytes));
                            }
                        }
                        input.flush_before = std::mem::take(&mut input.before);
                        input.after =
                            if config.max_count.is_some_and(|limit| input.selected > limit) {
                                input.after.saturating_sub(1)
                            } else {
                                config.context_after
                            };
                    }
                    if let Some(region) =
                        region.filter(|_| !config.invert && !config.record_context)
                    {
                        multi.plan_at = region.last + 1;
                        input.ready = Some(Job::Region(RegionJob::new(multi, region)));
                        if multi.region_at + 1 == multi.regions.len()
                            && input.after == 0
                            && (config.passthru || config.context_after > 0)
                            && config
                                .max_count
                                .is_some_and(|limit| input.selected >= limit)
                        {
                            input.trailing = Some(Job::Line(LineJob::new(
                                multi.record(region.first, 0..0),
                                false,
                            )));
                        }
                    } else {
                        input.ready = Some(Job::Line(LineJob::new(record, true)));
                    }
                } else if config.passthru || input.after > 0 {
                    input.after = input.after.saturating_sub(1);
                    if !config.invert
                        && !config.record_context
                        && input.after == 0
                        && !config.passthru
                        && config
                            .max_count
                            .is_some_and(|limit| input.selected >= limit)
                        && multi.region_at + 1 == multi.regions.len()
                    {
                        input.trailing = Some(Job::Line(LineJob::new(record.clone(), false)));
                    }
                    input.ready = Some(Job::Line(LineJob::new(record, false)));
                } else if config.context() && config.context_before > 0 {
                    if input.before.len() == config.context_before {
                        input.before.pop_front();
                    }
                    input.before.push_back(record);
                }
                if selected {
                    multi.last_selected = Some(multi.plan_at - 1);
                }
                if config
                    .max_count
                    .is_some_and(|limit| input.selected >= limit)
                {
                    let last = if config.invert {
                        multi.last_selected
                    } else {
                        multi.regions.get(multi.kept - 1).map(|r| r.last)
                    };
                    if last.is_some_and(|last| multi.plan_at > last)
                        && (input.after == 0 || config.passthru)
                    {
                        input.done = true;
                    }
                }
                if multi.stop_at.is_some_and(|stop| multi.plan_at > stop) {
                    input.done = true;
                }
                budget = budget.saturating_sub(1);
                continue;
            }
            if config.multiline {
                if input.finishing {
                    let data = input.pending.take();
                    input.tally.searched = data.len() as u64;
                    input.search = Some(program.start(data, true));
                    continue;
                }
                break;
            }
            if input.record_end.is_none() {
                let end = input.pending.len().min(input.scan.saturating_add(budget));
                while input.scan < end {
                    let at = input.scan;
                    input.scan += 1;
                    budget -= 1;
                    if input.pending[at] == config.terminator() {
                        input.record_end = Some(at);
                        break;
                    }
                }
            }
            let terminated = input.record_end.is_some();
            if !terminated
                && !(input.finishing
                    && input.scan == input.pending.len()
                    && !input.pending.is_empty())
            {
                if input.finishing && input.pending.is_empty() {
                    input.done = true;
                    input.finalize(config);
                }
                break;
            }
            let end = input.record_end.unwrap_or(input.pending.len());
            let next = end + usize::from(terminated);
            let last = next == input.pending.len();
            let mut data = if input.pending.start == 0 && last {
                let mut data = input.pending.take();
                data.truncate(end);
                data
            } else {
                if input.record.capacity() == 0 {
                    input.record = Vec::with_capacity(end);
                }
                let start = input.record.len();
                let copied = (end - start).min(budget);
                input
                    .record
                    .extend_from_slice(&input.pending[start..start + copied]);
                budget -= copied;
                if start + copied < end {
                    break;
                }
                input.pending.consume(next);
                std::mem::take(&mut input.record)
            };
            let raw_len = data.len();
            let cr = config.crlf && !config.null_data && data.last() == Some(&b'\r');
            if cr {
                data.pop();
            }
            input.number += 1;
            input.searching_number = input.number;
            input.searching_offset = input.offset;
            input.searching_cr = cr;
            input.searching_terminated = terminated;
            input.offset += raw_len as u64 + u64::from(terminated);
            input.tally.searched = input.offset;
            input.scan = 0;
            input.record_end = None;
            let all = !(config.quiet || config.files_only || config.files_without_match)
                || config.counts();
            input.search = Some(if let Some(mut scratch) = input.scratch.take() {
                scratch.reset(data, all);
                scratch
            } else {
                program.start(data, all)
            });
        }
        Ok(())
    }
}

impl Stream for Rg {
    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let begin: Begin = parse_config(config)?;
        if !matches!(
            begin.binary_mode.as_str(),
            "" | "text" | "convert" | "note" | "quit"
        ) {
            return Err(StreamError::new("unknown rg binary mode"));
        }
        self.input = Some(Input::new(begin, &self.config));
        Ok(())
    }
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if input.len() > INPUT_LIMIT {
            return Err(StreamError::new("rg input chunk exceeds 96 KiB"));
        }
        let state = self.input()?;
        if state.finishing {
            return Err(StreamError::new("rg stream fed after finish"));
        }
        if state.done {
            return Ok(());
        }
        state.append(input);
        self.step(out)
    }
    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if index == 0 {
            return self.feed(input, out);
        }
        if index == 2 {
            return crate::rg_format::format(input, out);
        }
        if index != 1 {
            return Err(StreamError::new("unknown rg input"));
        }
        let metadata: Metadata = parse_config(input)?;
        let state = self.input()?;
        if let Some(offset) = metadata.binary_offset {
            state.tally.nul = Some(offset);
        }
        if let Some(converted) = metadata.binary_converted {
            state.binary_converted = converted;
        }
        if let Some(skipped) = metadata.binary_skipped {
            state.tally.skipped = skipped;
            if skipped {
                state.done = true;
            }
        }
        if let Some(searched) = metadata.searched {
            state.searched_override = Some(searched);
            state.tally.searched = searched;
        }
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.input()?.finishing = true;
        self.step(out)
    }
    fn busy(&self) -> bool {
        self.input.as_ref().is_some_and(|state| {
            state.pending.previous.is_some()
                || !state.queued.is_empty()
                || !state.pieces.is_empty()
                || !state.jobs.is_empty()
                || !state.flush_before.is_empty()
                || state.ready.is_some()
                || state.trailing.is_some()
                || state.search.is_some()
                || state.multi.is_some() && !state.done
                || !state.done
                    && (!self.config.multiline
                        && (state.scan < state.pending.len() || state.record_end.is_some())
                        || state.finishing)
                || state.finishing && !state.finalized
        })
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out)
    }
    fn done(&self) -> bool {
        self.input.as_ref().is_some_and(|state| state.done)
    }
    fn status(&self) -> i32 {
        if self
            .input
            .as_ref()
            .is_some_and(|state| state.tally.selected)
        {
            0
        } else {
            1
        }
    }
    fn metadata(&self, out: &mut Vec<u8>) {
        if let Some(state) = &self.input {
            serde_json::to_writer(out, &state.tally).expect("rg tally serializes");
        } else {
            #[derive(Serialize)]
            struct Compiled<'a> {
                terms: &'a Option<crate::rg_matcher::SearchHints>,
            }
            serde_json::to_writer(
                out,
                &Compiled {
                    terms: &self.program.required_terms,
                },
            )
            .expect("rg prefixes serialize");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{WORK, open};
    use serde_json::{Value, json};

    fn run(data: &[u8], config: Value) -> (Vec<u8>, Value, usize) {
        let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
        stream
            .begin(br#"{"name":"<stdin>","label":null,"binary_mode":"text"}"#)
            .unwrap();
        let mut out = Vec::new();
        let mut calls = 0;
        for chunk in data.chunks(16 * 1024) {
            let before = out.len();
            stream.feed(chunk, &mut out).unwrap();
            assert!(out.len() - before <= WORK);
            while stream.busy() {
                let before = out.len();
                stream.drain(&mut out).unwrap();
                assert!(out.len() - before <= WORK);
                calls += 1;
                assert!(calls < 1_000_000);
            }
            if stream.done() {
                break;
            }
        }
        stream.finish(&mut out).unwrap();
        while stream.busy() {
            let before = out.len();
            stream.drain(&mut out).unwrap();
            assert!(out.len() - before <= WORK);
            calls += 1;
            assert!(calls < 1_000_000);
        }
        let mut metadata = Vec::new();
        stream.metadata(&mut metadata);
        (out, serde_json::from_slice(&metadata).unwrap(), calls)
    }

    #[test]
    fn flat_buffer_growth_copies_at_most_its_budget() {
        let mut buffer = super::Buffer::new();
        let mut expected = Vec::new();
        let mut pauses = 0;
        for value in 0..4097 {
            loop {
                let before = buffer.values.len();
                let previous = buffer.previous.as_ref().map(Vec::len);
                let mut budget = 1;
                let count = buffer.append(&[value], &mut budget);
                assert_eq!(budget, 0);
                if count == 1 {
                    expected.push(value);
                    break;
                }
                pauses += 1;
                if previous.is_some() {
                    assert!(buffer.values.len() <= before + 1);
                } else {
                    assert!(buffer.values.len() <= 1);
                }
                assert_eq!(&*buffer, expected);
            }
        }
        assert!(pauses > 2048);
        assert_eq!(buffer.take(), expected);
    }

    #[test]
    fn buffer_growth_copies_only_unconsumed_values_within_its_budget() {
        let mut buffer = super::Buffer::new();
        let values = (0..4096).collect::<Vec<_>>();
        assert_eq!(buffer.append(&values, &mut 4096), 4096);
        buffer.consume(2048);
        let mut calls = 0;
        loop {
            let mut budget = 1;
            let complete = buffer.reserve(4096, &mut budget);
            assert_eq!(&*buffer, &values[2048..]);
            calls += 1;
            if complete {
                break;
            }
            assert_eq!(budget, 0);
            assert!(calls < 2048);
        }
        assert_eq!(calls, 2048);
        assert_eq!(buffer.take(), values[2048..]);
    }

    #[test]
    fn input_growth_accepts_repeated_feeds_before_drain() {
        let mut input = super::Input::new(super::Begin::default(), &super::Config::default());
        let mut expected = Vec::new();
        let mut growths = 0;
        for at in 0..257 {
            let len = [1, super::INPUT_LIMIT, 19, 64 * 1024, 0][at % 5];
            let bytes = vec![(at % 251) as u8; len];
            input.append(&bytes);
            expected.extend_from_slice(&bytes);
            growths += usize::from(input.pending.previous.is_some());
            assert_eq!(input.pending.len() + input.queued.len(), expected.len());
        }
        assert!(growths > 0);
        while !input.collect(&mut 1) {}
        assert_eq!(input.pending.take(), expected);
        assert!(input.queued.is_empty());
    }

    #[test]
    fn ordinary_records_preserve_offsets_across_feeds_while_busy() {
        let data = [
            b"x\r\n".to_vec(),
            b"a".repeat(70_000),
            b"needle\r\nneedle\r\n".to_vec(),
            b"b".repeat(1_000),
            b"needle\r".to_vec(),
        ]
        .concat();
        let config = serde_json::to_vec(&json!({
            "pattern":"(needle)", "replace":"<$1>", "only_matching":true,
            "crlf":true, "line_numbers":true, "byte_offsets":true, "column":true, "stats":true,
        }))
        .unwrap();
        for chunk_size in [7, 16_381, 64 * 1024, super::INPUT_LIMIT] {
            for drain_feeds in [false, true] {
                let mut stream = open(&config).unwrap();
                stream.begin(b"{}").unwrap();
                let mut out = Vec::new();
                for chunk in data.chunks(chunk_size) {
                    let before = out.len();
                    stream.feed(chunk, &mut out).unwrap();
                    assert!(out.len() - before <= WORK);
                    while drain_feeds && stream.busy() {
                        let before = out.len();
                        stream.drain(&mut out).unwrap();
                        assert!(out.len() - before <= WORK);
                    }
                }
                stream.finish(&mut out).unwrap();
                while stream.busy() {
                    let before = out.len();
                    stream.drain(&mut out).unwrap();
                    assert!(out.len() - before <= WORK);
                }
                assert_eq!(
                    out,
                    b"2:70001:70003:<needle>\r\n3:1:70011:<needle>\r\n4:1001:71019:<needle>\r\n",
                    "chunk_size={chunk_size}, drain_feeds={drain_feeds}",
                );
                let mut metadata = Vec::new();
                stream.metadata(&mut metadata);
                let tally: Value = serde_json::from_slice(&metadata).unwrap();
                assert_eq!(tally["searched"], data.len());
                assert_eq!(tally["matched_lines"], 3);
                assert_eq!(tally["matches"], 3);
            }
        }
    }

    #[test]
    fn many_short_records_do_not_lose_the_last_record() {
        let data = [b"a\r\n".repeat(32_768), b"needle\r\n".to_vec()].concat();
        let (out, tally, _) = run(
            &data,
            json!({"pattern":"needle", "crlf":true, "line_numbers":true, "byte_offsets":true, "stats":true}),
        );
        assert_eq!(out, b"32769:98304:needle\r\n");
        assert_eq!(tally["searched"], data.len());
        assert_eq!(tally["matches"], 1);
    }

    fn matched_record(data: Vec<u8>, program: &super::Program) -> super::Record {
        let mut search = program.start(data, true);
        while !search.step(program, 17) {}
        let matches = std::sync::Arc::new(search.take_matches());
        let data = std::sync::Arc::new(search.take_haystack());
        super::Record {
            content: 0..data.len(),
            full_end: data.len(),
            data,
            number: 1,
            offset: 0,
            cr: false,
            terminated: false,
            found: 0..matches.len(),
            matched: !matches.is_empty(),
            matches,
        }
    }

    #[test]
    fn replacement_bytes_and_spans_resume_with_one_work_unit() {
        let program =
            super::Program::with_options(&["(?<x>a)".into()], super::Options::default()).unwrap();
        let record = matched_record(vec![b'a'; 8192], &program);
        let mut replacement = super::Replacement::new(
            record,
            std::sync::Arc::new(b"<$x>".to_vec()),
            0..8192,
            0..8192,
            1,
        );
        let mut calls = 0;
        while !replacement.poll(&program, &mut 1) {
            calls += 1;
            assert!(calls < 1_000_000);
        }
        assert!(calls > 8192 * 4);
        assert_eq!(replacement.out.take(), b"<a>".repeat(8192));
        assert_eq!(
            replacement.spans.take(),
            (0..8192).map(|at| (at * 3, at * 3 + 3)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn multiline_arrays_resume_with_one_work_unit() {
        let program = super::Program::with_options(
            &["a\\n".into()],
            super::Options {
                multiline: true,
                ..super::Options::default()
            },
        )
        .unwrap();
        let record = matched_record(b"a\nx\n".repeat(8192), &program);
        let matches = std::sync::Arc::try_unwrap(record.matches).ok().unwrap();
        let data = std::sync::Arc::try_unwrap(record.data).ok().unwrap();
        let mut multi = super::Multi::new(data, matches);
        let config = super::Config {
            multiline: true,
            ..super::Config::default()
        };
        let mut calls = 0;
        while !multi.prepare(&config, &mut 1) {
            calls += 1;
            assert!(calls < 1_000_000);
        }
        assert!(calls > 8192 * 5);
        assert_eq!(multi.lines.len(), 16384);
        assert_eq!(multi.regions.len(), 8192);
        for (at, region) in multi.regions.iter().enumerate() {
            assert_eq!(
                (region.first, region.last, region.from, region.to),
                (at * 2, at * 2, at, at + 1)
            );
        }
    }

    #[test]
    fn multiline_stream_keeps_every_feed_while_busy() {
        let mut stream = open(br#"{"pattern":"a\\n","multiline":true,"count_only":true}"#).unwrap();
        stream.begin(b"{}").unwrap();
        let data = b"a\nx\n".repeat(32768);
        let mut out = Vec::new();
        for chunk in data.chunks(1024) {
            stream.feed(chunk, &mut out).unwrap();
        }
        stream.finish(&mut out).unwrap();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        assert_eq!(out, b"32768\n");
    }

    #[test]
    fn growing_input_can_be_discarded_and_replaced() {
        let mut input = super::Input::new(super::Begin::default(), &super::Config::default());
        for _ in 0..100 {
            input.append(&vec![b'a'; 64 * 1024]);
            if input.pending.len() > 1024 * 1024 && input.pending.previous.is_some() {
                break;
            }
        }
        assert!(input.pending.previous.is_some());
        assert!(!std::mem::needs_drop::<super::Line>());
        assert!(!std::mem::needs_drop::<super::Region>());
        drop(input);
        let (out, _, _) = run(b"fresh\n", json!({"pattern":"fresh"}));
        assert_eq!(out, b"fresh\n");
    }

    #[test]
    fn unterminated_cr_counts_toward_the_column_limit() {
        for (preview, expected) in [
            (false, b"[Omitted long matching line]\r\n".as_slice()),
            (true, b"abc [... omitted end of long line]\r\n".as_slice()),
        ] {
            let (out, _, _) = run(
                b"abc\r",
                json!({"pattern":"a","crlf":true,"max_columns":3,"max_columns_preview":preview}),
            );
            assert_eq!(out, expected);
        }
    }

    #[test]
    fn adjacent_selected_lines_keep_one_context_group() {
        let (out, _, _) = run(
            b"x\na\na\n",
            json!({"pattern":"a","line_numbers":true,"context_before":1,"context_after":1}),
        );
        assert_eq!(out, b"1-x\n2:a\n3:a\n");
    }

    #[test]
    fn multiline_before_context_keeps_adjacent_regions_in_one_group() {
        let (out, _, _) = run(
            b"x\na\nb\na\nb\n",
            json!({"pattern":"a\\nb","multiline":true,"line_numbers":true,"context_before":1,"context_after":1}),
        );
        assert_eq!(out, b"1-x\n2:a\n3:b\n4:a\n5:b\n");
    }

    #[test]
    fn multiline_inverted_selected_lines_keep_one_context_group() {
        let (out, _, _) = run(
            b"x\na\na\n",
            json!({"pattern":"x\\n","multiline":true,"invert":true,"line_numbers":true,"context_before":1,"context_after":1}),
        );
        assert_eq!(out, b"1-x\n2:a\n3:a\n");
    }

    #[test]
    fn multiline_match_limit_prints_final_after_context_once() {
        let (out, _, _) = run(
            b"a\na\nb\nb\n",
            json!({"pattern":"a\\nb","multiline":true,"line_numbers":true,"max_count":1,"context_before":1,"context_after":1}),
        );
        assert_eq!(out, b"1-a\n2:a\n3:b\n4-b\n");
    }

    #[test]
    fn inverted_multiline_match_limit_stops_before_passthru_context() {
        let (out, _, _) = run(
            b"x\na\nb\n",
            json!({"pattern":"a\\nb","multiline":true,"invert":true,"passthru":true,"max_count":1}),
        );
        assert_eq!(out, b"x\n");
    }

    #[test]
    fn inverted_multiline_match_limit_counts_all_selected_lines() {
        let (out, _, _) = run(
            b"x\ny\nz\na\nb\n",
            json!({"pattern":"a\\nb","multiline":true,"invert":true,"passthru":true,"max_count":2}),
        );
        assert_eq!(out, b"x\ny\n");
    }

    #[test]
    fn inverted_multiline_context_searches_each_line_for_submatches() {
        let (out, _, _) = run(
            b"a\nb\nx\na\nb\n",
            json!({"pattern":"(?:a\\nb)|","multiline":true,"invert":true,"only_matching":true,"passthru":true}),
        );
        assert_eq!(out, b"\n\n\n\n\n\n\n\n\n\n");
    }

    #[test]
    fn inverted_multiline_context_does_not_print_a_matched_terminator_twice() {
        let (out, _, _) = run(
            b"aa\nx\n",
            json!({"pattern":"a\\n?","multiline":true,"invert":true,"only_matching":true,"passthru":true,"line_numbers":true}),
        );
        assert_eq!(out, b"1-a\n1-a\n2:x\n");
    }

    #[test]
    fn multiline_match_limit_preserves_final_pending_region_context_replay() {
        let (out, _, _) = run(
            b"a\nb\nx\na\nb\n",
            json!({"pattern":"a\\nb","multiline":true,"line_numbers":true,"max_count":1,"context_after":1}),
        );
        assert_eq!(out, b"1:a\n2:b\n3-x\n3-x\n");
        let (out, _, _) = run(
            b"a\nb\nx\na\nb\nx\na\nb\n",
            json!({"pattern":"a\\nb","multiline":true,"line_numbers":true,"max_count":1,"context_after":1}),
        );
        assert_eq!(out, b"1:a\n2:b\n3-x\n");
    }

    #[test]
    fn multiline_after_context_keeps_later_selected_regions_whole() {
        let (out, metadata, _) = run(
            b"a\nb\nx\na\nb\n",
            json!({"pattern":"a\\nb","multiline":true,"line_numbers":true,"max_count":1,"context_after":2,"stats":true}),
        );
        assert_eq!(out, b"1:a\n2:b\n3-x\n4:a\n5:b\n4-a\n");
        assert_eq!(metadata["matches"], 2);
        assert_eq!(metadata["matched_lines"], 4);
    }

    #[test]
    fn multiline_passthru_searches_to_the_end_when_limit_exceeds_matches() {
        let (out, _, _) = run(
            b"a\nb\nx\n",
            json!({"pattern":"a\\nb","multiline":true,"passthru":true,"line_numbers":true,"max_count":2}),
        );
        assert_eq!(out, b"1:a\n2:b\n3-x\n");
    }

    #[test]
    fn inverted_multiline_context_search_yields_for_a_long_line() {
        let data = [b"a".repeat(100_000), b"\nx\n".to_vec()].concat();
        let (out, _, calls) = run(
            &data,
            json!({"pattern":"a+\\n","multiline":true,"invert":true,"only_matching":true,"passthru":true}),
        );
        assert_eq!(out, data);
        assert!(calls > 10);
    }

    #[test]
    fn replacement_locations_are_positions_in_the_replaced_bytes() {
        let (out, _, _) = run(
            "éx xx\n".as_bytes(),
            json!({"pattern":"(?<letter>x)","replace":"<${letter}>","only_matching":true,"byte_offsets":true,"column":true,"line_numbers":true}),
        );
        assert_eq!(out, b"1:3:2:<x>\n1:7:6:<x>\n1:10:9:<x>\n");
    }

    #[test]
    fn ten_thousand_groups_search_without_unused_captures() {
        let pattern = "(a)".repeat(10_000);
        let data = [vec![b'a'; 10_000], vec![b'\n']].concat();
        for quiet in [false, true] {
            let (out, tally, _) = run(
                &data,
                json!({"pattern":pattern, "quiet":quiet, "line_regexp":true}),
            );
            assert_eq!(out, if quiet { Vec::new() } else { data.clone() });
            assert_eq!(tally["selected"], true);
        }
        let (out, _, _) = run(
            &data,
            json!({"pattern":pattern, "replace":"literal", "line_regexp":true}),
        );
        assert_eq!(out, b"literal\n");
        for mode in [
            "quiet",
            "files_only",
            "files_without_match",
            "count_only",
            "count_matches",
            "json",
        ] {
            let mut config = json!({"pattern":pattern, "replace":"$1"});
            config[mode] = json!(true);
            assert!(
                open(&serde_json::to_vec(&config).unwrap()).is_ok(),
                "{mode}"
            );
        }
    }

    #[test]
    fn capture_replacement_reports_scratch_refusal_before_searching() {
        let config = serde_json::to_vec(&json!({
            "pattern":"(a)".repeat(10_000), "replace":"$1",
        }))
        .unwrap();
        let error = open(&config).err().unwrap();
        assert_eq!(
            error.message,
            "regex search working memory exceeds the 67108864 byte limit"
        );
    }

    #[test]
    fn replacement_preserves_whole_named_and_unmatched_capture_priority() {
        let (out, _, _) = run(
            b"a ab\n",
            json!({
                "pattern":"(?<first>a|ab)(?<optional>b)?",
                "replace":"<$0|${first}|$2|${optional}>",
                "only_matching":true,
            }),
        );
        assert_eq!(out, b"<a|a||>\n<ab|a|b|b>\n");
    }

    #[test]
    fn unterminated_final_empty_matches_select_without_a_submatch() {
        let (out, metadata, _) = run(b"x", json!({"pattern":"$","only_matching":true}));
        assert_eq!(out, b"x\n");
        assert_eq!(metadata["selected"], true);
    }

    #[test]
    fn empty_matches_use_byte_positions_and_skip_a_nonempty_matches_end() {
        let (out, _, _) = run(
            "ébx\n".as_bytes(),
            json!({"pattern":"b*","only_matching":true,"byte_offsets":true}),
        );
        assert_eq!(out, b"0:\n1:\n2:b\n4:\n");
    }

    #[test]
    fn multiline_adjacent_matches_share_a_json_region() {
        let (out, _, _) = run(
            b"a\na\nb\na\n",
            json!({"pattern":"a\\n?","multiline":true,"json":true,"line_numbers":true}),
        );
        let records: Vec<Value> = out
            .split(|&byte| byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["data"]["lines"]["text"], "a\na\n");
        assert_eq!(
            records[0]["data"]["submatches"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn multiline_counts_matches_inside_merged_regions() {
        let (out, _, _) = run(
            b"a\na\nb\na\n",
            json!({"pattern":"a\\n?","multiline":true,"count_only":true}),
        );
        assert_eq!(out, b"3\n");
    }

    #[test]
    fn inverted_json_context_reports_real_regex_submatches() {
        let (out, _, _) = run(
            b"x\ny\n",
            json!({"pattern":"x","json":true,"invert":true,"context_before":1,"line_numbers":true}),
        );
        let first: Value =
            serde_json::from_slice(out.split(|&b| b == b'\n').next().unwrap()).unwrap();
        assert_eq!(first["type"], "context");
        assert_eq!(first["data"]["submatches"][0]["match"]["text"], "x");
    }

    #[test]
    fn json_preserves_malformed_bytes() {
        let (out, _, _) = run(
            b"\xffx\n",
            json!({"pattern":"x","json":true,"line_numbers":true,"ban_nul":false}),
        );
        let record: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(record["data"]["lines"]["bytes"], "/3gK");
        assert_eq!(record["data"]["submatches"][0]["start"], 1);
    }

    #[test]
    fn converted_binary_suppresses_passthru_nonmatching_lines() {
        for (data, expected) in [
            (
                b"before\nneedle\ntail\n".as_slice(),
                b"binary file matches (found \"\\0\" byte around offset 13)\n".as_slice(),
            ),
            (b"before\nafter\n".as_slice(), b"".as_slice()),
        ] {
            let mut stream = open(br#"{"pattern":"needle","passthru":true}"#).unwrap();
            stream
                .begin(br#"{"name":"file","binary_mode":"convert","binary_offset":13,"binary_converted":true}"#)
                .unwrap();
            let mut out = Vec::new();
            stream.feed(data, &mut out).unwrap();
            while stream.busy() {
                stream.drain(&mut out).unwrap();
            }
            stream.finish(&mut out).unwrap();
            while stream.busy() {
                stream.drain(&mut out).unwrap();
            }
            assert_eq!(out, expected);
        }
    }

    #[test]
    fn crlf_replacement_column_limit_counts_replaced_bytes() {
        for preview in [false, true] {
            for data in [b"a\r\n".as_slice(), b"a\n".as_slice(), b"a\r".as_slice()] {
                for maximum in [0, 1, 2] {
                    let (out, _, _) = run(
                        data,
                        json!({"pattern":"a","replace":"X","crlf":true,"max_columns":maximum,"max_columns_preview":preview}),
                    );
                    let expected = if data == b"a\r" {
                        if maximum == 1 {
                            if preview {
                                b"X [... 0 more matches]\r\n".as_slice()
                            } else {
                                b"[Omitted long line with 1 matches]\r\n".as_slice()
                            }
                        } else {
                            b"X\r\r\n".as_slice()
                        }
                    } else {
                        b"X\r\n".as_slice()
                    };
                    assert_eq!(out, expected, "{data:?}, M={maximum}, preview={preview}");
                }
            }
        }
    }

    #[test]
    fn crlf_anchors_and_replacements_use_original_line_offsets() {
        let (out, _, _) = run(
            b"ax\r\nbx\n",
            json!({"pattern":"x$","replace":"long","crlf":true,"line_numbers":true,"byte_offsets":true,"column":true}),
        );
        assert_eq!(out, b"1:2:0:along\r\n2:2:4:blong\r\n");
    }

    #[test]
    fn multiline_crlf_replacements_frame_the_rendered_records() {
        for (data, replacement, expected) in [
            (b"a\r\nb\r\n".as_slice(), "X", b"X\r\n".as_slice()),
            (b"a\nb\n".as_slice(), "X", b"X\r\n".as_slice()),
            (b"a\r\nb".as_slice(), "X", b"X\r\n".as_slice()),
            (b"a\r\nb\r".as_slice(), "X", b"X\r\r\n".as_slice()),
            (b"a\r\nb\r\n".as_slice(), "X\r\nY", b"X\r\nY\r\n".as_slice()),
            (b"a\r\nb\r\n".as_slice(), "$0", b"a\r\nb\r\n".as_slice()),
        ] {
            let (out, _, _) = run(
                data,
                json!({"pattern":"a\\r?\\nb","replace":replacement,"crlf":true,"multiline":true}),
            );
            assert_eq!(out, expected, "{data:?}, replace={replacement:?}");
        }
    }

    #[test]
    fn multiline_crlf_match_replacements_keep_only_literal_final_crs() {
        for vimgrep in [false, true] {
            for (data, replacement, expected) in [
                (b"a\nb\n".as_slice(), "X\r", b"X\r\n".as_slice()),
                (b"a\nb".as_slice(), "X\r", b"X\r\r\n".as_slice()),
                (b"a\r\nb\r\n".as_slice(), "X\r\nY", b"X\r\nY\r\n".as_slice()),
                (b"a\r\nb\r\n".as_slice(), "$0", b"a\r\nb\r\n".as_slice()),
            ] {
                let (out, _, _) = run(
                    data,
                    json!({"pattern":"a\\r?\\nb","replace":replacement,"crlf":true,"multiline":true,"only_matching":true,"vimgrep":vimgrep}),
                );
                assert_eq!(
                    out, expected,
                    "{data:?}, replace={replacement:?}, vimgrep={vimgrep}"
                );
            }
        }
        for (data, replacement, expected) in [
            (b"a\nb\n".as_slice(), "X", b"X\r\n".as_slice()),
            (b"a\nb".as_slice(), "X\r", b"X\r\r\n".as_slice()),
            (b"a\r\nb\r".as_slice(), "X", b"X\r\r\n".as_slice()),
        ] {
            let (out, _, _) = run(
                data,
                json!({"pattern":"a\\r?\\nb","replace":replacement,"crlf":true,"multiline":true,"vimgrep":true}),
            );
            assert_eq!(out, expected, "{data:?}, replace={replacement:?}");
        }
    }

    #[test]
    fn multiline_crlf_replacement_limits_measure_rendered_records() {
        for preview in [false, true] {
            for (data, maximum) in [(b"a\r\nb\r\n".as_slice(), 3), (b"a\nb\n".as_slice(), 2)] {
                let config = json!({"pattern":"a\\r?\\nb","replace":"X","crlf":true,"multiline":true,"max_columns":maximum,"max_columns_preview":preview});
                let (out, _, _) = run(data, config.clone());
                assert_eq!(out, b"X\r\n", "{data:?}, M={maximum}, preview={preview}");
                let mut limited = config;
                limited["max_columns"] = json!(maximum - 1);
                let (out, _, _) = run(data, limited);
                assert_ne!(
                    out,
                    b"X\r\n",
                    "{data:?}, M={}, preview={preview}",
                    maximum - 1
                );
                assert!(out.ends_with(b"\r\n"));
            }
        }
    }

    #[test]
    fn multiline_replacement_limits_count_all_matches_in_the_region() {
        for (maximum, preview, expected) in [(3, false, b"2"), (1, true, b"1")] {
            let (out, _, _) = run(
                b"a\r\nba\r\nb\r\n",
                json!({"pattern":"a\\r?\\nb","replace":"X","crlf":true,"multiline":true,"max_columns":maximum,"max_columns_preview":preview}),
            );
            let counts = out
                .iter()
                .copied()
                .filter(|byte| byte.is_ascii_digit())
                .collect::<Vec<_>>();
            assert_eq!(counts, expected);
            assert!(out.ends_with(b"\r\n"));
        }
    }

    #[test]
    fn multiline_null_replacements_preserve_cr_as_record_content() {
        for only_matching in [false, true] {
            for replacement in ["X\r", "X\r\nY"] {
                let (out, _, _) = run(
                    b"a\r\nb\0",
                    json!({"pattern":"a\\r?\\nb","replace":replacement,"crlf":true,"multiline":true,"null_data":true,"ban_nul":false,"only_matching":only_matching}),
                );
                assert_eq!(out, [replacement.as_bytes(), b"\0"].concat());
            }
        }
        for multiline in [false, true] {
            let pattern = if multiline { "a\\r?\\nb" } else { "b" };
            for vimgrep in [false, true] {
                for replace in [None, Some("X")] {
                    let data = b"a\r\nb\r\0";
                    let (out, _, _) = run(
                        data,
                        json!({"pattern":pattern,"replace":replace,"crlf":true,"multiline":multiline,"null_data":true,"ban_nul":false,"vimgrep":vimgrep}),
                    );
                    let expected = if replace.is_none() {
                        data.as_slice()
                    } else if multiline {
                        b"X\r\0".as_slice()
                    } else {
                        b"a\r\nX\r\0".as_slice()
                    };
                    assert_eq!(
                        out, expected,
                        "multiline={multiline}, vimgrep={vimgrep}, replace={replace:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn capture_references_follow_the_upstream_ascii_grammar() {
        let (out, _, _) = run(
            b"a\n",
            json!({"pattern":"(?<x>a)","replace":"${x}-$x-$1x-${x-y}-${4294967296}-$$"}),
        );
        assert_eq!(out, b"a-a--${x-y}--$\n");
    }

    #[test]
    fn preview_counts_graphemes_and_preserves_original_bytes() {
        let (out, _, _) = run(
            "e\u{301}xyz\n".as_bytes(),
            json!({"pattern":".","max_columns":1,"max_columns_preview":true}),
        );
        assert_eq!(out, "e\u{301} [... omitted end of long line]\n".as_bytes());
    }

    #[test]
    fn long_capture_expansion_and_json_each_need_several_drains() {
        let data = [b"a".repeat(100_000), b"\n".to_vec()].concat();
        let (out, _, calls) = run(&data, json!({"pattern":"(a+)","replace":"$1$1"}));
        assert_eq!(out.len(), 200_001);
        assert!(calls > 10);
        let (out, _, calls) = run(&data, json!({"pattern":"a+","json":true}));
        let record: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            record["data"]["lines"]["text"].as_str().unwrap().len(),
            100_001
        );
        assert!(calls > 10);
    }

    #[test]
    fn multiline_replacement_line_numbers_follow_the_rendered_prefix() {
        let (out, _, _) = run(
            b"a\na\n",
            json!({"pattern":"a\\n?","replace":"Q\nR\nS","multiline":true,"only_matching":true,"column":true,"line_numbers":true,"byte_offsets":true}),
        );
        assert_eq!(
            out,
            b"1:1:0:Q\n2:1:0:R\n3:1:0:S\n3:6:5:Q\n4:6:5:R\n5:6:5:S\n"
        );
    }

    #[test]
    fn null_multiline_assertions_keep_nul_in_the_matching_context() {
        for (pattern, data, expected, selected) in [
            ("a$", b"a\0".as_slice(), b"".as_slice(), false),
            ("^a", b"\0a\0".as_slice(), b"".as_slice(), false),
            ("a$", b"a\n\0".as_slice(), b"a\n\0".as_slice(), true),
            ("^a", b"\na\0".as_slice(), b"\na\0".as_slice(), true),
        ] {
            let (out, tally, _) = run(
                data,
                json!({"pattern":pattern,"multiline":true,"null_data":true,"ban_nul":false}),
            );
            assert_eq!(out, expected, "{pattern:?} on {data:?}");
            assert_eq!(tally["selected"], selected, "{pattern:?} on {data:?}");
        }
    }

    #[test]
    fn null_multiline_record_counts_are_distinct_from_match_counts() {
        for (pattern, data, count, matches) in [
            (
                "a",
                b"a a\0".as_slice(),
                b"1\0".as_slice(),
                b"2\0".as_slice(),
            ),
            (
                "^a",
                b"a\na\0".as_slice(),
                b"1\0".as_slice(),
                b"2\0".as_slice(),
            ),
            (
                "a$",
                b"a\na\0".as_slice(),
                b"1\0".as_slice(),
                b"1\0".as_slice(),
            ),
            (
                "^a",
                b"\na\0\na\0".as_slice(),
                b"2\0".as_slice(),
                b"2\0".as_slice(),
            ),
            (
                "a$",
                b"a\n\0a\n\0".as_slice(),
                b"2\0".as_slice(),
                b"2\0".as_slice(),
            ),
        ] {
            for (counts_matches, expected) in [(false, count), (true, matches)] {
                let (out, tally, _) = run(
                    data,
                    json!({"pattern":pattern,"multiline":true,"null_data":true,"ban_nul":false,
                        "count_only":!counts_matches,"count_matches":counts_matches}),
                );
                assert_eq!(
                    out, expected,
                    "{pattern:?} on {data:?}, matches={counts_matches}"
                );
                assert_eq!(tally["selected"], true);
            }
        }
    }

    #[test]
    fn null_multiline_inverted_record_counts_remain_selected() {
        for counts_matches in [false, true] {
            let (out, tally, _) = run(
                b"b\0x\0",
                json!({"pattern":"a$","multiline":true,"null_data":true,"ban_nul":false,
                    "invert":true,"count_only":!counts_matches,"count_matches":counts_matches}),
            );
            assert_eq!(out, b"2\0");
            assert_eq!(tally["selected"], true);
        }
    }

    #[test]
    fn null_record_empty_matches_use_ordinary_rendering_and_selection() {
        for (data, config, expected, selected) in [
            (vec![97, 10], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"only_matching":true}"#).unwrap(), vec![0, 0], true),
            (vec![97, 10], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"only_matching":true,"line_numbers":true,"column":true,"byte_offsets":true}"#).unwrap(), vec![49, 58, 49, 58, 48, 58, 0, 49, 58, 50, 58, 49, 58, 0], true),
            (vec![97, 10], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"vimgrep":true,"line_numbers":true,"column":true}"#).unwrap(), vec![49, 58, 49, 58, 97, 10, 0, 49, 58, 50, 58, 97, 10, 0], true),
            (vec![97, 10], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"count_only":true}"#).unwrap(), vec![49, 0], true),
            (vec![97, 10], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"count_matches":true}"#).unwrap(), vec![50, 0], true),
            (vec![97, 10], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false}"#).unwrap(), vec![97, 10, 0], true),
            (vec![97, 10], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"quiet":true}"#).unwrap(), vec![], true),
            (vec![97, 10, 0], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"only_matching":true}"#).unwrap(), vec![0, 0, 0], true),
            (vec![97, 10, 0], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"only_matching":true,"line_numbers":true,"column":true,"byte_offsets":true}"#).unwrap(), vec![49, 58, 49, 58, 48, 58, 0, 49, 58, 50, 58, 49, 58, 0, 49, 58, 51, 58, 50, 58, 0], true),
            (vec![97, 10, 0], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"vimgrep":true,"line_numbers":true,"column":true}"#).unwrap(), vec![49, 58, 49, 58, 97, 10, 0, 49, 58, 50, 58, 97, 10, 0, 49, 58, 51, 58, 97, 10, 0], true),
            (vec![97, 10, 0], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"count_only":true}"#).unwrap(), vec![49, 0], true),
            (vec![97, 10, 0], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"count_matches":true}"#).unwrap(), vec![51, 0], true),
            (vec![97, 10, 0], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false}"#).unwrap(), vec![97, 10, 0], true),
            (vec![97, 10, 0], serde_json::from_str(r#"{"pattern":"^|$","multiline":true,"null_data":true,"ban_nul":false,"quiet":true}"#).unwrap(), vec![], true),
            (vec![97], serde_json::from_str(r#"{"pattern":"$","multiline":true,"null_data":true,"ban_nul":false,"only_matching":true}"#).unwrap(), vec![97, 0], true),
            (vec![97], serde_json::from_str(r#"{"pattern":"$","multiline":true,"null_data":true,"ban_nul":false,"only_matching":true,"line_numbers":true,"column":true,"byte_offsets":true}"#).unwrap(), vec![49, 58, 48, 58, 97, 0], true),
            (vec![97], serde_json::from_str(r#"{"pattern":"$","multiline":true,"null_data":true,"ban_nul":false,"vimgrep":true,"line_numbers":true,"column":true}"#).unwrap(), vec![49, 58, 97, 0], true),
            (vec![97], serde_json::from_str(r#"{"pattern":"$","multiline":true,"null_data":true,"ban_nul":false,"count_only":true}"#).unwrap(), vec![49, 0], true),
            (vec![97], serde_json::from_str(r#"{"pattern":"$","multiline":true,"null_data":true,"ban_nul":false,"count_matches":true}"#).unwrap(), vec![48, 0], true),
            (vec![97], serde_json::from_str(r#"{"pattern":"$","multiline":true,"null_data":true,"ban_nul":false}"#).unwrap(), vec![97, 0], true),
            (vec![97], serde_json::from_str(r#"{"pattern":"$","multiline":true,"null_data":true,"ban_nul":false,"quiet":true}"#).unwrap(), vec![], true),
        ] {
            let (out, tally, _) = run(&data, config);
            assert_eq!(out, expected);
            assert_eq!(tally["selected"], selected);
        }
    }
}
