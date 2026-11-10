use std::collections::HashMap;

use serde_json::{Value as Json, json};

use crate::host::{Fault, Host};

struct Run {
    out: String,
    err: String,
    status: i32,
    files: HashMap<String, Vec<u8>>,
    links: HashMap<String, String>,
    /// What standard input still held once the run ended.
    stdin: String,
    drains: usize,
}

fn run_host(config: Json, mut host: Host) -> Run {
    let mut stream = super::open(config.to_string().as_bytes()).expect("opens");
    let status = host.drive(stream.as_mut());
    Run {
        out: String::from_utf8_lossy(&host.out).into_owned(),
        err: String::from_utf8_lossy(&host.err).into_owned(),
        status,
        files: host.files,
        links: host.links,
        stdin: String::from_utf8_lossy(&host.stdin).into_owned(),
        drains: host.drains,
    }
}

/// Text as the host sends it: one character per byte.
fn view(text: &str) -> String {
    text.bytes().map(char::from).collect()
}

fn expressions(pieces: &[&str]) -> Json {
    Json::Array(
        pieces
            .iter()
            .map(|text| json!({"text": view(text)}))
            .collect(),
    )
}

fn sed(script: &str, stdin: &str) -> Run {
    run_host(
        json!({"pieces": expressions(&[script]), "cwd": "/"}),
        Host::with(&[], stdin),
    )
}

fn out(script: &str, stdin: &str) -> String {
    let run = sed(script, stdin);
    assert_eq!((run.err.as_str(), run.status), ("", 0), "{script}");
    run.out
}

fn quiet(script: &str, stdin: &str) -> String {
    let run = run_host(
        json!({"pieces": expressions(&[script]), "quiet": true}),
        Host::with(&[], stdin),
    );
    assert_eq!(run.err, "", "{script}");
    run.out
}

fn refusal(pieces: &[&str]) -> (String, i32) {
    let run = run_host(
        json!({"pieces": expressions(pieces)}),
        Host::with(&[], "a\n"),
    );
    (run.err, run.status)
}

#[test]
fn scripts_print_what_gnu_prints() {
    for (script, data, want) in [
        (":a;N;$!ba;s/\\n/,/g", "a\nb\nc\n", "a,b,c\n"),
        ("$!N;P;D", "a\nb\nc\n", "a\nb\nc\n"),
        ("s/x*/-/g", "abxd\n", "-a-b-d-\n"),
        ("s/b*/X/2", "abbb\n", "aX\n"),
        ("2,4cMID", "1\n2\n3\n4\n5\n", "1\nMID\n5\n"),
        ("s/\\w\\+/\\u&/g", "hello world\n", "Hello World\n"),
        ("s/.*/\\u\\L&/", "hELLO\n", "hello\n"),
        ("s/.*/\\L\\u&/", "hello\n", "Hello\n"),
        ("s/\\(x*\\)\\(a\\)/\\u\\1\\2/", "ab\n", "Ab\n"),
        ("s/\\(x*\\)\\(y*\\)\\(a\\)/\\u\\1\\2\\3/", "ab\n", "ab\n"),
        ("s/x/[\\x26\\x5c1]/", "x\n", "[&\\1]\n"),
        ("s/a\\x2eb/X/g", "a.b axb\n", "X X\n"),
        ("y/el/ip/", "hello\n", "hippo\n"),
        ("n;a X", "a\nb\nc\n", "a\nb\nX\nc\n"),
        ("$G", "a\nb", "a\nb\n\n"),
        ("p;q", "abc", "abc\nabc\n"),
        ("s/hi/HI/p", "hi\nbye\n", "HI\nHI\nbye\n"),
        ("s/a+/X/", "a+b\n", "Xb\n"),
        (r"/a\+b/d", "x\na+b\naab\ny\n", "x\na+b\ny\n"),
        (r"/a\/b/,/c\/d/d", "x\na/b\nmid\nc/d\ny\n", "x\ny\n"),
        ("$!N;a X\nP;D", "a\nb\n", "a\nb\nX\nX\n"),
        ("1~2d;=", "a\nb\nc\nd\n", "2\nb\n4\nd\n"),
        ("x;G;1d", "a\nb\n", "a\nb\n"),
        ("h;s/.*/X/;H;g", "a\n", "a\nX\n"),
    ] {
        assert_eq!(out(script, data), want, "{script}");
    }
}

#[test]
fn a_missing_newline_holds_until_more_follows() {
    assert_eq!(out("p", "a"), "a\na");
    let run = run_host(
        json!({"pieces": expressions(&["p;="]), "quiet": true}),
        Host::with(&[], "a\nb"),
    );
    assert_eq!(run.out, "a\n1\nb\n2\n");
    assert_eq!(out("w /dev/stdout", "a\nb"), "a\na\nbb");
}

#[test]
fn a_long_line_reads_whole_beside_short_ones() {
    let long = "ab".repeat(33_000);
    let input = format!("{long}\nx\n{long}\n{long}");
    let expected = format!("{0}\n1\nx\n2\n{0}\n3\n{0}\n4\n", long.replacen('a', "A", 1));
    let run = run_host(
        json!({"pieces": expressions(&["s/a/A/;p;="]), "quiet": true}),
        Host::with(&[], &input),
    );
    assert_eq!(run.out, expected);
}

#[test]
fn list_wraps_without_splitting_an_escape() {
    assert_eq!(quiet("l 5", "aaa\tb\n"), "aaa\\\n\\tb$\n");
    assert_eq!(quiet("l 1", "abc\n"), "\\\na\\\nb\\\nc$\n");
    assert_eq!(quiet("l", "\x01\u{e9}\\\n"), "\\001\\303\\251\\\\$\n");
}

#[test]
fn a_line_number_range_opens_late_once() {
    let data = "1\n2\n3\n4\n5\n6\n";
    assert_eq!(quiet("1{n;b};2,3p", data), "3\n");
    assert_eq!(quiet("1{n;n;b};2,3p", data), "");
    assert_eq!(quiet("2,/4/p", data), "2\n3\n4\n");
    assert_eq!(quiet("2,~4p", data), "2\n3\n4\n");
    assert_eq!(quiet("4,~4p", data), "4\n5\n6\n");
    assert_eq!(quiet("0,/1/p", data), "1\n");
    assert_eq!(quiet("/2/,+2p", data), "2\n3\n4\n");
    assert_eq!(quiet("2,1p", data), "2\n");
}

fn files_run(script: &str, operands: &[&str], files: &[(&str, &str)], extra: Json) -> Run {
    let mut config = json!({"pieces": expressions(&[script]), "inputs": operands, "cwd": "/"});
    for (key, value) in extra.as_object().expect("an object") {
        config[key] = value.clone();
    }
    run_host(config, Host::with(files, ""))
}

#[test]
fn separate_inputs_restart_lines_hold_and_ranges() {
    let files = [
        ("/a", "a\nb\n"),
        ("/b", "c\n"),
        ("/x", "a\n"),
        ("/y", "b\n"),
    ];
    let run = files_run("x", &["/x", "/y"], &files, json!({"separate": true}));
    assert_eq!(run.out, "\n\n");
    let separate = json!({"separate": true, "quiet": true});
    let run = files_run("$p", &["/a", "/b"], &files, separate.clone());
    assert_eq!(run.out, "b\nc\n");
    let run = files_run("$p", &["/a", "/b"], &files, json!({"quiet": true}));
    assert_eq!(run.out, "c\n");
    let run = files_run("F;=", &["/a", "/b"], &files, separate);
    assert_eq!(run.out, "/a\n1\n/a\n2\n/b\n1\n");
}

#[test]
fn the_look_ahead_passes_over_a_directory() {
    let files = [("/f", "one\ntwo\n"), ("/g", "L1\n")];
    let mut host = Host::with(&files, "");
    host.directories.push("/d".into());
    let config =
        json!({"pieces": expressions(&["$p"]), "inputs": ["/f", "/d", "/g"], "quiet": true});
    let run = run_host(config, host);
    assert_eq!(
        (run.out.as_str(), run.err.as_str(), run.status),
        ("L1\n", "", 0)
    );
    let mut host = Host::with(&files, "");
    host.directories.push("/d".into());
    let config =
        json!({"pieces": expressions(&["p"]), "inputs": ["/f", "/d", "/g"], "quiet": true});
    let run = run_host(config, host);
    assert_eq!(run.out, "one\ntwo\n");
    assert_eq!(run.err, "sed: read error on /d: Is a directory\n");
    assert_eq!(run.status, 4);
}

