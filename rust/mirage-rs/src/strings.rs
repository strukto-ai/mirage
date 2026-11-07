use serde::Deserialize;

use crate::{Stream, StreamError, number, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// `-n` as typed.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    min_len: Option<Vec<u8>>,
    /// `-e`'s letter: `s` (7-bit, the default), `S` (8-bit), `b`/`l`
    /// (16-bit big/little endian) or `B`/`L` (32-bit).
    #[serde(default)]
    encoding: Option<char>,
    /// `-t`'s letter, `o`, `d` or `x`, which prints each string's offset.
    #[serde(default)]
    radix: Option<char>,
    /// `-w`: every whitespace byte belongs to a string.
    #[serde(default)]
    whitespace: bool,
    /// `-s`: what follows each string in place of a newline.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    separator: Option<Vec<u8>>,
    /// `-f`: the file's name and `: `, written before each string.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    prefix: Option<Vec<u8>>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let min_len = match config.min_len {
        Some(text) => min_length(&text).map_err(StreamError::new)?,
        None => 4,
    };
    let (width, little, eight_bit) = match config.encoding.unwrap_or('s') {
        's' => (1, false, false),
        'S' => (1, false, true),
        'b' => (2, false, false),
        'l' => (2, true, false),
        'B' => (4, false, false),
        'L' => (4, true, false),
        other => return Err(StreamError::new(format!("strings: bad encoding {other}"))),
    };
    if !matches!(config.radix, None | Some('o' | 'd' | 'x')) {
        return Err(StreamError::new("strings: bad radix"));
    }
    Ok(Box::new(Strings {
        min_len,
        width,
        little,
        eight_bit,
        whitespace: config.whitespace,
        radix: config.radix,
        separator: config.separator.unwrap_or_else(|| b"\n".to_vec()),
        prefix: config.prefix.unwrap_or_default(),
        buf: Vec::new(),
        base: 0,
        pos: 0,
        reach: None,
        printing: None,
        dead: [0; 4],
    }))
}

/// `-n` as binutils 2.44 reads it, C's strtoul at base 0 over every byte,
/// refused in its words in the order it tests them; a refusal names the
/// value one character per byte, which the host writes back as bytes.
fn min_length(text: &[u8]) -> Result<u64, String> {
    let shown = crate::byte_text(text);
    let parts = number::parts(text, true);
    if (parts.digits.is_empty() && !text.is_empty()) || !parts.rest.is_empty() {
        return Err(format!("strings: invalid integer argument {shown}"));
    }
    let value = match parts.value().and_then(|value| u64::try_from(value).ok()) {
        Some(value) if parts.negative() => value.wrapping_neg(),
        Some(value) => value,
        None => u64::MAX,
    };
    match value {
        0 => Err(format!(
            "strings: minimum string length is too small: {shown}"
        )),
        v if v > u64::from(u32::MAX) => Err(format!(
            "strings: minimum string length is too big: {shown}"
        )),
        v if v == u64::from(u32::MAX) => {
            Err(format!("strings: minimum string length {shown} is too big"))
        }
        v => Ok(v),
    }
}

/// binutils 2.44 strings over a whole input: every run of at least
/// `min_len` printable characters is written, each followed by the
/// separator. A character is `width` bytes in the encoding's byte order,
/// and printable when it is ASCII's graphic set, the space or the tab (any
/// whitespace under `-w`, and any byte past 127 under `-e S`). A run may
/// start at any byte: one too short moves the start on one byte, and the
/// next start after a printed run is the byte after the one that began the
/// character ending it.
struct Strings {
    min_len: u64,
    width: usize,
    little: bool,
    eight_bit: bool,
    whitespace: bool,
    radix: Option<char>,
    separator: Vec<u8>,
    prefix: Vec<u8>,
    /// The input from `base` on, which a start not yet settled may read.
    buf: Vec<u8>,
    base: u64,
    /// The next start to try.
    pos: u64,
    /// How far the start at `pos` has read, and how many characters,
    /// while it waits for more input.
    reach: Option<(u64, u64)>,
    /// The next character of the run being written.
    printing: Option<u64>,
    /// Per start alignment, where a start already failed: a later start
    /// of that alignment before it reads the same run, only shorter.
    dead: [u64; 4],
}

impl Strings {
    /// The character at `at`, when the input holds all of it.
    fn char_at(&self, at: u64) -> Option<u32> {
        let from = usize::try_from(at - self.base).ok()?;
        let bytes = self.buf.get(from..from + self.width)?;
        Some(if self.little {
            bytes
                .iter()
                .rev()
                .fold(0, |acc, &b| acc << 8 | u32::from(b))
        } else {
            bytes.iter().fold(0, |acc, &b| acc << 8 | u32::from(b))
        })
    }

