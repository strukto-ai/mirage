use std::collections::HashMap;
use std::ops::Range;

use crate::regex::Step;
use crate::regex::parse::Dialect;
use crate::regex::posix::{Options, Posix};

use super::buffer::Buffer;
use super::value::{MAX_LEN, Text};

/// Read one string escape whose backslash ends at `pos`, appending what it
/// spells; returns where the escape ends. An escape awk does not know
/// keeps its backslash.
pub(super) fn read_escape(src: &[u8], pos: usize, out: &mut Vec<u8>) -> usize {
    let esc = src[pos];
    let digits = |from: usize, most: usize, radix: u32| {
        src[from..]
            .iter()
            .take(most)
            .take_while(|d| char::from(**d).is_digit(radix))
            .count()
    };
    if (b'0'..=b'7').contains(&esc) {
        let len = digits(pos, 3, 8);
        out.push(radix_value(&src[pos..pos + len], 8));
        return pos + len;
    }
    if esc == b'x' {
        let len = digits(pos + 1, 2, 16);
        if len > 0 {
            out.push(radix_value(&src[pos + 1..pos + 1 + len], 16));
            return pos + 1 + len;
        }
    }
    let byte = match esc {
        b'\\' | b'/' | b'"' => esc,
        b'a' => 7,
        b'b' => 8,
        b'f' => 12,
        b'n' => b'\n',
        b'r' => b'\r',
        b't' => b'\t',
        b'v' => 11,
        _ => {
            out.extend_from_slice(&[b'\\', esc]);
            return pos + 1;
        }
    };
    out.push(byte);
    pos + 1
}

fn radix_value(digits: &[u8], radix: u32) -> u8 {
    let value = digits.iter().fold(0u32, |acc, d| {
        acc * radix + char::from(*d).to_digit(radix).unwrap_or(0)
    });
    (value & 0xFF) as u8
}

/// The escapes awk reads in an assigned value: a `-v` value, an `-F`
/// separator and a `var=value` operand alike.
pub(super) fn unescape(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut pos = 0;
    while pos < raw.len() {
        if raw[pos] == b'\\' && pos + 1 < raw.len() {
            pos = read_escape(raw, pos + 1, &mut out);
        } else {
            out.push(raw[pos]);
            pos += 1;
        }
    }
    out
}

/// A `var=value` operand's name and value, or None when it names a file:
/// POSIX makes it an assignment when a name (a letter or underscore, then
/// letters, digits and underscores) comes before its `=`.
pub(super) fn split_assignment(operand: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let first = *operand.first()?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let eq = operand
        .iter()
        .position(|&c| !(c.is_ascii_alphanumeric() || c == b'_'))?;
    (operand[eq] == b'=').then(|| (operand[..eq].to_vec(), unescape(&operand[eq + 1..])))
}

pub(super) fn compile_ere(pattern: &[u8]) -> Result<Posix, Vec<u8>> {
    let options = Options {
        extended: true,
        dialect: Dialect::Awk,
        ignore_case: false,
        utf8: false,
        multiline: false,
        word: false,
    };
    Posix::compile(pattern, &options).map_err(|_| {
        [
            b"awk: syntax error in regular expression ".as_slice(),
            pattern,
            b" at source line 1",
        ]
        .concat()
    })
}

/// The most expressions a run keeps compiled.
const CACHED: usize = 256;

/// The expressions a run has compiled, by their source.
#[derive(Default)]
pub(super) struct Regexes {
    cache: HashMap<Vec<u8>, Posix>,
}

impl Regexes {
    pub(super) fn get(&mut self, pattern: &[u8]) -> Result<&mut Posix, Vec<u8>> {
        if !self.cache.contains_key(pattern) {
            let compiled = compile_ere(pattern)?;
            if self.cache.len() >= CACHED {
                self.cache.clear();
            }
            self.cache.insert(pattern.to_vec(), compiled);
        }
        Ok(self.cache.get_mut(pattern).expect("just compiled"))
    }
}

fn blank(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n')
}

/// A field scan keeps its next search and field boundary between VM turns.
#[derive(Default)]
pub(super) struct SplitScan {
    at: usize,
    start: usize,
    active: bool,
    done: bool,
}