fn faulted(script: &str, fault: Fault, rest: &[(&str, &str)]) -> Run {
    let mut host = Host::with(rest, "");
    host.faults.insert("/in0".into(), fault);
    let mut inputs = vec!["/in0"];
    inputs.extend(rest.iter().map(|(name, _)| *name));
    let config = json!({"pieces": expressions(&[script]), "inputs": inputs, "quiet": true});
    run_host(config, host)
}

fn denied(after: usize) -> Fault {
    Fault {
        after,
        errno: "EACCES",
        text: "Permission denied",
    }
}

#[test]
fn a_read_failing_as_it_is_looked_into_ends_the_input() {
    let mut host = Host::with(&[("/in0", "first\n")], "");
    host.faults.insert("/in0".into(), denied(6));
    let config = json!({"pieces": expressions(&["$p"]), "inputs": ["/in0"], "quiet": true});
    let run = run_host(config, host);
    assert_eq!(
        (run.out.as_str(), run.err.as_str(), run.status),
        ("first\n", "", 0)
    );
    let mut host = Host::with(&[("/in0", "first\n"), ("/good", "good\n")], "");
    host.faults.insert("/in0".into(), denied(6));
    let config = json!({"pieces": expressions(&["p"]), "inputs": ["/in0", "/good"], "quiet": true});
    let run = run_host(config, host);
    assert_eq!(run.out, "first\n");
    assert_eq!(run.err, "sed: read error on /in0: Permission denied\n");
    assert_eq!(run.status, 4);
    let mut host = Host::with(&[("/in0", "one\nx")], "");
    host.faults.insert("/in0".into(), denied(5));
    let config = json!({"pieces": expressions(&["$!p;q"]), "inputs": ["/in0"], "quiet": true});
    let run = run_host(config, host);
    assert_eq!(
        (run.out.as_str(), run.err.as_str(), run.status),
        ("one\n", "", 0)
    );
}

#[test]
fn an_input_that_does_not_open_is_reported_and_read_past() {
    let run = faulted("q5", denied(0), &[("/one", "one\n")]);
    assert_eq!(run.out, "");
    let config = json!({"pieces": expressions(&["q5"]), "inputs": ["/nope", "/one"]});
    let run = run_host(config, Host::with(&[("/one", "one\n")], ""));
    assert_eq!(run.out, "one\n");
    assert_eq!(
        run.err,
        "sed: can't read /nope: No such file or directory\n"
    );
    assert_eq!(run.status, 2);
}

#[test]
fn the_append_queue_and_files() {
    let files = [("/r", "R1\n"), ("/in", "a\nb\nc\n")];
    let run = files_run("1r /r\n1a X\n2r/r", &["/in"], &files, json!({}));
    assert_eq!(run.out, "a\nR1\nX\nb\nR1\nc\n");
    let run = files_run("0r /r", &["/in"], &files, json!({}));
    assert_eq!(run.out, "R1\na\nb\nc\n");
    let run = files_run("1r /r\n1Q", &["/in"], &files, json!({}));
    assert_eq!(run.out, "");
    let run = files_run("p;0r /r", &["/in"], &files, json!({"quiet": true}));
    assert_eq!(run.out, "a\nR1\nb\nc\n");
    let run = files_run("1r /nope", &["/in"], &files, json!({}));
    assert_eq!((run.out.as_str(), run.status), ("a\nb\nc\n", 0));
    let files = [("/r", "x"), ("/in", "a\nb\n")];
    let run = files_run("r /r", &["/in"], &files, json!({}));
    assert_eq!(run.out, "a\nxb\nx");
}

#[test]
fn r_files_stream_and_report_a_failed_read() {
    let mut host = Host::with(&[("/r", "R1\nR2"), ("/in", "a\nb\n")], "");
    host.faults.insert("/r".into(), denied(5));
    let config = json!({"pieces": expressions(&["1r /r\n$a X"]), "inputs": ["/in"]});
    let run = run_host(config, host);
    assert_eq!(run.out, "a\nR1\nR2");
    assert_eq!(run.err, "sed: read error on /r: Permission denied\n");
    assert_eq!(run.status, 4);
    let mut host = Host::with(&[("/in", "a\n")], "");
    host.faults.insert(
        "/r".into(),
        Fault {
            after: 0,
            errno: "EIO",
            text: "Input/output error",
        },
    );
    let config = json!({"pieces": expressions(&["1R /r"]), "inputs": ["/in"]});
    let run = run_host(config, host);
    assert_eq!(run.err, "sed: read error on /r: Input/output error\n");
    assert_eq!(run.status, 4);
}

#[test]
fn r_cuts_its_file_at_newlines_only_and_rewinds_per_input() {
    let files = [("/r", "left\rright\nnext\n"), ("/in", "1\n2\n")];
    let run = files_run("R /r", &["/in"], &files, json!({}));
    assert_eq!(run.out, "1\nleft\rright\n2\nnext\n");
    let files = [("/r", "R1\nR2\n"), ("/f", "a\n")];
    let run = files_run("R /r", &["/f", "/f"], &files, json!({}));
    assert_eq!(run.out, "a\nR1\na\nR2\n");
    let run = files_run("R /r", &["/f", "/f"], &files, json!({"separate": true}));
    assert_eq!(run.out, "a\nR1\na\nR1\n");
}

#[test]
fn quit_codes_and_the_empty_regex() {
    let run = sed("2q300", "a\nb\nc\n");
    assert_eq!((run.out.as_str(), run.status), ("a\nb\n", 44));
    let run = run_host(
        json!({"pieces": expressions(&["2{/a/p};1{//p}"]), "quiet": true}),
        Host::with(&[], "a\nb\n"),
    );
    assert_eq!(
        run.err,
        "sed: -e expression #1, char 0: no previous regular expression\n"
    );
    assert_eq!(run.status, 1);
    assert_eq!(quiet("/a/I{s//x/p}", "AB\n"), "xB\n");
    let run = sed("/^/s//\\1/", "ab\n");
    assert_eq!(
        (run.err.as_str(), run.status),
        (
            "sed: -e expression #1, char 0: invalid reference \\1 on `s' command's RHS\n",
            1
        )
    );
    assert_eq!(sed("2q", "a\nb").out, "a\nb\n");
    assert_eq!(sed("Q7", "a\n").status, 7);
    assert_eq!(sed("q4294967295", "a\n").status, 0);
    assert_eq!(sed("q4294967296", "a\n").status, 0);
    assert_eq!(sed("q4294967297", "a\n").status, 1);
}

#[test]
fn refusals_carry_gnus_wording_and_place() {
    for (script, message) in [
        ("k", "char 1: unknown command: `k'"),
        ("2 k", "char 3: unknown command: `k'"),
        ("2 ", "char 2: missing command"),
        ("1,p", "char 3: unexpected `,'"),
        ("2!!d", "char 3: multiple `!'s"),
        ("2! !d", "char 4: multiple `!'s"),
        ("0p", "char 2: invalid usage of line address 0"),
        ("0!p", "char 2: invalid usage of line address 0"),
        ("0,5p", "char 4: invalid usage of line address 0"),
        ("1,2q", "char 4: command only uses one address"),
        ("1:a", "char 2: : doesn't want any addresses"),
        ("1#a", "char 2: comments don't accept any addresses"),
        ("}", "char 1: unexpected `}'"),
        ("{p;1}", "char 5: `}' doesn't want any addresses"),
        ("{p", "char 0: unmatched `{'"),
        ("s/a/b", "char 5: unterminated `s' command"),
        ("s/a/b/k", "char 7: unknown option to `s'"),
        ("s/a/b/gg", "char 8: multiple `g' options to `s' command"),
        (
            "s/a/b/2g3",
            "char 9: multiple number options to `s' command",
        ),
        (
            "s/o/O/0",
            "char 7: number option to `s' command may not be zero",
        ),
        ("s/a/b/w", "char 7: missing filename in r/R/w/W commands"),
        ("s/\\(/x/;p", "char 8: Unmatched ( or \\("),
        ("/\\(/Ip", "char 5: Unmatched ( or \\("),
        (
            "s/x/\\9/",
            "char 7: invalid reference \\9 on `s' command's RHS",
        ),
        (
            "y/abc/xy/",
            "char 9: strings for `y' command are different lengths",
        ),
        ("y/a/b/g", "char 7: extra characters after command"),
        ("y1a1\\x411", "char 9: extra characters after command"),
        ("l 3x", "char 4: extra characters after command"),
        (":", "char 1: \":\" lacks a label"),
        ("a", "char 1: expected \\ after `a', `c' or `i'"),
        ("\\%a", "char 3: unterminated address regex"),
        ("//Ip", "char 3: cannot specify modifiers on empty regexp"),
        ("v 9.0", "char 5: expected newer version of sed"),
        ("v 4.10", "char 6: expected newer version of sed"),
        ("e ls", "char 1: `e' command not supported"),
        (
            "s/\\c\\d/X/",
            "char 9: recursive escaping after \\c not allowed",
        ),
        (
            "s/a/\\c\\d/",
            "char 9: recursive escaping after \\c not allowed",
        ),
        (
            "y/a\\c\\d/XY/",
            "char 8: recursive escaping after \\c not allowed",
        ),
        (
            "a foo\\c\\dbar",
            "char 12: recursive escaping after \\c not allowed",
        ),
        ("s/\\c/X/", "char 7: Trailing backslash"),
        ("s/a/b/\r", "char 7: unknown option to `s'"),
    ] {
        assert_eq!(
            refusal(&[script]),
            (format!("sed: -e expression #1, {message}\n"), 1),
            "{script}"
        );
    }
    for version in ["09", "010", "4.010", "4..9", "4.9"] {
        assert_eq!(out(&format!("v {version}"), "x\n"), "x\n");
    }
}

