//! ripgrep's option values, read once here before the host walks a path.
//! The host sends every option that carries a value, with the switches
//! that decide which of them wins, each as typed and in the order typed.
//! A scalar option typed twice is read at its last occurrence, and the
//! values are checked in the order the hosts checked them, so a line with
//! two bad values names the same one it always has.

use serde_json::Value as Json;

use crate::scan::{self, Typed, Values};
use crate::{StreamError, rg_input};

const SORT_KEYS: [&str; 5] = ["path", "modified", "accessed", "created", "none"];
const COLOR_CHOICES: [&str; 4] = ["never", "auto", "always", "ansi"];
const ENGINES: [&str; 3] = ["default", "pcre2", "auto"];
/// What `--colors` takes (ripgrep 14.1.1 and termcolor): OUT:SPEC[:VALUE].
const COLOR_OUTPUTS: [&str; 4] = ["path", "line", "column", "match"];
const COLOR_SPECS: [&str; 4] = ["fg", "bg", "style", "none"];
const COLOR_NAMES: [&str; 8] = [
    "black", "blue", "green", "red", "cyan", "magenta", "yellow", "white",
];
const COLOR_STYLES: [&str; 6] = [
    "nobold",
    "bold",
    "nointense",
    "intense",
    "nounderline",
    "underline",
];
/// What `--hyperlink-format` takes: an alias or a URL with variables.
const HYPERLINK_ALIASES: [&str; 10] = [
    "default",
    "file",
    "grep+",
    "kitty",
    "macvim",
    "none",
    "textmate",
    "vscode",
    "vscode-insiders",
    "vscodium",
];
const HYPERLINK_VARIABLES: [&str; 5] = ["path", "line", "column", "host", "wslprefix"];

/// The options this grammar reads; anything else is the host's mistake.
const NAMES: [&str; 31] = [
    "threads",
    "encoding",
    "no_encoding",
    "color",
    "colors",
    "hyperlink_format",
    "dfa_size_limit",
    "regex_size_limit",
    "passthru",
    "passthrough",
    "after_context",
    "before_context",
    "context",
    "sort",
    "sortr",
    "sort_files",
    "no_sort_files",
    "pcre2",
    "no_pcre2",
    "engine",
    "auto_hybrid_regex",
    "no_auto_hybrid_regex",
    "max_columns",
    "path_separator",
    "max_count",
    "max_depth",
    "max_filesize",
    "context_separator",
    "no_context_separator",
    "field_match_separator",
    "field_context_separator",
];

