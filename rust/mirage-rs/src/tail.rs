//! tail's typed values: `-n` and `-c` as head reads them, a leading `+`
//! counting from the start; `--follow`'s word; and `-s`, a whole C
//! `strtod` word of at least 0, `null` when it is infinite. Only the last
//! of each is checked, in that order, where GNU checks each one as it is
//! typed: a divergence both hosts had, kept until it is pinned.

use serde_json::{Value as Json, json};

use crate::head;
use crate::printf::number::parse_float;
use crate::scan::{Typed, Values, last, unknown};
use crate::{StreamError, quoted};

/// Seconds between polls when `-s` is not typed.
const SLEEP_INTERVAL: f64 = 1.0;

/// `--follow`'s words, in the order GNU lists them back.
const FOLLOW: [&str; 2] = ["descriptor", "name"];

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    if let Some((name, _)) = options
        .iter()
        .find(|(name, _)| !matches!(name.as_str(), "n" | "c" | "follow" | "sleep_interval"))
    {
        return Err(unknown("tail", name));
    }
    let lines = last(options, "n")
        .map(|raw| Ok::<_, StreamError>(count(raw, head::lines("tail", raw)?)))
        .transpose()?;
    let bytes = last(options, "c")
        .map(|raw| Ok::<_, StreamError>(count(raw, head::bytes("tail", raw)?)))
        .transpose()?;
    let follow = last(options, "follow").map(follow).transpose()?;
    let mut values = Values::new();
    values.insert("lines".to_owned(), lines.unwrap_or(Json::Null));
    values.insert("bytes".to_owned(), bytes.unwrap_or(Json::Null));
    values.insert("follow".to_owned(), follow.map_or(Json::Null, Json::from));
    let seconds = last(options, "sleep_interval")
        .map(seconds)
        .transpose()?
        .unwrap_or(SLEEP_INTERVAL);
    let seconds = if seconds.is_finite() {
        Json::from(seconds)
    } else {
        Json::Null
    };
    values.insert("sleep_interval".to_owned(), seconds);
    Ok(values)
}

/// A count's magnitude and the end it counts from: the start for a `+`.
fn count(raw: &[u8], value: i64) -> Json {
    json!({"count": value.unsigned_abs(), "from_start": raw.first() == Some(&b'+')})
}

/// `--follow`'s word as argmatch reads it: one of `FOLLOW`, or a prefix of
/// just one.
fn follow(raw: &[u8]) -> Result<&'static str, StreamError> {
    if let Some(word) = FOLLOW.iter().find(|word| word.as_bytes() == raw) {
        return Ok(word);
    }
    let matches: Vec<&str> = FOLLOW
        .into_iter()
        .filter(|word| word.as_bytes().starts_with(raw))
        .collect();
    if let [word] = matches[..] {
        return Ok(word);
    }
    let kind = if matches.is_empty() {
        "invalid"
    } else {
        "ambiguous"
    };
    let refused = format!(
        "tail: {kind} argument '{}' for '--follow'\nValid arguments are:\n  - 'descriptor'\n  - 'name'\nTry 'tail --help' for more information.",
        quoted(raw)
    );
    Err(StreamError::refusal(refused.as_bytes(), 1))
}

/// `-s` as `xstrtod` reads it: the whole word one C-locale `strtod`
/// number, then at least 0, so `inf` passes and NaN does not.
fn seconds(raw: &[u8]) -> Result<f64, StreamError> {
    let (value, end, _) = parse_float(raw);
    if end == 0 || end != raw.len() || value.is_nan() || value < 0.0 {
        let refused = format!("tail: invalid number of seconds: '{}'", quoted(raw));
        return Err(StreamError::refusal(refused.as_bytes(), 1));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    #[test]
    fn a_plus_counts_from_the_start_and_a_minus_from_the_end() {
        let typed: &[(&str, &[u8])] = &[("n", b"+2"), ("c", b"-1K")];
        assert_eq!(
            scan("tail", typed).expect("read"),
            json!({
                "lines": {"count": 2, "from_start": true},
                "bytes": {"count": 1024, "from_start": false},
                "follow": null,
                "sleep_interval": 1.0,
            })
        );
    }

    #[test]
    fn counts_refuse_in_head_s_grammar_with_tail_s_name() {
        assert_eq!(
            refusal("tail", &[("n", b"2K")]),
            ("tail: invalid number of lines: '2K'".to_owned(), 1)
        );
        let typed: &[(&str, &[u8])] = &[("c", b"y"), ("sleep_interval", b"x"), ("n", b"x")];
        assert_eq!(
            refusal("tail", typed).0,
            "tail: invalid number of lines: 'x'"
        );
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
