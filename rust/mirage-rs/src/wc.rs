use std::collections::VecDeque;

use serde::Deserialize;

use crate::utf8::{Decoder, INVALID, ascii_run};
use crate::width::{advance_column, is_space};
use crate::{Stream, StreamError, parse_config};

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    report: Option<Vec<Row>>,
    width: Option<usize>,
    lines: bool,
    words: bool,
    bytes: bool,
    chars: bool,
    max_line_length: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    if let Some(rows) = config.report {
        let width = config.width.unwrap_or_else(|| {
            if rows.len() == 1 && rows[0].values.len() == 1 {
                1
            } else if rows.len() == 1 && rows[0].label.is_none() {
                7
            } else {
                rows.iter()
                    .flat_map(|row| &row.values)
                    .map(|n| n.to_string().len())
                    .max()
                    .unwrap_or(1)
            }
        });
        return Ok(Box::new(Report {
            rows: rows.into(),
            width,
            pending: Vec::new(),
            at: 0,
        }));
    }
    let byte_counts_only =
        (config.lines || config.bytes) && !(config.words || config.chars || config.max_line_length);
    Ok(Box::new(Wc {
        byte_counts_only,
        length: config.max_line_length
            || !(config.lines || config.words || config.bytes || config.chars),
        decoder: Decoder::new(),
        counts: Counts::default(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    values: Vec<u64>,
    #[serde(deserialize_with = "crate::latin1_opt")]
    label: Option<Vec<u8>>,
}

fn quoted_label(name: &[u8], out: &mut Vec<u8>) {
    if !name.contains(&b'\n') {
        out.extend_from_slice(name);
        return;
    }
    out.push(b'\'');
    let mut escaped = false;
    let mut at = 0;
    while at < name.len() {
        let tail = &name[at..];
        let width = if tail.starts_with(&[0xc2])
            && tail.get(1).is_some_and(|b| (0x80..=0x9f).contains(b))
        {
            2
        } else if tail.starts_with(&[0xe2, 0x80, 0xa8]) || tail.starts_with(&[0xe2, 0x80, 0xa9]) {
            3
        } else {
            1
        };
        let control = width > 1 || tail[0] < 0x20 || tail[0] == 0x7f;
        if control {
            if !escaped {
                out.extend_from_slice(b"'$'");
                escaped = true;
            }
            let named = match tail[0] {
                7 => Some(b'a'),
                8 => Some(b'b'),
                9 => Some(b't'),
                10 => Some(b'n'),
                11 => Some(b'v'),
                12 => Some(b'f'),
                13 => Some(b'r'),
                _ => None,
            };
            if let Some(named) = named {
                out.extend_from_slice(&[b'\\', named]);
            } else {
                for &byte in &tail[..width] {
                    out.extend_from_slice(format!("\\{byte:03o}").as_bytes());
                }
            }
        } else if tail[0] == b'\'' {
            out.extend_from_slice(b"'\\''");
            escaped = false;
        } else {
            if escaped {
                out.extend_from_slice(b"''");
                escaped = false;
            }
            out.push(tail[0]);
        }
        at += width;
    }
    out.push(b'\'');
}

struct Report {
    rows: VecDeque<Row>,
    width: usize,
    pending: Vec<u8>,
    at: usize,
}
impl Report {
    fn render(&mut self, out: &mut Vec<u8>) {
        let start = out.len();
        while out.len() - start < 64 * 1024 {
            if self.at == self.pending.len() {
                self.pending.clear();
                self.at = 0;
                crate::release_capacity(&mut self.pending);
                let Some(row) = self.rows.pop_front() else {
                    break;
                };
                for (index, value) in row.values.iter().enumerate() {
                    if index != 0 {
                        self.pending.push(b' ');
                    }
                    let number = value.to_string();
                    self.pending.resize(
                        self.pending.len() + self.width.saturating_sub(number.len()),
                        b' ',
                    );
                    self.pending.extend_from_slice(number.as_bytes());
                }
                if let Some(label) = row.label {
                    self.pending.push(b' ');
                    quoted_label(&label, &mut self.pending);
                }
                self.pending.push(b'\n');
            }
            let len = (64 * 1024 - (out.len() - start)).min(self.pending.len() - self.at);
            out.extend_from_slice(&self.pending[self.at..self.at + len]);
            self.at += len;
        }
    }
}
impl Stream for Report {
    fn feed(&mut self, _: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.render(out);
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.render(out);
        Ok(())
    }
    fn busy(&self) -> bool {
        self.at < self.pending.len() || !self.rows.is_empty()
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.render(out);
        Ok(())
    }
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
    fn char(&mut self, cp: u32, length: bool) {
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
        }
        if !length {
            return;
        }
        if cp == 0x0A {
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
    length: bool,
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
        let mut at = 0;
        while at < input.len() {
            if !self.decoder.pending() {
                let len = ascii_run(&input[at..]);
                if len > 0 {
                    let ascii = &input[at..at + len];
                    if self.length {
                        for &byte in ascii {
                            counts.char(u32::from(byte), true);
                        }
                    } else {
                        counts.chars += len as u64;
                        counts.lines += memchr::memchr_iter(b'\n', ascii).count() as u64;
                        for &byte in ascii {
                            let space = byte == b' ' || (b'\t'..=b'\r').contains(&byte);
                            counts.words += u64::from(counts.in_word && space);
                            counts.in_word = !space;
                        }
                    }
                    at += len;
                    continue;
                }
            }
            self.decoder
                .decode(&input[at..at + 1], |cp| counts.char(cp, self.length));
            at += 1;
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let counts = &mut self.counts;
        self.decoder.finish(|cp| counts.char(cp, self.length));
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