#[test]
fn a_command_never_continues_into_the_next_piece() {
    for (pieces, message) in [
        (["s/a/b\\", "c/"], "char 6: unterminated `s' command"),
        (["s/a\\", "b/x/"], "char 4: unterminated `s' command"),
        (["/a\\", "/p"], "char 3: unterminated address regex"),
        (["y/a\\", "/b/"], "char 4: unterminated `y' command"),
    ] {
        assert_eq!(
            refusal(&pieces).0,
            format!("sed: -e expression #1, {message}\n")
        );
    }
}

#[test]
fn pieces_and_files_are_named_as_gnu_names_them() {
    assert_eq!(
        refusal(&["p", "2 k"]).0,
        "sed: -e expression #2, char 3: unknown command: `k'\n"
    );
    assert_eq!(
        refusal(&["2", "p"]).0,
        "sed: -e expression #1, char 1: missing command\n"
    );
    assert_eq!(
        refusal(&["p", "2{p"]).0,
        "sed: -e expression #2, char 0: unmatched `{'\n"
    );
    let pieces = json!([{"text": "p"}, {"text": "p\n\n 2 k\n", "file": "/s.sed"}]);
    let run = run_host(json!({"pieces": pieces}), Host::with(&[], ""));
    assert_eq!(run.err, "sed: file /s.sed line 3: unknown command: `k'\n");
    assert_eq!(
        refusal(&["bfoo"]),
        ("sed: can't find label for jump to `foo'\n".into(), 4)
    );
    assert_eq!(
        refusal(&["s/[:alpha:]/x/"]),
        (
            "sed: character class syntax is [[:space:]], not [:space:]\n".into(),
            4
        )
    );
}

#[test]
fn text_reads_as_gnu_reads_it() {
    for (script, text) in [
        ("a  one", "one\n"),
        ("a\\   two", "   two\n"),
        ("a one\\/two\\tthree", "one/two\tthree\n"),
        ("1a foo; 2d", "foo; 2d\n"),
        ("a\\\n  l1\\\n  l2", "  l1\n  l2\n"),
        ("a\\\\", "\n"),
        ("a x\\ty\\", "x\\ty\n"),
        ("a foo\\c\\\\bar", "foo\x1cbar\n"),
        ("a foo\\c", "fooJ"),
        ("i foo\\c", "foo\n"),
    ] {
        assert_eq!(quiet(script, "x\n"), text, "{script}");
    }
    assert_eq!(quiet("a\\", "x\n"), "");
    let run = run_host(
        json!({"pieces": expressions(&["a foo\\", "bar"]), "quiet": true}),
        Host::with(&[], "x\n"),
    );
    assert_eq!(run.out, "foo\nbar\n");
}

#[test]
fn labels_comments_and_crlf() {
    assert_eq!(out("2{bx};s/^/-/;:x", "a\nb\n"), "-a\nb\n");
    let run = run_host(
        json!({"pieces": expressions(&["b done#note", "s/^/-/", ":done#here"])}),
        Host::with(&[], "a\n"),
    );
    assert_eq!(run.out, "a\n");
    assert_eq!(out("s/a/b/g\r\np", "aa\n"), "bb\nbb\n");
    assert_eq!(quiet("#n\n2p", "a\nb\n"), "b\n");
    assert_eq!(out(" #n", "a\n"), "a\n");
}

#[test]
fn escapes_name_bytes() {
    assert_eq!(out("s/\\c\\\\/X/", "a\x1cb\n"), "aXb\n");
    assert_eq!(out("y/\\c\\\\/Z/", "a\x1cb\n"), "aZb\n");
    assert_eq!(out("s/\\ca/Y/", "a\x01b\n"), "aYb\n");
    assert_eq!(out("y1a1\\x41", "a\n"), "\x04\n");
}

#[test]
fn utf8_works_on_characters() {
    let utf8 = |script: &str, data: &str| -> String {
        let run = run_host(
            json!({"pieces": expressions(&[script]), "utf8": true}),
            Host::with(&[], data),
        );
        assert_eq!(run.err, "", "{script}");
        run.out
    };
    assert_eq!(utf8("s/./X/", "é1\n"), "X1\n");
    assert_eq!(out("s/./X/", "é1\n"), "X\u{fffd}1\n");
    assert_eq!(utf8("y/éa/Eb/", "éa\n"), "Eb\n");
    assert_eq!(utf8("s/.*/\\U&/", "ébß\n"), "ÉBß\n");
    assert_eq!(out("s/.*/\\U&/", "ébß\n"), "éBß\n");
    assert_eq!(utf8("s/\\w*/\\u&/", "élan\n"), "Élan\n");
    let run = run_host(
        json!({"pieces": expressions(&["s\u{e9}a\u{e9}b\u{e9}"]), "utf8": true}),
        Host::with(&[], "a\n"),
    );
    assert_eq!(
        run.err,
        "sed: -e expression #1, char 2: delimiter character is not a single-byte character\n"
    );
}

#[test]
fn w_files_are_emptied_written_and_committed() {
    let run = files_run(
        "w /o",
        &["/in"],
        &[("/in", "a\nb"), ("/o", "old\n")],
        json!({"quiet": true}),
    );
    assert_eq!(run.files["/o"], b"a\nb");
    let run = files_run(
        "2w /o",
        &["/in"],
        &[("/in", "a\n"), ("/o", "old\n")],
        json!({}),
    );
    assert_eq!(run.files["/o"], b"");
    let run = run_host(
        json!({"pieces": expressions(&["w /o", "k"])}),
        Host::with(&[("/o", "old\n")], "a\n"),
    );
    assert_eq!(
        run.err,
        "sed: -e expression #2, char 1: unknown command: `k'\n"
    );
    assert_eq!(run.files["/o"], b"");
    let run = files_run("w /missing/o", &["/in"], &[("/in", "a\n")], json!({}));
    assert_eq!(
        (run.out.as_str(), run.err.as_str(), run.status),
        (
            "",
            "sed: couldn't open file /missing/o: No such file or directory\n",
            4
        )
    );
    let run = files_run(
        "w /brim/o",
        &["/in"],
        &[("/in", "a\n")],
        json!({"in_place": true, "paths": ["/in"]}),
    );
    assert_eq!(
        (run.err.as_str(), run.status),
        (
            "sed: couldn't open file /brim/o: No space left on device\n",
            4
        )
    );
    let run = files_run("w /brim/o", &["/in"], &[("/in", "a\n")], json!({}));
    assert_eq!(
        (run.out.as_str(), run.err.as_str(), run.status),
        (
            "a\n",
            "sed: couldn't open file /brim/o: No space left on device\n",
            4
        )
    );
    let run = files_run(
        "1w /dev/stderr",
        &["/in"],
        &[("/in", "a\nb\n")],
        json!({"quiet": true}),
    );
    assert_eq!((run.out.as_str(), run.err.as_str()), ("", "a\n"));
    let run = files_run(
        "N;W /o",
        &["/in"],
        &[("/in", "a\nb\nc\n")],
        json!({"quiet": true}),
    );
    assert_eq!(run.files["/o"], b"a\n");
    let run = files_run(
        "1w /o\n2w ./o\n3w /x/../o",
        &["/in"],
        &[("/in", "a\nbb\nccc\n")],
        json!({"quiet": true}),
    );
    assert_eq!(run.files["/o"], b"a\n\n\n");
}

