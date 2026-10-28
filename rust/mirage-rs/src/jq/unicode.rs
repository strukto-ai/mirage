// Adapted from jq 1.8.2 (MIT). See licenses/third_party/jq.txt.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::meter::Charge;
use crate::{Stream, StreamError};

pub(super) const BLOCK: usize = 4096;
pub(super) const WORK: usize = 16 * 1024;

#[derive(Default)]
pub(super) struct Bytes {
    blocks: BTreeMap<usize, Vec<u8>>,
    base: usize,
    len: usize,
    charge: Charge,
}

impl Bytes {
    pub(super) fn len(&self) -> usize {
        self.len
    }

    pub(super) fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub(super) fn get(&self, at: usize) -> Option<u8> {
        if at < self.base || at >= self.len {
            return None;
        }
        self.blocks.get(&(at / BLOCK))?.get(at % BLOCK).copied()
    }

    pub(super) fn push(&mut self, byte: u8) {
        self.blocks
            .entry(self.len / BLOCK)
            .or_insert_with(|| Vec::with_capacity(BLOCK))
            .push(byte);
        self.len += 1;
        self.charge.set(self.blocks.len() * (BLOCK + 64));
    }

    pub(super) fn extend(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.push(byte);
        }
    }

    pub(super) fn pop(&mut self) -> Option<u8> {
        let block = self.len.checked_sub(1)? / BLOCK;
        let value = self.blocks.get_mut(&block)?.pop()?;
        self.len -= 1;
        if self.blocks.get(&block).is_some_and(Vec::is_empty) {
            self.blocks.remove(&block);
        }
        self.charge.set(self.blocks.len() * (BLOCK + 64));
        Some(value)
    }

    pub(super) fn release_before(&mut self, at: usize) {
        while self.base + BLOCK <= at
            && self
                .blocks
                .get(&(self.base / BLOCK))
                .is_some_and(|b| b.len() == BLOCK)
        {
            self.blocks.remove(&(self.base / BLOCK));
            self.base += BLOCK;
            self.charge.set(self.blocks.len() * (BLOCK + 64));
        }
    }

    pub(super) fn discard_block(&mut self) -> bool {
        if let Some((id, _)) = self.blocks.pop_first() {
            self.base = ((id + 1) * BLOCK).min(self.len);
        }
        self.charge.set(self.blocks.len() * (BLOCK + 64));
        self.blocks.is_empty()
    }

    #[cfg(test)]
    pub(super) fn block_count(&self) -> usize {
        self.blocks.len()
    }
}

pub(super) fn decode_one(bytes: &Bytes, at: usize) -> (char, usize) {
    let first = bytes.get(at).unwrap();
    let length = match first {
        0..=0x7f => return (char::from(first), 1),
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return ('\u{fffd}', 1),
    };
    if length > bytes.len() - at {
        return ('\u{fffd}', bytes.len() - at);
    }
    let mut point = u32::from(first & (0xff >> (length + 1)));
    for k in 1..length {
        let byte = bytes.get(at + k).unwrap();
        if !(0x80..=0xbf).contains(&byte) {
            return ('\u{fffd}', k);
        }
        point = (point << 6) | u32::from(byte & 0x3f);
    }
    let minimum = [0, 0, 0x80, 0x800, 0x10000][length];
    if point < minimum {
        return ('\u{fffd}', length);
    }
    (char::from_u32(point).unwrap_or('\u{fffd}'), length)
}

fn decode_document_one(bytes: &Bytes, at: usize) -> (char, usize) {
    let first = bytes.get(at).unwrap();
    let length = match first {
        0..=0x7f => return (char::from(first), 1),
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return ('\u{fffd}', 1),
    };
    let mut point = u32::from(first & (0xff >> (length + 1)));
    for k in 1..length {
        let Some(byte) = bytes.get(at + k) else {
            return ('\u{fffd}', k);
        };
        if !(0x80..=0xbf).contains(&byte)
            || (k == 1
                && match first {
                    0xe0 => byte < 0xa0,
                    0xed => byte >= 0xa0,
                    0xf0 => byte < 0x90,
                    0xf4 => byte >= 0x90,
                    _ => false,
                })
        {
            return ('\u{fffd}', k);
        }
        point = (point << 6) | u32::from(byte & 0x3f);
    }
    (char::from_u32(point).unwrap(), length)
}

#[derive(Default)]
pub(super) struct DecodeCursor {
    pub(super) at: usize,
    pending: [u8; 4],
    used: usize,
    count: usize,
}