impl SplitScan {
    pub(super) fn next(
        &mut self,
        record: &[u8],
        fs: &[u8],
        paragraph: bool,
        regexes: &mut Regexes,
        work: &mut u64,
    ) -> Result<Step<Option<(usize, usize)>>, Vec<u8>> {
        if self.done || record.is_empty() {
            return Ok(Step::Done(None));
        }
        loop {
            if *work == 0 {
                return Ok(Step::Paused);
            }
            match fs {
                b"" => {
                    *work -= 1;
                    if self.at == record.len() {
                        self.done = true;
                        return Ok(Step::Done(None));
                    }
                    let at = self.at;
                    self.at += 1;
                    return Ok(Step::Done(Some((at, at + 1))));
                }
                b" " => {
                    *work -= 1;
                    if self.at == record.len() {
                        self.done = true;
                        return Ok(Step::Done(self.active.then_some((self.start, self.at))));
                    }
                    let at = self.at;
                    self.at += 1;
                    if blank(record[at]) {
                        if self.active {
                            self.active = false;
                            return Ok(Step::Done(Some((self.start, at))));
                        }
                    } else if !self.active {
                        self.active = true;
                        self.start = at;
                    }
                }
                &[sep] => {
                    *work -= 1;
                    if self.at == record.len() {
                        self.done = true;
                        return Ok(Step::Done(Some((self.start, self.at))));
                    }
                    let at = self.at;
                    self.at += 1;
                    if record[at] == sep || (paragraph && record[at] == b'\n') {
                        let start = self.start;
                        self.start = self.at;
                        return Ok(Step::Done(Some((start, at))));
                    }
                }
                _ => {
                    if self.at > record.len() {
                        self.done = true;
                        return Ok(Step::Done(Some((self.start, record.len()))));
                    }
                    match regexes.get(fs)?.find(record, self.at, work) {
                        Step::Paused => return Ok(Step::Paused),
                        Step::Done(Some((from, to))) if from == to => {
                            *work = work.saturating_sub(1);
                            self.at = from + 1;
                        }
                        Step::Done(Some((from, to))) => {
                            let start = self.start;
                            self.start = to;
                            self.at = to;
                            return Ok(Step::Done(Some((start, from))));
                        }
                        Step::Done(None) => {
                            self.done = true;
                            return Ok(Step::Done(Some((self.start, record.len()))));
                        }
                    }
                }
            }
        }
    }
}

#[derive(Default)]
pub(super) struct RecordSearch {
    rs: Vec<u8>,
    scanned: usize,
    regex: Option<crate::regex::RecordScan>,
    paragraph_start: usize,
    paragraph_end: Option<usize>,
    initialized: bool,
    position: usize,
    finding: bool,
    anchoring: bool,
}
impl RecordSearch {
    pub(super) fn shift(&mut self, count: usize) {
        self.scanned = self.scanned.saturating_sub(count);
        self.position = self.position.saturating_sub(count);
        self.paragraph_start = self.paragraph_start.saturating_sub(count);
        if let Some(end) = &mut self.paragraph_end {
            *end = end.saturating_sub(count);
        }
        if count > 0 {
            if let Some(regex) = &mut self.regex {
                regex.reset(0, false);
            }
        }
    }
    pub(super) fn reset(&mut self, start: usize) {
        self.scanned = start;
        self.position = start;
        self.finding = false;
        self.anchoring = false;
        self.paragraph_start = start;
        self.paragraph_end = None;
        if let Some(regex) = &mut self.regex {
            regex.reset(start, false);
        }
    }
}

/// Cut the next record from `buf[start..]` with an RS value: its range
/// and where the next one starts, or None when `buf` holds no complete
/// one yet. One byte is literal, an empty RS is paragraph mode and
/// anything longer an ERE, where a match of nothing separates nothing;
/// until the input ends, a separator reaching the end of `buf` could
/// still grow.
type RecordSpan = (usize, usize, usize);

