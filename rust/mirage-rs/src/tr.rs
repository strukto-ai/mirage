use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

const MISSING_TRANSLATION: &str = "tr: missing translation operand";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "crate::latin1")]
    set1: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1_opt")]
    set2: Option<Vec<u8>>,
    delete: bool,
    squeeze: bool,
    complement: bool,
    truncate_set1: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config = parse_config::<Config>(config)?;
    let mut set1 = expand(&config.set1)?;
    if config.complement {
        let members = membership(&set1);
        set1 = (u8::MIN..=u8::MAX)
            .filter(|&byte| !members[usize::from(byte)])
            .collect();
    }
    let set2 = expand(config.set2.as_deref().unwrap_or_default())?;
    if !config.delete && !config.squeeze && set2.is_empty() {
        return Err(StreamError::new(MISSING_TRANSLATION));
    }
    if !set2.is_empty() && config.truncate_set1 {
        set1.truncate(set2.len());
    }
    let mut translate = std::array::from_fn(|index| index as u8);
    if !config.delete {
        if let Some(&last) = set2.last() {
            for (index, &from) in set1.iter().enumerate() {
                translate[usize::from(from)] = set2.get(index).copied().unwrap_or(last);
            }
        }
    }
    Ok(Box::new(Tr {
        translate,
        delete: if config.delete {
            membership(&set1)
        } else {
            [false; 256]
        },
        squeeze: if config.squeeze {
            membership(if set2.is_empty() { &set1 } else { &set2 })
        } else {
            [false; 256]
        },
        previous: None,
    }))
}

fn membership(bytes: &[u8]) -> [bool; 256] {
    let mut members = [false; 256];
    for &byte in bytes {
        members[usize::from(byte)] = true;
    }
    members
}

struct Tr {
    translate: [u8; 256],
    delete: [bool; 256],
    squeeze: [bool; 256],
    previous: Option<u8>,
}

impl Stream for Tr {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.reserve(input.len());
        for &byte in input {
            if self.delete[usize::from(byte)] {
                continue;
            }
            let translated = self.translate[usize::from(byte)];
            if self.previous == Some(translated) && self.squeeze[usize::from(translated)] {
                continue;
            }
            out.push(translated);
            self.previous = Some(translated);
        }
        Ok(())
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }
}

fn escapes(input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] != b'\\' || index + 1 == input.len() {
            output.push(input[index]);
            index += 1;
            continue;
        }
        index += 1;
        let escaped = input[index];
        if matches!(escaped, b'0'..=b'7') {
            let start = index;
            let mut value = 0u16;
            while index < input.len() && index - start < 3 && matches!(input[index], b'0'..=b'7') {
                value = value * 8 + u16::from(input[index] - b'0');
                index += 1;
            }
            if value > u16::from(u8::MAX) {
                value /= 8;
                index -= 1;
            }
            output.push(value as u8);
        } else {
            output.push(match escaped {
                b'a' => 7,
                b'b' => 8,
                b'f' => 12,
                b'n' => b'\n',
                b'r' => b'\r',
                b't' => b'\t',
                b'v' => 11,
                _ => escaped,
            });
            index += 1;
        }
    }
    output
}

fn expand(input: &[u8]) -> Result<Vec<u8>, StreamError> {
    let input = escapes(input);
    let mut output = Vec::new();
    let mut index = 0;
    while index < input.len() {
        if input[index..].starts_with(b"[:") {
            if let Some(end) = input[index + 2..].windows(2).position(|pair| pair == b":]") {
                let end = index + 2 + end;
                let name = &input[index + 2..end];
                output.extend(class(name)?);
                index = end + 2;
                continue;
            }
        }
        if index + 2 < input.len() && input[index + 1] == b'-' {
            output.extend(input[index]..=input[index + 2]);
            index += 3;
        } else {
            output.push(input[index]);
            index += 1;
        }
    }
    Ok(output)
}

fn class(name: &[u8]) -> Result<impl Iterator<Item = u8>, StreamError> {
    let includes: fn(u8) -> bool = match name {
        b"alnum" => |byte| byte.is_ascii_alphanumeric(),
        b"alpha" => |byte| byte.is_ascii_alphabetic(),
        b"blank" => |byte| matches!(byte, b' ' | b'\t'),
        b"cntrl" => |byte| byte.is_ascii_control(),
        b"digit" => |byte| byte.is_ascii_digit(),
        b"graph" => |byte| byte.is_ascii_graphic(),
        b"lower" => |byte| byte.is_ascii_lowercase(),
        b"print" => |byte| matches!(byte, 32..=126),
        b"punct" => |byte| byte.is_ascii_punctuation(),
        b"space" => |byte| matches!(byte, b' ' | 9..=13),
        b"upper" => |byte| byte.is_ascii_uppercase(),
        b"xdigit" => |byte| byte.is_ascii_hexdigit(),
        _ => return Err(invalid_class(name)),
    };
    Ok((0..128).filter(move |&byte| includes(byte)))
}