#[test]
fn w_output_waits_when_the_script_reads_files() {
    let run = files_run("w /o\n$r /o", &["/in"], &[("/in", "a\nb\nc\n")], json!({}));
    assert_eq!(run.out, "a\nb\nc\n");
    assert_eq!(run.files["/o"], b"a\nb\nc\n");
}

#[test]
fn in_place_edits_each_file_whole() {
    let in_place = |script: &str, operands: &[&str], files: &[(&str, &str)]| -> Run {
        let config = json!({
            "pieces": expressions(&[script]),
            "inputs": operands,
            "paths": operands,
            "in_place": true,
            "cwd": "/",
        });
        run_host(config, Host::with(files, ""))
    };
    let run = in_place("y/o/0/", &["/a"], &[("/a", "one\ntwo\n")]);
    assert_eq!((run.out.as_str(), run.status), ("", 0));
    assert_eq!(run.files["/a"], b"0ne\ntw0\n");
    let run = in_place("2q", &["/a", "/b"], &[("/a", "1\n2\n3\n"), ("/b", "x\n")]);
    assert_eq!(run.files["/a"], b"1\n2\n");
    assert_eq!(run.files["/b"], b"x\n");
    let run = in_place(
        "$p;s/x/X/w /dev/stdout",
        &["/a", "/b"],
        &[("/a", "x\ny\n"), ("/b", "z\nx\n")],
    );
    assert_eq!(run.out, "X\nX\n");
    assert_eq!(run.files["/a"], b"X\ny\ny\n");
    assert_eq!(run.files["/b"], b"z\nx\nX\n");
    let run = in_place(
        "1r /f",
        &["/f", "/b"],
        &[("/f", "one\ntwo\n"), ("/b", "b1\nb2\n")],
    );
    assert_eq!(run.files["/f"], b"one\none\ntwo\ntwo\n");
    assert_eq!(run.files["/b"], b"b1\none\none\ntwo\ntwo\nb2\n");
    let run = in_place(
        "R /f",
        &["/f", "/b"],
        &[("/f", "one\ntwo\n"), ("/b", "b1\nb2\n")],
    );
    assert_eq!(run.files["/b"], b"b1\none\nb2\ntwo\n");
    let run = in_place(
        "s/b/B/;w /f",
        &["/b", "/f"],
        &[("/f", "one\ntwo\n"), ("/b", "b1\nb2\n")],
    );
    assert_eq!(run.files["/f"], b"");
    assert_eq!(run.files["/b"], b"B1\nB2\n");
    let run = in_place("p", &["/nope", "/a"], &[("/a", "a\n")]);
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: can't read /nope: No such file or directory\n", 2)
    );
    assert_eq!(run.files["/a"], b"a\na\n");
    let mut host = Host::with(&[("/a", "a\n")], "");
    host.directories.push("/d".into());
    let config = json!({"pieces": expressions(&["p"]), "inputs": ["/d", "/a"], "paths": ["/d", "/a"], "in_place": true});
    let run = run_host(config, host);
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: read error on /d: Is a directory\n", 4)
    );
    assert_eq!(run.files["/a"], b"a\n");
    let run = in_place("L", &["/a"], &[("/a", "a\n")]);
    assert_eq!(run.files["/a"], b"a\n");
    assert_eq!(run.status, 4);
    let run = in_place("w /o", &[], &[]);
    assert_eq!((run.err.as_str(), run.status), ("sed: no input files\n", 4));
    assert_eq!(run.files["/o"], b"");
}

#[test]
fn a_long_loop_yields_between_steps() {
    let config = json!({"pieces": expressions(&[":a;s/x/y/;ta;s/$/!/;:b;bb"])});
    let mut stream = super::open(config.to_string().as_bytes()).expect("opens");
    let mut host = Host::with(&[], "x\n");
    let mut data = Vec::new();
    let header = stream.request(&mut data);
    assert!(header.is_none());
    let mut calls = 0;
    loop {
        while stream.busy() && calls < 50 {
            stream.drain(&mut host.out).expect("drains");
            calls += 1;
        }
        let mut data = Vec::new();
        let Some(header) = stream.request(&mut data) else {
            break;
        };
        let (reply, data) = host.serve(&header, data);
        stream
            .respond(reply.to_string().as_bytes(), &data, &mut host.out)
            .expect("answers");
    }
    assert_eq!(calls, 50);
    assert!(stream.cancel());
    host.drive(stream.as_mut());
    assert_eq!(host.out, b"");
}

#[test]
fn early_close_keeps_what_was_written() {
    let config = json!({"pieces": expressions(&["w /saved\nq7"])});
    let mut stream = super::open(config.to_string().as_bytes()).expect("opens");
    let mut host = Host::with(&[], "x\ny\n");
    let mut out = Vec::new();
    while out.is_empty() {
        while stream.busy() {
            stream.drain(&mut out).expect("drains");
        }
        let mut data = Vec::new();
        let header = stream.request(&mut data).expect("a request");
        let (reply, data) = host.serve(&header, data);
        stream
            .respond(reply.to_string().as_bytes(), &data, &mut out)
            .expect("answers");
    }
    assert!(stream.cancel());
    assert_eq!(host.drive(stream.as_mut()), 7);
    assert_eq!(host.files["/saved"], b"x\n");
}

#[test]
fn metadata_says_whether_a_script_writes() {
    for (pieces, writes) in [
        (vec!["p"], false),
        (vec!["w /o"], true),
        (vec!["s/a/b/w /dev/stdout"], true),
        (vec!["w /o", "k"], true),
        (vec!["k", "w /o"], false),
    ] {
        let config = json!({"pieces": expressions(&pieces)});
        let stream = super::open(config.to_string().as_bytes()).expect("opens");
        let mut meta = Vec::new();
        stream.metadata(&mut meta);
        let meta: Json = serde_json::from_slice(&meta).expect("JSON");
        assert_eq!(meta["writes"], json!(writes), "{pieces:?}");
    }
}

#[test]
fn a_failed_edit_stops_the_run() {
    let config = |dir: &str| {
        json!({
            "pieces": expressions(&["s/a/b/w /o"]),
            "inputs": [format!("{dir}f"), "/g"],
            "paths": [format!("{dir}f"), "/g"],
            "in_place": true,
        })
    };
    let files = [
        ("/stale/f", "a\n"),
        ("/denied/f", "a\n"),
        ("/full/f", "a\n"),
        ("/g", "a\n"),
    ];
    let run = run_host(config("/stale/"), Host::with(&files, ""));
    assert_eq!(
        (run.err.as_str(), run.status),
        (
            "sed: couldn't edit /stale/f: changed since it was read; read it again before writing\n",
            4
        )
    );
    assert_eq!(run.files["/g"], b"a\n");
    assert_eq!(run.files["/o"], b"b\n");
    let run = run_host(config("/denied/"), Host::with(&files, ""));
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: can't read /denied/f: Permission denied\n", 1)
    );
    assert_eq!(run.files["/g"], b"a\n");
    assert_eq!(run.files["/o"], b"");
    let run = run_host(config("/full/"), Host::with(&files, ""));
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: couldn't edit /full/f: Disk quota exceeded\n", 4)
    );
    assert_eq!(run.files["/full/f"], b"a\n");
    assert_eq!(run.files["/g"], b"a\n");
    assert_eq!(run.files["/o"], b"");
}

