use sha2::{Digest, Sha256};

use super::table::{put_sequence, walk};
use super::{Charset, Codec, NAMES, charset, codec, lookup, open};
use crate::drain_all;

/// One run over `inputs`, each fed in the chunks given, as one line: its
/// output escaped, its stderr, its status and its refusal.
fn convert(from: &str, to: &str, omit: bool, inputs: &[&[&[u8]]]) -> String {
    let config = serde_json::json!({"from": from, "to": to, "omit": omit, "inputs": inputs.len()});
    let mut stream = open(config.to_string().as_bytes()).expect("opens");
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut run = || -> Result<(), crate::StreamError> {
        for (index, chunks) in inputs.iter().enumerate() {
            for chunk in chunks.iter() {
                stream.feed_input(index, chunk, &mut out)?;
                drain_all(stream.as_mut(), &mut out);
            }
            stream.end_input(index, &mut out)?;
            while stream.busy() {
                stream.drain(&mut out)?;
            }
        }
        Ok(())
    };
    let refusal = run().err().map(|e| e.message).unwrap_or_default();
    stream.take_stderr(&mut err);
    let err = String::from_utf8(err).unwrap().replace('\n', ";");
    format!("{}|{err}|{}|{refusal}", out.escape_ascii(), stream.status())
}

const ILLEGAL_0: &str = "iconv: illegal input sequence at position 0";
const INCOMPLETE: &str = "iconv: incomplete character or shift sequence at end of buffer;";

