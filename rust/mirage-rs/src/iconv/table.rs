//! The tables iconv's multi-byte and single-byte charsets read, each seeded
//! once per process from encoding_rs's WHATWG decoder and corrected to the
//! table glibc 2.41 converts with.

use encoding_rs::{DecoderResult, Encoding};

use crate::generated::iconv_data;

/// Where a charset's standard differs from the WHATWG decoder that seeds
/// it; scripts/gen_iconv_multibyte.py derives them from the standards'
/// published tables.
pub(crate) struct Corrections {
    /// A sequence, read big-endian, and the standard's code point.
    pub(crate) remapped: &'static [(u32, u32)],
    /// The first and last sequence of a range the standard leaves unmapped.
    pub(crate) excluded: &'static [(u32, u32)],
    /// Code points glibc encodes to a sequence that decodes to another one.
    pub(crate) one_way: &'static [(u32, u32)],
}

/// What one step of a decoder read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// A code point and the bytes it took.
    Char(u32, usize),
    /// A sequence the charset refuses, and the bytes `-c` skips.
    Illegal(usize),
    /// A sequence the input ends inside of.
    Cut,
}

/// The byte grammar of a multi-byte charset, measured from glibc 2.41.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Grammar {
    Gbk,
    EucCn,
    Gb18030,
    EucKr,
    Sjis,
    EucJp,
}

type Ranges = &'static [(u8, u8)];

/// One multi-byte charset: its grammar over a table seeded from
/// `encoding` for every sequence in `blocks` (per-byte ranges), a
/// private-use answer dropped unless its standard maps into that area.
pub(crate) struct Spec {
    pub(crate) grammar: Grammar,
    encoding: &'static Encoding,
    pub(crate) blocks: &'static [&'static [Ranges]],
    corrections: Corrections,
    private_use: bool,
}

const GBK_TRAIL: Ranges = &[(0x40, 0x7E), (0x80, 0xFE)];
const SJIS_TRAIL: Ranges = &[(0x40, 0x7E), (0x80, 0xFC)];
const EUC_BYTE: Ranges = &[(0xA1, 0xFE)];
const DIGIT: Ranges = &[(0x30, 0x39)];
const LETTER: Ranges = &[(0x81, 0xFE)];

pub(crate) const GBK: Spec = Spec {
    grammar: Grammar::Gbk,
    encoding: encoding_rs::GBK,
    blocks: &[
        &[&[(0x81, 0xFD)], GBK_TRAIL],
        &[&[(0xFE, 0xFE)], &[(0x40, 0x7E), (0x80, 0xA0)]],
    ],
    corrections: iconv_data::GBK,
    private_use: false,
};

pub(crate) const EUC_CN: Spec = Spec {
    grammar: Grammar::EucCn,
    encoding: encoding_rs::GBK,
    blocks: &[&[&[(0xA1, 0xF7)], EUC_BYTE]],
    corrections: iconv_data::EUC_CN,
    private_use: false,
};

pub(crate) const GB18030: Spec = Spec {
    grammar: Grammar::Gb18030,
    encoding: encoding_rs::GB18030,
    blocks: &[
        &[LETTER, GBK_TRAIL],
        &[&[(0x81, 0x83)], DIGIT, LETTER, DIGIT],
        &[&[(0x84, 0x84)], &[(0x30, 0x30)], LETTER, DIGIT],
        &[&[(0x84, 0x84)], &[(0x31, 0x31)], &[(0x81, 0xA4)], DIGIT],
    ],
    corrections: iconv_data::GB18030,
    private_use: true,
};

pub(crate) const EUC_KR: Spec = Spec {
    grammar: Grammar::EucKr,
    encoding: encoding_rs::EUC_KR,
    blocks: &[&[EUC_BYTE, EUC_BYTE]],
    corrections: iconv_data::EUC_KR,
    private_use: false,
};

pub(crate) const SJIS: Spec = Spec {
    grammar: Grammar::Sjis,
    encoding: encoding_rs::SHIFT_JIS,
    blocks: &[
        &[&[(0x81, 0x9F)], SJIS_TRAIL],
        &[&[(0xE0, 0xEA)], SJIS_TRAIL],
    ],
    corrections: iconv_data::SJIS,
    private_use: false,
};

pub(crate) const EUC_JP: Spec = Spec {
    grammar: Grammar::EucJp,
    encoding: encoding_rs::EUC_JP,
    blocks: &[
        &[EUC_BYTE, EUC_BYTE],
        &[&[(0x8E, 0x8E)], &[(0xA1, 0xDF)]],
        &[&[(0x8F, 0x8F)], &[(0xA2, 0xED)], EUC_BYTE],
    ],
    corrections: iconv_data::EUC_JP,
    private_use: false,
};

