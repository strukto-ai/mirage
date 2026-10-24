use std::collections::VecDeque;

use num_bigint::{BigInt, BigUint, Sign};
use num_traits::{Euclid, One, Signed, ToPrimitive, Zero};
use serde::Deserialize;

use crate::printf::number::{
    Decimal, FloatKind, FloatToken, Rendered, render_decimal, render_hex, render_special,
    scan_float,
};
use crate::{Stream, StreamError, latin1, latin1_list, latin1_opt, parse_config, quoted};

const OUTPUT: usize = 64 * 1024;
// A run of one byte longer than this stays a count, so a wide field or a
// long precision never sits whole in memory.
const RUN: u64 = 64;
const TRY: &str = "Try 'seq --help' for more information.";
const CONVERSIONS: &[u8] = b"efgaEFGA";

// GNU's long double, as the pins here measure it: IEEE binary128, arm64
// Linux's, with 112 fraction bits under the lead bit and a least normal
// exponent of -16382. x86-64's 80-bit long double prints %a of 1 as
// 0x8p-3 and overflows lower; no one output matches both, and seq's %a
// goldens were pinned in binary128.
const FRACTION_BITS: u32 = 112;
const MIN_EXPONENT: i64 = -16382;
// strtold reads zero for a magnitude at or under 2**-UNDERFLOW_BITS, half
// of the least subnormal.
const UNDERFLOW_BITS: usize = 16495;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "latin1_list")]
    operands: Vec<Vec<u8>>,
    #[serde(default, deserialize_with = "latin1_opt")]
    format: Option<Vec<u8>>,
    #[serde(default)]
    equal_width: bool,
    #[serde(deserialize_with = "latin1")]
    separator: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Finite,
    Infinite,
    Nan,
}

/// A number as seq holds it, exactly: `units / 10**scale`. GNU sums in a
/// long double whose rounding depends on the machine; exact values print
/// what GNU prints wherever its own output does not.
#[derive(Clone)]
struct Number {
    negative: bool,
    units: BigUint,
    scale: usize,
    kind: Kind,
}

impl Number {
    fn zero(negative: bool) -> Self {
        Self::special(negative, Kind::Finite)
    }

    fn special(negative: bool, kind: Kind) -> Self {
        Self {
            negative,
            units: BigUint::zero(),
            scale: 0,
            kind,
        }
    }

    fn signed(&self, scale: usize) -> BigInt {
        let units = BigInt::from_biguint(
            if self.negative {
                Sign::Minus
            } else {
                Sign::Plus
            },
            self.units.clone(),
        );
        units * BigInt::from(10_u8).pow((scale - self.scale) as u32)
    }

    fn whole(&self) -> bool {
        self.kind == Kind::Finite && self.scale == 0
    }

    fn rank(&self) -> i8 {
        match (self.kind, self.negative) {
            (Kind::Infinite, true) => -1,
            (Kind::Infinite, false) => 1,
            _ => 0,
        }
    }
}

/// `a < b` as C compares two long doubles: never true for a NaN.
fn less(a: &Number, b: &Number) -> bool {
    if a.kind == Kind::Nan || b.kind == Kind::Nan {
        return false;
    }
    if a.kind == Kind::Infinite || b.kind == Kind::Infinite {
        return a.rank() < b.rank();
    }
    let scale = a.scale.max(b.scale);
    a.signed(scale) < b.signed(scale)
}

fn same(a: &Number, b: &Number) -> bool {
    match (a.kind, b.kind) {
        (Kind::Finite, Kind::Finite) => {
            let scale = a.scale.max(b.scale);
            a.signed(scale) == b.signed(scale)
        }
        (Kind::Infinite, Kind::Infinite) => a.negative == b.negative,
        _ => false,
    }
}

fn overflow() -> BigUint {
    ((BigUint::one() << 114_usize) - 1_u8) << 16270_usize
}

/// `units / 10**scale` as strtold bounds it: zero when it underflows,
/// None when it overflows.
fn in_range(negative: bool, units: BigUint, scale: usize) -> Option<Number> {
    let denominator = BigUint::from(10_u8).pow(scale as u32);
    if units >= overflow() * &denominator {
        return None;
    }
    if (&units << UNDERFLOW_BITS) <= denominator {
        return Some(Number::zero(negative));
    }
    Some(Number {
        negative,
        units,
        scale,
        kind: Kind::Finite,
    })
}

fn digits_of(raw: &[u8], token: &FloatToken) -> Vec<u8> {
    raw[token.start..token.mantissa_end]
        .iter()
        .copied()
        .filter(|b| *b != b'.')
        .collect()
}

