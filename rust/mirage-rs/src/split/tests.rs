use serde_json::{Value as Json, json};

use crate::host::{Fault, Host};

/// Run `kind` over the file `in`, served three bytes a read; the host and
/// the run's status.
fn run(kind: &str, mut config: Json, operands: &[&str], input: &str) -> (Host, i32) {
    let mut host = Host::with(&[("in", input)], "");
    config["operands"] = json!(operands);
    let mut stream = crate::open(kind, config.to_string().as_bytes()).expect("opens");
    let status = host.drive(stream.as_mut());
    (host, status)
}

fn file<'a>(host: &'a Host, name: &str) -> &'a str {
    std::str::from_utf8(&host.files[name]).expect("text")
}

fn split(config: Json, input: &str) -> Host {
    run("split", config, &["in"], input).0
}

#[test]
fn split_cuts_across_the_host_chunks() {
    let host = split(json!({"lines": "2"}), "a\nbb\nccc\ndddd\ne");
    assert_eq!(
        (file(&host, "xab"), file(&host, "xac")),
        ("ccc\ndddd\n", "e")
    );
    assert_eq!(
        file(&split(json!({"bytes": "4"}), "abcdefghij"), "xac"),
        "ij"
    );
    let host = split(json!({"lines": "1", "separator": "|"}), "a|b||");
    assert_eq!(file(&host, "xac"), "|");
}

#[test]
fn suffixes_widen_past_the_reserved_letter_or_run_out() {
    let host = split(json!({"bytes": "1"}), &"x".repeat(677));
    assert!(
        ["xyz", "xzaaa", "xzaba"]
            .iter()
            .all(|name| host.files.contains_key(*name))
    );
    let config = json!({"bytes": "1", "numeric_suffixes": "8", "suffix_length": "1"});
    let (host, status) = run("split", config, &["in"], "abc");
    assert_eq!(
        (host.err.as_slice(), status),
        (b"split: output file suffixes exhausted\n".as_slice(), 1)
    );
    assert!(host.files.contains_key("x9") && !host.files.contains_key("x10"));
}

#[test]
fn chunks_cut_the_spool_the_host_filled() {
    let host = split(json!({"number": "3"}), "abcdefg");
    assert_eq!(
        [file(&host, "xaa"), file(&host, "xab"), file(&host, "xac")],
        ["abc", "de", "fg"]
    );
    let host = split(
        json!({"number": "l/3"}),
        "line1\nline2\nline3\nline4\nline5\n",
    );
    assert_eq!(file(&host, "xab"), "line3\nline4\n");
    let lines: String = (1..=20).map(|n| format!("{n}\n")).collect();
    let host = split(json!({"number": "r/18"}), &lines);
    assert_eq!(
        (file(&host, "xaa"), file(&host, "xar")),
        ("1\n19\n", "18\n")
    );
    assert_eq!(split(json!({"number": "2/3"}), "abcdefg").out, b"de");
    assert_eq!(
        split(json!({"number": "l/2/1000000000"}), "abc\ndef\n").out,
        b""
    );
    assert_eq!(split(json!({"number": "3"}), "").files.len(), 4);
}

