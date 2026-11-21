/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::parsers::MessageStream;
use std::borrow::Cow;

const B64_INVALID: u8 = 0xff;
#[cfg(feature = "base64_slice")]
const B64_STOP_SCAN: usize = 512;

static BASE64_DECODE: [u8; 256] = base64_decode_table();

const fn base64_decode_table() -> [u8; 256] {
    let mut table = [B64_INVALID; 256];
    let mut value = 0u8;
    while value < 64 {
        let ch = match value {
            0..=25 => b'A' + value,
            26..=51 => b'a' + (value - 26),
            52..=61 => b'0' + (value - 52),
            62 => b'+',
            _ => b'/',
        };
        table[ch as usize] = value;
        value += 1;
    }
    table
}

enum Base64Byte {
    Consumed,
    Stop,
    Invalid,
}

struct Base64Decoder {
    chunk: u32,
    byte_count: u8,
    buf: Vec<u8>,
}

impl Base64Decoder {
    fn with_capacity(capacity: usize) -> Self {
        Base64Decoder {
            chunk: 0,
            byte_count: 0,
            buf: Vec::with_capacity(capacity),
        }
    }

    #[inline(always)]
    fn push(&mut self, ch: u8, stop_char: u8) -> Base64Byte {
        let val = BASE64_DECODE[ch as usize];
        if val < 0x40 {
            self.chunk = (self.chunk << 6) | val as u32;
            self.byte_count = (self.byte_count + 1) & 3;
            if self.byte_count == 0 {
                self.buf.extend_from_slice(&self.chunk.to_be_bytes()[1..]);
            }
            Base64Byte::Consumed
        } else if ch == b'=' {
            self.flush();
            Base64Byte::Consumed
        } else if matches!(ch, b' ' | b'\t' | b'\r' | b'\n') {
            Base64Byte::Consumed
        } else if ch == stop_char {
            Base64Byte::Stop
        } else {
            Base64Byte::Invalid
        }
    }

    #[inline(always)]
    fn decode_groups<'a>(&mut self, mut rest: &'a [u8]) -> &'a [u8] {
        if self.byte_count != 0 {
            return rest;
        }
        while let [a, b, c, d, tail @ ..] = rest {
            let a = BASE64_DECODE[*a as usize];
            let b = BASE64_DECODE[*b as usize];
            let c = BASE64_DECODE[*c as usize];
            let d = BASE64_DECODE[*d as usize];
            if a | b | c | d >= 0x40 {
                break;
            }
            let word = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6) | d as u32;
            self.buf.extend_from_slice(&word.to_be_bytes()[1..]);
            rest = tail;
        }
        rest
    }

    #[inline(always)]
    fn flush(&mut self) {
        match self.byte_count {
            2 => self.buf.push((self.chunk >> 4) as u8),
            3 => self
                .buf
                .extend_from_slice(&[(self.chunk >> 10) as u8, (self.chunk >> 2) as u8]),
            _ => (),
        }
        self.byte_count = 0;
    }

    fn finish(mut self) -> Vec<u8> {
        self.flush();
        self.buf
    }
}

#[cfg(feature = "base64_slice")]
#[inline(always)]
fn base64_capacity(bytes: &[u8], stop_char: u8) -> usize {
    let len = if BASE64_DECODE[stop_char as usize] == B64_INVALID
        && stop_char != b'='
        && !matches!(stop_char, b' ' | b'\t' | b'\r' | b'\n')
    {
        let window = bytes.len().min(B64_STOP_SCAN);
        memchr::memchr(stop_char, bytes.get(..window).unwrap_or(bytes)).unwrap_or(bytes.len())
    } else {
        bytes.len()
    };
    len.div_ceil(4) * 3
}

#[inline(always)]
pub fn base64_decode(bytes: &[u8]) -> Option<Vec<u8>> {
    decode_slice(bytes, u8::MAX, bytes.len().div_ceil(4) * 3).map(|(decoded, _)| decoded)
}

#[cfg(feature = "base64_slice")]
pub fn base64_decode_slice(bytes: &[u8], stop_char: u8) -> Option<(Vec<u8>, usize)> {
    decode_slice(bytes, stop_char, base64_capacity(bytes, stop_char))
}

fn decode_slice(bytes: &[u8], stop_char: u8, capacity: usize) -> Option<(Vec<u8>, usize)> {
    let mut decoder = Base64Decoder::with_capacity(capacity);
    let mut rest = bytes;
    loop {
        rest = decoder.decode_groups(rest);
        let Some((&ch, tail)) = rest.split_first() else {
            break;
        };
        rest = tail;
        match decoder.push(ch, stop_char) {
            Base64Byte::Consumed => (),
            Base64Byte::Stop => return Some((decoder.finish(), bytes.len() - rest.len())),
            Base64Byte::Invalid => return None,
        }
    }
    Some((decoder.finish(), bytes.len()))
}

