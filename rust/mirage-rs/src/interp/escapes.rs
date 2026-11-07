//! The escapes a word's quoting names: `$'...'`'s ANSI-C table, the four
//! a double-quoted string keeps, and an unquoted word's backslashes.

use crate::utf8::{Char, char_at};

/// Decode the body of a `$'...'` word, as bash 5.2 builds it, in bytes:
/// the simple escapes, 1-3 octal digits masked to a byte, `\xHH` bytes,
/// `\u` and `\U` values UTF-8-encoded under a UTF-8 locale (surrogates
/// and values past Unicode as raw UTF-8-shaped bytes, 0x80000000 and past
/// as nothing) and in the C locale ASCII as its byte, anything else up to
/// 0x7FFFFFFF in its canonical spelling (`\u00E9`, `\U0001F600`, the short
/// form for any value under 0x10000), `\cX` control characters (`\c?`
/// is DEL, an escaped backslash one operand), and any other or incomplete
/// escape kept as typed, backslash included. A NUL ends the word segment,
/// as a C string does: `x$'a\0b'y` is `xay`.
pub fn decode_ansi_c(content: &[u8], utf8: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len());
    let mut i = 0;
    while i < content.len() {
        let byte = content[i];
        if byte != b'\\' || i + 1 == content.len() {
            out.push(byte);
            i += 1;
            continue;
        }
        let marker = content[i + 1];
        let simple = match marker {
            b'a' => Some(0x07),
            b'b' => Some(0x08),
            b'e' | b'E' => Some(0x1B),
            b'f' => Some(0x0C),
            b'n' => Some(b'\n'),
            b'r' => Some(b'\r'),
            b't' => Some(b'\t'),
            b'v' => Some(0x0B),
            b'\\' | b'\'' | b'"' | b'?' => Some(marker),
            _ => None,
        };
        if let Some(value) = simple {
            out.push(value);
            i += 2;
            continue;
        }
        match marker {
            b'0'..=b'7' => {
                let digits = digits(&content[i + 1..], 3, 8);
                let value = number(&content[i + 1..i + 1 + digits], 8) & 0xFF;
                if value == 0 {
                    return out;
                }
                out.push(value as u8);
                i += 1 + digits;
            }
            b'x' => {
                let digits = digits(&content[i + 2..], 2, 16);
                if digits == 0 {
                    out.extend_from_slice(b"\\x");
                    i += 2;
                    continue;
                }
                let value = number(&content[i + 2..i + 2 + digits], 16);
                if value == 0 {
                    return out;
                }
                out.push(value as u8);
                i += 2 + digits;
            }
            b'u' | b'U' => {
                let limit = if marker == b'u' { 4 } else { 8 };
                let digits = digits(&content[i + 2..], limit, 16);
                if digits == 0 {
                    out.extend_from_slice(&[b'\\', marker]);
                    i += 2;
                    continue;
                }
                let value = number(&content[i + 2..i + 2 + digits], 16);
                if value == 0 {
                    return out;
                }
                if utf8 {
                    utf8_shaped(value, &mut out);
                } else if value < 0x80 {
                    out.push(value as u8);
                } else if value < 0x1_0000 {
                    out.extend_from_slice(format!("\\u{value:04X}").as_bytes());
                } else if value < 0x8000_0000 {
                    out.extend_from_slice(format!("\\U{value:08X}").as_bytes());
                }
                i += 2 + digits;
            }
            b'c' => {
                if i + 2 == content.len() {
                    out.extend_from_slice(b"\\c");
                    i += 2;
                    continue;
                }
                let operand = content[i + 2];
                i += 3;
                if operand == b'\\' && content.get(i) == Some(&b'\\') {
                    i += 1;
                }
                let value = if operand == b'?' {
                    0x7F
                } else {
                    operand.to_ascii_uppercase() & 0x1F
                };
                if value == 0 {
                    return out;
                }
                out.push(value);
            }
            _ => {
                out.extend_from_slice(&[byte, marker]);
                i += 2;
            }
        }
    }
    out
}

/// How many of `text`'s leading bytes, up to `limit`, are digits of `radix`.
fn digits(text: &[u8], limit: usize, radix: u32) -> usize {
    text.iter()
        .take(limit)
        .take_while(|&&b| char::from(b).is_digit(radix))
        .count()
}

fn number(text: &[u8], radix: u32) -> u32 {
    text.iter().fold(0u32, |value, &b| {
        value
            .wrapping_mul(radix)
            .wrapping_add(char::from(b).to_digit(radix).unwrap_or(0))
    })
}

