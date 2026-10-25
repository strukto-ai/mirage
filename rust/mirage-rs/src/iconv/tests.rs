use sha2::{Digest, Sha256};

use super::table::{self, Multibyte, Spec, walk};
use super::{Tables, lookup, open, tables};
use crate::drain_all;

/// One run over `inputs`, each fed in the chunks given: its output,
/// stderr, status and refusal.
fn convert(
    from: &str,
    to: &str,
    omit: bool,
    inputs: &[&[&[u8]]],
) -> (Vec<u8>, String, i32, Option<String>) {
    let config = serde_json::json!({"from": from, "to": to, "omit": omit, "inputs": inputs.len()});
    let mut stream = open(config.to_string().as_bytes()).expect("opens");
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut refusal = None;
    'run: for (index, chunks) in inputs.iter().enumerate() {
        for chunk in chunks.iter() {
            if let Err(e) = stream.feed_input(index, chunk, &mut out) {
                refusal = Some(e.message);
                break 'run;
            }
            drain_all(stream.as_mut(), &mut out);
        }
        if let Err(e) = stream.end_input(index, &mut out) {
            refusal = Some(e.message);
            break;
        }
        while stream.busy() {
            if let Err(e) = stream.drain(&mut out) {
                refusal = Some(e.message);
                break 'run;
            }
        }
    }
    stream.take_stderr(&mut err);
    (
        out,
        String::from_utf8(err).unwrap(),
        stream.status(),
        refusal,
    )
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn multibyte(spec: &Spec, name: &str) -> &'static Multibyte {
    let Tables::Multi(table) = tables(lookup(name.as_bytes()).unwrap()) else {
        panic!("{name} has no multi-byte table");
    };
    assert_eq!(table.grammar, spec.grammar);
    table
}

/// Each table's size and digest, both directions, checked against glibc
/// 2.41 on debian:stable-slim when the hosts converted with them.
#[test]
fn the_multibyte_tables_match_the_pinned_digests() {
    let pins: [(&Spec, &str, usize, &str, usize, &str); 6] = [
        (
            &table::GBK,
            "GBK",
            21791,
            "bba66856a1a44bdc",
            21920,
            "4013fbd0c747f579",
        ),
        (
            &table::EUC_CN,
            "EUC-CN",
            7445,
            "e73a16723240a945",
            7573,
            "acabc939aa1cb893",
        ),
        (
            &table::GB18030,
            "GB18030",
            63360,
            "995fabe77efceaa4",
            63488,
            "56a3c65aa0c1b946",
        ),
        (
            &table::EUC_KR,
            "EUC-KR",
            8227,
            "f1f8fe46cc836ea0",
            8388,
            "96d8b6b82ea1a6de",
        ),
        (
            &table::SJIS,
            "SJIS",
            6879,
            "9e31ef626b7726f0",
            7075,
            "152ab23536e0befb",
        ),
        (
            &table::EUC_JP,
            "EUC-JP",
            13009,
            "0a3c10912de393e1",
            13169,
            "af425d9e826f2b95",
        ),
    ];
    for (spec, name, size, want, rsize, rwant) in pins {
        let table = multibyte(spec, name);
        let mut entries = Vec::new();
        let mut seq = Vec::new();
        for block in spec.blocks {
            walk(block, &mut seq, &mut |seq| {
                if let Some(cp) = table.get(seq) {
                    entries.push((seq.iter().fold(0u32, |key, &b| key << 8 | u32::from(b)), cp));
                }
            });
        }
        entries.sort_unstable();
        let text: String = entries
            .iter()
            .map(|(k, v)| format!("{k:x}:{v:x}\n"))
            .collect();
        assert_eq!(
            (entries.len(), digest(&text)),
            (size, want.to_owned()),
            "{name}"
        );
        let mut reverse = String::new();
        let mut count = 0;
        for cp in 0..0x10000 {
            if let Some(seq) = table.reverse.get(cp) {
                let mut bytes = Vec::new();
                table::put_sequence(seq, &mut bytes);
                let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                reverse += &format!("{cp:x}:{hex}\n");
                count += 1;
            }
        }
        assert_eq!(
            (count, digest(&reverse)),
            (rsize, rwant.to_owned()),
            "{name} reverse"
        );
    }
}

#[test]
fn positions_count_from_each_input_across_its_chunks() {
    let (out, _, _, refusal) = convert("UTF-8", "ASCII", false, &[&[b"ab", b"c\xc3", b"\xa9d"]]);
    assert_eq!(
        (out, refusal.as_deref()),
        (
            b"abc".to_vec(),
            Some("iconv: illegal input sequence at position 3")
        )
    );
    let (out, _, _, refusal) = convert("UTF-8", "ASCII", false, &[&[b"xy"], &[b"z", b"\xc3\xa9"]]);
    assert_eq!(
        (out, refusal.as_deref()),
        (
            b"xyz".to_vec(),
            Some("iconv: illegal input sequence at position 1")
        )
    );
}

