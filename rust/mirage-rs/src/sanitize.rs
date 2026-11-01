use std::sync::LazyLock;

use regex_automata::meta::Regex;
use serde::Deserialize;

use crate::policy::Text;
use crate::{Stream, StreamError, parse_config};

const NAME_MAX_BYTES: i64 = 255;
const NAME_MAX_CHARS: usize = 100;
const ELLIPSIS: &str = "...";
const SAFE_SLASH: u32 = '∕' as u32;
const ESCAPE_LEAD: u32 = '⁄' as u32;
// What a lone surrogate weighs in a filename: UTF-8 has no spelling for
// one, so it lands as U+FFFD, three bytes.
const SURROGATE_BYTES: usize = 3;

static SAFE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A[\p{L}\p{N}\p{White_Space}_.-]\z").expect("constant character class")
});

// Text travels as code points, as it does in the policy matcher, so a
// label with a lone surrogate reaches the rules whole on both hosts.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Config {
    Name {
        text: Text,
    },
    Path {
        text: Text,
    },
    Blank {
        text: Text,
    },
    Truncate {
        text: Text,
        budget: i64,
    },
    Label {
        text: Text,
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

fn units(text: &str) -> Text {
    text.chars().map(u32::from).collect()
}

fn is_blank(text: &[u32]) -> bool {
    text.iter()
        .all(|&unit| char::from_u32(unit).is_some_and(char::is_whitespace))
}

fn truncate_bytes(text: &[u32], budget: usize) -> &[u32] {
    let mut used = 0;
    for (at, &unit) in text.iter().enumerate() {
        used += char::from_u32(unit).map_or(SURROGATE_BYTES, char::len_utf8);
        if used > budget {
            return &text[..at];
        }
    }
    text
}

fn truncate_str(text: &str, budget: usize) -> &str {
    let mut end = budget.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn clean(text: &[u32]) -> String {
    let mut out = String::new();
    let mut previous = false;
    let mut encoded = [0; 4];
    for &unit in text {
        let ch = match char::from_u32(unit) {
            Some(ch) if ch != ' ' && SAFE.is_match(ch.encode_utf8(&mut encoded).as_bytes()) => ch,
            _ => '_',
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

fn name(text: &[u32]) -> Text {
    let cleaned = clean(text);
    if cleaned.is_empty() || is_blank(text) {
        return units("unknown");
    }
    cleaned
        .chars()
        .take(NAME_MAX_CHARS)
        .map(u32::from)
        .collect()
}

fn path(text: &[u32]) -> Text {
    if is_blank(text) {
        return units("unknown");
    }
    let lead = (text.first() == Some(&u32::from('.'))).then_some(ESCAPE_LEAD);
    lead.into_iter()
        .chain(text.iter().map(|&unit| {
            if unit == u32::from('/') {
                SAFE_SLASH
            } else {
                unit
            }
        }))
        .collect()
}

fn label(text: &[u32], fallback: &str, max_len: i64, max_bytes: i64) -> Text {
    let max_bytes = budget_size(max_bytes);
    let mut cleaned = clean(text);
    if cleaned.is_empty() || is_blank(text) {
        return units(fallback);
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
        let head = truncate_str(&cleaned, max_bytes.saturating_sub(ELLIPSIS.len()))
            .trim_end_matches(['_', '.']);
        cleaned = if head.is_empty() {
            truncate_str(&cleaned, max_bytes).into()
        } else {
            head.to_owned() + ELLIPSIS
        };
    }
    units(&cleaned)
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let answer = match parse_config(config)? {
        Config::Name { text } => serde_json::json!(name(&text)),
        Config::Path { text } => serde_json::json!(path(&text)),
        Config::Blank { text } => serde_json::json!(is_blank(&text)),
        Config::Truncate { text, budget } => {
            serde_json::json!(truncate_bytes(&text, budget_size(budget)))
        }
        Config::Label {
            text,
            fallback,
            max_len,
            max_bytes,
        } => serde_json::json!(label(&text, &fallback, max_len, max_bytes)),
    };
    Ok(Box::new(Sanitize(
        serde_json::to_vec(&answer).expect("sanitize serializes"),
    )))
}

struct Sanitize(Vec<u8>);

impl Stream for Sanitize {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("sanitize reads its text from its config"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.append(&mut self.0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(units: &[u32]) -> String {
        units
            .iter()
            .filter_map(|&unit| char::from_u32(unit))
            .collect()
    }

    #[test]
    fn labels_keep_unicode_and_respect_both_budgets() {
        let label =
            |raw: &str, max_len, max_bytes| text(&label(&units(raw), "empty", max_len, max_bytes));
        assert_eq!(label("..日本語 / 文書__", 100, 255), "日本語_文書");
        assert_eq!(label("🚀", 100, 255), "empty");
        assert_eq!(label("abcdef", 100, 2), "ab");
        assert_eq!(label("a....éé", 100, 8), "a...");
        assert_eq!(label(&"𐐀".repeat(120), 100, 255), "𐐀".repeat(63) + "...");
    }

    #[test]
    fn unicode_white_space_is_shared() {
        for (raw, expected) in [("\u{85}", true), ("\u{feff}", false), ("\u{1c}", false)] {
            assert_eq!(is_blank(&units(raw)), expected, "{raw:?}");
        }
    }

    #[test]
    fn lone_surrogates_are_unsafe_in_names_and_kept_in_paths() {
        assert_eq!(text(&name(&[0xd800, 97, 98])), "ab");
        assert_eq!(name(&[0xdc80]), units("unknown"));
        assert_eq!(
            path(&[46, 0xdc80, 47]),
            vec![ESCAPE_LEAD, 46, 0xdc80, SAFE_SLASH]
        );
        assert!(!is_blank(&[0xdc80]));
        assert_eq!(truncate_bytes(&[97, 0xdc80, 98], 3), &[97]);
        assert_eq!(truncate_bytes(&[97, 0xdc80, 98], 4), &[97, 0xdc80]);
    }

    #[test]
    fn operations_answer_code_points_and_refuse_unknown_fields() {
        for (config, expected) in [
            (
                json!({"op": "path", "text": units(".a/b")}),
                json!(units("⁄.a∕b")),
            ),
            (
                json!({"op": "truncate", "text": units("éé"), "budget": 3}),
                json!(units("é")),
            ),
            (
                json!({"op": "name", "text": units("e\u{301}")}),
                json!(units("e")),
            ),
            (json!({"op": "blank", "text": units(" \t")}), json!(true)),
        ] {
            let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
            let mut out = Vec::new();
            stream.finish(&mut out).unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&out).unwrap(),
                expected
            );
        }
        assert!(open(br#"{"op":"name","text":[],"unknown":1}"#).is_err());
    }
}