impl DecodeCursor {
    pub(super) fn write(
        &mut self,
        bytes: &mut Bytes,
        out: &mut Vec<u8>,
        max: usize,
        budget: &mut usize,
    ) -> bool {
        self.write_with(bytes, out, max, budget, decode_one)
    }

    pub(super) fn write_document(
        &mut self,
        bytes: &mut Bytes,
        out: &mut Vec<u8>,
        max: usize,
        budget: &mut usize,
    ) -> bool {
        self.write_with(bytes, out, max, budget, decode_document_one)
    }

    fn write_with(
        &mut self,
        bytes: &mut Bytes,
        out: &mut Vec<u8>,
        max: usize,
        budget: &mut usize,
        decode: fn(&Bytes, usize) -> (char, usize),
    ) -> bool {
        while out.len() < max && *budget > 0 {
            if self.used < self.count {
                out.push(self.pending[self.used]);
                self.used += 1;
                *budget -= 1;
                continue;
            }
            if self.at == bytes.len() {
                bytes.release_before(self.at);
                return true;
            }
            let (point, taken) = decode(bytes, self.at);
            self.at += taken;
            self.used = 0;
            self.count = point.encode_utf8(&mut self.pending).len();
            bytes.release_before(self.at);
            *budget = budget.saturating_sub(taken);
        }
        self.at == bytes.len() && self.used == self.count
    }
}

#[derive(Default)]
pub(super) struct JsonString {
    at: usize,
    phase: u8,
    pending: [u8; 12],
    used: usize,
    count: usize,
}