#[test]
fn an_incomplete_end_is_reported_and_the_next_input_read() {
    let (out, err, status, refusal) =
        convert("UTF-8", "UTF-16LE", false, &[&[b"a\xc3"], &[b"\xa9b"]]);
    assert_eq!(out, b"a\0");
    assert_eq!(
        err,
        "iconv: incomplete character or shift sequence at end of buffer\n"
    );
    assert_eq!(
        (status, refusal.as_deref()),
        (1, Some("iconv: illegal input sequence at position 0"))
    );
    let (out, err, status, _) = convert("GBK", "UTF-8", true, &[&[b"\x81"], &[b"\xb1", b"\xb1"]]);
    assert_eq!(
        (out, err.lines().count(), status),
        ("北".as_bytes().to_vec(), 1, 1)
    );
}

#[test]
fn a_bom_sets_the_byte_order_once_for_the_run() {
    let le: &[&[u8]] = &[b"\xff", b"\xfea\0"];
    let be: &[&[u8]] = &[b"\xfe\xff\0a"];
    assert_eq!(
        convert("UTF-16", "UTF-8", false, &[le, le]).0,
        "a\u{feff}a".as_bytes()
    );
    assert_eq!(convert("UTF-16", "UTF-8", false, &[&[b"\xff"], be]).0, b"a");
    assert_eq!(
        convert(
            "UTF-32",
            "UTF-8",
            false,
            &[&[b"\0\0", b"\xfe\xff"], &[b"\0\0\0a"]]
        )
        .0,
        b"a"
    );
}

#[test]
fn a_utf16_target_writes_its_bom_once_the_first_character_reaches_it() {
    assert_eq!(
        convert("UTF-8", "UTF-16", false, &[&[b""], &[b"a"], &[b"b"]]).0,
        b"\xff\xfea\0b\0"
    );
    let (out, _, status, _) = convert("UCS-4", "UTF-16", true, &[&[b"\0\x11\0\0"]]);
    assert_eq!((out, status), (b"\xff\xfe".to_vec(), 1));
    assert_eq!(convert("UTF-8", "UTF-16", true, &[&[b"\x80"]]).0, b"");
}

#[test]
fn ucs4_holds_what_glibc_holds_past_unicode() {
    assert_eq!(
        convert("UCS-4", "UTF-8", false, &[&[b"\x7f\xff\xff\xff"]]).0,
        b"\xfd\xbf\xbf\xbf\xbf\xbf"
    );
    assert_eq!(
        convert(
            "UTF-8",
            "UCS-4LE",
            false,
            &[&[b"\xf8\x88\x80", b"\x80\x80"]]
        )
        .0,
        b"\0\0\x20\0"
    );
    assert_eq!(
        convert("UCS-4", "UCS-4LE", false, &[&[b"\0\0\xd8\0"]]).0,
        b"\0\xd8\0\0"
    );
    let (out, _, status, _) = convert("UCS-4", "UTF-8", true, &[&[b"\x80\0\0\0\0\0\0a"]]);
    assert_eq!((out, status), (b"a".to_vec(), 0));
}

#[test]
fn single_byte_charsets_follow_glibc_where_whatwg_differs() {
    let cases: [(&str, &[u8], &[u8]); 5] = [
        ("CP1252", b"\x80", "€".as_bytes()),
        ("ISO-8859-9", b"\x80\xd0", "\u{80}Ğ".as_bytes()),
        ("KOI8-U", b"\xae\xa4", "╝є".as_bytes()),
        ("TIS-620", b"\xa1", "ก".as_bytes()),
        ("CP874", b"\x80", "€".as_bytes()),
    ];
    for (charset, input, want) in cases {
        assert_eq!(
            convert(charset, "UTF-8", false, &[&[input]]).0,
            want,
            "{charset}"
        );
    }
    for (charset, input) in [
        ("CP1252", b"\x81"),
        ("TIS-620", b"\xa0"),
        ("CP874", b"\x81"),
    ] {
        let refusal = convert(charset, "UTF-8", false, &[&[input]]).3;
        assert_eq!(
            refusal.as_deref(),
            Some("iconv: illegal input sequence at position 0"),
            "{charset}"
        );
    }
}

#[test]
fn output_comes_a_bounded_window_at_a_time() {
    let config = r#"{"from":"UTF-8","to":"UCS-4","inputs":1}"#;
    let mut stream = open(config.as_bytes()).unwrap();
    let input = vec![b'a'; 64 * 1024];
    let mut out = Vec::new();
    stream.feed_input(0, &input, &mut out).unwrap();
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
        ("S_JIS", false),
        ("/SJIS", false),
        ("", true),
        ("ascii//TRANSLIT", false),
    ] {
        assert_eq!(lookup(name.as_bytes()).is_some(), found, "{name}");
    }
    let config = serde_json::json!({"from": "bogus", "to": "nope\u{ff}"}).to_string();
    let refusal = open(config.as_bytes()).err().unwrap().message;
    assert_eq!(
        refusal,
        "iconv: conversions from `bogus' and to `nope\u{ff}' are not supported\nTry `iconv --help' or `iconv --usage' for more information."
    );
}

#[test]
fn the_list_is_in_strverscmp_order() {
    let mut stream = open(br#"{"list":true}"#).unwrap();
    let mut out = Vec::new();
    stream.finish(&mut out).unwrap();
    let text = String::from_utf8(out).unwrap();
    let names: Vec<&str> = text.lines().collect();
    assert_eq!(names[..3], ["866//", "874//", "8859_1//"]);
    let at = |name: &str| names.iter().position(|n| *n == name).unwrap();
    assert!(at("ISO-8859-9//") < at("ISO-8859-10//") && at("UTF-8//") < at("UTF-16//"));
}
