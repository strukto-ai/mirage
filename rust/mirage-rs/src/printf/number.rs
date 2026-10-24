use num_bigint::BigUint;
use num_traits::{One, ToPrimitive, Zero};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub prefix: Vec<u8>,
    pub body: Vec<u8>,
    pub zero_tail: u64,
    pub suffix: Vec<u8>,
    pub allow_zero: bool,
}

impl Rendered {
    fn finite(prefix: Vec<u8>, body: Vec<u8>, zero_tail: u64, suffix: Vec<u8>) -> Self {
        Self {
            prefix,
            body,
            zero_tail,
            suffix,
            allow_zero: true,
        }
    }

    pub fn byte_len(&self) -> u64 {
        self.zero_tail.saturating_add(
            self.prefix.len() as u64 + self.body.len() as u64 + self.suffix.len() as u64,
        )
    }
}

fn space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 11 | 12)
}

fn digit(byte: u8, base: u32) -> Option<u32> {
    let n = match byte {
        b'0'..=b'9' => u32::from(byte - b'0'),
        b'a'..=b'f' => u32::from(byte - b'a' + 10),
        b'A'..=b'F' => u32::from(byte - b'A' + 10),
        _ => return None,
    };
    (n < base).then_some(n)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum FloatKind {
    Decimal,
    Hex,
    Infinity,
    Nan,
}

/// One C-locale strtod number at the front of a word: `start` is where
/// its digits begin (past `0x` for a hex float) and `fraction` counts the
/// digits after its point.
pub(crate) struct FloatToken {
    pub(crate) kind: FloatKind,
    pub(crate) negative: bool,
    pub(crate) start: usize,
    pub(crate) mantissa_end: usize,
    pub(crate) end: usize,
    pub(crate) fraction: usize,
    pub(crate) exponent: i64,
}

fn case_prefix(raw: &[u8], word: &[u8]) -> bool {
    raw.get(..word.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(word))
}

fn exponent(raw: &[u8], marker: usize) -> (usize, i64) {
    let mut at = marker + 1;
    let negative = raw.get(at) == Some(&b'-');
    if matches!(raw.get(at), Some(b'+' | b'-')) {
        at += 1;
    }
    let start = at;
    let mut value = 0_i64;
    while let Some(b @ b'0'..=b'9') = raw.get(at) {
        value = (value * 10 + i64::from(b - b'0')).min(1_000_000_000);
        at += 1;
    }
    if at == start {
        return (marker, 0);
    }
    (at, if negative { -value } else { value })
}

pub(crate) fn scan_float(raw: &[u8]) -> Option<FloatToken> {
    let mut at = 0;
    while raw.get(at).copied().is_some_and(space) {
        at += 1;
    }
    let negative = raw.get(at) == Some(&b'-');
    if matches!(raw.get(at), Some(b'+' | b'-')) {
        at += 1;
    }
    let start = at;
    if case_prefix(&raw[at..], b"inf") {
        let end = at
            + if case_prefix(&raw[at..], b"infinity") {
                8
            } else {
                3
            };
        return Some(FloatToken {
            kind: FloatKind::Infinity,
            negative,
            start,
            mantissa_end: end,
            end,
            fraction: 0,
            exponent: 0,
        });
    }
    if case_prefix(&raw[at..], b"nan") {
        let mut end = at + 3;
        if raw.get(end) == Some(&b'(') {
            let mut close = end + 1;
            while raw
                .get(close)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            {
                close += 1;
            }
            if raw.get(close) == Some(&b')') {
                end = close + 1;
            }
        }
        return Some(FloatToken {
            kind: FloatKind::Nan,
            negative,
            start,
            mantissa_end: end,
            end,
            fraction: 0,
            exponent: 0,
        });
    }
    let hex = raw.get(at) == Some(&b'0') && matches!(raw.get(at + 1), Some(b'x' | b'X'));
    if hex {
        let mut end = at + 2;
        let digits_start = end;
        while raw.get(end).copied().and_then(|b| digit(b, 16)).is_some() {
            end += 1;
        }
        let whole = end - digits_start;
        let mut fraction = 0;
        if raw.get(end) == Some(&b'.') {
            end += 1;
            let frac_start = end;
            while raw.get(end).copied().and_then(|b| digit(b, 16)).is_some() {
                end += 1;
            }
            fraction = end - frac_start;
        }
        if whole + fraction != 0 {
            let mantissa_end = end;
            let (end, exponent) = if matches!(raw.get(end), Some(b'p' | b'P')) {
                exponent(raw, end)
            } else {
                (end, 0)
            };
            return Some(FloatToken {
                kind: FloatKind::Hex,
                negative,
                start: at + 2,
                mantissa_end,
                end,
                fraction,
                exponent,
            });
        }
    }
    while raw.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    let whole = at - start;
    let mut fraction = 0;
    if raw.get(at) == Some(&b'.') {
        at += 1;
        let frac_start = at;
        while raw.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        fraction = at - frac_start;
    }
    if whole + fraction == 0 {
        return None;
    }
    let mantissa_end = at;
    let (end, exponent) = if matches!(raw.get(at), Some(b'e' | b'E')) {
        exponent(raw, at)
    } else {
        (at, 0)
    };
    Some(FloatToken {
        kind: FloatKind::Decimal,
        negative,
        start,
        mantissa_end,
        end,
        fraction,
        exponent,
    })
}

struct Significant {
    kept: Vec<u8>,
    count: usize,
    trailing_zeroes: usize,
    dropped_nonzero: bool,
}

fn significant(raw: &[u8], token: &FloatToken, limit: usize) -> Significant {
    let mut kept = Vec::with_capacity(limit);
    let mut count = 0;
    let mut trailing_zeroes = 0;
    let mut dropped_nonzero = false;
    for &b in &raw[token.start..token.mantissa_end] {
        if b == b'.' || count == 0 && b == b'0' {
            continue;
        }
        count += 1;
        trailing_zeroes = if b == b'0' { trailing_zeroes + 1 } else { 0 };
        if kept.len() < limit {
            kept.push(b);
        } else if b != b'0' {
            dropped_nonzero = true;
        }
    }
    Significant {
        kept,
        count,
        trailing_zeroes,
        dropped_nonzero,
    }
}

fn rounded_shift(n: &BigUint, shift: usize, sticky: bool) -> BigUint {
    if shift == 0 {
        return n.clone();
    }
    let mut kept = n >> shift;
    let rest = n - (&kept << shift);
    let half = BigUint::one() << (shift - 1);
    if rest > half || rest == half && (sticky || kept.bit(0)) {
        kept += 1_u8;
    }
    kept
}

fn hex_double(raw: &[u8], token: &FloatToken) -> f64 {
    let digits = significant(raw, token, 32);
    if digits.count == 0 {
        return 0.0;
    }
    let n = BigUint::parse_bytes(&digits.kept, 16).unwrap();
    let e =
        token.exponent - 4 * token.fraction as i64 + 4 * (digits.count - digits.kept.len()) as i64;
    let bits = n.bits() as i64;
    let top = bits - 1 + e;
    if top > 1023 {
        return f64::INFINITY;
    }
    if top < -1075 {
        return 0.0;
    }
    let scale = (e + bits - 53).max(-1074);
    let rounded = if scale > e {
        rounded_shift(&n, (scale - e) as usize, digits.dropped_nonzero)
    } else {
        n << (e - scale) as usize
    };
    let q = rounded.to_u64().unwrap();
    if q == 0 {
        return 0.0;
    }
    let qbits = i64::from(64 - q.leading_zeros());
    let top = scale + qbits - 1;
    if top > 1023 {
        return f64::INFINITY;
    }
    if top < -1022 {
        return f64::from_bits(q << (scale + 1074) as u32);
    }
    let significand = if qbits > 53 {
        q >> (qbits - 53) as u32
    } else {
        q << (53 - qbits) as u32
    };
    f64::from_bits(((top + 1023) as u64) << 52 | (significand & ((1_u64 << 52) - 1)))
}

fn decimal_double(raw: &[u8], token: &FloatToken) -> f64 {
    let digits = significant(raw, token, 1200);
    if digits.count == 0 {
        return 0.0;
    }
    let scale = token.exponent - token.fraction as i64 + digits.count as i64;
    if scale > 310 {
        return f64::INFINITY;
    }
    if scale < -325 {
        return 0.0;
    }
    let mut value = digits.kept;
    if digits.dropped_nonzero {
        value.push(b'1');
    }
    let e = scale - value.len() as i64;
    value.push(b'e');
    value.extend_from_slice(e.to_string().as_bytes());
    std::str::from_utf8(&value).unwrap().parse().unwrap()
}

fn long_double_erange(raw: &[u8], token: &FloatToken) -> bool {
    let (significand, exponent, base, dropped) = match token.kind {
        FloatKind::Hex => {
            let digits = significant(raw, token, 32);
            if digits.count == 0 {
                return false;
            }
            let e = token.exponent - 4 * token.fraction as i64;
            let lead = 32 - digit(digits.kept[0], 16).unwrap().leading_zeros();
            let top = 4 * digits.count as i64 - 5 + i64::from(lead) + e;
            if (-16382..16383).contains(&top) {
                return false;
            }
            if !(-16495..16384).contains(&top) {
                return true;
            }
            (
                BigUint::parse_bytes(&digits.kept, 16).unwrap(),
                e + 4 * (digits.count - digits.kept.len()) as i64,
                2_u32,
                digits.dropped_nonzero,
            )
        }
        FloatKind::Decimal => {
            let mut digits = significant(raw, token, 12000);
            if digits.count == 0 {
                return false;
            }
            let scale = token.exponent - token.fraction as i64 + digits.count as i64;
            if (-4930..=4932).contains(&scale) {
                return false;
            }
            if scale >= 4934 || scale <= -4966 {
                return true;
            }
            let trimmed = digits.count - digits.trailing_zeroes;
            digits.kept.truncate(trimmed.min(12000));
            let n = BigUint::parse_bytes(&digits.kept, 10).unwrap();
            (
                n,
                scale - digits.kept.len() as i64,
                10_u32,
                trimmed > digits.kept.len(),
            )
        }
        FloatKind::Infinity | FloatKind::Nan => return false,
    };
    let power = BigUint::from(base).pow(exponent.unsigned_abs() as u32);
    let (num, den) = if exponent >= 0 {
        (significand * power, BigUint::one())
    } else {
        (significand, power)
    };
    let overflow = ((BigUint::one() << 114) - 1_u8) << 16270;
    if num >= overflow * &den {
        return true;
    }
    (&num << 16382) < den && (dropped || (&num << 16494) % den != BigUint::zero())
}

/// Read the longest C-locale strtod prefix and binary128 strtold range status.
pub fn parse_float(raw: &[u8]) -> (f64, usize, bool) {
    let Some(token) = scan_float(raw) else {
        return (0.0, 0, false);
    };
    let value = match token.kind {
        FloatKind::Decimal => decimal_double(raw, &token),
        FloatKind::Hex => hex_double(raw, &token),
        FloatKind::Infinity => f64::INFINITY,
        FloatKind::Nan => f64::NAN,
    };
    (
        if token.negative { -value } else { value },
        token.end,
        long_double_erange(raw, &token),
    )
}

fn flag(flags: &[u8], value: u8) -> bool {
    flags.contains(&value)
}

fn sign(negative: bool, flags: &[u8]) -> Vec<u8> {
    if negative {
        vec![b'-']
    } else if flag(flags, b'+') {
        vec![b'+']
    } else if flag(flags, b' ') {
        vec![b' ']
    } else {
        Vec::new()
    }
}

pub fn render_integer(value: i128, conv: u8, flags: &[u8], precision: Option<u64>) -> Rendered {
    let signed = matches!(conv, b'd' | b'i');
    let magnitude = value.unsigned_abs();
    let mut prefix = if signed && value < 0 {
        vec![b'-']
    } else if signed && flag(flags, b'+') {
        vec![b'+']
    } else if signed && flag(flags, b' ') {
        vec![b' ']
    } else {
        Vec::new()
    };
    let mut digits = match conv {
        b'o' => format!("{magnitude:o}").into_bytes(),
        b'x' => format!("{magnitude:x}").into_bytes(),
        b'X' => format!("{magnitude:X}").into_bytes(),
        _ => magnitude.to_string().into_bytes(),
    };
    if magnitude == 0 && precision == Some(0) {
        digits.clear();
    }
    let mut leading_zeroes = precision.unwrap_or(0).saturating_sub(digits.len() as u64);
    if flag(flags, b'#') {
        if magnitude != 0 && matches!(conv, b'x' | b'X') {
            prefix.extend_from_slice(if conv == b'X' { b"0X" } else { b"0x" });
        }
        if conv == b'o' && leading_zeroes == 0 && digits.first() != Some(&b'0') {
            leading_zeroes = 1;
        }
    }
    Rendered {
        prefix,
        body: Vec::new(),
        zero_tail: leading_zeroes,
        suffix: digits,
        allow_zero: precision.is_none(),
    }
}

/// A finite magnitude's decimal digits, the first of them at `10**point`.
pub(crate) struct Decimal {
    digits: Vec<u8>,
    point: i32,
}

impl Decimal {
    /// `units / 10**scale`, exactly.
    pub(crate) fn scaled(units: &BigUint, scale: usize) -> Self {
        let digits = units.to_str_radix(10).into_bytes();
        let point = if units.is_zero() {
            0
        } else {
            digits.len() as i32 - 1 - scale as i32
        };
        Self { digits, point }
    }

    // Past printf's 1100 places a double has no digit left, but an exact
    // value can, so the cap follows the digits.
    fn places_cap(&self) -> u64 {
        (self.digits.len() as i64 - 1 - i64::from(self.point)).max(1100) as u64
    }

    fn digits_cap(&self) -> u64 {
        (self.digits.len() as u64).max(1100)
    }
}

fn exact_decimal(value: f64) -> Decimal {
    let bits = value.to_bits();
    let field = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let (m, e) = if field == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1_u64 << 52), field - 1075)
    };
    if m == 0 {
        return Decimal {
            digits: vec![b'0'],
            point: 0,
        };
    }
    let k = (-e).max(0) as u32;
    let n = if e >= 0 {
        BigUint::from(m) << e as usize
    } else {
        BigUint::from(m) * BigUint::from(5_u8).pow(k)
    };
    let digits = n.to_str_radix(10).into_bytes();
    Decimal {
        point: digits.len() as i32 - 1 - k as i32,
        digits,
    }
}

