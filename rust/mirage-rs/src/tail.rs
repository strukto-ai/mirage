//! tail's typed values: `-n` and `-c` as head reads them, a leading `+`
//! counting from the start; `--follow`'s word; `-s`, a whole C `strtod`
//! word of at least 0, `null` when it is infinite; `--pid`, a process id;
//! and `--max-unchanged-stats`, a count that is only checked. Each typed
//! occurrence is checked in the order it was typed, as GNU reads its
//! options, and the last of each is the value; `--follow`'s word, which
//! the host hands over apart, is checked after them.

use serde_json::{Value as Json, json};

use crate::head;
use crate::number::{EOVERFLOW, unsigned_decimal};
use crate::printf::number::parse_float;
use crate::scan::{Typed, Values, last, unknown};
use crate::word::{self, Choice};
use crate::{StreamError, quoted};

/// Seconds between polls when `-s` is not typed.
const SLEEP_INTERVAL: f64 = 1.0;

/// `--follow`'s words, in the order GNU lists them back.
const FOLLOW: &[Choice] = &[&["descriptor"], &["name"]];

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let mut lines = Json::Null;
    let mut bytes = Json::Null;
    let mut seconds = SLEEP_INTERVAL;
    let mut process = Json::Null;
    for (name, raw) in options {
        match name.as_str() {
            "lines" => lines = count(raw, head::lines("tail", raw)?),
            "bytes" => bytes = count(raw, head::bytes("tail", raw)?),
            "sleep_interval" => seconds = interval(raw)?,
            "pid" => process = Json::from(pid(raw)?),
            "max_unchanged_stats" => stats(raw)?,
            "follow" => {}
            _ => return Err(unknown("tail", name)),
        }
    }
    let follow = last(options, "follow").map(follow).transpose()?;
    let mut values = Values::new();
    values.insert("lines".to_owned(), lines);
    values.insert("bytes".to_owned(), bytes);
    values.insert("follow".to_owned(), follow.map_or(Json::Null, Json::from));
    let seconds = if seconds.is_finite() {
        Json::from(seconds)
    } else {
        Json::Null
    };
    values.insert("sleep_interval".to_owned(), seconds);
    values.insert("pid".to_owned(), process);
    Ok(values)
}

/// A count's magnitude and the end it counts from: the start for a `+`.
fn count(raw: &[u8], value: i64) -> Json {
    json!({"count": value.unsigned_abs(), "from_start": raw.first() == Some(&b'+')})
}

fn follow(raw: &[u8]) -> Result<&'static str, StreamError> {
    word::choose("tail", "--follow", raw, FOLLOW, 1)
}

/// `-s` as `xstrtod` reads it: the whole word one C-locale `strtod`
/// number, then at least 0, so `inf` passes and NaN does not.
fn interval(raw: &[u8]) -> Result<f64, StreamError> {
    let (value, end, _) = parse_float(raw);
    if end == 0 || end != raw.len() || value.is_nan() || value < 0.0 {
        let refused = format!("tail: invalid number of seconds: '{}'", quoted(raw));
        return Err(StreamError::refusal(refused.as_bytes(), 1));
    }
    Ok(value)
}

/// `--pid`: a whole decimal word with no minus, blanks first, that fits
/// a `pid_t`.
fn pid(raw: &[u8]) -> Result<u32, StreamError> {
    let refused = format!("tail: invalid PID: '{}'", quoted(raw));
    match unsigned_decimal(raw).map(i32::try_from) {
        Some(Ok(value)) => Ok(value.unsigned_abs()),
        Some(Err(_)) => Err(StreamError::refusal(
            format!("{refused}: {EOVERFLOW}").as_bytes(),
            1,
        )),
        None => Err(StreamError::refusal(refused.as_bytes(), 1)),
    }
}

