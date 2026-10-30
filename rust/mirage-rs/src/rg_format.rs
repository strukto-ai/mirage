use serde::{Deserialize, Serialize};

use crate::{StreamError, latin1, parse_config};

#[derive(Default, Deserialize, Serialize)]
pub(crate) struct Totals {
    pub(crate) matches: u64,
    pub(crate) matched_lines: u64,
    pub(crate) with_match: u64,
    pub(crate) searched: u64,
    pub(crate) printed: u64,
    pub(crate) bytes_searched: u64,
    pub(crate) elapsed: f64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Message {
    Options {
        #[serde(default)]
        colors: Vec<String>,
        #[serde(default)]
        hyperlinks: Vec<String>,
        #[serde(default)]
        sizes: Vec<(String, String)>,
    },
    Lead {
        heading: bool,
        summary: bool,
        no_filename: bool,
        context: bool,
        #[serde(deserialize_with = "crate::latin1_opt")]
        separator: Option<Vec<u8>>,
        #[serde(deserialize_with = "crate::latin1_opt")]
        label: Option<Vec<u8>>,
        #[serde(deserialize_with = "latin1")]
        terminator: Vec<u8>,
        null: bool,
        printed: bool,
        binary: bool,
    },
    Encoding {
        label: String,
    },
    Begin {
        #[serde(deserialize_with = "latin1")]
        name: Vec<u8>,
    },
    End {
        #[serde(deserialize_with = "latin1")]
        name: Vec<u8>,
        nul: Option<u64>,
        selected: bool,
        matches: u64,
        matched_lines: u64,
        searched: u64,
        printed: u64,
        elapsed: f64,
    },
    Summary {
        totals: Totals,
        total: f64,
    },
    Stats {
        totals: Totals,
        total: f64,
    },
}

#[derive(Serialize)]
struct Event<T> {
    r#type: &'static str,
    data: T,
}

#[derive(Serialize)]
struct SummaryEvent<T> {
    data: T,
    r#type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Text<'a> {
    Text(&'a str),
    Bytes(String),
}

pub(crate) fn json_text(data: &[u8]) -> Text<'_> {
    match std::str::from_utf8(data) {
        Ok(text) => Text::Text(text),
        Err(_) => {
            let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut encoded = String::new();
            for chunk in data.chunks(3) {
                let a = chunk[0];
                let b = chunk.get(1).copied().unwrap_or(0);
                let c = chunk.get(2).copied().unwrap_or(0);
                encoded.push(char::from(table[usize::from(a >> 2)]));
                encoded.push(char::from(table[usize::from((a & 3) << 4 | b >> 4)]));
                encoded.push(if chunk.len() > 1 {
                    char::from(table[usize::from((b & 15) << 2 | c >> 6)])
                } else {
                    '='
                });
                encoded.push(if chunk.len() > 2 {
                    char::from(table[usize::from(c & 63)])
                } else {
                    '='
                });
            }
            Text::Bytes(encoded)
        }
    }
}

#[derive(Serialize)]
struct Begin<'a> {
    path: Text<'a>,
}

#[derive(Serialize)]
struct Duration {
    secs: u64,
    nanos: u32,
    human: String,
}

impl Duration {
    fn new(seconds: f64) -> Self {
        let total = (seconds * 1_000_000_000.0) as u64;
        Self {
            secs: total / 1_000_000_000,
            nanos: (total % 1_000_000_000) as u32,
            human: format!("{seconds:.6}s"),
        }
    }
}

#[derive(Serialize)]
struct OrderedDuration {
    human: String,
    nanos: u32,
    secs: u64,
}

impl From<Duration> for OrderedDuration {
    fn from(value: Duration) -> Self {
        Self {
            human: value.human,
            nanos: value.nanos,
            secs: value.secs,
        }
    }
}

#[derive(Serialize)]
struct Stats {
    elapsed: Duration,
    searches: u64,
    searches_with_match: u64,
    bytes_searched: u64,
    bytes_printed: u64,
    matched_lines: u64,
    matches: u64,
}

#[derive(Serialize)]
struct End<'a> {
    path: Text<'a>,
    binary_offset: Option<u64>,
    stats: Stats,
}

