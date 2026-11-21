/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::char::{REPLACEMENT_CHARACTER, decode_utf16};

use crate::decoders::base64::BASE64_MAP;

struct Utf7DecoderState {
    utf16_bytes: Vec<u16>,
    pending_byte: Option<u8>,
    b64_bytes: u32,
}

fn add_utf16_bytes(state: &mut Utf7DecoderState, n_bytes: usize) {
    debug_assert!(n_bytes < std::mem::size_of::<u32>());

    for byte in state.b64_bytes.to_le_bytes()[0..n_bytes].iter() {
        if let Some(pending_byte) = state.pending_byte {
            state
                .utf16_bytes
                .push(u16::from_be_bytes([pending_byte, *byte]));
            state.pending_byte = None;
        } else {
            state.pending_byte = Some(*byte);
        }
    }
}

pub(crate) fn decoder_utf7(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len());
    let mut byte_count: u8 = 0;
    let mut in_b64 = false;

    let mut state = Utf7DecoderState {
        utf16_bytes: Vec::with_capacity(10),
        pending_byte: None,
        b64_bytes: 0,
    };

    for byte in bytes {
        if in_b64 {
            let val = BASE64_MAP[byte_count as usize][*byte as usize];

            if val < 0x01ffffff {
                byte_count = (byte_count + 1) & 3;

                if byte_count == 1 {
                    state.b64_bytes = val;
                } else {
                    state.b64_bytes |= val;

                    if byte_count == 0 {
                        add_utf16_bytes(&mut state, 3);
                    }
                }
            } else {
                match byte_count {
                    1 | 2 => {
                        add_utf16_bytes(&mut state, 1);
                    }
                    3 => {
                        add_utf16_bytes(&mut state, 2);
                    }
                    _ => (),
                }

                if !state.utf16_bytes.is_empty() {
                    result.push_str(
                        decode_utf16(state.utf16_bytes.drain(..))
                            .map(|r| r.unwrap_or(REPLACEMENT_CHARACTER))
                            .collect::<String>()
                            .as_str(),
                    );
                } else if byte_count > 0 || state.pending_byte.is_some() {
                    result.push(REPLACEMENT_CHARACTER);
                } else {
                    result.push('+');
                    result.push(char::from(*byte));
                }

                state.pending_byte = None;
                byte_count = 0;
                in_b64 = false;
            }
        } else if byte == &b'+' {
            in_b64 = true;
        } else {
            result.push(char::from(*byte));
        }
    }

    result.shrink_to_fit();
    result
}

fn decoder_utf16_(bytes: &[u8], fnc: fn([u8; 2]) -> u16) -> String {
    if bytes.len() >= 2 {
        decode_utf16(bytes.as_chunks::<2>().0.iter().map(|c| fnc(*c)))
            .map(|r| r.unwrap_or(REPLACEMENT_CHARACTER))
            .collect::<String>()
    } else {
        "".to_string()
    }
}

#[inline(always)]
pub(crate) fn decoder_utf16_le(bytes: &[u8]) -> String {
    decoder_utf16_(bytes, u16::from_le_bytes)
}

#[inline(always)]
pub(crate) fn decoder_utf16_be(bytes: &[u8]) -> String {
    decoder_utf16_(bytes, u16::from_be_bytes)
}

#[allow(clippy::type_complexity)]
pub(crate) fn decoder_utf16(bytes: &[u8]) -> String {
    // Read BOM
    let (bytes, fnc): (&[u8], fn([u8; 2]) -> u16) = match bytes.get(0..2) {
        Some([0xfe, 0xff]) => (bytes.get(2..).unwrap_or(&[]), u16::from_be_bytes),
        Some([0xff, 0xfe]) => (bytes.get(2..).unwrap_or(&[]), u16::from_le_bytes),
        _ => (bytes, u16::from_le_bytes),
    };

    decoder_utf16_(bytes, fnc)
}

#[cfg(test)]
mod tests {
    use crate::decoders::charsets::utf::decoder_utf7;

    #[test]
    fn decode_utf7() {
        let inputs = [
            ("Hello, World+ACE-", "Hello, World!"),
            ("Hi Mom -+Jjo--!", "Hi Mom -☺-!"),
            ("+ZeVnLIqe-", "日本語"),
            ("Item 3 is +AKM-1.", "Item 3 is £1."),
            ("Plus minus +- -+ +--", "Plus minus +- -+ +--"),
            (
                "+APw-ber ihre mi+AN8-liche Lage+ADs- +ACI-wir",
                "über ihre mißliche Lage; \"wir",
            ),
            (
                concat!(
                    "+ACI-The sayings of Confucius,+ACI- James R. Ware, trans.  +U/BTFw-:\n",
                    "+ZYeB9FH6ckh5Pg-, 1980.\n",
                    "+Vttm+E6UfZM-, +W4tRQ066bOg-, +UxdOrA-:  +Ti1XC2b4Xpc-, 1990."
                ),
                concat!(
                    "\"The sayings of Confucius,\" James R. Ware, trans.  台北:\n",
                    "文致出版社, 1980.\n",
                    "四書五經, 宋元人注, 北京:  中國書店, 1990."
                ),
            ),
        ];

        for input in inputs {
            assert_eq!(decoder_utf7(input.0.as_bytes()), input.1);
        }
    }
}