/// Each table's size and digest, both directions, checked against glibc
/// 2.41 on debian:stable-slim when the hosts converted with them.
#[test]
fn the_multibyte_tables_match_the_pinned_digests() {
    let pins = "GBK 21791 bba66856a1a44bdc 21920 4013fbd0c747f579
        EUC-CN 7445 e73a16723240a945 7573 acabc939aa1cb893
        GB18030 63360 995fabe77efceaa4 63488 56a3c65aa0c1b946
        EUC-KR 8227 f1f8fe46cc836ea0 8388 96d8b6b82ea1a6de
        SJIS 6879 9e31ef626b7726f0 7075 152ab23536e0befb
        EUC-JP 13009 0a3c10912de393e1 13169 af425d9e826f2b95";
    let digest = |lines: Vec<String>| {
        let hash: String = Sha256::digest(lines.concat())[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        format!("{} {hash}", lines.len())
    };
    for pin in pins.lines() {
        let name = pin.split_whitespace().next().unwrap();
        let (Charset::Multi(spec), (Codec::Multi(table), _)) =
            (charset(name), codec(lookup(name.as_bytes()).unwrap()))
        else {
            panic!("{name} has no multi-byte table");
        };
        let mut entries = Vec::new();
        for block in spec.blocks {
            walk(block, &mut Vec::new(), &mut |seq| {
                if let Some(cp) = table.get(seq) {
                    entries.push((seq.iter().fold(0u32, |key, &b| key << 8 | u32::from(b)), cp));
                }
            });
        }
        entries.sort_unstable();
        let reverse = (0..0x10000).filter_map(|cp| {
            let mut bytes = Vec::new();
            put_sequence(table.reverse.get(cp)?, &mut bytes);
            Some(format!(
                "{cp:x}:{}\n",
                bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
            ))
        });
        let forward = digest(
            entries
                .iter()
                .map(|(k, v)| format!("{k:x}:{v:x}\n"))
                .collect(),
        );
        let got = format!("{name} {forward} {}", digest(reverse.collect()));
        assert_eq!(got, pin.trim());
    }
}

#[test]
fn positions_count_from_each_input_across_its_chunks() {
    let position = |n| format!("iconv: illegal input sequence at position {n}");
    let chunked: &[&[u8]] = &[b"ab", b"c\xc3", b"\xa9d"];
    assert_eq!(
        convert("UTF-8", "ASCII", false, &[chunked]),
        format!("abc||0|{}", position(3))
    );
    let second: &[&[u8]] = &[b"z", b"\xc3\xa9"];
    assert_eq!(
        convert("UTF-8", "ASCII", false, &[&[b"xy"], second]),
        format!("xyz||0|{}", position(1))
    );
}

#[test]
fn an_incomplete_end_is_reported_and_the_next_input_read() {
    let run = convert("UTF-8", "UTF-16LE", false, &[&[b"a\xc3"], &[b"\xa9b"]]);
    assert_eq!(run, format!("a\\x00|{INCOMPLETE}|1|{ILLEGAL_0}"));
    let gbk: &[&[u8]] = &[b"\xb1", b"\xb1"];
    assert_eq!(
        convert("GBK", "UTF-8", true, &[&[b"\x81"], gbk]),
        format!("\\xe5\\x8c\\x97|{INCOMPLETE}|1|")
    );
}

#[test]
fn a_bom_sets_the_byte_order_once_for_the_run() {
    let (le, be): (&[&[u8]], &[&[u8]]) = (&[b"\xff", b"\xfea\0"], &[b"\xfe\xff\0a"]);
    assert_eq!(
        convert("UTF-16", "UTF-8", false, &[le, le]),
        "a\\xef\\xbb\\xbfa||0|"
    );
    assert_eq!(
        convert("UTF-16", "UTF-8", false, &[&[b"\xff"], be]),
        format!("a|{INCOMPLETE}|1|")
    );
    let utf32: &[&[u8]] = &[b"\0\0", b"\xfe\xff"];
    assert_eq!(
        convert("UTF-32", "UTF-8", false, &[utf32, &[b"\0\0\0a"]]),
        "a||0|"
    );
}

#[test]
fn a_utf16_target_writes_its_bom_once_the_first_character_reaches_it() {
    assert_eq!(
        convert("UTF-8", "UTF-16", false, &[&[b""], &[b"a"], &[b"b"]]),
        "\\xff\\xfea\\x00b\\x00||0|"
    );
    assert_eq!(
        convert("UCS-4", "UTF-16", true, &[&[b"\0\x11\0\0"]]),
        "\\xff\\xfe||1|"
    );
    assert_eq!(convert("UTF-8", "UTF-16", true, &[&[b"\x80"]]), "||1|");
}

#[test]
fn ucs4_holds_what_glibc_holds_past_unicode() {
    assert_eq!(
        convert("UCS-4", "UTF-8", false, &[&[b"\x7f\xff\xff\xff"]]),
        "\\xfd\\xbf\\xbf\\xbf\\xbf\\xbf||0|"
    );
    let five: &[&[u8]] = &[b"\xf8\x88\x80", b"\x80\x80"];
    assert_eq!(
        convert("UTF-8", "UCS-4LE", false, &[five]),
        "\\x00\\x00 \\x00||0|"
    );
    assert_eq!(
        convert("UCS-4", "UCS-4LE", false, &[&[b"\0\0\xd8\0"]]),
        "\\x00\\xd8\\x00\\x00||0|"
    );
    assert_eq!(
        convert("UCS-4", "UTF-8", true, &[&[b"\x80\0\0\0\0\0\0a"]]),
        "a||0|"
    );
    assert_eq!(
        convert("UCS-2BE", "UTF-8", true, &[&[b"\xdc\0\0a"]]),
        "a||0|"
    );
    assert_eq!(convert("UCS-2", "UTF-8", true, &[&[b"\0\xdca\0"]]), "a||1|");
}

#[test]
fn single_byte_charsets_follow_glibc_where_whatwg_differs() {
    let cases = [
        ("CP1252", &b"\x80"[..], "\\xe2\\x82\\xac||0|".to_owned()),
        (
            "ISO-8859-9",
            b"\x80\xd0",
            "\\xc2\\x80\\xc4\\x9e||0|".to_owned(),
        ),
        ("KOI8-U", b"\xae", "\\xe2\\x95\\x9d||0|".to_owned()),
        ("TIS-620", b"\xa1", "\\xe0\\xb8\\x81||0|".to_owned()),
        ("CP1252", b"\x81", format!("||0|{ILLEGAL_0}")),
        ("CP874", b"\x81", format!("||0|{ILLEGAL_0}")),
        ("TIS-620", b"\xa0", format!("||0|{ILLEGAL_0}")),
    ];
    for (charset, input, want) in cases {
        assert_eq!(
            convert(charset, "UTF-8", false, &[&[input]]),
            want,
            "{charset}"
        );
    }
}

#[test]
fn output_comes_a_bounded_window_at_a_time() {
    let mut stream = open(br#"{"from":"UTF-8","to":"UCS-4","inputs":1}"#).unwrap();
    let mut out = Vec::new();
    stream.feed_input(0, &[b'a'; 64 * 1024], &mut out).unwrap();
    assert_eq!(
        (out.len(), stream.busy(), stream.wants()),
        (64 * 1024, true, None)
    );
    while stream.busy() {
        stream.drain(&mut out).unwrap();
    }
    assert_eq!((out.len(), stream.wants()), (256 * 1024, Some(0)));
}

#[test]
fn names_read_as_glibc_reads_them() {
    for (name, found) in [
        ("utf 8", true),
        ("s(jis)//", true),
        ("SJIS/!", true),
        ("", true),
    ] {
        assert_eq!(lookup(name.as_bytes()).is_some(), found, "{name}");
    }
    for name in ["S_JIS", "/SJIS", "ascii//TRANSLIT"] {
        assert_eq!(lookup(name.as_bytes()), None, "{name}");
    }
    for line in NAMES.lines() {
        let name = line.split(' ').next().unwrap();
        assert_eq!(
            matches!(charset(name), Charset::Ascii),
            name == "ANSI_X3.4-1968",
            "{name}"
        );
    }
    let config = serde_json::json!({"from": "bogus", "to": "nope\u{ff}"}).to_string();
    let refusal = open(config.as_bytes()).err().unwrap().message;
    let want =
        "iconv: conversions from `bogus' and to `nope\u{ff}' are not supported\nTry `iconv --help'";
    assert!(refusal.starts_with(want), "{refusal}");
}

#[test]
fn the_list_is_in_strverscmp_order() {
    let mut out = Vec::new();
    open(br#"{"list":true}"#).unwrap().finish(&mut out).unwrap();
    let text = String::from_utf8(out).unwrap();
    let names: Vec<&str> = text.lines().collect();
    assert_eq!(names[..3], ["866//", "874//", "8859_1//"]);
    let at = |name: &str| names.iter().position(|n| *n == name).unwrap();
    assert!(at("ISO-8859-9//") < at("ISO-8859-10//") && at("US-ASCII//") < at("US//"));
}