#[test]
fn a_space_past_the_longest_ends_the_run_as_memory_running_out() {
    for script in [":a;h;G;ba", ":a;s/x/xxxxxxxxxx/g;ba", "H;$!d;x"] {
        let lines = "x\n".repeat(crate::constants::MAX_HELD / 2 + 1);
        let run = sed(script, &lines);
        assert_eq!(
            (run.err.as_str(), run.status),
            ("sed: memory exhausted\n", 1),
            "{script}"
        );
    }
    for script in [":a;N;ba", ":a;a x\nba"] {
        let run = sed(script, &"x\n".repeat(crate::constants::MAX_HELD / 2 + 1));
        assert_eq!(
            (run.err.as_str(), run.status),
            ("sed: memory exhausted\n", 1),
            "{script}"
        );
    }
    // A loop that writes stderr and never ends its cycle hands it on.
    let config = json!({"pieces": expressions(&[":a;w /dev/stderr\nba"])});
    let mut stream = super::open(config.to_string().as_bytes()).expect("opens");
    let mut host = Host::with(&[], "x\n");
    let mut err = Vec::new();
    for _ in 0..200 {
        while stream.busy() && err.len() < 2 * crate::constants::FLUSH {
            stream.drain(&mut host.out).expect("drains");
            stream.take_stderr(&mut err);
        }
        let mut data = Vec::new();
        let Some(header) = stream.request(&mut data) else {
            break;
        };
        let (reply, data) = host.serve(&header, data);
        stream
            .respond(reply.to_string().as_bytes(), &data, &mut host.out)
            .expect("answers");
    }
    assert!(err.len() >= 2 * crate::constants::FLUSH);
    assert!(err.starts_with(b"x\nx\n"));
    let run = sed("p", &"a".repeat(crate::constants::MAX_HELD + 10));
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: read error on stdin: Cannot allocate memory\n", 4)
    );
    assert_eq!(out("s/x*/-/g", "abc\n"), "-a-b-c-\n");
    assert_eq!(out("s/b/X/3", "abbbb\n"), "abbXb\n");
}

#[test]
fn script_files_named_dash_are_files() {
    let files = [("/-", "DASH\n"), ("/in", "a\nb\n")];
    let mut host = Host::with(&files, "stdin\n");
    host.files.insert("-".into(), b"DASH\n".to_vec());
    let config = json!({"pieces": expressions(&["r -"]), "inputs": ["/in"]});
    assert_eq!(run_host(config, host).out, "a\nDASH\nb\nDASH\n");
    let mut host = Host::with(&files, "stdin\n");
    host.files.insert("-".into(), b"DASH\n".to_vec());
    let config = json!({"pieces": expressions(&["R -"]), "inputs": ["/in"]});
    assert_eq!(run_host(config, host).out, "a\nDASH\nb\n");
}

#[test]
fn every_way_a_space_grows_meets_the_cap() {
    let max = crate::constants::MAX_HELD;
    let exhausted = ("sed: memory exhausted\n", 1);
    let line = format!("{}\n", "a".repeat(max / 4));
    let run = sed("s/.*/&&&&&&&&&&/", &line);
    assert_eq!((run.err.as_str(), run.status), exhausted);
    let run = sed("s/a/\\U&&&&&&&&&&/g", &line);
    assert_eq!((run.err.as_str(), run.status), exhausted);
    // A case change that fits is made, however close to the cap.
    let wide = "a".repeat(max - max / 8);
    let run = sed("s/.*/\\U&/", &format!("{wide}\n"));
    assert_eq!(run.status, 0);
    assert_eq!(run.out, format!("{}\n", wide.to_uppercase()));
    let run = run_host(
        json!({"pieces": expressions(&["y/a/\u{20ac}/"]), "utf8": true}),
        Host::with(&[], &format!("{}\n", "a".repeat(max / 2))),
    );
    assert_eq!((run.err.as_str(), run.status), exhausted);
    let run = sed("p", &format!("{}\nb\n", "a".repeat(max + 1)));
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: read error on stdin: Cannot allocate memory\n", 4)
    );
    let run = sed("$!d", &format!("{}\nb\n", "a".repeat(max)));
    assert_eq!((run.out.as_str(), run.status), ("b\n", 0));
    let short = "abcdefg\n".repeat(max / 8 + 1);
    let files = [("/r", short.as_str()), ("/in", "a\n")];
    let run = files_run("R /r", &["/in"], &files, json!({"separate": true}));
    assert_eq!((run.err.as_str(), run.status), exhausted);
    let half = "abcdefg\n".repeat(max / 16 + 1);
    let mut host = Host::with(&[("/a", &short), ("/b", &half), ("/in", "a\n")], "");
    host.faults.insert(
        "/a".into(),
        Fault {
            after: max / 4 * 3,
            errno: "EIO",
            text: "Input/output error",
        },
    );
    let config = json!({
        "pieces": expressions(&["/x/R /a\nR /b"]),
        "inputs": ["/in"],
        "separate": true,
    });
    let run = run_host(config, host);
    assert_eq!((run.out.as_str(), run.status), ("a\nabcdefg\n", 0));
}

#[test]
fn a_later_spelling_waits_in_a_host_spool() {
    let lines: String = (0..2000).map(|n| format!("{n}\n")).collect();
    let run = files_run(
        "1w /o\nw ./o",
        &["/in"],
        &[("/in", &lines)],
        json!({"quiet": true}),
    );
    let mut want = b"0\n".to_vec();
    want.extend_from_slice(&lines.as_bytes()[2..]);
    assert_eq!(run.files["/o"], want);
}

#[test]
fn an_edit_opens_its_replacement_first_and_l_meets_the_cap() {
    let mut host = Host::with(&[("/denied/f", "a\nb\n")], "");
    host.faults.insert(
        "/denied/f".into(),
        Fault {
            after: 2,
            errno: "EIO",
            text: "Input/output error",
        },
    );
    let config = json!({
        "pieces": expressions(&["d"]),
        "inputs": ["/denied/f"],
        "paths": ["/denied/f"],
        "in_place": true,
    });
    let run = run_host(config, host);
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: can't read /denied/f: Permission denied\n", 1)
    );
    let mut host = Host::with(&[], "");
    host.faults.insert(
        "/f".into(),
        Fault {
            after: 0,
            errno: "EIO",
            text: "Input/output error",
        },
    );
    let config =
        json!({"pieces": expressions(&["p"]), "inputs": ["/f"], "paths": ["/f"], "in_place": true});
    let run = run_host(config, host);
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: Input/output error\n", 1)
    );
    let run = sed(
        "l",
        &format!("{}\n", "\u{1}".repeat(crate::constants::MAX_HELD / 2)),
    );
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: memory exhausted\n", 1)
    );
}

#[test]
fn a_long_back_referenced_search_goes_on_across_drains() {
    let line = "a".repeat(26);
    let run = sed("s/^\\(a\\|aa\\)*\\1c$/x/", &format!("{line}b\n{line}c\n"));
    assert_eq!(
        (run.out, run.err.as_str(), run.status),
        (format!("{line}b\nx\n"), "", 0)
    );
    assert!(run.drains > 2, "{}", run.drains);
}

#[test]
fn the_line_length_reads_as_atoi() {
    let read = |raw: &[u8]| super::line_length(Some(raw));
    assert_eq!(super::line_length(None), 70);
    assert_eq!(
        (read(b"  +12"), read(b"4294967297"), read(b"-3"), read(b"x")),
        (12, 1, 0, 0)
    );
    assert_eq!((read(b"2147483648"), read(&[b'9'; 40])), (0, 0));
}

fn with(script: &str, stdin: &str, extra: Json) -> Run {
    let mut config = json!({"pieces": expressions(&[script]), "cwd": "/"});
    for (key, value) in extra.as_object().expect("an object") {
        config[key] = value.clone();
    }
    run_host(config, Host::with(&[], stdin))
}

