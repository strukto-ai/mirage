use num_bigint::BigUint;
use num_traits::Zero;
use serde::Deserialize;

use crate::cut::{Interval, Mode, intervals};
use crate::{Stream, StreamError, latin1, latin1_list, parse_config, quoted};

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Scale {
    None,
    Si,
    Iec,
    IecI,
    Auto,
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

/// `numerator / denominator` rounded away from zero.
fn ceil(numerator: &BigUint, denominator: &BigUint) -> BigUint {
    let kept = numerator / denominator;
    if &kept * denominator == *numerator {
        kept
    } else {
        kept + 1_u8
    }
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

/// A value as GNU numfmt prints it under `--to`. `none` keeps the decimals
/// it was typed with and a scaled one is a whole number, rounded away from
/// zero, in fixed notation (`1Y` is twenty-five digits). A scale divides
/// while it can, rounds away from zero keeping one decimal below 10, which
/// can carry it back over the base (999.4 is 1.0k), and prints through
/// printf, rounding half to even. GNU reads into a long double, so a value
/// it cannot hold exactly may round up on the way out (`1.10` prints as
/// `1.11`); mirage keeps the value exact, as printf does.
fn format(value: &Value, to: Scale, out: &mut Vec<u8>) {
    let Value {
        negative,
        numerator,
        denominator,
        decimals,
    } = value;
    if to == Scale::None {
        let scaled = ceil(&(numerator * pow(10, *decimals)), denominator);
        return fixed(*negative, &scaled, *decimals, out);
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
    let places = usize::from(*numerator < &ten * &denominator);
    let mut numerator = ceil(&(numerator * pow(10, places)), &denominator);
    let mut denominator = pow(10, places);
    if numerator >= &base * &denominator && power < top {
        denominator *= &base;
        power += 1;
    }
    let places = usize::from(power > 0 && numerator < &ten * &denominator);
    numerator *= pow(10, places);
    fixed(*negative, &half_even(&numerator, &denominator), places, out);
    out.extend_from_slice(units[power].as_bytes());
    if to == Scale::IecI && power > 0 {
        out.push(b'i');
    }
}

struct Numfmt {
    config: Config,
    fields: Vec<Interval>,
    delimiter: Option<u8>,
    header: u64,
    separator: u8,
    held: Vec<u8>,
    /// How much of `held` is known to hold no separator.
    scanned: usize,
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
        failed: false,
    }))
}

impl Numfmt {
    /// One field with `--suffix` cut off its end when there and written
    /// back after the number either way.
    fn field(&self, value: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let suffix = &self.config.suffix;
        let value = value.strip_suffix(suffix.as_slice()).unwrap_or(value);
        format(&parse(value, self.config.from)?, self.config.to, out);
        out.extend_from_slice(suffix);
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
    fn record(&self, line: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
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

    fn checked(&mut self, result: Result<(), StreamError>) -> Result<(), StreamError> {
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
        let held = std::mem::take(&mut self.held);
        let mut start = 0;
        let mut from = self.scanned;
        let mut result = Ok(());
        while let Some(at) = memchr::memchr(self.separator, &held[from..]) {
            result = self.line(&held[start..from + at], true, out);
            start = from + at + 1;
            from = start;
            if result.is_err() {
                break;
            }
        }
        self.held = held;
        self.held.drain(..start);
        self.scanned = self.held.len();
        self.checked(result)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.failed {
            return Ok(());
        }
        let result = if self.config.operands.is_empty() {
            let held = std::mem::take(&mut self.held);
            if held.is_empty() {
                Ok(())
            } else {
                self.line(&held, false, out)
            }
        } else {
            self.config.operands.iter().try_for_each(|value| {
                self.record(value, out)?;
                out.push(self.separator);
                Ok(())
            })
        };
        self.checked(result)
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
}
