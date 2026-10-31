//! du's typed `--max-depth` and the switches it conflicts with: the depth
//! read as C's `strtoimax` at base 0, then `-s` against `-a` and against
//! a depth, as GNU coreutils 9.7 words them. Two divergences both hosts
//! had are kept until they are pinned: a leading blank is refused, and
//! only the last depth is checked where GNU refuses each bad one.

use serde_json::Value as Json;

use crate::number::{self, BLANKS};
use crate::scan::{Typed, Values, last, unknown};
use crate::{StreamError, quoted};

const HINT: &str = "Try 'du --help' for more information.";

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let (mut summarize, mut all) = (false, false);
    for (name, _) in options {
        match name.as_str() {
            "max_depth" => {}
            "s" => summarize = true,
            "a" => all = true,
            _ => return Err(unknown("du", name)),
        }
    }
    let depth = last(options, "max_depth").map(depth).transpose()?;
    if summarize && all {
        return Err(usage("du: cannot both summarize and show all entries"));
    }
    let mut warning = Json::Null;
    if let (true, Some(depth)) = (summarize, depth) {
        if depth != 0 {
            let refused = format!("du: warning: summarizing conflicts with --max-depth={depth}");
            return Err(usage(&refused));
        }
        warning = Json::from("du: warning: summarizing is the same as using --max-depth=0");
    }
    let mut values = Values::new();
    values.insert("max_depth".to_owned(), depth.map_or(Json::Null, Json::from));
    values.insert("warning".to_owned(), warning);
    Ok(values)
}

/// A depth: a sign, then a base-0 number filling the word, within `i64`.
fn depth(raw: &[u8]) -> Result<i64, StreamError> {
    let parts = number::parts(raw, true);
    let value = parts
        .value()
        .filter(|_| parts.whole() && !raw.first().is_some_and(|b| BLANKS.contains(b)))
        .and_then(|magnitude| i128::try_from(magnitude).ok())
        .map(|magnitude| {
            if parts.negative() {
                -magnitude
            } else {
                magnitude
            }
        })
        .and_then(|value| i64::try_from(value).ok());
    value.ok_or_else(|| usage(&format!("du: invalid maximum depth '{}'", quoted(raw))))
}

fn usage(line: &str) -> StreamError {
    StreamError::refusal(format!("{line}\n{HINT}").as_bytes(), 1)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    const HINT: &str = "\nTry 'du --help' for more information.";

    #[test]
    fn a_depth_reads_as_strtoimax_at_base_zero() {
        for (raw, depth) in [
            ("0", 0),
            ("2", 2),
            ("+2", 2),
            ("-0", 0),
            ("010", 8),
            ("0x2", 2),
            ("0X3", 3),
            ("-5", -5),
            ("9223372036854775807", i64::MAX),
            ("-9223372036854775808", i64::MIN),
        ] {
            let values = scan("du", &[("max_depth", raw.as_bytes())]).expect(raw);
            assert_eq!(values["max_depth"], json!(depth), "{raw}");
        }
    }

    #[test]
    fn a_depth_with_a_blank_or_past_i64_is_invalid() {
        for raw in [
            " 1",
            "1 ",
            "09",
            "0xz",
            "0x",
            "1x",
            "1_0",
            "",
            "+",
            "9223372036854775808",
            "-9223372036854775809",
            "1K",
        ] {
            let shown = format!(
                "du: invalid maximum depth '{}'{HINT}",
                crate::quoted(raw.as_bytes())
            );
            assert_eq!(
                refusal("du", &[("max_depth", raw.as_bytes())]),
                (shown, 1),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn a_bad_depth_comes_before_every_conflict() {
        let typed: &[(&str, &[u8])] = &[("s", b""), ("a", b""), ("max_depth", b"abc")];
        let shown = format!("du: invalid maximum depth 'abc'{HINT}");
        assert_eq!(refusal("du", typed), (shown, 1));
        let typed: &[(&str, &[u8])] = &[("s", b""), ("a", b""), ("max_depth", b"1")];
        let shown = format!("du: cannot both summarize and show all entries{HINT}");
        assert_eq!(refusal("du", typed), (shown, 1));
    }

    #[test]
    fn summarize_conflicts_with_any_depth_but_zero() {
        let typed: &[(&str, &[u8])] = &[("s", b""), ("max_depth", b"9007199254740993")];
        let shown =
            format!("du: warning: summarizing conflicts with --max-depth=9007199254740993{HINT}");
        assert_eq!(refusal("du", typed), (shown, 1));
        let typed: &[(&str, &[u8])] = &[("max_depth", b"-0"), ("s", b"")];
        assert_eq!(
            scan("du", typed).expect("read"),
            json!({"max_depth": 0, "warning": "du: warning: summarizing is the same as using --max-depth=0"})
        );
        let typed: &[(&str, &[u8])] = &[("max_depth", b"abc"), ("max_depth", b"1")];
        assert_eq!(
            scan("du", typed).expect("read"),
            json!({"max_depth": 1, "warning": null})
        );
    }
}
