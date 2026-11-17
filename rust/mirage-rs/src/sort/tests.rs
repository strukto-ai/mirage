use serde_json::{Value as Json, json};

use super::options::scan;
use crate::{Stream, drain_all, open, run};

fn config(mode: &str, keys: &str, extra: &str) -> String {
    format!(
        r#"{{"mode":"{mode}","compare":{{"keys":{keys},"field_sep":null,"reverse":false,"unique":false,"stable":false}},"zero_terminated":false{extra}}}"#
    )
}

const WHOLE: &str = r#"[{"start_field":1,"start_char":1,"start_skip":false,"end_field":null,"end_char":null,"end_skip":false,"mods":{"numeric":false,"general_numeric":false,"human":false,"version":false,"month":false,"fold":false,"reverse":false,"dictionary":false,"ignore_nonprinting":false,"random":false}}]"#;

#[test]
fn numeric_comparisons_resume_without_changing_key_order() {
    let tail = "0".repeat(1600);
    let prefix = "x".repeat(1600);
    let records = [
        format!("0007.04{tail}"),
        format!("-7.04{tail}"),
        format!("{prefix}|0.{tail}1"),
        format!("{prefix}|0.{tail}2"),
    ];
    let mut resumed = false;
    for (field, separator, reverse, unique) in [
        (1, None, false, false),
        (1, None, true, true),
        (2, Some(b'|'), false, true),
    ] {
        let mut key = serde_json::from_str::<Json>(WHOLE).unwrap()[0].clone();
        key["start_field"] = json!(field);
        key["mods"]["numeric"] = json!(true);
        let compare: super::Compare = serde_json::from_value(json!({
            "keys": [key], "field_sep": separator,
            "reverse": reverse, "stable": false, "unique": unique,
        }))
        .unwrap();
        for (a, b) in [(0, 1), (1, 0), (2, 3), (3, 2), (0, 0)] {
            let (a, b) = (records[a].as_bytes(), records[b].as_bytes());
            let mut comparison = super::Comparison::default();
            let mut calls = 0;
            let actual = loop {
                calls += 1;
                assert!(calls < 200, "comparison failed to advance");
                if let Some(order) = comparison.step(&compare, a, b, &mut 0, 1) {
                    break order;
                }
            };
            resumed |= calls > 1;
            assert_eq!(actual, compare.records(a, b));
        }
    }
    assert!(resumed);
}

