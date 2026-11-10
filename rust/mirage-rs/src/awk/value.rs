use std::borrow::{Borrow, Cow};
use std::cmp::Ordering;
use std::hash::{Hash, Hasher};
use std::ops::{Deref, Range};
use std::sync::{Arc, OnceLock};

use crate::number::is_blank;
use crate::printf::number::{Rendered, render_float, render_integer};

#[derive(Clone, Debug, Default)]
pub(super) struct Text {
    bytes: Arc<Vec<u8>>,
    range: Range<usize>,
    numeric: Arc<OnceLock<Numeric>>,
}

impl PartialEq for Text {
    fn eq(&self, other: &Self) -> bool {
        self.as_slice() == other.as_slice()
    }
}
impl Eq for Text {}
impl Hash for Text {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.as_slice().hash(state);
    }
}

impl From<Vec<u8>> for Text {
    fn from(bytes: Vec<u8>) -> Self {
        let range = 0..bytes.len();
        Self {
            bytes: Arc::new(bytes),
            range,
            numeric: Arc::default(),
        }
    }
}
impl Deref for Text {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.bytes[self.range.clone()]
    }
}
impl Borrow<[u8]> for Text {
    fn borrow(&self) -> &[u8] {
        self
    }
}
impl Text {
    pub(super) fn slice(&self, range: Range<usize>) -> Self {
        debug_assert!(range.start <= range.end && range.end <= self.len());
        if range == (0..self.len()) {
            return self.clone();
        }
        Self {
            bytes: self.bytes.clone(),
            range: self.range.start + range.start..self.range.start + range.end,
            numeric: Arc::default(),
        }
    }

    pub(super) fn storage_len(&self) -> usize {
        self.bytes.len()
    }

    pub(super) fn as_slice(&self) -> &[u8] {
        self
    }

    pub(super) fn prepare_number(&self, scan: &mut Option<NumberScan>, work: &mut u64) -> bool {
        if self.numeric.get().is_some() {
            return true;
        }
        let pending = scan.get_or_insert_with(NumberScan::default);
        let Some(numeric) = pending.step(self, work) else {
            return false;
        };
        let _ = self.numeric.set(numeric);
        *scan = None;
        true
    }

    fn number(&self) -> Numeric {
        *self
            .numeric
            .get()
            .expect("numeric values are prepared before use")
    }
}

