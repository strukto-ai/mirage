use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const INVALID: &str = "base64: invalid input";

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case", tag = "mode")]
enum Config {
    Encode {
        #[serde(deserialize_with = "crate::saturating_usize")]
        wrap: usize,
    },
    Decode {
        ignore_garbage: bool,
    },
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(match parse_config::<Config>(config)? {
        Config::Encode { wrap } => Box::new(Encoder {
            width: wrap,
            pending: [0; 2],
            held: 0,
            column: 0,
        }),
        Config::Decode { ignore_garbage } => Box::new(Decoder {
            ignore_garbage,
            digits: 0,
            value: 0,
            padding: false,
        }),
    })
}

/// GNU `base64`: 76 columns by default, `-w 0` for one unbroken line, and
/// a final newline only when the last line is not empty.
struct Encoder {
    width: usize,
    pending: [u8; 2],
    held: usize,
    column: usize,
}

impl Encoder {
    fn group(&mut self, bytes: &[u8], out: &mut Vec<u8>) {
        let mut quad = [b'='; 4];
        let value = (u32::from(bytes[0]) << 16)
            | (u32::from(*bytes.get(1).unwrap_or(&0)) << 8)
            | u32::from(*bytes.get(2).unwrap_or(&0));
        let digits = bytes.len() + 1;
        for (slot, item) in quad.iter_mut().enumerate().take(digits) {
            *item = ALPHABET[((value >> (18 - 6 * slot)) & 63) as usize];
        }
        self.emit(&quad, out);
    }

    fn emit(&mut self, encoded: &[u8], out: &mut Vec<u8>) {
        if self.width == 0 {
            out.extend_from_slice(encoded);
            return;
        }
        let mut rest = encoded;
        while !rest.is_empty() {
            let take = rest.len().min(self.width - self.column);
            out.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            self.column += take;
            if self.column == self.width {
                out.push(b'\n');
                self.column = 0;
            }
        }
    }
}

impl Stream for Encoder {
    fn feed(&mut self, mut input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.held > 0 {
            let need = (3 - self.held).min(input.len());
            let mut group = [0u8; 3];
            group[..self.held].copy_from_slice(&self.pending[..self.held]);
            group[self.held..self.held + need].copy_from_slice(&input[..need]);
            input = &input[need..];
            if self.held + need < 3 {
                self.pending[..self.held + need].copy_from_slice(&group[..self.held + need]);
                self.held += need;
                return Ok(());
            }
            self.held = 0;
            self.group(&group, out);
        }
        let whole = input.len() / 3 * 3;
        let mut encoded = Vec::with_capacity(whole / 3 * 4);
        for group in input[..whole].chunks_exact(3) {
            let value =
                (u32::from(group[0]) << 16) | (u32::from(group[1]) << 8) | u32::from(group[2]);
            encoded.extend_from_slice(&[
                ALPHABET[(value >> 18) as usize],
                ALPHABET[((value >> 12) & 63) as usize],
                ALPHABET[((value >> 6) & 63) as usize],
                ALPHABET[(value & 63) as usize],
            ]);
        }
        self.emit(&encoded, out);
        let tail = &input[whole..];
        self.pending[..tail.len()].copy_from_slice(tail);
        self.held = tail.len();
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.held > 0 {
            let pending = self.pending;
            let held = self.held;
            self.held = 0;
            self.group(&pending[..held], out);
        }
        if self.width > 0 && self.column > 0 {
            out.push(b'\n');
            self.column = 0;
        }
        Ok(())
    }
}

/// GNU coreutils 9.7 `base64 -d`: newlines are skipped, `-i` skips any
/// other byte outside the alphabet, unpadded tails and concatenated padded
/// blocks decode, and an invalid byte keeps the prefix decoded before it.
struct Decoder {
    ignore_garbage: bool,
    digits: u32,
    value: u32,
    padding: bool,
}

fn digit_of(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

impl Decoder {
    fn stray_bits(&self) -> bool {
        self.digits != 0 && self.value & ((1 << (2 * (4 - self.digits))) - 1) != 0
    }
}

impl Stream for Decoder {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.reserve(input.len() / 4 * 3 + 3);
        for &byte in input {
            let digit = digit_of(byte);
            if byte == b'\n' || (self.ignore_garbage && digit.is_none() && byte != b'=') {
                continue;
            }
            if self.padding {
                if byte != b'=' {
                    return Err(StreamError::new(INVALID));
                }
                self.padding = false;
            } else if let Some(digit) = digit {
                self.value = (self.value << 6) | digit;
                self.digits += 1;
                if self.digits >= 2 {
                    out.push(((self.value >> (2 * (4 - self.digits))) & 255) as u8);
                }
                if self.digits == 4 {
                    self.digits = 0;
                    self.value = 0;
                }
            } else if byte == b'=' && (self.digits == 2 || self.digits == 3) {
                if self.stray_bits() {
                    return Err(StreamError::new(INVALID));
                }
                self.padding = self.digits == 2;
                self.digits = 0;
                self.value = 0;
            } else {
                return Err(StreamError::new(INVALID));
            }
        }
        Ok(())
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.padding || self.digits == 1 || self.stray_bits() {
            return Err(StreamError::new(INVALID));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::run;

    const ENCODE: &str = r#"{"mode":"encode","wrap":76}"#;
    const DECODE: &str = r#"{"mode":"decode","ignore_garbage":false}"#;

    #[test]
    fn encodes_across_chunk_boundaries() {
        let data: Vec<u8> = (0u8..=255).cycle().take(1000).collect();
        let (whole, _) = run("base64", ENCODE, &[&data]);
        let pieces: Vec<&[u8]> = data.chunks(7).collect();
        let (split, _) = run("base64", ENCODE, &pieces);
        assert_eq!(whole, split);
        assert!(whole.ends_with(b"\n"));
        assert!(whole.split(|&b| b == b'\n').all(|line| line.len() <= 76));
    }

    #[test]
    fn encodes_like_gnu() {
        assert_eq!(run("base64", ENCODE, &[b"hello"]).0, b"aGVsbG8=\n");
        assert_eq!(
            run("base64", r#"{"mode":"encode","wrap":0}"#, &[b"hi"]).0,
            b"aGk="
        );
        assert_eq!(
            run("base64", r#"{"mode":"encode","wrap":4}"#, &[b"hello"]).0,
            b"aGVs\nbG8=\n"
        );
        assert_eq!(run("base64", ENCODE, &[b""]).0, b"");
    }

    #[test]
    fn decodes_like_gnu() {
        assert_eq!(
            run("base64", DECODE, &[b"aGVs", b"bG8=\n"]),
            (b"hello".to_vec(), None)
        );
        assert_eq!(run("base64", DECODE, &[b"aGk"]).0, b"hi");
        assert_eq!(run("base64", DECODE, &[b"aGk=aGk="]).0, b"hihi");
        let (out, err) = run("base64", DECODE, &[b"aGVs*bG8="]);
        assert_eq!(out, b"hel");
        assert_eq!(err.map(|e| e.message), Some("base64: invalid input".into()));
        let ignore = r#"{"mode":"decode","ignore_garbage":true}"#;
        assert_eq!(run("base64", ignore, &[b"aG*Vs"]).0, b"hel");
        assert!(run("base64", DECODE, &[b"a"]).1.is_some());
        assert!(run("base64", DECODE, &[b"aGl="]).1.is_some());
    }
}
