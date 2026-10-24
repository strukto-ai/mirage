use std::borrow::Cow;
use std::cmp::Ordering;

use crate::printf::number::{Rendered, render_float, render_integer};

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Value {
    Uninit,
    Num(f64),
    Str(Vec<u8>),
    /// Text from the input (a field, a getline record, split's pieces,
    /// ARGV, ENVIRON, an assignment): a number when it looks like one.
    /// Never empty.
    Strnum(Vec<u8>),
    /// An array passed to a function, only ever a call's argument.
    Array(usize),
}

/// Input-derived text: an absent or empty field is a plain string, so
/// `$9 == 0` is false where `x == 0` is true for an unset `x`.
pub(super) fn strnum(raw: Vec<u8>) -> Value {
    if raw.is_empty() {
        Value::Str(raw)
    } else {
        Value::Strnum(raw)
    }
}

fn blank(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n')
}

/// The length of the awk number at the start of `raw`, or 0:
/// `[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?`.
fn number_len(raw: &[u8]) -> usize {
    let digits = |from: usize| {
        raw[from..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    let mut at = usize::from(matches!(raw.first(), Some(b'+' | b'-')));
    let whole = digits(at);
    at += whole;
    if raw.get(at) == Some(&b'.') {
        let fraction = digits(at + 1);
        if whole == 0 && fraction == 0 {
            return 0;
        }
        at += 1 + fraction;
    } else if whole == 0 {
        return 0;
    }
    if matches!(raw.get(at), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(raw.get(at + 1), Some(b'+' | b'-')));
        let exponent = digits(at + 1 + sign);
        if exponent > 0 {
            at += 1 + sign + exponent;
        }
    }
    at
}

fn trimmed(raw: &[u8]) -> &[u8] {
    let start = raw.iter().position(|&c| !blank(c)).unwrap_or(raw.len());
    let end = raw
        .iter()
        .rposition(|&c| !blank(c))
        .map_or(start, |at| at + 1);
    &raw[start..end]
}

/// Whether text, blanks aside, is an awk number as a whole.
pub(super) fn looks_numeric(raw: &[u8]) -> bool {
    let body = trimmed(raw);
    !body.is_empty() && number_len(body) == body.len()
}

/// The number text starts with, strtod style but decimal only; 0 when it
/// starts with none.
pub(super) fn parse_number(raw: &[u8]) -> f64 {
    let start = raw.iter().position(|&c| !blank(c)).unwrap_or(raw.len());
    let body = &raw[start..];
    let len = number_len(body);
    std::str::from_utf8(&body[..len])
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(0.0)
}

/// The most bytes one string, or one printf field, may take.
pub(super) const MAX_LEN: usize = 1 << 30;

/// A number truncated toward zero, as awk reads an integer: NaN is 0, an
/// infinity the 64-bit edge, and a magnitude past `i128` saturates.
pub(super) fn to_int(value: f64) -> i128 {
    if value.is_nan() {
        0
    } else if value.is_infinite() {
        if value > 0.0 { 1 << 63 } else { -(1 << 63) }
    } else {
        value.trunc() as i128
    }
}

impl Value {
    pub(super) fn num(&self) -> f64 {
        match self {
            Value::Uninit | Value::Array(_) => 0.0,
            Value::Num(n) => *n,
            Value::Str(s) | Value::Strnum(s) => parse_number(s),
        }
    }

    /// The value as text, numbers through `convfmt`.
    pub(super) fn text(&self, convfmt: &[u8]) -> Cow<'_, [u8]> {
        match self {
            Value::Uninit | Value::Array(_) => Cow::Borrowed(&[]),
            Value::Num(n) => Cow::Owned(format_num(*n, convfmt)),
            Value::Str(s) | Value::Strnum(s) => Cow::Borrowed(s),
        }
    }

    pub(super) fn into_text(self, convfmt: &[u8]) -> Vec<u8> {
        match self {
            Value::Str(s) | Value::Strnum(s) => s,
            other => other.text(convfmt).into_owned(),
        }
    }

    /// Whether the value takes part in a numeric comparison.
    fn numeric(&self) -> bool {
        match self {
            Value::Uninit | Value::Num(_) => true,
            Value::Strnum(s) => looks_numeric(s),
            Value::Str(_) | Value::Array(_) => false,
        }
    }

    pub(super) fn truth(&self) -> bool {
        match self {
            Value::Uninit | Value::Array(_) => false,
            Value::Num(n) => *n != 0.0,
            Value::Strnum(s) if looks_numeric(s) => parse_number(s) != 0.0,
            Value::Str(s) | Value::Strnum(s) => !s.is_empty(),
        }
    }
}

