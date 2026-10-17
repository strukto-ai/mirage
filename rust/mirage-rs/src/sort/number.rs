use std::cmp::Ordering;

use super::key::is_blank;

/// A C-locale `-n` number at the front of a field, exact however long:
/// optional blanks, an optional `-`, digits, an optional fraction. Zero is
/// never negative and leading and trailing zeroes do not count.
#[derive(PartialEq, Eq)]
pub(crate) struct Number<'a> {
    negative: bool,
    integer: &'a [u8],
    fraction: &'a [u8],
}

impl Ord for Number<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        if self.negative != other.negative {
            return if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        // Both integer parts are free of leading zeros, so the longer is
        // the larger.
        let order = (self.integer.len().cmp(&other.integer.len()))
            .then_with(|| self.integer.cmp(other.integer))
            .then_with(|| self.fraction.cmp(other.fraction));
        if self.negative {
            order.reverse()
        } else {
            order
        }
    }
}

impl PartialOrd for Number<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn skip_blanks(field: &[u8]) -> usize {
    field
        .iter()
        .position(|&byte| !is_blank(byte))
        .unwrap_or(field.len())
}

fn digit_run(field: &[u8], from: usize) -> usize {
    field[from..]
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .map_or(field.len(), |at| from + at)
}

pub(crate) fn leading_number(field: &[u8]) -> Number<'_> {
    let mut at = skip_blanks(field);
    let minus = field.get(at) == Some(&b'-');
    if minus {
        at += 1;
    }
    let end = digit_run(field, at);
    let mut integer = &field[at..end];
    integer = &integer[integer
        .iter()
        .position(|&d| d != b'0')
        .unwrap_or(integer.len())..];
    let mut fraction: &[u8] = &[];
    if field.get(end) == Some(&b'.') {
        let stop = digit_run(field, end + 1);
        fraction = &field[end + 1..stop];
        fraction = &fraction[..fraction
            .iter()
            .rposition(|&d| d != b'0')
            .map_or(0, |at| at + 1)];
    }
    Number {
        negative: minus && !(integer.is_empty() && fraction.is_empty()),
        integer,
        fraction,
    }
}

/// `-h`'s key: the unit's order (negated for a
/// negative number, 0 without a nonzero digit) and then the number. The
/// unit is the byte after the run of digits and points.
pub(crate) fn human_order(field: &[u8]) -> (i32, Number<'_>) {
    let mut at = skip_blanks(field);
    let minus = field.get(at) == Some(&b'-');
    if minus {
        at += 1;
    }
    let mut end = at;
    while end < field.len() && (field[end].is_ascii_digit() || field[end] == b'.') {
        end += 1;
    }
    let nonzero = field[at..end]
        .iter()
        .any(|&byte| (b'1'..=b'9').contains(&byte));
    let order = match field.get(end) {
        Some(b'K' | b'k') => 1,
        Some(b'M') => 2,
        Some(b'G') => 3,
        Some(b'T') => 4,
        Some(b'P') => 5,
        Some(b'E') => 6,
        Some(b'Z') => 7,
        Some(b'Y') => 8,
        Some(b'R') => 9,
        Some(b'Q') => 10,
        _ => 0,
    };
    let order = if nonzero { order } else { 0 };
    (if minus { -order } else { order }, leading_number(field))
}

/// `-g`: what strtod reads at the front of the field. A field with no
/// number sorts first, then NaN, then the numbers by value, -0 equal to 0.
/// Two NaNs order by sign, `-nan` first, as GNU sort 9.7 does.
pub(crate) fn general_order(a: &[u8], b: &[u8]) -> Ordering {
    match (strtod(a), strtod(b)) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(x), Some(y)) => match (x.is_nan(), y.is_nan()) {
            (true, true) => y.is_sign_negative().cmp(&x.is_sign_negative()),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        },
    }
}

fn ascii_prefix(field: &[u8], at: usize, word: &[u8]) -> bool {
    field.len() >= at + word.len() && field[at..at + word.len()].eq_ignore_ascii_case(word)
}

/// The double C's strtod reads at the front of `field` in the C locale,
/// or `None` when no number starts there: blanks (isspace), a sign, then a
/// hex float, a decimal float, inf or infinity, or nan with an optional
/// `(chars)` tag.
pub(crate) fn strtod(field: &[u8]) -> Option<f64> {
    let mut at = field
        .iter()
        .position(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | 0x0B | 0x0C | b'\r'))
        .unwrap_or(field.len());
    let negative = match field.get(at) {
        Some(b'-') => {
            at += 1;
            true
        }
        Some(b'+') => {
            at += 1;
            false
        }
        _ => false,
    };
    let value = hex_float(field, at)
        .or_else(|| decimal_float(field, at))
        .or_else(|| {
            if ascii_prefix(field, at, b"inf") {
                Some(f64::INFINITY)
            } else if ascii_prefix(field, at, b"nan") {
                Some(f64::NAN)
            } else {
                None
            }
        })?;
    Some(if negative { -value } else { value })
}

