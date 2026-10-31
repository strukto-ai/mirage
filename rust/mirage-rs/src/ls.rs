//! ls's typed values (coreutils 9.7). Each `--sort`, `--time`,
//! `--hyperlink`, `--color`, `--classify`, `--indicator-style` and
//! `--block-size` is checked where it was typed, so the first bad one
//! names the refusal; `--time-style` is read once the options are, its
//! last value only. The last of `-t -S -X -v -U --sort` sets the sort, of
//! `-c -u --time` the time, of `-F --classify -p --file-type
//! --indicator-style` the indicator, and the later of `-h` and
//! `--block-size` the size scale. The host sends a bare `--classify`,
//! `--hyperlink` or `--color` as `always`, the word GNU reads it as.

use serde_json::{Value as Json, json};

use crate::number::BLANKS;
use crate::scan::{Typed, Values, unknown};
use crate::word::{self, Choice};
use crate::{StreamError, byte_text};

const SORT: &[Choice] = &[
    &["none"],
    &["size"],
    &["time"],
    &["version"],
    &["extension"],
    &["name"],
    &["width"],
];
const TIME: &[Choice] = &[
    &["atime", "access", "use"],
    &["ctime", "status"],
    &["mtime", "modification"],
    &["birth", "creation"],
];
const WHEN: &[Choice] = &[
    &["always", "yes", "force"],
    &["never", "no", "none"],
    &["auto", "tty", "if-tty"],
];
const INDICATOR: &[Choice] = &[&["none"], &["slash"], &["file-type"], &["classify"]];
const TIME_STYLE: &[Choice] = &[&["full-iso"], &["long-iso"], &["iso"], &["locale"]];

/// The `--time-style` choices as GNU lists them, patterns rather than
/// words.
const TIME_STYLES_LISTED: &str = "Valid arguments are:\n  - [posix-]full-iso\n  \
     - [posix-]long-iso\n  - [posix-]iso\n  - [posix-]locale\n  \
     - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n\
     Try 'ls --help' for more information.";

/// `--block-size`'s unit letters, each the next power of 1024; only the
/// first four also in lower case.
const UNITS: &[u8] = b"KMGTPEZY";

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let mut sort = Json::Null;
    let mut time = "mtime";
    let mut indicator = "none";
    let mut hyperlink = false;
    let mut block = Json::Null;
    let mut time_style: Option<&[u8]> = None;
    for (name, raw) in options {
        match name.as_str() {
            "sort" => sort = Json::from(word::choose("ls", "--sort", raw, SORT, 1)?),
            "t" => sort = json!("time"),
            "S" => sort = json!("size"),
            "X" => sort = json!("extension"),
            "v" => sort = json!("version"),
            "U" => sort = json!("none"),
            "time" => time = word::choose("ls", "--time", raw, TIME, 1)?,
            "c" => time = "ctime",
            "u" => time = "atime",
            "hyperlink" => hyperlink = word::choose("ls", "--hyperlink", raw, WHEN, 1)? == "always",
            "color" => {
                word::choose("ls", "--color", raw, WHEN, 1)?;
            }
            "classify" => {
                let when = word::choose("ls", "--classify", raw, WHEN, 1)?;
                indicator = if when == "always" { "classify" } else { "none" };
            }
            "indicator_style" => {
                indicator = word::choose("ls", "--indicator-style", raw, INDICATOR, 1)?;
            }
            "p" => indicator = "slash",
            "file_type" => indicator = "file-type",
            "block_size" => block = block_size(raw)?,
            "human_readable" => block = Json::Null,
            "time_style" => time_style = Some(raw),
            _ => return Err(unknown("ls", name)),
        }
    }
    let mut values = Values::new();
    values.insert("sort".to_owned(), sort);
    values.insert("time".to_owned(), json!(time));
    values.insert("indicator".to_owned(), json!(indicator));
    values.insert("hyperlink".to_owned(), json!(hyperlink));
    values.insert("block_size".to_owned(), block);
    values.insert(
        "time_style".to_owned(),
        json!(time_style.map_or(Ok("locale".to_owned()), style)?),
    );
    Ok(values)
}

