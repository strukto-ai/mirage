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
    Err(StreamError::new(format!("scan: no grammar for {command}")))
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
    use crate::open;

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
