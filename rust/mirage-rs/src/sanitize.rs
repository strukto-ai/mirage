use std::sync::LazyLock;

use regex_automata::meta::Regex;
use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

const NAME_MAX_BYTES: i64 = 255;
const NAME_MAX_CHARS: usize = 100;
const ELLIPSIS: &str = "...";
const SAFE_SLASH: &str = "∕";
const ESCAPE_LEAD: &str = "⁄";

static SAFE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A[\p{L}\p{N}\p{White_Space}_.-]\z").expect("constant character class")
});

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Config {
    Name {},
    Path {},
    Blank {},
    Truncate {
        budget: i64,
    },
    Label {
        fallback: String,
        max_len: i64,
        #[serde(default = "name_max_bytes")]
        max_bytes: i64,
    },
}

fn name_max_bytes() -> i64 {
    NAME_MAX_BYTES
}

fn budget_size(budget: i64) -> usize {
    usize::try_from(budget.max(0)).unwrap_or(usize::MAX)
}

fn truncate_bytes(text: &str, budget: usize) -> &str {
    let mut end = budget.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn clean(text: &str) -> String {
    let mut out = String::new();
    let mut previous = false;
    let mut encoded = [0; 4];
    for ch in text.chars() {
        let ch = if ch != ' ' && SAFE.is_match(ch.encode_utf8(&mut encoded).as_bytes()) {
            ch
        } else {
            '_'
        };
        if ch != '_' || !previous {
            out.push(ch);
        }
        previous = ch == '_';
    }
    out.trim_start_matches(['.', '_'])
        .trim_end_matches('_')
        .into()
}

fn label(text: &str, fallback: &str, max_len: i64, max_bytes: i64) -> String {
    let max_bytes = budget_size(max_bytes);
    let mut cleaned = clean(text);
    if cleaned.is_empty() || text.chars().all(char::is_whitespace) {
        return fallback.into();
    }
    let count = cleaned.chars().count() as i64;
    if count > max_len {
        // Both hosts use slice semantics, including a negative stop.
        let stop = max_len.saturating_sub(ELLIPSIS.len() as i64);
        let stop = if stop < 0 {
            count.saturating_add(stop).max(0)
        } else {
            stop
        };
        cleaned = cleaned.chars().take(stop as usize).collect::<String>() + ELLIPSIS;
    }
    if cleaned.len() > max_bytes {
        let head = truncate_bytes(&cleaned, max_bytes.saturating_sub(ELLIPSIS.len()))
            .trim_end_matches(['_', '.']);
        cleaned = if head.is_empty() {
            truncate_bytes(&cleaned, max_bytes).into()
        } else {
            head.to_owned() + ELLIPSIS
        };
    }
    cleaned
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(Sanitize {
        config: parse_config(config)?,
        input: Vec::new(),
        finished: false,
    }))
}

struct Sanitize {
    config: Config,
    input: Vec<u8>,
    finished: bool,
}

impl Stream for Sanitize {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.finished {
            return Err(StreamError::new("sanitize input already finished"));
        }
        self.input.extend_from_slice(input);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        let input = std::mem::take(&mut self.input);
        let text = std::str::from_utf8(&input)
            .map_err(|_| StreamError::new("sanitize needs UTF-8 text"))?;
        let result = match &self.config {
            Config::Name {} => {
                let cleaned = clean(text);
                if cleaned.is_empty() || text.chars().all(char::is_whitespace) {
                    "unknown".into()
                } else {
                    cleaned.chars().take(NAME_MAX_CHARS).collect()
                }
            }
            Config::Path {} => {
                if text.chars().all(char::is_whitespace) {
                    "unknown".into()
                } else {
                    let safe = text.replace('/', SAFE_SLASH);
                    if safe.starts_with('.') {
                        ESCAPE_LEAD.to_owned() + &safe
                    } else {
                        safe
                    }
                }
            }
            Config::Blank {} => if text.chars().all(char::is_whitespace) {
                "1"
            } else {
                "0"
            }
            .into(),
            Config::Truncate { budget } => truncate_bytes(text, budget_size(*budget)).into(),
            Config::Label {
                fallback,
                max_len,
                max_bytes,
            } => label(text, fallback, *max_len, *max_bytes),
        };
        out.extend_from_slice(result.as_bytes());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn labels_keep_unicode_and_respect_both_budgets() {
        assert_eq!(label("..日本語 / 文書__", "empty", 100, 255), "日本語_文書");
        assert_eq!(label("🚀", "empty", 100, 255), "empty");
        assert_eq!(label("abcdef", "empty", 100, 2), "ab");
        assert_eq!(label("a....éé", "empty", 100, 8), "a...");
        let text = "𐐀".repeat(120);
        assert_eq!(label(&text, "empty", 100, 255), "𐐀".repeat(63) + "...");
    }

    #[test]
    fn unicode_white_space_is_shared() {
        for (text, expected) in [("\u{85}", "1"), ("\u{feff}", "0"), ("\u{1c}", "0")] {
            let mut stream = open(br#"{"op":"blank"}"#).unwrap();
            let mut out = Vec::new();
            for byte in text.as_bytes() {
                stream.feed(&[*byte], &mut out).unwrap();
            }
            stream.finish(&mut out).unwrap();
            stream.finish(&mut out).unwrap();
            assert_eq!(out, expected.as_bytes());
        }
    }

    #[test]
    fn operations_accept_chunked_text_and_refuse_unknown_fields() {
        for (config, text, expected) in [
            (json!({"op":"path"}), ".a/b", "⁄.a∕b"),
            (json!({"op":"truncate","budget":3}), "éé", "é"),
            (json!({"op":"name"}), "e\u{301}", "e"),
        ] {
            let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
            let mut out = Vec::new();
            for byte in text.as_bytes() {
                stream.feed(&[*byte], &mut out).unwrap();
            }
            stream.finish(&mut out).unwrap();
            assert_eq!(out, expected.as_bytes());
        }
        assert!(open(br#"{"op":"name","unknown":1}"#).is_err());
    }
}