/// `--time-style`: any `posix-` spelling is the locale style, since there
/// is no other locale; `+FORMAT` comes back whole; anything else is one
/// of the named styles, refused with exit 2.
fn style(raw: &[u8]) -> Result<String, StreamError> {
    if raw.starts_with(b"posix-") {
        return Ok("locale".to_owned());
    }
    if raw.starts_with(b"+") {
        return Ok(byte_text(raw));
    }
    word::matched(raw, TIME_STYLE)
        .map(str::to_owned)
        .map_err(|why| {
            let refused = format!(
                "{}\n{TIME_STYLES_LISTED}",
                word::line("ls", "time style", raw, why)
            );
            StreamError::refusal(refused.as_bytes(), 2)
        })
}

/// `--block-size=SIZE`: `human-readable` or `si`, or an optional count
/// read as `strtoumax` reads a decimal one, then an optional unit letter,
/// `B` after it making it decimal and `iB` keeping it binary. A unit
/// alone is echoed after each size. A suffix failure outranks a size past
/// `u64`, which outranks a zero size; each exits 2 and quotes the word
/// unescaped. Deliberately decimal where `strtoumax` reads `0x` and `0`
/// prefixes as hexadecimal and octal.
fn block_size(raw: &[u8]) -> Result<Json, StreamError> {
    let refuse = |before: &str, after: &str| {
        let mut shown = before.as_bytes().to_vec();
        shown.push(b'\'');
        shown.extend_from_slice(raw);
        shown.push(b'\'');
        shown.extend_from_slice(after.as_bytes());
        Err(StreamError::refusal(&shown, 2))
    };
    let invalid = || refuse("ls: invalid --block-size argument ", "");
    let suffix = || refuse("ls: invalid suffix in --block-size argument ", "");
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
    let (count, unit) = body.split_at(digits);
    let power = |letter: u8| {
        let upper = letter.to_ascii_uppercase();
        let lower_ok = b"kmgt".contains(&letter) || letter.is_ascii_uppercase();
        UNITS
            .iter()
            .position(|&unit| unit == upper)
            .filter(|_| lower_ok)
            .map(|at| (upper, at as u32 + 1))
    };
    if count.is_empty() && unit.first().copied().and_then(power).is_none() {
        return invalid();
    }
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
        return refuse("ls: --block-size argument ", " too large");
    };
    if divisor == 0 {
        return invalid();
    }
    let shown = if digits == 0 { shown } else { String::new() };
    Ok(scale(divisor, &shown, None))
}