/// The value strtold reads for a whole-word number, None when it
/// overflows. A magnitude far outside the long double range is settled
/// from its digit count before any arithmetic, so an exponent of any
/// length costs nothing.
fn value_of(raw: &[u8], token: &FloatToken) -> Option<Number> {
    let negative = token.negative;
    match token.kind {
        FloatKind::Infinity => Some(Number::special(negative, Kind::Infinite)),
        FloatKind::Nan => Some(Number::special(negative, Kind::Nan)),
        FloatKind::Decimal => {
            let all = digits_of(raw, token);
            let digits = &all[all.iter().take_while(|b| **b == b'0').count()..];
            let significant =
                &digits[..digits.len() - digits.iter().rev().take_while(|b| **b == b'0').count()];
            if significant.is_empty() {
                return Some(Number::zero(negative));
            }
            let exponent =
                token.exponent - token.fraction as i64 + (digits.len() - significant.len()) as i64;
            let top = significant.len() as i64 + exponent;
            if top > 4933 {
                return None;
            }
            if top < -4965 {
                return Some(Number::zero(negative));
            }
            let units = BigUint::parse_bytes(significant, 10).expect("decimal digits");
            if exponent >= 0 {
                in_range(
                    negative,
                    units * BigUint::from(10_u8).pow(exponent as u32),
                    0,
                )
            } else {
                in_range(negative, units, (-exponent) as usize)
            }
        }
        FloatKind::Hex => {
            let bits = BigUint::parse_bytes(&digits_of(raw, token), 16).expect("hex digits");
            if bits.is_zero() {
                return Some(Number::zero(negative));
            }
            let mut exponent = token.exponent - 4 * token.fraction as i64;
            let top = bits.bits() as i64 + exponent;
            if top > 16384 {
                return None;
            }
            if top < -16494 {
                return Some(Number::zero(negative));
            }
            let shift = (bits.trailing_zeros().unwrap_or(0) as i64).min((-exponent).max(0));
            let bits = bits >> shift as usize;
            exponent += shift;
            if exponent >= 0 {
                in_range(negative, bits << exponent as usize, 0)
            } else {
                let scale = (-exponent) as usize;
                in_range(
                    negative,
                    bits * BigUint::from(5_u8).pow(scale as u32),
                    scale,
                )
            }
        }
    }
}

/// A STRTOD number spanning the whole word, as xstrtod demands: leading
/// blanks read and trailing ones do not.
fn whole_word(raw: &[u8]) -> Option<FloatToken> {
    scan_float(raw).filter(|token| token.end == raw.len())
}

/// An operand as seq reads it: its value, its print width in the form it
/// was typed (`-.1` counts as `-0.1`, `1.` as `1`), and its decimals,
/// None when GNU prints it with `%g`.
struct Operand {
    value: Number,
    width: usize,
    precision: Option<usize>,
}

fn refuse(line: String) -> StreamError {
    StreamError::new(format!("seq: {line}\n{TRY}"))
}

/// FIRST, INCREMENT or LAST, refused as GNU refuses it. The integer digits
/// count as typed, with one for a `-`; a positive exponent widens the
/// integer part and eats decimals, a negative one adds decimals (measured
/// on GNU 9.7 over 3,600 operand pairs). A hex float with a point or a
/// lowercase `p` exponent prints with `%g`.
fn operand(raw: &[u8]) -> Result<Operand, StreamError> {
    let shown = quoted(raw);
    let token = whole_word(raw);
    let value = token.as_ref().and_then(|token| value_of(raw, token));
    let (Some(token), Some(value)) = (token, value) else {
        return Err(refuse(format!(
            "invalid floating point argument: '{shown}'"
        )));
    };
    if value.kind == Kind::Nan {
        return Err(refuse(format!(
            "invalid 'not-a-number' argument: '{shown}'"
        )));
    }
    let (width, precision) = match token.kind {
        FloatKind::Hex => {
            let typed = &raw[token.start..token.end];
            (
                0,
                (!typed.contains(&b'.') && !typed.contains(&b'p')).then_some(0),
            )
        }
        FloatKind::Decimal => {
            let mantissa = &raw[token.start..token.mantissa_end];
            let integer = mantissa.len() - mantissa.contains(&b'.') as usize - token.fraction;
            let decimals = (token.fraction as i64 - token.exponent).max(0) as usize;
            let width =
                usize::from(token.negative) + integer.max(1) + token.exponent.max(0) as usize;
            (
                width + if decimals > 0 { decimals + 1 } else { 0 },
                Some(decimals),
            )
        }
        FloatKind::Infinity | FloatKind::Nan => (0, Some(0)),
    };
    Ok(Operand {
        value,
        width,
        precision,
    })
}