pub fn base64_decode_stream<'x>(
    stream: impl Iterator<Item = &'x u8>,
    stream_len: usize,
    stop_char: u8,
) -> Option<Vec<u8>> {
    let mut decoder = Base64Decoder::with_capacity(stream_len / 4 * 3);
    for &ch in stream {
        match decoder.push(ch, stop_char) {
            Base64Byte::Consumed => (),
            Base64Byte::Stop => return Some(decoder.finish()),
            Base64Byte::Invalid => return None,
        }
    }
    Some(decoder.finish())
}

impl<'x> MessageStream<'x> {
    pub fn decode_base64_mime(&mut self, boundary: &[u8]) -> (usize, Cow<'x, [u8]>) {
        let mut chunk: u32 = 0;
        let mut byte_count: u8 = 0;

        let mut buf = Vec::with_capacity(self.remaining() / 4 * 3);
        let mut last_ch = b'\n';
        let mut before_last_ch = 0;
        let mut end_pos = self.offset();

        self.checkpoint();

        while let Some(&ch) = self.next() {
            let val = BASE64_MAP[byte_count as usize][ch as usize];

            if val < 0x01ffffff {
                byte_count = (byte_count + 1) & 3;

                if byte_count == 1 {
                    chunk = val;
                } else {
                    chunk |= val;

                    if byte_count == 0 {
                        buf.extend_from_slice(&chunk.to_le_bytes()[0..3]);
                    }
                }
            } else {
                match ch {
                    b'=' => match byte_count {
                        1 | 2 => {
                            buf.push(chunk.to_le_bytes()[0]);
                            byte_count = 0;
                        }
                        3 => {
                            buf.extend_from_slice(&chunk.to_le_bytes()[0..2]);
                            byte_count = 0;
                        }
                        0 => (),
                        _ => {
                            self.restore();
                            return (usize::MAX, b""[..].into());
                        }
                    },
                    b'\n' => {
                        end_pos = if last_ch == b'\r' {
                            self.offset() - 2
                        } else {
                            self.offset() - 1
                        }
                    }
                    b' ' | b'\t' | b'\r' => (),
                    b'-' => {
                        if last_ch == b'-' {
                            return if !boundary.is_empty() && self.try_skip(boundary) {
                                buf.shrink_to_fit();
                                (
                                    if before_last_ch == b'\n' {
                                        end_pos
                                    } else {
                                        self.offset() - boundary.len() - 2
                                    },
                                    buf.into(),
                                )
                            } else {
                                self.restore();
                                (usize::MAX, b""[..].into())
                            };
                        }
                    }
                    _ => {
                        self.restore();
                        return (usize::MAX, b""[..].into());
                    }
                }
            }

            before_last_ch = last_ch;
            last_ch = ch;
        }

        buf.shrink_to_fit();
        (
            if boundary.is_empty() {
                self.offset()
            } else {
                self.restore();
                usize::MAX
            },
            buf.into(),
        )
    }

    pub fn decode_base64_word(&mut self) -> Option<Vec<u8>> {
        let mut chunk: u32 = 0;
        let mut byte_count: u8 = 0;
        let mut buf = Vec::with_capacity(64);

        while let Some(&ch) = self.next() {
            match ch {
                b'=' => {
                    match byte_count {
                        1 | 2 => {
                            buf.push(chunk.to_le_bytes()[0]);
                            byte_count = 0;
                        }
                        3 => {
                            buf.extend_from_slice(&chunk.to_le_bytes()[0..2]);
                            byte_count = 0;
                        }
                        0 => (),
                        _ => {
                            // Invalid
                            break;
                        }
                    }
                }
                b'?' => {
                    if let Some(b'=') = self.next() {
                        return Some(buf);
                    } else {
                        break;
                    }
                }
                b'\n' => {
                    if !self.next_is_space() {
                        break;
                    }
                }
                b' ' | b'\t' | b'\r' => (),
                _ => {
                    let val = BASE64_MAP[byte_count as usize][ch as usize];

                    if val < 0x01ffffff {
                        byte_count = (byte_count + 1) & 3;

                        if byte_count == 1 {
                            chunk = val;
                        } else {
                            chunk |= val;

                            if byte_count == 0 {
                                buf.extend_from_slice(&chunk.to_le_bytes()[0..3]);
                            }
                        }
                    } else {
                        break;
                    }
                }
            }
        }

        None
    }
}

