//! hexdump's format strings: units of an iteration count, a byte count
//! and a quoted printf-style text, read into the prints a block runs
//! through, and the one-letter options as the format strings they stand
//! for.

use crate::printf::number::{Rendered, render_float, render_integer};

/// The format strings each one-letter display option adds, in order: the
/// offset where the input ends, then each line.
pub(super) const DEFAULT: &[&[u8]] = &[b"\"%07.7_Ax\\n\"", b"\"%07.7_ax \" 8/2 \"%04x \" \"\\n\""];
pub(super) const ONE_BYTE_OCTAL: &[&[u8]] =
    &[b"\"%07.7_Ax\\n\"", b"\"%07.7_ax \" 16/1 \"%03o \" \"\\n\""];
pub(super) const ONE_BYTE_HEX: &[&[u8]] =
    &[b"\"%07.7_Ax\\n\"", b"\"%07.7_ax \" 16/1 \" %02x \" \"\\n\""];
pub(super) const ONE_BYTE_CHAR: &[&[u8]] =
    &[b"\"%07.7_Ax\\n\"", b"\"%07.7_ax \" 16/1 \"%3_c \" \"\\n\""];
pub(super) const CANONICAL: &[&[u8]] = &[
    b"\"%08.8_Ax\\n\"",
    b"\"%08.8_ax  \" 8/1 \"%02x \" \"  \" 8/1 \"%02x \"",
    b"\"  |\" 16/1 \"%_p\" \"|\\n\"",
];
pub(super) const TWO_BYTES_DECIMAL: &[&[u8]] =
    &[b"\"%07.7_Ax\\n\"", b"\"%07.7_ax \" 8/2 \"  %05u \" \"\\n\""];
pub(super) const TWO_BYTES_OCTAL: &[&[u8]] =
    &[b"\"%07.7_Ax\\n\"", b"\"%07.7_ax \" 8/2 \" %06o \" \"\\n\""];
pub(super) const TWO_BYTES_HEX: &[&[u8]] = &[
    b"\"%07.7_Ax\\n\"",
    b"\"%07.7_ax \" 8/2 \"   %04x \" \"\\n\"",
];

/// The names `%_u` shows for the control characters.
const NAMES: [&[u8]; 32] = [
    b"nul", b"soh", b"stx", b"etx", b"eot", b"enq", b"ack", b"bel", b"bs", b"ht", b"lf", b"vt",
    b"ff", b"cr", b"so", b"si", b"dle", b"dc1", b"dc2", b"dc3", b"dc4", b"nak", b"syn", b"etb",
    b"can", b"em", b"sub", b"esc", b"fs", b"gs", b"rs", b"us",
];

/// What a conversion shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    /// No conversion: the text alone.
    Text,
    /// `%_a` (where the block's next byte is) or, `end`, `%_A` (where the
    /// input ended), in `d`, `o` or `x`.
    Address { radix: u8, end: bool },
    /// `%d %i %o %u %x %X` over 1, 2, 4 or 8 bytes.
    Integer(u8),
    /// `%e %E %f %g %G` over 4 or 8 bytes.
    Float(u8),
    /// `%c`: the byte itself.
    Char,
    /// `%s`: the bytes as a string.
    Str,
    /// `%_c`: a printable byte, an escape, or three octal digits.
    Escaped,
    /// `%_p`: a printable byte or `.`.
    Printable,
    /// `%_u`: a printable byte, a control character's name, or hex.
    Named,
}

/// One conversion and the text around it, and the bytes it reads.
#[derive(Clone, Debug)]
pub(super) struct Print {
    pub(super) before: Vec<u8>,
    pub(super) kind: Kind,
    pub(super) flags: Vec<u8>,
    pub(super) width: usize,
    pub(super) precision: Option<usize>,
    pub(super) size: usize,
    /// The text after the unit's last conversion, on its last print.
    pub(super) after: Vec<u8>,
}

/// A format unit: its prints, run `reps` times.
#[derive(Clone, Debug)]
pub(super) struct Unit {
    pub(super) reps: usize,
    /// An iteration count was given, so the count never grows to fill a
    /// block.
    pub(super) counted: bool,
    pub(super) bytes: Option<usize>,
    /// The unit's text, escapes read, which its prints are made of.
    text: Vec<u8>,
    pub(super) prints: Vec<Print>,
    /// The unit holds a `%_A`, so it runs once, where the input ends.
    pub(super) end: bool,
}

impl Unit {
    /// The bytes one iteration reads.
    pub(super) fn step(&self) -> usize {
        self.prints.iter().map(|print| print.size).sum()
    }