fn increment(digits: &mut Vec<u8>) {
    for n in digits.iter_mut().rev() {
        if *n != b'9' {
            *n += 1;
            return;
        }
        *n = b'0';
    }
    digits.insert(0, b'1');
}

fn round_up(digits: &[u8], at: usize, previous: u8) -> bool {
    digits.get(at).is_some_and(|next| {
        *next > b'5'
            || *next == b'5'
                && (digits[at + 1..].iter().any(|b| *b != b'0') || (previous - b'0') % 2 == 1)
    })
}

fn rounded_significant(mut decimal: Decimal, count: usize) -> Decimal {
    if decimal.digits.len() > count {
        let up = round_up(&decimal.digits, count, decimal.digits[count - 1]);
        decimal.digits.truncate(count);
        if up {
            increment(&mut decimal.digits);
            if decimal.digits.len() > count {
                decimal.digits.truncate(count);
                decimal.point += 1;
            }
        }
    } else {
        decimal.digits.resize(count, b'0');
    }
    decimal
}

fn fixed_parts(decimal: Decimal) -> (Vec<u8>, Vec<u8>) {
    let point = decimal.point + 1;
    if point <= 0 {
        let mut fraction = vec![b'0'; (-point) as usize];
        fraction.extend_from_slice(&decimal.digits);
        (vec![b'0'], fraction)
    } else if point as usize >= decimal.digits.len() {
        let mut integer = decimal.digits;
        integer.resize(point as usize, b'0');
        (integer, Vec::new())
    } else {
        let mut integer = decimal.digits;
        let fraction = integer.split_off(point as usize);
        (integer, fraction)
    }
}