/// A printed line as its bytes, a long run of one byte (padding, or
/// fraction zeros past the exact digits) kept as a count.
#[derive(Clone, Default)]
struct Line {
    pieces: Vec<Piece>,
}

#[derive(Clone)]
enum Piece {
    Bytes(Vec<u8>),
    Run(u8, u64),
}

impl Line {
    fn bytes(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        match self.pieces.last_mut() {
            Some(Piece::Bytes(held)) => held.extend_from_slice(bytes),
            _ => self.pieces.push(Piece::Bytes(bytes.to_vec())),
        }
    }

    fn run(&mut self, byte: u8, count: u64) {
        if count > RUN {
            self.pieces.push(Piece::Run(byte, count));
        } else {
            self.bytes(&vec![byte; count as usize]);
        }
    }

    /// The line as maximal runs of one byte, however its pieces split
    /// them: rounding can print the same zeros as digits or as a run.
    fn runs(&self) -> Vec<(u8, u64)> {
        let mut runs: Vec<(u8, u64)> = Vec::new();
        let mut push = |byte: u8, count: u64| match runs.last_mut() {
            Some((last, total)) if *last == byte => *total += count,
            _ => runs.push((byte, count)),
        };
        for piece in &self.pieces {
            match piece {
                Piece::Bytes(bytes) => bytes.iter().for_each(|byte| push(*byte, 1)),
                Piece::Run(byte, count) => push(*byte, *count),
            }
        }
        runs
    }

    /// The line as reading it back sees it: a long run is padding or
    /// fraction zeros, which read the same cut to one byte.
    fn reading(&self) -> Vec<u8> {
        let mut text = Vec::new();
        for piece in &self.pieces {
            match piece {
                Piece::Bytes(bytes) => text.extend_from_slice(bytes),
                Piece::Run(byte, _) => text.push(*byte),
            }
        }
        text
    }
}

/// A seq format around its one floating directive.
struct Format {
    prefix: Vec<u8>,
    flags: Vec<u8>,
    width: u64,
    precision: Option<u64>,
    conversion: u8,
    suffix: Vec<u8>,
}

/// Where the first `%` that is not half of `%%` sits.
fn lone_percent(text: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i < text.len() {
        if text[i] == b'%' {
            if text.get(i + 1) != Some(&b'%') {
                return Some(i);
            }
            i += 1;
        }
        i += 1;
    }
    None
}

fn digits_value(text: &[u8]) -> u64 {
    text.iter().fold(0_u64, |n, b| {
        n.saturating_mul(10).saturating_add(u64::from(b - b'0'))
    })
}

