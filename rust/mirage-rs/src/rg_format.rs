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