fn exponent_suffix(exponent: i32, upper: bool, hex: bool) -> Vec<u8> {
    let mut suffix = vec![
        if hex {
            if upper { b'P' } else { b'p' }
        } else if upper {
            b'E'
        } else {
            b'e'
        },
        if exponent < 0 { b'-' } else { b'+' },
    ];
    let digits = exponent.unsigned_abs().to_string();
    if !hex && digits.len() < 2 {
        suffix.push(b'0');
    }
    suffix.extend_from_slice(digits.as_bytes());
    suffix
}

fn render_fixed(negative: bool, decimal: Decimal, flags: &[u8], precision: u64) -> Rendered {
    let p = precision.min(decimal.places_cap()) as usize;
    let (mut integer, mut fraction) = fixed_parts(decimal);
    if fraction.len() > p {
        let previous = if p == 0 {
            *integer.last().unwrap()
        } else {
            fraction[p - 1]
        };
        let up = round_up(&fraction, p, previous);
        fraction.truncate(p);
        if up {
            integer.extend_from_slice(&fraction);
            increment(&mut integer);
            fraction = integer.split_off(integer.len() - p);
        }
    } else {
        fraction.resize(p, b'0');
    }
    if precision != 0 || flag(flags, b'#') {
        integer.push(b'.');
        integer.extend_from_slice(&fraction);
    }
    Rendered::finite(
        sign(negative, flags),
        integer,
        precision - p as u64,
        Vec::new(),
    )
}

