use serde_json::{Value as Json, json};

use crate::StreamError;
use crate::number::{self, BLANKS};

const UNITS: &[u8] = b"KMGTPEZY";

pub(crate) fn parse(
    raw: &[u8],
    command: &str,
    option: &str,
    exit: i32,
    base_zero: bool,
) -> Result<Json, StreamError> {
    let refuse = |before: &str, after: &str| {
        let mut shown = before.as_bytes().to_vec();
        shown.push(b'\'');
        shown.extend_from_slice(raw);
        shown.push(b'\'');
        shown.extend_from_slice(after.as_bytes());
        Err(StreamError::refusal(&shown, exit))
    };
    let invalid = || refuse(&format!("{command}: invalid {option} argument "), "");
    let suffix = || {
        refuse(
            &format!("{command}: invalid suffix in {option} argument "),
            "",
        )
    };
    match raw {
        b"human-readable" => return Ok(scale(1024, "", Some(1024))),
        b"si" => return Ok(scale(1000, "", Some(1000))),
        _ => {}
    }
    let start = raw
        .iter()
        .position(|b| !BLANKS.contains(b))
        .unwrap_or(raw.len());
    let body = raw[start..].strip_prefix(b"+").unwrap_or(&raw[start..]);
    if body.len() != raw.len() && !body.first().is_some_and(u8::is_ascii_digit) {
        return invalid();
    }
    let digits = body.iter().take_while(|b| b.is_ascii_digit()).count();
    let (count, unit) = if base_zero && digits > 0 {
        let parts = match body {
            [b'0', b'b' | b'B', b'0' | b'1', ..] => {
                let binary = &body[2..];
                let end = binary
                    .iter()
                    .take_while(|b| matches!(b, b'0' | b'1'))
                    .count();
                number::Parts {
                    sign: None,
                    radix: 2,
                    digits: &binary[..end],
                    rest: &binary[end..],
                }
            }
            _ => number::parts(body, true),
        };
        let count = parts.saturating();
        if count == 0 {
            return invalid();
        }
        (count, parts.rest)
    } else {
        let (count, unit) = body.split_at(digits);
        let count = if count.is_empty() {
            1u128
        } else {
            count
                .iter()
                .try_fold(0u128, |n, &b| {
                    n.checked_mul(10)?.checked_add(u128::from(b - b'0'))
                })
                .unwrap_or(u128::MAX)
        };
        (count, unit)
    };
    let power = |letter: u8| {
        let upper = letter.to_ascii_uppercase();
        let lower_ok = b"kmgt".contains(&letter) || letter.is_ascii_uppercase();
        UNITS
            .iter()
            .position(|&unit| unit == upper)
            .filter(|_| lower_ok)
            .map(|at| (upper, at as u32 + 1))
    };
    if digits == 0 && unit.first().copied().and_then(power).is_none() {
        return invalid();
    }
    let (factor, shown) = match unit {
        [] => (1u128, String::new()),
        [letter, rest @ ..] => {
            let Some((upper, power)) = power(*letter) else {
                return suffix();
            };
            let upper = char::from(upper);
            match rest {
                b"" => (1024u128.pow(power), upper.to_string()),
                b"B" => {
                    let lead = if upper == 'K' { 'k' } else { upper };
                    (1000u128.pow(power), format!("{lead}B"))
                }
                b"iB" => (1024u128.pow(power), format!("{upper}iB")),
                _ => return suffix(),
            }
        }
    };
    let Some(divisor) = count
        .checked_mul(factor)
        .filter(|&n| n <= u128::from(u64::MAX))
    else {
        return refuse(&format!("{command}: {option} argument "), " too large");
    };
    if divisor == 0 {
        return invalid();
    }
    let shown = if digits == 0 { shown } else { String::new() };
    Ok(scale(divisor, &shown, None))
}

pub(crate) fn scale(divisor: u128, suffix: &str, human_base: Option<u32>) -> Json {
    json!({"divisor": divisor.to_string(), "suffix": suffix, "human_base": human_base})
}