#[test]
fn long_numeric_records_sort_merge_and_deduplicate_stably() {
    let digits = "7".repeat(2 * crate::PIECE + 1);
    let first = format!("{digits}.05000 z\n").into_bytes();
    let equal = format!("00{digits}.05 a\n").into_bytes();
    let smaller = format!("-{digits}.05\n").into_bytes();
    let larger = format!("{digits}.051\n").into_bytes();
    let keys = WHOLE.replace(r#""numeric":false"#, r#""numeric":true"#);
    for unique in [false, true] {
        let cfg = config("sort", &keys, r#","run_bytes":1073741824"#)
            .replace(r#""stable":false"#, r#""stable":true"#)
            .replace(r#""unique":false"#, &format!(r#""unique":{unique}"#));
        let input = [
            larger.as_slice(),
            first.as_slice(),
            equal.as_slice(),
            smaller.as_slice(),
        ]
        .concat();
        let expected = if unique {
            [smaller.as_slice(), first.as_slice(), larger.as_slice()].concat()
        } else {
            [
                smaller.as_slice(),
                first.as_slice(),
                equal.as_slice(),
                larger.as_slice(),
            ]
            .concat()
        };
        let (out, error) = run("sort", &cfg, &[&input]);
        assert!(
            error.is_none(),
            "{}",
            error.map_or(String::new(), |error| error.to_string())
        );
        assert_eq!(out, expected);

        let cfg = cfg
            .replace(r#""mode":"sort""#, r#""mode":"merge""#)
            .replace(r#""run_bytes":1073741824"#, r#""inputs":2"#);
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let inputs = [
            [smaller.as_slice(), first.as_slice()].concat(),
            [equal.as_slice(), larger.as_slice()].concat(),
        ];
        let mut positions = [0, 0];
        let mut output = Vec::new();
        loop {
            drain_all(stream.as_mut(), &mut output);
            let Some(index) = stream.wants() else { break };
            let at = positions[index];
            if at == inputs[index].len() {
                stream.end_input(index, &mut output).unwrap();
            } else {
                let stop = inputs[index].len().min(at + 16384);
                stream
                    .feed_input(index, &inputs[index][at..stop], &mut output)
                    .unwrap();
                positions[index] = stop;
            }
        }
        stream.finish(&mut output).unwrap();
        drain_all(stream.as_mut(), &mut output);
        assert_eq!(output, expected);
    }
}

#[test]
fn sorts_bytes_and_keeps_a_missing_newline() {
    let cfg = config("sort", WHOLE, r#","run_bytes":8388608"#);
    assert_eq!(run("sort", &cfg, &[b"b\na\n\xff\nc"]).0, b"a\nb\nc\n\xff\n");
}

/// Every `drain` until the stream is idle, and how many it took.
fn drain_run(stream: &mut dyn crate::Stream) -> (Vec<u8>, usize) {
    let mut out = Vec::new();
    let mut calls = 0;
    while stream.busy() {
        stream.drain(&mut out).unwrap();
        calls += 1;
    }
    (out, calls)
}

#[test]
fn a_full_run_makes_the_stream_busy() {
    let cfg = config("sort", WHOLE, r#","run_bytes":130"#);
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    stream.feed(b"c\na\n", &mut out).unwrap();
    assert!(out.is_empty() && stream.busy());
    assert!(stream.feed(b"b\n", &mut out).is_err());
    assert_eq!(drain_run(stream.as_mut()).0, b"a\nc\n");
    stream.feed(b"b\n", &mut out).unwrap();
    assert!(!stream.busy());
    stream.finish(&mut out).unwrap();
    assert_eq!(drain_run(stream.as_mut()).0, b"b\n");
    assert!(out.is_empty());
}

#[test]
fn sorts_and_writes_a_run_in_bounded_steps() {
    let cfg = config("sort", WHOLE, r#","run_bytes":1073741824"#);
    let input: Vec<u8> = (0..30000)
        .rev()
        .flat_map(|n| format!("{n:05}\n").into_bytes())
        .collect();
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    stream.feed(&input, &mut out).unwrap();
    assert!(!stream.busy());
    stream.finish(&mut out).unwrap();
    let mut pieces = 0;
    let mut calls = 0;
    while stream.busy() {
        let mut piece = Vec::new();
        stream.drain(&mut piece).unwrap();
        assert!(piece.len() < crate::constants::OUTPUT + 16);
        calls += 1;
        pieces += usize::from(!piece.is_empty());
        out.extend_from_slice(&piece);
    }
    assert_eq!(pieces, input.len().div_ceil(crate::constants::OUTPUT));
    assert!(calls > pieces);
    let want: Vec<u8> = (0..30000)
        .flat_map(|n| format!("{n:05}\n").into_bytes())
        .collect();
    assert_eq!(out, want);
}

#[test]
fn the_stepped_merge_is_stable() {
    let keys = WHOLE.replace(r#""end_field":null"#, r#""end_field":1"#);
    let cfg = config("sort", &keys, r#","run_bytes":1073741824"#)
        .replace(r#""stable":false"#, r#""stable":true"#);
    let lines: Vec<String> = (0..5000)
        .map(|n| format!("{} {n}", (n * 7919) % 13))
        .collect();
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    let mut want = lines.clone();
    want.sort_by_key(|line| line.split(' ').next().unwrap().to_owned());
    let want: String = want.iter().map(|line| format!("{line}\n")).collect();
    assert_eq!(
        String::from_utf8(run("sort", &cfg, &[text.as_bytes()]).0).unwrap(),
        want
    );
}

#[test]
fn a_full_run_waits_for_the_next_feed() {
    let cfg = config("sort", WHOLE, r#","run_bytes":130"#);
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    stream.feed(b"d\nc\nb\na\n", &mut out).unwrap();
    assert_eq!(drain_run(stream.as_mut()).0, b"c\nd\n");
    stream.feed(b"", &mut out).unwrap();
    assert_eq!(drain_run(stream.as_mut()).0, b"a\nb\n");
    stream.finish(&mut out).unwrap();
    assert!(!stream.busy() && out.is_empty());
}

#[test]
fn finish_writes_every_run_left() {
    let cfg = config("sort", WHOLE, r#","run_bytes":130"#);
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    stream.feed(b"f\ne\nd\nc\nb\na\n", &mut out).unwrap();
    assert_eq!(drain_run(stream.as_mut()).0, b"e\nf\n");
    stream.finish(&mut out).unwrap();
    assert_eq!(drain_run(stream.as_mut()).0, b"c\nd\na\nb\n");
    assert!(out.is_empty());
}

#[test]
fn counts_past_32_bits_saturate() {
    let keys = WHOLE
        .replace(r#""start_field":1"#, r#""start_field":2"#)
        .replace(r#""start_char":1"#, r#""start_char":4294967295"#)
        .replace(
            r#""end_field":null"#,
            r#""end_field":100000000000000000000"#,
        );
    let cfg = config("sort", &keys, r#","run_bytes":18446744073709551616"#)
        .replace(r#""stable":false"#, r#""stable":true"#);
    assert_eq!(run("sort", &cfg, &[b"zz b\naa a\n"]).0, b"zz b\naa a\n");
    assert!(open("base64", br#"{"mode":"encode","wrap":4294967296}"#).is_ok());
}

#[test]
fn merges_a_long_record_once() {
    let cfg = config("merge", WHOLE, r#","inputs":2"#);
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    let long = vec![b'z'; 1 << 20];
    for piece in long.chunks(16 * 1024) {
        stream.feed_input(0, piece, &mut out).unwrap();
    }
    stream.feed_input(0, b"\n", &mut out).unwrap();
    stream.end_input(0, &mut out).unwrap();
    let short: Vec<u8> = (0..20000)
        .flat_map(|n| format!("a{n:05}\n").into_bytes())
        .collect();
    stream.feed_input(1, &short, &mut out).unwrap();
    out.extend(drain_run(stream.as_mut()).0);
    stream.end_input(1, &mut out).unwrap();
    out.extend(drain_run(stream.as_mut()).0);
    stream.finish(&mut out).unwrap();
    assert_eq!(&out[..short.len()], &short[..]);
    assert_eq!(out.len(), short.len() + long.len() + 1);
}

#[test]
fn a_merge_call_does_bounded_work() {
    let keys = WHOLE.replace(r#""numeric":false"#, r#""numeric":true"#);
    let cfg = config("merge", &keys, r#","inputs":2"#);
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    let mut long = vec![b'9'; 32 * 1024];
    long.push(b'\n');
    stream.feed_input(0, &long, &mut out).unwrap();
    stream.end_input(0, &mut out).unwrap();
    let short = b"1\n".repeat(2000);
    // Each comparison may read the long number, so a call writes only
    // the few short records its work allows.
    let most = super::STEP / super::weight(&long) + 1;
    let mut calls = 1;
    stream.feed_input(1, &short, &mut out).unwrap();
    assert!(stream.busy() && out.len() <= most * 2);
    while stream.busy() {
        let mut piece = Vec::new();
        stream.drain(&mut piece).unwrap();
        assert!(piece.len() <= most * 2);
        out.extend(piece);
        calls += 1;
    }
    assert!(calls >= 2000 / most);
    stream.end_input(1, &mut out).unwrap();
    out.extend(drain_run(stream.as_mut()).0);
    stream.finish(&mut out).unwrap();
    assert_eq!(&out[..short.len()], &short[..]);
    assert_eq!(&out[short.len()..], &long[..]);
}

#[test]
fn long_records_sort_in_smaller_blocks_and_stay_stable() {
    let keys = WHOLE.replace(r#""end_field":null"#, r#""end_field":1"#);
    let cfg = config("sort", &keys, r#","run_bytes":1073741824"#)
        .replace(r#""stable":false"#, r#""stable":true"#);
    let lines: Vec<String> = (0..3000)
        .map(|n| {
            let pad = if n % 50 == 0 {
                "x".repeat(20_000)
            } else {
                String::new()
            };
            format!("{} {n}{pad}", (n * 7919) % 13)
        })
        .collect();
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    let mut want = lines.clone();
    want.sort_by_key(|line| line.split(' ').next().unwrap().to_owned());
    let want: String = want.iter().map(|line| format!("{line}\n")).collect();
    assert_eq!(
        String::from_utf8(run("sort", &cfg, &[text.as_bytes()]).0).unwrap(),
        want
    );
}

#[test]
fn a_separator_is_any_one_byte() {
    // GNU sort 9.7 in the pinned image: LC_ALL=C sort -t $'\xff' -k2,2.
    let keys = WHOLE
        .replace(r#""start_field":1"#, r#""start_field":2"#)
        .replace(r#""end_field":null"#, r#""end_field":2"#);
    let cfg = config("sort", &keys, r#","run_bytes":8388608"#)
        .replace(r#""field_sep":null"#, r#""field_sep":255"#);
    assert_eq!(
        run("sort", &cfg, &[b"a\xffz\nb\xffy\n"]).0,
        b"b\xffy\na\xffz\n"
    );
}

#[test]
fn version_reads_the_key_as_d_and_i_leave_it() {
    // GNU sort 9.7 in the pinned image, LC_ALL=C.
    let input: &[u8] = b"ab\na-b\na\x01b\n";
    for (mods, unique, want) in [
        (r#""dictionary":true"#, true, &b"ab\n"[..]),
        (r#""ignore_nonprinting":true"#, true, b"ab\na-b\n"),
        (r#""dictionary":true"#, false, b"a\x01b\na-b\nab\n"),
        (r#""ignore_nonprinting":true"#, false, b"a\x01b\nab\na-b\n"),
    ] {
        let keys = WHOLE
            .replace(r#""version":false"#, r#""version":true"#)
            .replace(&mods.replace("true", "false"), mods);
        let mut cfg = config("sort", &keys, r#","run_bytes":8388608"#);
        if unique {
            cfg = cfg.replace(r#""unique":false"#, r#""unique":true"#);
        }
        assert_eq!(
            run("sort", &cfg, &[input]).0,
            want,
            "{mods} unique={unique}"
        );
    }
}

// GNU sort 9.7's `sort -V` of these lines, measured in the pinned image.
const VERSIONS: &[&str] = &[
    "",
    ".",
    "..",
    ".1",
    ".a",
    ".f",
    ".hidden",
    "~~",
    "~",
    "0",
    "00",
    "001",
    "01",
    "1",
    "1.a",
    "1.a.b",
    "1e5",
    "1.0~rc1",
    "1.0~rc2",
    "1.0",
    "1.0a",
    "1.0-1",
    "1.0.1",
    "1.2",
    "1.5~",
    "1.5a",
    "1.5.5",
    "1.010",
    "1.10",
    "2.0.0~beta",
    "2.0.0",
    "2.0.0+git",
    "9",
    "10",
    "Ab",
    "Z",
    "a~",
    "a",
    "a.b.c",
    "a.tar",
];

#[test]
fn orders_versions_as_gnu_does() {
    let keys = WHOLE.replace(r#""version":false"#, r#""version":true"#);
    let cfg = config("sort", &keys, r#","run_bytes":8388608"#);
    let mut input: Vec<&str> = VERSIONS.to_vec();
    input.reverse();
    input.rotate_left(17);
    let text: String = input.iter().map(|line| format!("{line}\n")).collect();
    let want: String = VERSIONS.iter().map(|line| format!("{line}\n")).collect();
    assert_eq!(
        String::from_utf8(run("sort", &cfg, &[text.as_bytes()]).0).unwrap(),
        want
    );
}

#[test]
fn version_comparison_resumes_through_filtered_bytes_suffixes_and_digits() {
    use super::modifiers::Mods;
    use super::version::{VersionScan, version_cmp};

    let skipped = b"!\x01".repeat(800);
    let long = b"a".repeat(800);
    let pairs = [
        (b"".to_vec(), skipped.clone()),
        ([skipped.as_slice(), b"."].concat(), b"..".to_vec()),
        (b".a1.tar.gz".to_vec(), b"a1.tar.gz".to_vec()),
        (b"01".to_vec(), b"1.a".to_vec()),
        (b"a1..a~.gz".to_vec(), b"a1..b.tar".to_vec()),
        (b"abZ~1".to_vec(), b"abzA1".to_vec()),
        (b"ab!1".to_vec(), b"abA1".to_vec()),
        (long.clone(), long.clone()),
        (
            [b"9".repeat(800), b"1".to_vec()].concat(),
            [b"9".repeat(800), b"2".to_vec()].concat(),
        ),
        ([b"0".repeat(800), b"12".to_vec()].concat(), b"12".to_vec()),
        (
            [long.as_slice(), b"~1"].concat(),
            [long.as_slice(), b"A1"].concat(),
        ),
        (
            [long.as_slice(), b"00012.tar.gz"].concat(),
            [long.as_slice(), b"12.tar.xz"].concat(),
        ),
        (
            [long.as_slice(), b"099999b"].concat(),
            [long.as_slice(), b"100000a"].concat(),
        ),
        (
            [long.as_slice(), b"000~"].concat(),
            [long.as_slice(), b"0"].concat(),
        ),
        (
            [skipped.as_slice(), b"Ab-01\x01.tar.gz"].concat(),
            b"ab1targz".to_vec(),
        ),
    ];
    for mods in [
        Mods::default(),
        Mods {
            fold: true,
            ..Mods::default()
        },
        Mods {
            fold: true,
            dictionary: true,
            ..Mods::default()
        },
        Mods {
            ignore_nonprinting: true,
            ..Mods::default()
        },
    ] {
        for (a, b) in &pairs {
            let transform = |source: &[u8]| {
                source
                    .iter()
                    .copied()
                    .filter(|&byte| super::modifiers::kept(byte, &mods))
                    .map(|byte| {
                        if mods.fold {
                            byte.to_ascii_uppercase()
                        } else {
                            byte
                        }
                    })
                    .collect::<Vec<_>>()
            };
            let expected = version_cmp(&transform(a), &transform(b));
            for budget in [1, 7, 4096] {
                let mut scan = VersionScan::default();
                let mut calls = 0;
                let actual = loop {
                    calls += 1;
                    assert!(calls < 20000, "version comparison failed to advance");
                    let mut remaining = budget;
                    if let Some(order) = scan.step(a, b, &mods, &mut remaining) {
                        break order;
                    }
                };
                assert_eq!(actual, expected);
                if budget == 1 && a.len() + b.len() > 256 {
                    assert!(calls > 256, "source scanning must consume the allowance");
                }
            }
        }
    }
}

#[test]
fn merges_inputs_on_demand() {
    let cfg = config("merge", WHOLE, r#","inputs":2"#);
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    assert_eq!(stream.wants(), Some(0));
    stream.feed_input(0, b"a\nc", &mut out).unwrap();
    assert_eq!(stream.wants(), Some(1));
    stream.feed_input(1, b"b\n", &mut out).unwrap();
    assert_eq!(out, b"a\n");
    assert_eq!(stream.wants(), Some(0));
    stream.end_input(0, &mut out).unwrap();
    assert_eq!(out, b"a\nb\n");
    assert_eq!(stream.wants(), Some(1));
    stream.end_input(1, &mut out).unwrap();
    assert_eq!(stream.wants(), None);
    stream.finish(&mut out).unwrap();
    assert_eq!(out, b"a\nb\nc\n");
}

#[test]
fn check_names_the_first_disorder() {
    let cfg = config("check", WHOLE, "");
    let (out, err) = run("sort", &cfg, &[b"a\nc\n", b"b\nd\n"]);
    assert_eq!(out, b"b");
    assert_eq!(err.map(|e| e.message), Some("3".into()));
}

#[test]
fn quiet_check_omits_the_disordered_record() {
    let mut record = vec![b'a'; 128 * 1024];
    record.extend_from_slice(b"\xff\xf0\x9f\x98\x80");
    let input = [b"z\n".as_slice(), &record, b"\n"].concat();
    let chunks: Vec<_> = input.chunks(16384).collect();
    for quiet in [false, true] {
        let cfg = config("check", WHOLE, &format!(",\"quiet\":{quiet}"));
        let (out, error) = run("sort", &cfg, &chunks);
        let error = error.expect("disorder");
        assert_eq!(error.message, "2");
        assert_eq!(error.status, 1);
        if quiet {
            assert!(out.is_empty());
        } else {
            assert_eq!(out, record);
        }
    }
}

type Options<'a> = [(&'a str, &'a str)];

/// The engine's configuration sort's grammar reads from `options` under
/// `-z`, with `mode`'s fields laid over it.
fn engine(options: &Options, mode: Json) -> String {
    let mut typed: Vec<_> = options
        .iter()
        .map(|(name, text)| ((*name).to_owned(), text.as_bytes().to_vec()))
        .collect();
    typed.push(("zero_terminated".to_owned(), Vec::new()));
    let mut config = scan(&typed).expect("read")["config"].clone();
    for (name, value) in mode.as_object().expect("an object") {
        config[name] = value.clone();
    }
    config.to_string()
}

// Records end in NUL so one may hold a newline, which is still a blank.
fn records(list: &[&str]) -> Vec<u8> {
    list.iter()
        .flat_map(|record| [record.as_bytes(), b"\0"].concat())
        .collect()
}

fn split(output: &[u8]) -> Vec<String> {
    let text = String::from_utf8(output.to_vec()).expect("utf-8");
    let mut list: Vec<String> = text.split('\0').map(str::to_owned).collect();
    list.pop();
    list
}

fn sorted(options: &Options, list: &[&str]) -> Vec<String> {
    let config = engine(options, json!({"mode": "sort", "run_bytes": 8 << 20}));
    split(&run("sort", &config, &[&records(list)]).0)
}

fn lines(text: &str, options: &Options) -> Vec<String> {
    sorted(options, &text.split('\n').collect::<Vec<_>>())
}

fn merged(options: &Options, runs: &[&[&str]]) -> Vec<String> {
    let config = engine(options, json!({"mode": "merge", "inputs": runs.len()}));
    let mut stream = open("sort", config.as_bytes()).expect("opens");
    let mut out = Vec::new();
    for (index, list) in runs.iter().enumerate() {
        stream
            .feed_input(index, &records(list), &mut out)
            .expect("fed");
        drain_all(stream.as_mut(), &mut out);
    }
    for index in 0..runs.len() {
        stream.end_input(index, &mut out).expect("ended");
        drain_all(stream.as_mut(), &mut out);
    }
    stream.finish(&mut out).expect("finished");
    drain_all(stream.as_mut(), &mut out);
    split(&out)
}

#[test]
fn default_separator_leading_blanks_belong_to_the_following_field() {
    assert_eq!(lines("a 1\na  2", &[("key", "2,2")]), ["a  2", "a 1"]);
    let typed = [("key", "2,2"), ("ignore_leading_blanks", "")];
    assert_eq!(lines("a 1\na  2", &typed), ["a 1", "a  2"]);
}

#[test]
fn an_explicit_separator_collapses_no_blanks() {
    let typed = [("key", "3,3"), ("field_separator", ":")];
    assert_eq!(lines("x::b\ny::a", &typed), ["y::a", "x::b"]);
    let typed = [("key", "2,2"), ("field_separator", ":"), ("stable", "")];
    assert_eq!(lines("y::a\nx::b", &typed), ["y::a", "x::b"]);
}

#[test]
fn a_key_extracts_its_fields() {
    assert_eq!(lines("a 2 z\nb 2 a", &[("key", "2")]), ["b 2 a", "a 2 z"]);
    let typed = [("key", "2,2"), ("stable", "")];
    assert_eq!(lines("b 2 a\na 2 z", &typed), ["b 2 a", "a 2 z"]);
    assert_eq!(lines("a 1\nb  2", &[("key", "2,2")]), ["b  2", "a 1"]);
    assert_eq!(lines("xa\ny 5", &[("key", "1.2")]), ["y 5", "xa"]);
    assert_eq!(lines("a b c\nx 3", &[("key", "3,3")]), ["x 3", "a b c"]);
}

#[test]
fn keydefs_order_records() {
    let data = "a 2 z\nb 2 a\nc 1 m";
    assert_eq!(lines(data, &[("key", "2")]), ["c 1 m", "b 2 a", "a 2 z"]);
    assert_eq!(lines(data, &[("key", "2,2")]), ["c 1 m", "a 2 z", "b 2 a"]);
    let typed = [("key", "2,2n"), ("key", "1,1r")];
    assert_eq!(lines(data, &typed), ["c 1 m", "b 2 a", "a 2 z"]);
    let fruit = "apple 3\nbanana 1\ncherry 2\napple 10";
    assert_eq!(
        lines(fruit, &[("key", "2,2n")]),
        ["banana 1", "cherry 2", "apple 3", "apple 10"]
    );
    let ties = "z 2\nm 2\na 2";
    let typed = [("key", "2,2n"), ("reverse", "")];
    assert_eq!(lines(ties, &typed), ["z 2", "m 2", "a 2"]);
    assert_eq!(lines(ties, &[("key", "2,2n")]), ["a 2", "m 2", "z 2"]);
    let typed = [("key", "2,2n"), ("stable", "")];
    assert_eq!(lines(ties, &typed), ["z 2", "m 2", "a 2"]);
    let typed = [("key", "2b"), ("numeric_sort", "")];
    assert_eq!(
        lines("  a 30\n  b 5\n  c 200", &typed),
        ["  c 200", "  a 30", "  b 5"]
    );
    let typed = [("key", "1.2,1.3"), ("field_separator", ":")];
    assert_eq!(
        lines("apple:12\nbee:3\ncat:100", &typed),
        ["cat:100", "bee:3", "apple:12"]
    );
}

#[test]
fn the_global_options_order_records() {
    let fruit = "banana\napple\ncherry";
    assert_eq!(lines(fruit, &[]), ["apple", "banana", "cherry"]);
    assert_eq!(
        lines(fruit, &[("reverse", "")]),
        ["cherry", "banana", "apple"]
    );
    let numbers = "10\n2\n30\n1";
    assert_eq!(
        lines(numbers, &[("numeric_sort", "")]),
        ["1", "2", "10", "30"]
    );
    let typed = [("numeric_sort", ""), ("reverse", "")];
    assert_eq!(lines(numbers, &typed), ["30", "10", "2", "1"]);
    assert_eq!(
        lines("10\nabc\n2\nxyz", &[("numeric_sort", "")]),
        ["abc", "xyz", "2", "10"]
    );
    assert_eq!(
        lines("banana\napple\nbanana\napple\ncherry", &[("unique", "")]),
        ["apple", "banana", "cherry"]
    );
    assert_eq!(
        lines("Banana\napple\nCherry", &[("ignore_case", "")]),
        ["apple", "Banana", "Cherry"]
    );
    let typed = [("unique", ""), ("ignore_case", "")];
    assert_eq!(
        lines("Apple\napple\nBanana\nbanana", &typed),
        ["Apple", "Banana"]
    );
    let typed = [("key", "2"), ("numeric_sort", "")];
    assert_eq!(lines("a 10\nb 2\nc 30", &typed), ["b 2", "a 10", "c 30"]);
    let typed = [("field_separator", ":"), ("key", "2"), ("numeric_sort", "")];
    assert_eq!(lines("a:10\nb:2\nc:30", &typed), ["b:2", "a:10", "c:30"]);
    let general = [("general_numeric_sort", "")];
    assert_eq!(
        lines("inf\n5\n-3\nnan\nabc", &general),
        ["abc", "nan", "-3", "5", "inf"]
    );
    assert_eq!(
        lines("0x10\n5\n12abc\n0x\n0x1p99999", &general),
        ["0x", "5", "12abc", "0x10", "0x1p99999"]
    );
}

// -n and -h in the C locale, pinned against GNU sort 9.7.
#[test]
fn numeric_keys_read_as_gnu_does() {
    let numeric = [("numeric_sort", "")];
    assert_eq!(
        sorted(&numeric, &["\n5", "3", "\n-5", "-4"]),
        ["\n-5", "-4", "3", "\n5"]
    );
    assert_eq!(
        sorted(&[("key", "2,2n")], &["b\n1", "a\n2"]),
        ["b\n1", "a\n2"]
    );
    let human = [("human_numeric_sort", "")];
    assert_eq!(
        lines("1500\n1.5K\n2000\n1K", &human),
        ["1500", "2000", "1K", "1.5K"]
    );
    assert_eq!(lines("1m\n1M\n2\n1k", &human), ["1m", "2", "1k", "1M"]);
    assert_eq!(
        lines("-1K\n-2\n1\n-1M\n0\n-0K\n0K", &human),
        ["-1M", "-1K", "-2", "-0K", "0", "0K", "1"]
    );
    let stable = [("human_numeric_sort", ""), ("stable", "")];
    assert_eq!(
        lines("5.K\n3K\n.5K\n3\nK", &stable),
        ["K", "3", ".5K", "3K", "5.K"]
    );
    assert_eq!(
        lines("1.000000000000000002K\n1.000000000000000001K", &stable),
        ["1.000000000000000001K", "1.000000000000000002K"]
    );
}

// Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
#[test]
fn unique_stops_at_the_keys() {
    let typed = [("key", "2,2"), ("unique", "")];
    assert_eq!(lines("b 1\na 1", &typed), ["b 1"]);
    assert_eq!(lines("b 1\na 1", &[("key", "2,2")]), ["a 1", "b 1"]);
    let typed = [("ignore_case", ""), ("unique", "")];
    assert_eq!(lines("b\na\nB", &typed), ["a", "b"]);
    let typed = [("key", "2,2"), ("unique", ""), ("reverse", "")];
    assert_eq!(lines("a 1\nb 1\nc 2", &typed), ["c 2", "a 1"]);
}

#[test]
fn a_merge_takes_the_smallest_head_and_never_reorders_a_run() {
    assert_eq!(merged(&[], &[&["b", "a"]]), ["b", "a"]);
    assert_eq!(merged(&[], &[&["c", "a"], &["b"]]), ["b", "c", "a"]);
    assert_eq!(
        merged(&[], &[&["a", "d"], &["b", "e"], &["c", "f"]]),
        ["a", "b", "c", "d", "e", "f"]
    );
    let runs: &[&[&str]] = &[&["k 3"], &["k 1"], &["k 2"]];
    let typed = [("key", "1,1"), ("stable", "")];
    assert_eq!(merged(&typed, runs), ["k 3", "k 1", "k 2"]);
    assert_eq!(merged(&[("key", "1,1")], runs), ["k 1", "k 2", "k 3"]);
    assert_eq!(merged(&[], &[&[], &["b", "a"], &[]]), ["b", "a"]);
    assert!(merged(&[], &[&[], &[]]).is_empty());
}

#[test]
fn a_unique_merge_keeps_the_first_of_a_key_equal_series() {
    let unique = [("unique", "")];
    assert_eq!(merged(&unique, &[&["a", "b", "a"]]), ["a", "b", "a"]);
    assert_eq!(
        merged(&unique, &[&["a", "b"], &["a", "c"]]),
        ["a", "b", "c"]
    );
    let typed = [("key", "2,2"), ("unique", "")];
    assert_eq!(merged(&typed, &[&["x 1"], &["a 1"]]), ["x 1"]);
    let typed = [("ignore_case", ""), ("unique", "")];
    assert_eq!(merged(&typed, &[&["b"], &["B"]]), ["b"]);
}

#[test]
fn a_unique_merge_releases_a_giant_previous_record_after_small_records() {
    let keys = WHOLE.replace(r#""numeric":false"#, r#""numeric":true"#);
    let cfg =
        config("merge", &keys, r#", "inputs":1"#).replace(r#""unique":false"#, r#""unique":true"#);
    let super::Config::Merge { compare, .. } = serde_json::from_str(&cfg).unwrap() else {
        unreachable!();
    };
    let mut stream = super::Merger {
        compare,
        separator: b'\n',
        inputs: vec![super::Input::default()],
        previous: None,
        paused: false,
        selection: super::Selection::default(),
        writing: None,
        comparison: super::Comparison::default(),
    };
    let mut capacity = 0;
    for digit in ['9', '8'] {
        let record = format!(
            "-{}\n",
            digit.to_string().repeat(crate::constants::KEPT * 8)
        );
        let mut out = Vec::new();
        for piece in record.as_bytes().chunks(crate::PIECE) {
            stream.feed(piece, &mut out).unwrap();
            drain_all(&mut stream, &mut out);
        }
        assert_eq!(out, record.as_bytes());
        let current = stream.previous.as_ref().unwrap().capacity();
        assert!(current >= record.len() - 1);
        if capacity != 0 {
            assert_eq!(current, capacity);
        }
        capacity = current;
    }
    let mut out = Vec::new();
    stream.feed(b"1\n1\n2\n", &mut out).unwrap();
    drain_all(&mut stream, &mut out);
    assert_eq!(out, b"1\n2\n");
    let previous = stream.previous.as_ref().unwrap();
    assert_eq!(previous, b"2");
    assert!(previous.capacity() <= crate::constants::KEPT * 4);
    capacity = previous.capacity();
    out.clear();
    stream.feed(b"3\n", &mut out).unwrap();
    drain_all(&mut stream, &mut out);
    assert_eq!(out, b"3\n");
    assert_eq!(stream.previous.as_ref().unwrap().capacity(), capacity);
}

/// What `-R` makes of `list` when the host draws `drawn`, with the other
/// `options`.
fn shuffled(options: &Options, drawn: &[u8], list: &[&str]) -> Vec<String> {
    let mut typed = options.to_vec();
    typed.push(("random_sort", ""));
    let mut config: Json = serde_json::from_str(&engine(
        &typed,
        json!({"mode": "sort", "run_bytes": 8 << 20}),
    ))
    .expect("json");
    config["compare"]["salt"] = json!(drawn);
    split(&run("sort", &config.to_string(), &[&records(list)]).0)
}

#[test]
fn random_keeps_equal_keys_together_and_follows_its_salt() {
    let list = ["b", "a", "c", "a", "b", "d", "c", "e"];
    let first = shuffled(&[], &[1; 16], &list);
    assert_eq!(first, shuffled(&[], &[1; 16], &list));
    let mut every = first.clone();
    every.sort();
    assert_eq!(every, ["a", "a", "b", "b", "c", "c", "d", "e"]);
    let runs = first.windows(2).filter(|pair| pair[0] != pair[1]).count();
    assert_eq!(runs, 4);
    let salts: std::collections::BTreeSet<_> = (0..8u8)
        .map(|byte| shuffled(&[], &[byte; 16], &list))
        .collect();
    assert!(salts.len() > 1);
}

#[test]
fn random_hashes_a_key_after_folding_and_breaks_a_tie_on_the_record() {
    let folded = shuffled(&[("ignore_case", "")], &[7; 16], &["B", "a", "b", "A"]);
    let at = |name: &str| folded.iter().position(|record| record == name).unwrap();
    assert_eq!(at("a"), at("A") + 1);
    assert_eq!(at("b"), at("B") + 1);
    let keyed = shuffled(&[("key", "2,2")], &[7; 16], &["x 2", "y 1", "z 2"]);
    let at = |name: &str| keyed.iter().position(|record| record == name).unwrap();
    assert_eq!(at("z 2"), at("x 2") + 1);
}

#[test]
fn a_second_random_source_must_be_the_same_word() {
    let typed = |words: &[&str]| -> Vec<(String, Vec<u8>)> {
        words
            .iter()
            .map(|word| ("random_source".to_owned(), word.as_bytes().to_vec()))
            .collect()
    };
    assert!(scan(&typed(&["a", "a"])).is_ok());
    let refused = scan(&typed(&["a", "b"])).expect_err("refused");
    assert_eq!(refused.status, 2);
    assert_eq!(
        String::from_utf8_lossy(&refused.stderr()),
        "sort: multiple random sources specified"
    );
    assert_eq!(scan(&[]).expect("read")["random"], json!(false));
    let random = [("random_sort".to_owned(), Vec::new())];
    assert_eq!(scan(&random).expect("read")["random"], json!(true));
}

#[test]
fn output_pieces_split_inside_long_records() {
    for zero in [false, true] {
        for unique in [false, true] {
            for mode in ["sort", "merge"] {
                let extra = if mode == "sort" {
                    r#", "run_bytes":8388608"#
                } else {
                    r#", "inputs":1"#
                };
                let cfg = config(mode, WHOLE, extra)
                    .replace(
                        r#""zero_terminated":false"#,
                        &format!(r#""zero_terminated":{zero}"#),
                    )
                    .replace(r#""unique":false"#, &format!(r#""unique":{unique}"#));
                let mut stream = open("sort", cfg.as_bytes()).unwrap();
                let separator = if zero { 0 } else { b'\n' };
                let mut input = vec![b'x'; 3 * crate::constants::OUTPUT];
                input.push(separator);
                let expected = input.clone();
                if unique {
                    input.extend_from_slice(&expected);
                }
                let mut output = Vec::new();
                for chunk in input.chunks(16384) {
                    let mut piece = Vec::new();
                    stream.feed(chunk, &mut piece).unwrap();
                    assert!(piece.len() <= crate::constants::OUTPUT);
                    output.extend(piece);
                    while stream.busy() {
                        let mut piece = Vec::new();
                        stream.drain(&mut piece).unwrap();
                        assert!(piece.len() <= crate::constants::OUTPUT);
                        output.extend(piece);
                    }
                }
                let mut piece = Vec::new();
                stream.finish(&mut piece).unwrap();
                assert!(piece.len() <= crate::constants::OUTPUT);
                output.extend(piece);
                while stream.busy() {
                    let mut piece = Vec::new();
                    stream.drain(&mut piece).unwrap();
                    assert!(piece.len() <= crate::constants::OUTPUT);
                    output.extend(piece);
                }
                assert_eq!(output, expected, "{mode} unique={unique} zero={zero}");
            }
        }
    }
}

#[test]
fn an_open_record_counts_toward_the_run_target() {
    let cfg = config("sort", WHOLE, r#", "run_bytes":1024"#);
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    stream.feed(b"z\na\n", &mut out).unwrap();
    stream.feed(&vec![b'x'; 1024], &mut out).unwrap();
    assert!(stream.busy());
    assert_eq!(drain_run(stream.as_mut()).0, b"a\nz\n");
    stream.finish(&mut out).unwrap();
    let mut expected = vec![b'x'; 1024];
    expected.push(b'\n');
    assert_eq!(drain_run(stream.as_mut()).0, expected);
}

#[test]
fn whole_record_comparison_resumes_without_restarting_the_prefix() {
    let compare: super::Compare = serde_json::from_value(json!({
        "keys": serde_json::from_str::<Json>(WHOLE).unwrap(),
        "field_sep": null, "reverse": false, "unique": false, "stable": false,
    }))
    .unwrap();
    let mut a = vec![b'x'; 2 * super::COST_BYTES];
    let mut b = a.clone();
    a.push(b'a');
    b.push(b'b');
    let mut comparison = super::Comparison::default();
    for _ in 0..2 {
        assert_eq!(comparison.step(&compare, &a, &b, &mut 0, 1), None);
    }
    assert_eq!(
        comparison.step(&compare, &a, &b, &mut 0, 1),
        Some(std::cmp::Ordering::Less)
    );
    assert_eq!(
        comparison.step(&compare, b"z", b"a", &mut 0, 1),
        Some(std::cmp::Ordering::Greater)
    );
}

#[test]
fn lexical_comparison_preserves_byte_order_at_word_and_tail_boundaries() {
    let compare: super::Compare = serde_json::from_value(json!({
        "keys": serde_json::from_str::<Json>(WHOLE).unwrap(),
        "field_sep": null, "reverse": false, "unique": false, "stable": false,
    }))
    .unwrap();
    for len in 0..40 {
        let a: Vec<u8> = (0..len).map(|i| (i * 37) as u8).collect();
        for at in 0..=len {
            let mut b = a.clone();
            if at == len {
                b.push(128);
            } else {
                b[at] ^= 128;
            }
            for (a, b) in [(&a, &b), (&b, &a), (&a, &a)] {
                assert_eq!(
                    super::Comparison::default().step(&compare, a, b, &mut 0, 1),
                    Some(a.cmp(b)),
                    "length {len}, differing byte {at}",
                );
            }
        }
    }
}

#[test]
fn checker_yields_between_records_and_keeps_disorder_output() {
    let cfg = config("check", WHOLE, "");
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut out = Vec::new();
    stream.feed(&b"x\n".repeat(10000), &mut out).unwrap();
    assert!(stream.busy());
    assert!(stream.feed(b"z", &mut out).is_err());
    assert!(drain_run(stream.as_mut()).0.is_empty());
    let error = stream.feed(b"a\n", &mut out).unwrap_err();
    assert_eq!(error.message, "10001");
    assert_eq!(out, b"a");
}

#[test]
fn sort_and_merge_accept_records_larger_than_the_checker_buffer_limit() {
    for mode in ["sort", "merge"] {
        let extra = if mode == "sort" {
            r#", "run_bytes":8388608"#
        } else {
            r#", "inputs":1"#
        };
        let cfg = config(mode, WHOLE, extra);
        let mut stream = open("sort", cfg.as_bytes()).unwrap();
        let mut expected = vec![b'x'; crate::constants::MAX_HELD + 1];
        let mut out = Vec::new();
        for chunk in expected.chunks(16384) {
            stream.feed(chunk, &mut out).unwrap();
            out.extend(drain_run(stream.as_mut()).0);
        }
        stream.finish(&mut out).unwrap();
        out.extend(drain_run(stream.as_mut()).0);
        expected.push(b'\n');
        assert_eq!(out, expected);
    }
}

#[test]
fn unique_output_stays_bounded_across_a_host_drain_batch() {
    let cfg = config("sort", WHOLE, r#", "run_bytes":8388608"#)
        .replace(r#""unique":false"#, r#""unique":true"#);
    let mut stream = open("sort", cfg.as_bytes()).unwrap();
    let mut input = b"a\n".to_vec();
    let mut long = vec![b'b'; crate::constants::OUTPUT * 4];
    long.push(b'\n');
    for _ in 0..8 {
        input.extend_from_slice(&long);
    }
    input.push(b'z');
    let mut piece = Vec::new();
    stream.feed(&input, &mut piece).unwrap();
    stream.finish(&mut piece).unwrap();
    let mut output = Vec::new();
    while stream.busy() {
        piece.clear();
        crate::drain_steps(stream.as_mut(), &mut piece).unwrap();
        assert!(piece.len() <= crate::constants::OUTPUT);
        output.extend_from_slice(&piece);
    }
    assert_eq!(output, [b"a\n".as_slice(), &long, b"z\n"].concat());
}
