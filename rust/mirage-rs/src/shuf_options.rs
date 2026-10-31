//! shuf's typed values, each checked where it was typed as GNU checks it
//! (coreutils 9.7): every `-n` a whole unsigned decimal word, the least
//! kept and clamped to `SIZE_MAX`; `-i LO-HI` split at its first dash,
//! each bound such a word, a second `-i` refused; a second `-o` refused
//! unless it is the same word; and `-e` with `-i` refused once every
//! option is read. Counts and bounds reach `u64::MAX`, past what a JSON
//! number keeps exact, so they come back as decimal text.

use serde_json::{Value as Json, json};

use crate::number::{EOVERFLOW, unsigned_decimal};
use crate::scan::{Typed, Values, unknown};
use crate::{StreamError, quoted};

const ECHO_WITH_RANGE: &str =
    "shuf: cannot combine -e and -i options\nTry 'shuf --help' for more information.";

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let mut count: Option<u64> = None;
    let mut range: Option<(u64, u64)> = None;
    let mut output: Option<&[u8]> = None;
    let mut echo = false;
    for (name, raw) in options {
        match name.as_str() {
            "head_count" => {
                let value = unsigned_decimal(raw).ok_or_else(|| {
                    refused(&format!("shuf: invalid line count: '{}'", quoted(raw)))
                })?;
                let value = u64::try_from(value).unwrap_or(u64::MAX);
                count = Some(count.map_or(value, |least| least.min(value)));
            }
            "input_range" => {
                if range.is_some() {
                    return Err(refused("shuf: multiple -i options specified"));
                }
                range = Some(input_range(raw)?);
            }
            "output" => match output {
                Some(first) if first != raw.as_slice() => {
                    return Err(refused("shuf: multiple output files specified"));
                }
                _ => output = Some(raw),
            },
            "echo" => echo = true,
            _ => return Err(unknown("shuf", name)),
        }
    }
    if echo && range.is_some() {
        return Err(refused(ECHO_WITH_RANGE));
    }
    let mut values = Values::new();
    values.insert(
        "count".to_owned(),
        count.map_or(Json::Null, |n| Json::from(n.to_string())),
    );
    values.insert(
        "range".to_owned(),
        range.map_or(Json::Null, |(low, high)| {
            json!([low.to_string(), high.to_string()])
        }),
    );
    Ok(values)
}

/// `-i LO-HI`: a bound past `u64` overflows, checked low bound first, and
/// a decreasing range or one whose span reaches `SIZE_MAX` is invalid.
fn input_range(raw: &[u8]) -> Result<(u64, u64), StreamError> {
    let invalid = || refused(&format!("shuf: invalid input range: '{}'", quoted(raw)));
    let overflow = || {
        refused(&format!(
            "shuf: invalid input range: '{}': {EOVERFLOW}",
            quoted(raw)
        ))
    };
    let dash = raw.iter().position(|&b| b == b'-').ok_or_else(invalid)?;
    let bound = |side: &[u8]| {
        let value = unsigned_decimal(side).ok_or_else(invalid)?;
        u64::try_from(value).map_err(|_| overflow())
    };
    let low = bound(&raw[..dash])?;
    let high = bound(&raw[dash + 1..])?;
    if low > high || high - low == u64::MAX {
        return Err(invalid());
    }
    Ok((low, high))
}