/// GNU seq's `-f` check: exactly one floating `%` directive, its flags,
/// width, precision and an optional `L`, with nothing but `%%` around it.
fn parse_format(fmt: &[u8]) -> Result<Format, StreamError> {
    let shown = quoted(fmt);
    let Some(start) = lone_percent(fmt) else {
        return Err(StreamError::new(format!(
            "seq: format '{shown}' has no % directive"
        )));
    };
    let mut at = start + 1;
    let flags_end = at
        + fmt[at..]
            .iter()
            .take_while(|b| b"-+#0 '".contains(b))
            .count();
    let width_end = flags_end
        + fmt[flags_end..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
    at = width_end;
    let mut precision = None;
    if fmt.get(at) == Some(&b'.') {
        let digits = fmt[at + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        precision = Some(digits_value(&fmt[at + 1..at + 1 + digits]));
        at += 1 + digits;
    }
    if fmt.get(at) == Some(&b'L') {
        at += 1;
    }
    let Some(&conversion) = fmt.get(at) else {
        return Err(StreamError::new(format!("seq: format '{shown}' ends in %")));
    };
    if !CONVERSIONS.contains(&conversion) {
        let len = match conversion {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => 1,
        };
        let shown_char = String::from_utf8_lossy(&fmt[at..(at + len).min(fmt.len())]);
        return Err(StreamError::new(format!(
            "seq: format '{shown}' has unknown %{shown_char} directive"
        )));
    }
    let suffix = &fmt[at + 1..];
    if lone_percent(suffix).is_some() {
        return Err(StreamError::new(format!(
            "seq: format '{shown}' has too many % directives"
        )));
    }
    Ok(Format {
        prefix: unescape(&fmt[..start]),
        flags: fmt[start + 1..flags_end].to_vec(),
        width: digits_value(&fmt[flags_end..width_end]),
        precision,
        conversion,
        suffix: unescape(suffix),
    })
}

fn unescape(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        out.push(text[i]);
        i += if text[i] == b'%' && text.get(i + 1) == Some(&b'%') {
            2
        } else {
            1
        };
    }
    out
}

/// The format seq prints with when no `-f` is given: `%.Nf` for the most
/// decimals FIRST or INCREMENT was typed with, padded with zeros under
/// `-w` to the wider of FIRST and LAST at those decimals; `%g` when any
/// operand would print with it, which `-w` leaves unpadded.
fn implied(first: &Operand, step: &Operand, last: &Operand, equal_width: bool) -> Format {
    let mut format = Format {
        prefix: Vec::new(),
        flags: Vec::new(),
        width: 0,
        precision: None,
        conversion: b'g',
        suffix: Vec::new(),
    };
    let (Some(a), Some(b), Some(_)) = (first.precision, step.precision, last.precision) else {
        return format;
    };
    let decimals = a.max(b);
    format.conversion = b'f';
    format.precision = Some(decimals as u64);
    if equal_width {
        // An operand keeps its typed integer width and takes the format's
        // decimals: `-w .5 -0.25 -.5` prints `-.5` as `-0.50`.
        let width_at = |operand: &Operand| {
            let typed = operand.precision.unwrap_or(0);
            let integer = operand.width - if typed > 0 { typed + 1 } else { 0 };
            integer + if decimals > 0 { decimals + 1 } else { 0 }
        };
        format.flags = b"0".to_vec();
        format.width = width_at(first).max(width_at(last)) as u64;
    }
    format
}

/// `numerator / denominator` rounded half to even.
fn nearest(numerator: BigUint, denominator: &BigUint) -> BigUint {
    let kept = &numerator / denominator;
    let rest = numerator - &kept * denominator;
    let twice = rest << 1_usize;
    if twice > *denominator || twice == *denominator && kept.bit(0) {
        kept + 1_u8
    } else {
        kept
    }
}

/// A finite nonzero value as a binary128 long double holds it: rounded
/// half to even to 113 bits, or to the subnormal grid under 2**-16382,
/// which glibc writes with a lead digit of 0 and that least exponent.
fn quad(value: &Number) -> (u128, i32) {
    let denominator = BigUint::from(10_u8).pow(value.scale as u32);
    let mut exponent = value.units.bits() as i64 - denominator.bits() as i64;
    if (&value.units << (-exponent).max(0) as usize) < (&denominator << exponent.max(0) as usize) {
        exponent -= 1;
    }
    exponent = exponent.max(MIN_EXPONENT);
    let shift = i64::from(FRACTION_BITS) - exponent;
    let mut mantissa = if shift >= 0 {
        nearest(&value.units << shift as usize, &denominator)
    } else {
        nearest(value.units.clone(), &(denominator << (-shift) as usize))
    };
    if mantissa.is_zero() {
        return (0, 0);
    }
    if mantissa.bits() > u64::from(FRACTION_BITS) + 1 {
        mantissa >>= 1_usize;
        exponent += 1;
    }
    (mantissa.to_u128().expect("113 bits"), exponent as i32)
}

impl Format {
    /// One number through the format, as C's printf renders it.
    fn render(&self, value: &Number, line: &mut Line) {
        let upper = self.conversion.is_ascii_uppercase();
        let rendered = match value.kind {
            Kind::Finite if self.conversion.eq_ignore_ascii_case(&b'a') => {
                let (mantissa, exponent) = if value.units.is_zero() {
                    (0, 0)
                } else {
                    quad(value)
                };
                render_hex(
                    value.negative,
                    mantissa,
                    FRACTION_BITS,
                    exponent,
                    &self.flags,
                    self.precision,
                    upper,
                )
            }
            Kind::Finite => render_decimal(
                value.negative,
                Decimal::scaled(&value.units, value.scale),
                self.conversion,
                &self.flags,
                self.precision,
            ),
            kind => render_special(value.negative, kind == Kind::Nan, upper, &self.flags),
        };
        line.bytes(&self.prefix);
        self.padded(&rendered, line);
        line.bytes(&self.suffix);
    }

    /// A field padded to the width as printf pads it: on the right for
    /// `-`, with zeros after the sign for `0`, else with blanks.
    fn padded(&self, rendered: &Rendered, line: &mut Line) {
        let pad = self.width.saturating_sub(rendered.byte_len());
        let left = self.flags.contains(&b'-');
        let zero = rendered.allow_zero && self.flags.contains(&b'0') && !left;
        if !left && !zero {
            line.run(b' ', pad);
        }
        line.bytes(&rendered.prefix);
        if zero {
            line.run(b'0', pad);
        }
        line.bytes(&rendered.body);
        line.run(b'0', rendered.zero_tail);
        line.bytes(&rendered.suffix);
        if left {
            line.run(b' ', pad);
        }
    }

    /// Whether printf refuses the format outright: a width or precision
    /// past what C's int holds is EOVERFLOW (coreutils 9.7).
    fn overflows(&self) -> bool {
        let limit = i32::MAX as u64;
        self.width > limit || self.precision.is_some_and(|precision| precision > limit)
    }

    /// The width a `%.0f`-shaped format zero-pads whole numbers to: None
    /// for any other format, 0 for the plain `%.0f`.
    fn zero_pad(&self) -> Option<u64> {
        if !self.prefix.is_empty()
            || !self.suffix.is_empty()
            || self.conversion != b'f'
            || self.precision != Some(0)
        {
            return None;
        }
        match self.flags.as_slice() {
            b"" if self.width == 0 => Some(0),
            b"0" => Some(self.width),
            _ => None,
        }
    }

    /// Whether a printed number, its format text cut from both ends and
    /// read back as a whole word, is LAST: leading blanks read and
    /// trailing ones do not, so `%-5.1f` stops where `%5.1f` goes on.
    fn names_last(&self, text: &[u8], last: &Number) -> bool {
        let body = &text[self.prefix.len()..text.len() - self.suffix.len()];
        whole_word(body)
            .and_then(|token| value_of(body, &token))
            .is_some_and(|value| same(&value, last))
    }
}

enum Cursor {
    First,
    Integers {
        next: BigInt,
        delta: BigInt,
        end: Option<BigInt>,
        pad: u64,
    },
    Sums {
        units: BigInt,
        delta: BigInt,
        scale: usize,
    },
    Repeat(Number),
    Done,
}

struct Seq {
    first: Number,
    step: Number,
    last: Number,
    format: Format,
    separator: Vec<u8>,
    cursor: Cursor,
    shown: Line,
    pending: VecDeque<Piece>,
    started: bool,
    printed: bool,
    ended: bool,
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let format = config.format.as_deref().map(parse_format).transpose()?;
    if format.is_some() && config.equal_width {
        return Err(refuse(
            "format string may not be specified when printing equal width strings".into(),
        ));
    }
    let [first, step, last] = match config.operands.as_slice() {
        [last] => [None, None, Some(operand(last)?)],
        [first, last] => [Some(operand(first)?), None, Some(operand(last)?)],
        [first, step, last] => {
            let first = operand(first)?;
            let increment = operand(step)?;
            if increment.value.kind == Kind::Finite && increment.value.units.is_zero() {
                return Err(refuse(format!(
                    "invalid Zero increment value: '{}'",
                    quoted(step)
                )));
            }
            [Some(first), Some(increment), Some(operand(last)?)]
        }
        _ => return Err(StreamError::new("seq takes one to three operands")),
    };
    let one = || Operand {
        value: Number {
            negative: false,
            units: BigUint::one(),
            scale: 0,
            kind: Kind::Finite,
        },
        width: 1,
        precision: Some(0),
    };
    let (first, step, last) = (
        first.unwrap_or_else(one),
        step.unwrap_or_else(one),
        last.expect("LAST"),
    );
    let format = format.unwrap_or_else(|| implied(&first, &step, &last, config.equal_width));
    let seq = Seq {
        first: first.value,
        step: step.value,
        last: last.value,
        format,
        separator: config.separator,
        cursor: Cursor::First,
        shown: Line::default(),
        pending: VecDeque::new(),
        started: false,
        printed: false,
        ended: false,
    };
    if seq.format.overflows() && !seq.beyond(&seq.first) {
        return Err(StreamError::new(
            "seq: write error: Value too large for defined data type",
        ));
    }
    Ok(Box::new(seq))
}

impl Seq {
    fn beyond(&self, value: &Number) -> bool {
        if self.step.negative {
            less(value, &self.last)
        } else {
            less(&self.last, value)
        }
    }

    /// After FIRST: the whole numbers printed plainly, their digits exact
    /// so the one past LAST never reads back as LAST; else exact sums, or
    /// with an infinity in FIRST or INCREMENT one value without end (a
    /// NaN when they are opposite infinities).
    fn after_first(&self) -> Cursor {
        let (first, step, last) = (&self.first, &self.step, &self.last);
        if let Some(pad) = self
            .format
            .zero_pad()
            .filter(|_| first.whole() && step.whole())
        {
            let delta = step.signed(0);
            let end = (last.kind == Kind::Finite).then(|| {
                let unit = BigInt::from(10_u8).pow(last.scale as u32);
                let units = last.signed(last.scale);
                let floor = units.div_euclid(&unit);
                if delta.is_negative() && floor.clone() * &unit != units {
                    floor + 1
                } else {
                    floor
                }
            });
            return Cursor::Integers {
                next: first.signed(0) + &delta,
                delta,
                end,
                pad,
            };
        }
        if first.kind == Kind::Finite && step.kind == Kind::Finite {
            let scale = first.scale.max(step.scale);
            return Cursor::Sums {
                units: first.signed(scale),
                delta: step.signed(scale),
                scale,
            };
        }
        Cursor::Repeat(if first.kind == Kind::Finite {
            step.clone()
        } else if step.kind == Kind::Infinite && step.negative != first.negative {
            Number::special(false, Kind::Nan)
        } else {
            first.clone()
        })
    }

    /// Each number of the sequence as printed, FIRST to LAST, then the one
    /// past LAST as well when it prints differently from the one before it
    /// and reads back as LAST (`seq -f %.1f 0 0.34 1` ends in `1.0`).
    fn next_line(&mut self, line: &mut Line) -> bool {
        let value = match std::mem::replace(&mut self.cursor, Cursor::Done) {
            Cursor::Done => return false,
            Cursor::First => {
                if self.beyond(&self.first) {
                    return false;
                }
                self.format.render(&self.first, line);
                self.shown.clone_from(line);
                self.cursor = self.after_first();
                return true;
            }
            Cursor::Integers {
                next,
                delta,
                end,
                pad,
            } => {
                let past = end.as_ref().is_some_and(|end| {
                    if delta.is_negative() {
                        next < *end
                    } else {
                        next > *end
                    }
                });
                if past {
                    return false;
                }
                let digits = next.magnitude().to_str_radix(10);
                if next.is_negative() {
                    line.bytes(b"-");
                }
                let width = pad.saturating_sub(u64::from(next.is_negative()));
                line.run(b'0', width.saturating_sub(digits.len() as u64));
                line.bytes(digits.as_bytes());
                self.cursor = Cursor::Integers {
                    next: next + &delta,
                    delta,
                    end,
                    pad,
                };
                return true;
            }
            Cursor::Sums {
                units,
                delta,
                scale,
            } => {
                let units = units + &delta;
                let value = Number {
                    negative: units.is_negative(),
                    units: units.magnitude().clone(),
                    scale,
                    kind: Kind::Finite,
                };
                self.cursor = Cursor::Sums {
                    units,
                    delta,
                    scale,
                };
                value
            }
            Cursor::Repeat(value) => {
                self.cursor = Cursor::Repeat(value.clone());
                value
            }
        };
        self.format.render(&value, line);
        if self.beyond(&value) {
            self.cursor = Cursor::Done;
            return line.runs() != self.shown.runs()
                && self.format.names_last(&line.reading(), &self.last);
        }
        self.shown.clone_from(line);
        true
    }

    /// The lines joined by SEPARATOR and ended by a newline, a bounded
    /// window per call, a long run spread over as many as it takes;
    /// nothing at all when there is no line.
    fn window(&mut self, out: &mut Vec<u8>) {
        let start = out.len();
        loop {
            while let Some(piece) = self.pending.front_mut() {
                let room = OUTPUT.saturating_sub(out.len() - start) as u64;
                if room == 0 {
                    return;
                }
                match piece {
                    Piece::Bytes(bytes) => out.extend_from_slice(bytes),
                    Piece::Run(byte, count) => {
                        let taken = (*count).min(room);
                        out.resize(out.len() + taken as usize, *byte);
                        *count -= taken;
                        if *count > 0 {
                            continue;
                        }
                    }
                }
                self.pending.pop_front();
            }
            if out.len() - start >= OUTPUT {
                return;
            }
            let mut line = Line::default();
            if !self.next_line(&mut line) {
                if self.printed {
                    out.push(b'\n');
                }
                self.ended = true;
                return;
            }
            if self.printed {
                self.pending.push_back(Piece::Bytes(self.separator.clone()));
            }
            self.pending.extend(line.pieces);
            self.printed = true;
        }
    }
}

impl Stream for Seq {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.started = true;
        self.window(out);
        Ok(())
    }

    fn busy(&self) -> bool {
        self.started && !self.ended
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.ended {
            self.window(out);
        }
        Ok(())
    }

    fn done(&self) -> bool {
        self.ended
    }
}