/// rg's option values, or the first one it refuses in its words, exit 2.
pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    if let Some((name, _)) = options
        .iter()
        .find(|(name, _)| !NAMES.contains(&name.as_str()))
    {
        return Err(scan::unknown("rg", name));
    }
    let latest = scan::latest(options);
    let last = |name: &str| scan::last(options, name);
    let winner = |names: &[&str]| {
        latest
            .iter()
            .rev()
            .find(|(name, _)| names.contains(&name.as_str()))
            .map(|(name, _)| name.as_str())
    };
    let mut values = Values::new();
    let threads = last("threads")
        .map(|raw| number("threads", raw))
        .transpose()?;
    values.insert("threads".to_owned(), Json::from(threads));
    values.insert("encoding".to_owned(), Json::from(encoding(options)?));
    if let Some(raw) = last("color") {
        choice("--color", raw, &COLOR_CHOICES)?;
    }
    for raw in all(options, "colors") {
        if let Some(reason) = color_refusal(raw) {
            return Err(flag_error("--colors", &reason));
        }
    }
    for raw in all(options, "hyperlink_format") {
        if let Some(reason) = hyperlink_refusal(raw) {
            let mut shown = b"invalid hyperlink format: ".to_vec();
            shown.extend_from_slice(&reason);
            return Err(flag_error("--hyperlink-format", &shown));
        }
    }
    for name in ["dfa_size_limit", "regex_size_limit"] {
        values.insert(name.to_owned(), Json::from(size(options, name)?));
    }
    let (passthru, before, after) = context(&latest)?;
    values.insert("passthru".to_owned(), Json::from(passthru));
    values.insert("context_before".to_owned(), Json::from(before));
    values.insert("context_after".to_owned(), Json::from(after));
    let sort_flag = winner(&["sort", "sortr", "sort_files", "no_sort_files"]);
    let sort = match sort_flag {
        Some("sort_files") => Some("path"),
        Some(flag @ ("sort" | "sortr")) => {
            let raw = last(flag).unwrap_or_default();
            Some(choice(&format!("--{flag}"), raw, &SORT_KEYS)?)
        }
        _ => None,
    };
    if sort == Some("created") {
        return Err(StreamError::refusal(
            b"rg: sorting by creation time is not supported by the virtual filesystem",
            2,
        ));
    }
    values.insert("sort".to_owned(), Json::from(sort));
    values.insert(
        "sort_reverse".to_owned(),
        Json::from(sort_flag == Some("sortr")),
    );
    let engine = match winner(&[
        "pcre2",
        "no_pcre2",
        "engine",
        "auto_hybrid_regex",
        "no_auto_hybrid_regex",
    ]) {
        Some("pcre2") => "pcre2",
        Some("auto_hybrid_regex") => "auto",
        Some("engine") => {
            let raw = last("engine").unwrap_or_default();
            ENGINES
                .into_iter()
                .find(|engine| engine.as_bytes() == raw)
                .ok_or_else(|| {
                    let mut reason = b"unrecognized regex engine '".to_vec();
                    reason.extend_from_slice(raw);
                    reason.push(b'\'');
                    flag_error("--engine", &reason)
                })?
        }
        _ => "default",
    };
    values.insert("engine".to_owned(), Json::from(engine));
    let max_columns = last("max_columns")
        .map(|raw| number("max_columns", raw))
        .transpose()?;
    values.insert("max_columns".to_owned(), Json::from(max_columns));
    values.insert(
        "path_separator".to_owned(),
        text(path_separator(last("path_separator"))?),
    );
    for name in ["max_count", "max_depth"] {
        let value = last(name).map(|raw| number(name, raw)).transpose()?;
        values.insert(name.to_owned(), Json::from(value));
    }
    values.insert(
        "max_filesize".to_owned(),
        Json::from(size(options, "max_filesize")?),
    );
    let separator = (winner(&["context_separator", "no_context_separator"])
        != Some("no_context_separator"))
    .then(|| last("context_separator").map_or_else(|| b"--".to_vec(), unescape));
    values.insert("context_separator".to_owned(), text(separator));
    for (name, default) in [
        ("field_match_separator", ":"),
        ("field_context_separator", "-"),
    ] {
        let raw = last(name).unwrap_or(default.as_bytes());
        values.insert(name.to_owned(), text(Some(unescape(raw))));
    }
    Ok(values)
}

/// Every occurrence of option `name`, in the order typed.
fn all<'a>(options: &'a [Typed], name: &'a str) -> impl Iterator<Item = &'a [u8]> {
    options
        .iter()
        .filter(move |(typed, _)| typed == name)
        .map(|(_, raw)| raw.as_slice())
}

/// Bytes as the host reads a byte view: one character per byte.
fn text(bytes: Option<Vec<u8>>) -> Json {
    bytes.map_or(Json::Null, |bytes| {
        Json::from(bytes.into_iter().map(char::from).collect::<String>())
    })
}

/// ripgrep's refusal of an option value it cannot parse, exit 2.
fn flag_error(spelling: &str, reason: &[u8]) -> StreamError {
    let mut stderr = format!("rg: error parsing flag {spelling}: ").into_bytes();
    stderr.extend_from_slice(reason);
    StreamError::refusal(&stderr, 2)
}

/// A value from a fixed set, refused in ripgrep's words.
fn choice(
    spelling: &str,
    raw: &[u8],
    choices: &[&'static str],
) -> Result<&'static str, StreamError> {
    choices
        .iter()
        .find(|choice| choice.as_bytes() == raw)
        .copied()
        .ok_or_else(|| {
            let mut reason = b"choice '".to_vec();
            reason.extend_from_slice(raw);
            reason.extend_from_slice(b"' is unrecognized");
            flag_error(spelling, &reason)
        })
}