fn scale(divisor: u128, suffix: &str, human_base: Option<u32>) -> Json {
    json!({"divisor": divisor.to_string(), "suffix": suffix, "human_base": human_base})
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::scan::tests::{refusal, scan};

    fn values(typed: &[(&str, &[u8])]) -> serde_json::Value {
        scan("ls", typed).expect("read")
    }

    #[test]
    fn with_no_option_every_value_is_its_default() {
        assert_eq!(
            values(&[]),
            json!({
                "sort": null,
                "time": "mtime",
                "indicator": "none",
                "hyperlink": false,
                "block_size": null,
                "time_style": "locale",
            })
        );
    }

    #[test]
    fn the_last_spelling_of_each_setting_wins() {
        let typed: &[(&str, &[u8])] = &[("sort", b"non"), ("t", b"")];
        assert_eq!(values(typed)["sort"], json!("time"));
        let typed: &[(&str, &[u8])] = &[("S", b""), ("sort", b"ver")];
        assert_eq!(values(typed)["sort"], json!("version"));
        let typed: &[(&str, &[u8])] = &[("time", b"a"), ("c", b"")];
        assert_eq!(values(typed)["time"], json!("ctime"));
        let typed: &[(&str, &[u8])] = &[("u", b""), ("time", b"birth")];
        assert_eq!(values(typed)["time"], json!("birth"));
        let typed: &[(&str, &[u8])] = &[("classify", b"always"), ("p", b"")];
        assert_eq!(values(typed)["indicator"], json!("slash"));
        let typed: &[(&str, &[u8])] = &[("file_type", b""), ("classify", b"never")];
        assert_eq!(values(typed)["indicator"], json!("none"));
        let typed: &[(&str, &[u8])] = &[("p", b""), ("indicator_style", b"c")];
        assert_eq!(values(typed)["indicator"], json!("classify"));
        let typed: &[(&str, &[u8])] = &[("hyperlink", b"always"), ("hyperlink", b"auto")];
        assert_eq!(values(typed)["hyperlink"], json!(false));
        let typed: &[(&str, &[u8])] = &[("hyperlink", b"yes")];
        assert_eq!(values(typed)["hyperlink"], json!(true));
    }

    #[test]
    fn the_later_of_h_and_block_size_wins() {
        let typed: &[(&str, &[u8])] = &[("block_size", b"K"), ("human_readable", b"")];
        assert_eq!(values(typed)["block_size"], json!(null));
        let typed: &[(&str, &[u8])] = &[("human_readable", b""), ("block_size", b"K")];
        assert_eq!(
            values(typed)["block_size"],
            json!({"divisor": "1024", "suffix": "K", "human_base": null})
        );
        let typed: &[(&str, &[u8])] = &[("block_size", b"x"), ("human_readable", b"")];
        assert_eq!(refusal("ls", typed).1, 2);
    }

    #[test]
    fn a_block_size_is_a_count_then_a_unit() {
        for (raw, divisor, suffix, base) in [
            ("human-readable", "1024", "", json!(1024)),
            ("si", "1000", "", json!(1000)),
            ("4", "4", "", json!(null)),
            (" +1", "1", "", json!(null)),
            ("k", "1024", "K", json!(null)),
            ("K", "1024", "K", json!(null)),
            ("KB", "1000", "kB", json!(null)),
            ("KiB", "1024", "KiB", json!(null)),
            ("MB", "1000000", "MB", json!(null)),
            ("2K", "2048", "", json!(null)),
            ("010", "10", "", json!(null)),
            ("15E", "17293822569102704640", "", json!(null)),
            (
                "18446744073709551615",
                "18446744073709551615",
                "",
                json!(null),
            ),
        ] {
            assert_eq!(
                values(&[("block_size", raw.as_bytes())])["block_size"],
                json!({"divisor": divisor, "suffix": suffix, "human_base": base}),
                "{raw}"
            );
        }
    }

    #[test]
    fn a_block_size_refusal_quotes_the_word_unescaped_and_exits_two() {
        let shown = |raw: &str, how: &str| match how {
            "suffix" => format!("ls: invalid suffix in --block-size argument '{raw}'"),
            "large" => format!("ls: --block-size argument '{raw}' too large"),
            _ => format!("ls: invalid --block-size argument '{raw}'"),
        };
        for (raw, how) in [
            ("x", "invalid"),
            ("0", "invalid"),
            ("0K", "invalid"),
            ("iB", "invalid"),
            ("B", "invalid"),
            ("-1K", "invalid"),
            ("", "invalid"),
            ("+K", "invalid"),
            (" K", "invalid"),
            ("+ 1", "invalid"),
            ("bogus", "invalid"),
            ("1x", "suffix"),
            ("1e", "suffix"),
            ("Kx", "suffix"),
            ("1Ki", "suffix"),
            ("1.5K", "suffix"),
            ("1R", "suffix"),
            ("1 ", "suffix"),
            ("1p", "suffix"),
            ("Y", "large"),
            ("16E", "large"),
            ("18446744073709551616", "large"),
            (&"9".repeat(50), "large"),
        ] {
            assert_eq!(
                refusal("ls", &[("block_size", raw.as_bytes())]),
                (shown(raw, how), 2),
                "{raw:?}"
            );
        }
        assert_eq!(
            refusal("ls", &[("block_size", "1\u{e9}".as_bytes())]).0,
            "ls: invalid suffix in --block-size argument '1\u{e9}'"
        );
    }

    #[test]
    fn each_word_is_checked_where_it_was_typed() {
        let typed: &[(&str, &[u8])] = &[("sort", b"bogus"), ("sort", b"size")];
        assert!(
            refusal("ls", typed)
                .0
                .starts_with("ls: invalid argument 'bogus' for '--sort'")
        );
        let typed: &[(&str, &[u8])] = &[("time", b"x"), ("sort", b"y")];
        assert!(
            refusal("ls", typed)
                .0
                .starts_with("ls: invalid argument 'x' for '--time'")
        );
        let typed: &[(&str, &[u8])] = &[("time_style", b"x"), ("block_size", b"y")];
        assert!(
            refusal("ls", typed)
                .0
                .starts_with("ls: invalid --block-size")
        );
        let typed: &[(&str, &[u8])] = &[("color", b"x")];
        assert_eq!(refusal("ls", typed).1, 1);
        let typed: &[(&str, &[u8])] = &[("classify", b""), ("p", b"")];
        assert!(
            refusal("ls", typed)
                .0
                .starts_with("ls: ambiguous argument '' for '--classify'")
        );
    }

    #[test]
    fn a_word_refusal_lists_the_choices_and_exits_one() {
        assert_eq!(
            refusal("ls", &[("sort", b"n")]),
            (
                "ls: ambiguous argument 'n' for '--sort'\nValid arguments are:\n  - 'none'\n  \
                 - 'size'\n  - 'time'\n  - 'version'\n  - 'extension'\n  - 'name'\n  \
                 - 'width'\nTry 'ls --help' for more information."
                    .to_owned(),
                1
            )
        );
        assert_eq!(
            refusal("ls", &[("hyperlink", b"a")]).0,
            "ls: ambiguous argument 'a' for '--hyperlink'\nValid arguments are:\n  \
             - 'always', 'yes', 'force'\n  - 'never', 'no', 'none'\n  \
             - 'auto', 'tty', 'if-tty'\nTry 'ls --help' for more information."
        );
    }

    #[test]
    fn the_time_style_is_its_last_value_read_after_the_loop() {
        for (raw, style) in [
            ("full", "full-iso"),
            ("long-iso", "long-iso"),
            ("iso", "iso"),
            ("posix-zzz", "locale"),
            ("posix-", "locale"),
            ("+%Y/%m", "+%Y/%m"),
            ("+%Y\n%H", "+%Y\n%H"),
        ] {
            assert_eq!(
                values(&[("time_style", raw.as_bytes())])["time_style"],
                json!(style),
                "{raw:?}"
            );
        }
        let typed: &[(&str, &[u8])] = &[("time_style", b"x"), ("time_style", b"iso")];
        assert_eq!(values(typed)["time_style"], json!("iso"));
        let listed = "Valid arguments are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n  \
                      - [posix-]iso\n  - [posix-]locale\n  \
                      - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n\
                      Try 'ls --help' for more information.";
        assert_eq!(
            refusal("ls", &[("time_style", b"")]),
            (
                format!("ls: ambiguous argument '' for 'time style'\n{listed}"),
                2
            )
        );
        assert_eq!(
            refusal("ls", &[("time_style", b"x\x01")]).0,
            format!("ls: invalid argument 'x\\001' for 'time style'\n{listed}")
        );
        let typed: &[(&str, &[u8])] = &[("time_style", b"x"), ("sort", b"y")];
        assert!(refusal("ls", typed).0.contains("for '--sort'"));
    }
}
