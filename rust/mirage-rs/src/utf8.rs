/// What the decoder emits for one maximal invalid subpart: past anything it
/// decodes, so a caller can tell it from a U+FFFD the input spelled.
pub(crate) const INVALID: u32 = u32::MAX;

/// An incremental UTF-8 decoder in the reading GNU `wc` 9.7 shows in
/// C.UTF-8: overlong forms and surrogates are invalid, one `INVALID` per
/// maximal subpart as WHATWG counts them, but ISO 10646's 31-bit range still
/// reads, so a 4-byte form past U+10FFFF and the 5- and 6-byte forms decode.
/// A sequence split across chunks decodes as if it were whole.
#[derive(Default)]
pub(crate) struct Decoder {
    needed: u8,
    seen: u8,
    code_point: u32,
    lower: u8,
    upper: u8,
}

impl Decoder {
    pub(crate) fn new() -> Self {
        Self {
            lower: 0x80,
            upper: 0xBF,
            ..Self::default()
        }
    }

    pub(crate) fn pending(&self) -> bool {
        self.needed != 0
    }

    /// Decode `bytes`, calling `emit` once per code point.
    pub(crate) fn decode(&mut self, bytes: &[u8], mut emit: impl FnMut(u32)) {
        let mut i = 0;
        while i < bytes.len() {
            let byte = bytes[i];
            if self.needed == 0 {
                match lead(byte) {
                    Some(Lead::Ascii) => emit(u32::from(byte)),
                    Some(Lead::Sequence(needed, bits, lower, upper)) => {
                        self.start(needed, bits, lower, upper)
                    }
                    None => emit(INVALID),
                }
                i += 1;
                continue;
            }
            if byte < self.lower || byte > self.upper {
                self.reset();
                emit(INVALID);
                continue;
            }
            self.lower = 0x80;
            self.upper = 0xBF;
            self.code_point = (self.code_point << 6) | u32::from(byte & 0x3F);
            self.seen += 1;
            if self.seen == self.needed {
                let cp = self.code_point;
                self.reset();
                emit(cp);
            }
            i += 1;
        }
    }

    /// End of input: an unfinished sequence is one invalid subpart.
    pub(crate) fn finish(&mut self, mut emit: impl FnMut(u32)) {
        if self.needed != 0 {
            self.reset();
            emit(INVALID);
        }
    }

    fn start(&mut self, needed: u8, bits: u8, lower: u8, upper: u8) {
        self.needed = needed;
        self.seen = 0;
        self.code_point = u32::from(bits);
        self.lower = lower;
        self.upper = upper;
    }

    fn reset(&mut self) {
        self.needed = 0;
        self.seen = 0;
        self.code_point = 0;
        self.lower = 0x80;
        self.upper = 0xBF;
    }
}

enum Lead {
    Ascii,
    /// Continuation bytes still to come, the lead's payload bits, and the
    /// range the first continuation byte must fall in.
    Sequence(u8, u8, u8, u8),
}

fn lead(byte: u8) -> Option<Lead> {
    Some(match byte {
        0x00..=0x7F => Lead::Ascii,
        0xC2..=0xDF => Lead::Sequence(1, byte & 0x1F, 0x80, 0xBF),
        0xE0 => Lead::Sequence(2, byte & 0x0F, 0xA0, 0xBF),
        0xED => Lead::Sequence(2, byte & 0x0F, 0x80, 0x9F),
        0xE1..=0xEF => Lead::Sequence(2, byte & 0x0F, 0x80, 0xBF),
        0xF0 => Lead::Sequence(3, byte & 0x07, 0x90, 0xBF),
        0xF1..=0xF7 => Lead::Sequence(3, byte & 0x07, 0x80, 0xBF),
        0xF8 => Lead::Sequence(4, byte & 0x03, 0x88, 0xBF),
        0xF9..=0xFB => Lead::Sequence(4, byte & 0x03, 0x80, 0xBF),
        0xFC => Lead::Sequence(5, byte & 0x01, 0x84, 0xBF),
        0xFD => Lead::Sequence(5, byte & 0x01, 0x80, 0xBF),
        _ => return None,
    })
}