/// POSIX's comparison: numeric when both sides are numbers, numeric
/// strings or unset, by bytes otherwise.
pub(super) fn compare(left: &Value, right: &Value, convfmt: &[u8]) -> Ordering {
    if left.numeric() && right.numeric() {
        let (lhs, rhs) = (left.num(), right.num());
        if lhs == rhs {
            Ordering::Equal
        } else if lhs < rhs {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    } else {
        left.text(convfmt).cmp(&right.text(convfmt))
    }
}

/// A number as awk converts it to text: an integral value prints as an
/// integer whatever the format, as in every awk; anything else goes
/// through `convfmt` (CONVFMT, or OFMT for output), or `%.6g` when that
/// is no single float conversion.
pub(super) fn format_num(value: f64, convfmt: &[u8]) -> Vec<u8> {
    if value.is_nan() {
        return b"nan".to_vec();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            b"inf".to_vec()
        } else {
            b"-inf".to_vec()
        };
    }
    if value == value.trunc() && value.abs() < 2f64.powi(63) {
        return (value as i64).to_string().into_bytes();
    }
    let mut out = Vec::new();
    match float_spec(convfmt) {
        Some(spec) => spec.render(value, &mut out),
        None => FloatSpec::default().render(value, &mut out),
    }
    out
}

/// One `%[-+ #0]*[0-9]*(\.[0-9]*)?[eEfFgG]` conversion.
pub(super) struct FloatSpec<'a> {
    pub(super) flags: &'a [u8],
    pub(super) width: usize,
    pub(super) precision: Option<usize>,
    pub(super) conv: u8,
}

impl Default for FloatSpec<'_> {
    fn default() -> Self {
        FloatSpec {
            flags: b"",
            width: 0,
            precision: Some(6),
            conv: b'g',
        }
    }
}

impl FloatSpec<'_> {
    pub(super) fn render(&self, value: f64, out: &mut Vec<u8>) {
        // A NaN prints unsigned, as Python's and C's printf agree.
        let value = if value.is_nan() { f64::NAN } else { value };
        let precision = self.precision.map(|p| p as u64);
        pad(
            render_float(value, self.conv, self.flags, precision),
            self.flags,
            self.width,
            out,
        );
    }
}

fn float_spec(format: &[u8]) -> Option<FloatSpec<'_>> {
    let rest = format.strip_prefix(b"%")?;
    let flags = rest.iter().take_while(|c| b"-+ #0".contains(c)).count();
    let width = rest[flags..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count();
    let mut at = flags + width;
    let mut precision = None;
    if rest.get(at) == Some(&b'.') {
        let digits = rest[at + 1..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count();
        precision = Some(decimal(&rest[at + 1..at + 1 + digits]));
        at += 1 + digits;
    }
    let width = decimal(&rest[flags..flags + width]);
    if width > MAX_LEN || precision.is_some_and(|p| p > MAX_LEN) {
        return None;
    }
    match rest.get(at..) {
        Some(&[conv]) if b"eEfFgG".contains(&conv) => Some(FloatSpec {
            flags: &rest[..flags],
            width,
            precision: precision.or(Some(6)),
            conv,
        }),
        _ => None,
    }
}

/// A run of decimal digits, saturating.
pub(super) fn decimal(digits: &[u8]) -> usize {
    digits.iter().fold(0usize, |acc, d| {
        acc.saturating_mul(10).saturating_add(usize::from(d - b'0'))
    })
}

/// Lay a rendered conversion out in `width`, left-justified under `-`
/// and zero-filled under `0` where the conversion allows it.
pub(super) fn pad(rendered: Rendered, flags: &[u8], width: usize, out: &mut Vec<u8>) {
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

/// An integer conversion with C's flag rules: `%d` and `%i` keep the
/// exact integer, `%o %u %x %X` read a negative one as its 64-bit two's
/// complement.
pub(super) fn render_int(value: f64, conv: u8, flags: &[u8], precision: Option<usize>) -> Rendered {
    let precision = precision.map(|p| p as u64);
    let huge = value.is_finite() && value.abs() >= 2f64.powi(127);
    if !matches!(conv, b'd' | b'i') {
        // The low 64 bits of an integer past i128 are all zero.
        let wrapped = if huge { 0 } else { to_int(value) as u64 };
        return render_integer(i128::from(wrapped), conv, flags, precision);
    }
    if !huge {
        return render_integer(to_int(value), conv, flags, precision);
    }
    let mut rendered = render_integer(if value < 0.0 { -1 } else { 1 }, conv, flags, precision);
    let bits = value.abs().to_bits();
    let mantissa = (bits & ((1 << 52) - 1)) | (1 << 52);
    let shift = ((bits >> 52) & 0x7FF) as usize - 1075;
    rendered.suffix = (num_bigint::BigUint::from(mantissa) << shift)
        .to_string()
        .into_bytes();
    rendered.zero_tail = precision
        .unwrap_or(0)
        .saturating_sub(rendered.suffix.len() as u64);
    rendered
}
