//! The `scan` stream: a command's typed option values read once, here,
//! before its host touches an operand. The host sends the command and the
//! options it was given, each as typed and in the order typed; `open`
//! fails with the first value the command refuses, in its words and with
//! its exit status, and otherwise `finish` writes every value as one JSON
//! object keyed by option.

use serde::Deserialize;
use serde_json::{Map, Value as Json};

use crate::{Stream, StreamError, latin1_bytes, parse_config};

/// One option as typed: its name and its value's bytes.
pub(crate) type Typed = (String, Vec<u8>);

/// What a command's grammar makes of its options: every value by name.
pub(crate) type Values = Map<String, Json>;

/// A command's grammar: its typed options read, or its refusal.
type Grammar = fn(&[Typed]) -> Result<Values, StreamError>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    command: String,
    /// `[name, value]` pairs, each value one character per byte.
    options: Vec<(String, String)>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { command, options } = parse_config(config)?;
    let typed = options
        .into_iter()
        .map(|(name, text)| {
            latin1_bytes(&text)
                .map(|bytes| (name, bytes))
                .ok_or_else(|| StreamError::new("a scanned value holds a character past U+00FF"))
        })
        .collect::<Result<Vec<Typed>, StreamError>>()?;
    let values = grammar(&command)?(&typed)?;
    Ok(Box::new(Scanned {
        values: serde_json::to_vec(&Json::Object(values)).unwrap_or_default(),
    }))
}

/// The grammar that reads `command`'s options.
fn grammar(command: &str) -> Result<Grammar, StreamError> {
    Ok(match command {
        "base64" => crate::base64::scan,
        "cmp" => crate::cmp::scan,
        "fmt" => crate::reflow::scan,
        "fold" => crate::fold::scan,
        "grep" => crate::grep::scan,
        "rg" => crate::rg_options::scan,
        "xxd" => crate::xxd::scan,
        _ => return Err(StreamError::new(format!("scan: no grammar for {command}"))),
    })
}

/// An option the command's grammar does not read: the host's mistake, not
/// the line's.
pub(crate) fn unknown(command: &str, name: &str) -> StreamError {
    StreamError::new(format!("scan: {command} reads no option {name}"))
}

/// The last occurrence of option `name`, the one a program that keeps a
/// value and checks it once its options are read refuses.
pub(crate) fn last<'a>(options: &'a [Typed], name: &str) -> Option<&'a [u8]> {
    options
        .iter()
        .rev()
        .find(|(typed, _)| typed == name)
        .map(|(_, raw)| raw.as_slice())
}

/// Each option's last occurrence, in the order those occurrences were
/// typed: what a host's parsed flags keep of a scalar option typed twice.
pub(crate) fn latest(options: &[Typed]) -> Vec<&Typed> {
    options
        .iter()
        .enumerate()
        .filter(|(at, (name, _))| !options[at + 1..].iter().any(|(later, _)| later == name))
        .map(|(_, typed)| typed)
        .collect()
}

/// The values a scan read, written once the host finishes it.
struct Scanned {
    values: Vec<u8>,
}

