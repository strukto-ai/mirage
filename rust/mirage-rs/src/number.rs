//! Numbers as C's `strtol` family and GNU's option readers take them from a
//! typed word, written from POSIX and the GNU manuals and pinned against
//! `debian:stable-slim`: one place for the grammar every command's value
//! shares, each command keeping the clauses it refuses with.

/// What C's `isspace` takes in the C locale, which `strtol` skips first.
pub(crate) const BLANKS: &[u8] = b" \t\n\x0b\x0c\r";

/// `strerror(ERANGE)`, the clause a value below its least takes.
pub(crate) const ERANGE: &str = "Numerical result out of range";

/// `strerror(EOVERFLOW)`, the clause a value past its type takes.
pub(crate) const EOVERFLOW: &str = "Value too large for defined data type";

/// The size letters GNU's byte counts take (coreutils 9.7): every power
/// letter in upper case, `k` and `m` in lower case, and `b`.
pub(crate) const SIZE_LETTERS: &[u8] = b"bkKmMEGPQRTYZ";
const POWERS: &[u8] = b"KMGTPEZYRQ";

/// A typed number as `strtol` splits it: blanks skipped, at most one
/// sign, the radix a base-0 prefix names, the run of that radix's digits,
/// and what follows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Parts<'a> {
    pub(crate) sign: Option<u8>,
    pub(crate) radix: u32,
    pub(crate) digits: &'a [u8],
    pub(crate) rest: &'a [u8],
}

impl Parts<'_> {
    pub(crate) fn negative(&self) -> bool {
        self.sign == Some(b'-')
    }

    /// Whether the word held a number and nothing after it.
    pub(crate) fn whole(&self) -> bool {
        !self.digits.is_empty() && self.rest.is_empty()
    }

    /// The digits' magnitude, or None past `u128`.
    pub(crate) fn value(&self) -> Option<u128> {
        self.digits.iter().try_fold(0u128, |n, &b| {
            n.checked_mul(u128::from(self.radix))?
                .checked_add(u128::from(char::from(b).to_digit(self.radix)?))
        })
    }

    /// The digits' magnitude, a value past `u128` saturating.
    pub(crate) fn saturating(&self) -> u128 {
        self.value().unwrap_or(u128::MAX)
    }
}

/// Split `raw` as `strtol` reads it: decimal, or C's base 0 (a `0x` with a
/// hex digit after it is hexadecimal, any other leading `0` octal).
pub(crate) fn parts(raw: &[u8], base0: bool) -> Parts<'_> {
    let start = raw
        .iter()
        .position(|b| !BLANKS.contains(b))
        .unwrap_or(raw.len());
    let (sign, unsigned) = match &raw[start..] {
        [sign @ (b'+' | b'-'), rest @ ..] => (Some(*sign), rest),
        rest => (None, rest),
    };
    let (radix, body) = match unsigned {
        [b'0', b'x' | b'X', next, ..] if base0 && next.is_ascii_hexdigit() => (16, &unsigned[2..]),
        [b'0', ..] if base0 => (8, unsigned),
        _ => (10, unsigned),
    };
    let len = body
        .iter()
        .position(|&b| !char::from(b).is_digit(radix))
        .unwrap_or(body.len());
    Parts {
        sign,
        radix,
        digits: &body[..len],
        rest: &body[len..],
    }
}

/// A whole signed decimal word, blanks first, its magnitude saturating
/// past `u128`; None for anything else.
pub(crate) fn decimal(raw: &[u8]) -> Option<(bool, u128)> {
    let parts = parts(raw, false);
    parts
        .whole()
        .then(|| (parts.negative(), parts.saturating()))
}

/// A whole decimal word with no minus, as GNU's unsigned counts read one.
pub(crate) fn unsigned_decimal(raw: &[u8]) -> Option<u128> {
    decimal(raw).and_then(|(negative, value)| (!negative).then_some(value))
}

/// A whole signed decimal word, its magnitude saturating past `i128`.
pub(crate) fn signed_decimal(raw: &[u8]) -> Option<i128> {
    let (negative, value) = decimal(raw)?;
    let value = i128::try_from(value).unwrap_or(i128::MAX);
    Some(if negative { -value } else { value })
}

/// `strtol(raw, &end, 0)` as glibc reads it: 0 and the whole word when no
/// number leads it, a value past `long` saturating, and the word past the
/// number.
pub(crate) fn strtol(raw: &[u8]) -> (i64, &[u8]) {
    long(parts(raw, true), raw)
}

