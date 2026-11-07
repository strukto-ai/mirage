mod options;

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// The prefix and the files as typed, globs spread, each one character
    /// per byte.
    #[serde(deserialize_with = "crate::latin1_list")]
    operands: Vec<Vec<u8>>,
    fold: bool,
    /// -d: only letters, digits and blanks take part in the comparison.
    #[serde(default)]
    alphanum: bool,
    /// -t: the prefix ends just after the first of this character.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    terminate: Option<Vec<u8>>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config {
        operands,
        fold,
        alphanum,
        terminate,
    } = parse_config(config)?;
    let mut prefix = options::prefix(&operands)?.to_vec();
    if let Some(&stop) = terminate.as_deref().and_then(<[u8]>::first) {
        if let Some(at) = prefix.iter().position(|&b| b == stop) {
            prefix.truncate(at + 1);
        }
    }
    if alphanum {
        prefix.retain(|&b| compared(b));
    }
    Ok(Box::new(Look {
        prefix,
        fold,
        alphanum,
        matched: 0,
        head: Vec::new(),
        line: Line::Head,
    }))
}

/// Whether -d compares this byte: a letter, a digit or a blank.
fn compared(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b' ' || byte == b'\t'
}

/// Where the current line stands against the prefix.
#[derive(PartialEq)]
enum Line {
    /// Its start is still being compared.
    Head,
    Copy,
    Skip,
}

/// util-linux 2.41 look over its input line by line: a line that starts
/// with the prefix, under `fold` with ASCII letters compared without case,
/// is written as it stands, a last line without its newline too.
struct Look {
    prefix: Vec<u8>,
    fold: bool,
    alphanum: bool,
    /// How much of the prefix the current line has matched.
    matched: usize,
    /// The start of the current line, as long as it matches the prefix.
    head: Vec<u8>,
    line: Line,
}

impl Stream for Look {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut rest = input;
        while !rest.is_empty() {
            if self.line == Line::Head {
                let mut verdict = None;
                for &byte in rest {
                    if self.matched == self.prefix.len() {
                        verdict = Some(true);
                        break;
                    }
                    if byte == b'\n' {
                        verdict = Some(false);
                        break;
                    }
                    if self.alphanum && !compared(byte) {
                        continue;
                    }
                    let want = self.prefix[self.matched];
                    if byte != want && !(self.fold && byte.eq_ignore_ascii_case(&want)) {
                        verdict = Some(false);
                        break;
                    }
                    self.matched += 1;
                }
                match verdict.or((self.matched == self.prefix.len()).then_some(true)) {
                    Some(true) => {
                        out.append(&mut self.head);
                        self.line = Line::Copy;
                    }
                    Some(false) => {
                        self.head.clear();
                        self.line = Line::Skip;
                    }
                    None => {
                        self.head.extend_from_slice(rest);
                        return Ok(());
                    }
                }
            }
            let end = memchr::memchr(b'\n', rest).map_or(rest.len(), |at| at + 1);
            if self.line == Line::Copy {
                out.extend_from_slice(&rest[..end]);
            }
            if rest[end - 1] == b'\n' {
                self.line = Line::Head;
                self.matched = 0;
            }
            rest = &rest[end..];
        }
        Ok(())
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.head.clear();
        self.line = Line::Head;
        self.matched = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::run;

    const WORDS: &[u8] = b"a b\nab\na-b c\nab-c\nabc\nabz\nb x\n";

    fn look(config: &str) -> Vec<u8> {
        let chunks: [&[u8]; 3] = [&WORDS[..5], &WORDS[5..13], &WORDS[13..]];
        run("look", config, &chunks).0
    }

    #[test]
    fn alphanum_compares_letters_digits_and_blanks_only() {
        assert_eq!(
            look(r#"{"operands": ["a-b"], "fold": false, "alphanum": true}"#),
            b"ab\na-b c\nab-c\nabc\nabz\n"
        );
        assert_eq!(
            look(r#"{"operands": ["a b"], "fold": false, "alphanum": true}"#),
            b"a b\n"
        );
    }

    #[test]
    fn terminate_ends_the_prefix_before_alphanum_reads_it() {
        assert_eq!(
            look(r#"{"operands": ["ab-zz"], "fold": false, "terminate": "-"}"#),
            b"ab-c\n"
        );
        assert_eq!(
            look(r#"{"operands": ["a-bz"], "fold": false, "alphanum": true, "terminate": "-"}"#),
            b"a b\nab\na-b c\nab-c\nabc\nabz\n"
        );
        assert_eq!(
            look(r#"{"operands": ["ab"], "fold": false, "terminate": "xy"}"#),
            b"ab\nab-c\nabc\nabz\n"
        );
    }
}