#[test]
fn a_failed_read_or_write_ends_the_run() {
    let mut host = Host::with(&[], "");
    let fault = Fault {
        after: 0,
        errno: "EIO",
        text: "Input/output error",
    };
    host.faults.insert("in".into(), fault);
    let mut stream = crate::open("split", br#"{"operands":["in"]}"#).expect("opens");
    assert_eq!(host.drive(stream.as_mut()), 1);
    assert_eq!(host.err, b"split: in: Input/output error\n");
    let (host, _) = run(
        "split",
        json!({"lines": "1"}),
        &["in", "/denied/p"],
        "a\nb\n",
    );
    assert_eq!(host.err, b"split: /denied/paa: Permission denied\n");
    let (host, _) = run(
        "csplit",
        json!({"prefix": "/denied/p"}),
        &["in", "1"],
        "a\n",
    );
    assert_eq!(host.err, b"csplit: /denied/p00: Permission denied\n");
    // The piece a read fails in is committed, then removed with the rest.
    let mut host = Host::with(&[("in", "a\nb\nc\nd\n")], "");
    let fault = Fault {
        after: 5,
        errno: "EIO",
        text: "Input/output error",
    };
    host.faults.insert("in".into(), fault);
    let mut stream = crate::open("csplit", br#"{"operands":["in","3"]}"#).expect("opens");
    assert_eq!(host.drive(stream.as_mut()), 1);
    assert_eq!(
        (host.out.as_slice(), host.files.len()),
        (b"4\n1\n".as_slice(), 1)
    );
}

#[test]
fn csplit_cuts_lines_that_cross_the_host_chunks() {
    let cut = |patterns: &[&str], config: Json| {
        let operands: Vec<&str> = std::iter::once("in")
            .chain(patterns.iter().copied())
            .collect();
        run(
            "csplit",
            config,
            &operands,
            "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
        )
        .0
    };
    assert_eq!(cut(&["3", "{2}"], json!({})).out, b"4\n6\n6\n5\n");
    let host = cut(&["/5/-2", "%8%"], json!({}));
    assert_eq!(
        (host.out.as_slice(), file(&host, "xx01")),
        (b"4\n7\n".as_slice(), "8\n9\n10\n")
    );
    let host = cut(&["/[13579]/", "{*}"], json!({"suppress": true}));
    assert_eq!(host.out, b"0\n2\n2\n2\n2\n0\n0\n");
    let host = cut(&["/1/+4", "{*}"], json!({}));
    assert_eq!(host.err, b"csplit: '/1/+4': line number out of range\n");
    assert_eq!(host.files.len(), 1);
}

#[test]
fn csplit_holds_no_line_past_its_limit() {
    let line = "a".repeat(super::csplit::MAX_LEN + 1);
    let (host, status) = run("csplit", json!({}), &["in", "/b/"], &line);
    assert_eq!(
        (host.err.as_slice(), status),
        (b"csplit: memory exhausted\n".as_slice(), 1)
    );
    let lines = "a line of sixteen\n".repeat(super::csplit::MAX_LEN / 8);
    let (host, _) = run("csplit", json!({}), &["in", "/b/-100000"], &lines);
    assert_eq!(host.err, b"csplit: memory exhausted\n");
    assert_eq!(host.files.len(), 1);
    let (host, _) = run("csplit", json!({}), &["in", "2"], &format!("{line}\nb\n"));
    assert_eq!(host.out, format!("{}\n2\n", line.len() + 1).into_bytes());
}

#[test]
fn csplit_goes_on_with_a_long_back_referenced_search_across_drains() {
    let line = "a".repeat(26);
    let input = format!("{line}b\n{line}c\nzz\n");
    let (host, status) = run(
        "csplit",
        json!({}),
        &["in", "/^\\(a\\|aa\\)*\\1c$/"],
        &input,
    );
    assert_eq!((host.out.as_slice(), status), (b"28\n31\n".as_slice(), 0));
    assert!(host.drains > 2, "{}", host.drains);
}

/// Every piece the run made, in name order.
fn pieces(host: &Host) -> Vec<(String, String)> {
    let mut names: Vec<_> = host
        .files
        .keys()
        .filter(|name| name.starts_with('x'))
        .cloned()
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| (file(host, &name).to_owned(), name))
        .map(|(body, name)| (name, body))
        .collect()
}

#[test]
fn line_bytes_pack_whole_records_and_cut_a_long_one() {
    for (input, limit, want) in [
        (
            "aaaa\nbb\ncccccccc\nd\n",
            "5",
            vec!["aaaa\n", "bb\n", "ccccc", "ccc\n", "d\n"],
        ),
        ("ab\ncccccccc\n", "5", vec!["ab\n", "ccccc", "ccc\n"]),
        ("abcdefgh\nij\n", "5", vec!["abcde", "fgh\n", "ij\n"]),
        ("abcde\nfghij\n", "5", vec!["abcde", "\n", "fghij", "\n"]),
        (
            "ab\ncdefghijklmnop",
            "5",
            vec!["ab\n", "cdefg", "hijkl", "mnop"],
        ),
        (
            "abcdefghijk\nl\n",
            "3",
            vec!["abc", "def", "ghi", "jk\n", "l\n"],
        ),
        ("a\nb\nc\nd\n", "4", vec!["a\nb\n", "c\nd\n"]),
        ("", "5", vec![]),
    ] {
        let host = split(json!({"line_bytes": limit}), input);
        let got: Vec<String> = pieces(&host).into_iter().map(|(_, body)| body).collect();
        assert_eq!(got, want, "{input:?} -C {limit}");
    }
}

#[test]
fn one_way_of_splitting_and_a_line_bytes_count_worded_as_lines() {
    for config in [
        json!({"lines": "1", "bytes": "1"}),
        json!({"line_bytes": "2", "number": "2"}),
    ] {
        let (host, status) = run("split", config, &["in"], "a\n");
        assert_eq!(
            (host.err.as_slice(), status),
            (b"split: cannot split in more than one way\nTry 'split --help' for more information.\n".as_slice(), 1)
        );
    }
    let (host, status) = run("split", json!({"line_bytes": "0"}), &["in"], "a\n");
    assert_eq!(
        (host.err.as_slice(), status),
        (b"split: invalid number of lines: '0'\n".as_slice(), 1)
    );
}

#[test]
fn elided_pieces_make_no_file_and_verbose_names_the_ones_made() {
    let host = split(
        json!({"number": "4", "elide_empty_files": true, "verbose": true}),
        "ab",
    );
    assert_eq!(
        pieces(&host),
        [
            ("xaa".to_owned(), "a".to_owned()),
            ("xab".to_owned(), "b".to_owned())
        ]
    );
    assert_eq!(host.out, b"creating file 'xaa'\ncreating file 'xab'\n");
    let host = split(
        json!({"number": "r/3", "elide_empty_files": true, "verbose": true}),
        "a\nb\n",
    );
    assert_eq!(pieces(&host).len(), 2);
    assert_eq!(host.out, b"creating file 'xaa'\ncreating file 'xab'\n");
    let host = split(json!({"number": "r/3", "verbose": true}), "a\nb\n");
    assert_eq!(pieces(&host).len(), 3);
    assert_eq!(
        host.out,
        b"creating file 'xaa'\ncreating file 'xab'\ncreating file 'xac'\n"
    );
    let host = split(json!({"line_bytes": "3", "verbose": true}), "ab\ncd\n");
    assert_eq!(host.out, b"creating file 'xaa'\ncreating file 'xab'\n");
}