/// One count as ripgrep reads it, an unsigned 64-bit integer after an
/// optional `+`, named under the option's short spelling: the line's
/// spelling never reached the hosts, so a long one is named short too.
fn number(name: &str, raw: &[u8]) -> Result<u64, StreamError> {
    let spelling = match name {
        "max_count" => "-m",
        "after_context" => "-A",
        "before_context" => "-B",
        "context" => "-C",
        "max_depth" => "-d",
        "threads" => "-j",
        _ => "-M",
    };
    let digits = raw.strip_prefix(b"+").unwrap_or(raw);
    let reason = if raw.is_empty() {
        "cannot parse integer from empty string"
    } else if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        "invalid digit found in string"
    } else {
        let value = digits.iter().try_fold(0u64, |value, &digit| {
            value.checked_mul(10)?.checked_add(u64::from(digit - b'0'))
        });
        match value {
            Some(value) => return Ok(value),
            None => "number too large to fit in target type",
        }
    };
    let shown = format!("value is not a valid number: {reason}");
    Err(flag_error(spelling, shown.as_bytes()))
}

/// `-E` resolved in line order: auto, none, or the WHATWG encoding a label
/// names, `--no-encoding` going back to auto. ripgrep checks every label
/// as it reads it, so an earlier bad one is refused too (14.1.1).
fn encoding(options: &[Typed]) -> Result<String, StreamError> {
    let mut found = "auto".to_owned();
    for (name, raw) in options {
        match name.as_str() {
            "no_encoding" => found = "auto".to_owned(),
            "encoding" if raw == b"auto" || raw == b"none" => {
                found = String::from_utf8_lossy(raw).into_owned();
            }
            "encoding" => {
                let named = std::str::from_utf8(raw).ok().and_then(rg_input::encoding);
                let Some(named) = named else {
                    let mut reason = b"grep config error: unknown encoding: ".to_vec();
                    reason.extend_from_slice(raw);
                    return Err(flag_error("-E", &reason));
                };
                found = named.name().to_owned();
            }
            _ => {}
        }
    }
    Ok(found)
}

/// A size option's last value in bytes; ripgrep parses every occurrence
/// as it reads it, so an earlier bad one is refused too.
fn size(options: &[Typed], name: &str) -> Result<Option<u64>, StreamError> {
    let spelling = match name {
        "max_filesize" => "--max-filesize",
        "dfa_size_limit" => "--dfa-size-limit",
        _ => "--regex-size-limit",
    };
    let mut found = None;
    for raw in all(options, name) {
        found = Some(size_bytes(spelling, raw)?);
    }
    Ok(found)
}

/// Digits and an optional K, M or G that fit in 64 bits, refused in
/// ripgrep's words.
fn size_bytes(spelling: &str, raw: &[u8]) -> Result<u64, StreamError> {
    let (digits, unit) = match raw.split_last() {
        Some((b'K', digits)) => (digits, 1u64 << 10),
        Some((b'M', digits)) => (digits, 1 << 20),
        Some((b'G', digits)) => (digits, 1 << 30),
        _ => (raw, 1),
    };
    let shown = String::from_utf8_lossy(raw);
    let reason = if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        let mut reason = b"invalid format for size '".to_vec();
        reason.extend_from_slice(raw);
        reason.extend_from_slice(
            b"', which should be a non-empty sequence of digits followed by an optional 'K', \
              'M' or 'G' suffix",
        );
        reason
    } else {
        let value = digits.iter().try_fold(0u64, |value, &digit| {
            value.checked_mul(10)?.checked_add(u64::from(digit - b'0'))
        });
        match value.map(|value| value.checked_mul(unit)) {
            Some(Some(bytes)) => return Ok(bytes),
            Some(None) => format!("size too big in '{shown}'").into_bytes(),
            None => format!(
                "invalid integer found in size '{shown}': number too large to fit in target type"
            )
            .into_bytes(),
        }
    };
    let mut shown = b"invalid size: ".to_vec();
    shown.extend_from_slice(&reason);
    Err(flag_error(spelling, &shown))
}

