use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Style {
    Shell,
    ShellAlways,
    Escape,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    style: Style,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { style } = parse_config(config)?;
    Ok(Box::new(Quote {
        style,
        text: Vec::new(),
        finished: false,
    }))
}

struct Quote {
    style: Style,
    text: Vec<u8>,
    finished: bool,
}

impl Stream for Quote {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.finished {
            self.text.extend_from_slice(input);
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if std::mem::replace(&mut self.finished, true) {
            return Ok(());
        }
        let text = std::mem::take(&mut self.text);
        match self.style {
            Style::Shell => out.extend(shell_quoted(&text)),
            Style::ShellAlways => out.extend(shell(&text, true)),
            Style::Escape => {
                for (c, bytes) in characters(&text) {
                    if matches!(c, Some(' ' | '\\')) {
                        out.push(b'\\');
                        out.extend_from_slice(bytes);
                    } else if c.is_none() || escaped(c) {
                        escape(c, bytes, out);
                    } else {
                        out.extend_from_slice(bytes);
                    }
                }
            }
        }
        Ok(())
    }
}

fn characters(text: &[u8]) -> impl Iterator<Item = (Option<char>, &[u8])> {
    text.utf8_chunks().flat_map(|chunk| {
        let valid = chunk.valid();
        let chars = valid
            .char_indices()
            .map(move |(at, c)| (Some(c), &valid.as_bytes()[at..at + c.len_utf8()]));
        chars.chain(chunk.invalid().chunks(1).map(|byte| (None, byte)))
    })
}

// Match the hosts' UTF-8 locale policy. Unassigned code points stay ordinary
// so updating Unicode's assignments cannot change a diagnostic's spelling.
fn escaped(c: Option<char>) -> bool {
    c.is_some_and(|c| matches!(u32::from(c), 0..=0x1f | 0x7f..=0x9f | 0x2028 | 0x2029))
}

fn escape(c: Option<char>, bytes: &[u8], out: &mut Vec<u8>) {
    match c {
        Some('\x07') => out.extend_from_slice(b"\\a"),
        Some('\x08') => out.extend_from_slice(b"\\b"),
        Some('\t') => out.extend_from_slice(b"\\t"),
        Some('\n') => out.extend_from_slice(b"\\n"),
        Some('\x0b') => out.extend_from_slice(b"\\v"),
        Some('\x0c') => out.extend_from_slice(b"\\f"),
        Some('\r') => out.extend_from_slice(b"\\r"),
        _ => bytes
            .iter()
            .for_each(|byte| out.extend_from_slice(format!("\\{byte:03o}").as_bytes())),
    }
}

pub(crate) fn shell_quoted(text: &[u8]) -> Vec<u8> {
    shell(text, false)
}

/// `text` in GNU's shell-escape quoting, as a diagnostic names a word: bare
/// when a shell reads it back as itself, else `'...'` with a quote as
/// `'\''` and a run of controls as one `$'...'` group, or `"..."` for a
/// word whose only trouble is a quote. A character past ASCII is ordinary,
/// as under a UTF-8 locale, except the C1 controls and U+2028 and U+2029;
/// a byte that is no UTF-8 is ordinary too.
fn shell(text: &[u8], always: bool) -> Vec<u8> {
    const ALWAYS: &[u8] = b" !\"$&'()*:;<=>?[\\^`|";
    const DOUBLE_BLOCKERS: &[u8] = b"!\"#$&()*;<=>?[\\^`{|}~";
    let special =
        |c: Option<char>, set: &[u8]| c.is_some_and(|c| c.is_ascii() && set.contains(&(c as u8)));
    let bare = !always
        && !text.is_empty()
        && text != b"{"
        && text != b"}"
        && !matches!(text.first(), Some(b'#' | b'~'))
        && characters(text).all(|(c, _)| !escaped(c) && !special(c, ALWAYS));
    if bare {
        return text.to_vec();
    }
    if text.contains(&b'\'')
        && characters(text).all(|(c, _)| !escaped(c) && !special(c, DOUBLE_BLOCKERS))
    {
        return [b"\"", text, b"\""].concat();
    }
    let mut out = vec![b'\''];
    let mut in_escape = false;
    for (c, bytes) in characters(text) {
        if escaped(c) {
            if !in_escape {
                out.extend_from_slice(b"'$'");
                in_escape = true;
            }
            escape(c, bytes, &mut out);
        } else if bytes == b"'" {
            out.extend_from_slice(b"'\\''");
            in_escape = false;
        } else {
            if in_escape {
                out.extend_from_slice(b"''");
                in_escape = false;
            }
            out.extend_from_slice(bytes);
        }
    }
    out.push(b'\'');
    out
}

#[cfg(test)]
mod tests {
    use super::shell_quoted;
    use crate::open;

    #[test]
    fn styles_preserve_utf8_and_raw_bytes_across_every_chunk_boundary() {
        let name = "a '\t\u{85}\u{2028}é😀\\".as_bytes();
        let name = [name, b"\xff"].concat();
        for (style, expected) in [
            ("shell", shell_quoted(&name)),
            ("shell_always", shell_quoted(&name)),
            (
                "escape",
                b"a\\ '\\t\\302\\205\\342\\200\\250\xc3\xa9\xf0\x9f\x98\x80\\\\\\377".to_vec(),
            ),
        ] {
            for split in 0..=name.len() {
                let config = serde_json::json!({"style": style}).to_string();
                let mut stream = open("quote", config.as_bytes()).expect("quote style");
                let mut out = Vec::new();
                stream.feed(&name[..split], &mut out).unwrap();
                stream.feed(&name[split..], &mut out).unwrap();
                assert!(out.is_empty());
                stream.finish(&mut out).unwrap();
                stream.finish(&mut out).unwrap();
                assert_eq!(out, expected, "{style}, split {split}");
            }
        }
    }

    #[test]
    fn always_style_wraps_plain_names_and_escape_leaves_empty_names_empty() {
        for (style, input, expected) in [
            ("shell", "plain", "plain"),
            ("shell_always", "plain", "'plain'"),
            ("shell_always", "it's", "\"it's\""),
            ("shell_always", "", "''"),
            ("escape", "", ""),
        ] {
            let config = serde_json::json!({"style": style}).to_string();
            let mut stream = open("quote", config.as_bytes()).unwrap();
            let mut out = Vec::new();
            stream.feed(input.as_bytes(), &mut out).unwrap();
            stream.finish(&mut out).unwrap();
            assert_eq!(out, expected.as_bytes());
        }
    }

    #[test]
    fn shell_quoting_matches_gnu_shell_escape() {
        for (text, quoted) in [
            ("x", "x"),
            ("", "''"),
            ("{", "'{'"),
            ("#a", "'#a'"),
            ("a#", "a#"),
            ("a b", "'a b'"),
            ("it's", "\"it's\""),
            ("it's$", "'it'\\''s$'"),
            ("a\u{9}b", "'a'$'\\t''b'"),
            ("a\u{1}'b", "'a'$'\\001'\\''b'"),
            ("é", "é"),
            ("\u{85}x", "''$'\\302\\205''x'"),
            ("a\u{2028}", "'a'$'\\342\\200\\250'"),
            ("~", "'~'"),
            ("-3", "-3"),
            (" 1", "' 1'"),
            ("\u{1}\u{2}z", "''$'\\001\\002''z'"),
        ] {
            assert_eq!(shell_quoted(text.as_bytes()), quoted.as_bytes(), "{text:?}");
        }
        assert_eq!(shell_quoted(b"a\xffb"), b"a\xffb");
    }
}