/// `--max-unchanged-stats`: a whole decimal word with no minus, a count
/// past any type taken as the most there is. Nothing reopens a file
/// here, so the count is checked and goes no further.
fn stats(raw: &[u8]) -> Result<(), StreamError> {
    if unsigned_decimal(raw).is_none() {
        let refused = format!(
            "tail: invalid maximum number of unchanged stats between opens: '{}'",
            quoted(raw)
        );
        return Err(StreamError::refusal(refused.as_bytes(), 1));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    #[test]
    fn a_plus_counts_from_the_start_and_a_minus_from_the_end() {
        let typed: &[(&str, &[u8])] = &[("lines", b"+2"), ("bytes", b"-1K")];
        assert_eq!(
            scan("tail", typed).expect("read"),
            json!({
                "lines": {"count": 2, "from_start": true},
                "bytes": {"count": 1024, "from_start": false},
                "follow": null,
                "sleep_interval": 1.0,
                "pid": null,
            })
        );
    }

    #[test]
    fn counts_refuse_in_head_s_grammar_with_tail_s_name() {
        assert_eq!(
            refusal("tail", &[("lines", b"2K")]),
            ("tail: invalid number of lines: '2K'".to_owned(), 1)
        );
        let typed: &[(&str, &[u8])] = &[("bytes", b"y"), ("sleep_interval", b"x"), ("lines", b"x")];
        assert_eq!(
            refusal("tail", typed).0,
            "tail: invalid number of bytes: 'y'"
        );
        let typed: &[(&str, &[u8])] = &[("lines", b"x"), ("lines", b"1")];
        assert_eq!(
            refusal("tail", typed).0,
            "tail: invalid number of lines: 'x'"
        );
    }

    #[test]
    fn a_pid_is_a_plus_signed_decimal_that_fits_a_pid_t() {
        for (raw, pid) in [
            (" +5", 5),
            ("\t05", 5),
            ("2147483647", 2_147_483_647),
            ("0", 0),
        ] {
            let values = scan("tail", &[("pid", raw.as_bytes())]).expect(raw);
            assert_eq!(values["pid"], json!(pid), "{raw:?}");
        }
        for raw in ["abc", "-1", "-0", "", " ", "5 ", "+-5", "0x10", "5x"] {
            assert_eq!(
                refusal("tail", &[("pid", raw.as_bytes())]),
                (format!("tail: invalid PID: '{raw}'"), 1),
                "{raw:?}"
            );
        }
        let large = "tail: invalid PID: '2147483648': Value too large for defined data type";
        assert_eq!(refusal("tail", &[("pid", b"2147483648")]).0, large);
        let typed: &[(&str, &[u8])] = &[("pid", b"abc"), ("max_unchanged_stats", b"x")];
        assert_eq!(refusal("tail", typed).0, "tail: invalid PID: 'abc'");
    }

    #[test]
    fn unchanged_stats_are_a_count_that_may_be_huge() {
        for raw in ["5", " 3", "+3", "18446744073709551616"] {
            scan("tail", &[("max_unchanged_stats", raw.as_bytes())]).expect(raw);
        }
        for raw in ["x", "-1", "-0", "", "3 ", "3k", " -3"] {
            let shown =
                format!("tail: invalid maximum number of unchanged stats between opens: '{raw}'");
            assert_eq!(
                refusal("tail", &[("max_unchanged_stats", raw.as_bytes())]),
                (shown, 1),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn follow_takes_a_word_or_a_prefix_of_one() {
        for (raw, word) in [("d", "descriptor"), ("na", "name"), ("name", "name")] {
            let values = scan("tail", &[("follow", raw.as_bytes())]).expect(raw);
            assert_eq!(values["follow"], json!(word), "{raw}");
        }
        let valid = "\nValid arguments are:\n  - 'descriptor'\n  - 'name'\n\
                     Try 'tail --help' for more information.";
        assert_eq!(
            refusal("tail", &[("follow", b"")]).0,
            format!("tail: ambiguous argument '' for '--follow'{valid}")
        );
        assert_eq!(
            refusal("tail", &[("follow", b"x\r")]).0,
            format!("tail: invalid argument 'x\\r' for '--follow'{valid}")
        );
    }

    #[test]
    fn seconds_are_a_whole_strtod_word_of_at_least_zero() {
        for (raw, seconds) in [
            (" 1", json!(1.0)),
            ("+1", json!(1.0)),
            (".5", json!(0.5)),
            ("1e3", json!(1000.0)),
            ("0x10", json!(16.0)),
            ("0x1p-2", json!(0.25)),
            ("-0", json!(-0.0)),
            ("inf", json!(null)),
            ("INFINITY", json!(null)),
            ("1e999", json!(null)),
        ] {
            let values = scan("tail", &[("sleep_interval", raw.as_bytes())]).expect(raw);
            assert_eq!(values["sleep_interval"], seconds, "{raw}");
        }
        for raw in [
            "nan", "NaN(1)", "-1", "-inf", "1 ", "", "1,5", "1e", "0x", "x", "1\x01",
        ] {
            let shown = format!(
                "tail: invalid number of seconds: '{}'",
                crate::quoted(raw.as_bytes())
            );
            assert_eq!(
                refusal("tail", &[("sleep_interval", raw.as_bytes())]),
                (shown, 1),
                "{raw:?}"
            );
        }
        assert_eq!(
            scan("tail", &[]).expect("read")["sleep_interval"],
            json!(1.0)
        );
    }
}