#[derive(Serialize)]
struct OrderedStats {
    bytes_printed: u64,
    bytes_searched: u64,
    elapsed: OrderedDuration,
    matched_lines: u64,
    matches: u64,
    searches: u64,
    searches_with_match: u64,
}

#[derive(Serialize)]
struct Summary {
    elapsed_total: OrderedDuration,
    stats: OrderedStats,
}

fn line<T: Serialize>(message: &T, out: &mut Vec<u8>) -> Result<(), StreamError> {
    serde_json::to_writer(&mut *out, message).map_err(|err| StreamError::new(err.to_string()))?;
    out.push(b'\n');
    Ok(())
}

pub(crate) fn format(input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
    match parse_config(input)? {
        Message::Options {
            colors,
            hyperlinks,
            sizes,
        } => {
            for spec in colors {
                if let Some(reason) = color_refusal(&spec) {
                    return Err(flag_error("--colors", reason));
                }
            }
            for spec in hyperlinks {
                if let Some(reason) = hyperlink_refusal(&spec) {
                    return Err(flag_error(
                        "--hyperlink-format",
                        format!("invalid hyperlink format: {reason}"),
                    ));
                }
            }
            let mut result = std::collections::BTreeMap::new();
            for (dest, value) in sizes {
                result.insert(dest.clone(), size_bytes(&value, &dest)?);
            }
            serde_json::to_writer(out, &result).expect("rg sizes serialize");
            Ok(())
        }
        Message::Lead {
            heading,
            summary,
            no_filename,
            context,
            separator,
            label,
            terminator,
            null,
            printed,
            binary,
        } => {
            let headed = heading && !summary;
            let mut gap = Vec::new();
            if printed {
                if headed && !no_filename {
                    gap.push(b'\n');
                } else if context {
                    if let Some(separator) = separator {
                        gap.extend(separator);
                        gap.push(b'\n');
                    }
                }
            }
            let mut head = Vec::new();
            if headed && !binary {
                if let Some(label) = label {
                    head.extend(label);
                    if null {
                        head.push(0);
                    } else {
                        head.extend(terminator);
                    }
                }
            }
            serde_json::to_writer(out, &[gap, head]).expect("rg lead serializes");
            Ok(())
        }
        Message::Encoding { label } => {
            if let Some(encoding) = crate::rg_input::encoding(&label) {
                out.extend_from_slice(encoding.name().as_bytes());
            }
            Ok(())
        }
        Message::Begin { name } => line(
            &Event {
                r#type: "begin",
                data: Begin {
                    path: json_text(&name),
                },
            },
            out,
        ),
        Message::End {
            name,
            nul,
            selected,
            matches,
            matched_lines,
            searched,
            printed,
            elapsed,
        } => line(
            &Event {
                r#type: "end",
                data: End {
                    path: json_text(&name),
                    binary_offset: nul,
                    stats: Stats {
                        elapsed: Duration::new(elapsed),
                        searches: 1,
                        searches_with_match: u64::from(selected),
                        bytes_searched: searched,
                        bytes_printed: printed,
                        matched_lines,
                        matches,
                    },
                },
            },
            out,
        ),
        Message::Summary { totals: t, total } => line(
            &SummaryEvent {
                data: Summary {
                    elapsed_total: Duration::new(total).into(),
                    stats: OrderedStats {
                        bytes_printed: t.printed,
                        bytes_searched: t.bytes_searched,
                        elapsed: Duration::new(t.elapsed).into(),
                        matched_lines: t.matched_lines,
                        matches: t.matches,
                        searches: t.searched,
                        searches_with_match: t.with_match,
                    },
                },
                r#type: "summary",
            },
            out,
        ),
        Message::Stats { totals: t, total } => {
            out.extend_from_slice(format!("\n{} matches\n{} matched lines\n{} files contained matches\n{} files searched\n{} bytes printed\n{} bytes searched\n{:.6} seconds spent searching\n{:.6} seconds\n", t.matches, t.matched_lines, t.with_match, t.searched, t.printed, t.bytes_searched, t.elapsed, total).as_bytes());
            Ok(())
        }
    }
}