/*
 * Table adapted from Nick Galbreath's "High performance base64 encoder / decoder"
 *
 * Copyright 2005, 2006, 2007 Nick Galbreath -- nickg [at] modp [dot] com
 * All rights reserved.
 *
 * http://code.google.com/p/stringencoders/
 *
 * Released under bsd license.
 *
 */

pub static BASE64_MAP: &[&[u32]] = &[
    &[
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x000000f8, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x000000fc, 0x000000d0,
        0x000000d4, 0x000000d8, 0x000000dc, 0x000000e0, 0x000000e4, 0x000000e8, 0x000000ec,
        0x000000f0, 0x000000f4, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x00000000, 0x00000004, 0x00000008, 0x0000000c, 0x00000010,
        0x00000014, 0x00000018, 0x0000001c, 0x00000020, 0x00000024, 0x00000028, 0x0000002c,
        0x00000030, 0x00000034, 0x00000038, 0x0000003c, 0x00000040, 0x00000044, 0x00000048,
        0x0000004c, 0x00000050, 0x00000054, 0x00000058, 0x0000005c, 0x00000060, 0x00000064,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x00000068,
        0x0000006c, 0x00000070, 0x00000074, 0x00000078, 0x0000007c, 0x00000080, 0x00000084,
        0x00000088, 0x0000008c, 0x00000090, 0x00000094, 0x00000098, 0x0000009c, 0x000000a0,
        0x000000a4, 0x000000a8, 0x000000ac, 0x000000b0, 0x000000b4, 0x000000b8, 0x000000bc,
        0x000000c0, 0x000000c4, 0x000000c8, 0x000000cc, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
    ],
    &[
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x0000e003, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x0000f003, 0x00004003,
        0x00005003, 0x00006003, 0x00007003, 0x00008003, 0x00009003, 0x0000a003, 0x0000b003,
        0x0000c003, 0x0000d003, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x00000000, 0x00001000, 0x00002000, 0x00003000, 0x00004000,
        0x00005000, 0x00006000, 0x00007000, 0x00008000, 0x00009000, 0x0000a000, 0x0000b000,
        0x0000c000, 0x0000d000, 0x0000e000, 0x0000f000, 0x00000001, 0x00001001, 0x00002001,
        0x00003001, 0x00004001, 0x00005001, 0x00006001, 0x00007001, 0x00008001, 0x00009001,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x0000a001,
        0x0000b001, 0x0000c001, 0x0000d001, 0x0000e001, 0x0000f001, 0x00000002, 0x00001002,
        0x00002002, 0x00003002, 0x00004002, 0x00005002, 0x00006002, 0x00007002, 0x00008002,
        0x00009002, 0x0000a002, 0x0000b002, 0x0000c002, 0x0000d002, 0x0000e002, 0x0000f002,
        0x00000003, 0x00001003, 0x00002003, 0x00003003, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
    ],
    &[
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x00800f00, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x00c00f00, 0x00000d00,
        0x00400d00, 0x00800d00, 0x00c00d00, 0x00000e00, 0x00400e00, 0x00800e00, 0x00c00e00,
        0x00000f00, 0x00400f00, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x00000000, 0x00400000, 0x00800000, 0x00c00000, 0x00000100,
        0x00400100, 0x00800100, 0x00c00100, 0x00000200, 0x00400200, 0x00800200, 0x00c00200,
        0x00000300, 0x00400300, 0x00800300, 0x00c00300, 0x00000400, 0x00400400, 0x00800400,
        0x00c00400, 0x00000500, 0x00400500, 0x00800500, 0x00c00500, 0x00000600, 0x00400600,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x00800600,
        0x00c00600, 0x00000700, 0x00400700, 0x00800700, 0x00c00700, 0x00000800, 0x00400800,
        0x00800800, 0x00c00800, 0x00000900, 0x00400900, 0x00800900, 0x00c00900, 0x00000a00,
        0x00400a00, 0x00800a00, 0x00c00a00, 0x00000b00, 0x00400b00, 0x00800b00, 0x00c00b00,
        0x00000c00, 0x00400c00, 0x00800c00, 0x00c00c00, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
    ],
    &[
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x003e0000, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x003f0000, 0x00340000,
        0x00350000, 0x00360000, 0x00370000, 0x00380000, 0x00390000, 0x003a0000, 0x003b0000,
        0x003c0000, 0x003d0000, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x00000000, 0x00010000, 0x00020000, 0x00030000, 0x00040000,
        0x00050000, 0x00060000, 0x00070000, 0x00080000, 0x00090000, 0x000a0000, 0x000b0000,
        0x000c0000, 0x000d0000, 0x000e0000, 0x000f0000, 0x00100000, 0x00110000, 0x00120000,
        0x00130000, 0x00140000, 0x00150000, 0x00160000, 0x00170000, 0x00180000, 0x00190000,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x001a0000,
        0x001b0000, 0x001c0000, 0x001d0000, 0x001e0000, 0x001f0000, 0x00200000, 0x00210000,
        0x00220000, 0x00230000, 0x00240000, 0x00250000, 0x00260000, 0x00270000, 0x00280000,
        0x00290000, 0x002a0000, 0x002b0000, 0x002c0000, 0x002d0000, 0x002e0000, 0x002f0000,
        0x00300000, 0x00310000, 0x00320000, 0x00330000, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
        0x01ffffff, 0x01ffffff, 0x01ffffff, 0x01ffffff,
    ],
];