    pub(super) fn total(&self) -> usize {
        self.reps.saturating_mul(self.step())
    }
}

/// A format string: the units one `-e` or one line of `-f` holds.
pub(super) type Format = Vec<Unit>;

/// Read one format string's units, or refuse it as hexdump does, naming
/// the string whole.
pub(super) fn parse(raw: &[u8]) -> Result<Format, String> {
    let bad = || format!("hexdump: bad format {{{}}}", crate::byte_text(raw));
    let mut units = Vec::new();
    let mut at = 0;
    let blank = |b: u8| b.is_ascii_whitespace();
    loop {
        while raw.get(at).is_some_and(|&b| blank(b)) {
            at += 1;
        }
        if at >= raw.len() {
            return Ok(units);
        }
        let (mut reps, mut counted, mut bytes) = (1, false, None);
        if raw[at].is_ascii_digit() {
            (reps, at) = number(raw, at).ok_or_else(bad)?;
            counted = true;
            if !raw.get(at).is_some_and(|&b| blank(b) || b == b'/') {
                return Err(bad());
            }
            while raw.get(at).is_some_and(|&b| blank(b)) {
                at += 1;
            }
        }
        if raw.get(at) == Some(&b'/') {
            at += 1;
            while raw.get(at).is_some_and(|&b| blank(b)) {
                at += 1;
            }
            if raw.get(at).is_some_and(u8::is_ascii_digit) {
                let count;
                (count, at) = number(raw, at).ok_or_else(bad)?;
                if !raw.get(at).is_some_and(|&b| blank(b)) {
                    return Err(bad());
                }
                // A byte count of 0 is none.
                bytes = (count > 0).then_some(count);
                while raw.get(at).is_some_and(|&b| blank(b)) {
                    at += 1;
                }
            }
        }
        if raw.get(at) != Some(&b'"') {
            return Err(bad());
        }
        let start = at + 1;
        let close = raw[start..]
            .iter()
            .position(|&b| b == b'"')
            .ok_or_else(bad)?;
        units.push(Unit {
            reps,
            counted,
            bytes,
            text: escaped(&raw[start..start + close]),
            prints: Vec::new(),
            end: false,
        });
        at = start + close + 1;
    }
}