    fn printable(&self, c: u32) -> bool {
        let Ok(byte) = u8::try_from(c) else {
            return false;
        };
        matches!(byte, b'\t' | b' '..=b'~')
            || (self.whitespace && matches!(byte, b'\n' | 0x0b | 0x0c | b'\r'))
            || (self.eight_bit && byte > 127)
    }

    fn header(&self, at: u64, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.prefix);
        match self.radix {
            Some('o') => out.extend_from_slice(format!("{at:7o} ").as_bytes()),
            Some('d') => out.extend_from_slice(format!("{at:7} ").as_bytes()),
            Some('x') => out.extend_from_slice(format!("{at:7x} ").as_bytes()),
            _ => {}
        }
    }

    /// Settle what the input on hand decides, keeping what a start not
    /// yet settled may still read.
    fn scan(&mut self, out: &mut Vec<u8>) {
        let width = self.width as u64;
        loop {
            if let Some(mut at) = self.printing {
                while let Some(c) = self.char_at(at) {
                    if !self.printable(c) {
                        out.extend_from_slice(&self.separator);
                        self.printing = None;
                        self.pos = at + 1;
                        break;
                    }
                    out.push(c as u8);
                    at += width;
                }
                if self.printing.is_some() {
                    self.printing = Some(at);
                    break;
                }
                continue;
            }
            let lane = (self.pos % width) as usize;
            if self.pos < self.dead[lane] {
                self.pos += 1;
                continue;
            }
            let (mut at, mut count) = self.reach.take().unwrap_or((self.pos, 0));
            let mut ended = false;
            while count < self.min_len {
                match self.char_at(at) {
                    Some(c) if self.printable(c) => {
                        count += 1;
                        at += width;
                    }
                    Some(_) => {
                        ended = true;
                        break;
                    }
                    None => break,
                }
            }
            if count >= self.min_len {
                self.header(self.pos, out);
                let mut from = self.pos;
                while from < at {
                    out.push(self.char_at(from).unwrap_or_default() as u8);
                    from += width;
                }
                self.printing = Some(at);
                continue;
            }
            if !ended {
                self.reach = Some((at, count));
                break;
            }
            self.dead[lane] = at;
            self.pos += 1;
        }
        let keep = self.printing.unwrap_or(self.pos);
        let drop = usize::try_from(keep.saturating_sub(self.base))
            .unwrap_or(usize::MAX)
            .min(self.buf.len());
        self.buf.drain(..drop);
        self.base += drop as u64;
    }
}

impl Stream for Strings {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.buf.extend_from_slice(input);
        self.scan(out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.printing.take().is_some() {
            out.extend_from_slice(&self.separator);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::min_length;
    use crate::run;

    const SAMPLE: &[u8] = b"\x01hello world\x00ab\x00line one\nline two\x00\xe9t\xe9s caf\xe9\x00h\x00i\x00j\x00k\x00\x00w\x00x\x00y\x00z\x00\x00\x00A\x00\x00\x00B\x00\x00\x00C\x00\x00\x00D\x00\x00\x00";

    fn strings(config: &str) -> Vec<u8> {
        let whole = run("strings", config, &[SAMPLE]).0;
        let pieces: Vec<&[u8]> = SAMPLE.chunks(3).collect();
        assert_eq!(run("strings", config, &pieces).0, whole);
        whole
    }

    #[test]
    fn offsets_names_and_separators_frame_each_string() {
        assert_eq!(
            strings(r#"{"radix": "x", "prefix": "s: ", "separator": "|"}"#),
            b"s:       1 hello world|s:      10 line one|s:      19 line two|s:      25 s caf|"
        );
        assert_eq!(
            strings(r#"{"radix": "o", "whitespace": true}"#),
            b"      1 hello world\n     20 line one\nline two\n     45 s caf\n"
        );
        assert_eq!(
            strings(r#"{"encoding": "S", "min_len": "9"}"#),
            b"hello world\n\xe9t\xe9s caf\xe9\n"
        );
    }

    #[test]
    fn wide_encodings_read_characters_from_any_byte() {
        assert_eq!(strings(r#"{"encoding": "l"}"#), b"hijk\nwxyz\n");
        assert_eq!(strings(r#"{"encoding": "b"}"#), b"hijk\nwxyz\n");
        assert_eq!(strings(r#"{"encoding": "L"}"#), b"zABCD\n");
        assert_eq!(strings(r#"{"encoding": "B"}"#), b"ABCD\n");
    }

    #[test]
    fn an_overflow_stays_too_big_whatever_its_sign() {
        for raw in ["18446744073709551616", "-18446744073709551616"] {
            assert_eq!(
                min_length(raw.as_bytes()),
                Err(format!("strings: minimum string length is too big: {raw}"))
            );
        }
        assert_eq!(min_length(b"-18446744073709551615"), Ok(1));
    }
}