/// GB18030's four-byte sequences below this pointer are the BMP's.
const GB_BMP: usize = 39420;
const PRIVATE_USE: std::ops::RangeInclusive<u32> = 0xE000..=0xF8FF;
const ABSENT: u32 = u32::MAX;

/// Code point to sequence, read big-endian, a page of the BMP at a time.
#[derive(Default)]
pub(crate) struct Reverse {
    pages: Vec<Option<Box<[u32; 256]>>>,
}

impl Reverse {
    pub(crate) fn get(&self, cp: u32) -> Option<u32> {
        let page = self.pages.get(usize::try_from(cp >> 8).ok()?)?.as_deref()?;
        let seq = page[(cp & 0xFF) as usize];
        (seq != ABSENT).then_some(seq)
    }

    fn put(&mut self, cp: u32, seq: u32, keep: bool) {
        let at = (cp >> 8) as usize;
        if self.pages.len() <= at {
            self.pages.resize_with(at + 1, || None);
        }
        let page = self.pages[at].get_or_insert_with(|| Box::new([ABSENT; 256]));
        let slot = &mut page[(cp & 0xFF) as usize];
        if !keep || *slot == ABSENT {
            *slot = seq;
        }
    }
}

/// A sequence's bytes, read big-endian, as wide as its value needs.
pub(crate) fn put_sequence(seq: u32, out: &mut Vec<u8>) {
    let bytes = seq.to_be_bytes();
    let skip =
        usize::from(seq <= 0xFF_FFFF) + usize::from(seq <= 0xFFFF) + usize::from(seq <= 0xFF);
    out.extend_from_slice(&bytes[skip..]);
}

/// A multi-byte charset's tables: two-byte sequences by their value past
/// 0x8000, EUC-JP's three-byte and GB18030's four-byte ones by index, 0
/// where none maps (no sequence there decodes to U+0000).
pub(crate) struct Multibyte {
    pub(crate) grammar: Grammar,
    two: Box<[u16]>,
    wide: Box<[u16]>,
    pub(crate) reverse: Reverse,
}

impl Grammar {
    /// The index of a three- or four-byte sequence in `wide`.
    fn wide_index(self, seq: &[u8]) -> Option<usize> {
        let at = |i: usize, base: u8| usize::from(seq[i].wrapping_sub(base));
        match (self, seq.len()) {
            (Grammar::EucJp, 3) => Some(at(1, 0xA1) * 94 + at(2, 0xA1)),
            (Grammar::Gb18030, 4) => {
                let index =
                    (at(0, 0x81) * 10 + at(1, 0x30)) * 1260 + at(2, 0x81) * 10 + at(3, 0x30);
                (index < GB_BMP).then_some(index)
            }
            _ => None,
        }
    }

    fn wide_len(self) -> usize {
        match self {
            Grammar::EucJp => 94 * 94,
            Grammar::Gb18030 => GB_BMP,
            _ => 0,
        }
    }
}

impl Multibyte {
    pub(crate) fn get(&self, seq: &[u8]) -> Option<u32> {
        let cp = if seq.len() == 2 {
            self.two[usize::from(u16::from_be_bytes([seq[0], seq[1]])) - 0x8000]
        } else {
            self.wide[self.grammar.wide_index(seq)?]
        };
        (cp != 0).then_some(u32::from(cp))
    }

    fn set(&mut self, seq: &[u8], cp: u16) {
        if seq.len() == 2 {
            self.two[usize::from(u16::from_be_bytes([seq[0], seq[1]])) - 0x8000] = cp;
        } else if let Some(index) = self.grammar.wide_index(seq) {
            self.wide[index] = cp;
        }
    }

    fn pair(&self, raw: &[u8], at: usize, unmapped: usize) -> Step {
        match self.get(&raw[at..at + 2]) {
            Some(cp) => Step::Char(cp, 2),
            None => Step::Illegal(unmapped),
        }
    }