pub(super) fn take_record(
    buf: &[u8],
    start: usize,
    rs: &[u8],
    last: bool,
    regexes: &mut Regexes,
    search: &mut RecordSearch,
    budget: &mut u64,
) -> Result<Step<Option<RecordSpan>>, Vec<u8>> {
    if !search.initialized || search.rs != rs {
        search.rs.clear();
        search.rs.extend_from_slice(rs);
        search.regex = if rs.len() > 1 {
            regexes.get(rs)?.record_scanner()
        } else {
            None
        };
        search.initialized = true;
        search.reset(start);
    }
    let tail = |start| (last && start < buf.len()).then_some((start, buf.len(), buf.len()));
    match rs {
        b"" => Ok(paragraph(buf, start, last, search, budget)),
        &[sep] => {
            let from = search.scanned.max(start);
            let end = buf
                .len()
                .min(from.saturating_add(usize::try_from(*budget).unwrap_or(usize::MAX)));
            if let Some(at) = memchr::memchr(sep, &buf[from..end]) {
                *budget -= (at + 1) as u64;
                Ok(Step::Done(Some((start, from + at, from + at + 1))))
            } else {
                *budget -= (end - from) as u64;
                search.scanned = end;
                Ok(if end < buf.len() {
                    Step::Paused
                } else {
                    Step::Done(tail(start))
                })
            }
        }
        _ => {
            if search.anchoring {
                if let Some(scanner) = &mut search.regex {
                    match scanner.scan(buf, false, budget) {
                        Ok(Step::Paused) => return Ok(Step::Paused),
                        Err(()) => search.regex = None,
                        _ => {}
                    }
                }
                search.anchoring = false;
                search.finding = false;
                search.position = start;
                return Ok(Step::Done(None));
            }
            if !search.finding {
                if let Some(scanner) = &mut search.regex {
                    match scanner.scan(buf, last, budget) {
                        Ok(Step::Paused) => return Ok(Step::Paused),
                        Ok(Step::Done(false)) => return Ok(Step::Done(None)),
                        Ok(Step::Done(true)) => {}
                        Err(()) => search.regex = None,
                    }
                }
                search.finding = true;
                search.position = start;
            }
            let regex = regexes.get(rs)?;
            while search.position <= buf.len() {
                if *budget == 0 {
                    return Ok(Step::Paused);
                }
                *budget -= 1;
                let (from, to) = match regex.find(buf, search.position, budget) {
                    Step::Paused => return Ok(Step::Paused),
                    Step::Done(None) => break,
                    Step::Done(Some(found)) => found,
                };
                if from == to {
                    search.position = from + 1;
                    continue;
                }
                if to == buf.len() && !last {
                    if from == start {
                        if let Some(scanner) = &mut search.regex {
                            scanner.reset(start, true);
                            search.anchoring = true;
                            match scanner.scan(buf, false, budget) {
                                Ok(Step::Paused) => return Ok(Step::Paused),
                                Err(()) => search.regex = None,
                                _ => {}
                            }
                            search.anchoring = false;
                        }
                    }
                    search.finding = false;
                    search.position = start;
                    return Ok(Step::Done(None));
                }
                return Ok(Step::Done(Some((start, from, to))));
            }
            search.finding = false;
            search.position = start;
            Ok(Step::Done(tail(start)))
        }
    }
}

fn paragraph(
    buf: &[u8],
    start: usize,
    last: bool,
    search: &mut RecordSearch,
    budget: &mut u64,
) -> Step<Option<(usize, usize, usize)>> {
    let mut start = start.max(search.paragraph_start);
    while start < buf.len() && buf[start] == b'\n' {
        if *budget == 0 {
            search.paragraph_start = start;
            return Step::Paused;
        }
        *budget -= 1;
        start += 1;
    }
    search.paragraph_start = start;
    if let Some(end) = search.paragraph_end {
        let mut stop = search.scanned.max(end + 2);
        while stop < buf.len() && buf[stop] == b'\n' {
            if *budget == 0 {
                search.scanned = stop;
                return Step::Paused;
            }
            *budget -= 1;
            stop += 1;
        }
        search.scanned = stop;
        return Step::Done((stop < buf.len() || last).then_some((start, end, stop)));
    }
    let mut at = start.max(search.scanned);
    while at < buf.len() {
        if *budget == 0 {
            search.scanned = at;
            return Step::Paused;
        }
        *budget -= 1;
        if at > start && buf[at - 1] == b'\n' && buf[at] == b'\n' {
            search.paragraph_end = Some(at - 1);
            search.scanned = at + 1;
            return paragraph(buf, start, last, search, budget);
        }
        at += 1;
    }
    search.scanned = buf.len();
    if !last || start == buf.len() {
        return Step::Done(None);
    }
    Step::Done(Some((
        start,
        buf.len() - usize::from(buf.ends_with(b"\n")),
        buf.len(),
    )))
}

