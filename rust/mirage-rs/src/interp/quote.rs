//! A value quoted the way bash prints it back as input: `${v@Q}`'s single
//! quotes, and `declare -p`'s double quotes, each turning to `$'...'` for a
//! value holding a character the terminal would not show.

use std::cmp::Ordering;

use crate::generated::unicode_classes::PRINT;

/// The escapes bash's `$'...'` form names, beside three-digit octal.
fn named_escape(byte: u8) -> Option<&'static [u8]> {
    Some(match byte {
        0x07 => b"\\a",
        0x08 => b"\\b",
        b'\t' => b"\\t",
        b'\n' => b"\\n",
        0x0B => b"\\v",
        0x0C => b"\\f",
        b'\r' => b"\\r",
        0x1B => b"\\E",
        _ => return None,
    })
}

fn control(byte: u8) -> bool {
    byte < 0x20 || byte == 0x7F
}

/// Whether a UTF-8 locale prints `c`: `[[:print:]]`, which leaves out the
/// controls, the line and paragraph separators and unassigned code points.
pub(crate) fn prints(c: char) -> bool {
    let c = u32::from(c);
    PRINT
        .binary_search_by(|&(low, high)| {
            if high < c {
                Ordering::Less
            } else if low > c {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        })
        .is_ok()
}

/// Whether a value shows as it is: no control character, and under the
/// C locale no byte past ASCII; under UTF-8 only characters it prints.
pub(crate) fn printable(value: &[u8], utf8: bool) -> bool {
    if value.iter().any(|&b| control(b)) {
        return false;
    }
    if utf8 {
        std::str::from_utf8(value).is_ok_and(|text| text.chars().all(prints))
    } else {
        value.is_ascii()
    }
}

/// `$'...'`: each control byte, and each byte that is no shown character,
/// as its escape, and `'` and `\` escaped so the value reads back whole.
pub(crate) fn ansi_c(value: &[u8], utf8: bool) -> Vec<u8> {
    let mut out = b"$'".to_vec();
    let shown: Vec<bool> = if utf8 {
        let mut shown = vec![false; value.len()];
        let mut at = 0;
        for chunk in value.utf8_chunks() {
            for (offset, c) in chunk.valid().char_indices().filter(|&(_, c)| prints(c)) {
                shown[at + offset..at + offset + c.len_utf8()].fill(true);
            }
            at += chunk.valid().len() + chunk.invalid().len();
        }
        shown
    } else {
        value.iter().map(u8::is_ascii).collect()
    };
    for (&byte, shown) in value.iter().zip(shown) {
        if let Some(escape) = named_escape(byte) {
            out.extend_from_slice(escape);
        } else if control(byte) || !shown {
            out.extend_from_slice(format!("\\{byte:03o}").as_bytes());
        } else if matches!(byte, b'\'' | b'\\') {
            out.extend_from_slice(&[b'\\', byte]);
        } else {
            out.push(byte);
        }
    }
    out.push(b'\'');
    out
}

/// A name as a diagnostic names it (`cd`, `command not found`): as it is
/// when it shows as it is, else `$'...'`.
pub fn shown(value: &[u8], utf8: bool) -> Vec<u8> {
    if printable(value, utf8) {
        value.to_vec()
    } else {
        ansi_c(value, utf8)
    }
}

/// `${v@Q}`: single quotes, `'` as `'\''`, or `$'...'` for a value that
/// does not show as it is.
pub fn single(value: &[u8], utf8: bool) -> Vec<u8> {
    if !printable(value, utf8) {
        return ansi_c(value, utf8);
    }
    let mut out = vec![b'\''];
    for &byte in value {
        if byte == b'\'' {
            out.extend_from_slice(b"'\\''");
        } else {
            out.push(byte);
        }
    }
    out.push(b'\'');
    out
}

/// `declare -p`'s quoting: `$'...'` for a value holding a control
/// character, otherwise double quotes with `\`, `"`, `$` and backtick
/// escaped. Text past ASCII stays as it is.
pub fn declare(value: &[u8]) -> Vec<u8> {
    if value.iter().any(|&b| control(b)) {
        return ansi_c(value, true);
    }
    let mut out = vec![b'"'];
    for &byte in value {
        if matches!(byte, b'\\' | b'"' | b'$' | b'`') {
            out.push(b'\\');
        }
        out.push(byte);
    }
    out.push(b'"');
    out
}

/// One associative key as `declare -p` spells it: bare when every byte is
/// one bash leaves unquoted (alphanumerics and `_ % + , - . / : = @ ~`),
/// quoted like a value otherwise; `@` and `*` alone quote, since bare they
/// would read back as a splat.
pub fn key(key: &[u8]) -> Vec<u8> {
    let bare = !key.is_empty()
        && key != b"@"
        && key != b"*"
        && key
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"_%+,-./:=@~".contains(b));
    if bare { key.to_vec() } else { declare(key) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_quotes_as_bash_prints_them() {
        assert_eq!(single(b"it's", false), b"'it'\\''s'");
        assert_eq!(single(b"", false), b"''");
        assert_eq!(single(b"a\tb\x01", false), b"$'a\\tb\\001'");
        assert_eq!(single("é".as_bytes(), false), b"$'\\303\\251'");
        assert_eq!(single("é".as_bytes(), true), "'é'".as_bytes());
        assert_eq!(
            single("é\u{2028}a".as_bytes(), true),
            "$'é\\342\\200\\250a'".as_bytes()
        );
        assert_eq!(
            single("\u{85}\u{378}".as_bytes(), true),
            b"$'\\302\\205\\315\\270'"
        );
        assert_eq!(
            single("\u{200b}'x".as_bytes(), true),
            "'\u{200b}'\\''x'".as_bytes()
        );
    }

    #[test]
    fn declare_quotes_as_bash_prints_them() {
        assert_eq!(declare(b"b c"), b"\"b c\"");
        assert_eq!(declare(b"$x\"`"), b"\"\\$x\\\"\\`\"");
        assert_eq!(declare(b"a\nb"), b"$'a\\nb'");
        assert_eq!(declare(b"\x01'y\\z"), b"$'\\001\\'y\\\\z'");
        assert_eq!(key(b"k.1"), b"k.1");
        assert_eq!(key(b"a b"), b"\"a b\"");
        assert_eq!(key(b"@"), b"\"@\"");
    }
}