fn decimal_float(field: &[u8], at: usize) -> Option<f64> {
    let whole_end = digit_run(field, at);
    let mut end = whole_end;
    if field.get(end) == Some(&b'.') {
        end = digit_run(field, end + 1);
    }
    let mantissa_digits = (whole_end - at) + end.saturating_sub(whole_end + 1);
    if mantissa_digits == 0 {
        return None;
    }
    if matches!(field.get(end), Some(b'e' | b'E')) {
        let mut exp = end + 1;
        if matches!(field.get(exp), Some(b'+' | b'-')) {
            exp += 1;
        }
        let stop = digit_run(field, exp);
        if stop > exp {
            end = stop;
        }
    }
    std::str::from_utf8(&field[at..end])
        .ok()?
        .parse::<f64>()
        .ok()
}

fn hex_digit(byte: u8) -> Option<u64> {
    (byte as char).to_digit(16).map(u64::from)
}

/// `0x` hex digits with an optional fraction and `p` exponent, rounded once
/// to the nearest double, ties to even.
fn hex_float(field: &[u8], at: usize) -> Option<f64> {
    if !(field.get(at) == Some(&b'0') && matches!(field.get(at + 1), Some(b'x' | b'X'))) {
        return None;
    }
    let mut i = at + 2;
    let mut mantissa: u64 = 0;
    let mut sticky = false;
    let mut exponent: i64 = 0;
    let mut seen = false;
    let mut point = false;
    while i < field.len() {
        let byte = field[i];
        if byte == b'.' && !point {
            point = true;
            i += 1;
            continue;
        }
        let Some(digit) = hex_digit(byte) else { break };
        seen = true;
        if mantissa >> 60 == 0 {
            mantissa = (mantissa << 4) | digit;
            if point {
                exponent -= 4;
            }
        } else {
            sticky |= digit != 0;
            if !point {
                exponent += 4;
            }
        }
        i += 1;
    }
    if !seen {
        return None;
    }
    if matches!(field.get(i), Some(b'p' | b'P')) {
        let mut j = i + 1;
        let negative = field.get(j) == Some(&b'-');
        if matches!(field.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let stop = digit_run(field, j);
        if stop > j {
            let mut power: i64 = 0;
            for &d in &field[j..stop] {
                power = (power * 10 + i64::from(d - b'0')).min(1 << 40);
            }
            exponent += if negative { -power } else { power };
        }
    }
    Some(scale(mantissa, sticky, exponent))
}

/// `mantissa * 2^exponent` (plus a sticky bit below it) as the nearest
/// double, ties to even, overflowing to infinity and through subnormals.
fn scale(mantissa: u64, sticky: bool, exponent: i64) -> f64 {
    if mantissa == 0 {
        return 0.0;
    }
    let width = 64 - i64::from(mantissa.leading_zeros());
    let top = width - 1 + exponent;
    if top > 1023 {
        return f64::INFINITY;
    }
    let lowest = if top < -1022 { -1074 } else { top - 52 };
    let shift = lowest - exponent;
    let (mut kept, round, rest) = if shift <= 0 {
        (mantissa << (-shift).min(63), false, false)
    } else if shift > 64 {
        (0, false, true)
    } else if shift == 64 {
        (0, mantissa >> 63 != 0, mantissa << 1 != 0)
    } else {
        let kept = mantissa >> shift;
        let round = (mantissa >> (shift - 1)) & 1 != 0;
        let rest = mantissa & ((1u64 << (shift - 1)) - 1) != 0;
        (kept, round, rest)
    };
    if round && (rest || sticky || kept & 1 != 0) {
        kept += 1;
    }
    let value = ldexp(kept as f64, lowest);
    if value.is_finite() {
        value
    } else {
        f64::INFINITY
    }
}

/// `x * 2^exp` in steps that stay inside the double's range, so a
/// subnormal power of two is not lost on the way.
fn ldexp(mut x: f64, mut exp: i64) -> f64 {
    while exp > 1000 {
        x *= 2f64.powi(1000);
        exp -= 1000;
    }
    while exp < -1000 {
        x *= 2f64.powi(-1000);
        exp += 1000;
    }
    x * 2f64.powi(exp as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_numbers_like_strtod() {
        assert_eq!(strtod(b"  3.5e2x"), Some(350.0));
        assert_eq!(strtod(b"-0x1.8p3"), Some(-12.0));
        assert_eq!(strtod(b"0x"), Some(0.0));
        assert_eq!(strtod(b"Infinity"), Some(f64::INFINITY));
        assert!(strtod(b"nan(abc)").is_some_and(f64::is_nan));
        assert_eq!(strtod(b"."), None);
        assert_eq!(strtod(b"abc"), None);
        assert_eq!(strtod(b"0x1p-1074"), Some(f64::from_bits(1)));
        assert_eq!(strtod(b"0x1p1024"), Some(f64::INFINITY));
        assert_eq!(strtod(b"0x1.fffffffffffff8p0"), Some(2.0));
    }

    #[test]
    fn orders_numbers_exactly() {
        let order = |a: &[u8], b: &[u8]| leading_number(a).cmp(&leading_number(b));
        assert_eq!(order(b"10", b"9"), Ordering::Greater);
        assert_eq!(order(b"-1", b"-2"), Ordering::Greater);
        assert_eq!(order(b"-0", b"0"), Ordering::Equal);
        assert_eq!(order(b"1.50", b"1.5"), Ordering::Equal);
        assert_eq!(order(b" 007", b"7x"), Ordering::Equal);
        assert_eq!(
            order(b"100000000000000000001", b"100000000000000000000"),
            Ordering::Greater
        );
        assert_eq!(
            human_order(b"1K").0.cmp(&human_order(b"1500").0),
            Ordering::Greater
        );
    }
}