/// An awk substring: positions count from 1 and truncate toward zero; a
/// start below 1 is clamped to 1 with the whole length still taken, as
/// gawk and onetrueawk do (`substr("hello", -1, 3)` is "hel").
pub(super) fn substr(size: usize, start: f64, length: Option<f64>) -> (usize, usize) {
    let begin = usize::try_from(super::value::to_int(start).max(1) - 1)
        .unwrap_or(usize::MAX)
        .min(size);
    let count = length.map_or(size - begin, |length| {
        usize::try_from(super::value::to_int(length).max(0))
            .unwrap_or(usize::MAX)
            .min(size - begin)
    });
    (begin, begin + count)
}

pub(super) struct IndexSearch {
    haystack: Text,
    needle: Text,
    prefix: Vec<u32>,
    building: usize,
    matched: usize,
    at: usize,
}

impl IndexSearch {
    pub(super) fn new(haystack: Text, needle: Text) -> Self {
        Self {
            prefix: {
                let mut prefix = Vec::new();
                if needle.len() <= haystack.len() && !needle.is_empty() {
                    prefix = Vec::with_capacity(needle.len());
                    prefix.push(0);
                }
                prefix
            },
            haystack,
            needle,
            building: 1,
            matched: 0,
            at: 0,
        }
    }

    pub(super) fn step(&mut self, work: &mut u64) -> Step<usize> {
        if self.needle.is_empty() {
            return Step::Done(1);
        }
        if self.needle.len() > self.haystack.len() {
            return Step::Done(0);
        }
        while self.building < self.needle.len() {
            if *work == 0 {
                return Step::Paused;
            }
            *work -= 1;
            if self.needle[self.building] == self.needle[self.matched] {
                self.matched += 1;
                self.prefix.push(self.matched as u32);
                self.building += 1;
            } else if self.matched > 0 {
                self.matched = self.prefix[self.matched - 1] as usize;
            } else {
                self.prefix.push(0);
                self.building += 1;
            }
            if self.building == self.needle.len() {
                self.matched = 0;
            }
        }
        while self.at < self.haystack.len() {
            if *work == 0 {
                return Step::Paused;
            }
            *work -= 1;
            if self.haystack[self.at] == self.needle[self.matched] {
                self.at += 1;
                self.matched += 1;
                if self.matched == self.needle.len() {
                    return Step::Done(self.at - self.needle.len() + 1);
                }
            } else if self.matched > 0 {
                self.matched = self.prefix[self.matched - 1] as usize;
            } else {
                self.at += 1;
            }
        }
        Step::Done(0)
    }
}

pub(super) enum View {
    Shared(Text),
    Copy(StringWork),
}

impl View {
    pub(super) fn new(subject: Text, range: Range<usize>) -> Self {
        if subject.storage_len() > range.len().saturating_mul(4) {
            Self::Copy(StringWork::Copy {
                out: Vec::with_capacity(range.len()),
                subject,
                at: range.start,
                end: range.end,
            })
        } else {
            Self::Shared(subject.slice(range))
        }
    }

    pub(super) fn step(&mut self, work: &mut u64) -> Step<Text> {
        if *work == 0 {
            return Step::Paused;
        }
        match self {
            Self::Shared(text) => {
                *work -= 1;
                Step::Done(text.clone())
            }
            Self::Copy(copy) => match copy.step(work) {
                Step::Paused => Step::Paused,
                Step::Done(bytes) => Step::Done(bytes.into()),
            },
        }
    }
}

pub(super) enum StringWork {
    Case {
        subject: Text,
        upper: bool,
        at: usize,
        out: Vec<u8>,
    },
    Copy {
        subject: Text,
        at: usize,
        end: usize,
        out: Vec<u8>,
    },
    Join {
        left: Text,
        right: Text,
        at: usize,
        out: Vec<u8>,
    },
}

