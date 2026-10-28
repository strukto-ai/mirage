use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde::Deserialize;

use crate::cut::{Interval, Mode, intervals};
use crate::printf::number::render_float;
use crate::{Stream, StreamError, latin1, latin1_list, parse_config, quoted};

const OUTPUT: usize = 64 * 1024;

/// The most digits GNU prints a value with, its whole part and its
/// decimals together: its long double's digits and one, 34 where that is
/// binary128 (aarch64, whose pins this follows; x86-64 stops at 19).
const DIGITS: usize = 34;

/// The widest field mirage pads to, a bound GNU has not: past it a
/// padding or format width is refused, not allocated.
const WIDEST: usize = 1 << 20;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Scale {
    None,
    Si,
    Iec,
    IecI,
    Auto,
}

/// --round's methods, which settle a value cut to the decimals it prints.
#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Round {
    Up,
    Down,
    #[default]
    FromZero,
    TowardsZero,
    Nearest,
}

/// --invalid's modes: stop at the first field that is no number, or copy
/// it and go on, saying so and failing at the end, saying so, or not.
#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Invalid {
    #[default]
    Abort,
    Fail,
    Warn,
    Ignore,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    to: Scale,
    from: Scale,
    #[serde(deserialize_with = "latin1")]
    suffix: Vec<u8>,
    #[serde(deserialize_with = "latin1_list")]
    operands: Vec<Vec<u8>>,
    /// Every --field as typed; `-` is every field, and none is field 1.
    #[serde(default, deserialize_with = "latin1_list")]
    fields: Vec<Vec<u8>>,
    /// Every -d as typed; the last is the one byte fields are cut at, and
    /// with none they are runs of blanks apart.
    #[serde(default, deserialize_with = "latin1_list")]
    delimiters: Vec<Vec<u8>>,
    /// Every --header as typed, its count of records copied as they are.
    #[serde(default, deserialize_with = "latin1_list")]
    headers: Vec<Vec<u8>>,
    #[serde(default)]
    zero_terminated: bool,
    /// --from-unit and --to-unit as typed, none for 1.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    from_unit: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    to_unit: Option<Vec<u8>>,
    #[serde(default)]
    round: Round,
    /// --padding as typed.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    padding: Option<Vec<u8>>,
    /// --format as typed.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    format: Option<Vec<u8>>,
    #[serde(default)]
    invalid: Invalid,
}

/// A --format: the text around its one directive, and the directive's
/// zero flag, left alignment, width and precision. GNU unescapes `%%`
/// before the directive and copies the text after it as it is.
#[derive(Default)]
struct Format {
    prefix: Vec<u8>,
    suffix: Vec<u8>,
    zero: bool,
    left: bool,
    width: Option<usize>,
    precision: Option<usize>,
}

/// Leading digits as a count, saturating, and the rest.
fn count(text: &[u8]) -> (Option<usize>, &[u8]) {
    let len = text.iter().take_while(|b| b.is_ascii_digit()).count();
    let value = text[..len].iter().fold(0usize, |value, digit| {
        value
            .saturating_mul(10)
            .saturating_add(usize::from(digit - b'0'))
    });
    ((len > 0).then_some(value), &text[len..])
}

/// --format as GNU reads it (coreutils 9.7): any text, `%%` a `%`, then
/// one `%[0][' ][-][N][.[N]]f`, then text that holds no other directive.
fn format_of(typed: &[u8]) -> Result<Format, StreamError> {
    let shown = quoted(typed);
    let mut format = Format::default();
    let mut at = 0;
    loop {
        let Some(found) = memchr::memchr(b'%', &typed[at..]) else {
            return Err(refusal(format!("format '{shown}' has no % directive")));
        };
        format.prefix.extend_from_slice(&typed[at..at + found]);
        at += found + 1;
        match typed.get(at) {
            Some(b'%') => {
                format.prefix.push(b'%');
                at += 1;
            }
            Some(_) => break,
            None => return Err(refusal(format!("format '{shown}' ends in %"))),
        }
    }
    let mut rest = &typed[at..];
    while let Some((flag, tail)) = rest.split_first() {
        match flag {
            b'0' => format.zero = true,
            b'\'' | b' ' => {}
            _ => break,
        }
        rest = tail;
    }
    if let Some(tail) = rest.strip_prefix(b"-") {
        format.left = true;
        rest = tail;
    }
    (format.width, rest) = count(rest);
    if let Some(tail) = rest.strip_prefix(b".") {
        let (precision, tail) = count(tail);
        format.precision = Some(precision.unwrap_or(0));
        rest = tail;
    }
    let Some(suffix) = rest.strip_prefix(b"f") else {
        return Err(refusal(format!(
            "invalid format '{shown}', directive must be %[0]['][-][N][.][N]f"
        )));
    };
    let mut scan = suffix;
    while let Some(found) = memchr::memchr(b'%', scan) {
        if scan.get(found + 1) != Some(&b'%') {
            return Err(refusal(format!(
                "format '{shown}' has too many % directives"
            )));
        }
        scan = &scan[found + 2..];
    }
    if format.width.is_some_and(|width| width > WIDEST) {
        return Err(refusal(format!(
            "invalid format '{shown}': width too large"
        )));
    }
    format.suffix = suffix.to_vec();
    Ok(format)
}

