//! du's typed `--max-depth` and the switches it conflicts with: the depth
//! read as C's `strtoimax` at base 0, then `-s` against `-a` and against
//! a depth, as GNU coreutils 9.7 words them. A leading blank in a depth
//! remains refused on both hosts. Then the size scale, `-t`'s threshold
//! (worded by the spelling typed, `-t` or `--threshold`), `--time`'s word
//! and the time style, which the host hands over only under `--time`,
//! read from `--time-style` or `TIME_STYLE`.

use serde_json::Value as Json;

use crate::number::{self, BLANKS};
use crate::scan::{Typed, Values, unknown};
use crate::word::{self, Choice};
use crate::{StreamError, byte_text, quoted};

const HINT: &str = "Try 'du --help' for more information.";
/// The size letters `-t` takes, each with an optional `B` or `iB`.
const THRESHOLD_LETTERS: &[u8] = b"kKmMGTPEZYRQ";
/// `--time`'s words, in the order GNU lists them back.
const TIMES: &[Choice] = &[&["atime", "access", "use"], &["ctime", "status"]];
/// The named time styles; a `+FORMAT` is any word with a leading `+`.
const STYLES: &[Choice] = &[&["full-iso"], &["long-iso"], &["iso"]];
const INODE_UNITS: &str =
    "du: warning: options --apparent-size and -b are ineffective with --inodes";

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let (mut summarize, mut all) = (false, false);
    let (mut inodes, mut apparent) = (false, false);
    let mut block = Json::Null;
    let mut max_depth = None;
    let mut limit = Json::Null;
    let mut time = Json::Null;
    let mut style = Json::Null;
    let mut diagnostics = String::new();
    let fatal = |diagnostics: &str, error: StreamError| {
        let mut stderr = diagnostics.as_bytes().to_vec();
        stderr.extend(error.stderr());
        StreamError::refusal(&stderr, 1)
    };
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
            "si" => block = crate::block_size::scale(1000, "", Some(1000)),
            "inodes" => inodes = true,
            "apparent_size" => apparent = true,
            "t" | "threshold" => {
                let option = if name == "t" { "-t" } else { "--threshold" };
                let value = threshold(raw, option).map_err(|error| fatal(&diagnostics, error))?;
                limit = Json::from(value.to_string());
            }
            "time" => {
                let word = word::choose("du", "--time", raw, TIMES, 1)
                    .map_err(|error| fatal(&diagnostics, error))?;
                time = Json::from(word);
            }
            "time_style" => style = Json::from(time_style(raw)?),
            "bytes" => {
                apparent = true;
                block = crate::block_size::scale(1, "", None);
            }
            "k" => block = crate::block_size::scale(1024, "", None),
            "m" => block = crate::block_size::scale(1048576, "", None),
            "block_size" => {
                block = crate::block_size::parse(raw, "du", "-B", 1, true)
                    .map_err(|error| fatal(&diagnostics, error))?;
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
    let mut warnings = Vec::new();
    if let (true, Some(depth)) = (summarize, depth) {
        if depth != 0 {
            let refused = format!("du: warning: summarizing conflicts with --max-depth={depth}");
            return Err(usage(&refused));
        }
        warnings.push("du: warning: summarizing is the same as using --max-depth=0");
    }
    if inodes && apparent {
        warnings.push(INODE_UNITS);
    }
    let mut values = Values::new();
    values.insert("max_depth".to_owned(), depth.map_or(Json::Null, Json::from));
    values.insert(
        "warning".to_owned(),
        if warnings.is_empty() {
            Json::Null
        } else {
            Json::from(warnings.join("\n"))
        },
    );
    values.insert("block_size".to_owned(), block);
    values.insert("threshold".to_owned(), limit);
    values.insert("time".to_owned(), time);
    values.insert("time_style".to_owned(), style);
    Ok(values)
}

/// `-t`: a signed base-0 number with an optional size letter, within
/// `i64`; a minus zero is refused, under `--threshold`'s name whichever
/// spelling was typed.
fn threshold(raw: &[u8], option: &str) -> Result<i64, StreamError> {
    let refuse = |line: String| StreamError::refusal(line.as_bytes(), 1);
    let parts = number::parts(raw, true);
    if parts.digits.is_empty() {
        return Err(refuse(format!(
            "du: invalid {option} argument '{}'",
            quoted(raw)
        )));
    }
    let scale = if parts.rest.is_empty() {
        Some(1)
    } else {
        number::unit(parts.rest, THRESHOLD_LETTERS)
    };
    let Some(scale) = scale else {
        return Err(refuse(format!(
            "du: invalid suffix in {option} argument '{}'",
            quoted(raw)
        )));
    };
    let Some(magnitude) = parts
        .value()
        .and_then(|value| value.checked_mul(scale))
        .and_then(|value| i64::try_from(value).ok())
    else {
        return Err(refuse(format!(
            "du: {option} argument '{}' too large",
            quoted(raw)
        )));
    };
    if parts.negative() && magnitude == 0 {
        return Err(refuse(format!(
            "du: invalid --threshold argument '{}'",
            quoted(raw)
        )));
    }
    Ok(if parts.negative() {
        -magnitude
    } else {
        magnitude
    })
}