fn render_exponential(
    negative: bool,
    decimal: Decimal,
    flags: &[u8],
    precision: u64,
    upper: bool,
) -> Rendered {
    let p = precision.min(decimal.digits_cap()) as usize;
    let decimal = rounded_significant(decimal, p + 1);
    let mut body = vec![decimal.digits[0]];
    if precision != 0 || flag(flags, b'#') {
        body.push(b'.');
        body.extend_from_slice(&decimal.digits[1..]);
    }
    Rendered::finite(
        sign(negative, flags),
        body,
        precision - p as u64,
        exponent_suffix(decimal.point, upper, false),
    )
}

fn trim_zeroes(digits: &mut Vec<u8>) {
    while digits.last() == Some(&b'0') {
        digits.pop();
    }
}

fn render_general(
    negative: bool,
    decimal: Decimal,
    flags: &[u8],
    precision: u64,
    upper: bool,
) -> Rendered {
    let p = precision.max(1);
    let count = p.min(decimal.digits_cap()) as usize;
    let mut decimal = rounded_significant(decimal, count);
    let alternate = flag(flags, b'#');
    if decimal.point < -4 || decimal.point >= 0 && decimal.point as u64 >= p {
        if !alternate {
            trim_zeroes(&mut decimal.digits);
        }
        let mut body = vec![decimal.digits[0]];
        if decimal.digits.len() > 1 || alternate {
            body.push(b'.');
            body.extend_from_slice(&decimal.digits[1..]);
        }
        return Rendered::finite(
            sign(negative, flags),
            body,
            if alternate { p - count as u64 } else { 0 },
            exponent_suffix(decimal.point, upper, false),
        );
    }
    let fraction_length =
        (p as i128 - 1 - i128::from(decimal.point)).min(i128::from(u64::MAX)) as u64;
    let (mut integer, mut fraction) = fixed_parts(decimal);
    let mut zero_tail = fraction_length.saturating_sub(fraction.len() as u64);
    if !alternate {
        trim_zeroes(&mut fraction);
        zero_tail = 0;
    }
    if !fraction.is_empty() || alternate {
        integer.push(b'.');
        integer.extend_from_slice(&fraction);
    }
    Rendered::finite(sign(negative, flags), integer, zero_tail, Vec::new())
}