/// bash's UTF-8 encoding of an escape's value: UTF-8-shaped bytes for any
/// value under 2^31, the old four- to six-byte forms past Unicode.
fn utf8_shaped(value: u32, out: &mut Vec<u8>) {
    let cont = |shift: u32| 0x80 | ((value >> shift) & 0x3F) as u8;
    match value {
        0..=0x7F => out.push(value as u8),
        0x80..=0x7FF => out.extend_from_slice(&[0xC0 | (value >> 6) as u8, cont(0)]),
        0x800..=0xFFFF => out.extend_from_slice(&[0xE0 | (value >> 12) as u8, cont(6), cont(0)]),
        0x1_0000..=0x1F_FFFF => {
            out.extend_from_slice(&[0xF0 | (value >> 18) as u8, cont(12), cont(6), cont(0)])
        }
        0x20_0000..=0x3FF_FFFF => out.extend_from_slice(&[
            0xF8 | (value >> 24) as u8,
            cont(18),
            cont(12),
            cont(6),
            cont(0),
        ]),
        0x400_0000..=0x7FFF_FFFF => out.extend_from_slice(&[
            0xFC | (value >> 30) as u8,
            cont(24),
            cont(18),
            cont(12),
            cont(6),
            cont(0),
        ]),
        _ => {}
    }
}

/// The text a double-quoted segment's escapes name: bash keeps `\$`,
/// `` \` ``, `\"`, `\\` and `\<newline>` inside double quotes, and every
/// other backslash stands as typed.
pub fn unescape_dquoted(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i] == b'\\' && i + 1 < text.len() {
            match text[i + 1] {
                b'$' | b'`' | b'"' | b'\\' => {
                    out.push(text[i + 1]);
                    i += 2;
                    continue;
                }
                b'\n' => {
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        out.push(text[i]);
        i += 1;
    }
    out
}

/// An unquoted word's text as runs, each live or quoted: a backslash
/// quotes the character after it, which stands for itself (`\*` matches
/// only a star, `\~` is no tilde, `\é` keeps its bytes together), and a
/// backslash ending the word stands as typed.
pub fn unquoted_runs(text: &[u8]) -> Vec<(Vec<u8>, bool)> {
    let mut runs: Vec<(Vec<u8>, bool)> = Vec::new();
    let mut push = |byte: u8, quoted: bool| match runs.last_mut() {
        Some((run, q)) if *q == quoted => run.push(byte),
        _ => runs.push((vec![byte], quoted)),
    };
    let mut i = 0;
    while i < text.len() {
        if text[i] == b'\\' && i + 1 < text.len() {
            let width = match char_at(&text[i + 1..]) {
                Char::Whole(width, _) => width,
                _ => 1,
            };
            for &byte in &text[i + 1..i + 1 + width] {
                push(byte, true);
            }
            i += 1 + width;
        } else {
            push(text[i], false);
            i += 1;
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_c_names_bytes() {
        assert_eq!(decode_ansi_c(br"a\tb\x41\101\e", true), b"a\tbAA\x1b");
        assert_eq!(decode_ansi_c(br"x\0y", true), b"x");
        assert_eq!(
            decode_ansi_c(b"\\u00e9\\uD800", true),
            b"\xc3\xa9\xed\xa0\x80"
        );
        assert_eq!(
            decode_ansi_c(br"\U00110000\UFFFFFFFF!", true),
            b"\xf4\x90\x80\x80!"
        );
        assert_eq!(decode_ansi_c(br"\ca\c?\q\x", true), b"\x01\x7f\\q\\x");
        assert_eq!(decode_ansi_c(br"\400z", true), b"");
    }

    #[test]
    fn the_c_locale_keeps_what_it_cannot_spell() {
        assert_eq!(
            decode_ansi_c(
                br"\u00e9|\u41|\u7f|\u80|\U1F600|\U0000DFFF|\U80000000|\uZ",
                false
            ),
            b"\\u00E9|A|\x7f|\\u0080|\\U0001F600|\\uDFFF||\\uZ"
        );
    }

    #[test]
    fn double_quotes_keep_four_escapes() {
        assert_eq!(
            unescape_dquoted(b"\\$x \\\" \\\\ \\n \\\nz"),
            b"$x \" \\ \\n z"
        );
    }

    #[test]
    fn unquoted_backslashes_quote_one_character() {
        assert_eq!(
            unquoted_runs(br"a\*b*\\"),
            vec![
                (b"a".to_vec(), false),
                (b"*".to_vec(), true),
                (b"b*".to_vec(), false),
                (b"\\".to_vec(), true),
            ]
        );
        assert_eq!(unquoted_runs(b"x\\"), vec![(b"x\\".to_vec(), false)]);
        assert_eq!(
            unquoted_runs(b"a\\\xc3\xa9\\\\\\\xffb"),
            vec![
                (b"a".to_vec(), false),
                (b"\xc3\xa9\\\xff".to_vec(), true),
                (b"b".to_vec(), false),
            ]
        );
    }
}