/// `--passthru` and `-A`/`-B`/`-C` in line order, as ripgrep's ContextMode
/// resolves them: `--passthru` replaces every context option before it,
/// and a context option after it replaces it and starts afresh. `-A` and
/// `-B`, even at 0, outrank `-C` for their own side.
fn context(latest: &[&Typed]) -> Result<(bool, u64, u64), StreamError> {
    let mut passthru = false;
    let mut counts: [Option<u64>; 3] = [None; 3];
    for (name, raw) in latest {
        let slot = match name.as_str() {
            "passthru" | "passthrough" => {
                passthru = true;
                counts = [None; 3];
                continue;
            }
            "before_context" => 0,
            "after_context" => 1,
            "context" => 2,
            _ => continue,
        };
        passthru = false;
        counts[slot] = Some(number(name, raw)?);
    }
    let [before, after, both] = counts;
    let both = both.unwrap_or(0);
    Ok((passthru, before.unwrap_or(both), after.unwrap_or(both)))
}

/// A separator's escapes read as ripgrep reads them: `\t`, `\n`, `\r`,
/// `\0`, `\\` and `\xHH`, the last written as the UTF-8 of U+00HH.
fn unescape(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if let [b'\\', b'x', high, low, ..] = raw[i..] {
            if high.is_ascii_hexdigit() && low.is_ascii_hexdigit() {
                let hex = [high, low];
                let code = std::str::from_utf8(&hex)
                    .ok()
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                    .unwrap_or_default();
                let mut utf8 = [0; 2];
                out.extend_from_slice(char::from(code).encode_utf8(&mut utf8).as_bytes());
                i += 4;
                continue;
            }
        }
        let escaped = match raw[i..] {
            [b'\\', b't', ..] => Some(b'\t'),
            [b'\\', b'n', ..] => Some(b'\n'),
            [b'\\', b'r', ..] => Some(b'\r'),
            [b'\\', b'0', ..] => Some(0),
            [b'\\', b'\\', ..] => Some(b'\\'),
            _ => None,
        };
        if let Some(byte) = escaped {
            out.push(byte);
            i += 2;
        } else {
            out.push(raw[i]);
            i += 1;
        }
    }
    out
}

/// `--path-separator`'s one byte, None for ripgrep's own `/`; anything
/// but one byte is refused, an empty one standing for the default.
fn path_separator(raw: Option<&[u8]>) -> Result<Option<Vec<u8>>, StreamError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let separator = unescape(raw);
    match separator.len() {
        0 => Ok(None),
        1 => Ok(Some(separator)),
        len => {
            let mut reason = format!(
                "A path separator must be exactly one byte, but the given separator is {len} \
                 bytes: "
            )
            .into_bytes();
            reason.extend_from_slice(raw);
            reason.extend_from_slice(
                b"\nIn some shells on Windows '/' is automatically expanded. Use '//' instead.",
            );
            Err(flag_error("--path-separator", &reason))
        }
    }
}

/// Lower case as the hosts compared it, Unicode's mapping over the text:
/// ripgrep 14.1.1 takes `blac\u{212A}` (the Kelvin sign) for black too.
fn lower(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).to_lowercase()
}

fn joined(words: &[&str]) -> String {
    words.join(", ")
}

/// Why ripgrep refuses one `--colors` spec, or None.
fn color_refusal(spec: &[u8]) -> Option<Vec<u8>> {
    let pieces: Vec<&[u8]> = spec.split(|&b| b == b':').collect();
    let mut malformed = b"invalid color spec format: '".to_vec();
    malformed.extend_from_slice(spec);
    malformed
        .extend_from_slice(b"'. Valid format is '(path|line|column|match):(fg|bg|style):(value)'.");
    if !(2..=3).contains(&pieces.len()) {
        return Some(malformed);
    }
    let unrecognized = |what: &str, piece: &[u8], words: &[&str], end: &str| {
        let mut reason = format!("unrecognized {what} '").into_bytes();
        reason.extend_from_slice(piece);
        reason.extend_from_slice(format!("'. Choose from: {}{end}", joined(words)).as_bytes());
        reason
    };
    if !COLOR_OUTPUTS.contains(&lower(pieces[0]).as_str()) {
        return Some(unrecognized("output type", pieces[0], &COLOR_OUTPUTS, "."));
    }
    let kind = lower(pieces[1]);
    if !COLOR_SPECS.contains(&kind.as_str()) {
        return Some(unrecognized("spec type", pieces[1], &COLOR_SPECS, "."));
    }
    if kind == "none" {
        return None;
    }
    let Some(&value) = pieces.get(2) else {
        return Some(malformed);
    };
    if kind == "style" {
        return (!COLOR_STYLES.contains(&lower(value).as_str()))
            .then(|| unrecognized("style attribute", value, &COLOR_STYLES, "."));
    }
    color_value_refusal(value)
}