/// A hex float as glibc's `%a` writes it: `mantissa` holds the lead digit
/// over `fraction_bits` bits (a multiple of four), and the digits round
/// half to even at the precision without renormalizing.
pub(crate) fn render_hex(
    negative: bool,
    mantissa: u128,
    fraction_bits: u32,
    exponent: i32,
    flags: &[u8],
    precision: Option<u64>,
    upper: bool,
) -> Rendered {
    let places = u64::from(fraction_bits / 4);
    let p = precision.unwrap_or(places).min(places) as u32;
    let drop = fraction_bits - p * 4;
    let mut kept = mantissa >> drop;
    if drop != 0 {
        let rest = mantissa & ((1_u128 << drop) - 1);
        let half = 1_u128 << (drop - 1);
        if rest > half || rest == half && kept % 2 == 1 {
            kept += 1;
        }
    }
    let lead = b'0' + (kept >> (p * 4)) as u8;
    let mask = (1_u128 << (p * 4)) - 1;
    let mut fractional = if p == 0 {
        Vec::new()
    } else {
        format!("{:0width$x}", kept & mask, width = p as usize).into_bytes()
    };
    if precision.is_none() {
        trim_zeroes(&mut fractional);
    }
    let zero_tail = precision.map_or(0, |n| n.saturating_sub(u64::from(p)));
    let mut prefix = sign(negative, flags);
    prefix.extend_from_slice(if upper { b"0X" } else { b"0x" });
    let mut body = vec![lead];
    if !fractional.is_empty() || zero_tail != 0 || flag(flags, b'#') {
        body.push(b'.');
        body.extend_from_slice(&fractional);
    }
    if upper {
        body.make_ascii_uppercase();
    }
    Rendered::finite(
        prefix,
        body,
        zero_tail,
        exponent_suffix(exponent, upper, true),
    )
}