    /// One character at `at`.
    pub(crate) fn step(&self, raw: &[u8], at: usize) -> Step {
        let lead = raw[at];
        let byte = |i: usize| raw.get(at + i).copied();
        match self.grammar {
            Grammar::Gbk => match (lead, byte(1)) {
                (..0x80, _) => Step::Char(u32::from(lead), 1),
                (0x80, _) => Step::Char(0x20AC, 1),
                (0xFF, _) => Step::Illegal(1),
                (_, None) => Step::Cut,
                (_, Some(trail))
                    if trail < 0x40 || trail == 0xFF || (lead == 0xFE && trail > 0xA0) =>
                {
                    Step::Illegal(1)
                }
                _ => self.pair(raw, at, 2),
            },
            Grammar::EucCn => match (lead, byte(1)) {
                (..0x80, _) => Step::Char(u32::from(lead), 1),
                (0xFF, _) | (..=0xA0, _) if lead != 0x8E && lead != 0x8F => Step::Illegal(1),
                (_, None) => Step::Cut,
                (_, Some(..0xA1)) => Step::Illegal(1),
                _ => self.pair(raw, at, 2),
            },
            // Bytes up to 0x9F stand for themselves, C1 controls included,
            // and a refused pair is skipped whole whatever its second byte.
            Grammar::EucKr => match (lead, byte(1)) {
                (..=0x9F, _) => Step::Char(u32::from(lead), 1),
                (0xA0, _) => Step::Illegal(1),
                (_, None) => Step::Cut,
                _ => self.pair(raw, at, 2),
            },
            // 0x5C and 0x7E are JIS X 0201's yen sign and overline, and
            // 0xA1-0xDF its half-width katakana.
            Grammar::Sjis => match (lead, byte(1)) {
                (0x5C, _) => Step::Char(0xA5, 1),
                (0x7E, _) => Step::Char(0x203E, 1),
                (..0x80, _) => Step::Char(u32::from(lead), 1),
                (0xA1..=0xDF, _) => Step::Char(u32::from(lead) + 0xFEC0, 1),
                (0x80 | 0xA0 | 0xEB.., _) => Step::Illegal(1),
                (_, None) => Step::Cut,
                (_, Some(..0x40)) => Step::Illegal(1),
                _ => self.pair(raw, at, 2),
            },
            // Code set 2 (0x8E) is half-width katakana and code set 3
            // (0x8F) JIS X 0212, whose rows outside 0x22-0x6D are refused
            // before the third byte is asked for; one byte of any refused
            // sequence is skipped.
            Grammar::EucJp => match (lead, byte(1), byte(2)) {
                (..=0x8D | 0x90..=0x9F, _, _) => Step::Char(u32::from(lead), 1),
                (0xFF, _, _) => Step::Illegal(1),
                (_, None, _) => Step::Cut,
                (_, Some(..0xA1), _) => Step::Illegal(1),
                (0x8F, Some(second), _) if !(0xA2..=0xED).contains(&second) => Step::Illegal(1),
                (0x8F, _, None) => Step::Cut,
                (0x8F, _, _) => self
                    .get(&raw[at..at + 3])
                    .map_or(Step::Illegal(1), |cp| Step::Char(cp, 3)),
                _ => self.pair(raw, at, 1),
            },
            Grammar::Gb18030 => match (lead, byte(1)) {
                (..0x80, _) => Step::Char(u32::from(lead), 1),
                (0x80 | 0xFF, _) => Step::Illegal(1),
                (_, None) => Step::Cut,
                (_, Some(0x30..=0x39)) => self.four(raw, at),
                (_, Some(second)) if second < 0x40 || second == 0x7F || second == 0xFF => {
                    Step::Illegal(2)
                }
                _ => self.pair(raw, at, 2),
            },
        }
    }

    /// A GB18030 four-byte sequence: planes 1-16 are a straight count
    /// from 0x90308130, the BMP's are in the table.
    fn four(&self, raw: &[u8], at: usize) -> Step {
        let Some(seq) = raw.get(at..at + 4) else {
            return Step::Cut;
        };
        if !(0x81..=0xFE).contains(&seq[2]) {
            return Step::Illegal(3);
        }
        if !(0x30..=0x39).contains(&seq[3]) {
            return Step::Illegal(4);
        }
        let cp = if (0x90..=0xE3).contains(&seq[0]) {
            let at = |i: usize, base: u8| u32::from(seq[i] - base);
            let cp = 0x10000
                + (((at(0, 0x90) * 10 + at(1, 0x30)) * 126 + at(2, 0x81)) * 10 + at(3, 0x30));
            (cp <= 0x10FFFF).then_some(cp)
        } else {
            self.get(seq)
        };
        cp.map_or(Step::Illegal(4), |cp| Step::Char(cp, 4))
    }

    /// GB18030's four-byte sequence of a code point past the BMP.
    pub(crate) fn supplementary(cp: u32) -> u32 {
        let index = cp - 0x10000;
        let (index, b4) = (index / 10, index % 10);
        let (index, b3) = (index / 126, index % 126);
        u32::from_be_bytes([
            0x90 + (index / 10) as u8,
            0x30 + (index % 10) as u8,
            0x81 + b3 as u8,
            0x30 + b4 as u8,
        ])
    }
}

