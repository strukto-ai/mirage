use serde::Deserialize;

use crate::utf8::{Decoder, INVALID};
use crate::width::{advance_column, is_space};
use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    lines: bool,
    words: bool,
    bytes: bool,
    chars: bool,
    max_line_length: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let byte_counts_only =
        (config.lines || config.bytes) && !(config.words || config.chars || config.max_line_length);
    Ok(Box::new(Wc {
        byte_counts_only,
        decoder: Decoder::new(),
        counts: Counts::default(),
    }))
}

/// Words also end at the non-breaking spaces and the word joiner, as GNU
/// `wc` 9.7 splits them, though they are no space to `width::is_space`.
fn is_nbspace(cp: u32) -> bool {
    matches!(cp, 0x00A0 | 0x2007 | 0x202F | 0x2060)
}

#[derive(Default)]
struct Counts {
    lines: u64,
    words: u64,
    bytes: u64,
    chars: u64,
    max_line_length: u64,
    column: u64,
    in_word: bool,
}

impl Counts {
    fn char(&mut self, cp: u32) {
        if cp == INVALID {
            self.in_word = true;
            return;
        }
        self.chars += 1;
        if is_space(cp) || is_nbspace(cp) {
            if self.in_word {
                self.words += 1;
                self.in_word = false;
            }
        } else {
            self.in_word = true;
        }
        if cp == 0x0A {
            self.lines += 1;
            self.max_line_length = self.max_line_length.max(self.column);
            self.column = 0;
            return;
        }
        self.column = advance_column(self.column, cp);
        self.max_line_length = self.max_line_length.max(self.column);
    }
}

/// GNU `wc` 9.7's counts in C.UTF-8. With only `-l` and `-c` asked it never
/// decodes. A byte that decodes to no character is part of a word but no
/// character and no column. On finish it writes
/// `lines words bytes chars max_line_length`.
struct Wc {
    byte_counts_only: bool,
    decoder: Decoder,
    counts: Counts,
}

impl Stream for Wc {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.counts.bytes += input.len() as u64;
        if self.byte_counts_only {
            self.counts.lines += memchr::memchr_iter(b'\n', input).count() as u64;
            return Ok(());
        }
        let counts = &mut self.counts;
        self.decoder.decode(input, |cp| counts.char(cp));
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let counts = &mut self.counts;
        self.decoder.finish(|cp| counts.char(cp));
        if counts.in_word {
            counts.words += 1;
            counts.in_word = false;
        }
        let Counts {
            lines,
            words,
            bytes,
            chars,
            max_line_length,
            ..
        } = *counts;
        out.extend_from_slice(
            format!("{lines} {words} {bytes} {chars} {max_line_length}").as_bytes(),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::run;

    const ALL: &str =
        r#"{"lines":false,"words":false,"bytes":false,"chars":false,"max_line_length":false}"#;

    fn counts(chunks: &[&[u8]]) -> String {
        String::from_utf8(run("wc", ALL, chunks).0).unwrap()
    }

    #[test]
    fn counts_like_gnu() {
        assert_eq!(counts(&[b"hello world\nfoo\n"]), "2 3 16 16 11");
        assert_eq!(counts(&[b"a\tb"]), "0 2 3 3 9");
        assert_eq!(counts(&[b"a\rb"]), "0 2 3 3 1");
        assert_eq!(counts(&["数据 x\n".as_bytes()]), "1 2 9 5 6");
        assert_eq!(counts(&[b"\xff\xfeab"]), "0 1 4 2 2");
        assert_eq!(counts(&[b"a \xff b"]), "0 3 5 4 4");
        assert_eq!(counts(&[b"\xe2\x82x"]), "0 1 3 1 1");
        assert_eq!(counts(&[b"a\xef\xbf\xbdb"]), "0 1 5 3 3");
        assert_eq!(counts(&["a\u{2060}b".as_bytes()]), "0 2 5 3 2");
        assert_eq!(counts(&["a\u{200b}b\u{85}c".as_bytes()]), "0 1 8 5 3");
        assert_eq!(
            counts(&[b"\xc0\xaf \xe0\x80\xaf \xf4\x90\x80\x80\n"]),
            "1 3 12 4 2"
        );
        assert_eq!(counts(&["a\u{202b}b \u{2630}".as_bytes()]), "0 2 9 5 5");
        assert_eq!(counts(&[b""]), "0 0 0 0 0");
    }

    #[test]
    fn splits_do_not_change_counts() {
        let text = "héllo 数据\tz\u{2003}w\n end".as_bytes();
        let whole = counts(&[text]);
        for split in 0..=text.len() {
            assert_eq!(counts(&[&text[..split], &text[split..]]), whole);
        }
    }

    #[test]
    fn byte_counts_skip_decoding() {
        let lines =
            r#"{"lines":true,"words":false,"bytes":false,"chars":false,"max_line_length":false}"#;
        assert_eq!(run("wc", lines, &[b"a\nb\n", b"\xff\n"]).0, b"3 0 6 0 0");
    }
}