pub(super) fn string(raw: impl Into<Text>) -> Value {
    Value::Str(raw.into())
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Value {
    Uninit,
    Num(f64),
    Str(Text),
    /// Text from the input (a field, a getline record, split's pieces,
    /// ARGV, ENVIRON, an assignment): a number when it looks like one.
    /// Never empty.
    Strnum(Text),
    /// An array passed to a function, only ever a call's argument.
    Array(usize),
}

/// Input-derived text: an absent or empty field is a plain string, so
/// `$9 == 0` is false where `x == 0` is true for an unset `x`.
pub(super) fn strnum(raw: impl Into<Text>) -> Value {
    let raw = raw.into();
    if raw.is_empty() {
        Value::Str(raw)
    } else {
        Value::Strnum(raw)
    }
}

/// The length of the awk number at the start of `raw`, or 0:
/// `[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?`.
#[cfg(test)]
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

#[cfg(test)]
fn trimmed(raw: &[u8]) -> &[u8] {
    let start = raw.iter().position(|&c| !is_blank(c)).unwrap_or(raw.len());
    let end = raw
        .iter()
        .rposition(|&c| !is_blank(c))
        .map_or(start, |at| at + 1);
    &raw[start..end]
}

/// Whether text, blanks aside, is an awk number as a whole.
#[cfg(test)]
fn looks_numeric(raw: &[u8]) -> bool {
    let body = trimmed(raw);
    !body.is_empty() && number_len(body) == body.len()
}

/// The number text starts with, strtod style but decimal only; 0 when it
/// starts with none.
#[cfg(test)]
fn parse_number(raw: &[u8]) -> f64 {
    let start = raw.iter().position(|&c| !is_blank(c)).unwrap_or(raw.len());
    let body = &raw[start..];
    let len = number_len(body);
    std::str::from_utf8(&body[..len])
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(0.0)
}

#[derive(Clone, Copy, Debug)]
struct Numeric {
    value: f64,
    whole: bool,
}

#[derive(Default)]
enum NumberPhase {
    #[default]
    Space,
    Start,
    Mantissa,
    Power,
    Tail,
}

#[derive(Default)]
pub(super) struct NumberScan {
    at: usize,
    phase: NumberPhase,
    negative: bool,
    dot: bool,
    fractional: usize,
    significant: usize,
    kept: Vec<u8>,
    sticky: bool,
    exponent: i64,
    exponent_negative: bool,
}

impl NumberScan {
    fn result(&self, whole: bool) -> Numeric {
        let mut token = String::with_capacity(self.kept.len() + 32);
        if self.negative {
            token.push('-');
        }
        if self.kept.is_empty() {
            token.push('0');
        } else {
            token.push_str(std::str::from_utf8(&self.kept).expect("decimal digits"));
        }
        let mut exponent = if self.exponent_negative {
            -self.exponent
        } else {
            self.exponent
        };
        exponent = exponent
            .saturating_sub(self.fractional as i64)
            .saturating_add(self.significant.saturating_sub(self.kept.len()) as i64);
        if self.sticky {
            token.push('1');
            exponent = exponent.saturating_sub(1);
        }
        token.push('e');
        token.push_str(&exponent.to_string());
        Numeric {
            value: token.parse().expect("normalized decimal"),
            whole,
        }
    }

    fn step(&mut self, raw: &[u8], work: &mut u64) -> Option<Numeric> {
        while *work > 0 {
            *work -= 1;
            match self.phase {
                NumberPhase::Space => {
                    if raw.get(self.at).is_some_and(|&byte| is_blank(byte)) {
                        self.at += 1;
                    } else {
                        self.phase = NumberPhase::Start;
                    }
                }
                NumberPhase::Start => {
                    if matches!(raw.get(self.at), Some(b'+' | b'-')) {
                        self.negative = raw[self.at] == b'-';
                        self.at += 1;
                    }
                    let valid = raw.get(self.at).is_some_and(u8::is_ascii_digit)
                        || (raw.get(self.at) == Some(&b'.')
                            && raw.get(self.at + 1).is_some_and(u8::is_ascii_digit));
                    if !valid {
                        return Some(Numeric {
                            value: 0.0,
                            whole: false,
                        });
                    }
                    self.phase = NumberPhase::Mantissa;
                }
                NumberPhase::Mantissa => {
                    if let Some(&byte @ b'0'..=b'9') = raw.get(self.at) {
                        self.fractional += usize::from(self.dot);
                        if byte != b'0' || self.significant > 0 {
                            self.significant += 1;
                            // Every binary64 rounding boundary has fewer than 800
                            // significant decimal digits; a later nonzero digit
                            // only distinguishes equality from being above it.
                            if self.kept.len() < 1200 {
                                self.kept.push(byte);
                            } else {
                                self.sticky |= byte != b'0';
                            }
                        }
                        self.at += 1;
                    } else if !self.dot && raw.get(self.at) == Some(&b'.') {
                        self.dot = true;
                        self.at += 1;
                    } else {
                        let next = self.at
                            + 1
                            + usize::from(matches!(raw.get(self.at + 1), Some(b'+' | b'-')));
                        if matches!(raw.get(self.at), Some(b'e' | b'E'))
                            && raw.get(next).is_some_and(u8::is_ascii_digit)
                        {
                            self.exponent_negative = raw.get(self.at + 1) == Some(&b'-');
                            self.at = next;
                            self.phase = NumberPhase::Power;
                        } else {
                            self.phase = NumberPhase::Tail;
                        }
                    }
                }
                NumberPhase::Power => {
                    if let Some(&byte @ b'0'..=b'9') = raw.get(self.at) {
                        self.exponent = self
                            .exponent
                            .saturating_mul(10)
                            .saturating_add((byte - b'0') as i64);
                        self.at += 1;
                    } else {
                        self.phase = NumberPhase::Tail;
                    }
                }
                NumberPhase::Tail => match raw.get(self.at) {
                    Some(&byte) if is_blank(byte) => self.at += 1,
                    Some(_) => return Some(self.result(false)),
                    None => return Some(self.result(true)),
                },
            }
        }
        None
    }
}

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
    pub(super) fn prepare_number(&self, scan: &mut Option<NumberScan>, work: &mut u64) -> bool {
        match self {
            Value::Str(raw) | Value::Strnum(raw) => raw.prepare_number(scan, work),
            _ => true,
        }
    }

    pub(super) fn num(&self) -> f64 {
        match self {
            Value::Uninit | Value::Array(_) => 0.0,
            Value::Num(n) => *n,
            Value::Str(s) | Value::Strnum(s) => s.number().value,
        }
    }

    /// A special variable uses the fixed default conversion.
    pub(super) fn default_text(&self) -> Cow<'_, [u8]> {
        match self {
            Value::Uninit | Value::Array(_) => Cow::Borrowed(&[]),
            Value::Num(n) => Cow::Owned(default_number(*n)),
            Value::Str(s) | Value::Strnum(s) => Cow::Borrowed(s),
        }
    }

    pub(super) fn into_text(self) -> Text {
        match self {
            Value::Str(s) | Value::Strnum(s) => s,
            Value::Uninit | Value::Array(_) => Text::default(),
            Value::Num(_) => unreachable!("numeric text conversion must be prepared"),
        }
    }

    /// Whether the value takes part in a numeric comparison.
    pub(super) fn numeric(&self) -> bool {
        match self {
            Value::Uninit | Value::Num(_) => true,
            Value::Strnum(s) => s.number().whole,
            Value::Str(_) | Value::Array(_) => false,
        }
    }

    pub(super) fn truth(&self) -> bool {
        match self {
            Value::Uninit | Value::Array(_) => false,
            Value::Num(n) => *n != 0.0,
            Value::Strnum(s) if s.number().whole => s.number().value != 0.0,
            Value::Str(s) | Value::Strnum(s) => !s.is_empty(),
        }
    }
}