#[cfg(test)]
mod tests {
    fn seq(operands: &[&str], format: Option<&str>, equal_width: bool) -> Result<String, String> {
        let config = serde_json::json!({
            "operands": operands,
            "format": format,
            "equal_width": equal_width,
            "separator": "\n",
        });
        let mut stream = super::open(config.to_string().as_bytes()).map_err(|e| e.message)?;
        let mut out = Vec::new();
        stream.finish(&mut out).unwrap();
        while stream.busy() && out.len() < 1 << 20 {
            stream.drain(&mut out).unwrap();
        }
        Ok(String::from_utf8(out).unwrap())
    }

    #[test]
    fn prints_as_gnu_does() {
        // GNU seq 9.7 on debian:stable-slim (arm64, binary128 long double).
        for (operands, format, equal_width, expected) in [
            (
                &["0", "0.1", "0.5"][..],
                None,
                false,
                "0.0\n0.1\n0.2\n0.3\n0.4\n0.5\n",
            ),
            (
                &["1", "0.25", "2"],
                None,
                false,
                "1.00\n1.25\n1.50\n1.75\n2.00\n",
            ),
            (&["1.", "3"], None, false, "1\n2\n3\n"),
            (&["10", "-0.3", "9"], None, false, "10.0\n9.7\n9.4\n9.1\n"),
            (&["1", "0x1.8", "5"], None, false, "1\n2.5\n4\n"),
            (&["0x1p20", "0x1p20"], None, false, "1.04858e+06\n"),
            (&[" 1", " 3"], None, false, "1\n2\n3\n"),
            (&["-0", "1"], None, false, "-0\n1\n"),
            (&["-0", "1"], None, true, "-0\n01\n"),
            (
                &[".5", "-0.25", "-.5"],
                None,
                true,
                "00.50\n00.25\n00.00\n-0.25\n-0.50\n",
            ),
            (
                &["18446744073709551616", "18446744073709551618"],
                None,
                false,
                "18446744073709551616\n18446744073709551617\n18446744073709551618\n",
            ),
            (&["1", "-inf", "3"], None, false, ""),
            (&["1", "inf", "3"], None, false, "1\n"),
            (&["1e-4960"], None, false, ""),
            (&["0x1p-16494"], None, false, ""),
            (&["1", "1.0000001", "2"], Some("%g"), false, "1\n2\n"),
            (
                &["0", "0.34", "1"],
                Some("%.1f"),
                false,
                "0.0\n0.3\n0.7\n1.0\n",
            ),
            (
                &["0", "0.34", "1"],
                Some("%-5.1f"),
                false,
                "0.0  \n0.3  \n0.7  \n",
            ),
            (&["0", "0.6", "1"], Some("%.0f"), false, "0\n1\n"),
            (
                &["-1", "1"],
                Some("%08.2f"),
                false,
                "-0001.00\n00000.00\n00001.00\n",
            ),
            (&["1", "2"], Some("%#.0f"), false, "1.\n2.\n"),
            (&["1e-5", "1e-5"], Some("%G"), false, "1E-05\n"),
            (&["1", "2"], Some("%-8g|"), false, "1       |\n2       |\n"),
            (&["-1", "1"], Some("% g"), false, "-1\n 0\n 1\n"),
            (&["1", "2"], Some("%%%g%%"), false, "%1%\n%2%\n"),
            (
                &["1", "0.5", "2"],
                Some("%a"),
                false,
                "0x1p+0\n0x1.8p+0\n0x1p+1\n",
            ),
            (
                &["0.1", "0.1"],
                Some("%a"),
                false,
                "0x1.999999999999999999999999999ap-4\n",
            ),
            (
                &["0x1p-16400", "0x1p-16400"],
                Some("%a"),
                false,
                "0x0.00004p-16382\n",
            ),
            (&["0x1p-16495", "0x1p-16495"], Some("%a"), false, "0x0p+0\n"),
            (&["0", "0"], Some("%#a"), false, "0x0.p+0\n"),
            (&["3", "3"], Some("%.0a"), false, "0x2p+1\n"),
            (&["1", "1"], Some("%012.3A"), false, "0X001.000P+0\n"),
            (
                &["1e-1500", "1e-1500"],
                Some("%.1502f"),
                false,
                &format!("0.{}100\n", "0".repeat(1499)),
            ),
        ] {
            assert_eq!(
                seq(operands, format, equal_width).as_deref(),
                Ok(expected),
                "{operands:?} {format:?}"
            );
        }
        let lines = seq(&["inf", "-inf", "1"], None, false).unwrap();
        assert!(lines.starts_with("inf\nnan\nnan\n"));
    }