/// A time style: a `+FORMAT` whole, or a named style or a prefix of one.
fn time_style(raw: &[u8]) -> Result<String, StreamError> {
    if raw.starts_with(b"+") {
        return Ok(byte_text(raw));
    }
    word::choose("du", "time style", raw, STYLES, 1).map(str::to_owned)
}

/// A depth: a sign, then a base-0 number filling the word, within `i64`.
fn depth(raw: &[u8]) -> Option<i64> {
    let parts = number::parts(raw, true);
    parts
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
        .and_then(|value| i64::try_from(value).ok())
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
            json!({"block_size": null, "max_depth": 0, "threshold": null, "time": null, "time_style": null, "warning": "du: warning: summarizing is the same as using --max-depth=0"})
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
    fn a_threshold_is_a_signed_size_worded_by_its_spelling() {
        for (raw, value) in [
            ("0x10", "16"),
            ("010", "8"),
            ("1k", "1024"),
            ("1KB", "1000"),
            ("1KiB", "1024"),
            (" 5", "5"),
            ("+5", "5"),
            ("-1K", "-1024"),
            ("2kB", "2000"),
            ("0", "0"),
        ] {
            let values = scan("du", &[("t", raw.as_bytes())]).expect(raw);
            assert_eq!(values["threshold"], json!(value), "{raw:?}");
        }
        for (raw, line) in [
            ("x", "du: invalid -t argument 'x'"),
            ("", "du: invalid -t argument ''"),
            ("5b", "du: invalid suffix in -t argument '5b'"),
            ("1e3", "du: invalid suffix in -t argument '1e3'"),
            ("09", "du: invalid suffix in -t argument '09'"),
            ("5 ", "du: invalid suffix in -t argument '5 '"),
            ("1Y", "du: -t argument '1Y' too large"),
            (
                "-99999999999999999999",
                "du: -t argument '-99999999999999999999' too large",
            ),
            ("-0", "du: invalid --threshold argument '-0'"),
        ] {
            assert_eq!(
                refusal("du", &[("t", raw.as_bytes())]),
                (line.to_owned(), 1),
                "{raw:?}"
            );
        }
        assert_eq!(
            refusal("du", &[("threshold", b"x")]).0,
            "du: invalid --threshold argument 'x'"
        );
        let typed: &[(&str, &[u8])] = &[("t", b"1"), ("threshold", b"7")];
        assert_eq!(scan("du", typed).expect("read")["threshold"], json!("7"));
    }

    #[test]
    fn time_takes_a_word_and_a_style_or_a_format() {
        for (raw, word) in [("a", "atime"), ("use", "atime"), ("s", "ctime")] {
            let values = scan("du", &[("time", raw.as_bytes())]).expect(raw);
            assert_eq!(values["time"], json!(word), "{raw}");
        }
        let valid = "\nValid arguments are:\n  - 'atime', 'access', 'use'\n  - 'ctime', 'status'";
        assert_eq!(
            refusal("du", &[("time", b"mod")]),
            (
                format!("du: invalid argument 'mod' for '--time'{valid}{HINT}"),
                1
            )
        );
        for (raw, style) in [
            ("f", "full-iso"),
            ("l", "long-iso"),
            ("is", "iso"),
            ("+%Y", "+%Y"),
        ] {
            let values = scan("du", &[("time_style", raw.as_bytes())]).expect(raw);
            assert_eq!(values["time_style"], json!(style), "{raw}");
        }
        let valid = "\nValid arguments are:\n  - 'full-iso'\n  - 'long-iso'\n  - 'iso'";
        assert_eq!(
            refusal("du", &[("time_style", b"posix-iso")]),
            (
                format!("du: invalid argument 'posix-iso' for 'time style'{valid}{HINT}"),
                1
            )
        );
    }

    #[test]
    fn inodes_warn_of_apparent_sizes_and_si_scales_by_a_thousand() {
        let typed: &[(&str, &[u8])] = &[("inodes", b""), ("bytes", b"")];
        assert_eq!(
            scan("du", typed).expect("read")["warning"],
            json!("du: warning: options --apparent-size and -b are ineffective with --inodes")
        );
        let typed: &[(&str, &[u8])] = &[("k", b""), ("si", b"")];
        assert_eq!(
            scan("du", typed).expect("read")["block_size"]["human_base"],
            json!(1000)
        );
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