#[cfg(test)]
mod tests {
    use crate::parsers::MessageStream;

    #[test]
    fn decode_base64() {
        for (encoded_str, expected_result) in [
            ("VGVzdA==", "Test"),
            ("WWU=", "Ye"),
            ("QQ==", "A"),
            ("cm8=", "ro"),
            (
                "QXJlIHlvdSBhIFNoaW1hbm8gb3IgQ2FtcGFnbm9sbyBwZXJzb24/",
                "Are you a Shimano or Campagnolo person?",
            ),
            (
                "PCFET0NUWVBFIGh0bWw+CjxodG1sPgo8Ym9keT4KPC9ib2R5Pgo8L2h0bWw+Cg==",
                "<!DOCTYPE html>\n<html>\n<body>\n</body>\n</html>\n",
            ),
            (
                "PCFET0NUWVBFIGh0bWw+CjxodG1sPg\no8Ym9ke\nT4KPC 9ib2R5Pg\n o8L2h0bWw+Cg==",
                "<!DOCTYPE html>\n<html>\n<body>\n</body>\n</html>\n",
            ),
            ("w6HDqcOtw7PDug==", "áéíóú"),
            ("====", ""),
            ("w6HDq!cOtw7PDug=", ""),
            ("w6 HD qcOt", "áéí"),
            ("cmáé", ""),
            ("áé", ""),
            ("w\n6\nH\nD\nq\nc\nO\nt\nw\n7\n P\tD u g\n==", "áéíóú"),
            ("w6HDqcOtw7PDug==", "áéíóú"),
        ] {
            assert_eq!(
                super::base64_decode(encoded_str.as_bytes()).unwrap_or_default(),
                expected_result.as_bytes(),
                "Failed for {encoded_str:?}",
            );
        }
    }

    #[test]
    fn decode_base64_mime() {
        for (encoded_str, expected_result) in [
            ("VGVzdA==\r\n--boundary\n", "Test"),
            (
                "PCFET0NUWVBFIGh0bWw+CjxodG1sPg\no8Ym9ke\nT4KPC 9ib2R5Pg\n o8L2h0bWw+Cg==\r\n--boundary--\r\n",
                "<!DOCTYPE html>\n<html>\n<body>\n</body>\n</html>\n",
            ),
            ("w6HDqcOtw7PDug==\r\n--boundary \n", "áéíóú"),
            (
                "w\n6\nH\nD\nq\nc\nO\nt\nw\n7\n P\tD u g\n==\r\n--boundary\n",
                "áéíóú",
            ),
            ("w6HDqcOtw7PDug==--boundary", "áéíóú"),
            ("w6HDqcOtw7PDug==\n--boundary--", "áéíóú"),
            (
                "w\n6\nH\nD\nq\nc\nO\nt\nw\n7\n P\tD u g\n==\n--boundary",
                "áéíóú",
            ),
        ] {
            let mut s = MessageStream::new(encoded_str.as_bytes());
            let (_, result) = s.decode_base64_mime(b"boundary");

            assert_eq!(
                result,
                expected_result.as_bytes(),
                "Failed for {encoded_str:?}",
            );
        }
    }

    #[test]
    fn decode_base64_word() {
        for (encoded_str, expected_result) in [
            ("w 6 H D q c O t w 7 P D u g==  ?=", "áéíóú"),
            ("w6HDqcOtw7PDug==?=", "áéíóú"),
            ("w6HDqc\n  Otw7PDug==?=", "áéíóú"),
            ("w6HDqcOtw7PDug================?=", "áéíóú"),
            ("?=", ""),
        ] {
            let mut s = MessageStream::new(encoded_str.as_bytes());
            assert_eq!(
                s.decode_base64_word().unwrap(),
                expected_result.as_bytes(),
                "Failed for {encoded_str:?}",
            );
        }
    }
}
