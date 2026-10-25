//! od's output types: what a TYPE string or a traditional letter names,
//! each value's text at its width, and the padding that lines several
//! types up under one another.

use std::fmt::Write as _;

use num_bigint::BigUint;
use num_traits::One;

use crate::quoted;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Kind {
    Named,
    Char,
    Signed,
    Unsigned,
    Octal,
    Hex,
    /// IEEE half precision: `fH` or `f2`.
    Half,
    /// bfloat16: `fB`.
    Brain,
    /// binary32, binary64, or `fL`, binary128 as on aarch64.
    Float,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Format {
    pub(super) kind: Kind,
    pub(super) size: usize,
    /// `z`: the line's bytes in print after its values.
    pub(super) z: bool,
}

const NAMES: [&[u8]; 33] = [
    b"nul", b"soh", b"stx", b"etx", b"eot", b"enq", b"ack", b"bel", b"bs", b"ht", b"nl", b"vt",
    b"ff", b"cr", b"so", b"si", b"dle", b"dc1", b"dc2", b"dc3", b"dc4", b"nak", b"syn", b"etb",
    b"can", b"em", b"sub", b"esc", b"fs", b"gs", b"rs", b"us", b"sp",
];

impl Format {
    pub(super) fn new(kind: Kind, size: usize) -> Format {
        Format {
            kind,
            size,
            z: false,
        }
    }

    /// The type a traditional option letter stands for.
    pub(super) fn letter(letter: u8) -> Option<Format> {
        let (kind, size) = match letter {
            b'a' => (Kind::Named, 1),
            b'b' => (Kind::Octal, 1),
            b'c' => (Kind::Char, 1),
            b'd' => (Kind::Unsigned, 2),
            b'D' => (Kind::Unsigned, 4),
            b'e' | b'F' => (Kind::Float, 8),
            b'f' => (Kind::Float, 4),
            b'h' | b'x' => (Kind::Hex, 2),
            b'H' | b'X' => (Kind::Hex, 4),
            b'i' => (Kind::Signed, 4),
            b'I' | b'l' | b'L' => (Kind::Signed, 8),
            b'o' | b'B' => (Kind::Octal, 2),
            b'O' => (Kind::Octal, 4),
            b's' => (Kind::Signed, 2),
            _ => return None,
        };
        Some(Format::new(kind, size))
    }

    /// The widest value's length: the most negative or the largest
    /// integer of the size, all its octal or hex digits, or a float's
    /// sign, round-trip digits, point and widest exponent.
    fn width(&self) -> usize {
        let index = self.size.trailing_zeros() as usize;
        match self.kind {
            Kind::Named | Kind::Char => 3,
            Kind::Signed => [4, 6, 11, 20][index],
            Kind::Unsigned => [3, 5, 10, 20][index],
            Kind::Octal => [3, 6, 11, 22][index],
            Kind::Hex => 2 * self.size,
            Kind::Half | Kind::Brain => 15,
            Kind::Float => [15, 24, 44][index - 2],
        }
    }
}

/// Append the types a TYPE string names, or refuse it as GNU does: the
/// first character it cannot read, or a size no type of the kind has.
pub(super) fn parse(spec: &[u8], formats: &mut Vec<Format>) -> Result<(), Vec<u8>> {
    let mut at = 0;
    while at < spec.len() {
        let letter = spec[at];
        at += 1;
        let format = match letter {
            b'a' => Format::new(Kind::Named, 1),
            b'c' => Format::new(Kind::Char, 1),
            b'd' | b'o' | b'u' | b'x' => {
                let kind = match letter {
                    b'd' => Kind::Signed,
                    b'o' => Kind::Octal,
                    b'u' => Kind::Unsigned,
                    _ => Kind::Hex,
                };
                let named = match spec.get(at) {
                    Some(b'C') => 1,
                    Some(b'S') => 2,
                    Some(b'I') => 4,
                    Some(b'L') => 8,
                    _ => 0,
                };
                let size = sized(spec, &mut at, named, 4)?;
                if ![1, 2, 4, 8].contains(&size) {
                    return Err(unsupported(spec, size, "integral"));
                }
                Format::new(kind, size)
            }
            b'f' => {
                let (kind, named) = match spec.get(at) {
                    Some(b'B') => (Kind::Brain, 2),
                    Some(b'H') => (Kind::Half, 2),
                    Some(b'F') => (Kind::Float, 4),
                    Some(b'D') => (Kind::Float, 8),
                    Some(b'L') => (Kind::Float, 16),
                    _ => (Kind::Float, 0),
                };
                match sized(spec, &mut at, named, 8)? {
                    2 if kind == Kind::Float => Format::new(Kind::Half, 2),
                    size @ (2 | 4 | 8 | 16) => Format::new(kind, size),
                    size => return Err(unsupported(spec, size, "floating point")),
                }
            }
            _ => {
                let mut refused = b"od: invalid character '".to_vec();
                refused.push(letter);
                refused
                    .extend_from_slice(format!("' in type string '{}'", quoted(spec)).as_bytes());
                return Err(refused);
            }
        };
        let z = spec.get(at) == Some(&b'z');
        at += usize::from(z);
        formats.push(Format { z, ..format });
    }
    Ok(())
}

/// A type's size: the one its letter names, the digits given, or
/// `default` for neither.
fn sized(spec: &[u8], at: &mut usize, named: usize, default: usize) -> Result<usize, Vec<u8>> {
    if named > 0 {
        *at += 1;
        return Ok(named);
    }
    let digits = spec[*at..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if digits == 0 {
        return Ok(default);
    }
    let size = spec[*at..*at + digits].iter().try_fold(0usize, |n, d| {
        n.checked_mul(10)?.checked_add(usize::from(d - b'0'))
    });
    *at += digits;
    size.ok_or_else(|| format!("od: invalid type string '{}'", quoted(spec)).into_bytes())
}

fn unsupported(spec: &[u8], size: usize, what: &str) -> Vec<u8> {
    format!(
        "od: invalid type string '{}';\nthis system doesn't provide a {size}-byte {what} type",
        quoted(spec)
    )
    .into_bytes()
}

/// The values a line holds at most for their padding to be worked out
/// ahead; a value's share is under 256, less than a line's widest span
/// of 16 bytes.
const SHARES: u128 = 4096;

/// One type's line: its values, each widened so that every type's
/// values over the same bytes end in the same column.
struct Column {
    format: Format,
    width: usize,
    /// The values on a full line, and the spaces spread over them, each
    /// value's share worked out ahead for a line of up to `SHARES`.
    fields: u128,
    pad: u128,
    extras: Vec<u8>,
    /// For a one-byte type, every byte's value after its separator.
    table: Vec<u8>,
}

/// The types of a dump laid out over lines of `width` bytes, each
/// `total` columns wide past the address.
pub(super) struct Layout {
    columns: Vec<Column>,
    total: usize,
    scratch: Scratch,
}

/// The buffers a float's text is written through, kept between values.
#[derive(Default)]
struct Scratch {
    shortest: String,
    text: Vec<u8>,
}

impl Layout {
    pub(super) fn new(formats: &[Format], width: usize) -> Layout {
        let span = |format: &Format| (format.width() + 1).saturating_mul(width / format.size);
        let total = formats.iter().map(span).max().unwrap_or(0);
        let mut scratch = Scratch::default();
        let columns = formats
            .iter()
            .map(|format| {
                let mut column = Column {
                    format: *format,
                    width: format.width(),
                    fields: (width / format.size) as u128,
                    pad: (total - span(format)) as u128,
                    extras: Vec::new(),
                    table: Vec::new(),
                };
                if column.pad > 0 && column.fields <= SHARES {
                    column.extras = (0..column.fields as usize)
                        .map(|f| column.extra(f) as u8)
                        .collect();
                }
                if format.size == 1 {
                    let mut table = Vec::with_capacity(256 * (column.width + 1));
                    for byte in 0..=255u8 {
                        table.push(b' ');
                        column.value(&[byte], &mut scratch, &mut table);
                    }
                    column.table = table;
                }
                column
            })
            .collect();
        Layout {
            columns,
            total,
            scratch,
        }
    }

    pub(super) fn count(&self) -> usize {
        self.columns.len()
    }

    /// Type `index`'s line over `block`, which falls short of a full line
    /// only at the end, without its address.
    pub(super) fn line(&mut self, index: usize, block: &[u8], big: bool, out: &mut Vec<u8>) {
        let column = &self.columns[index];
        let start = out.len();
        if column.table.is_empty() {
            let size = column.format.size;
            for (field, piece) in block.chunks(size).enumerate() {
                out.resize(out.len() + column.extra(field) + 1, b' ');
                let mut unit = [0u8; 16];
                unit[..piece.len()].copy_from_slice(piece);
                if big {
                    unit[..size].reverse();
                }
                column.value(&unit[..size], &mut self.scratch, out);
            }
        } else {
            let cell = column.width + 1;
            for (field, &byte) in block.iter().enumerate() {
                out.resize(out.len() + column.extra(field), b' ');
                let at = usize::from(byte) * cell;
                out.extend_from_slice(&column.table[at..at + cell]);
            }
        }
        if column.format.z {
            let used = out.len() - start;
            out.resize(out.len() + self.total - used + 2, b' ');
            out.push(b'>');
            out.extend(
                block
                    .iter()
                    .map(|&b| if (32..127).contains(&b) { b } else { b'.' }),
            );
            out.push(b'<');
        }
        out.push(b'\n');
    }
}

impl Column {
    /// The spaces before value `field` beyond its separator: its share of
    /// the line's padding, spread as evenly as whole spaces allow.
    fn extra(&self, field: usize) -> usize {
        if self.pad == 0 {
            return 0;
        }
        if let Some(&extra) = self.extras.get(field) {
            return usize::from(extra);
        }
        let field = field as u128;
        let before = self.pad * (self.fields - field) / self.fields;
        let after = self.pad * (self.fields - field - 1) / self.fields;
        (before - after) as usize
    }

    /// One value right-aligned to the type's width, from its bytes in
    /// little-endian order.
    fn value(&self, unit: &[u8], scratch: &mut Scratch, out: &mut Vec<u8>) {
        let mut word = [0u8; 8];
        let low = unit.len().min(8);
        word[..low].copy_from_slice(&unit[..low]);
        let raw = u64::from_le_bytes(word);
        let width = self.width;
        match self.format.kind {
            Kind::Named => {
                let byte = unit[0] & 0x7f;
                let name = match byte {
                    0..=32 => NAMES[usize::from(byte)],
                    127 => b"del",
                    _ => std::slice::from_ref(&byte),
                };
                right(name, width, out);
            }
            Kind::Char => {
                let escape: &[u8] = match unit[0] {
                    0 => b"\\0",
                    7 => b"\\a",
                    8 => b"\\b",
                    9 => b"\\t",
                    10 => b"\\n",
                    11 => b"\\v",
                    12 => b"\\f",
                    13 => b"\\r",
                    32..=126 => &unit[..1],
                    byte => return digits(u64::from(byte), 8, 3, out),
                };
                right(escape, width, out);
            }
            Kind::Signed => {
                let shift = 64 - 8 * self.format.size as u32;
                let value = ((raw << shift) as i64) >> shift;
                decimal(value.unsigned_abs(), value < 0, width, out);
            }
            Kind::Unsigned => decimal(raw, false, width, out),
            Kind::Octal => digits(raw, 8, width, out),
            Kind::Hex => digits(raw, 16, width, out),
            Kind::Half | Kind::Brain | Kind::Float => {
                let mut text = std::mem::take(&mut scratch.text);
                text.clear();
                match (self.format.kind, self.format.size) {
                    (Kind::Half, _) => single(half(raw as u16), scratch, &mut text),
                    (Kind::Brain, _) => single((raw as u32) << 16, scratch, &mut text),
                    (_, 4) => single(raw as u32, scratch, &mut text),
                    (_, 8) => double(raw, scratch, &mut text),
                    _ => {
                        let mut bits = [0u8; 16];
                        bits.copy_from_slice(unit);
                        quad(u128::from_le_bytes(bits), &mut text);
                    }
                }
                right(&text, width, out);
                scratch.text = text;
            }
        }
    }
}

fn right(text: &[u8], width: usize, out: &mut Vec<u8>) {
    out.resize(out.len() + width.saturating_sub(text.len()), b' ');
    out.extend_from_slice(text);
}

fn decimal(mut n: u64, negative: bool, width: usize, out: &mut Vec<u8>) {
    let mut text = [0u8; 21];
    let mut at = text.len();
    loop {
        at -= 1;
        text[at] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    if negative {
        at -= 1;
        text[at] = b'-';
    }
    right(&text[at..], width, out);
}

/// `count` digits of `n` in base 8 or 16, zero-filled.
fn digits(n: u64, base: u64, count: usize, out: &mut Vec<u8>) {
    let bits = base.trailing_zeros() as usize;
    for place in (0..count).rev() {
        let digit = n.checked_shr((place * bits) as u32).unwrap_or(0) & (base - 1);
        out.push(b"0123456789abcdef"[digit as usize]);
    }
}

/// A half-precision value as the float it widens to, exactly.
fn half(bits: u16) -> u32 {
    let sign = u32::from(bits >> 15) << 31;
    let exponent = u32::from((bits >> 10) & 0x1f);
    let fraction = u32::from(bits & 0x3ff);
    sign | match exponent {
        0 => (f32::from(bits & 0x3ff) * f32::from_bits(0x3380_0000)).to_bits(),
        0x1f => 0x7f80_0000 | fraction << 13,
        _ => (exponent + 112) << 23 | fraction << 13,
    }
}

// GNU od prints a float as gnulib's ftoastr does: `%.*g` from the type's
// guaranteed digits (FLT_DIG, DBL_DIG, LDBL_DIG; 1 below the normal
// range) up until the text reads back as the value.

fn single(bits: u32, scratch: &mut Scratch, out: &mut Vec<u8>) {
    let field = bits >> 23 & 0xff;
    let fraction = u64::from(bits & 0x7f_ffff);
    let (m, e) = match field {
        0 => (fraction, -149),
        _ => (fraction | 1 << 23, field as i32 - 150),
    };
    if field == 0xff {
        return special(bits >> 31 == 1, fraction != 0, out);
    }
    let edge = field > 1 && fraction == 0;
    let value = f32::from_bits(bits & !(1 << 31));
    let guaranteed = if field == 0 && m > 0 { 1 } else { 6 };
    float(
        value,
        bits >> 31 == 1,
        guaranteed,
        (m, e, edge),
        scratch,
        out,
    );
}

fn double(bits: u64, scratch: &mut Scratch, out: &mut Vec<u8>) {
    let field = (bits >> 52 & 0x7ff) as i32;
    let fraction = bits & ((1 << 52) - 1);
    let (m, e) = match field {
        0 => (fraction, -1074),
        _ => (fraction | 1 << 52, field - 1075),
    };
    if field == 0x7ff {
        return special(bits >> 63 == 1, fraction != 0, out);
    }
    let edge = field > 1 && fraction == 0;
    let value = f64::from_bits(bits & !(1 << 63));
    let guaranteed = if field == 0 && m > 0 { 1 } else { 15 };
    float(
        value,
        bits >> 63 == 1,
        guaranteed,
        (m, e, edge),
        scratch,
        out,
    );
}

fn special(negative: bool, nan: bool, out: &mut Vec<u8>) {
    if negative {
        out.push(b'-');
    }
    out.extend_from_slice(if nan { b"nan" } else { b"inf" });
}

/// Up to the guaranteed digits the shortest that read back are the
/// nearest ones too. Past them a tie, which `%g` rounds to even, or a
/// power of two, whose value below is half as far as the one above, can
/// part the two, and there the nearest at each precision is read back as
/// GNU does.
fn float<T>(
    magnitude: T,
    negative: bool,
    guaranteed: usize,
    (m, e, edge): (u64, i32, bool),
    scratch: &mut Scratch,
    out: &mut Vec<u8>,
) where
    T: Copy + PartialEq + std::str::FromStr + std::fmt::LowerExp,
{
    if negative {
        out.push(b'-');
    }
    let text = &mut scratch.shortest;
    text.clear();
    let _ = write!(text, "{magnitude:e}");
    let shortest = text.find('e').unwrap_or(text.len()) - usize::from(text.contains('.'));
    let mut precision = shortest.max(guaranteed);
    if shortest > guaranteed && (edge || tie(m, e, shortest)) {
        loop {
            text.clear();
            let _ = write!(text, "{magnitude:.*e}", precision - 1);
            if text.parse::<T>().is_ok_and(|back| back == magnitude) {
                break;
            }
            precision += 1;
        }
    }
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text.as_str(), "0"));
    let mut digits = [0u8; 40];
    let mut count = 0;
    for digit in mantissa.bytes().filter(|&b| b != b'.') {
        digits[count] = digit;
        count += 1;
    }
    general(
        &digits[..count],
        exponent.parse().unwrap_or(0),
        precision,
        out,
    );
}

/// Whether `m * 2**e` lies half way between two decimals of `count`
/// digits: it has exactly one digit more, a 5.
fn tie(m: u64, e: i32, count: usize) -> bool {
    let shift = m.trailing_zeros();
    let (m, e) = (u128::from(m >> shift), e + shift as i32);
    let exact = match e {
        0..=60 => m << e,
        -27..=-1 => m * 5u128.pow(e.unsigned_abs()),
        _ => return false,
    };
    exact % 10 == 5 && exact.ilog10() as usize == count
}

/// `digits`, the first at `10**point`, as `%.{precision}g` lays them out
/// once rounded to them, trailing zeros dropped.
fn general(digits: &[u8], point: i32, precision: usize, out: &mut Vec<u8>) {
    let end = digits
        .iter()
        .rposition(|&d| d != b'0')
        .map_or(1, |at| at + 1);
    let digits = &digits[..end];
    if point < -4 || point >= precision as i32 {
        out.push(digits[0]);
        if digits.len() > 1 {
            out.push(b'.');
            out.extend_from_slice(&digits[1..]);
        }
        out.extend_from_slice(if point < 0 { b"e-" } else { b"e+" });
        if point.unsigned_abs() < 10 {
            out.push(b'0');
        }
        decimal(u64::from(point.unsigned_abs()), false, 0, out);
    } else if point < 0 {
        out.extend_from_slice(b"0.");
        out.resize(out.len() + point.unsigned_abs() as usize - 1, b'0');
        out.extend_from_slice(digits);
    } else {
        let whole = point as usize + 1;
        out.extend_from_slice(&digits[..whole.min(digits.len())]);
        out.resize(out.len() + whole.saturating_sub(digits.len()), b'0');
        if digits.len() > whole {
            out.push(b'.');
            out.extend_from_slice(&digits[whole..]);
        }
    }
}

/// `fL`: binary128, aarch64's long double, where the repository pins
/// long double output (x86-64's is the 80-bit format).
fn quad(bits: u128, out: &mut Vec<u8>) {
    let field = ((bits >> 112) & 0x7fff) as i32;
    let fraction = bits & ((1 << 112) - 1);
    if field == 0x7fff {
        return special(bits >> 127 == 1, fraction != 0, out);
    }
    if bits >> 127 == 1 {
        out.push(b'-');
    }
    let (m, e) = match field {
        0 => (fraction, -16494),
        _ => (fraction | 1 << 112, field - 16495),
    };
    if m == 0 {
        return out.push(b'0');
    }
    // At a power of two the value below is half as far as the one above.
    let edge = field > 1 && fraction == 0;
    let mut precision = if field == 0 { 1 } else { 33 };
    loop {
        let (digits, point) = rounded(m, e, precision);
        if reads_back(m, e, &digits, point, edge) {
            return general(&digits, point, precision, out);
        }
        precision += 1;
    }
}

fn ten(power: i32) -> BigUint {
    BigUint::from(10u8).pow(power.unsigned_abs())
}

/// `m * 2**e` to `precision` significant digits, ties to even, and the
/// power of ten of the first digit.
fn rounded(m: u128, e: i32, precision: usize) -> (Vec<u8>, i32) {
    let precision = precision as i32;
    let bits = 128 - m.leading_zeros() as i32;
    let mut point = (f64::from(bits - 1 + e) * std::f64::consts::LOG10_2).floor() as i32;
    let (top, bottom) = (ten(precision), ten(precision - 1));
    loop {
        let shift = point - precision + 1;
        let mut num = BigUint::from(m);
        let mut den = BigUint::one();
        if e > 0 {
            num <<= e as usize;
        } else {
            den <<= (-e) as usize;
        }
        if shift > 0 {
            den *= ten(shift);
        } else {
            num *= ten(shift);
        }
        let mut digits = &num / &den;
        if digits >= top {
            point += 1;
            continue;
        }
        if digits < bottom {
            point -= 1;
            continue;
        }
        let twice = (num % &den) << 1usize;
        if twice > den || twice == den && digits.bit(0) {
            digits += 1u8;
        }
        if digits == top {
            digits = bottom;
            point += 1;
        }
        return (digits.to_str_radix(10).into_bytes(), point);
    }
}

/// Whether the decimal reads back as `m * 2**e`: it lies within half a
/// step of it, on the half-way point only when `m` is even.
fn reads_back(m: u128, e: i32, digits: &[u8], point: i32, edge: bool) -> bool {
    let shift = point - digits.len() as i32 + 1;
    let twos = (2 - e).max(0);
    let tens = (-shift).max(0);
    let scale = ten(tens);
    let decimal =
        (BigUint::parse_bytes(digits, 10).unwrap_or_default() * ten(shift + tens)) << twos as usize;
    let value = (BigUint::from(m) << (e + twos) as usize) * &scale;
    let above = (BigUint::one() << (e - 1 + twos) as usize) * &scale;
    let below = if edge {
        &above >> 1usize
    } else {
        above.clone()
    };
    let (gap, half) = if decimal >= value {
        (decimal - value, above)
    } else {
        (value - decimal, below)
    };
    gap < half || gap == half && m % 2 == 0
}
