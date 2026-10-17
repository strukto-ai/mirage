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

    /// Decode `bytes`, calling `emit` once per code point.
    pub(crate) fn decode(&mut self, bytes: &[u8], mut emit: impl FnMut(u32)) {
        let mut i = 0;
        while i < bytes.len() {
            let byte = bytes[i];
            if self.needed == 0 {
                match byte {
                    0x00..=0x7F => emit(u32::from(byte)),
                    0xC2..=0xDF => self.start(1, byte & 0x1F, 0x80, 0xBF),
                    0xE0 => self.start(2, byte & 0x0F, 0xA0, 0xBF),
                    0xED => self.start(2, byte & 0x0F, 0x80, 0x9F),
                    0xE1..=0xEF => self.start(2, byte & 0x0F, 0x80, 0xBF),
                    0xF0 => self.start(3, byte & 0x07, 0x90, 0xBF),
                    0xF1..=0xF7 => self.start(3, byte & 0x07, 0x80, 0xBF),
                    0xF8 => self.start(4, byte & 0x03, 0x88, 0xBF),
                    0xF9..=0xFB => self.start(4, byte & 0x03, 0x80, 0xBF),
                    0xFC => self.start(5, byte & 0x01, 0x84, 0xBF),
                    0xFD => self.start(5, byte & 0x01, 0x80, 0xBF),
                    _ => emit(INVALID),
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