fn double_hex(value: f64, flags: &[u8], precision: Option<u64>, upper: bool) -> Rendered {
    let bits = value.to_bits() & !(1_u64 << 63);
    let field = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let mut exponent = 0;
    let mut mantissa = 0;
    if bits != 0 {
        let (m, e) = if field == 0 {
            (fraction, -1074)
        } else {
            (fraction | (1_u64 << 52), field - 1075)
        };
        let significant_bits = 64 - m.leading_zeros();
        exponent = e + significant_bits as i32 - 1;
        mantissa = m << (53 - significant_bits);
    }
    render_hex(
        value.is_sign_negative(),
        u128::from(mantissa),
        52,
        exponent,
        flags,
        precision,
        upper,
    )
}

/// An infinity or a NaN, which takes a sign but never zero padding.
pub(crate) fn render_special(negative: bool, nan: bool, upper: bool, flags: &[u8]) -> Rendered {
    let body: &[u8] = match (nan, upper) {
        (true, true) => b"NAN",
        (true, false) => b"nan",
        (false, true) => b"INF",
        (false, false) => b"inf",
    };
    Rendered {
        prefix: sign(negative, flags),
        body: body.to_vec(),
        zero_tail: 0,
        suffix: Vec::new(),
        allow_zero: false,
    }
}

/// An exact finite value through `%e`, `%f` or `%g` (either case).
pub(crate) fn render_decimal(
    negative: bool,
    decimal: Decimal,
    conv: u8,
    flags: &[u8],
    precision: Option<u64>,
) -> Rendered {
    let upper = conv.is_ascii_uppercase();
    let precision = precision.unwrap_or(6);
    match conv.to_ascii_lowercase() {
        b'f' => render_fixed(negative, decimal, flags, precision),
        b'e' => render_exponential(negative, decimal, flags, precision, upper),
        _ => render_general(negative, decimal, flags, precision, upper),
    }
}