/// Whether termcolor reads `code` as a color number, decimal or `0x` hex,
/// from 0 to 255.
fn color_number(code: &[u8]) -> bool {
    let (digits, radix) = match code.strip_prefix(b"0x") {
        Some(hex) => (hex, 16),
        None => (code, 10),
    };
    let digits = digits.strip_prefix(b"+").unwrap_or(digits);
    !digits.is_empty()
        && digits.iter().all(|&b| char::from(b).is_digit(radix))
        && digits
            .iter()
            .try_fold(0u32, |value, &b| {
                let value = value * radix + char::from(b).to_digit(radix)?;
                (value <= 255).then_some(value)
            })
            .is_some()
}

/// Why termcolor refuses a color: a name, 0-255 or an r,g,b triple.
fn color_value_refusal(value: &[u8]) -> Option<Vec<u8>> {
    let codes: Vec<&[u8]> = value.split(|&b| b == b',').collect();
    if COLOR_NAMES.contains(&lower(value).as_str())
        || ([1, 3].contains(&codes.len()) && codes.iter().all(|code| color_number(code)))
    {
        return None;
    }
    let (head, tail) = if codes.len() == 1 && value.iter().all(u8::is_ascii_hexdigit) {
        (
            "unrecognized ansi256 color number, should be '[0-255]' (or a hex number), but is '",
            "'".to_owned(),
        )
    } else if value.contains(&b',') {
        (
            "unrecognized RGB color triple, should be '[0-255],[0-255],[0-255]' (or a hex \
             triple), but is '",
            "'".to_owned(),
        )
    } else {
        (
            "unrecognized color name '",
            format!("'. Choose from: {}", joined(&COLOR_NAMES)),
        )
    };
    let mut reason = head.as_bytes().to_vec();
    reason.extend_from_slice(value);
    reason.extend_from_slice(tail.as_bytes());
    Some(reason)
}

/// Why ripgrep refuses a `--hyperlink-format`, or None.
fn hyperlink_refusal(format: &[u8]) -> Option<Vec<u8>> {
    if format.is_empty()
        || HYPERLINK_ALIASES
            .iter()
            .any(|alias| alias.as_bytes() == format)
    {
        return None;
    }
    let mut names: Vec<&[u8]> = Vec::new();
    let mut head = Vec::new();
    let mut i = 0;
    while i < format.len() {
        match &format[i..] {
            [b'{', b'{', ..] | [b'}', b'}', ..] => {
                if names.is_empty() {
                    head.push(format[i]);
                }
                i += 2;
            }
            [b'{', ..] => {
                let Some(end) = format[i..].iter().position(|&b| b == b'}') else {
                    return Some(
                        b"unclosed variable: found '{' without a corresponding '}' following it"
                            .to_vec(),
                    );
                };
                let name = &format[i + 1..i + end];
                if !HYPERLINK_VARIABLES.iter().any(|var| var.as_bytes() == name) {
                    let mut reason = b"invalid hyperlink format variable: '".to_vec();
                    reason.extend_from_slice(name);
                    reason.extend_from_slice(
                        format!("', choose from: {}", joined(&HYPERLINK_VARIABLES)).as_bytes(),
                    );
                    return Some(reason);
                }
                names.push(name);
                i += end + 1;
            }
            [b'}', ..] => {
                return Some(
                    b"unopened variable: found '}' without a corresponding '{' preceding it"
                        .to_vec(),
                );
            }
            _ => {
                if names.is_empty() {
                    head.push(format[i]);
                }
                i += 1;
            }
        }
    }
    let has = |var: &str| names.contains(&var.as_bytes());
    let reason = if names.is_empty() {
        format!(
            "at least a {{path}} variable is required in a hyperlink format, or otherwise use \
             a valid alias: {}",
            joined(&HYPERLINK_ALIASES)
        )
    } else if !has("path") {
        "the {path} variable is required in a hyperlink format".to_owned()
    } else if has("column") && !has("line") {
        "the hyperlink format contains a {column} variable, but no {line} variable is present"
            .to_owned()
    } else if !url_scheme(&head) {
        "the hyperlink format must start with a valid URL scheme, i.e., [0-9A-Za-z+-.]+:".to_owned()
    } else {
        return None;
    };
    Some(reason.into_bytes())
}