impl Stream for Scanned {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.append(&mut self.values);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as Json, json};

    use crate::open;

    /// What `command` makes of `options`: its values, or its stderr and
    /// status.
    fn scan(command: &str, options: &[(&str, &[u8])]) -> Result<Json, (Vec<u8>, i32)> {
        let options: Vec<(&str, String)> = options
            .iter()
            .map(|(name, raw)| (*name, raw.iter().map(|&b| char::from(b)).collect()))
            .collect();
        let config = json!({"command": command, "options": options}).to_string();
        let mut stream = open("scan", config.as_bytes()).map_err(|e| (e.stderr(), e.status))?;
        let mut out = Vec::new();
        stream.finish(&mut out).expect("finished");
        Ok(serde_json::from_slice(&out).expect("json"))
    }

    fn refusal(command: &str, options: &[(&str, &[u8])]) -> (String, i32) {
        let (stderr, status) = scan(command, options).expect_err("refused");
        (String::from_utf8_lossy(&stderr).into_owned(), status)
    }

    const CMP_HINT: &str = "\ncmp: Try 'cmp --help' for more information.";

    #[test]
    fn cmp_counts_take_base_zero_digits_and_its_size_letters() {
        for (raw, value) in [
            ("4", 4u64),
            ("1K", 1024),
            ("1k", 1024),
            ("1kB", 1000),
            ("1kiB", 1024),
            ("1M", 1024 * 1024),
            ("0Z", 0),
            ("010", 8),
            ("0x400", 1024),
            ("+1010", 1010),
            (" 1", 1),
            ("9223372036854775807", i64::MAX as u64),
            ("7E", 7 << 60),
        ] {
            let values = scan("cmp", &[("bytes", raw.as_bytes())]).expect(raw);
            assert_eq!(values["limit"], json!(value), "{raw}");
        }
    }

    #[test]
    fn cmp_refuses_a_count_past_its_grammar_unescaped() {
        for raw in [
            "1b",
            "1B",
            "1c",
            "1w",
            "1m",
            "1g",
            "1t",
            "1Q",
            "0Q",
            "1 ",
            "-1",
            "9223372036854775808",
            "8E",
            "1Z",
            "1Y",
            "abc",
            "1\u{e9}",
            "1\x01",
            "1'",
            "1\\",
        ] {
            let shown = format!("cmp: invalid --bytes value '{raw}'{CMP_HINT}");
            assert_eq!(refusal("cmp", &[("bytes", raw.as_bytes())]), (shown, 2));
        }
    }

    #[test]
    fn cmp_ignore_initial_names_the_word_from_where_it_stopped() {
        let values = scan("cmp", &[("ignore_initial", b"1K:2")]).expect("read");
        assert_eq!(values["skip"], json!([1024, 2]));
        assert_eq!(
            scan("cmp", &[("ignore_initial", b"3")]).expect("read")["skip"],
            json!([3, 3])
        );
        for (raw, named) in [
            ("1b:1", "1b:1"),
            ("1:1b", "1b"),
            ("abc:1", "abc:1"),
            ("1:2:3", "2:3"),
            ("1:", ""),
            (":1", ":1"),
        ] {
            let shown = format!("cmp: invalid --ignore-initial value '{named}'{CMP_HINT}");
            assert_eq!(
                refusal("cmp", &[("ignore_initial", raw.as_bytes())]),
                (shown, 2)
            );
        }
    }

    #[test]
    fn cmp_skip_operands_keep_the_larger_and_take_no_colon() {
        let options: &[(&str, &[u8])] =
            &[("ignore_initial", b"1"), ("skip", b"0"), ("skip", b"0x2")];
        assert_eq!(scan("cmp", options).expect("read")["skip"], json!([1, 2]));
        let shown = format!("cmp: invalid --ignore-initial value '1:2'{CMP_HINT}");
        assert_eq!(refusal("cmp", &[("skip", b"1:2")]), (shown, 2));
    }

    #[test]
    fn cmp_refuses_in_the_order_typed() {
        let conflict = format!("cmp: options -l and -s are incompatible{CMP_HINT}");
        let typed: &[(&str, &[u8])] = &[("verbose", b""), ("quiet", b""), ("bytes", b"x")];
        assert_eq!(refusal("cmp", typed), (conflict, 2));
        let typed: &[(&str, &[u8])] = &[("bytes", b"x"), ("verbose", b""), ("silent", b"")];
        let shown = format!("cmp: invalid --bytes value 'x'{CMP_HINT}");
        assert_eq!(refusal("cmp", typed), (shown, 2));
    }

    #[test]
    fn fold_checks_every_width_typed() {
        let typed: &[(&str, &[u8])] = &[("width", b"0"), ("width", b"5")];
        let shown = "fold: invalid number of columns: '0': Numerical result out of range";
        assert_eq!(refusal("fold", typed), (shown.to_owned(), 1));
        let typed: &[(&str, &[u8])] = &[("width", b"x"), ("width", b"5")];
        assert_eq!(
            refusal("fold", typed).0,
            "fold: invalid number of columns: 'x'"
        );
        let typed: &[(&str, &[u8])] = &[("width", b"7"), ("width", b" +5")];
        assert_eq!(scan("fold", typed).expect("read"), json!({"width": 5}));
    }

    #[test]
    fn base64_takes_a_wrap_past_intmax_as_none() {
        let wrap = scan("base64", &[("wrap", b"99999999999999999999")]).expect("read");
        assert_eq!(wrap, json!({"wrap": 0}));
        assert_eq!(
            refusal("base64", &[("wrap", b"-1")]),
            ("base64: invalid wrap size: '-1'".to_owned(), 1)
        );
    }

    #[test]
    fn fmt_reads_the_last_width_then_bounds_the_goal_by_it() {
        let typed: &[(&str, &[u8])] = &[("goal", b"80"), ("width", b"70")];
        let shown = "fmt: invalid width: '80': Value too large for defined data type";
        assert_eq!(refusal("fmt", typed), (shown.to_owned(), 1));
        let typed: &[(&str, &[u8])] = &[("width", b"x"), ("width", b"2500"), ("goal", b"90")];
        assert_eq!(
            scan("fmt", typed).expect("read"),
            json!({"width": 2500, "goal": 90})
        );
        let shown = "fmt: invalid width: '2501': Numerical result out of range";
        assert_eq!(refusal("fmt", &[("width", b"2501")]), (shown.to_owned(), 1));
    }

    #[test]
    fn xxd_reads_strtol_and_refuses_only_columns() {
        let typed: &[(&str, &[u8])] = &[
            ("c", b"0x8z"),
            ("g", b"-3"),
            ("s", b"+-0x10"),
            ("args_l", b"-1"),
        ];
        let values = scan("xxd", typed).expect("read");
        assert_eq!(
            values,
            json!({"cols": 8, "group": 2, "seek": {"offset": 16, "relative": true, "back": true}, "limit": null})
        );
        let values = scan("xxd", &[("c", b"x"), ("g", b"17")]).expect("read");
        assert_eq!(
            (&values["cols"], &values["group"]),
            (&json!(16), &json!(16))
        );
        assert_eq!(
            scan("xxd", &[("g", b"0x9")]).expect("read")["group"],
            json!(9)
        );
        let shown = "xxd: invalid number of columns (max. 256).".to_owned();
        assert_eq!(refusal("xxd", &[("c", b"257")]), (shown.clone(), 1));
        assert_eq!(refusal("xxd", &[("p", b""), ("c", b"-1")]), (shown, 1));
        let values = scan("xxd", &[("c", b"300"), ("p", b"")]).expect("read");
        assert_eq!(values["cols"], json!(300));
        assert_eq!(scan("xxd", &[("p", b"")]).expect("read")["cols"], json!(30));
    }

    #[test]
    fn grep_context_takes_what_both_hosts_took() {
        for (raw, value) in [
            (" 5", 5u64),
            ("+5", 5),
            ("5 ", 5),
            ("1_0", 10),
            ("-0", 0),
            ("05", 5),
            ("\u{a0}5\u{3000}", 5),
            ("99999999999999999999", u64::MAX),
        ] {
            let values = scan("grep", &[("after_context", raw.as_bytes())]).expect(raw);
            assert_eq!(values["after_context"], json!(value), "{raw}");
        }
        for raw in [
            "",
            "x",
            "-1",
            "0x5",
            "1e3",
            "1__0",
            "_1",
            "1_",
            "\u{661}",
            "\u{85}5",
            "\u{feff}5",
            "\x1c5",
        ] {
            let shown = format!("grep: {raw}: invalid context length argument");
            let refused = refusal("grep", &[("after_context", raw.as_bytes())]);
            assert_eq!(
                refused,
                (shown.chars().map(|c| c.to_string()).collect::<String>(), 2)
            );
        }
    }

    #[test]
    fn grep_reads_each_option_at_its_last_and_checks_in_greps_order() {
        let typed: &[(&str, &[u8])] = &[("after_context", b"x"), ("after_context", b"1")];
        assert_eq!(
            scan("grep", typed).expect("read")["after_context"],
            json!(1)
        );
        let typed: &[(&str, &[u8])] = &[("context", b"3"), ("after_context", b"0")];
        let values = scan("grep", typed).expect("read");
        assert_eq!(
            (&values["after_context"], &values["before_context"]),
            (&json!(0), &json!(3))
        );
        let typed: &[(&str, &[u8])] = &[
            ("max_count", b"y"),
            ("directories", b"z"),
            ("after_context", b"x"),
            ("binary_files", b"v"),
        ];
        assert_eq!(
            refusal("grep", typed),
            ("grep: unknown binary-files type".to_owned(), 2)
        );
        let typed: &[(&str, &[u8])] = &[("max_count", b"y"), ("directories", b"z")];
        assert_eq!(refusal("grep", typed).1, 1);
    }

    #[test]
    fn grep_max_count_takes_blanks_a_sign_and_digits() {
        for (raw, value) in [
            (" 5", json!(5)),
            ("+1", json!(1)),
            ("-1", json!(null)),
            ("-0", json!(0)),
        ] {
            assert_eq!(
                scan("grep", &[("max_count", raw.as_bytes())]).expect(raw)["max_count"],
                value
            );
        }
        for raw in ["5 ", "1_0", "0x5", "", "\u{a0}1"] {
            let refused = refusal("grep", &[("max_count", raw.as_bytes())]);
            assert_eq!(refused, ("grep: invalid max count".to_owned(), 2), "{raw}");
        }
    }

    #[test]
    fn grep_directories_take_a_prefix_and_devices_only_the_word() {
        for (typed, action) in [
            (&[("directories", b"rec".as_slice())][..], "recurse"),
            (
                &[("recursive", b"".as_slice()), ("directories", b"s")][..],
                "skip",
            ),
            (
                &[
                    ("directories", b"skip".as_slice()),
                    ("dereference_recursive", b""),
                ][..],
                "recurse",
            ),
        ] {
            assert_eq!(
                scan("grep", typed).expect("read")["directories"],
                json!(action)
            );
        }
        let (shown, status) = refusal("grep", &[("directories", b"re")]);
        assert_eq!(status, 1);
        assert_eq!(
            shown,
            "grep: ambiguous argument 're' for '--directories'\nValid arguments are:\n  - 'read'\n  \
             - 'recurse'\n  - 'skip'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' \
             for more information."
        );
        let (shown, _) = refusal(
            "grep",
            &[
                ("directories", "x\u{e9}'".as_bytes()),
                ("directories", b"read"),
            ],
        );
        assert!(shown.starts_with("grep: invalid argument 'x\\303\\251\\'' for '--directories'"));
        let typed: &[(&str, &[u8])] = &[("devices", b"x"), ("devices", b"skip")];
        assert_eq!(
            refusal("grep", typed),
            ("grep: unknown devices method".to_owned(), 2)
        );
        let values = scan("grep", &[("devices", b"skip")]).expect("read");
        assert_eq!(values["skip_devices"], json!(true));
    }

    #[test]
    fn grep_binary_mode_is_the_last_of_its_group() {
        for (typed, mode) in [
            (
                &[("text", b"".as_slice()), ("binary_files", b"binary")][..],
                "binary",
            ),
            (
                &[("binary_files", b"text".as_slice()), ("args_I", b"")][..],
                "without-match",
            ),
            (&[][..], "binary"),
        ] {
            assert_eq!(
                scan("grep", typed).expect("read")["binary_mode"],
                json!(mode)
            );
        }
    }

    #[test]
    fn a_command_without_a_grammar_is_refused() {
        let refused = open("scan", br#"{"command":"nope","options":[]}"#)
            .err()
            .expect("refused");
        assert_eq!(refused.message, "scan: no grammar for nope");
    }

    #[test]
    fn a_value_past_one_byte_per_character_is_refused() {
        let refused = open(
            "scan",
            "{\"command\":\"nope\",\"options\":[[\"n\",\"\u{100}\"]]}".as_bytes(),
        )
        .err()
        .expect("refused");
        assert_eq!(
            refused.message,
            "a scanned value holds a character past U+00FF"
        );
    }
}