#[test]
fn null_data_lines_end_at_nul() {
    for (script, data, want) in [
        ("s/^/>/", "a\0b\0c", ">a\0>b\0>c"),
        ("s/\\n/N/;s/^/>/", "a\nb\0c\0", ">aNb\0>c\0"),
        ("N;s/\\n/+/", "a\0b\0", "a\0b\0"),
        ("N;s/a\\x00/A+/", "a\0b\0", "A+b\0"),
        ("N;P;D", "a\0b\0", "a\0b\0"),
        ("P;d", "a\nb\0c\0", "a\nb\0c\0"),
        ("D", "a\nb\0c\0", ""),
        ("H;$!d;x", "a\0b\0", "\0a\0b\0"),
        ("G", "a\0b\0", "a\0\0b\0\0"),
        ("=", "a\0b\0", "1\x00a\x002\x00b\x00"),
        ("1a X", "a\0b\0", "a\0X\nb\0"),
        ("1i X", "a\0b\0", "X\0a\0b\0"),
        ("1c X", "a\0b\0", "X\0b\0"),
        ("1i\\\nX\\\nY", "a\0b\0", "X\nY\0a\0b\0"),
        ("1c\\\nX\\\nY", "a\0b\0", "X\nY\0b\0"),
        ("1,2c\\\nX", "a\0b\0", "X\0"),
        ("F", "a\0b\0", "-\0a\0-\0b\0"),
        ("1z", "a\0b\0", "\0b\0"),
        ("y/a/\\n/", "a\0b\0", "\n\0b\0"),
        ("s/\\n/,/g", "a\nb\n", "a,b,"),
        ("a X", "a\0b", "a\0X\nb\0X\n"),
        ("$G", "a\0b", "a\0b\0\0"),
        ("=", "a\0b", "1\x00a\x002\x00b"),
        ("i X", "a\0b", "X\0a\0X\0b"),
        ("N;s/^b/B/M", "a\0b\0", "a\0B\0"),
        ("N;s/a$/A/M", "a\0b\0", "A\0b\0"),
        ("s/^a/A/Mg;s/y$/Y/M", "x\nay\nb\0", "x\nay\nb\0"),
        ("N;s/a.b/X/M", "a\0b\0", "a\0b\0"),
        ("s/a.b/X/M", "a\nb\0", "a\nb\0"),
        ("N;s/a[^x]b/X/M", "a\0b\0", "a\0b\0"),
        ("N;s/a.b/X/", "a\0b\0", "X\0"),
        ("N;s/a[^x]b/X/", "a\0b\0", "X\0"),
        ("N;s/^/>/Mg", "a\0b\0", ">a\0>b\0"),
        ("N;s/$/</Mg", "a\0b\0", "a<\0b<\0"),
        ("s/$/</Mg", "a\nb\0", "a\nb<\0"),
    ] {
        let run = with(script, data, json!({"null_data": true}));
        assert_eq!(
            (run.out.as_str(), run.err.as_str(), run.status),
            (want, "", 0),
            "{script}"
        );
    }
    let quiet = |script: &str, data: &str| {
        with(script, data, json!({"null_data": true, "quiet": true})).out
    };
    assert_eq!(quiet("l", "a\0b\0"), "a$\0b$\0");
    assert_eq!(quiet("l 5", "abcdefghij\0"), "abcd\\\0efgh\\\0ij$\0");
    assert_eq!(quiet("$p", "a\0b"), "b");
    assert_eq!(quiet("p;p", "a\0b"), "a\0a\0b\0b");
    let run = with("1q5", "a\0b\0", json!({"null_data": true}));
    assert_eq!((run.out.as_str(), run.status), ("a\0", 5));
}

#[test]
fn null_data_reads_and_writes_records_at_nul() {
    let z = json!({"null_data": true});
    for (body, want) in [
        ("r1\0r2\0", "a\0r1\0b\0r2\0"),
        ("r1\nr2\n", "a\0r1\nr2\nb\0"),
        ("r1", "a\0r1b\0"),
    ] {
        let run = files_run(
            "R rf",
            &["/in"],
            &[("/in", "a\0b\0"), ("rf", body)],
            z.clone(),
        );
        assert_eq!(run.out, want, "{body:?}");
    }
    let wrote = |script: &str, data: &str| {
        let run = files_run(script, &["/in"], &[("/in", data)], z.clone());
        String::from_utf8_lossy(&run.files["out"]).into_owned()
    };
    assert_eq!(wrote("w out", "a\0b\0"), "a\0b\0");
    assert_eq!(wrote("W out", "a\nb\0c\0"), "a\nb\0c\0");
    assert_eq!(wrote("s/a/X/w out", "a\0b\0"), "X\0");
    let run = files_run(
        "s/a/A/",
        &["/z"],
        &[("/z", "a\0b\0")],
        json!({"null_data": true, "in_place": true, "paths": ["/z"]}),
    );
    assert_eq!(run.files["/z"], b"A\0b\0");
}

fn refused_with(pieces: &[&str], extra: Json) -> (String, i32) {
    let mut config = json!({"pieces": expressions(pieces)});
    for (key, value) in extra.as_object().expect("an object") {
        config[key] = value.clone();
    }
    let run = run_host(config, Host::with(&[], "a\n"));
    (run.err, run.status)
}

#[test]
fn posix_refuses_what_sed_adds() {
    for (script, want) in [
        ("s/A/X/I", "char 7: unknown option to `s'"),
        ("s/a/b/i", "char 7: unknown option to `s'"),
        ("s/^a/X/M", "char 8: unknown option to `s'"),
        ("s/a/b/m", "char 7: unknown option to `s'"),
        ("s/a/b/e", "char 7: unknown option to `s'"),
        ("/A/Id", "char 4: unknown command: `I'"),
        ("/^x/Md", "char 5: unknown command: `M'"),
        ("0,/a/d", "char 6: invalid usage of line address 0"),
        ("1~2d", "char 2: unknown command: `~'"),
        ("1~0d", "char 2: unknown command: `~'"),
        ("1,+1d", "char 3: unexpected `,'"),
        ("1,~2d", "char 3: unexpected `,'"),
        ("/a/,+1{/b/d}", "char 5: unexpected `,'"),
        ("1a hello", "char 4: expected \\ after `a', `c' or `i'"),
        ("1i hello", "char 4: expected \\ after `a', `c' or `i'"),
        ("1c hello", "char 4: expected \\ after `a', `c' or `i'"),
        ("a\\", "char 2: incomplete command"),
        ("F", "char 1: unknown command: `F'"),
        ("1Q", "char 2: unknown command: `Q'"),
        ("1q5", "char 3: extra characters after command"),
        ("l 3", "char 3: extra characters after command"),
        ("R rf", "char 1: unknown command: `R'"),
        ("W /dev/stdout", "char 1: unknown command: `W'"),
        ("T", "char 1: unknown command: `T'"),
        ("v 4.2", "char 1: unknown command: `v'"),
        ("z", "char 1: unknown command: `z'"),
        ("e echo hi", "char 1: unknown command: `e'"),
        ("l;L", "char 3: unknown command: `L'"),
        ("y/a/b/;F", "char 8: unknown command: `F'"),
    ] {
        assert_eq!(
            refused_with(&[script], json!({"posix": true})),
            (format!("sed: -e expression #1, {want}\n"), 1),
            "{script}"
        );
    }
}

#[test]
fn posix_reads_escapes_and_ends_as_posix_does() {
    let posix = |script: &str, data: &str, extended: bool| {
        let run = with(script, data, json!({"posix": true, "extended": extended}));
        assert_eq!((run.err.as_str(), run.status), ("", 0), "{script}");
        run.out
    };
    for (script, data, want) in [
        ("s/a\\+/X/", "a+\n", "X\n"),
        ("s/a\\?/X/", "a?\n", "X\n"),
        ("s/a\\|b/X/", "a|b\n", "X\n"),
        ("s/\\w/X/", "w\n", "X\n"),
        ("s/\\</X/", "<a\n", "Xa\n"),
        ("s/\\bx/X/", "bx\n", "X\n"),
        ("s/\\`a/X/", "`a\n", "X\n"),
        ("s/[\\x61]/X/g", "ax\\1\n", "aXXX\n"),
        ("s/[\\n]/N/g", "nx\\\n", "NxN\n"),
        ("s/[\\t]/T/g", "tx\\\n", "TxT\n"),
        ("s/\\x2e/X/", "a.b\n", "X.b\n"),
        ("s/a/\\U&/", "ab\n", "Uab\n"),
        ("s/a/\\u&x/", "ab\n", "uaxb\n"),
        ("s/\\(a\\)\\{1,\\}b/X/", "ab\n", "X\n"),
        ("N;N", "a\nb\n", ""),
        ("N", "a\nb\nc\n", "a\nb\n"),
        ("$!N;P;D", "a\nb\nc\n", "a\nb\nc\n"),
        ("1{p;p}", "a\n", "a\na\na\n"),
        ("a\\\n  x", "a\n", "a\n  x\n"),
    ] {
        assert_eq!(posix(script, data, false), want, "{script}");
    }
    assert_eq!(posix("s/a{1,}/X/;s/\\w/W/", "aa\n", true), "X\n");
    assert_eq!(posix("s/\\<a/X/", "ab\n", true), "ab\n");
    assert_eq!(posix("s/[\\t]/X/", "tab\n", true), "Xab\n");
    assert_eq!(out("s/[\\x61]/X/g", "ax\\1\n"), "Xx\\1\n");
    assert_eq!(out("s/[\\n]/N/g", "nx\\\n"), "nx\\\n");
}

