//! truncate's typed `-s`: `[blanks][mode][blanks][sign]digits[suffix]`, a
//! mode from `< > / %` and a sign that adjusts, at most one of them,
//! checked once its options are read, as GNU coreutils 9.7 words it.
//! The size comes back as decimal text, since it can pass 2**53.

use serde_json::json;

use crate::number::{self, BLANKS, EOVERFLOW};
use crate::scan::{Typed, Values, last, unknown};
use crate::{StreamError, quoted};

/// The size letters truncate takes: every power in upper case, `g`, `k`,
/// `m` and `t` in lower case, and no `b`.
const LETTERS: &[u8] = b"EGKMPQRTYZgkmt";

/// `off_t`'s largest value.
const OFF_T_MAX: u128 = i64::MAX as u128;

const HINT: &str = "Try 'truncate --help' for more information.";

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    if let Some((name, _)) = options.iter().find(|(name, _)| name != "size") {
        return Err(unknown("truncate", name));
    }
    let Some(raw) = last(options, "size") else {
        let refused =
            format!("truncate: you must specify either '--size' or '--reference'\n{HINT}");
        return Err(StreamError::refusal(refused.as_bytes(), 1));
    };
    let (mode, size) = size(raw)?;
    let mut values = Values::new();
    values.insert(
        "size".to_owned(),
        json!({"mode": mode, "size": size.to_string()}),
    );
    Ok(values)
}

/// What `-s` asks of a file's size, and the number it names.
fn size(raw: &[u8]) -> Result<(&'static str, u128), StreamError> {
    let stripped = skip_blanks(raw);
    let (mode, remainder) = match stripped {
        [b'<', rest @ ..] => (Some("at_most"), skip_blanks(rest)),
        [b'>', rest @ ..] => (Some("at_least"), skip_blanks(rest)),
        [b'/', rest @ ..] => (Some("round_down"), skip_blanks(rest)),
        [b'%', rest @ ..] => (Some("round_up"), skip_blanks(rest)),
        _ => (None, stripped),
    };
    let (sign, body) = match remainder {
        [sign @ (b'+' | b'-'), rest @ ..] => (Some(*sign), rest),
        _ => (None, remainder),
    };
    if sign.is_some() && mode.is_some() {
        let refused = format!("truncate: multiple relative modifiers specified\n{HINT}");
        return Err(StreamError::refusal(refused.as_bytes(), 1));
    }
    let invalid = |clause: &str| {
        let refused = format!("truncate: Invalid number: '{}'{clause}", quoted(remainder));
        StreamError::refusal(refused.as_bytes(), 1)
    };
    let digits = body.iter().take_while(|b| b.is_ascii_digit()).count();
    let multiplier = match &body[digits..] {
        [] => Some(1),
        suffix => number::unit(suffix, LETTERS),
    };
    let Some(multiplier) = multiplier.filter(|_| digits > 0) else {
        return Err(invalid(""));
    };
    let number = number::parts(&body[..digits], false)
        .saturating()
        .saturating_mul(multiplier);
    let bound = OFF_T_MAX + u128::from(sign == Some(b'-'));
    if number > bound {
        return Err(invalid(&format!(": {EOVERFLOW}")));
    }
    if number == 0 && matches!(mode, Some("round_down" | "round_up")) {
        return Err(StreamError::refusal(b"truncate: division by zero", 1));
    }
    let mode = match sign {
        Some(b'+') => "extend",
        Some(_) => "reduce",
        None => mode.unwrap_or("absolute"),
    };
    Ok((mode, number))
}

fn skip_blanks(raw: &[u8]) -> &[u8] {
    let start = raw
        .iter()
        .position(|b| !BLANKS.contains(b))
        .unwrap_or(raw.len());
    &raw[start..]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    fn size(raw: &str) -> serde_json::Value {
        scan("truncate", &[("size", raw.as_bytes())]).expect(raw)["size"].clone()
    }

    #[test]
    fn a_size_names_its_mode_and_its_exact_number() {
        for (raw, mode, number) in [
            ("10K", "absolute", "10240"),
            ("1kB", "absolute", "1000"),
            ("2g", "absolute", "2147483648"),
            (" +2", "extend", "2"),
            ("-1K", "reduce", "1024"),
            ("< 4", "at_most", "4"),
            ("\t>5", "at_least", "5"),
            ("/ 100", "round_down", "100"),
            ("%512", "round_up", "512"),
            ("9007199254740993", "absolute", "9007199254740993"),
            ("-8E", "reduce", "9223372036854775808"),
            ("0Q", "absolute", "0"),
            ("010", "absolute", "10"),
        ] {
            assert_eq!(size(raw), json!({"mode": mode, "size": number}), "{raw}");
        }
    }

    #[test]
    fn a_sign_after_a_mode_is_a_second_modifier() {
        let shown = "truncate: multiple relative modifiers specified\n\
                     Try 'truncate --help' for more information.";
        for raw in ["<+4", "%-3", " > +1"] {
            assert_eq!(
                refusal("truncate", &[("size", raw.as_bytes())]),
                (shown.to_owned(), 1),
                "{raw}"
            );
        }
    }

    #[test]
    fn an_invalid_number_quotes_what_follows_the_mode() {
        for (raw, shown) in [
            ("abc", "abc"),
            ("", ""),
            ("<abc", "abc"),
            ("+ 4", "+ 4"),
            ("4 ", "4 "),
            ("K", "K"),
            ("1b", "1b"),
            ("1kib", "1kib"),
            ("0x10", "0x10"),
            ("<", ""),
            ("<<5", "<5"),
            ("a\tb", "a\\tb"),
        ] {
            let message = format!("truncate: Invalid number: '{shown}'");
            assert_eq!(
                refusal("truncate", &[("size", raw.as_bytes())]),
                (message, 1),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn a_size_past_off_t_is_too_large_and_zero_divides_nothing() {
        for raw in ["8E", "9223372036854775808", "1Q", "+8E"] {
            let shown =
                format!("truncate: Invalid number: '{raw}': Value too large for defined data type");
            assert_eq!(refusal("truncate", &[("size", raw.as_bytes())]), (shown, 1));
        }
        for raw in ["/0", "%0K"] {
            assert_eq!(
                refusal("truncate", &[("size", raw.as_bytes())]),
                ("truncate: division by zero".to_owned(), 1)
            );
        }
    }

    #[test]
    fn only_the_last_size_is_read_and_one_is_required() {
        let typed: &[(&str, &[u8])] = &[("size", b"abc"), ("size", b"5")];
        assert_eq!(
            scan("truncate", typed).expect("read")["size"],
            json!({"mode": "absolute", "size": "5"})
        );
        let shown = "truncate: you must specify either '--size' or '--reference'\n\
                     Try 'truncate --help' for more information.";
        assert_eq!(refusal("truncate", &[]), (shown.to_owned(), 1));
    }
}