/// C's `atoi`: the decimal number the word begins with, 0 when none does,
/// saturated to `long` as glibc's `strtol` beneath it is.
pub(crate) fn atoi(raw: &[u8]) -> i64 {
    long(parts(raw, false), raw).0
}

fn long<'a>(parts: Parts<'a>, raw: &'a [u8]) -> (i64, &'a [u8]) {
    if parts.digits.is_empty() {
        return (0, raw);
    }
    let magnitude = i128::try_from(parts.saturating()).unwrap_or(i128::MAX);
    let value = if parts.negative() {
        -magnitude
    } else {
        magnitude
    };
    let value = value.clamp(i128::from(i64::MIN), i128::from(i64::MAX));
    (value as i64, parts.rest)
}

/// The multiplier a byte count's size suffix stands for.
/// `letters` is the command's own set, as `SIZE_LETTERS` is split's.
pub(crate) fn unit(suffix: &[u8], letters: &[u8]) -> Option<u128> {
    let (&letter, tail) = suffix.split_first()?;
    if !letters.contains(&letter) {
        return None;
    }
    if letter == b'b' {
        return tail.is_empty().then_some(512);
    }
    let power = POWERS
        .iter()
        .position(|&p| p == letter.to_ascii_uppercase())?
        + 1;
    let base: u128 = match tail {
        b"" | b"iB" => 1024,
        b"B" => 1000,
        _ => return None,
    };
    Some(base.pow(power as u32))
}

#[cfg(test)]
mod tests {
    use super::{SIZE_LETTERS, atoi, decimal, parts, strtol, unit, unsigned_decimal};

    #[test]
    fn base_zero_reads_hex_octal_and_decimal() {
        let hex = parts(b" 0x1f", true);
        assert_eq!((hex.radix, hex.value()), (16, Some(31)));
        let octal = parts(b"017", true);
        assert_eq!((octal.radix, octal.value()), (8, Some(15)));
        assert_eq!(parts(b"19", true).value(), Some(19));
    }

    #[test]
    fn a_0x_without_a_hex_digit_is_octal_zero() {
        let read = parts(b"0xg", true);
        assert_eq!(
            (read.radix, read.digits, read.rest),
            (8, &b"0"[..], &b"xg"[..])
        );
    }

    #[test]
    fn the_digit_run_stops_at_the_first_other_byte() {
        let read = parts(b"\t-12k", false);
        assert_eq!(read.sign, Some(b'-'));
        assert_eq!((read.digits, read.rest), (&b"12"[..], &b"k"[..]));
        assert!(!read.whole());
    }

    #[test]
    fn decimal_takes_a_whole_signed_word_and_saturates() {
        assert_eq!(decimal(b" +7"), Some((false, 7)));
        assert_eq!(decimal(b"-3"), Some((true, 3)));
        assert_eq!(decimal(b"3 "), None);
        assert_eq!(decimal(b""), None);
        assert_eq!(decimal(&[b'9'; 60]), Some((false, u128::MAX)));
    }

    #[test]
    fn a_value_past_u128_is_none_until_saturated() {
        let read = parts(&[b'9'; 60], false);
        assert_eq!((read.value(), read.saturating()), (None, u128::MAX));
    }

    #[test]
    fn size_units_take_iec_and_si_forms() {
        assert_eq!(unit(b"b", SIZE_LETTERS), Some(512));
        assert_eq!(unit(b"K", SIZE_LETTERS), Some(1024));
        assert_eq!(unit(b"kB", SIZE_LETTERS), Some(1000));
        assert_eq!(unit(b"MiB", SIZE_LETTERS), Some(1024 * 1024));
        assert_eq!(unit(b"bB", SIZE_LETTERS), None);
        assert_eq!(unit(b"x", SIZE_LETTERS), None);
    }

    #[test]
    fn strtol_reads_a_leading_number_and_saturates() {
        assert_eq!(strtol(b" 0x10z"), (16, &b"z"[..]));
        assert_eq!(strtol(b"x"), (0, &b"x"[..]));
        assert_eq!(strtol(&[b'9'; 30]).0, i64::MAX);
        assert_eq!(strtol(b"-99999999999999999999").0, i64::MIN);
    }

    #[test]
    fn atoi_reads_decimal_only() {
        assert_eq!(atoi(b"012x"), 12);
        assert_eq!(atoi(b"0x10"), 0);
        assert_eq!(atoi(b"z"), 0);
    }

    #[test]
    fn unsigned_decimal_refuses_a_minus() {
        assert_eq!(unsigned_decimal(b"-0"), None);
        assert_eq!(unsigned_decimal(b"+5"), Some(5));
    }
}