#[test]
fn sandbox_refuses_commands_that_reach_files() {
    for (script, want) in [
        ("w out", "#1, char 1"),
        ("r g", "#1, char 1"),
        ("e echo hi", "#1, char 1"),
        ("s/a/b/w out", "#1, char 7"),
        ("s/a/echo b/e", "#1, char 12"),
        ("R g", "#1, char 1"),
        ("W out", "#1, char 1"),
        ("1{p;w out\n}", "#1, char 5"),
    ] {
        assert_eq!(
            refused_with(&[script], json!({"sandbox": true})),
            (
                format!("sed: -e expression {want}: e/r/w commands disabled in sandbox mode\n"),
                1
            ),
            "{script}"
        );
    }
    assert_eq!(
        refused_with(&["1p", "w x"], json!({"sandbox": true})).0,
        "sed: -e expression #2, char 1: e/r/w commands disabled in sandbox mode\n"
    );
    assert_eq!(with("1p", "a\n", json!({"sandbox": true})).out, "a\na\n");
}

fn linked(files: &[(&str, &str)], links: &[(&str, &str)]) -> Host {
    let mut host = Host::with(files, "");
    host.links = links
        .iter()
        .map(|(name, target)| (name.to_string(), target.to_string()))
        .collect();
    host
}

fn edit(script: &str, operands: &[&str], host: Host, extra: Json) -> Run {
    let mut config = json!({
        "pieces": expressions(&[script]),
        "inputs": operands,
        "paths": operands,
        "in_place": true,
        "cwd": "/",
    });
    for (key, value) in extra.as_object().expect("an object") {
        config[key] = value.clone();
    }
    run_host(config, host)
}

fn file(run: &Run, name: &str) -> String {
    String::from_utf8_lossy(&run.files[name]).into_owned()
}

#[test]
fn a_suffix_keeps_each_file_before_its_edit() {
    let host = || Host::with(&[("/f", "a\nb\n"), ("/g", "x\n")], "");
    let run = edit("s/a/A/", &["/f", "/g"], host(), json!({"suffix": ".bak"}));
    assert_eq!((run.err.as_str(), run.status), ("", 0));
    assert_eq!(
        (file(&run, "/f"), file(&run, "/f.bak")),
        ("A\nb\n".into(), "a\nb\n".into())
    );
    assert_eq!(file(&run, "/g.bak"), "x\n");
    let run = edit("s/a/A/", &["/f"], host(), json!({"suffix": ""}));
    assert!(!run.files.contains_key("/f.bak"));
    let run = edit("s/a/A/", &["/f"], host(), json!({"suffix": "*"}));
    assert_eq!((run.files.len(), file(&run, "/f")), (2, "A\nb\n".into()));
    let run = edit("1q", &["/f", "/g"], host(), json!({"suffix": ".bak"}));
    assert_eq!(
        (file(&run, "/f"), file(&run, "/f.bak")),
        ("a\n".into(), "a\nb\n".into())
    );
    assert!(!run.files.contains_key("/g.bak"));
    let run = edit(
        "s/a/A/",
        &["d/f"],
        Host::with(&[("d/f", "a\n")], ""),
        json!({"suffix": "bak/*.o"}),
    );
    assert_eq!(file(&run, "bak/d/f.o"), "a\n");
}

#[test]
fn a_backup_that_cannot_be_kept_ends_the_run_unedited() {
    let run = edit(
        "s/a/A/",
        &["f", "g"],
        Host::with(&[("f", "a\n"), ("g", "a\n")], ""),
        json!({"suffix": "/missing/*"}),
    );
    assert_eq!(
        (run.err.as_str(), run.status),
        ("sed: cannot rename f: No such file or directory\n", 4)
    );
    assert_eq!(
        (file(&run, "f"), file(&run, "g")),
        ("a\n".into(), "a\n".into())
    );
    let mut host = Host::with(&[("/f", "a\n")], "");
    host.directories.push("/f.bak".into());
    let run = edit("s/a/A/", &["/f"], host, json!({"suffix": ".bak"}));
    assert_eq!(
        (run.err.as_str(), run.status, file(&run, "/f")),
        ("sed: cannot rename /f: Is a directory\n", 4, "a\n".into())
    );
}

#[test]
fn an_edit_replaces_a_link_unless_it_follows_it() {
    let host = || linked(&[("/f", "a\nb\n")], &[("/l", "f")]);
    let run = edit("s/a/A/", &["/l"], host(), json!({}));
    assert_eq!((run.err.as_str(), run.status), ("", 0));
    assert_eq!(
        (file(&run, "/l"), file(&run, "/f")),
        ("A\nb\n".into(), "a\nb\n".into())
    );
    assert!(run.links.is_empty());
    let run = edit("s/a/A/", &["/l"], host(), json!({"suffix": ".bak"}));
    assert_eq!(run.links["/l.bak"], "f");
    assert_eq!(
        (file(&run, "/l"), file(&run, "/f")),
        ("A\nb\n".into(), "a\nb\n".into())
    );
    let run = edit(
        "s/a/A/",
        &["/l"],
        host(),
        json!({"follow_symlinks": true, "suffix": ".bak"}),
    );
    assert_eq!((run.err.as_str(), run.status), ("", 0));
    assert_eq!(
        (file(&run, "/f"), file(&run, "/f.bak")),
        ("A\nb\n".into(), "a\nb\n".into())
    );
    assert_eq!(run.links["/l"], "f");
    assert!(!run.files.contains_key("/l"));
    // An edit that fails leaves the link it would have replaced.
    let run = edit("s//X/", &["/l"], host(), json!({"suffix": ".bak"}));
    assert_eq!(run.status, 1);
    assert_eq!(run.links["/l"], "f");
    assert!(!run.files.contains_key("/l") && !run.links.contains_key("/l.bak"));
}

fn follow(script: &str, operands: &[&str], host: Host) -> Run {
    run_host(
        json!({
            "pieces": expressions(&[script]),
            "inputs": operands,
            "cwd": "/",
            "follow_symlinks": true,
            "quiet": true,
        }),
        host,
    )
}

#[test]
fn following_names_each_input_as_its_links_lead() {
    let files = [("f", "a\nb\n"), ("/w/f", "w\n"), ("g", "x\n")];
    let run = follow(
        "F",
        &["l", "abs", "d/up", "-"],
        linked(&files, &[("l", "f"), ("abs", "/w/f"), ("d/up", "../f")]),
    );
    assert_eq!(
        (run.out.as_str(), run.err.as_str()),
        ("f\nf\n/w/f\nd/../f\nd/../f\n", "")
    );
    let run = follow("p", &["f", "l", "g"], linked(&files, &[("l", "nowhere")]));
    assert_eq!(
        (run.out.as_str(), run.err.as_str(), run.status),
        (
            "a\nb\n",
            "sed: couldn't readlink nowhere: No such file or directory\n",
            4
        )
    );
    let run = follow("$p", &["f", "l"], linked(&files, &[("l", "nowhere")]));
    assert_eq!((run.out.as_str(), run.status), ("", 4));
    let run = follow("p", &["missing", "f"], linked(&files, &[]));
    assert_eq!(
        (run.out.as_str(), run.err.as_str(), run.status),
        (
            "",
            "sed: couldn't readlink missing: No such file or directory\n",
            4
        )
    );
    let run = follow("p", &["l1"], linked(&files, &[("l1", "l2"), ("l2", "l1")]));
    assert_eq!(
        (run.err.as_str(), run.status),
        (
            "sed: couldn't follow symlink l1: Too many levels of symbolic links\n",
            4
        )
    );
    let chain = |count: usize| {
        let names: Vec<(String, String)> = (0..count)
            .map(|at| {
                let target = if at == 0 {
                    "f".into()
                } else {
                    format!("l{}", at - 1)
                };
                (format!("l{at}"), target)
            })
            .collect();
        let links: Vec<(&str, &str)> = names
            .iter()
            .map(|(n, t)| (n.as_str(), t.as_str()))
            .collect();
        follow("F", &[&format!("l{}", count - 1)], linked(&files, &links)).status
    };
    assert_eq!((chain(40), chain(41)), (0, 4));
}