/// A decimal count, and where it ends.
fn number(raw: &[u8], start: usize) -> Option<(usize, usize)> {
    let end = start
        + raw[start..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
    let text = std::str::from_utf8(&raw[start..end]).ok()?;
    Some((text.parse().ok()?, end))
}

/// The text with C's one-character escapes read; any other escaped
/// character stands for itself.
fn escaped(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut bytes = text.iter();
    while let Some(&b) = bytes.next() {
        if b != b'\\' {
            out.push(b);
            continue;
        }
        let Some(&next) = bytes.next() else {
            out.push(b'\\');
            break;
        };
        out.push(match next {
            b'0' => 0,
            b'a' => 0x07,
            b'b' => 0x08,
            b'f' => 0x0c,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'v' => 0x0b,
            other => other,
        });
    }
    out
}

/// Read each unit's conversions and size them as hexdump does once every
/// format is in: a refusal names the first conversion it cannot run.
pub(super) fn prepare(formats: &mut [Format]) -> Result<(), String> {
    for unit in formats.iter_mut().flatten() {
        unit.prints = prints(unit)?;
        unit.end = unit
            .prints
            .iter()
            .any(|print| matches!(print.kind, Kind::Address { end: true, .. }));
    }
    Ok(())
}

/// A unit's text split at its conversions, each with its byte count.
fn prints(unit: &Unit) -> Result<Vec<Print>, String> {
    let text = &unit.text;
    let mut prints = Vec::new();
    let mut before = Vec::new();
    let mut at = 0;
    while at < text.len() {
        if text[at] != b'%' {
            before.push(text[at]);
            at += 1;
            continue;
        }
        let start = at;
        at += 1;
        let flags_start = at;
        while text.get(at).is_some_and(|b| b"-+ #0".contains(b)) {
            at += 1;
        }
        let flags = text[flags_start..at].to_vec();
        let width_start = at;
        while text.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        let width = digits(&text[width_start..at]);
        let mut precision = None;
        if text.get(at) == Some(&b'.') {
            at += 1;
            let precision_start = at;
            while text.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            precision = Some(digits(&text[precision_start..at]));
        }
        let bad_conversion = |chars: &[u8]| {
            format!(
                "hexdump: bad conversion character %{}",
                crate::byte_text(chars)
            )
        };
        let Some(&conversion) = text.get(at) else {
            return Err(format!(
                "hexdump: bad format {{{}}}",
                crate::byte_text(&text[start..])
            ));
        };
        let kind = match conversion {
            b'd' | b'i' | b'o' | b'u' | b'x' | b'X' => Kind::Integer(conversion),
            b'e' | b'E' | b'f' | b'g' | b'G' => Kind::Float(conversion),
            b'c' => Kind::Char,
            b's' => Kind::Str,
            b'_' => {
                let tail = &text[at..text.len().min(at + 3)];
                match text.get(at + 1) {
                    Some(&letter @ (b'a' | b'A')) => match text.get(at + 2) {
                        Some(&radix @ (b'd' | b'o' | b'x')) => {
                            at += 2;
                            Kind::Address {
                                radix,
                                end: letter == b'A',
                            }
                        }
                        _ => return Err(bad_conversion(tail)),
                    },
                    Some(b'c') => {
                        at += 1;
                        Kind::Escaped
                    }
                    Some(b'p') => {
                        at += 1;
                        Kind::Printable
                    }
                    Some(b'u') => {
                        at += 1;
                        Kind::Named
                    }
                    _ => return Err(bad_conversion(&text[at..text.len().min(at + 2)])),
                }
            }
            _ => return Err(bad_conversion(&[conversion])),
        };
        at += 1;
        prints.push(Print {
            before: std::mem::take(&mut before),
            kind,
            flags,
            width,
            precision,
            size: 0,
            after: Vec::new(),
        });
    }
    match prints.last_mut() {
        Some(last) => last.after = before,
        None => prints.push(Print {
            before,
            kind: Kind::Text,
            flags: Vec::new(),
            width: 0,
            precision: None,
            size: 0,
            after: Vec::new(),
        }),
    }
    size(unit, &mut prints)?;
    Ok(prints)
}

fn digits(raw: &[u8]) -> usize {
    raw.iter().fold(0usize, |n, &b| {
        n.saturating_mul(10).saturating_add(usize::from(b - b'0'))
    })
}

/// Give each print the bytes it reads: the unit's byte count, else the
/// conversion's own; a unit with a byte count and no conversion reads it
/// all the same.
fn size(unit: &Unit, prints: &mut [Print]) -> Result<(), String> {
    let reading = prints
        .iter()
        .filter(|print| !matches!(print.kind, Kind::Text | Kind::Address { .. }))
        .count();
    if unit.bytes.is_some() && reading > 1 {
        return Err("hexdump: byte count with multiple conversion characters".to_string());
    }
    for print in prints.iter_mut() {
        let wrong = |name: &str| format!("hexdump: bad byte count for conversion character {name}");
        print.size = match print.kind {
            Kind::Text | Kind::Address { .. } => 0,
            Kind::Integer(conversion) => match unit.bytes.unwrap_or(4) {
                size @ (1 | 2 | 4 | 8) => size,
                _ => return Err(wrong(&char::from(conversion).to_string())),
            },
            Kind::Float(conversion) => match unit.bytes.unwrap_or(8) {
                size @ (4 | 8) => size,
                _ => return Err(wrong(&char::from(conversion).to_string())),
            },
            Kind::Char | Kind::Escaped | Kind::Printable | Kind::Named => {
                match unit.bytes.unwrap_or(1) {
                    1 => 1,
                    _ => {
                        return Err(wrong(match print.kind {
                            Kind::Char => "c",
                            Kind::Escaped => "_c",
                            Kind::Printable => "_p",
                            _ => "_u",
                        }));
                    }
                }
            }
            Kind::Str => match (unit.bytes, print.precision) {
                (Some(bytes), _) => bytes,
                (None, Some(precision)) => precision,
                (None, None) => {
                    return Err("hexdump: %s requires a precision or a byte count".to_string());
                }
            },
        };
    }
    if reading == 0
        && let (Some(bytes), Some(text)) = (unit.bytes, prints.first_mut())
        && text.kind == Kind::Text
    {
        text.size = bytes;
    }
    Ok(())
}

/// How a print shows a value it reads from `data`, past which the block
/// holds zeros, at `address`.
pub(super) fn render(print: &Print, data: &[u8], address: u64, reps: usize, out: &mut Vec<u8>) {
    let take = |size: usize| -> u64 {
        let mut word = [0u8; 8];
        let have = data.len().min(size);
        word[..have].copy_from_slice(&data[..have]);
        u64::from_le_bytes(word)
    };
    match print.kind {
        Kind::Text => {}
        Kind::Address { radix, .. } => {
            let rendered = render_integer(
                i128::from(address),
                radix,
                &print.flags,
                as_u64(print.precision),
            );
            pad(&rendered, &print.flags, print.width, out);
        }
        Kind::Integer(conversion) => {
            let raw = take(print.size);
            let value = match conversion {
                b'd' | b'i' => {
                    let shift = 64 - 8 * print.size as u32;
                    i128::from(((raw << shift) as i64) >> shift)
                }
                _ => i128::from(raw),
            };
            let rendered = render_integer(value, conversion, &print.flags, as_u64(print.precision));
            pad(&rendered, &print.flags, print.width, out);
        }
        Kind::Float(conversion) => {
            let raw = take(print.size);
            let value = match print.size {
                4 => f64::from(f32::from_bits(raw as u32)),
                _ => f64::from_bits(raw),
            };
            let rendered = render_float(value, conversion, &print.flags, as_u64(print.precision));
            pad(&rendered, &print.flags, print.width, out);
        }
        Kind::Char => text(&[data.first().copied().unwrap_or(0)], print, out),
        Kind::Str => {
            // A count that repeats leaves the string to run to the block's
            // end, or to a NUL.
            let limit = match (print.precision, reps) {
                (Some(precision), _) => precision,
                (None, 1) => print.size,
                (None, _) => data.len(),
            };
            let shown = &data[..data.len().min(limit)];
            let end = shown.iter().position(|&b| b == 0).unwrap_or(shown.len());
            text(&shown[..end], print, out);
        }
        Kind::Escaped => {
            let byte = data.first().copied().unwrap_or(0);
            let shown: Vec<u8> = match byte {
                0 => b"\\0".to_vec(),
                0x07 => b"\\a".to_vec(),
                0x08 => b"\\b".to_vec(),
                0x0c => b"\\f".to_vec(),
                b'\n' => b"\\n".to_vec(),
                b'\r' => b"\\r".to_vec(),
                b'\t' => b"\\t".to_vec(),
                0x0b => b"\\v".to_vec(),
                0x20..=0x7e => vec![byte],
                _ => format!("{byte:03o}").into_bytes(),
            };
            text(&shown, print, out);
        }
        Kind::Printable => {
            let byte = data.first().copied().unwrap_or(0);
            let shown = if (0x20..=0x7e).contains(&byte) {
                byte
            } else {
                b'.'
            };
            text(&[shown], print, out);
        }
        Kind::Named => {
            let byte = data.first().copied().unwrap_or(0);
            let shown: Vec<u8> = match byte {
                0x00..=0x1f => NAMES[usize::from(byte)].to_vec(),
                0x7f => b"del".to_vec(),
                0x20..=0x7e => vec![byte],
                _ => format!("{byte:02x}").into_bytes(),
            };
            text(&shown, print, out);
        }
    }
}

/// What a print shows past the end of the input: as many blanks as a
/// string conversion of its width would.
pub(super) fn blank(print: &Print, out: &mut Vec<u8>) {
    if print.kind != Kind::Text {
        out.resize(out.len() + print.width, b' ');
    }
}

fn as_u64(precision: Option<usize>) -> Option<u64> {
    precision.map(|p| p as u64)
}

/// Lay a string out in the print's width, on the left under `-`.
fn text(shown: &[u8], print: &Print, out: &mut Vec<u8>) {
    let gap = print.width.saturating_sub(shown.len());
    let left = print.flags.contains(&b'-');
    if !left {
        out.resize(out.len() + gap, b' ');
    }
    out.extend_from_slice(shown);
    if left {
        out.resize(out.len() + gap, b' ');
    }
}

/// Lay a number out in `width`, on the left under `-`, zero-filled under
/// `0` where the conversion allows it.
fn pad(rendered: &Rendered, flags: &[u8], width: usize, out: &mut Vec<u8>) {
    let len = usize::try_from(rendered.byte_len()).unwrap_or(usize::MAX);
    let gap = width.saturating_sub(len);
    let left = flags.contains(&b'-');
    let zero = rendered.allow_zero && flags.contains(&b'0') && !left;
    if !left && !zero {
        out.resize(out.len() + gap, b' ');
    }
    out.extend_from_slice(&rendered.prefix);
    if zero {
        out.resize(out.len() + gap, b'0');
    }
    out.extend_from_slice(&rendered.body);
    out.resize(
        out.len() + usize::try_from(rendered.zero_tail).unwrap_or(0),
        b'0',
    );
    out.extend_from_slice(&rendered.suffix);
    if left {
        out.resize(out.len() + gap, b' ');
    }
}