/// Whether `head` starts with a URL scheme and its colon.
fn url_scheme(head: &[u8]) -> bool {
    let len = head
        .iter()
        .position(|&b| !(b.is_ascii_alphanumeric() || b"+.-".contains(&b)))
        .unwrap_or(head.len());
    len > 0 && head.get(len) == Some(&b':')
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as Json, json};

    use crate::open;

    fn scan(options: &[(&str, &[u8])]) -> Result<Json, (String, i32)> {
        let options: Vec<(&str, String)> = options
            .iter()
            .map(|(name, raw)| (*name, raw.iter().map(|&b| char::from(b)).collect()))
            .collect();
        let config = json!({"command": "rg", "options": options}).to_string();
        let mut stream = open("scan", config.as_bytes())
            .map_err(|e| (String::from_utf8_lossy(&e.stderr()).into_owned(), e.status))?;
        let mut out = Vec::new();
        stream.finish(&mut out).expect("finished");
        Ok(serde_json::from_slice(&out).expect("json"))
    }

    fn refusal(options: &[(&str, &[u8])]) -> String {
        let (stderr, status) = scan(options).expect_err("refused");
        assert_eq!(status, 2, "{stderr}");
        stderr
    }

    #[test]
    fn defaults_name_every_value() {
        assert_eq!(
            scan(&[]).expect("read"),
            json!({
                "threads": null, "encoding": "auto", "dfa_size_limit": null,
                "regex_size_limit": null, "passthru": false, "context_before": 0,
                "context_after": 0, "sort": null, "sort_reverse": false,
                "engine": "default", "max_columns": null, "path_separator": null,
                "max_count": null, "max_depth": null, "max_filesize": null,
                "context_separator": "--", "field_match_separator": ":",
                "field_context_separator": "-",
            })
        );
    }

    #[test]
    fn numbers_take_digits_after_one_plus() {
        let values = scan(&[("max_count", b"+7"), ("threads", b"18446744073709551615")]);
        let values = values.expect("read");
        assert_eq!(
            (&values["max_count"], &values["threads"]),
            (&json!(7), &json!(u64::MAX))
        );
        for (raw, reason) in [
            ("", "cannot parse integer from empty string"),
            ("+", "invalid digit found in string"),
            ("-1", "invalid digit found in string"),
            (" 1", "invalid digit found in string"),
            (
                "18446744073709551616",
                "number too large to fit in target type",
            ),
        ] {
            let shown = format!("rg: error parsing flag -m: value is not a valid number: {reason}");
            assert_eq!(refusal(&[("max_count", raw.as_bytes())]), shown);
        }
    }

    #[test]
    fn a_scalar_typed_twice_is_read_at_its_last() {
        let values = scan(&[("max_count", b"x"), ("max_count", b"2")]).expect("read");
        assert_eq!(values["max_count"], json!(2));
    }

    #[test]
    fn context_follows_passthru_in_line_order() {
        let read = |options: &[(&str, &[u8])]| {
            let values = scan(options).expect("read");
            (
                values["passthru"].clone(),
                values["context_before"].clone(),
                values["context_after"].clone(),
            )
        };
        assert_eq!(
            read(&[("context", b"3"), ("after_context", b"0")]),
            (json!(false), json!(3), json!(0))
        );
        assert_eq!(
            read(&[("context", b"3"), ("passthru", b"")]),
            (json!(true), json!(0), json!(0))
        );
        assert_eq!(
            read(&[("passthru", b""), ("before_context", b"1")]),
            (json!(false), json!(1), json!(0))
        );
        assert_eq!(
            refusal(&[("context", b"x")]),
            "rg: error parsing flag -C: value is not a valid number: invalid digit found in string"
        );
    }

    #[test]
    fn refusals_keep_the_hosts_order() {
        let typed: &[(&str, &[u8])] = &[("max_count", b"x"), ("threads", b"y")];
        assert!(refusal(typed).starts_with("rg: error parsing flag -j:"));
        let typed: &[(&str, &[u8])] = &[("max_filesize", b"x"), ("color", b"y")];
        assert_eq!(
            refusal(typed),
            "rg: error parsing flag --color: choice 'y' is unrecognized"
        );
    }

    #[test]
    fn sort_and_engine_take_the_last_of_their_group() {
        let values = scan(&[("sort", b"bogus"), ("sortr", b"path")]).expect("read");
        assert_eq!(
            (&values["sort"], &values["sort_reverse"]),
            (&json!("path"), &json!(true))
        );
        let values = scan(&[("sort", b"bogus"), ("sort_files", b"")]).expect("read");
        assert_eq!(values["sort"], json!("path"));
        assert_eq!(
            refusal(&[("sortr", b"created")]),
            "rg: sorting by creation time is not supported by the virtual filesystem"
        );
        assert_eq!(
            refusal(&[("sort", b"size")]),
            "rg: error parsing flag --sort: choice 'size' is unrecognized"
        );
        let values = scan(&[("engine", b"bogus"), ("pcre2", b"")]).expect("read");
        assert_eq!(values["engine"], json!("pcre2"));
        let values = scan(&[("pcre2", b""), ("no_pcre2", b"")]).expect("read");
        assert_eq!(values["engine"], json!("default"));
        assert_eq!(
            scan(&[("auto_hybrid_regex", b"")]).expect("read")["engine"],
            json!("auto")
        );
        assert_eq!(
            refusal(&[("engine", b"fast")]),
            "rg: error parsing flag --engine: unrecognized regex engine 'fast'"
        );
    }

    #[test]
    fn every_encoding_label_is_checked() {
        assert_eq!(
            scan(&[("encoding", b"latin1")]).expect("read")["encoding"],
            json!("windows-1252")
        );
        let typed: &[(&str, &[u8])] = &[("encoding", b"utf-16le"), ("no_encoding", b"")];
        assert_eq!(scan(typed).expect("read")["encoding"], json!("auto"));
        let typed: &[(&str, &[u8])] = &[("encoding", b"bogus"), ("encoding", b"none")];
        assert_eq!(
            refusal(typed),
            "rg: error parsing flag -E: grep config error: unknown encoding: bogus"
        );
    }

    #[test]
    fn sizes_take_one_unit_and_fit_in_64_bits() {
        let values = scan(&[("max_filesize", b"x"), ("max_filesize", b"2K")]);
        assert!(values.is_err());
        let values = scan(&[("max_filesize", b"1G"), ("regex_size_limit", b"5")]).expect("read");
        assert_eq!(
            (&values["max_filesize"], &values["regex_size_limit"]),
            (&json!(1u64 << 30), &json!(5))
        );
        assert_eq!(
            refusal(&[("max_filesize", b"1T")]),
            "rg: error parsing flag --max-filesize: invalid size: invalid format for size '1T', \
             which should be a non-empty sequence of digits followed by an optional 'K', 'M' or \
             'G' suffix"
        );
        assert_eq!(
            refusal(&[("dfa_size_limit", b"17179869184G")]),
            "rg: error parsing flag --dfa-size-limit: invalid size: size too big in '17179869184G'"
        );
        assert_eq!(
            refusal(&[("regex_size_limit", b"18446744073709551616")]),
            "rg: error parsing flag --regex-size-limit: invalid size: invalid integer found in \
             size '18446744073709551616': number too large to fit in target type"
        );
    }

    #[test]
    fn separators_unescape_and_the_path_one_is_a_byte() {
        let typed: &[(&str, &[u8])] = &[
            ("context_separator", b"\\t\\x41\\xff\\\\x41"),
            ("field_match_separator", b"\\0"),
            ("path_separator", b"\\\\"),
        ];
        let values = scan(typed).expect("read");
        assert_eq!(values["context_separator"], json!("\tA\u{c3}\u{bf}\\x41"));
        assert_eq!(values["field_match_separator"], json!("\0"));
        assert_eq!(values["path_separator"], json!("\\"));
        let typed: &[(&str, &[u8])] = &[("context_separator", b"x"), ("no_context_separator", b"")];
        assert_eq!(scan(typed).expect("read")["context_separator"], json!(null));
        assert_eq!(
            scan(&[("path_separator", b"")]).expect("read")["path_separator"],
            json!(null)
        );
        assert_eq!(
            refusal(&[("path_separator", b"\\xff")]),
            "rg: error parsing flag --path-separator: A path separator must be exactly one \
             byte, but the given separator is 2 bytes: \\xff\nIn some shells on Windows '/' is \
             automatically expanded. Use '//' instead."
        );
    }

    #[test]
    fn colors_read_as_termcolor_reads_them() {
        for spec in [
            "match:fg:red",
            "PATH:BG:0x+ff",
            "line:style:Bold",
            "column:none",
            "match:fg:1,2,255",
            "match:fg:blac\u{212A}",
        ] {
            assert!(scan(&[("colors", spec.as_bytes())]).is_ok(), "{spec}");
        }
        for (spec, reason) in [
            (
                "match",
                "invalid color spec format: 'match'. Valid format is '(path|line|column|match):(fg|bg|style):(value)'.",
            ),
            (
                "x:fg:red",
                "unrecognized output type 'x'. Choose from: path, line, column, match.",
            ),
            (
                "match:fg",
                "invalid color spec format: 'match:fg'. Valid format is '(path|line|column|match):(fg|bg|style):(value)'.",
            ),
            (
                "match:fg:256",
                "unrecognized ansi256 color number, should be '[0-255]' (or a hex number), but is '256'",
            ),
            (
                "match:fg:",
                "unrecognized ansi256 color number, should be '[0-255]' (or a hex number), but is ''",
            ),
            (
                "match:fg:1,2",
                "unrecognized RGB color triple, should be '[0-255],[0-255],[0-255]' (or a hex triple), but is '1,2'",
            ),
            (
                "match:fg:pink",
                "unrecognized color name 'pink'. Choose from: black, blue, green, red, cyan, magenta, yellow, white",
            ),
            (
                "match:style:wavy",
                "unrecognized style attribute 'wavy'. Choose from: nobold, bold, nointense, intense, nounderline, underline.",
            ),
        ] {
            assert_eq!(
                refusal(&[("colors", spec.as_bytes())]),
                format!("rg: error parsing flag --colors: {reason}")
            );
        }
    }

    #[test]
    fn hyperlink_formats_need_a_scheme_and_a_path() {
        for format in [
            "",
            "vscode",
            "file://{host}{path}",
            "x+y:{{{path}:{line}:{column}",
        ] {
            assert!(
                scan(&[("hyperlink_format", format.as_bytes())]).is_ok(),
                "{format}"
            );
        }
        for (format, reason) in [
            (
                "file://{path",
                "unclosed variable: found '{' without a corresponding '}' following it",
            ),
            (
                "file://path}",
                "unopened variable: found '}' without a corresponding '{' preceding it",
            ),
            (
                "file://{nope}",
                "invalid hyperlink format variable: 'nope', choose from: path, line, column, host, wslprefix",
            ),
            (
                "file://x",
                "at least a {path} variable is required in a hyperlink format, or otherwise use a valid alias: default, file, grep+, kitty, macvim, none, textmate, vscode, vscode-insiders, vscodium",
            ),
            (
                "file://{line}",
                "the {path} variable is required in a hyperlink format",
            ),
            (
                "file://{path}:{column}",
                "the hyperlink format contains a {column} variable, but no {line} variable is present",
            ),
            (
                "{path}",
                "the hyperlink format must start with a valid URL scheme, i.e., [0-9A-Za-z+-.]+:",
            ),
        ] {
            assert_eq!(
                refusal(&[("hyperlink_format", format.as_bytes())]),
                format!(
                    "rg: error parsing flag --hyperlink-format: invalid hyperlink format: {reason}"
                )
            );
        }
    }

    #[test]
    fn an_option_outside_the_grammar_is_the_hosts_mistake() {
        let (stderr, status) = scan(&[("glob", b"*")]).expect_err("refused");
        assert_eq!(
            (stderr.as_str(), status),
            ("scan: rg reads no option glob", 1)
        );
    }
}