fn flag_error(flag: &str, reason: impl AsRef<str>) -> StreamError {
    StreamError::new(format!(
        "rg: error parsing flag {flag}: {}",
        reason.as_ref()
    ))
}
fn size_bytes(value: &str, dest: &str) -> Result<u64, StreamError> {
    let flag = format!("--{}", dest.replace('_', "-"));
    let (digits, scale) = match value.as_bytes().last() {
        Some(b'K') => (&value[..value.len() - 1], 1u64 << 10),
        Some(b'M') => (&value[..value.len() - 1], 1u64 << 20),
        Some(b'G') => (&value[..value.len() - 1], 1u64 << 30),
        _ => (value, 1),
    };
    let reason = if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        format!(
            "invalid format for size '{value}', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix"
        )
    } else if let Ok(number) = digits.parse::<u64>() {
        if let Some(bytes) = number.checked_mul(scale) {
            return Ok(bytes);
        }
        format!("size too big in '{value}'")
    } else {
        format!("invalid integer found in size '{value}': number too large to fit in target type")
    };
    Err(flag_error(&flag, format!("invalid size: {reason}")))
}
const COLOR_OUTPUTS: &[&str] = &["path", "line", "column", "match"];
const COLOR_SPECS: &[&str] = &["fg", "bg", "style", "none"];
const COLOR_NAMES: &[&str] = &[
    "black", "blue", "green", "red", "cyan", "magenta", "yellow", "white",
];
const COLOR_STYLES: &[&str] = &[
    "nobold",
    "bold",
    "nointense",
    "intense",
    "nounderline",
    "underline",
];
const HYPERLINK_ALIASES: &[&str] = &[
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
const HYPERLINK_VARIABLES: &[&str] = &["path", "line", "column", "host", "wslprefix"];
fn color_number(code: &str) -> bool {
    let (digits, radix) = code.strip_prefix("0x").map_or((code, 10), |hex| (hex, 16));
    let digits = digits.strip_prefix('+').unwrap_or(digits);
    !digits.is_empty()
        && digits.bytes().all(|b| {
            if radix == 16 {
                b.is_ascii_hexdigit()
            } else {
                b.is_ascii_digit()
            }
        })
        && u8::from_str_radix(digits, radix).is_ok()
}
fn color_refusal(spec: &str) -> Option<String> {
    let pieces: Vec<&str> = spec.split(':').collect();
    let malformed = || {
        format!(
            "invalid color spec format: '{spec}'. Valid format is '(path|line|column|match):(fg|bg|style):(value)'."
        )
    };
    if !(2..=3).contains(&pieces.len()) {
        return Some(malformed());
    }
    if !COLOR_OUTPUTS.contains(&pieces[0].to_ascii_lowercase().as_str()) {
        return Some(format!(
            "unrecognized output type '{}'. Choose from: {}.",
            pieces[0],
            COLOR_OUTPUTS.join(", ")
        ));
    }
    let kind = pieces[1].to_ascii_lowercase();
    if !COLOR_SPECS.contains(&kind.as_str()) {
        return Some(format!(
            "unrecognized spec type '{}'. Choose from: {}.",
            pieces[1],
            COLOR_SPECS.join(", ")
        ));
    }
    if kind == "none" {
        return None;
    }
    let Some(value) = pieces.get(2) else {
        return Some(malformed());
    };
    if kind == "style" {
        return (!COLOR_STYLES.contains(&value.to_ascii_lowercase().as_str())).then(|| {
            format!(
                "unrecognized style attribute '{value}'. Choose from: {}.",
                COLOR_STYLES.join(", ")
            )
        });
    }
    let codes: Vec<&str> = value.split(',').collect();
    if COLOR_NAMES.contains(&value.to_ascii_lowercase().as_str())
        || matches!(codes.len(), 1 | 3) && codes.iter().all(|code| color_number(code))
    {
        return None;
    }
    Some(
        if codes.len() == 1 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
            format!(
                "unrecognized ansi256 color number, should be '[0-255]' (or a hex number), but is '{value}'"
            )
        } else if value.contains(',') {
            format!(
                "unrecognized RGB color triple, should be '[0-255],[0-255],[0-255]' (or a hex triple), but is '{value}'"
            )
        } else {
            format!(
                "unrecognized color name '{value}'. Choose from: {}",
                COLOR_NAMES.join(", ")
            )
        },
    )
}
fn hyperlink_refusal(fmt: &str) -> Option<String> {
    if fmt.is_empty() || HYPERLINK_ALIASES.contains(&fmt) {
        return None;
    }
    let mut names = Vec::new();
    let mut head = String::new();
    let mut rest = fmt;
    while !rest.is_empty() {
        if rest.starts_with("{{") || rest.starts_with("}}") {
            if names.is_empty() {
                head.push(rest.as_bytes()[0] as char);
            }
            rest = &rest[2..];
        } else if let Some(tail) = rest.strip_prefix('{') {
            let Some(end) = tail.find('}') else {
                return Some(
                    "unclosed variable: found '{' without a corresponding '}' following it".into(),
                );
            };
            let name = &tail[..end];
            if !HYPERLINK_VARIABLES.contains(&name) {
                return Some(format!(
                    "invalid hyperlink format variable: '{name}', choose from: {}",
                    HYPERLINK_VARIABLES.join(", ")
                ));
            }
            names.push(name);
            rest = &tail[end + 1..];
        } else if rest.starts_with('}') {
            return Some(
                "unopened variable: found '}' without a corresponding '{' preceding it".into(),
            );
        } else {
            let ch = rest.chars().next().expect("nonempty");
            if names.is_empty() {
                head.push(ch);
            }
            rest = &rest[ch.len_utf8()..];
        }
    }
    if names.is_empty() {
        return Some(format!(
            "at least a {{path}} variable is required in a hyperlink format, or otherwise use a valid alias: {}",
            HYPERLINK_ALIASES.join(", ")
        ));
    }
    if !names.contains(&"path") {
        return Some("the {path} variable is required in a hyperlink format".into());
    }
    if names.contains(&"column") && !names.contains(&"line") {
        return Some(
            "the hyperlink format contains a {column} variable, but no {line} variable is present"
                .into(),
        );
    }
    let valid_scheme = head.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b))
    });
    if !valid_scheme {
        return Some(
            "the hyperlink format must start with a valid URL scheme, i.e., [0-9A-Za-z+-.]+:"
                .into(),
        );
    }
    None
}