/// A --from-unit or --to-unit size as GNU reads it: blanks and a `+`,
/// digits (1 when there are none), then a unit letter, `i` after it for
/// powers of 1024, and nothing more; zero, or past what 64 bits hold, is
/// no size.
fn unit_size(typed: &[u8]) -> Result<BigUint, StreamError> {
    let invalid = || refusal(format!("invalid unit size: '{}'", quoted(typed)));
    let lead = typed.iter().take_while(|b| b.is_ascii_whitespace()).count();
    let text = &typed[lead..];
    let text = text.strip_prefix(b"+").unwrap_or(text);
    let digits = text.iter().take_while(|b| b.is_ascii_digit()).count();
    let mut size = if digits == 0 {
        BigUint::from(1_u8)
    } else {
        BigUint::parse_bytes(&text[..digits], 10).expect("digits")
    };
    match &text[digits..] {
        [] => {}
        [letter] => size *= pow(1000, unit_power(*letter).ok_or_else(invalid)? as usize),
        [letter, b'i'] => size *= pow(1024, unit_power(*letter).ok_or_else(invalid)? as usize),
        _ => return Err(invalid()),
    }
    if size.is_zero() || size > BigUint::from(u64::MAX) {
        return Err(invalid());
    }
    Ok(size)
}

/// --padding as GNU reads it: blanks, a sign and digits, never zero; a
/// negative width pads on the right.
fn padding_of(typed: &[u8]) -> Result<i64, StreamError> {
    let invalid = || refusal(format!("invalid padding value '{}'", quoted(typed)));
    let lead = typed.iter().take_while(|b| b.is_ascii_whitespace()).count();
    let text = &typed[lead..];
    let (negative, text) = match text.split_first() {
        Some((b'-', rest)) => (true, rest),
        Some((b'+', rest)) => (false, rest),
        _ => (false, text),
    };
    let (Some(width), []) = count(text) else {
        return Err(invalid());
    };
    if width == 0 || width > WIDEST {
        return Err(invalid());
    }
    Ok(if negative {
        -(width as i64)
    } else {
        width as i64
    })
}