impl StringWork {
    pub(super) fn step(&mut self, work: &mut u64) -> Step<Vec<u8>> {
        match self {
            Self::Case {
                subject,
                upper,
                at,
                out,
            } => {
                let end = subject
                    .len()
                    .min(at.saturating_add(usize::try_from(*work).unwrap_or(usize::MAX)));
                out.extend_from_slice(&subject[*at..end]);
                if *upper {
                    out[*at..end].make_ascii_uppercase();
                } else {
                    out[*at..end].make_ascii_lowercase();
                }
                *work -= (end - *at) as u64;
                *at = end;
                if end == subject.len() {
                    Step::Done(std::mem::take(out))
                } else {
                    Step::Paused
                }
            }
            Self::Copy {
                subject,
                at,
                end,
                out,
            } => {
                let stop =
                    (*end).min(at.saturating_add(usize::try_from(*work).unwrap_or(usize::MAX)));
                out.extend_from_slice(&subject[*at..stop]);
                *work -= (stop - *at) as u64;
                *at = stop;
                if *at == *end {
                    Step::Done(std::mem::take(out))
                } else {
                    Step::Paused
                }
            }
            Self::Join {
                left,
                right,
                at,
                out,
            } => {
                while *at < left.len() + right.len() {
                    if *work == 0 {
                        return Step::Paused;
                    }
                    let (piece, from) = if *at < left.len() {
                        (&left[..], *at)
                    } else {
                        (&right[..], *at - left.len())
                    };
                    let count =
                        (piece.len() - from).min(usize::try_from(*work).unwrap_or(usize::MAX));
                    out.extend_from_slice(&piece[from..from + count]);
                    *work -= count as u64;
                    *at += count;
                }
                Step::Done(std::mem::take(out))
            }
        }
    }
}

enum SubPhase {
    Search,
    Prefix {
        from: usize,
        to: usize,
        at: usize,
    },
    Template {
        from: usize,
        to: usize,
        at: usize,
    },
    Matched {
        from: usize,
        to: usize,
        at: usize,
        next: usize,
    },
    Advance {
        from: usize,
        to: usize,
    },
    Tail {
        at: usize,
    },
}

pub(super) struct Substitution {
    subject: Text,
    template: Text,
    out: Buffer<u8>,
    phase: SubPhase,
    global: bool,
    pos: usize,
    count: usize,
    last_end: Option<usize>,
}

fn copy_piece(
    out: &mut Buffer<u8>,
    bytes: &[u8],
    at: &mut usize,
    end: usize,
    work: &mut u64,
) -> Result<bool, ()> {
    if out.len().saturating_add(end - *at) > MAX_LEN {
        return Err(());
    }
    if !out.reserve(end - *at, work) {
        return Ok(false);
    }
    let count = (end - *at).min(usize::try_from(*work).unwrap_or(usize::MAX));
    out.values.extend_from_slice(&bytes[*at..*at + count]);
    *at += count;
    *work -= count as u64;
    Ok(*at == end)
}

impl Substitution {
    pub(super) fn new(subject: Text, template: Text, global: bool) -> Self {
        Self {
            out: Buffer::with_capacity(subject.len()),
            subject,
            template,
            global,
            phase: SubPhase::Search,
            pos: 0,
            count: 0,
            last_end: None,
        }
    }

