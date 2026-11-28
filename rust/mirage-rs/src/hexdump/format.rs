//! hexdump's format strings: units of an iteration count, a byte count
//! and a quoted printf-style text, read into the prints a block runs
//! through, and the one-letter options as the format strings they stand
//! for.

use std::collections::VecDeque;

use crate::printf::number::{Rendered, render_float, render_integer_into};

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

impl Print {
    /// Whether the print reads bytes of the block.
    fn reads(&self) -> bool {
        !matches!(self.kind, Kind::Text | Kind::Address { .. })
    }

    /// A width or a precision past C's `int`, which printf refuses: the
    /// conversion and the text before it show nothing.
    pub(super) fn lost(&self) -> bool {
        let most = i32::MAX as usize;
        self.width > most || self.precision.is_some_and(|precision| precision > most)
    }
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
    /// The bytes one iteration takes of the block: what its conversions
    /// read, or, for a unit that reads none, its byte count, which moves
    /// no conversion on.
    pub(super) fn span(&self) -> usize {
        if self.prints.iter().any(Print::reads) {
            self.prints
                .iter()
                .fold(0usize, |sum, print| sum.saturating_add(print.size))
        } else {
            self.bytes.unwrap_or(0)
        }
    }

    pub(super) fn total(&self) -> usize {
        self.reps.saturating_mul(self.span())
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
        let slash = raw.get(at) == Some(&b'/');
        if slash {
            at += 1;
            while raw.get(at).is_some_and(|&b| blank(b)) {
                at += 1;
            }
        }
        // After an iteration count the byte count needs no slash.
        if slash || counted {
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
        // A color annotation runs to the text's last `]`; mirage writes no
        // color, so it shows nothing.
        if text[at..].starts_with(b"_L") {
            let close = text[at..]
                .starts_with(b"_L[")
                .then(|| text[at..].iter().rposition(|&b| b == b']'))
                .flatten()
                .ok_or_else(|| bad_conversion(b"_L"))?;
            at += close + 1;
        }
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
/// conversion's own.
fn size(unit: &Unit, prints: &mut [Print]) -> Result<(), String> {
    let reading = prints.iter().filter(|print| print.reads()).count();
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
    Ok(())
}

/// Output held past a `drain`'s budget: bytes from an offset on, or a run
/// of one byte.
pub(super) enum Piece {
    Bytes(Vec<u8>, usize),
    Run(u8, usize),
}

/// Where output goes in one `drain`: bytes and runs of one byte are
/// written up to `limit` and the rest, and all that follows, held for the
/// next; `prints` counts down the prints the call may still run, and
/// `number` holds each integer while it is laid out.
pub(super) struct Sink<'a> {
    out: &'a mut Vec<u8>,
    limit: usize,
    pub(super) held: VecDeque<Piece>,
    pub(super) prints: usize,
    number: Rendered,
}

impl<'a> Sink<'a> {
    pub(super) fn new(
        out: &'a mut Vec<u8>,
        room: usize,
        prints: usize,
        held: VecDeque<Piece>,
    ) -> Sink<'a> {
        let limit = out.len().saturating_add(room);
        Sink {
            out,
            limit,
            held,
            prints,
            number: Rendered::default(),
        }
    }

    /// The output budget or the prints are spent, or output is held.
    pub(super) fn spent(&self) -> bool {
        !self.held.is_empty() || self.out.len() >= self.limit || self.prints == 0
    }

    pub(super) fn bytes(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if !self.held.is_empty() {
            self.held.push_back(Piece::Bytes(bytes.to_vec(), 0));
            return;
        }
        let now = bytes.len().min(self.limit.saturating_sub(self.out.len()));
        self.out.extend_from_slice(&bytes[..now]);
        if now < bytes.len() {
            self.held.push_back(Piece::Bytes(bytes[now..].to_vec(), 0));
        }
    }

    pub(super) fn run(&mut self, byte: u8, count: usize) {
        if count == 0 {
            return;
        }
        if !self.held.is_empty() {
            self.held.push_back(Piece::Run(byte, count));
            return;
        }
        let now = count.min(self.limit.saturating_sub(self.out.len()));
        self.out.resize(self.out.len() + now, byte);
        if now < count {
            self.held.push_back(Piece::Run(byte, count - now));
        }
    }

    /// Write what an earlier call held, as far as the budget goes.
    pub(super) fn release(&mut self) {
        while let Some(piece) = self.held.pop_front() {
            match piece {
                // The rest stays where it is, its offset moved on.
                Piece::Bytes(bytes, at) => {
                    let left = bytes.len() - at;
                    let now = left.min(self.limit.saturating_sub(self.out.len()));
                    self.out.extend_from_slice(&bytes[at..at + now]);
                    if now < left {
                        self.held.push_front(Piece::Bytes(bytes, at + now));
                        return;
                    }
                }
                Piece::Run(byte, count) => {
                    let now = count.min(self.limit.saturating_sub(self.out.len()));
                    self.out.resize(self.out.len() + now, byte);
                    if now < count {
                        self.held.push_front(Piece::Run(byte, count - now));
                        return;
                    }
                }
            }
        }
    }
}

/// How a print shows a value it reads from `data`, the rest of its block,
/// at `address`.
pub(super) fn render(print: &Print, data: &[u8], address: u64, sink: &mut Sink) {
    let take = |size: usize| -> u64 {
        let mut word = [0u8; 8];
        let have = data.len().min(size);
        word[..have].copy_from_slice(&data[..have]);
        u64::from_le_bytes(word)
    };
    match print.kind {
        Kind::Text => {}
        Kind::Address { radix, .. } => {
            integer(print, i128::from(address), radix, sink);
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
            integer(print, value, conversion, sink);
        }
        Kind::Float(conversion) => {
            let raw = take(print.size);
            let value = match print.size {
                4 => f64::from(f32::from_bits(raw as u32)),
                _ => f64::from_bits(raw),
            };
            let rendered = render_float(value, conversion, &print.flags, as_u64(print.precision));
            pad(&rendered, &print.flags, print.width, sink);
        }
        Kind::Char => text(&[data.first().copied().unwrap_or(0)], print, sink),
        Kind::Str => {
            // The string runs to a NUL or the block's end, whatever the
            // bytes it moves the next conversion on.
            let limit = print.precision.unwrap_or(data.len());
            let shown = &data[..data.len().min(limit)];
            let end = shown.iter().position(|&b| b == 0).unwrap_or(shown.len());
            text(&shown[..end], print, sink);
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
            text(&shown, print, sink);
        }
        Kind::Printable => {
            let byte = data.first().copied().unwrap_or(0);
            let shown = if (0x20..=0x7e).contains(&byte) {
                byte
            } else {
                b'.'
            };
            text(&[shown], print, sink);
        }
        Kind::Named => {
            let byte = data.first().copied().unwrap_or(0);
            let shown: Vec<u8> = match byte {
                0x00..=0x1f => NAMES[usize::from(byte)].to_vec(),
                0x7f => b"del".to_vec(),
                0x20..=0x7e => vec![byte],
                _ => format!("{byte:02x}").into_bytes(),
            };
            text(&shown, print, sink);
        }
    }
}

/// What a print shows past the end of the input: as many blanks as a
/// string conversion of its width would.
pub(super) fn blank(print: &Print, sink: &mut Sink) {
    if print.kind != Kind::Text {
        sink.run(b' ', print.width);
    }
}

fn as_u64(precision: Option<usize>) -> Option<u64> {
    precision.map(|p| p as u64)
}

/// `value` under `conversion`, laid out in the print's width through the
/// sink's own buffers.
fn integer(print: &Print, value: i128, conversion: u8, sink: &mut Sink) {
    let mut number = std::mem::take(&mut sink.number);
    render_integer_into(
        value,
        conversion,
        &print.flags,
        as_u64(print.precision),
        &mut number,
    );
    pad(&number, &print.flags, print.width, sink);
    sink.number = number;
}

/// Lay a string out in the print's width, on the left under `-`.
fn text(shown: &[u8], print: &Print, sink: &mut Sink) {
    let gap = print.width.saturating_sub(shown.len());
    let left = print.flags.contains(&b'-');
    if !left {
        sink.run(b' ', gap);
    }
    sink.bytes(shown);
    if left {
        sink.run(b' ', gap);
    }
}

/// Lay a number out in `width`, on the left under `-`, zero-filled under
/// `0` where the conversion allows it.
fn pad(rendered: &Rendered, flags: &[u8], width: usize, sink: &mut Sink) {
    let len = usize::try_from(rendered.byte_len()).unwrap_or(usize::MAX);
    let gap = width.saturating_sub(len);
    let left = flags.contains(&b'-');
    let zero = rendered.allow_zero && flags.contains(&b'0') && !left;
    if !left && !zero {
        sink.run(b' ', gap);
    }
    sink.bytes(&rendered.prefix);
    if zero {
        sink.run(b'0', gap);
    }
    sink.bytes(&rendered.body);
    sink.run(
        b'0',
        usize::try_from(rendered.zero_tail).unwrap_or(usize::MAX),
    );
    sink.bytes(&rendered.suffix);
    if left {
        sink.run(b' ', gap);
    }
}