    #[test]
    fn refuses_as_gnu_does() {
        let refusal = |line: &str| {
            Err(format!(
                "seq: {line}\nTry 'seq --help' for more information."
            ))
        };
        for (operands, format, equal_width, expected) in [
            (
                &["abc"][..],
                None,
                false,
                refusal("invalid floating point argument: 'abc'"),
            ),
            (
                &["3 "],
                None,
                false,
                refusal("invalid floating point argument: '3 '"),
            ),
            (
                &["1e"],
                None,
                false,
                refusal("invalid floating point argument: '1e'"),
            ),
            (
                &["0x"],
                None,
                false,
                refusal("invalid floating point argument: '0x'"),
            ),
            (
                &["1e5000"],
                None,
                false,
                refusal("invalid floating point argument: '1e5000'"),
            ),
            (
                &["0x1p16384"],
                None,
                false,
                refusal("invalid floating point argument: '0x1p16384'"),
            ),
            (
                &["1.1897314953572317651e4932"],
                None,
                false,
                refusal("invalid floating point argument: '1.1897314953572317651e4932'"),
            ),
            (
                &["nan"],
                None,
                false,
                refusal("invalid 'not-a-number' argument: 'nan'"),
            ),
            (
                &["1", "-nan", "3"],
                None,
                false,
                refusal("invalid 'not-a-number' argument: '-nan'"),
            ),
            (
                &["1", "-0", "3"],
                None,
                false,
                refusal("invalid Zero increment value: '-0'"),
            ),
            (
                &["\u{c3}\u{a9}"],
                None,
                false,
                refusal("invalid floating point argument: '\\303\\251'"),
            ),
            (
                &["1", "2"],
                Some("%g"),
                true,
                refusal("format string may not be specified when printing equal width strings"),
            ),
            (
                &["1"],
                Some("x"),
                false,
                Err("seq: format 'x' has no % directive".into()),
            ),
            (
                &["1"],
                Some("%"),
                false,
                Err("seq: format '%' ends in %".into()),
            ),
            (
                &["1"],
                Some("%d"),
                false,
                Err("seq: format '%d' has unknown %d directive".into()),
            ),
            (
                &["1"],
                Some("%g%g"),
                false,
                Err("seq: format '%g%g' has too many % directives".into()),
            ),
        ] {
            assert_eq!(
                seq(operands, format, equal_width),
                expected,
                "{operands:?} {format:?}"
            );
        }
    }