/// What opens a run of bytes, read as `Decoder` reads a character.
pub(crate) enum Char {
    /// A character, its length in bytes and its code point.
    Whole(usize, u32),
    /// The start of a character the bytes seen so far do not finish.
    Partial,
    /// A byte that starts no character; a column counter takes it alone,
    /// as glibc's `mbrtowc` does.
    Invalid,
}

/// The character that opens `bytes`, which must not be empty.
pub(crate) fn char_at(bytes: &[u8]) -> Char {
    let (needed, bits, mut lower, mut upper) = match lead(bytes[0]) {
        Some(Lead::Ascii) => return Char::Whole(1, u32::from(bytes[0])),
        Some(Lead::Sequence(needed, bits, lower, upper)) => (needed, bits, lower, upper),
        None => return Char::Invalid,
    };
    let mut cp = u32::from(bits);
    for at in 1..=usize::from(needed) {
        let Some(&byte) = bytes.get(at) else {
            return Char::Partial;
        };
        if byte < lower || byte > upper {
            return Char::Invalid;
        }
        (lower, upper) = (0x80, 0xBF);
        cp = (cp << 6) | u32::from(byte & 0x3F);
    }
    Char::Whole(usize::from(needed) + 1, cp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(chunks: &[&[u8]]) -> String {
        let mut decoder = Decoder::new();
        let mut out = String::new();
        for chunk in chunks {
            decoder.decode(chunk, |cp| {
                out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
            });
        }
        decoder.finish(|cp| out.push(char::from_u32(cp).unwrap_or('\u{FFFD}')));
        out
    }

    // None of these reaches past U+10FFFF, where the two readings differ.
    #[test]
    fn matches_lossy_decoding_across_splits() {
        let samples: [&[u8]; 6] = [
            "héllo 数据".as_bytes(),
            b"\xff\xfe abc",
            b"\xe6\x95",
            b"\xf0\x9f\x98\x80\xf0\x9f",
            b"\xed\xa0\x80x",
            b"\xc3\x28\xe2\x82",
        ];
        for sample in samples {
            let expected = String::from_utf8_lossy(sample).into_owned();
            assert_eq!(decode_all(&[sample]), expected);
            for split in 0..=sample.len() {
                assert_eq!(decode_all(&[&sample[..split], &sample[split..]]), expected);
            }
        }
    }
}

#[cfg(test)]
mod wide_tests {
    use super::*;

    fn code_points(bytes: &[u8]) -> Vec<u32> {
        let mut decoder = Decoder::new();
        let mut out = Vec::new();
        decoder.decode(bytes, |cp| out.push(cp));
        decoder.finish(|cp| out.push(cp));
        out
    }

    #[test]
    fn reads_the_31_bit_range() {
        assert_eq!(code_points(b"\xf4\x90\x80\x80"), [0x11_0000]);
        assert_eq!(code_points(b"\xf7\xbf\xbf\xbf"), [0x1F_FFFF]);
        assert_eq!(code_points(b"\xf8\x88\x80\x80\x80"), [0x20_0000]);
        assert_eq!(code_points(b"\xfc\x84\x80\x80\x80\x80"), [0x400_0000]);
        assert_eq!(code_points(b"\xc0\xaf"), [INVALID, INVALID]);
        assert_eq!(code_points(b"\xed\xa0\x80"), [INVALID, INVALID, INVALID]);
        assert_eq!(code_points(b"\xf8\x80\x80\x80\x80"), [INVALID; 5]);
    }
}

/// The ASCII prefix, testing eight bytes at a time without alignment assumptions.
pub(crate) fn ascii_run(bytes: &[u8]) -> usize {
    let mut at = 0;
    while let Some(chunk) = bytes.get(at..at + 8) {
        if u64::from_ne_bytes(chunk.try_into().unwrap()) & 0x8080_8080_8080_8080 != 0 {
            break;
        }
        at += 8;
    }
    at + bytes[at..]
        .iter()
        .take_while(|byte| byte.is_ascii())
        .count()
}

/// One Unicode scalar or maximal invalid subpart, using the replacement reading.
pub(crate) fn scalar(bytes: &[u8]) -> (char, usize) {
    let first = bytes[0];
    if first < 0x80 {
        return (char::from(first), 1);
    }
    let (len, low, high) = match first {
        0xC2..=0xDF => (2, 0x80, 0xBF),
        0xE0 => (3, 0xA0, 0xBF),
        0xED => (3, 0x80, 0x9F),
        0xE1..=0xEF => (3, 0x80, 0xBF),
        0xF0 => (4, 0x90, 0xBF),
        0xF4 => (4, 0x80, 0x8F),
        0xF1..=0xF3 => (4, 0x80, 0xBF),
        _ => return ('\u{FFFD}', 1),
    };
    let mut cp = u32::from(first & (0x7F >> len));
    for at in 1..len {
        let Some(&byte) = bytes.get(at) else {
            return ('\u{FFFD}', at);
        };
        let (lo, hi) = if at == 1 { (low, high) } else { (0x80, 0xBF) };
        if !(lo..=hi).contains(&byte) {
            return ('\u{FFFD}', at);
        }
        cp = cp << 6 | u32::from(byte & 0x3F);
    }
    (char::from_u32(cp).expect("validated scalar"), len)
}

/// Strict scalar width; an invalid byte stands alone.
pub(crate) fn unit_len(bytes: &[u8]) -> usize {
    let (ch, len) = scalar(bytes);
    if ch == '\u{FFFD}' && !bytes.starts_with(b"\xef\xbf\xbd") {
        1
    } else {
        len
    }
}

#[derive(Default)]
pub(crate) struct Validator {
    pub(crate) left: u8,
    low: u8,
    high: u8,
    pub(crate) invalid: bool,
}
impl Validator {
    pub(crate) fn push(&mut self, byte: u8) {
        if self.invalid {
            return;
        }
        if self.left > 0 {
            if byte < self.low || byte > self.high {
                self.invalid = true;
                return;
            }
            self.left -= 1;
            self.low = 0x80;
            self.high = 0xBF;
            return;
        }
        (self.left, self.low, self.high) = match byte {
            0..=0x7F => (0, 0x80, 0xBF),
            0xC2..=0xDF => (1, 0x80, 0xBF),
            0xE0 => (2, 0xA0, 0xBF),
            0xED => (2, 0x80, 0x9F),
            0xE1..=0xEF => (2, 0x80, 0xBF),
            0xF0 => (3, 0x90, 0xBF),
            0xF1..=0xF3 => (3, 0x80, 0xBF),
            0xF4 => (3, 0x80, 0x8F),
            _ => {
                self.invalid = true;
                (0, 0x80, 0xBF)
            }
        };
    }
}

#[cfg(test)]
mod scalar_tests {
    use super::*;
    #[test]
    fn maximal_subparts_match_the_standard_decoder() {
        let mut state = 17u64;
        for width in 1..=4 {
            for _ in 0..10_000 {
                let mut bytes = [0u8; 4];
                for byte in &mut bytes[..width] {
                    state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                    *byte = (state >> 32) as u8;
                }
                let input = &bytes[..width];
                let mut at = 0;
                let mut actual = String::new();
                while at < input.len() {
                    let (ch, len) = scalar(&input[at..]);
                    actual.push(ch);
                    at += len;
                }
                assert_eq!(actual, String::from_utf8_lossy(input), "{input:?}");
                let mut validator = Validator::default();
                for &byte in input {
                    validator.push(byte);
                }
                assert_eq!(
                    !validator.invalid && validator.left == 0,
                    std::str::from_utf8(input).is_ok()
                );
            }
        }
    }
}