#[test]
fn quitting_hands_standard_input_back_what_it_left() {
    let run = sed("1q", "one\ntwo\nthree\n");
    assert_eq!(
        (run.out.as_str(), run.stdin.as_str()),
        ("one\n", "two\nthree\n")
    );
    let run = run_host(
        json!({"pieces": expressions(&["2q"]), "quiet": true}),
        Host::with(&[], "one\ntwo\nthree\n"),
    );
    assert_eq!((run.out.as_str(), run.stdin.as_str()), ("", "three\n"));
    assert_eq!(sed("2d", "one\ntwo\nthree\n").stdin, "");
}

fn traced(script: &str, data: &str, extra: Json) -> String {
    let mut config = json!({"pieces": expressions(&[script]), "debug": true, "cwd": "/"});
    for (key, value) in extra.as_object().expect("an object") {
        config[key] = value.clone();
    }
    let run = run_host(config, Host::with(&[], data));
    assert_eq!(run.err, "", "{script}");
    run.out
}

#[test]
fn debug_lists_the_program_then_each_step() {
    let ab = "a\nb\n";
    for (script, data, want) in [
        (
            "s/a/X/",
            ab,
            "SED PROGRAM:\n  s/a/X/\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: s/a/X/\nMATCHED REGEX REGISTERS\n  regex[0] = 0-1 'a'\nPATTERN: X\nEND-OF-CYCLE:\nX\nINPUT:   'STDIN' line 2\nPATTERN: b\nCOMMAND: s/a/X/\nPATTERN: b\nEND-OF-CYCLE:\nb\n",
        ),
        (
            "$!N;P;D",
            ab,
            "SED PROGRAM:\n  $! N\n  P\n  D\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: $! N\nPATTERN: a\\nb\nCOMMAND: P\na\nCOMMAND: D\nPATTERN: b\nCOMMAND: $! N\nCOMMAND: P\nb\nCOMMAND: D\n",
        ),
        (
            "0,/a/{h;G;x;H;g}",
            ab,
            "SED PROGRAM:\n  0,/a/ {\n    h\n    G\n    x\n    H\n    g\n  }\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: 0,/a/ {\nCOMMAND:   h\nHOLD:    a\nCOMMAND:   G\nPATTERN: a\\na\nCOMMAND:   x\nPATTERN: a\nHOLD:    a\\na\nCOMMAND:   H\nHOLD:    a\\na\\na\nCOMMAND:   g\nHOLD:    a\\na\\na\nCOMMAND: }\nEND-OF-CYCLE:\na\na\na\nINPUT:   'STDIN' line 2\nPATTERN: b\nCOMMAND: 0,/a/ {\nCOMMAND: }\nEND-OF-CYCLE:\nb\n",
        ),
        (
            "1{b};p",
            ab,
            "SED PROGRAM:\n  1 {\n    b\n  }\n  p\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: 1 {\nCOMMAND:   b\nEND-OF-CYCLE:\na\nINPUT:   'STDIN' line 2\nPATTERN: b\nCOMMAND:   1 {\nCOMMAND:   }\nCOMMAND:   p\nb\nEND-OF-CYCLE:\nb\n",
        ),
        (
            "n;n",
            ab,
            "SED PROGRAM:\n  n\n  n\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: n\na\nPATTERN: b\nCOMMAND: n\nb\nEND-OF-CYCLE:\n",
        ),
        (
            "2Q3",
            ab,
            "SED PROGRAM:\n  2 Q 3\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: 2 Q 3\nEND-OF-CYCLE:\na\nINPUT:   'STDIN' line 2\nPATTERN: b\nCOMMAND: 2 Q 3\n",
        ),
        (
            "1q",
            ab,
            "SED PROGRAM:\n  1 q\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: 1 q\na\n",
        ),
        (
            "y/ba/xy/",
            "ab\n",
            "SED PROGRAM:\n  y/ab/yx/\nINPUT:   'STDIN' line 1\nPATTERN: ab\nCOMMAND: y/ab/yx/\nPATTERN: yx\nEND-OF-CYCLE:\nyx\n",
        ),
        (
            "s/\\(a\\)\\(b\\)*/[\\1&\\U\\2\\E\\l\\u\\n\\t]/",
            "ab\n",
            "SED PROGRAM:\n  s/\\\\(a\\\\)\\\\(b\\\\)*/[\\1&\\U\\2\\E\\l\\u\n\t]/\nINPUT:   'STDIN' line 1\nPATTERN: ab\nCOMMAND: s/\\\\(a\\\\)\\\\(b\\\\)*/[\\1&\\U\\2\\E\\l\\u\n\t]/\nMATCHED REGEX REGISTERS\n  regex[0] = 0-2 'ab'\n  regex[1] = 0-1 'a'\n  regex[2] = 1-2 'b'\nPATTERN: [aabB\\n\\t]\nEND-OF-CYCLE:\n[aabB\n\t]\n",
        ),
        (
            "1a hello",
            ab,
            "SED PROGRAM:\n  1 a\\hello\n\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: 1 a\\hello\n\nEND-OF-CYCLE:\na\nhello\nINPUT:   'STDIN' line 2\nPATTERN: b\nCOMMAND: 1 a\\hello\n\nEND-OF-CYCLE:\nb\n",
        ),
        (
            "2c\\\nC",
            ab,
            "SED PROGRAM:\n  2 c\\C\n\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: 2 c\\C\n\nEND-OF-CYCLE:\na\nINPUT:   'STDIN' line 2\nPATTERN: b\nCOMMAND: 2 c\\C\n\nC\nEND-OF-CYCLE:\n",
        ),
        (
            "s/a/b/pmIg3w out",
            "a\n",
            "SED PROGRAM:\n  s/a/b/imgp3wout\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: s/a/b/imgp3wout\nMATCHED REGEX REGISTERS\n  regex[0] = 0-1 'a'\nPATTERN: a\nEND-OF-CYCLE:\na\n",
        ),
        (
            "/a\\/b/p;\\%a%p;\\,x\\,y,p;!d;0~3d;$d;/a/I,/b/M!d",
            "",
            "SED PROGRAM:\n  /a\\/b/ p\n  /a/ p\n  /x,y/ p\n  !d\n  0~3 d\n  $ d\n  /a/I,/b/M! d\n",
        ),
        (
            "p",
            "a\t\x07\x08\\/\u{1b}\n",
            "SED PROGRAM:\n  p\nINPUT:   'STDIN' line 1\nPATTERN: a\\t\\a\\o010\\\\/\\o033\nCOMMAND: p\na\t\x07\x08\\/\u{1b}\nEND-OF-CYCLE:\na\t\x07\x08\\/\u{1b}\n",
        ),
        ("", "", "SED PROGRAM:\n"),
    ] {
        assert_eq!(traced(script, data, json!({})), want, "{script}");
    }
    assert_eq!(
        traced("s/a/b/", "a\0", json!({"null_data": true})),
        "SED PROGRAM:\n  s/a/b/\nINPUT:   'STDIN' line 1\nPATTERN: a\nCOMMAND: s/a/b/\nMATCHED REGEX REGISTERS\n  regex[0] = 0-1 'a'\nPATTERN: b\nEND-OF-CYCLE:\nb\0"
    );
    let run = edit(
        "s/a/b/",
        &["/f"],
        Host::with(&[("/f", "a\n")], ""),
        json!({"debug": true}),
    );
    assert_eq!(
        (run.out.as_str(), file(&run, "/f")),
        (
            "SED PROGRAM:\n  s/a/b/\nINPUT:   '/f' line 1\nPATTERN: a\nCOMMAND: s/a/b/\nMATCHED REGEX REGISTERS\n  regex[0] = 0-1 'a'\nPATTERN: b\nEND-OF-CYCLE:\n",
            "b\n".into()
        )
    );
}

#[test]
fn a_byte_y_names_twice_takes_the_last() {
    assert_eq!(out("y/aa/ab/", "a\n"), "b\n");
    let run = run_host(
        json!({"pieces": expressions(&["y/\u{e9}\u{e9}/ab/"]), "utf8": true}),
        Host::with(&[], "\u{e9}\n"),
    );
    assert_eq!(run.out, "a\n");
}
