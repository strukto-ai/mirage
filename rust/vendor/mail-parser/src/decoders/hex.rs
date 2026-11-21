/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use super::quoted_printable::HEX_MAP;

#[derive(PartialEq, Debug)]
enum HexState {
    None,
    Percent,
    Hex1,
}

pub fn decode_hex(src: &[u8]) -> (bool, Vec<u8>) {
    let mut state = HexState::None;
    let mut hex1 = 0;
    let mut result = Vec::with_capacity(src.len());
    let mut success = true;

    for ch in src {
        match ch {
            b'%' => {
                if let HexState::None = state {
                    state = HexState::Percent
                } else {
                    success = false;
                    break;
                }
            }
            _ => match state {
                HexState::None => {
                    result.push(*ch);
                }
                HexState::Percent => {
                    hex1 = HEX_MAP[*ch as usize];
                    if hex1 != -1 {
                        state = HexState::Hex1;
                    } else {
                        success = false;
                        break;
                    }
                }
                HexState::Hex1 => {
                    let hex2 = HEX_MAP[*ch as usize];

                    state = HexState::None;
                    if hex2 != -1 {
                        result.push(((hex1 as u8) << 4) | hex2 as u8);
                    } else {
                        success = false;
                        break;
                    }
                }
            },
        }
    }

    (success, result)
}

#[cfg(test)]
mod tests {
    use crate::decoders::hex::decode_hex;

    #[test]
    fn decode_hex_line() {
        let inputs = [
            ("this%20is%20some%20text", "this is some text"),
            ("this is some text", "this is some text"),
        ];

        for input in inputs {
            let (success, result) = decode_hex(input.0.as_bytes());

            assert!(success, "Failed for '{:?}'", input.0);

            let result_str = std::str::from_utf8(&result).unwrap();

            /*println!(
                "Decoded '{}'\n -> to ->\n'{}'\n{}",
                input.0.escape_debug(),
                result_str.escape_debug(),
                "-".repeat(50)
            );*/

            assert_eq!(
                input.1,
                result_str,
                "Failed for '{}'",
                input.0.escape_debug()
            );
        }
    }
}