    #[test]
    fn an_endless_sequence_is_drawn_a_window_at_a_time() {
        let config = r#"{"operands":["inf"],"separator":"\n"}"#;
        let mut stream = super::open(config.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.finish(&mut out).unwrap();
        for _ in 0..3 {
            assert!(stream.busy());
            assert!(out.len() < super::OUTPUT + 64);
            out.clear();
            stream.drain(&mut out).unwrap();
        }
        assert!(out.starts_with(b"\n") || out[0].is_ascii_digit());
    }

    #[test]
    fn a_wide_field_streams_in_bounded_windows() {
        let config = serde_json::json!({
            "operands": ["2"], "format": "%-2000000000.3f|", "equal_width": false,
            "separator": "\n",
        });
        let mut stream = super::open(config.to_string().as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.finish(&mut out).unwrap();
        assert!(out.starts_with(b"1.000    ") && out.len() <= super::OUTPUT);
        for _ in 0..4 {
            out.clear();
            stream.drain(&mut out).unwrap();
            assert!(out.len() <= super::OUTPUT && out.iter().all(|b| *b == b' '));
        }
        assert!(stream.busy());
        let precision = seq(&["0.5", "0.5", "1"], Some("%.100f"), false).unwrap();
        assert_eq!(precision, format!("0.5{0}\n1.0{0}\n", "0".repeat(99)));
    }

    #[test]
    fn a_format_past_c_int_is_a_write_error() {
        let refusal = Err("seq: write error: Value too large for defined data type".to_owned());
        assert_eq!(seq(&["1"], Some("%2147483648f"), false), refusal);
        assert_eq!(seq(&["1"], Some("%.2147483648f"), false), refusal);
        assert_eq!(
            seq(&["2", "1"], Some("%2147483648f"), false),
            Ok(String::new())
        );
    }

    #[test]
    fn a_row_printed_alike_as_digits_or_a_run_is_not_repeated() {
        let zeros = format!("0.{}\n", "0".repeat(1200));
        assert_eq!(
            seq(&["0", "1e-1300", "0"], Some("%.1200f"), false),
            Ok(zeros)
        );
    }
}
