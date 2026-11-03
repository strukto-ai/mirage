//! du's typed `--max-depth` and the switches it conflicts with: the depth
//! read as C's `strtoimax` at base 0, then `-s` against `-a` and against
//! a depth, as GNU coreutils 9.7 words them. A leading blank in a depth
//! remains refused on both hosts.

use serde_json::Value as Json;

use crate::number::{self, BLANKS};
use crate::scan::{Typed, Values, unknown};
use crate::{StreamError, quoted};

const HINT: &str = "Try 'du --help' for more information.";

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let (mut summarize, mut all) = (false, false);
    let mut block = Json::Null;
    let mut max_depth = None;
    let mut diagnostics = String::new();
    for (name, raw) in options {
        match name.as_str() {
            "max_depth" => match depth(raw) {
                Some(value) => max_depth = Some(value),
                None => {
                    diagnostics.push_str(&format!("du: invalid maximum depth '{}'\n", quoted(raw)))
                }
            },
            "summarize" => summarize = true,
            "all" => all = true,
            "human_readable" => block = Json::Null,
            "bytes" => block = crate::block_size::scale(1, "", None),
            "k" => block = crate::block_size::scale(1024, "", None),
            "m" => block = crate::block_size::scale(1048576, "", None),
            "block_size" => {
                block = crate::block_size::parse(raw, "du", "-B", 1, true).map_err(|error| {
                    let mut stderr = diagnostics.as_bytes().to_vec();
                    stderr.extend(error.stderr());
                    StreamError::refusal(&stderr, 1)
                })?;
            }
            _ => return Err(unknown("du", name)),
        }
    }
    if !diagnostics.is_empty() {
        return Err(usage(diagnostics.trim_end()));
    }
    let depth = max_depth;
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
    values.insert("block_size".to_owned(), block);
    Ok(values)
}

/// A depth: a sign, then a base-0 number filling the word, within `i64`.
fn depth(raw: &[u8]) -> Option<i64> {
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
    value
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
        let typed: &[(&str, &[u8])] = &[("summarize", b""), ("all", b""), ("max_depth", b"abc")];
        let shown = format!("du: invalid maximum depth 'abc'{HINT}");
        assert_eq!(refusal("du", typed), (shown, 1));
        let typed: &[(&str, &[u8])] = &[("summarize", b""), ("all", b""), ("max_depth", b"1")];
        let shown = format!("du: cannot both summarize and show all entries{HINT}");
        assert_eq!(refusal("du", typed), (shown, 1));
    }

    #[test]
    fn summarize_conflicts_with_any_depth_but_zero() {
        let typed: &[(&str, &[u8])] = &[("summarize", b""), ("max_depth", b"9007199254740993")];
        let shown =
            format!("du: warning: summarizing conflicts with --max-depth=9007199254740993{HINT}");
        assert_eq!(refusal("du", typed), (shown, 1));
        let typed: &[(&str, &[u8])] = &[("max_depth", b"-0"), ("summarize", b"")];
        assert_eq!(
            scan("du", typed).expect("read"),
            json!({"block_size": null, "max_depth": 0, "warning": "du: warning: summarizing is the same as using --max-depth=0"})
        );
        let typed: &[(&str, &[u8])] = &[("max_depth", b"abc"), ("max_depth", b"1")];
        assert_eq!(
            refusal("du", typed),
            (format!("du: invalid maximum depth 'abc'{HINT}"), 1)
        );
    }

    #[test]
    fn unit_options_reduce_in_occurrence_order() {
        for (typed, divisor) in [
            (vec![("bytes", b"".as_slice()), ("k", b"")], "1024"),
            (vec![("k", b"".as_slice()), ("bytes", b"")], "1"),
            (
                vec![("k", b"".as_slice()), ("bytes", b""), ("k", b"")],
                "1024",
            ),
            (vec![("block_size", b"0x10".as_slice())], "16"),
            (vec![("block_size", b"010".as_slice())], "8"),
            (vec![("block_size", b"0b10".as_slice())], "2"),
            (vec![("block_size", b"0B10K".as_slice())], "2048"),
        ] {
            assert_eq!(
                scan("du", &typed).expect("units")["block_size"]["divisor"],
                json!(divisor)
            );
        }
        let typed: &[(&str, &[u8])] = &[("k", b""), ("human_readable", b"")];
        assert_eq!(scan("du", typed).expect("human")["block_size"], json!(null));
    }

    #[test]
    fn each_block_size_is_validated_before_a_later_unit() {
        for (raw, expected) in [
            ("0", "du: invalid -B argument '0'"),
            ("08", "du: invalid -B argument '08'"),
            ("09", "du: invalid -B argument '09'"),
            ("0x", "du: invalid -B argument '0x'"),
            ("0xg", "du: invalid -B argument '0xg'"),
            ("0b2", "du: invalid -B argument '0b2'"),
            ("0b102", "du: invalid suffix in -B argument '0b102'"),
            ("1x", "du: invalid suffix in -B argument '1x'"),
            (
                "18446744073709551616",
                "du: -B argument '18446744073709551616' too large",
            ),
        ] {
            let typed: &[(&str, &[u8])] = &[("block_size", raw.as_bytes()), ("bytes", b"")];
            assert_eq!(refusal("du", typed), (expected.to_owned(), 1));
        }
    }
    #[test]
    fn depth_diagnostics_precede_a_later_fatal_block_size() {
        let typed: &[(&str, &[u8])] = &[("max_depth", b"bad"), ("block_size", b"0")];
        assert_eq!(
            refusal("du", typed),
            (
                "du: invalid maximum depth 'bad'\ndu: invalid -B argument '0'".to_owned(),
                1
            )
        );
        let typed: &[(&str, &[u8])] = &[("block_size", b"0"), ("max_depth", b"bad")];
        assert_eq!(
            refusal("du", typed),
            ("du: invalid -B argument '0'".to_owned(), 1)
        );
        let typed: &[(&str, &[u8])] = &[("max_depth", b"bad"), ("max_depth", b"worse")];
        assert_eq!(
            refusal("du", typed),
            (
                format!("du: invalid maximum depth 'bad'\ndu: invalid maximum depth 'worse'{HINT}"),
                1
            )
        );
    }
}