// SI spells kilo lowercase; every larger unit and all of IEC stay uppercase.
const IEC_UNITS: [&str; 11] = ["", "K", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q"];
const SI_UNITS: [&str; 11] = ["", "k", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q"];

/// A unit letter's power; only kilo has a lowercase spelling.
fn unit_power(byte: u8) -> Option<u32> {
    match byte {
        b'k' => Some(1),
        _ => IEC_UNITS[1..]
            .iter()
            .position(|unit| unit.as_bytes() == [byte])
            .map(|at| at as u32 + 1),
    }
}

fn refusal(message: String) -> StreamError {
    StreamError::new(format!("numfmt: {message}"))
}

/// A blank between fields: newline too, which only `-z` puts inside one.
fn blank(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n')
}

/// GNU's two shapes of suffix complaint: an unusable first character
/// quotes only the field, a usable unit followed by junk quotes the field
/// and then the junk (coreutils 9.7).
fn suffix_error(value: &[u8], junk: &[u8]) -> StreamError {
    if junk.is_empty() {
        return refusal(format!("invalid suffix in input: '{}'", quoted(value)));
    }
    refusal(format!(
        "invalid suffix in input '{}': '{}'",
        quoted(value),
        quoted(junk)
    ))
}

/// A value held exactly, `numerator / denominator`, and the decimals an
/// unscaled one was typed with, which `--to=none` prints it back at.
struct Value {
    negative: bool,
    numerator: BigUint,
    denominator: BigUint,
    decimals: usize,
}

fn pow(base: u32, exponent: usize) -> BigUint {
    BigUint::from(base).pow(exponent as u32)
}

/// A unit suffix as `(base, power)` for `--from`: si and iec take the
/// bare letter, iec-i requires its `i`, auto takes either and lets the
/// `i` pick 1024, and nothing may follow. Under iec-i a unit not followed
/// by its `i` is the missing-`i` clause, whatever comes after it.
fn scale_of(value: &[u8], suffix: &[u8], from: Scale) -> Result<(u32, u32), StreamError> {
    let Some(power) = unit_power(suffix[0]) else {
        return Err(suffix_error(value, b""));
    };
    let tail = &suffix[1..];
    let (base, rest) = match from {
        Scale::IecI if tail.first() != Some(&b'i') => {
            return Err(refusal(format!(
                "missing 'i' suffix in input: '{}' (e.g Ki/Mi/Gi)",
                quoted(value)
            )));
        }
        Scale::IecI => (1024, &tail[1..]),
        Scale::Auto if tail.first() == Some(&b'i') => (1024, &tail[1..]),
        Scale::Auto | Scale::Si => (1000, tail),
        _ => (1024, tail),
    };
    if !rest.is_empty() {
        return Err(suffix_error(value, rest));
    }
    Ok((base, power))
}

/// One field: an optional `-`, digits with at most one point that a digit
/// follows (GNU reads no `+`, no bare trailing point and no exponent: `1e3`
/// is a number and the unknown suffix `e3`), then any unit. A real unit
/// with no `--from` is pointed at it, so the letter is checked before the
/// mode. A zero is unsigned, as GNU prints `-0` as `0`.
fn parse(value: &[u8], from: Scale) -> Result<Value, StreamError> {
    let invalid = || refusal(format!("invalid number: '{}'", quoted(value)));
    let negative = value.first() == Some(&b'-');
    let digits_at = |at: usize| {
        value[at.min(value.len())..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let start = usize::from(negative);
    let whole = digits_at(start);
    let point = start + whole;
    let fraction = if value.get(point) == Some(&b'.') {
        digits_at(point + 1)
    } else {
        0
    };
    let end = match (whole, fraction) {
        (_, 1..) => point + 1 + fraction,
        (1.., 0) => point,
        _ => return Err(invalid()),
    };
    let rest = &value[end..];
    if rest.first() == Some(&b'.') && fraction == 0 {
        return Err(invalid());
    }
    let spaced = rest.iter().take_while(|b| blank(**b)).count();
    if spaced > 0 && spaced == rest.len() && from == Scale::None {
        return Err(refusal(format!(
            "rejecting suffix in input: '{}' (consider using --from)",
            quoted(value)
        )));
    }
    let rest = &rest[spaced..];
    let digits: Vec<u8> = value[start..end]
        .iter()
        .copied()
        .filter(|b| *b != b'.')
        .collect();
    let mut numerator = BigUint::parse_bytes(&digits, 10).expect("digits");
    let mut decimals = fraction;
    if !rest.is_empty() {
        if unit_power(rest[0]).is_none() {
            return Err(suffix_error(value, b""));
        }
        if from == Scale::None {
            return Err(refusal(format!(
                "rejecting suffix in input: '{}' (consider using --from)",
                quoted(value)
            )));
        }
        let (base, power) = scale_of(value, rest, from)?;
        numerator *= pow(base, power as usize);
        decimals = 0;
    }
    Ok(Value {
        negative: negative && !numerator.is_zero(),
        numerator,
        denominator: pow(10, fraction),
        decimals,
    })
}

/// `numerator / denominator` rounded half to even, as printf rounds.
fn half_even(numerator: &BigUint, denominator: &BigUint) -> BigUint {
    let kept = numerator / denominator;
    let twice = (numerator - &kept * denominator) << 1_usize;
    if twice > *denominator || twice == *denominator && kept.bit(0) {
        kept + 1_u8
    } else {
        kept
    }
}

/// The magnitude `numerator / denominator` of a value of sign `negative`,
/// to a whole number as --round says.
fn rounded(numerator: &BigUint, denominator: &BigUint, round: Round, negative: bool) -> BigUint {
    let kept = numerator / denominator;
    let rest = numerator - &kept * denominator;
    let up = !rest.is_zero()
        && match round {
            Round::FromZero => true,
            Round::TowardsZero => false,
            Round::Up => !negative,
            Round::Down => negative,
            Round::Nearest => rest << 1_usize >= *denominator,
        };
    if up { kept + 1_u8 } else { kept }
}

/// GNU's refusal of a value printed with more digits than it holds.
fn too_precise(
    value: &Value,
    numerator: &BigUint,
    denominator: &BigUint,
    places: usize,
) -> StreamError {
    let magnitude = numerator.to_f64().unwrap_or(f64::MAX) / denominator.to_f64().unwrap_or(1.0);
    let signed = if value.negative {
        -magnitude
    } else {
        magnitude
    };
    let general = render_float(signed, b'g', &[], None);
    let shown = String::from_utf8_lossy(&[general.prefix, general.body, general.suffix].concat())
        .into_owned();
    refusal(format!(
        "value/precision too large to be printed: '{shown}/{places}' (consider using --to)"
    ))
}

/// Whether a value's whole digits and `places` decimals are more than GNU
/// prints. A whole number has none to refuse: mirage prints every digit
/// of one, where GNU refuses to read one so long (`value too large to be
/// converted`).
fn past_digits(numerator: &BigUint, denominator: &BigUint, places: usize) -> bool {
    places > 0 && (numerator / denominator).to_string().len() + places > DIGITS
}

fn fixed(negative: bool, scaled: &BigUint, places: usize, out: &mut Vec<u8>) {
    let digits = format!("{scaled:0>width$}", width = places + 1);
    if negative {
        out.push(b'-');
    }
    let (whole, fraction) = digits.split_at(digits.len() - places);
    out.extend_from_slice(whole.as_bytes());
    if places > 0 {
        out.push(b'.');
        out.extend_from_slice(fraction.as_bytes());
    }
}

/// A value as GNU numfmt prints it under `--to`, rounded as --round says
/// and with `precision` decimals when --format gives some; the length of
/// its number before the unit. `none` keeps the decimals it was typed with
/// and a scaled one is a whole number, in fixed notation (`1Y` is
/// twenty-five digits). A scale divides while it can, rounds keeping one
/// decimal below 10, which can carry it back over the base (999.4 is
/// 1.0k), and prints through printf, rounding half to even. GNU reads into
/// a long double, so a value it cannot hold exactly may round up on the way
/// out (`1.10` prints as `1.11`); mirage keeps the value exact, as printf
/// does.
fn format(
    value: &Value,
    to: Scale,
    round: Round,
    precision: Option<usize>,
    out: &mut Vec<u8>,
) -> Result<usize, StreamError> {
    let Value {
        negative,
        numerator,
        denominator,
        decimals,
    } = value;
    let start = out.len();
    if to == Scale::None {
        let places = precision.unwrap_or(*decimals);
        if past_digits(numerator, denominator, places) {
            return Err(too_precise(value, numerator, denominator, places));
        }
        let scaled = rounded(
            &(numerator * pow(10, places)),
            denominator,
            round,
            *negative,
        );
        fixed(*negative, &scaled, places, out);
        return Ok(out.len() - start);
    }
    let (base, units) = match to {
        Scale::Si => (BigUint::from(1000_u32), SI_UNITS),
        _ => (BigUint::from(1024_u32), IEC_UNITS),
    };
    let ten = BigUint::from(10_u8);
    let top = units.len() - 1;
    let mut power = 0;
    let mut denominator = denominator.clone();
    while *numerator >= &base * &denominator && power < top {
        denominator *= &base;
        power += 1;
    }
    let places = precision.unwrap_or(usize::from(*numerator < &ten * &denominator));
    if past_digits(numerator, &denominator, places) {
        return Err(too_precise(value, numerator, &denominator, places));
    }
    let mut numerator = rounded(
        &(numerator * pow(10, places)),
        &denominator,
        round,
        *negative,
    );
    let mut denominator = pow(10, places);
    if numerator >= &base * &denominator && power < top {
        denominator *= &base;
        power += 1;
    }
    let places = precision.unwrap_or(usize::from(power > 0 && numerator < &ten * &denominator));
    numerator *= pow(10, places);
    let scaled = half_even(&numerator, &denominator);
    fixed(*negative, &scaled, places, out);
    let number = out.len() - start;
    out.extend_from_slice(units[power].as_bytes());
    if to == Scale::IecI && power > 0 {
        out.push(b'i');
    }
    Ok(number)
}

struct Numfmt {
    config: Config,
    from_unit: BigUint,
    to_unit: BigUint,
    format: Option<Format>,
    /// The width a field is padded to, negative to pad on the right; 0 for
    /// none.
    padding: i64,
    /// Lines said of the fields --invalid let through, not yet taken.
    warnings: Vec<u8>,
    /// Whether --invalid=fail let a field through.
    invalid_seen: bool,
    fields: Vec<Interval>,
    delimiter: Option<u8>,
    header: u64,
    separator: u8,
    held: Vec<u8>,
    /// How much of `held` is known to hold no separator.
    scanned: usize,
    /// The next operand to convert.
    next: usize,
    eof: bool,
    /// Whether the last call stopped at its output window with records
    /// left to convert.
    again: bool,
    failed: bool,
}

/// --header's count as GNU reads it: blanks, an optional `+` and digits
/// naming at least one record (coreutils 9.7).
fn header_count(value: &[u8]) -> Result<u64, StreamError> {
    let lead = value.iter().take_while(|b| b.is_ascii_whitespace()).count();
    let digits = value[lead..].strip_prefix(b"+").unwrap_or(&value[lead..]);
    std::str::from_utf8(digits)
        .ok()
        .filter(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|count| *count > 0)
        .ok_or_else(|| refusal(format!("invalid header value '{}'", quoted(value))))
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let unit = |typed: &Option<Vec<u8>>| {
        typed
            .as_deref()
            .map_or_else(|| Ok(BigUint::from(1_u8)), unit_size)
    };
    let from_unit = unit(&config.from_unit)?;
    let to_unit = unit(&config.to_unit)?;
    let padding = config.padding.as_deref().map_or(Ok(0), padding_of)?;
    let format = config.format.as_deref().map(format_of).transpose()?;
    if config
        .delimiters
        .iter()
        .any(|delimiter| delimiter.len() > 1)
    {
        return Err(refusal(
            "the delimiter must be a single character".to_owned(),
        ));
    }
    let header = config
        .headers
        .iter()
        .try_fold(0, |_, value| header_count(value))?;
    let fields = match config.fields.as_slice() {
        [] => vec![Interval { first: 1, last: 1 }],
        [all] if all == b"-" => vec![Interval {
            first: 1,
            last: u64::MAX,
        }],
        [list] => intervals(list, Mode::Fields, "numfmt")?,
        _ => return Err(refusal("multiple field specifications".to_owned())),
    };
    Ok(Box::new(Numfmt {
        from_unit,
        to_unit,
        format,
        padding,
        warnings: Vec::new(),
        invalid_seen: false,
        delimiter: config
            .delimiters
            .last()
            .map(|delimiter| delimiter.first().copied().unwrap_or(0)),
        separator: if config.zero_terminated { 0 } else { b'\n' },
        fields,
        header,
        config,
        held: Vec::new(),
        scanned: 0,
        next: 0,
        eof: false,
        again: false,
        failed: false,
    }))
}

impl Numfmt {
    /// One field converted. A field that is no number stops the run, or,
    /// under --invalid, goes out as it came, said of unless ignored, and
    /// fails the run at its end under `fail`.
    fn field(&mut self, value: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mode = self.config.invalid;
        match self.convert(value, out) {
            Err(error) if mode != Invalid::Abort => {
                if mode != Invalid::Ignore {
                    self.warnings.extend_from_slice(error.message.as_bytes());
                    self.warnings.push(b'\n');
                }
                self.invalid_seen |= mode == Invalid::Fail;
                out.extend_from_slice(value);
                Ok(())
            }
            converted => converted,
        }
    }

    /// One field with `--suffix` cut off its end when there, scaled by the
    /// units, then the number with the suffix after it, padded and set in
    /// --format's text. A format's width stands in for --padding; with its
    /// zero flag the number is zero-filled to it before its unit, as printf
    /// fills it, and otherwise the whole field is padded with blanks.
    fn convert(&self, value: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let suffix = &self.config.suffix;
        let number = value.strip_suffix(suffix.as_slice()).unwrap_or(value);
        let mut parsed = parse(number, self.config.from)?;
        parsed.numerator *= &self.from_unit;
        parsed.denominator *= &self.to_unit;
        let layout = self.format.as_ref();
        let precision = layout.and_then(|layout| layout.precision);
        let mut field = Vec::new();
        let digits = format(
            &parsed,
            self.config.to,
            self.config.round,
            precision,
            &mut field,
        )?;
        let zero = layout.filter(|layout| layout.zero && !layout.left);
        if let Some(width) = zero.and_then(|layout| layout.width) {
            let sign = usize::from(field.first() == Some(&b'-'));
            let fill = width.saturating_sub(digits);
            field.splice(sign..sign, std::iter::repeat_n(b'0', fill));
        }
        field.extend_from_slice(suffix);
        let (width, left) = match layout.and_then(|layout| layout.width.map(|w| (w, layout.left))) {
            Some(spec) => spec,
            None => (self.padding.unsigned_abs() as usize, self.padding < 0),
        };
        let fill = width.saturating_sub(field.len());
        if let Some(layout) = layout {
            out.extend_from_slice(&layout.prefix);
        }
        if !left {
            out.resize(out.len() + fill, b' ');
        }
        out.extend_from_slice(&field);
        if left {
            out.resize(out.len() + fill, b' ');
        }
        if let Some(layout) = layout {
            out.extend_from_slice(&layout.suffix);
        }
        Ok(())
    }

    fn selected(&self, index: u64) -> bool {
        self.fields
            .iter()
            .any(|range| range.first <= index && index <= range.last)
    }

    /// One record with its selected fields converted, as GNU cuts it
    /// (coreutils 9.7). At a -d byte every field is between two of them
    /// and a converted one loses its leading blanks. Otherwise one blank
    /// parts two fields and goes out as a space, any more lead the next
    /// field, and a converted field that had them is right-aligned to its
    /// width. A selected field holding no number is refused, so is an
    /// empty record.
    fn record(&mut self, line: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(delimiter) = self.delimiter {
            for (index, field) in line.split(|b| *b == delimiter).enumerate() {
                if index > 0 {
                    out.push(delimiter);
                }
                if self.selected(index as u64 + 1) {
                    let lead = field.iter().take_while(|b| blank(**b)).count();
                    self.field(&field[lead..], out)?;
                } else {
                    out.extend_from_slice(field);
                }
            }
            return Ok(());
        }
        let mut at = 0;
        let mut index = 1;
        loop {
            let lead = line[at..].iter().take_while(|b| blank(**b)).count();
            let end = at + lead + line[at + lead..].iter().take_while(|b| !blank(**b)).count();
            if self.selected(index) {
                let mut converted = Vec::new();
                self.field(&line[at + lead..end], &mut converted)?;
                if lead > 0 {
                    let width = end - at;
                    out.resize(out.len() + width.saturating_sub(converted.len()), b' ');
                }
                out.extend_from_slice(&converted);
            } else {
                out.extend_from_slice(&line[at..end]);
            }
            if end == line.len() {
                return Ok(());
            }
            out.push(b' ');
            at = end + 1;
            index += 1;
        }
    }

    /// A record, the header's ones copied as they are, and its separator
    /// when it had one.
    fn line(&mut self, line: &[u8], ended: bool, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.header > 0 {
            self.header -= 1;
            out.extend_from_slice(line);
        } else {
            self.record(line, out)?;
        }
        if ended {
            out.push(self.separator);
        }
        Ok(())
    }

    /// The records or operands that fit one output window, the rest left
    /// for `drain`: a long `--suffix` on many short records would
    /// otherwise build all of their output in one call.
    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let start = out.len();
        self.again = false;
        if !self.config.operands.is_empty() {
            while self.next < self.config.operands.len() {
                if out.len() - start >= OUTPUT {
                    self.again = true;
                    return Ok(());
                }
                let value = std::mem::take(&mut self.config.operands[self.next]);
                self.next += 1;
                self.record(&value, out)?;
                out.push(self.separator);
            }
            return Ok(());
        }
        let held = std::mem::take(&mut self.held);
        let mut at = 0;
        let mut from = self.scanned;
        let mut result = Ok(());
        while result.is_ok() {
            if out.len() - start >= OUTPUT {
                self.again = true;
                break;
            }
            match memchr::memchr(self.separator, &held[from..]) {
                Some(found) => {
                    result = self.line(&held[at..from + found], true, out);
                    at = from + found + 1;
                    from = at;
                }
                None => {
                    if self.eof && at < held.len() {
                        result = self.line(&held[at..], false, out);
                        at = held.len();
                    }
                    from = held.len();
                    break;
                }
            }
        }
        self.held = held;
        self.held.drain(..at);
        self.scanned = from - at;
        result
    }

    fn checked(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let result = self.step(out);
        self.failed = result.is_err();
        result
    }
}

impl Stream for Numfmt {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.failed || !self.config.operands.is_empty() {
            return Ok(());
        }
        self.held.extend_from_slice(input);
        self.checked(out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.eof = true;
        if self.failed {
            return Ok(());
        }
        self.checked(out)
    }

    fn busy(&self) -> bool {
        !self.failed && self.again
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.failed {
            return Ok(());
        }
        self.checked(out)
    }

    fn status(&self) -> i32 {
        if self.invalid_seen { 2 } else { 0 }
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.warnings);
    }
}

#[cfg(test)]
mod tests {
    fn numfmt(value: &str, to: &str, from: &str) -> Result<String, String> {
        let config = serde_json::json!({
            "to": to, "from": from, "suffix": "", "operands": [value],
        });
        let mut stream = super::open(config.to_string().as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.finish(&mut out).map_err(|e| e.message)?;
        Ok(String::from_utf8(out).unwrap().trim_end().to_owned())
    }

    #[test]
    fn converts_as_gnu_does() {
        for (value, to, from, expected) in [
            ("1Y", "none", "si", "1000000000000000000000000"),
            ("1Q", "none", "iec", "1267650600228229401496703205376"),
            ("1.20", "none", "none", "1.20"),
            ("00012", "none", "none", "12"),
            ("1.0005K", "none", "si", "1001"),
            ("-0.0015K", "none", "si", "-2"),
            ("1k", "none", "iec", "1024"),
            ("1ki", "none", "auto", "1024"),
            ("1.5", "none", "iec-i", "1.5"),
            ("1000", "iec-i", "none", "1000"),
            ("1024", "iec-i", "none", "1.0Ki"),
            ("2.5", "si", "none", "2"),
            ("999.95", "si", "none", "1.0k"),
            ("-999.95", "si", "none", "-1.0k"),
            ("1023.95", "iec", "none", "1.0K"),
            ("1000.00000001", "si", "none", "1.1k"),
            ("1000000000000000000001", "si", "none", "1.1Z"),
            ("-0.04", "si", "none", "-0"),
            ("-0", "si", "none", "0"),
            ("-0.0", "none", "none", "0.0"),
            ("-0K", "none", "si", "0"),
        ] {
            assert_eq!(
                numfmt(value, to, from).as_deref(),
                Ok(expected),
                "{value} {to} {from}"
            );
        }
    }

    #[test]
    fn refuses_as_gnu_does() {
        let refused = |message: &str| Err(format!("numfmt: {message}"));
        for (value, from, expected) in [
            (
                "1KiB",
                "iec",
                refused("invalid suffix in input '1KiB': 'iB'"),
            ),
            (
                "1KiB",
                "auto",
                refused("invalid suffix in input '1KiB': 'B'"),
            ),
            ("1m", "si", refused("invalid suffix in input: '1m'")),
            ("1e3", "none", refused("invalid suffix in input: '1e3'")),
            (
                "1K",
                "iec-i",
                refused("missing 'i' suffix in input: '1K' (e.g Ki/Mi/Gi)"),
            ),
            (
                "1K\u{c3}\u{a9}",
                "iec-i",
                refused("missing 'i' suffix in input: '1K\\303\\251' (e.g Ki/Mi/Gi)"),
            ),
            (
                "1Kii",
                "iec-i",
                refused("invalid suffix in input '1Kii': 'i'"),
            ),
            ("1iK", "iec-i", refused("invalid suffix in input: '1iK'")),
            (
                "1k",
                "none",
                refused("rejecting suffix in input: '1k' (consider using --from)"),
            ),
            ("+1", "si", refused("invalid number: '+1'")),
            ("1.", "none", refused("invalid number: '1.'")),
            ("x\\", "none", refused("invalid number: 'x\\\\'")),
            (
                "1K\\",
                "si",
                refused("invalid suffix in input '1K\\\\': '\\\\'"),
            ),
        ] {
            assert_eq!(numfmt(value, "none", from), expected, "{value} {from}");
        }
    }

    fn records(options: serde_json::Value, input: &[&[u8]]) -> (Vec<u8>, Option<String>) {
        let mut config = serde_json::json!({
            "to": "si", "from": "none", "suffix": "", "operands": [],
        });
        config
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let mut stream = super::open(config.to_string().as_bytes()).unwrap();
        let mut out = Vec::new();
        for chunk in input {
            if let Err(err) = stream.feed(chunk, &mut out) {
                return (out, Some(err.message));
            }
        }
        let err = stream.finish(&mut out).err().map(|err| err.message);
        (out, err)
    }

    /// The operands' output, the stream's warnings and status, and its
    /// refusal, under `options` over `to: none`.
    fn converted(
        options: serde_json::Value,
        operands: &[&str],
    ) -> (String, String, i32, Option<String>) {
        let mut config = serde_json::json!({
            "to": "none", "from": "none", "suffix": "", "operands": operands,
        });
        config
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let mut stream = match super::open(config.to_string().as_bytes()) {
            Ok(stream) => stream,
            Err(err) => return (String::new(), String::new(), 1, Some(err.message)),
        };
        let mut out = Vec::new();
        let refusal = stream.finish(&mut out).err().map(|err| err.message);
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        let mut warnings = Vec::new();
        stream.take_stderr(&mut warnings);
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
        (text(out), text(warnings), stream.status(), refusal)
    }

    #[test]
    fn units_rounding_padding_and_formats_match_gnu() {
        use serde_json::json;
        for (options, operand, expected) in [
            (json!({"from_unit": "1024"}), "1.5", "1536.0\n"),
            (json!({"from_unit": "Ki"}), "1", "1024\n"),
            (json!({"from_unit": " +5"}), "1", "5\n"),
            (json!({"from_unit": "1000", "to": "si"}), "1500", "1.5M\n"),
            (json!({"to_unit": "1000"}), "1499", "2\n"),
            (json!({"to_unit": "1000"}), "1.5", "0.1\n"),
            (json!({"to_unit": "10"}), "1.55", "0.16\n"),
            (json!({"from_unit": "10", "to_unit": "3"}), "1", "4\n"),
            (json!({"to_unit": "1000"}), "-1500", "-2\n"),
            (
                json!({"to_unit": "1000", "round": "towards-zero"}),
                "1999",
                "1\n",
            ),
            (
                json!({"to_unit": "1000", "round": "nearest"}),
                "2500",
                "3\n",
            ),
            (json!({"round": "up", "to": "si"}), "1001", "1.1k\n"),
            (json!({"round": "down", "to": "si"}), "1999", "1.9k\n"),
            (json!({"round": "up", "to": "si"}), "-1001", "-1.0k\n"),
            (json!({"round": "down", "to": "si"}), "-1001", "-1.1k\n"),
            (json!({"round": "nearest", "to": "si"}), "1250", "1.3k\n"),
            (json!({"round": "nearest", "to": "si"}), "1049", "1.0k\n"),
            (json!({"round": "up", "to": "si"}), "9999", "10k\n"),
            (json!({"round": "down", "to": "si"}), "999999", "999k\n"),
            (json!({"padding": "10"}), "1000", "      1000\n"),
            (json!({"padding": "-10"}), "1000", "1000      \n"),
            (json!({"padding": "3"}), "123456", "123456\n"),
            (
                json!({"padding": "5", "suffix": "B", "to": "si"}),
                "1500",
                "1.5kB\n",
            ),
            (json!({"format": "%.3f"}), "1000", "1000.000\n"),
            (json!({"format": "%f"}), "1.50", "1.50\n"),
            (json!({"format": "%010f"}), "1000", "0000001000\n"),
            (json!({"format": "%-10f"}), "1000", "1000      \n"),
            (json!({"format": "%0-10f"}), "5", "5         \n"),
            (json!({"format": "%'05f"}), "5", "00005\n"),
            (json!({"format": "x%fy"}), "5", "x5y\n"),
            (json!({"format": "%%%f%%"}), "5", "%5%%\n"),
            (json!({"format": "%.f"}), "1234.5", "1235\n"),
            (json!({"format": "%.2f"}), "0.125", "0.13\n"),
            (
                json!({"format": "%.2f", "round": "down"}),
                "0.125",
                "0.12\n",
            ),
            (json!({"format": "%.1f"}), "-0.04", "-0.1\n"),
            (json!({"format": "%05.1f"}), "-5", "-05.0\n"),
            (json!({"format": "%.3f", "to": "si"}), "1234567", "1.235M\n"),
            (json!({"format": "%.0f", "to": "si"}), "1499", "2k\n"),
            (
                json!({"format": "%.4f", "to": "iec"}),
                "1000",
                "1000.0000\n",
            ),
            (
                json!({"format": "%08.1f", "to": "si"}),
                "1500",
                "000001.5k\n",
            ),
            (
                json!({"format": "%010.2f", "to": "si"}),
                "-1500",
                "-000001.50k\n",
            ),
            (
                json!({"format": "%10.1f", "to": "iec"}),
                "1048576",
                "      1.0M\n",
            ),
            (
                json!({"format": "x%-6.1fy", "to": "si"}),
                "1500",
                "x1.5k  y\n",
            ),
            (
                json!({"format": "%8.1f", "suffix": "B", "to": "si"}),
                "1500",
                "   1.5kB\n",
            ),
            (json!({"format": "%3f", "padding": "10"}), "1", "  1\n"),
        ] {
            let (out, _, status, refusal) = converted(options.clone(), &[operand]);
            assert_eq!(
                (out.as_str(), status, refusal),
                (expected, 0, None),
                "{options} {operand}"
            );
        }
    }

    #[test]
    fn bad_options_and_fields_are_refused_or_let_through_as_gnu_does() {
        use serde_json::json;
        for (options, expected) in [
            (json!({"from_unit": "0"}), "numfmt: invalid unit size: '0'"),
            (
                json!({"from_unit": "KiB"}),
                "numfmt: invalid unit size: 'KiB'",
            ),
            (
                json!({"to_unit": "16Ei"}),
                "numfmt: invalid unit size: '16Ei'",
            ),
            (
                json!({"from_unit": "1i"}),
                "numfmt: invalid unit size: '1i'",
            ),
            (json!({"padding": "0"}), "numfmt: invalid padding value '0'"),
            (json!({"padding": ""}), "numfmt: invalid padding value ''"),
            (
                json!({"format": "abc"}),
                "numfmt: format 'abc' has no % directive",
            ),
            (json!({"format": "%"}), "numfmt: format '%' ends in %"),
            (
                json!({"format": "%f%f"}),
                "numfmt: format '%f%f' has too many % directives",
            ),
            (
                json!({"format": "%-'5f"}),
                "numfmt: invalid format '%-\\'5f', directive must be %[0]['][-][N][.][N]f",
            ),
        ] {
            let (_, _, _, refusal) = converted(options.clone(), &["1"]);
            assert_eq!(refusal.as_deref(), Some(expected), "{options}");
        }
        let (out, _, _, refusal) = converted(json!({"format": "%.34f"}), &["1"]);
        assert_eq!(out, "");
        assert_eq!(
            refusal.as_deref(),
            Some("numfmt: value/precision too large to be printed: '1/34' (consider using --to)")
        );
        let (out, _, _, _) = converted(json!({"format": "%.33f"}), &["1"]);
        assert_eq!(out.len(), 36);
        let invalid = ["abc", "12", "def"];
        let said = "numfmt: invalid number: 'abc'\nnumfmt: invalid number: 'def'\n";
        assert_eq!(
            converted(json!({"invalid": "fail"}), &invalid),
            ("abc\n12\ndef\n".into(), said.into(), 2, None)
        );
        assert_eq!(
            converted(json!({"invalid": "warn", "padding": "6"}), &invalid),
            ("abc\n    12\ndef\n".into(), said.into(), 0, None)
        );
        assert_eq!(
            converted(json!({"invalid": "ignore"}), &invalid),
            ("abc\n12\ndef\n".into(), String::new(), 0, None)
        );
        let (out, _, _, refusal) = converted(json!({"invalid": "abort"}), &invalid);
        assert_eq!(
            (out.as_str(), refusal.as_deref()),
            ("", Some("numfmt: invalid number: 'abc'"))
        );
    }

    #[test]
    fn records_split_into_fields_as_gnu_cuts_them() {
        let all = serde_json::json!({"fields": ["-"]});
        for (options, input, expected, refusal) in [
            (
                all.clone(),
                &b"  1000   2000\n"[..],
                &b"  1.0k   2.0k\n"[..],
                None,
            ),
            (
                serde_json::json!({}),
                b"1000\t\t2000\n",
                b"1.0k \t2000\n",
                None,
            ),
            (
                serde_json::json!({"fields": ["2"]}),
                b"1000\t\t2000\n",
                b"1000  2.0k\n",
                None,
            ),
            (
                serde_json::json!({}),
                b"   123456789 x\n",
                b"        124M x\n",
                None,
            ),
            (serde_json::json!({}), b"1000000 2\n", b"1.0M 2\n", None),
            (
                all.clone(),
                b"1  2  \n",
                b"1  2 ",
                Some("invalid number: ''"),
            ),
            (
                serde_json::json!({}),
                b"100\n\n200\n",
                b"100\n",
                Some("invalid number: ''"),
            ),
            (serde_json::json!({}), b"1000\n20", b"1.0k\n20", None),
            (
                serde_json::json!({"fields": ["1,3"]}),
                b"1000 2000 3000\n",
                b"1.0k 2000 3.0k\n",
                None,
            ),
            (
                serde_json::json!({"delimiters": [","], "fields": ["-"]}),
                b" 1000, 2000\n",
                b"1.0k,2.0k\n",
                None,
            ),
            (
                serde_json::json!({"delimiters": [","], "fields": ["2"]}),
                b"1000, 2000 \n",
                b"1000,",
                Some("rejecting suffix in input: '2000 ' (consider using --from)"),
            ),
            (
                serde_json::json!({"headers": ["1"]}),
                b"h1 h2\n1000 2000\n",
                b"h1 h2\n1.0k 2000\n",
                None,
            ),
            (
                serde_json::json!({"zero_terminated": true}),
                b"1000\n2000\0",
                b"1.0k 2000\0",
                None,
            ),
        ] {
            let (out, err) = records(options, &[input]);
            assert_eq!(
                (out.as_slice(), err.as_deref()),
                (expected, refusal.map(|r| format!("numfmt: {r}")).as_deref()),
                "{input:?}"
            );
        }
    }

    #[test]
    fn options_are_refused_in_gnus_words() {
        let opened = |options: serde_json::Value| {
            let mut config = serde_json::json!({
                "to": "si", "from": "none", "suffix": "", "operands": [],
            });
            config
                .as_object_mut()
                .unwrap()
                .extend(options.as_object().unwrap().clone());
            super::open(config.to_string().as_bytes())
                .err()
                .map(|err| err.message)
        };
        let hint = "\nTry 'numfmt --help' for more information.";
        for (options, expected) in [
            (
                serde_json::json!({"fields": ["0"]}),
                format!("numfmt: fields are numbered from 1{hint}"),
            ),
            (
                serde_json::json!({"fields": ["3-2"]}),
                format!("numfmt: invalid decreasing range{hint}"),
            ),
            (
                serde_json::json!({"fields": ["1", "2"]}),
                "numfmt: multiple field specifications".to_owned(),
            ),
            (
                serde_json::json!({"delimiters": ["ab", ","]}),
                "numfmt: the delimiter must be a single character".to_owned(),
            ),
            (
                serde_json::json!({"headers": ["0"]}),
                "numfmt: invalid header value '0'".to_owned(),
            ),
            (
                serde_json::json!({"headers": ["-1"]}),
                "numfmt: invalid header value '-1'".to_owned(),
            ),
        ] {
            assert_eq!(opened(options).as_deref(), Some(expected.as_str()));
        }
        assert_eq!(
            opened(serde_json::json!({"headers": [" 1"], "delimiters": [""]})),
            None
        );
    }

    #[test]
    fn a_record_split_over_many_feeds_is_searched_once() {
        let config = r#"{"to":"si","from":"none","suffix":"","operands":[]}"#;
        let mut stream = super::open(config.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed(b"1000", &mut out).unwrap();
        for _ in 0..1000 {
            stream.feed(b" xxxxxxxx", &mut out).unwrap();
        }
        stream.feed(b"\n2000\n", &mut out).unwrap();
        assert!(out.starts_with(b"1.0k xxxxxxxx") && out.ends_with(b"xxxxxxxx\n2.0k\n"));
        assert_eq!(out.len(), 4 + 9 * 1000 + 1 + 5);
    }

    #[test]
    fn a_long_suffix_on_many_records_comes_out_a_window_at_a_time() {
        let suffix = "B".repeat(super::OUTPUT);
        let operands: Vec<String> = (0..8).map(|i| i.to_string()).collect();
        for operands in [operands, Vec::new()] {
            let config = serde_json::json!({
                "to": "none", "from": "none", "suffix": suffix, "operands": operands,
            });
            let mut stream = super::open(config.to_string().as_bytes()).unwrap();
            let mut total = Vec::new();
            let mut window = |stream: &mut Box<dyn crate::Stream>, out: &mut Vec<u8>| loop {
                assert!(out.len() <= 2 * super::OUTPUT);
                total.append(out);
                if !stream.busy() {
                    break;
                }
                stream.drain(out).unwrap();
            };
            let mut out = Vec::new();
            stream.feed(b"0\n1\n2\n3\n4\n5\n6\n7\n", &mut out).unwrap();
            window(&mut stream, &mut out);
            stream.finish(&mut out).unwrap();
            window(&mut stream, &mut out);
            let expected: String = (0..8).map(|i| format!("{i}{suffix}\n")).collect();
            assert_eq!(total, expected.as_bytes());
        }
    }
}
