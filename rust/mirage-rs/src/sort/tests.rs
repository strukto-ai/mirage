use serde_json::{Value as Json, json};

use super::options::scan;
use crate::{drain_all, open, run};

fn config(mode: &str, keys: &str, extra: &str) -> String {
    format!(
        r#"{{"mode":"{mode}","compare":{{"keys":{keys},"field_sep":null,"reverse":false,"unique":false,"stable":false}},"zero_terminated":false{extra}}}"#
    )
}

const WHOLE: &str = r#"[{"start_field":1,"start_char":1,"start_skip":false,"end_field":null,"end_char":null,"end_skip":false,"mods":{"numeric":false,"general_numeric":false,"human":false,"version":false,"month":false,"fold":false,"reverse":false,"dictionary":false,"ignore_nonprinting":false,"random":false}}]"#;

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
        assert!(piece.len() < super::PIECE + 16);
        calls += 1;
        pieces += usize::from(!piece.is_empty());
        out.extend_from_slice(&piece);
    }
    assert_eq!(pieces, input.len().div_ceil(super::PIECE));
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