impl JsonString {
    pub(super) fn write(
        &mut self,
        bytes: &Bytes,
        out: &mut Vec<u8>,
        max: usize,
        budget: &mut usize,
    ) -> bool {
        while out.len() < max && *budget > 0 {
            if self.used < self.count {
                out.push(self.pending[self.used]);
                self.used += 1;
                *budget -= 1;
                continue;
            }
            self.used = 0;
            match self.phase {
                0 => {
                    self.pending[0] = b'"';
                    self.count = 1;
                    self.phase = 1;
                }
                1 if self.at < bytes.len() => {
                    let (point, taken) = decode_one(bytes, self.at);
                    self.at += taken;
                    *budget = budget.saturating_sub(taken);
                    let escape: Option<&[u8]> = match point {
                        '"' => Some(b"\\\""),
                        '\\' => Some(b"\\\\"),
                        '\u{8}' => Some(b"\\b"),
                        '\u{c}' => Some(b"\\f"),
                        '\n' => Some(b"\\n"),
                        '\r' => Some(b"\\r"),
                        '\t' => Some(b"\\t"),
                        _ => None,
                    };
                    if let Some(escaped) = escape {
                        self.pending[..escaped.len()].copy_from_slice(escaped);
                        self.count = escaped.len();
                    } else if point < '\u{20}' {
                        let number = point as u8;
                        self.pending[..4].copy_from_slice(b"\\u00");
                        self.pending[4] = b"0123456789abcdef"[(number >> 4) as usize];
                        self.pending[5] = b"0123456789abcdef"[(number & 15) as usize];
                        self.count = 6;
                    } else {
                        self.count = point.encode_utf8(&mut self.pending).len();
                    }
                }
                1 => {
                    self.pending[0] = b'"';
                    self.count = 1;
                    self.phase = 2;
                }
                _ => return true,
            }
        }
        self.phase == 2 && self.used == self.count
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct DecodeConfig {}

#[derive(Default, PartialEq)]
enum DecodeState {
    #[default]
    Reading,
    Finishing,
    Discarding,
    Ended,
}

#[derive(Default)]
struct DecodeStream {
    bytes: Bytes,
    cursor: DecodeCursor,
    state: DecodeState,
}

pub(crate) fn open_decode(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let _: DecodeConfig = crate::parse_config(config)?;
    Ok(Box::new(DecodeStream::default()))
}

impl Stream for DecodeStream {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.state != DecodeState::Reading {
            return Err(StreamError::new("jq decoder input has ended"));
        }
        if input.len() > WORK {
            return Err(StreamError::new("jq decoder input exceeds 16384 bytes"));
        }
        self.bytes.extend(input);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.state == DecodeState::Reading {
            self.state = DecodeState::Finishing;
        }
        self.drain(out)
    }

    fn busy(&self) -> bool {
        matches!(self.state, DecodeState::Finishing | DecodeState::Discarding)
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.state == DecodeState::Finishing {
            let mut budget = WORK;
            let max = out.len() + WORK;
            if self.cursor.write(&mut self.bytes, out, max, &mut budget) {
                self.state = DecodeState::Discarding;
            }
        } else if self.state == DecodeState::Discarding {
            for _ in 0..WORK / BLOCK {
                if self.bytes.discard_block() {
                    self.state = DecodeState::Ended;
                    break;
                }
            }
        }
        Ok(())
    }

    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let config: super::BeginConfig = crate::parse_config(config)?;
        if !config.discard {
            return Err(StreamError::new("jq decoder begin requires discard=true"));
        }
        self.cursor = DecodeCursor::default();
        if self.state != DecodeState::Ended {
            self.state = DecodeState::Discarding;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jq_utf8_replacement_groups_cross_feed_boundaries() {
        let cases: &[(&[u8], &str)] = &[
            (b"plain", "plain"),
            (b"\xf0\x80\x80\x80", "\u{fffd}"),
            (b"\xed\xa0\x80", "\u{fffd}"),
            (b"\xf4\x90\x80\x80", "\u{fffd}"),
            (b"\xe2\x82", "\u{fffd}"),
            (b"\xc0\x80", "\u{fffd}\u{fffd}"),
            (b"\xe2\x82x", "\u{fffd}x"),
            (b"\xe2a", "\u{fffd}"),
            (b"a\xffb", "a\u{fffd}b"),
        ];
        for &(input, expected) in cases {
            for size in 1..=input.len().max(1) {
                let mut decoder = open_decode(b"{}").unwrap();
                let mut out = Vec::new();
                for chunk in input.chunks(size) {
                    decoder.feed(chunk, &mut out).unwrap();
                    assert!(out.is_empty());
                }
                decoder.finish(&mut out).unwrap();
                while decoder.busy() {
                    decoder.drain(&mut out).unwrap();
                }
                assert_eq!(String::from_utf8(out).unwrap(), expected);
                let mut again = Vec::new();
                decoder.finish(&mut again).unwrap();
                assert!(again.is_empty());
            }
        }
    }

    #[test]
    fn decode_calls_and_copies_are_bounded() {
        let input = b"\xf0\x9f\x98\x80\xe2a".repeat(100_000);
        let mut decoder = open_decode(b"{}").unwrap();
        for chunk in input.chunks(WORK) {
            decoder.feed(chunk, &mut Vec::new()).unwrap();
        }
        let mut bytes = 0;
        let mut out = Vec::new();
        decoder.finish(&mut out).unwrap();
        assert!(out.len() <= WORK);
        bytes += out.len();
        while decoder.busy() {
            let mut out = Vec::new();
            decoder.drain(&mut out).unwrap();
            assert!(out.len() <= WORK);
            bytes += out.len();
        }
        assert!(bytes > 600_000);
    }

    #[test]
    fn discard_retires_decoder_blocks_without_more_output() {
        for started in [false, true] {
            let mut decoder = DecodeStream::default();
            for _ in 0..100 {
                decoder.feed(&vec![b'a'; WORK], &mut Vec::new()).unwrap();
            }
            if started {
                let mut out = Vec::new();
                decoder.finish(&mut out).unwrap();
                assert!(!out.is_empty());
            }
            let before = decoder.bytes.block_count();
            decoder.begin(br#"{"discard":true}"#).unwrap();
            assert_eq!(decoder.bytes.block_count(), before);
            let mut previous = before;
            while decoder.busy() {
                let mut out = Vec::new();
                decoder.drain(&mut out).unwrap();
                assert!(out.is_empty());
                let remaining = decoder.bytes.block_count();
                assert!(previous - remaining <= WORK / BLOCK);
                previous = remaining;
            }
            assert_eq!(decoder.bytes.block_count(), 0);
            let mut out = Vec::new();
            decoder.finish(&mut out).unwrap();
            decoder.begin(br#"{"discard":true}"#).unwrap();
            assert!(!decoder.busy());
            assert!(out.is_empty());
        }
    }

    #[test]
    fn decoder_finish_releases_the_final_partial_block() {
        let mut decoder = DecodeStream::default();
        decoder.feed(b"partial", &mut Vec::new()).unwrap();
        let mut out = Vec::new();
        decoder.finish(&mut out).unwrap();
        while decoder.busy() {
            decoder.drain(&mut out).unwrap();
        }
        assert_eq!(out, b"partial");
        assert_eq!(decoder.bytes.block_count(), 0);
    }

    #[test]
    fn decoder_discard_requires_explicit_configuration_and_bounded_input() {
        let mut decoder = open_decode(b"{}").unwrap();
        assert!(decoder.begin(b"{}").is_err());
        assert!(decoder.begin(br#"{"discard":true,"extra":true}"#).is_err());
        assert!(
            decoder
                .feed(&vec![b'a'; WORK + 1], &mut Vec::new())
                .is_err()
        );
        assert!(!decoder.busy());
    }
}
