use super::apply::{is_tried, search};
use crate::host::Host;

const POEM: &str = "roses are red\nviolets are blue\nsugar is sweet\n";
const POEM_DIFF: &str = "--- a/poem.txt\n+++ b/poem.txt\n@@ -1,3 +1,3 @@\n roses are red\n-violets are blue\n+violets are dark\n sugar is sweet\n";

fn seq(n: usize) -> String {
    (1..=n).map(|k| format!("{k}\n")).collect()
}

fn patch(host: &mut Host, options: &str) -> (i32, String, String) {
    let defaults = r#"{"strip": 0, "reverse": false, "forward": false, "file": null}"#;
    let config = crate::config(defaults, options);
    let mut stream = crate::open("patch", config.as_bytes()).expect("opens");
    let status = host.drive(stream.as_mut());
    let out = String::from_utf8_lossy(&std::mem::take(&mut host.out)).into_owned();
    let err = String::from_utf8_lossy(&std::mem::take(&mut host.err)).into_owned();
    (status, out, err)
}

fn file(host: &Host, name: &str) -> Option<String> {
    host.files
        .get(name)
        .map(|data| String::from_utf8_lossy(data).into_owned())
}

#[test]
fn a_matching_patch_applies_quietly() {
    let mut host = Host::with(&[("poem.txt", POEM)], POEM_DIFF);
    let (status, out, err) = patch(&mut host, r#"{"strip": 1}"#);
    assert_eq!(
        (status, out.as_str(), err.as_str()),
        (0, "patching file poem.txt\n", "")
    );
    let dark = "roses are red\nviolets are dark\nsugar is sweet\n";
    assert_eq!(file(&host, "poem.txt").as_deref(), Some(dark));
    assert!(!host.files.contains_key("poem.txt.orig"));
}

#[test]
fn offsets_and_fuzz_are_reported_and_backed_up() {
    let cases = [
        (
            "@@ -8,3 +8,3 @@\n 6\n-7\n+seven\n 8\n",
            "Hunk #1 succeeded at 6 (offset -2 lines).\n",
        ),
        (
            "@@ -5,7 +5,7 @@\n X\n 6\n 7\n-8\n+eight\n 9\n 10\n Y\n",
            "Hunk #1 succeeded at 5 with fuzz 1.\n",
        ),
        (
            "@@ -2,7 +2,7 @@\n X\n 6\n 7\n-8\n+eight\n 9\n 10\n Y\n",
            "Hunk #1 succeeded at 5 with fuzz 1 (offset 3 lines).\n",
        ),
        (
            "@@ -5,7 +5,7 @@\n X\n Z\n 7\n-8\n+eight\n 9\n W\n Y\n",
            "Hunk #1 succeeded at 5 with fuzz 2.\n",
        ),
    ];
    for (hunk, note) in cases {
        let diff = format!("--- n.txt\n+++ n.txt\n{hunk}");
        let mut host = Host::with(&[("n.txt", &seq(20))], &diff);
        let (status, out, _) = patch(&mut host, r#"{"file": "n.txt"}"#);
        assert_eq!((status, out), (0, format!("patching file n.txt\n{note}")));
        assert_eq!(file(&host, "n.txt.orig"), Some(seq(20)));
    }
}

#[test]
fn a_one_line_offset_is_singular() {
    let diff = "--- e.txt\n+++ e.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n";
    let mut host = Host::with(&[("e.txt", "x\na\nb\nc\n")], diff);
    let (_, out, _) = patch(&mut host, "{}");
    assert_eq!(
        out,
        "patching file e.txt\nHunk #1 succeeded at 2 with fuzz 1 (offset 1 line).\n"
    );
}

#[test]
fn a_rejected_hunk_moves_by_what_placed_hunks_added() {
    let diff = "--- n.txt\t2020-01-01 00:00:00\n+++ n.txt\t2020-01-02 00:00:00\n@@ -2,2 +2,4 @@\n 2\n+a\n+b\n 3\n@@ -10,3 +12,3 @@ func\n 10\n-zz\n+11\n 12\n";
    let mut host = Host::with(&[("n.txt", &seq(20))], diff);
    let (status, out, _) = patch(&mut host, "{}");
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "patching file n.txt\nHunk #2 FAILED at 12.\n1 out of 2 hunks FAILED -- saving rejects to file n.txt.rej\n"
    );
    assert_eq!(
        file(&host, "n.txt.rej").as_deref(),
        Some(
            "--- n.txt\t2020-01-01 00:00:00\n+++ n.txt\t2020-01-02 00:00:00\n@@ -12,3 +14,3 @@ func\n 10\n-zz\n+11\n 12\n"
        )
    );
}

#[test]
fn a_reject_lists_each_change_run_removed_lines_first() {
    let diff = "--- n.txt\n+++ n.txt\n@@ -2,6 +2,6 @@\n 2\n-x3\n+X3\n 4\n+X5\n-x5\n+X6\n-x6\n 7\n";
    let mut host = Host::with(&[("n.txt", &seq(20))], diff);
    patch(&mut host, "{}");
    assert_eq!(
        file(&host, "n.txt.rej").as_deref(),
        Some("--- n.txt\n+++ n.txt\n@@ -2,6 +2,6 @@\n 2\n-x3\n+X3\n 4\n-x5\n-x6\n+X5\n+X6\n 7\n")
    );
}

#[test]
fn a_patch_already_applied_is_skipped() {
    let dark = "roses are red\nviolets are dark\nsugar is sweet\n";
    let rejects = "--- poem.txt\n+++ poem.txt\n@@ -1,3 +1,3 @@\n roses are red\n-violets are blue\n+violets are dark\n sugar is sweet\n";
    let mut host = Host::with(&[("poem.txt", dark)], POEM_DIFF);
    let (status, out, _) = patch(&mut host, r#"{"strip": 1}"#);
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "patching file poem.txt\nReversed (or previously applied) patch detected!  Assume -R? [n] \nApply anyway? [n] \nSkipping patch.\n1 out of 1 hunk ignored -- saving rejects to file poem.txt.rej\n"
    );
    assert_eq!(file(&host, "poem.txt.rej").as_deref(), Some(rejects));
    assert_eq!(file(&host, "poem.txt").as_deref(), Some(dark));
    let mut host = Host::with(&[("poem.txt", dark)], POEM_DIFF);
    let (status, out, _) = patch(&mut host, r#"{"strip": 1, "forward": true}"#);
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "patching file poem.txt\nReversed (or previously applied) patch detected!  Skipping patch.\n1 out of 1 hunk ignored -- saving rejects to file poem.txt.rej\n"
    );
}

#[test]
fn reverse_undoes_and_refuses_a_patch_not_applied() {
    let dark = "roses are red\nviolets are dark\nsugar is sweet\n";
    let mut host = Host::with(&[("poem.txt", dark)], POEM_DIFF);
    let (status, _, _) = patch(&mut host, r#"{"strip": 1, "reverse": true}"#);
    assert_eq!(
        (status, file(&host, "poem.txt").as_deref()),
        (0, Some(POEM))
    );
    let mut host = Host::with(&[("poem.txt", POEM)], POEM_DIFF);
    let (status, out, _) = patch(
        &mut host,
        r#"{"strip": 1, "reverse": true, "forward": true}"#,
    );
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "patching file poem.txt\nUnreversed patch detected!  Skipping patch.\n1 out of 1 hunk ignored -- saving rejects to file poem.txt.rej\n"
    );
    assert_eq!(
        file(&host, "poem.txt.rej").as_deref(),
        Some(
            "--- poem.txt\n+++ poem.txt\n@@ -1,3 +1,3 @@\n roses are red\n-violets are dark\n+violets are blue\n sugar is sweet\n"
        )
    );
}

#[test]
fn reverse_swaps_the_reject_names() {
    let diff = "--- old/e.txt\t2020\n+++ new/e.txt\t2021\n@@ -1 +1 @@\n-y\n+z\n";
    let mut host = Host::with(&[("e.txt", "x\n")], diff);
    let (status, _, _) = patch(&mut host, r#"{"strip": 1, "reverse": true}"#);
    assert_eq!(status, 1);
    assert_eq!(
        file(&host, "e.txt.rej").as_deref(),
        Some("--- e.txt\t2021\n+++ e.txt\t2020\n@@ -1 +1 @@\n-z\n+y\n")
    );
}

#[test]
fn a_directory_is_refused_whole() {
    let diff = "--- a/sub\n+++ b/sub\n@@ -1 +1 @@\n-a\n+b\n";
    let mut host = Host::with(&[], diff);
    host.directories.push("sub".to_owned());
    let (status, out, _) = patch(&mut host, r#"{"strip": 1}"#);
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "File sub is not a regular file -- refusing to patch\n1 out of 1 hunk ignored -- saving rejects to file sub.rej\n"
    );
    assert_eq!(
        file(&host, "sub.rej").as_deref(),
        Some("--- sub\n+++ sub\n@@ -1 +1 @@\n-a\n+b\n")
    );
}

#[test]
fn a_missing_file_is_made_only_by_a_patch_that_creates_it() {
    let diff = "--- /dev/null\n+++ b/d/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n";
    let mut host = Host::with(&[], diff);
    let (status, out, _) = patch(&mut host, r#"{"strip": 1}"#);
    assert_eq!((status, out.as_str()), (0, "patching file d/new.txt\n"));
    assert_eq!(file(&host, "d/new.txt").as_deref(), Some("one\ntwo\n"));
    assert_eq!(host.directories, ["d"]);
    let diff = "x\n--- a/gone.txt\n+++ b/gone.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n";
    let mut host = Host::with(&[], diff);
    let (status, out, _) = patch(&mut host, r#"{"strip": 1}"#);
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "can't find file to patch at input line 4\nPerhaps you used the wrong -p or --strip option?\nThe text leading up to this was:\n--------------------------\n|x\n|--- a/gone.txt\n|+++ b/gone.txt\n--------------------------\nFile to patch: \nSkip this patch? [y] \nSkipping patch.\n1 out of 1 hunk ignored\n"
    );
    assert!(host.files.is_empty());
}

#[test]
fn a_patch_that_empties_a_file_deletes_it_and_the_directories_it_empties() {
    let diff = "--- a/d/e/f.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n";
    let mut host = Host::with(&[("d/e/f.txt", "a\n"), ("d/s.txt", "s\n")], diff);
    host.directories = vec!["d".to_owned(), "d/e".to_owned()];
    let (status, out, _) = patch(&mut host, r#"{"strip": 1}"#);
    assert_eq!((status, out.as_str()), (0, "patching file d/e/f.txt\n"));
    assert_eq!(host.directories, ["d"]);
    assert!(!host.files.contains_key("d/e/f.txt"));
}

#[test]
fn a_patch_that_cannot_be_read_ends_the_run() {
    let mut host = Host::with(&[], "");
    host.faults.insert(
        "-".to_owned(),
        crate::host::Fault {
            after: 0,
            errno: "EIO",
            text: "Input/output error",
        },
    );
    let (status, out, err) = patch(&mut host, "{}");
    assert_eq!((status, out.as_str()), (2, ""));
    assert_eq!(err, "patch: **** read error : Input/output error\n");
}

#[test]
fn a_failed_write_ends_the_run() {
    let diff = "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n";
    let mut host = Host::with(&[], diff);
    let (status, out, err) = patch(&mut host, r#"{"file": "/denied/x"}"#);
    assert_eq!(status, 1);
    assert!(
        out.ends_with("saving rejects to file /denied/x.rej\n"),
        "{out}"
    );
    assert_eq!(err, "patch: /denied/x.rej: Permission denied\n");
}

#[test]
fn an_end_held_hunk_is_found_after_a_long_prefix() {
    let mut text: String = (0..100_000).map(|k| format!("p{k}\n")).collect();
    text += "a\nb\nc\nd\n";
    let diff = "--- f\n+++ f\n@@ -1,4 +1,4 @@\n a\n b\n c\n-d\n+D\n";
    let mut host = Host::with(&[("f", &text)], diff);
    let (status, out, _) = patch(&mut host, "{}");
    assert_eq!(
        (status, out.as_str()),
        (
            0,
            "patching file f\nHunk #1 succeeded at 100001 (offset 100000 lines).\n"
        )
    );
    let diff = "--- f\n+++ f\n@@ -1,4 +1,4 @@\n-x\n+X\n a\n b\n c\n";
    let text: String = (0..1000).map(|k| format!("p{k}\nx\na\nb\nc\n")).collect();
    let mut host = Host::with(&[("f", &text)], diff);
    let (status, out, _) = patch(&mut host, "{}");
    assert_eq!(status, 1);
    assert!(out.contains("Hunk #1 FAILED at 1."), "{out}");
}

#[test]
fn the_search_knows_every_line_it_reaches() {
    for expected in -6..12 {
        for used in 0..8 {
            for last in -3..12 {
                let mut reached = Vec::new();
                search(expected, used, last, |at| {
                    reached.push(at);
                    false
                });
                for at in -14..16 {
                    assert_eq!(
                        is_tried(at, expected, used, last),
                        reached.contains(&at),
                        "{at} {expected} {used} {last}"
                    );
                }
            }
        }
    }
}