    pub(super) fn step(
        &mut self,
        regex: &mut Posix,
        work: &mut u64,
    ) -> Result<Step<(usize, Vec<u8>)>, ()> {
        while *work > 0 {
            let byte = match self.phase {
                SubPhase::Template { at, .. } => {
                    self.template.get(at).is_some_and(|byte| *byte != b'&')
                }
                SubPhase::Advance { from, to } => from == to && from < self.subject.len(),
                _ => false,
            };
            if byte {
                if self.out.len() == MAX_LEN {
                    return Err(());
                }
                if !self.out.reserve(1, work) || *work == 0 {
                    return Ok(Step::Paused);
                }
            }
            match &mut self.phase {
                SubPhase::Search => {
                    if self.pos > self.subject.len() {
                        self.phase = SubPhase::Tail {
                            at: self.subject.len(),
                        };
                        continue;
                    }
                    match regex.find(&self.subject, self.pos, work) {
                        Step::Paused => return Ok(Step::Paused),
                        Step::Done(None) => self.phase = SubPhase::Tail { at: self.pos },
                        Step::Done(Some((from, to))) => {
                            self.phase = SubPhase::Prefix {
                                from,
                                to,
                                at: self.pos,
                            }
                        }
                    }
                    *work = work.saturating_sub(1);
                }
                SubPhase::Prefix { from, to, at } => {
                    if !copy_piece(&mut self.out, &self.subject, at, *from, work)? {
                        return Ok(Step::Paused);
                    }
                    self.phase = if from == to && self.last_end == Some(*from) {
                        SubPhase::Advance {
                            from: *from,
                            to: *to,
                        }
                    } else {
                        self.count += 1;
                        SubPhase::Template {
                            from: *from,
                            to: *to,
                            at: 0,
                        }
                    };
                }
                SubPhase::Template { from, to, at } => {
                    if *at == self.template.len() {
                        self.phase = SubPhase::Advance {
                            from: *from,
                            to: *to,
                        };
                        continue;
                    }
                    if !matches!(self.template[*at], b'\\' | b'&') {
                        let end = self
                            .template
                            .len()
                            .min(at.saturating_add(usize::try_from(*work).unwrap_or(usize::MAX)));
                        let end = memchr::memchr2(b'\\', b'&', &self.template[*at..end])
                            .map_or(end, |offset| *at + offset);
                        copy_piece(&mut self.out, &self.template, at, end, work)?;
                        continue;
                    }
                    *work -= 1;
                    match self.template[*at] {
                        b'&' => {
                            self.phase = SubPhase::Matched {
                                from: *from,
                                to: *to,
                                at: *from,
                                next: *at + 1,
                            }
                        }
                        b'\\' if self.template.get(*at + 1) == Some(&b'&') => {
                            self.out.values.push(b'&');
                            *at += 2;
                        }
                        b'\\' if self.template.get(*at + 1..*at + 3) == Some(&b"\\&"[..]) => {
                            self.out.values.push(b'\\');
                            self.phase = SubPhase::Matched {
                                from: *from,
                                to: *to,
                                at: *from,
                                next: *at + 3,
                            };
                        }
                        byte => {
                            self.out.values.push(byte);
                            *at += 1;
                        }
                    }
                    if self.out.len() > MAX_LEN {
                        return Err(());
                    }
                }
                SubPhase::Matched { from, to, at, next } => {
                    if !copy_piece(&mut self.out, &self.subject, at, *to, work)? {
                        return Ok(Step::Paused);
                    }
                    self.phase = SubPhase::Template {
                        from: *from,
                        to: *to,
                        at: *next,
                    };
                }
                SubPhase::Advance { from, to } => {
                    *work -= 1;
                    if from == to {
                        if let Some(&byte) = self.subject.get(*from) {
                            if self.out.len() == MAX_LEN {
                                return Err(());
                            }
                            self.out.values.push(byte);
                        }
                        self.pos = *from + 1;
                    } else {
                        self.pos = *to;
                        self.last_end = Some(*to);
                    }
                    self.phase = if self.global {
                        SubPhase::Search
                    } else {
                        SubPhase::Tail {
                            at: self.pos.min(self.subject.len()),
                        }
                    };
                }
                SubPhase::Tail { at } => {
                    if !copy_piece(&mut self.out, &self.subject, at, self.subject.len(), work)? {
                        return Ok(Step::Paused);
                    }
                    return Ok(Step::Done((self.count, self.out.take())));
                }
            }
        }
        Ok(Step::Paused)
    }
}

#[cfg(test)]
mod record_tests {
    use super::*;

    fn complete_record(
        buf: &[u8],
        start: usize,
        rs: &[u8],
        last: bool,
        regexes: &mut Regexes,
        search: &mut RecordSearch,
    ) -> Result<Option<(usize, usize, usize)>, Vec<u8>> {
        loop {
            let mut work = 7;
            match take_record(buf, start, rs, last, regexes, search, &mut work)? {
                Step::Done(record) => return Ok(record),
                Step::Paused => {}
            }
        }
    }