fn refused(message: &str) -> StreamError {
    StreamError::refusal(message.as_bytes(), 1)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    type Line<'a> = &'a [(&'a str, &'a [u8])];

    const MAX: &str = "18446744073709551615";
    const PAST: &str = "18446744073709551616";

    fn count(raw: &str) -> serde_json::Value {
        scan("shuf", &[("head_count", raw.as_bytes())]).expect(raw)["count"].clone()
    }

    fn range(raw: &str) -> Result<serde_json::Value, String> {
        scan("shuf", &[("input_range", raw.as_bytes())])
            .map(|values| values["range"].clone())
            .map_err(|(stderr, _)| String::from_utf8_lossy(&stderr).into_owned())
    }

    #[test]
    fn a_count_is_a_whole_unsigned_decimal_word_clamped_to_size_max() {
        for (raw, value) in [
            ("2", "2"),
            (" 2", "2"),
            ("\t2", "2"),
            ("\n2", "2"),
            ("+2", "2"),
            (" +2", "2"),
            ("010", "10"),
            ("0", "0"),
            (MAX, MAX),
            (PAST, MAX),
            (&"9".repeat(400), MAX),
        ] {
            assert_eq!(count(raw), json!(value), "{raw}");
        }
        for raw in ["2 ", "-1", "0x10", "", "abc", "++2", "2\n", "1K", "\u{e9}"] {
            assert_eq!(
                refusal("shuf", &[("head_count", raw.as_bytes())]),
                (
                    format!(
                        "shuf: invalid line count: '{}'",
                        crate::quoted(raw.as_bytes())
                    ),
                    1
                ),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn every_count_is_checked_and_the_least_is_kept() {
        let typed: &[(&str, &[u8])] = &[("head_count", b"1"), ("head_count", b"3")];
        assert_eq!(scan("shuf", typed).expect("read")["count"], json!("1"));
        let typed: &[(&str, &[u8])] = &[("head_count", b"3"), ("head_count", b"0")];
        assert_eq!(scan("shuf", typed).expect("read")["count"], json!("0"));
        let typed: &[(&str, &[u8])] = &[("head_count", b"1"), ("head_count", b"abc")];
        assert_eq!(refusal("shuf", typed).0, "shuf: invalid line count: 'abc'");
        assert_eq!(
            scan("shuf", &[]).expect("read"),
            json!({"count": null, "range": null})
        );
    }

    #[test]
    fn a_range_splits_at_its_first_dash_and_reads_each_bound_alone() {
        for (raw, low, high) in [
            ("1-3", "1", "3"),
            ("0-0", "0", "0"),
            (" 1-5", "1", "5"),
            ("1- 5", "1", "5"),
            ("+1-+3", "1", "3"),
            ("01-03", "1", "3"),
            ("\t1-\t3", "1", "3"),
            (&format!("1-{MAX}"), "1", MAX),
        ] {
            assert_eq!(range(raw), Ok(json!([low, high])), "{raw}");
        }
        for raw in [
            "5-3", "1-0", "-1-5", "1 -5", "1-", "-5", "5", "", "1--3", "1-2-3", "0x1-0x3", "1-3\n",
            "x-1",
        ] {
            assert_eq!(
                range(raw),
                Err(format!(
                    "shuf: invalid input range: '{}'",
                    crate::quoted(raw.as_bytes())
                )),
                "{raw:?}"
            );
        }
        assert_eq!(
            range(&format!("0-{MAX}")),
            Err(format!("shuf: invalid input range: '0-{MAX}'"))
        );
    }

    #[test]
    fn a_bound_past_u64_overflows_and_the_low_bound_is_read_first() {
        let clause = ": Value too large for defined data type";
        for raw in [
            format!("{PAST}-1"),
            format!("1-{PAST}"),
            format!("{PAST}-x"),
        ] {
            assert_eq!(
                range(&raw),
                Err(format!("shuf: invalid input range: '{raw}'{clause}"))
            );
        }
        let raw = format!("x-{PAST}");
        assert_eq!(
            range(&raw),
            Err(format!("shuf: invalid input range: '{raw}'"))
        );
    }

    #[test]
    fn each_option_is_refused_where_it_was_typed() {
        let cases: &[(Line, &str)] = &[
            (
                &[
                    ("input_range", b"1-2"),
                    ("head_count", b"abc"),
                    ("input_range", b"3-4"),
                ],
                "shuf: invalid line count: 'abc'",
            ),
            (
                &[("input_range", b"1-2"), ("input_range", b"1-2")],
                "shuf: multiple -i options specified",
            ),
            (
                &[("input_range", b"1-2"), ("input_range", b"x")],
                "shuf: multiple -i options specified",
            ),
            (
                &[("input_range", b"1-x"), ("input_range", b"2-3")],
                "shuf: invalid input range: '1-x'",
            ),
            (
                &[("output", b"a"), ("output", b"b"), ("head_count", b"x")],
                "shuf: multiple output files specified",
            ),
            (
                &[("head_count", b"x"), ("output", b"a"), ("output", b"b")],
                "shuf: invalid line count: 'x'",
            ),
            (
                &[("input_range", b"1-3"), ("echo", b""), ("head_count", b"x")],
                "shuf: invalid line count: 'x'",
            ),
            (
                &[("echo", b""), ("input_range", b"1-x")],
                "shuf: invalid input range: '1-x'",
            ),
            (
                &[("echo", b""), ("input_range", b"1-3")],
                "shuf: cannot combine -e and -i options\nTry 'shuf --help' for more information.",
            ),
        ];
        for (typed, shown) in cases {
            assert_eq!(refusal("shuf", typed), ((*shown).to_owned(), 1));
        }
        let typed: &[(&str, &[u8])] = &[("output", b"a"), ("output", b"a")];
        assert!(scan("shuf", typed).is_ok());
    }
}