fn invalid_class(name: &[u8]) -> StreamError {
    let mut printable = String::new();
    for &byte in name {
        match byte {
            7 => printable.push_str("\\a"),
            8 => printable.push_str("\\b"),
            9 => printable.push_str("\\t"),
            10 => printable.push_str("\\n"),
            11 => printable.push_str("\\v"),
            12 => printable.push_str("\\f"),
            13 => printable.push_str("\\r"),
            32..=126 => printable.push(char::from(byte)),
            _ => printable.push_str(&format!("\\{byte:03o}")),
        }
    }
    let quoted = printable.replace('\\', "\\\\").replace('\'', "\\'");
    StreamError::new(format!("tr: invalid character class '{quoted}'"))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::{open, run};

    fn config(set1: &[u8], set2: Option<&[u8]>, flags: &[&str]) -> String {
        let text = |bytes: &[u8]| bytes.iter().copied().map(char::from).collect::<String>();
        json!({
            "set1": text(set1),
            "set2": set2.map(text),
            "delete": flags.contains(&"delete"),
            "squeeze": flags.contains(&"squeeze"),
            "complement": flags.contains(&"complement"),
            "truncate_set1": flags.contains(&"truncate"),
        })
        .to_string()
    }

    fn splits(config: &str, input: &[u8], expected: &[u8]) {
        for split in 0..=input.len() {
            let (output, error) = run("tr", config, &[&input[..split], &[], &input[split..]]);
            assert_eq!(error, None, "split {split}");
            assert_eq!(output, expected, "split {split}");
        }
        let mut seed = 20261018u32;
        for _ in 0..32 {
            let mut chunks: Vec<&[u8]> = Vec::new();
            let mut rest = input;
            while !rest.is_empty() {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let size = (seed as usize % 37 + 1).min(rest.len());
                chunks.push(&rest[..size]);
                rest = &rest[size..];
            }
            let (output, error) = run("tr", config, &chunks);
            assert_eq!(error, None);
            assert_eq!(output, expected);
        }
    }

    #[test]
    fn translation_pads_truncates_and_uses_last_duplicate_mapping() {
        for (set1, set2, flags, input, expected) in [
            (
                &b"abcde"[..],
                &b"xy"[..],
                &[][..],
                &b"abcde"[..],
                &b"xyyyy"[..],
            ),
            (b"abcde", b"xy", &["truncate"], b"abcde", b"xycde"),
            (b"aba", b"123", &[], b"abba", b"3223"),
            (b"a", b"XYZ", &[], b"aXa", b"XXX"),
            (b"", b"X", &[], b"abc", b"abc"),
        ] {
            splits(&config(set1, Some(set2), flags), input, expected);
        }
    }

    #[test]
    fn squeeze_uses_translated_bytes_and_survives_deleted_chunks() {
        splits(
            &config(b"ab", Some(b"xx"), &["squeeze"]),
            b"aabbaa_ccaa",
            b"x_ccx",
        );
        splits(
            &config(b"_", Some(b"ab"), &["delete", "squeeze"]),
            b"aa___aaa___bbb",
            b"ab",
        );
        splits(&config(b"a", None, &["squeeze"]), b"aaabbbaa", b"abbba");
        splits(&config(b"a", Some(b""), &["squeeze"]), b"aaa", b"a");
        splits(&config(b"a", None, &["squeeze"]), b"", b"");
        splits(
            &config(b"ab", Some(b"a"), &["delete", "squeeze", "truncate"]),
            b"aabbb",
            b"bbb",
        );
    }

    #[test]
    fn all_bytes_and_complement_preserve_malformed_utf8() {
        let bytes: Vec<u8> = (u8::MIN..=u8::MAX).collect();
        splits(&config(b"", None, &["squeeze"]), &bytes, &bytes);
        splits(
            &config(b"\\000-\\377", Some(b"X"), &[]),
            &bytes,
            &vec![b'X'; 256],
        );
        splits(&config(b"a", None, &["delete", "complement"]), &bytes, b"a");
        splits(
            &config(&[0xff, 0x80], Some(b"ab"), &["squeeze"]),
            &[0xff, 0xff, 0x80, 0x80, 0xc3, 0xa9],
            &[b'a', b'b', 0xc3, 0xa9],
        );
    }

    #[test]
    fn named_unknown_octal_and_trailing_escapes() {
        for (operand, input, expected) in [
            (&b"\\n"[..], &b"a\nb"[..], &b"ab"[..]),
            (b"\\t", b"a\tb", b"ab"),
            (b"\\r", b"a\rb", b"ab"),
            (b"\\a", b"a\x07b", b"ab"),
            (b"\\b", b"a\x08b", b"ab"),
            (b"\\f", b"a\x0cb", b"ab"),
            (b"\\v", b"a\x0bb", b"ab"),
            (b"\\\\", b"a\\b", b"ab"),
            (b"\\0", b"a\0b", b"ab"),
            (b"\\141", b"abc", b"bc"),
            (b"\\0141", b"\x0c1a", b"a"),
            (b"\\19", b"\x019a", b"a"),
            (b"\\400", b" 0a", b"a"),
            (b"\\777", b"?7a", b"a"),
            (b"\\z\\e\\8\\9", b"ze89a", b"a"),
            (b"\\x41", b"axb41", b"ab"),
            (b"\\c", b"abcd", b"abd"),
            (b"end\\", b"end\\a", b"a"),
            (b"\\101-\\103", b"ABCD", b"D"),
            (b"", b"abc", b"abc"),
        ] {
            splits(&config(operand, None, &["delete"]), input, expected);
        }
    }

    #[test]
    fn c_classes_have_ordered_ascii_members() {
        for (name, expected) in [
            (
                "alnum",
                &b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[..],
            ),
            (
                "alpha",
                &b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[..],
            ),
            ("blank", b"\t "),
            ("cntrl", &(0..32).chain([127]).collect::<Vec<_>>()),
            ("digit", b"0123456789"),
            ("graph", &(33..127).collect::<Vec<_>>()),
            ("lower", b"abcdefghijklmnopqrstuvwxyz"),
            ("print", &(32..127).collect::<Vec<_>>()),
            ("punct", b"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"),
            ("space", b"\t\n\x0b\x0c\r "),
            ("upper", b"ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
            ("xdigit", b"0123456789ABCDEFabcdef"),
        ] {
            let input: Vec<u8> = (u8::MIN..=u8::MAX).collect();
            let operand = format!("[:{name}:]");
            splits(
                &config(operand.as_bytes(), None, &["delete", "complement"]),
                &input,
                expected,
            );
            let mapping: Vec<u8> = expected
                .iter()
                .enumerate()
                .map(|(index, _)| b'A' + index as u8)
                .collect();
            let encoded: String = mapping.iter().map(|byte| format!("\\{byte:03o}")).collect();
            let (output, error) = run(
                "tr",
                &config(operand.as_bytes(), Some(encoded.as_bytes()), &[]),
                &[expected],
            );
            assert_eq!(error, None);
            assert_eq!(output, mapping);
        }
    }

    #[test]
    fn compilation_refuses_before_input_with_exact_class_spelling() {
        for (operand, expected) in [
            (&b"[:bogus:]"[..], "tr: invalid character class 'bogus'"),
            (b"[:x\xff:]", "tr: invalid character class 'x\\\\377'"),
            (b"[:x'\\n:]", "tr: invalid character class 'x\\'\\\\n'"),
        ] {
            let error = open("tr", config(operand, None, &["delete"]).as_bytes())
                .err()
                .expect("invalid class refuses");
            assert_eq!(error.message, expected);
        }
        for set2 in [None, Some(&b""[..]), Some(&b"z-a"[..])] {
            let error = open("tr", config(b"a", set2, &[]).as_bytes())
                .err()
                .expect("missing translation refuses");
            assert_eq!(error.message, super::MISSING_TRANSLATION);
        }
        let mut invalid: Value = serde_json::from_str(&config(b"a", Some(b"b"), &[])).unwrap();
        invalid["unknown"] = json!(true);
        assert!(open("tr", invalid.to_string().as_bytes()).is_err());
        invalid.as_object_mut().unwrap().remove("unknown");
        invalid["set1"] = json!("\u{100}");
        assert!(open("tr", invalid.to_string().as_bytes()).is_err());
    }
}