    #[test]
    fn incremental_record_search_matches_full_search_at_every_boundary() {
        for rs in [
            b"\n".as_slice(),
            b"",
            b"END",
            b"x+",
            b"a.*z|END",
            b"ab.*z|E+",
            b"a$",
            b"x*",
            b"[ab]+",
            b"a{2,4}",
        ] {
            for text in [
                b"alpha\n\nENDxxxENDtail\n".as_slice(),
                b"aaaaabxxazEND",
                b"tailaaaa",
                b"\n\n\nparagraph\n\n\nlast",
                b"zzzzzzzz",
                b"abXEEzT",
            ] {
                for width in 1..=text.len() {
                    let mut regexes = Regexes::default();
                    let mut search = RecordSearch::default();
                    let mut start = 0;
                    for end in (width..text.len())
                        .step_by(width)
                        .chain(std::iter::once(text.len()))
                    {
                        let last = end == text.len();
                        loop {
                            let got = complete_record(
                                &text[..end],
                                start,
                                rs,
                                last,
                                &mut regexes,
                                &mut search,
                            )
                            .unwrap();
                            let mut reference = RecordSearch {
                                rs: rs.to_vec(),
                                initialized: true,
                                ..RecordSearch::default()
                            };
                            let expected = complete_record(
                                &text[..end],
                                start,
                                rs,
                                last,
                                &mut regexes,
                                &mut reference,
                            )
                            .unwrap();
                            assert_eq!(
                                got, expected,
                                "rs {rs:?}, text {text:?}, width {width}, end {end}"
                            );
                            let Some((_, _, next)) = got else { break };
                            start = next;
                            search.reset(start);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn long_records_retain_the_scanned_position() {
        for rs in [b"\n".as_slice(), b"", b"END", b"x+"] {
            let mut regexes = Regexes::default();
            let mut search = RecordSearch::default();
            let text = vec![b'a'; 1024 * 1024];
            for end in (4096..=text.len()).step_by(4096) {
                assert!(
                    complete_record(&text[..end], 0, rs, false, &mut regexes, &mut search)
                        .unwrap()
                        .is_none()
                );
                if rs.len() <= 1 {
                    assert_eq!(search.scanned, end);
                } else {
                    assert!(search.regex.is_some());
                }
            }
        }
    }
}

#[cfg(test)]
mod string_tests {
    use super::*;

    #[test]
    fn impossible_index_searches_do_not_allocate_a_prefix_table() {
        let mut search = IndexSearch::new(Text::default(), vec![b'a'; 64 * 1024 * 1024].into());
        assert_eq!(search.prefix.capacity(), 0);
        assert!(matches!(search.step(&mut 1), Step::Done(0)));
    }

    #[test]
    fn small_views_release_the_large_backing_record_after_bounded_copying() {
        for budget in [1, 7, 20000] {
            let subject: Text = vec![b'x'; 131073].into();
            let mut view = View::new(subject, 17..8210);
            let mut turns = 0;
            let value = loop {
                turns += 1;
                let mut work = budget;
                if let Step::Done(text) = view.step(&mut work) {
                    break text;
                }
                assert_eq!(work, 0);
                assert!(turns < 10000);
            };
            assert_eq!(value.len(), 8193);
            assert_eq!(value.storage_len(), value.len());
            assert!(value.iter().all(|byte| *byte == b'x'));
            if budget < 8193 {
                assert!(turns > 1);
            }
        }
    }

    #[test]
    fn index_matches_slice_search_at_every_budget_boundary() {
        for budget in [1, 2, 7] {
            for haystack in [
                b"".as_slice(),
                b"a",
                b"aaaaabaaaaab",
                b"ababababac",
                b"\x00\xff\x00",
            ] {
                for needle in [
                    b"".as_slice(),
                    b"a",
                    b"aaaaab",
                    b"ababac",
                    b"aaaac",
                    b"\xff\x00",
                ] {
                    let expected = if needle.is_empty() {
                        1
                    } else {
                        haystack
                            .windows(needle.len())
                            .position(|s| s == needle)
                            .map_or(0, |at| at + 1)
                    };
                    let mut search =
                        IndexSearch::new(haystack.to_vec().into(), needle.to_vec().into());
                    let mut turns = 0;
                    loop {
                        turns += 1;
                        assert!(turns < 1000);
                        let mut work = budget;
                        match search.step(&mut work) {
                            Step::Paused => {}
                            Step::Done(actual) => {
                                assert_eq!(actual, expected);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
}