pub(super) fn compare_numbers(lhs: f64, rhs: f64) -> Ordering {
    if lhs == rhs {
        Ordering::Equal
    } else if lhs < rhs {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

/// Integers and nonfinite values ignore CONVFMT and OFMT.
pub(super) fn fixed_number(value: f64) -> Option<Vec<u8>> {
    if value.is_nan() {
        return Some(b"nan".to_vec());
    }
    if value.is_infinite() {
        return Some(if value > 0.0 {
            b"inf".to_vec()
        } else {
            b"-inf".to_vec()
        });
    }
    if value == value.trunc() && value.abs() < 2f64.powi(63) {
        return Some((value as i64).to_string().into_bytes());
    }
    None
}

pub(super) fn default_number(value: f64) -> Vec<u8> {
    if let Some(text) = fixed_number(value) {
        return text;
    }
    let mut out = Vec::new();
    FloatSpec::default().render(value, &mut out);
    out
}

#[cfg(test)]
pub(super) fn format_num(value: f64, convfmt: &[u8]) -> Vec<u8> {
    if let Some(text) = fixed_number(value) {
        return text;
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
        pad(self.rendered(value), self.flags, self.width, out);
    }

    /// The conversion before its field width.
    pub(super) fn rendered(&self, value: f64) -> Rendered {
        // A NaN prints unsigned, as Python's and C's printf agree.
        let value = if value.is_nan() { f64::NAN } else { value };
        render_float(
            value,
            self.conv,
            self.flags,
            self.precision.map(|p| p as u64),
        )
    }
}

#[cfg(test)]
fn float_spec(format: &[u8]) -> Option<FloatSpec<'_>> {
    use crate::constants::MAX_HELD;
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
    if width > MAX_HELD || precision.is_some_and(|p| p > MAX_HELD) {
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
#[cfg(test)]
fn decimal(digits: &[u8]) -> usize {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_scanning_matches_decimal_rounding_and_classification() {
        let mut cases: Vec<String> = [
            "", "+", "-", ".", "  ", "0", "-0", "+.5", "-7.", "1e", "1e+", "1e-3", "1e-3x",
            " 42 \t\n", "1\r", "0x1a", "nan", "inf",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let midpoint = "1.00000000000000011102230246251565404236316680908203125";
        for sign in ["", "-"] {
            for tail in ["", "1", "9"] {
                cases.push(format!("{sign}{midpoint}{}{tail}", "0".repeat(5000)));
            }
        }
        let digits = num_bigint::BigUint::from(5u8).pow(1075).to_str_radix(10);
        let subnormal = format!("0.{}{digits}", "0".repeat(1075 - digits.len()));
        cases.push(subnormal.clone());
        cases.push(format!("{subnormal}{}1", "0".repeat(5000)));
        cases.push(format!("1{}e-5000", "0".repeat(5000)));
        cases.push(format!("1{}e-5001", "9".repeat(5000)));
        cases.push(format!("-{}", "0".repeat(5000)));
        cases.push(format!("{}42{}", " ".repeat(5000), "\t".repeat(5000)));
        cases.push(format!("1e{}", "9".repeat(5000)));
        cases.push(format!("1e-{}", "9".repeat(5000)));
        for raw in cases {
            for budget in [1, 7, 20000] {
                let mut scan = NumberScan::default();
                let mut turns = 0;
                let found = loop {
                    let mut work = budget;
                    if let Some(found) = scan.step(raw.as_bytes(), &mut work) {
                        break found;
                    }
                    assert_eq!(work, 0);
                    turns += 1;
                    assert!(turns < raw.len() + 16);
                };
                assert_eq!(
                    found.value.to_bits(),
                    parse_number(raw.as_bytes()).to_bits(),
                    "{} bytes at budget {budget}",
                    raw.len()
                );
                assert_eq!(found.whole, looks_numeric(raw.as_bytes()));
                assert!(scan.kept.len() <= 1200);
            }
        }
    }
}
