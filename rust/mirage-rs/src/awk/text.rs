use std::collections::HashMap;

use crate::regex::parse::Dialect;
use crate::regex::posix::{Options, Posix};

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

/// Split `record` into fields by an FS value, as ranges of it. A blank FS
/// splits at runs of blanks with the ends trimmed, an empty one makes
/// each byte a field, one byte is literal and anything longer an ERE. A
/// record read in paragraph mode also splits at each newline when FS is
/// one byte, as in gawk and onetrueawk; a regex FS does not.
pub(super) fn split(
    record: &[u8],
    fs: &[u8],
    paragraph: bool,
    regexes: &mut Regexes,
    out: &mut Vec<(usize, usize)>,
) -> Result<(), Vec<u8>> {
    out.clear();
    match fs {
        b"" => out.extend((0..record.len()).map(|at| (at, at + 1))),
        b" " => {
            let mut at = 0;
            while at < record.len() {
                while at < record.len() && blank(record[at]) {
                    at += 1;
                }
                let start = at;
                while at < record.len() && !blank(record[at]) {
                    at += 1;
                }
                if at > start {
                    out.push((start, at));
                }
            }
        }
        &[sep] => {
            if record.is_empty() {
                return Ok(());
            }
            let mut start = 0;
            for (at, &c) in record.iter().enumerate() {
                if c == sep || (paragraph && c == b'\n') {
                    out.push((start, at));
                    start = at + 1;
                }
            }
            out.push((start, record.len()));
        }
        _ => {
            if record.is_empty() {
                return Ok(());
            }
            let regex = regexes.get(fs)?;
            let (mut start, mut pos) = (0, 0);
            while pos <= record.len() {
                let Some((from, to)) = regex.find(record, pos) else {
                    break;
                };
                if from == to {
                    // A separator that matches nothing separates nothing.
                    pos = from + 1;
                    continue;
                }
                out.push((start, from));
                start = to;
                pos = to;
            }
            out.push((start, record.len()));
        }
    }
    Ok(())
}

/// Cut the next record from `buf[start..]` with an RS value: its range
/// and where the next one starts, or None when `buf` holds no complete
/// one yet. One byte is literal, an empty RS is paragraph mode and
/// anything longer an ERE, where a match of nothing separates nothing;
/// until the input ends, a separator reaching the end of `buf` could
/// still grow.
pub(super) fn take_record(
    buf: &[u8],
    start: usize,
    rs: &[u8],
    last: bool,
    regexes: &mut Regexes,
) -> Result<Option<(usize, usize, usize)>, Vec<u8>> {
    let tail = |start: usize| (last && start < buf.len()).then_some((start, buf.len(), buf.len()));
    match rs {
        b"" => Ok(paragraph(buf, start, last)),
        &[sep] => Ok(match memchr::memchr(sep, &buf[start..]) {
            Some(at) => Some((start, start + at, start + at + 1)),
            None => tail(start),
        }),
        _ => {
            let regex = regexes.get(rs)?;
            let mut pos = start;
            while pos <= buf.len() {
                let Some((from, to)) = regex.find(buf, pos) else {
                    break;
                };
                if from == to {
                    pos = from + 1;
                    continue;
                }
                if to == buf.len() && !last {
                    return Ok(None);
                }
                return Ok(Some((start, from, to)));
            }
            Ok(tail(start))
        }
    }
}

/// Paragraph mode: records are separated by blank lines, and leading or
/// trailing newlines never make an empty record. The whole run of
/// newlines is the separator, so a run reaching the end of `buf` waits.
fn paragraph(buf: &[u8], mut start: usize, last: bool) -> Option<(usize, usize, usize)> {
    while start < buf.len() && buf[start] == b'\n' {
        start += 1;
    }
    if let Some(at) = memchr::memmem::find(&buf[start..], b"\n\n") {
        let end = start + at;
        let mut stop = end + 2;
        while stop < buf.len() && buf[stop] == b'\n' {
            stop += 1;
        }
        return (stop < buf.len() || last).then_some((start, end, stop));
    }
    if !last || start == buf.len() {
        return None;
    }
    let end = buf.len() - usize::from(buf.ends_with(b"\n"));
    Some((start, end, buf.len()))
}

/// An awk substring: positions count from 1 and truncate toward zero; a
/// start below 1 is clamped to 1 with the whole length still taken, as
/// gawk and onetrueawk do (`substr("hello", -1, 3)` is "hel").
pub(super) fn substr(subject: &[u8], start: f64, length: Option<f64>) -> &[u8] {
    let begin = usize::try_from(super::value::to_int(start).max(1) - 1).unwrap_or(usize::MAX);
    let rest = subject.get(begin..).unwrap_or_default();
    match length {
        None => rest,
        Some(length) => {
            let span = super::value::to_int(length);
            if span <= 0 {
                return &[];
            }
            &rest[..rest.len().min(usize::try_from(span).unwrap_or(usize::MAX))]
        }
    }
}

/// A sub/gsub replacement with `&` the match: `\&` is a literal
/// ampersand and `\\&` a backslash and the match; any other backslash is
/// itself, as in gawk, mawk and onetrueawk.
fn expand(template: &[u8], matched: &[u8], out: &mut Vec<u8>) {
    let mut at = 0;
    while at < template.len() {
        match template[at] {
            b'\\' if template.get(at + 1) == Some(&b'&') => {
                out.push(b'&');
                at += 2;
            }
            b'\\' if template[at + 1..].starts_with(b"\\&") => {
                out.push(b'\\');
                out.extend_from_slice(matched);
                at += 3;
            }
            b'&' => {
                out.extend_from_slice(matched);
                at += 1;
            }
            c => {
                out.push(c);
                at += 1;
            }
        }
    }
}

/// sub, or gsub when `global`: the count of replacements and the result.
/// An empty match touching the previous match is no match, so
/// `gsub(/l*/, "-")` turns "hello" into "-h-e-o-".
pub(super) fn substitute(
    regex: &mut Posix,
    template: &[u8],
    subject: &[u8],
    global: bool,
) -> (usize, Vec<u8>) {
    let mut out = Vec::with_capacity(subject.len());
    let (mut count, mut pos, mut last_end) = (0, 0, None);
    while pos <= subject.len() {
        let Some((from, to)) = regex.find(subject, pos) else {
            break;
        };
        out.extend_from_slice(&subject[pos..from]);
        if !(from == to && last_end == Some(from)) {
            expand(template, &subject[from..to], &mut out);
            count += 1;
        }
        if from == to {
            if let Some(&c) = subject.get(from) {
                out.push(c);
            }
            pos = from + 1;
        } else {
            pos = to;
            last_end = Some(to);
        }
        if !global {
            break;
        }
    }
    out.extend_from_slice(subject.get(pos..).unwrap_or_default());
    (count, out)
}
