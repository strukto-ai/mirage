use super::apply::{is_tried, search};
use crate::host::Host;

const POEM: &str = "roses are red\nviolets are blue\nsugar is sweet\n";
const POEM_DIFF: &str = "--- a/poem.txt\n+++ b/poem.txt\n@@ -1,3 +1,3 @@\n roses are red\n-violets are blue\n+violets are dark\n sugar is sweet\n";

fn seq(n: usize) -> String {
    (1..=n).map(|k| format!("{k}\n")).collect()
}

fn patch(host: &mut Host, options: &str) -> (i32, String, String) {
    let defaults =
        r#"{"strip": "0", "reverse": false, "forward": false, "file": null, "dry_run": false}"#;
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
    let (status, out, err) = patch(&mut host, r#"{"strip": "1"}"#);
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
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "patching file poem.txt\nReversed (or previously applied) patch detected!  Assume -R? [n] \nApply anyway? [n] \nSkipping patch.\n1 out of 1 hunk ignored -- saving rejects to file poem.txt.rej\n"
    );
    assert_eq!(file(&host, "poem.txt.rej").as_deref(), Some(rejects));
    assert_eq!(file(&host, "poem.txt").as_deref(), Some(dark));
    let mut host = Host::with(&[("poem.txt", dark)], POEM_DIFF);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1", "forward": true}"#);
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
    let (status, _, _) = patch(&mut host, r#"{"strip": "1", "reverse": true}"#);
    assert_eq!(
        (status, file(&host, "poem.txt").as_deref()),
        (0, Some(POEM))
    );
    let mut host = Host::with(&[("poem.txt", POEM)], POEM_DIFF);
    let (status, out, _) = patch(
        &mut host,
        r#"{"strip": "1", "reverse": true, "forward": true}"#,
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
    let (status, _, _) = patch(&mut host, r#"{"strip": "1", "reverse": true}"#);
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
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
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
fn a_link_is_refused_whole_even_by_a_deletion() {
    let diff = "--- link\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n";
    let mut host = Host::with(&[("link", "a\n")], diff);
    host.faults.insert(
        "link".to_owned(),
        crate::host::Fault {
            after: 0,
            errno: "ELOOP",
            text: "Too many levels of symbolic links",
        },
    );
    let (status, out, _) = patch(&mut host, "{}");
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "File link is not a regular file -- refusing to patch\n1 out of 1 hunk ignored -- saving rejects to file link.rej\n"
    );
    assert_eq!(file(&host, "link").as_deref(), Some("a\n"));
}

#[test]
fn a_missing_file_is_made_only_by_a_patch_that_creates_it() {
    let diff = "--- /dev/null\n+++ b/d/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n";
    let mut host = Host::with(&[], diff);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!((status, out.as_str()), (0, "patching file d/new.txt\n"));
    assert_eq!(file(&host, "d/new.txt").as_deref(), Some("one\ntwo\n"));
    assert_eq!(host.directories, ["d"]);
    let diff = "x\n--- a/gone.txt\n+++ b/gone.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n";
    let mut host = Host::with(&[], diff);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
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
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
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

#[test]
fn a_dry_run_checks_each_file_and_writes_nothing() {
    let cases = [
        (POEM_DIFF, 0, "checking file poem.txt\n"),
        (
            "--- a/poem.txt\n+++ b/poem.txt\n@@ -1,3 +1,3 @@\n-x\n+y\n z\n w\n",
            1,
            "checking file poem.txt\nHunk #1 FAILED at 1.\n1 out of 1 hunk FAILED\n",
        ),
        (
            "--- /dev/null\n+++ b/new/n\n@@ -0,0 +1 @@\n+x\n",
            0,
            "checking file new/n\n",
        ),
        (
            "--- a/poem.txt\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-roses are red\n-violets are blue\n-sugar is sweet\n",
            0,
            "checking file poem.txt\n",
        ),
    ];
    for (diff, code, report) in cases {
        let mut host = Host::with(&[("poem.txt", POEM)], diff);
        let (status, out, _) = patch(&mut host, r#"{"strip": "1", "dry_run": true}"#);
        assert_eq!((status, out.as_str()), (code, report), "{diff}");
        assert_eq!(host.files.len(), 1, "{diff}");
        assert_eq!(file(&host, "poem.txt").as_deref(), Some(POEM));
        assert!(host.directories.is_empty());
    }
}

#[test]
fn git_moves_read_their_diff_line_refuse_dangerous_names_and_keep_modes() {
    // The diff --git line names a move; its rename lines do not.
    let differ =
        "diff --git a/src b/dst\nsimilarity index 100%\nrename from src\nrename to ../outside\n";
    let mut host = Host::with(&[("src", "hi\n")], differ);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(
        (status, out.as_str()),
        (0, "patching file dst (renamed from src)\n")
    );
    let doubled =
        "diff --git a/src b//abs/out\nsimilarity index 100%\ncopy from src\ncopy to /abs/out\n";
    let mut host = Host::with(&[("src", "hi\n")], doubled);
    let (_, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(out, "patching file abs/out (copied from src)\n");
    let cannot = "Cannot rename file without two valid file names\n";
    let spaced = "diff --git a/x y b/z\nsimilarity index 100%\nrename from x y\nrename to z\n";
    let mut host = Host::with(&[("x y", "hi\n")], spaced);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(
        (status, out.as_str()),
        (1, cannot),
        "a blank in a name leaves the line no names"
    );
    // A dangerous target is said of, a dangerous source is not, and the
    // hunks after either are ignored.
    let hunk = "--- a/src\n+++ b/dst\n@@ -1 +1 @@\n-hi\n+ho\n";
    for (header, said) in [
        (
            "diff --git a/src b/../outside\nsimilarity index 90%\n",
            "Ignoring potentially dangerous file name ../outside\n",
        ),
        ("diff --git a/../src b/dst\nsimilarity index 90%\n", ""),
        ("diff --git a/../a b/../b\nsimilarity index 90%\n", ""),
    ] {
        let diff = format!("{header}rename from x\nrename to y\n{hunk}");
        let mut host = Host::with(&[("src", "hi\n"), ("../src", "hi\n")], &diff);
        let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
        let expected = format!("{said}{cannot}1 out of 1 hunk ignored\n");
        assert_eq!((status, out.as_str()), (1, expected.as_str()), "{header}");
        assert_eq!(file(&host, "src").as_deref(), Some("hi\n"));
    }
    let missing = format!(
        "diff --git a/gone b/dst\nsimilarity index 90%\nrename from gone\nrename to dst\n{hunk}"
    );
    let mut host = Host::with(&[], &missing);
    let (_, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(out, format!("{cannot}1 out of 1 hunk ignored\n"));

    // The target keeps the source's mode, through the hunks after it too.
    let rename = "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n";
    let mut host = Host::with(&[("old", "x\n")], rename);
    host.modes.insert("old".into(), 0o755);
    patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(host.modes.get("new"), Some(&0o755));
    let copy = "diff --git a/old b/new\nsimilarity index 90%\ncopy from old\ncopy to new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-x\n+y\n";
    let mut host = Host::with(&[("old", "x\n")], copy);
    host.modes.insert("old".into(), 0o751);
    let (_, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(out, "patching file new (copied from old)\n");
    assert_eq!(host.modes.get("new"), Some(&0o751));
    assert_eq!(file(&host, "new").as_deref(), Some("y\n"));

    // An ORIGFILE stands in for the source.
    let edited = copy.replace("copy", "rename");
    let mut host = Host::with(&[("old", "x\n"), ("target", "x\n")], &edited);
    let (_, out, _) = patch(&mut host, r#"{"strip": "1", "file": "target"}"#);
    assert_eq!(out, "patching file new (renamed from target)\n");
    assert_eq!(file(&host, "new").as_deref(), Some("y\n"));
    assert_eq!(file(&host, "old").as_deref(), Some("x\n"));
    assert!(!host.files.contains_key("target"));
}

#[test]
fn git_headers_move_files_set_modes_and_refuse_binary_patches() {
    let rename =
        "diff --git a/old b/renamed\nsimilarity index 100%\nrename from old\nrename to renamed\n";
    let mut host = Host::with(&[("old", "one\n")], rename);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(
        (status, out.as_str()),
        (0, "patching file renamed (renamed from old)\n")
    );
    assert_eq!(file(&host, "renamed").as_deref(), Some("one\n"));
    assert!(!host.files.contains_key("old"));
    // Taken as done once the target stands, the other way round too.
    host.stdin = rename.as_bytes().to_vec();
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(
        (status, out.as_str()),
        (0, "patching file renamed (already renamed from old)\n")
    );
    host.stdin = rename.as_bytes().to_vec();
    let (_, out, _) = patch(&mut host, r#"{"strip": "1", "reverse": true}"#);
    assert_eq!(out, "patching file old (renamed from renamed)\n");
    let mut host = Host::with(&[], rename);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(
        (status, out.as_str()),
        (1, "Cannot rename file without two valid file names\n")
    );

    let edited = "diff --git a/old b/renamed\nsimilarity index 50%\nrename from old\nrename to renamed\nindex 1..2 100644\n--- a/old\n+++ b/renamed\n@@ -1 +1 @@\n-one\n+two\n";
    let mut host = Host::with(&[("old", "one\n")], edited);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(
        (status, out.as_str()),
        (0, "patching file renamed (renamed from old)\n")
    );
    assert_eq!(file(&host, "renamed").as_deref(), Some("two\n"));

    let copy = "diff --git a/old b/other\nsimilarity index 100%\ncopy from old\ncopy to other\n";
    let mut host = Host::with(&[("old", "one\n"), ("other", "x\n")], copy);
    let (_, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(out, "patching file other (copied from old)\n");
    assert_eq!(file(&host, "other").as_deref(), Some("one\n"));
    assert_eq!(file(&host, "old").as_deref(), Some("one\n"));

    let modes = "diff --git a/f b/f\nold mode 100644\nnew mode 100755\n";
    let mut host = Host::with(&[("f", "a\n")], modes);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!((status, out.as_str()), (0, "patching file f\n"));
    assert_eq!(host.modes.get("f"), Some(&0o755));
    host.stdin = modes.as_bytes().to_vec();
    let (_, out, _) = patch(&mut host, r#"{"strip": "1", "dry_run": true}"#);
    assert_eq!(out, "checking file f\n");
    let mut host = Host::with(&[], modes);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(status, 1);
    assert!(
        out.starts_with("can't find file to patch at input line 3\n"),
        "{out}"
    );
    assert!(out.ends_with("Skipping patch.\n"), "{out}");

    let empty = "diff --git a/new b/new\nnew file mode 100755\nindex 0000000..e69de29\n";
    let mut host = Host::with(&[], empty);
    let (_, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(out, "patching file new\n");
    assert_eq!(file(&host, "new").as_deref(), Some(""));
    assert_eq!(host.modes.get("new"), Some(&0o755));
    let gone = "diff --git a/f b/f\ndeleted file mode 100644\nindex e69de29..0000000\n";
    let mut host = Host::with(&[("f", "")], gone);
    let (_, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(out, "patching file f\n");
    assert!(!host.files.contains_key("f"));

    let binary =
        "diff --git a/f b/f\nindex 1234567..89abcde\nGIT binary patch\nliteral 1\nIcmZ?d00001\n\n";
    let mut host = Host::with(&[("f", "a\n")], binary);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!(
        (status, out.as_str()),
        (1, "File f: git binary diffs are not supported.\n")
    );
    let differ =
        "diff --git a/f b/f\nindex 1234567..89abcde 100644\nBinary files a/f and b/f differ\n";
    let mut host = Host::with(&[("f", "a\n")], differ);
    let (status, out, _) = patch(&mut host, r#"{"strip": "1"}"#);
    assert_eq!((status, out.as_str()), (0, "patching file f\n"));
    assert_eq!(file(&host, "f").as_deref(), Some("a\n"));
}

#[test]
fn a_strip_count_is_refused_in_patch_words_with_exit_2() {
    let refused = |typed: &str| {
        let config = serde_json::json!({ "strip": typed }).to_string();
        crate::open("patch", config.as_bytes())
            .err()
            .map(|e| (e.message, e.status))
    };
    for (typed, said) in [
        ("x", "patch: **** strip count x is not a number"),
        ("3x", "patch: **** strip count 3x is not a number"),
        (" 1", "patch: **** strip count ' 1' is not a number"),
        (" +1", "patch: **** strip count ' +1' is not a number"),
        ("", "patch: **** strip count '' is not a number"),
        ("-2", "patch: **** strip count -2 is negative"),
    ] {
        assert_eq!(refused(typed), Some((said.to_owned(), 2)), "{typed:?}");
    }
    for typed in ["+0", "-0", "99999999999999999999999"] {
        assert_eq!(refused(typed), None, "{typed:?}");
    }
}

const TWO_FILES: &str = "--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n--- g\n+++ g\n@@ -1 +1 @@\n-b\n+B\n";

#[test]
fn an_output_file_holds_every_section_in_order() {
    let mut host = Host::with(&[("f", "a\n"), ("g", "b\n")], TWO_FILES);
    let (status, out, err) = patch(&mut host, r#"{"output": "out"}"#);
    assert_eq!((status, err.as_str()), (0, ""));
    let names = "patching file out (read from f)\npatching file out (read from g)\n";
    assert_eq!(out, names);
    assert_eq!(file(&host, "out").as_deref(), Some("A\nB\n"));
    assert_eq!(file(&host, "f").as_deref(), Some("a\n"));
}

#[test]
fn an_output_file_is_emptied_before_the_patch_is_read() {
    let mut host = Host::with(&[("out", "OLD\n")], "hello\n");
    let (status, _, err) = patch(&mut host, r#"{"output": "out"}"#);
    assert_eq!(status, 2);
    assert_eq!(
        err,
        "patch: **** Only garbage was found in the patch input.\n"
    );
    assert_eq!(file(&host, "out").as_deref(), Some(""));
}

#[test]
fn an_output_file_that_will_not_open_stops_the_run_first() {
    let mut host = Host::with(&[("f", "a\n"), ("g", "b\n")], TWO_FILES);
    let (status, out, err) = patch(&mut host, r#"{"output": "/missing/out"}"#);
    assert_eq!((status, out.as_str()), (2, ""));
    let refused = "patch: **** Can't create file /missing/out : No such file or directory\n";
    assert_eq!(err, refused);
}

#[test]
fn a_dry_run_still_writes_its_output_file() {
    let mut host = Host::with(&[("f", "a\n"), ("g", "b\n")], TWO_FILES);
    let (status, out, _) = patch(&mut host, r#"{"output": "out", "dry_run": true}"#);
    assert_eq!(status, 0);
    assert!(
        out.starts_with("checking file out (read from f)\n"),
        "{out}"
    );
    assert_eq!(file(&host, "out").as_deref(), Some("A\nB\n"));
}

#[test]
fn an_output_over_its_own_input_reads_it_emptied() {
    let diff = "--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n";
    let mut host = Host::with(&[("f", "a\n")], diff);
    let (status, out, _) = patch(&mut host, r#"{"output": "f"}"#);
    assert_eq!(status, 1);
    assert!(
        out.starts_with("patching file f\nHunk #1 FAILED at 1.\n"),
        "{out}"
    );
    assert_eq!(file(&host, "f").as_deref(), Some(""));
}

#[test]
fn a_backup_takes_the_name_its_options_ask_for() {
    let diff = "--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n";
    let cases = [
        (r#"{"backup": true}"#, "f.orig"),
        (r#"{"backup": true, "suffix": ".bak"}"#, "f.bak"),
        (
            r#"{"backup": true, "prefix": "p_", "suffix": ".s"}"#,
            "p_f.s",
        ),
        (r#"{"backup": true, "version": "numbered"}"#, "f.~1~"),
        (r#"{"backup": true, "version": "existing"}"#, "f.orig"),
    ];
    for (options, name) in cases {
        let mut host = Host::with(&[("f", "a\n")], diff);
        let (status, ..) = patch(&mut host, options);
        assert_eq!(status, 0, "{options}");
        assert_eq!(file(&host, name).as_deref(), Some("a\n"), "{options}");
    }
    let mut host = Host::with(&[("f", "a\n"), ("f.~3~", "old\n")], diff);
    assert_eq!(
        patch(&mut host, r#"{"backup": true, "version": "existing"}"#).0,
        0
    );
    assert_eq!(file(&host, "f.~4~").as_deref(), Some("a\n"));
}

#[test]
fn loose_whitespace_finds_a_hunk_exact_matching_misses() {
    let diff = "--- f\n+++ f\n@@ -1 +1 @@\n-a  b\n+C\n";
    let mut host = Host::with(&[("f", "a b\n")], diff);
    assert_eq!(patch(&mut host, "{}").0, 1);
    let mut host = Host::with(&[("f", "a b\n")], diff);
    assert_eq!(patch(&mut host, r#"{"whitespace": true}"#).0, 0);
    assert_eq!(file(&host, "f").as_deref(), Some("C\n"));
}

#[test]
fn a_fuzz_of_zero_refuses_what_the_default_takes() {
    let hunk = "--- n.txt\n+++ n.txt\n@@ -5,7 +5,7 @@\n X\n 6\n 7\n-8\n+eight\n 9\n 10\n Y\n";
    let mut host = Host::with(&[("n.txt", &seq(20))], hunk);
    assert_eq!(patch(&mut host, r#"{"fuzz": "0"}"#).0, 1);
    assert_eq!(file(&host, "n.txt"), Some(seq(20)));
}

#[test]
fn an_emptied_file_goes_under_remove_empty() {
    let diff = "--- f\n+++ f\n@@ -1 +0,0 @@\n-a\n";
    let mut host = Host::with(&[("f", "a\n")], diff);
    assert_eq!(patch(&mut host, r#"{"remove_empty": true}"#).0, 0);
    assert_eq!(file(&host, "f"), None);
}

#[test]
fn silent_keeps_the_report_and_not_the_failure() {
    let diff = "--- f\n+++ f\n@@ -1 +1 @@\n-z\n+A\n";
    let mut host = Host::with(&[("f", "a\n")], diff);
    let (status, out, _) = patch(&mut host, r#"{"silent": true, "force": true}"#);
    assert_eq!(status, 1);
    assert_eq!(
        out,
        "1 out of 1 hunk FAILED -- saving rejects to file f.rej\n"
    );
}

#[test]
fn a_named_reject_file_takes_the_failed_hunks() {
    let diff = "--- f\n+++ f\n@@ -1 +1 @@\n-z\n+A\n";
    let mut host = Host::with(&[("f", "a\n")], diff);
    assert_eq!(patch(&mut host, r#"{"reject": "r", "force": true}"#).0, 1);
    assert!(file(&host, "r").expect("written").contains("-z\n"));
    assert_eq!(file(&host, "f.rej"), None);
    let mut host = Host::with(&[("f", "a\n")], diff);
    let (status, _, err) = patch(&mut host, r#"{"reject": "/missing/r", "force": true}"#);
    assert_eq!(status, 2);
    let refused = "patch: **** Can't create file /missing/r : No such file or directory\n";
    assert_eq!(err, refused);
}

const APPLIED: &str = "--- f\n+++ f\n@@ -1,3 +1,3 @@\n a\n-b\n+X\n c\n";

#[test]
fn batch_mode_does_not_undo_what_forward_skips() {
    let mut host = Host::with(&[("f", "a\nX\nc\n")], APPLIED);
    let (status, out, _) = patch(&mut host, r#"{"batch": true, "forward": true}"#);
    assert_eq!(status, 1);
    assert!(
        out.contains("Reversed (or previously applied) patch detected!  Skipping patch.\n"),
        "{out}"
    );
    assert_eq!(file(&host, "f").as_deref(), Some("a\nX\nc\n"));
}

#[test]
fn a_huge_fuzz_costs_no_more_than_the_context_it_can_drop() {
    let mut host = Host::with(&[("f", "a\nb\nc\n")], APPLIED);
    assert_eq!(patch(&mut host, r#"{"fuzz": "9223372036854775807"}"#).0, 0);
    assert_eq!(file(&host, "f").as_deref(), Some("a\nX\nc\n"));
}

#[test]
fn numbered_backups_keep_counting_past_the_first_run_of_names() {
    let names: Vec<(String, &str)> = (1..=70).map(|n| (format!("f.~{n}~"), "old\n")).collect();
    let mut files: Vec<(&str, &str)> = names.iter().map(|(n, c)| (n.as_str(), *c)).collect();
    files.push(("f", "a\nb\nc\n"));
    let mut host = Host::with(&files, APPLIED);
    assert_eq!(
        patch(&mut host, r#"{"backup": true, "version": "numbered"}"#).0,
        0
    );
    assert_eq!(file(&host, "f.~71~").as_deref(), Some("a\nb\nc\n"));
    assert_eq!(file(&host, "f.~70~").as_deref(), Some("old\n"));
}