struct Formatter;

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn crate::Stream>, StreamError> {
    let _: std::collections::BTreeMap<String, String> = parse_config(config)?;
    Ok(Box::new(Formatter))
}

impl crate::Stream for Formatter {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        format(input, out)
    }
    fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::format;
    use serde_json::{Value, json};

    #[test]
    fn begin_preserves_utf8_and_encodes_invalid_path_bytes() {
        for (name, expected) in [
            (
                "path",
                br#"{"type":"begin","data":{"path":{"text":"path"}}}"#.as_slice(),
            ),
            (
                "ÿ",
                br#"{"type":"begin","data":{"path":{"bytes":"/w=="}}}"#.as_slice(),
            ),
            (
                "ÿx",
                br#"{"type":"begin","data":{"path":{"bytes":"/3g="}}}"#.as_slice(),
            ),
        ] {
            let mut out = Vec::new();
            format(
                &serde_json::to_vec(&json!({"kind":"begin", "name":name})).unwrap(),
                &mut out,
            )
            .unwrap();
            assert_eq!(out, [expected, b"\n"].concat());
        }
    }

    #[test]
    fn end_reports_counts_and_host_supplied_duration() {
        let mut out = Vec::new();
        format(
            &serde_json::to_vec(&json!({
                "kind":"end", "name":"f", "nul":3, "selected":true,
                "matches":2, "matched_lines":1, "searched":8, "printed":14, "elapsed":1.25
            }))
            .unwrap(),
            &mut out,
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            value,
            json!({"type":"end", "data":{
                "path":{"text":"f"}, "binary_offset":3, "stats":{
                    "elapsed":{"secs":1,"nanos":250000000,"human":"1.250000s"},
                    "searches":1,"searches_with_match":1,"bytes_searched":8,
                    "bytes_printed":14,"matched_lines":1,"matches":2
                }
            }})
        );
    }
}