/// Render binary64 values with explicit signs, notation and ties-to-even rounding.
pub fn render_float(value: f64, conv: u8, flags: &[u8], precision: Option<u64>) -> Rendered {
    let upper = conv.is_ascii_uppercase();
    let negative = value.is_sign_negative();
    if !value.is_finite() {
        return render_special(negative, value.is_nan(), upper, flags);
    }
    match conv.to_ascii_lowercase() {
        b'a' => double_hex(value, flags, precision, upper),
        b'e' | b'f' | b'g' => {
            render_decimal(negative, exact_decimal(value), conv, flags, precision)
        }
        _ => unreachable!("float conversion was validated by the format scanner"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(rendered: Rendered) -> String {
        assert!(rendered.zero_tail < 10000);
        let mut bytes = rendered.prefix;
        bytes.extend(rendered.body);
        bytes.resize(bytes.len() + rendered.zero_tail as usize, b'0');
        bytes.extend(rendered.suffix);
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn float_longest_prefix_and_signed_zero() {
        assert_eq!(parse_float(b"  -0e+2junk"), (-0.0, 7, false));
        assert!(parse_float(b"-0").0.is_sign_negative());
        assert!(parse_float(b"-nan(tag)").0.is_sign_negative());
        assert_eq!(parse_float(b"0x.p2"), (0.0, 1, false));
        assert_eq!(parse_float(b"1e+"), (1.0, 1, false));
        assert_eq!(parse_float(b"NaN(a!b)").1, 3);
        assert_eq!(parse_float(b"infinite").1, 3);
    }

    #[test]
    fn hex_parse_rounds_ties_and_subnormals_once() {
        assert_eq!(
            parse_float(b"0x1.00000000000008p0").0.to_bits(),
            1.0_f64.to_bits()
        );
        assert_eq!(
            parse_float(b"0x1.0000000000000801p0").0.to_bits(),
            1.0_f64.to_bits() + 1
        );
        assert_eq!(
            parse_float(b"0x1.00000000000018p0").0.to_bits(),
            1.0_f64.to_bits() + 2
        );
        assert_eq!(parse_float(b"0x1p-1075").0.to_bits(), 0);
        assert_eq!(parse_float(b"0x1.00000000000001p-1075").0.to_bits(), 1);
        assert_eq!(parse_float(b"0x1.fffffffffffffp1023").0, f64::MAX);
        assert_eq!(parse_float(b"0x1.fffffffffffff8p1023").0, f64::INFINITY);
    }

    #[test]
    fn binary128_range_is_separate_from_binary64() {
        assert_eq!(parse_float(b"1e400"), (f64::INFINITY, 5, false));
        assert!(!parse_float(b"0x1p-16494").2);
        assert!(parse_float(b"0x1p-16495").2);
        assert!(!parse_float(b"0x1.ffffffffffffffffffffffffffffp16383").2);
        assert!(parse_float(b"0x1.ffffffffffffffffffffffffffff8p16383").2);
        assert!(parse_float(b"1e4933").2);
        assert!(parse_float(b"1e-4966").2);
        assert!(!parse_float(b"0e9999999999999999999").2);
    }

    #[test]
    fn float_rendering_obeys_ties_and_general_thresholds() {
        assert_eq!(text(render_float(2.5, b'f', b"", Some(0))), "2");
        assert_eq!(text(render_float(3.5, b'f', b"", Some(0))), "4");
        assert_eq!(text(render_float(9.999, b'e', b"", Some(2))), "1.00e+01");
        assert_eq!(text(render_float(9.999, b'g', b"", Some(3))), "10");
        assert_eq!(
            text(render_float(0.000099999, b'g', b"", Some(3))),
            "0.0001"
        );
        assert_eq!(text(render_float(1.25, b'g', b"#", Some(6))), "1.25000");
        assert_eq!(text(render_float(-0.0, b'f', b"+", Some(1))), "-0.0");
        assert_eq!(text(render_float(f64::NAN, b'f', b"+", Some(1))), "+nan");
        assert_eq!(text(render_float(-f64::NAN, b'G', b"+", None)), "-NAN");
    }

    #[test]
    fn hex_rounding_preserves_the_leading_carry() {
        assert_eq!(text(render_float(1.999, b'a', b"", Some(0))), "0x2p+0");
        assert_eq!(text(render_float(1.96875, b'a', b"", Some(1))), "0x2.0p+0");
        assert_eq!(text(render_float(1.90625, b'a', b"", Some(1))), "0x1.ep+0");
        assert_eq!(
            text(render_float(f64::from_bits(1), b'A', b"#", None)),
            "0X1.P-1074"
        );
        assert_eq!(text(render_float(0.0, b'a', b"", Some(2))), "0x0.00p+0");
    }

    #[test]
    fn huge_precisions_have_bounded_segments() {
        for conv in *b"fega" {
            let rendered = render_float(f64::from_bits(1), conv, b"#", Some(u64::MAX));
            assert!(rendered.body.len() < 1500);
            assert!(rendered.zero_tail > u64::MAX - 2000);
        }
        let rendered = render_integer(1, b'd', b"", Some(u64::MAX));
        assert_eq!(rendered.zero_tail, u64::MAX - 1);
    }
}