/// What the WHATWG decoder answers for one whole sequence, when it is one
/// BMP character.
fn seed(encoding: &'static Encoding, seq: &[u8]) -> Option<u16> {
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut unit = [0u16; 2];
    let (result, read, written) = decoder.decode_to_utf16_without_replacement(seq, &mut unit, true);
    (result == DecoderResult::InputEmpty && read == seq.len() && written == 1).then_some(unit[0])
}

/// Call `each` with every sequence a block spans, in byte order.
pub(crate) fn walk(block: &[Ranges], seq: &mut Vec<u8>, each: &mut dyn FnMut(&[u8])) {
    let Some((ranges, rest)) = block.split_first() else {
        return each(seq);
    };
    for &(low, high) in *ranges {
        for byte in low..=high {
            seq.push(byte);
            walk(rest, seq, each);
            seq.pop();
        }
    }
}

impl Spec {
    /// The tables, seeded and corrected; glibc encodes with the decode
    /// table turned around, single bytes first, plus its one-way entries.
    pub(crate) fn build(&self) -> Multibyte {
        let mut table = Multibyte {
            grammar: self.grammar,
            two: vec![0; 0x8000].into_boxed_slice(),
            wide: vec![0; self.grammar.wide_len()].into_boxed_slice(),
            reverse: Reverse::default(),
        };
        let excluded = |seq: &[u8]| {
            let key = seq.iter().fold(0u32, |key, &b| key << 8 | u32::from(b));
            self.corrections
                .excluded
                .iter()
                .any(|&(low, high)| (low..=high).contains(&key))
        };
        let mut seq = Vec::with_capacity(4);
        for block in self.blocks {
            walk(block, &mut seq, &mut |seq| {
                let Some(cp) = seed(self.encoding, seq).filter(|_| !excluded(seq)) else {
                    return;
                };
                if self.private_use || !PRIVATE_USE.contains(&u32::from(cp)) {
                    table.set(seq, cp);
                }
            });
        }
        for &(key, cp) in self.corrections.remapped {
            let bytes = key.to_be_bytes();
            table.set(
                &bytes[bytes.iter().take_while(|&&b| b == 0).count()..],
                cp as u16,
            );
        }
        let mut reverse = Reverse::default();
        for byte in 0..=255u8 {
            if let Step::Char(cp, 1) = table.step(&[byte], 0) {
                reverse.put(cp, u32::from(byte), true);
            }
        }
        for block in self.blocks {
            walk(block, &mut seq, &mut |seq| {
                if let Some(cp) = table.get(seq) {
                    let key = seq.iter().fold(0u32, |key, &b| key << 8 | u32::from(b));
                    reverse.put(cp, key, true);
                }
            });
        }
        for &(cp, key) in self.corrections.one_way {
            reverse.put(cp, key, false);
        }
        table.reverse = reverse;
        table
    }
}

/// How a single-byte charset's high half differs from its WHATWG decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum High {
    /// As WHATWG has it.
    Whatwg,
    /// An ISO 8859 part WHATWG reads as a Windows code page: 0x80-0x9F
    /// are the C1 controls.
    Controls,
    /// A Windows code page: WHATWG fills each byte in 0x80-0x9F the vendor
    /// table leaves undefined with the C1 control of its value, which
    /// glibc refuses.
    Holes,
    /// TIS-620: ISO 8859-11 without the C1 controls and the no-break space.
    Tis,
    /// KOI8-U as RFC 2319 has it: WHATWG's is KOI8-RU, whose 0xAE and 0xBE
    /// are Ukrainian letters where KOI8-U keeps KOI8-R's box drawing.
    Koi8u,
}

/// A single-byte charset's tables.
pub(crate) struct Single {
    pub(crate) decode: Box<[u32; 256]>,
    pub(crate) reverse: Reverse,
}

pub(crate) fn single(encoding: &'static Encoding, high: High) -> Single {
    let mut decode = Box::new([ABSENT; 256]);
    for (byte, slot) in (0..=255u8).zip(decode.iter_mut()) {
        let from = match (high, byte) {
            (High::Koi8u, 0xAE | 0xBE) => encoding_rs::KOI8_R,
            _ => encoding,
        };
        let cp = seed(from, &[byte]).map(u32::from);
        *slot = match (high, byte) {
            (High::Controls, 0x80..=0x9F) => u32::from(byte),
            (High::Holes, 0x80..=0x9F) if cp == Some(u32::from(byte)) => ABSENT,
            (High::Tis, 0x80..=0xA0) => ABSENT,
            _ => cp.unwrap_or(ABSENT),
        };
    }
    let mut reverse = Reverse::default();
    for (byte, &cp) in decode.iter().enumerate() {
        if cp != ABSENT {
            reverse.put(cp, byte as u32, true);
        }
    }
    Single { decode, reverse }
}
