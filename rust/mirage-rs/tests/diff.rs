use mirage_rs::{Stream, open};

fn compare(config: &str, old: &[u8], new: &[u8]) -> (Vec<u8>, Vec<u8>, i32, Vec<u8>) {
    let mut stream = open("diff", config.as_bytes()).expect("open diff");
    let mut output = Vec::new();
    for (index, input) in [old, new].into_iter().enumerate() {
        for chunk in input.chunks(7) {
            stream.feed_input(index, chunk, &mut output).unwrap();
            assert!(output.is_empty());
        }
        stream.end_input(index, &mut output).unwrap();
        assert!(output.is_empty());
    }
    stream.finish(&mut output).unwrap();
    while stream.busy() {
        let start = output.len();
        stream.drain(&mut output).unwrap();
        assert!(output.len() - start <= 65536);
    }
    let mut stderr = Vec::new();
    stream.take_stderr(&mut stderr);
    let mut metadata = Vec::new();
    stream.metadata(&mut metadata);
    let metadata: serde_json::Value = serde_json::from_slice(&metadata).expect("json");
    let outcome = serde_json::json!({ "outcome": metadata["outcome"] });
    (
        output,
        stderr,
        stream.status(),
        outcome.to_string().into_bytes(),
    )
}

#[test]
fn equal_and_different_are_explicit() {
    assert_eq!(
        compare("{}", b"", b""),
        (vec![], vec![], 0, br#"{"outcome":"equal"}"#.to_vec())
    );
    let (output, stderr, status, metadata) = compare("{}", b"old\n", b"new\n");
    assert_eq!(output, b"1c1\n< old\n---\n> new\n");
    assert!(stderr.is_empty());
    assert_eq!(status, 1);
    assert_eq!(metadata, br#"{"outcome":"different"}"#);
}

#[test]
fn output_text_cannot_override_comparison_status() {
    let (output, _, status, _) = compare("{}", b"before\n", b"files are identical\n");
    assert!(output.ends_with(b" are identical\n"));
    assert_eq!(status, 1);
}

#[test]
fn normalization_preserves_original_bytes() {
    let (output, _, status, _) = compare(
        r#"{"ignore_case":true,"ignore_space_change":true}"#,
        b" SAME\t\nOld \xff\n",
        b" same \nNew \xfe\n",
    );
    assert_eq!(status, 1);
    assert_eq!(output, b"2c2\n< Old \xff\n---\n> New \xfe\n");
    assert_eq!(
        compare(r#"{"ignore_all_space":true}"#, b"a \tb\r\n", b"ab").2,
        0
    );
}

#[test]
fn ignore_case_uses_unicode_lowercase_without_case_folding() {
    for (old, new) in [("Ä\n", "ä\n"), ("ΟΣ\n", "ος\n"), ("İ\n", "i\u{307}\n")] {
        for mode in ["normal", "unified", "ed"] {
            let config = format!(r#"{{"ignore_case":true,"mode":"{mode}"}}"#);
            assert_eq!(
                compare(&config, old.as_bytes(), new.as_bytes()),
                (vec![], vec![], 0, br#"{"outcome":"equal"}"#.to_vec()),
                "{mode}: {old:?} versus {new:?}"
            );
        }
    }
    let result = compare(
        r#"{"ignore_case":true}"#,
        "Straße\n".as_bytes(),
        b"STRASSE\n",
    );
    assert_eq!(result.0, "1c1\n< Straße\n---\n> STRASSE\n".as_bytes());
    assert_eq!(result.2, 1);
    let result = compare(
        r#"{"ignore_case":true,"ignore_all_space":true}"#,
        "ΟΣ Α\n".as_bytes(),
        "οςα\n".as_bytes(),
    );
    assert_eq!(result.2, 0);
}

#[test]
fn ignore_case_preserves_invalid_utf8_and_original_output() {
    let result = compare(
        r#"{"ignore_case":true}"#,
        "Ä\nÖ\n".as_bytes(),
        "ä\nü\n".as_bytes(),
    );
    assert_eq!(result.0, "2c2\n< Ö\n---\n> ü\n".as_bytes());
    assert_eq!(result.2, 1);
    let result = compare(
        r#"{"ignore_case":true}"#,
        b"\xff\xc3\x84\nOld \xfe\n",
        b"\xff\xc3\xa4\nNew \xfd\n",
    );
    assert_eq!(result.0, b"2c2\n< Old \xfe\n---\n> New \xfd\n");
    assert!(result.1.is_empty());
    assert_eq!(result.2, 1);
    assert_eq!(
        compare(r#"{"ignore_case":true}"#, b"\xff\n", b"\xfe\n").0,
        b"1c1\n< \xff\n---\n> \xfe\n"
    );
}

#[test]
fn unified_preserves_invalid_utf8_cr_and_missing_lf() {
    let (output, stderr, status, _) = compare(
        r#"{"mode":"unified","old_header":"left\tstamp","new_header":"right\tstamp"}"#,
        b"same\r\n\xff",
        b"same\r\n\xfe",
    );
    assert_eq!(output, b"--- left\tstamp\n+++ right\tstamp\n@@ -1,2 +1,2 @@\n same\r\n-\xff\n\\ No newline at end of file\n+\xfe\n\\ No newline at end of file\n");
    assert!(stderr.is_empty());
    assert_eq!(status, 1);
}

#[test]
fn binary_probe_stops_at_4096_bytes() {
    let old = vec![b'x'; 4100];
    let mut new = old.clone();
    new[4095] = 0;
    assert_eq!(
        compare("{}", &old, &new).0,
        b"Binary files a and b differ\n"
    );
    assert_eq!(compare(r#"{"brief":true}"#, &old, &new).0, b"");
    new[4095] = b'x';
    new[4096] = 0;
    let result = compare("{}", &old, &new);
    assert!(result.0.starts_with(b"1c1\n"));
    assert!(result.0.contains(&0));
    new[10] = 0;
    assert!(
        compare(r#"{"text":true}"#, &old, &new)
            .0
            .starts_with(b"1c1\n")
    );
}

#[test]
fn ed_escapes_dot_payload_and_reports_missing_newline() {
    let (output, stderr, status, _) = compare(r#"{"mode":"ed"}"#, b"old\n", b".\nlast");
    assert_eq!(output, b"1c\n..\n.\ns/.//\na\nlast\n.\n");
    assert_eq!(stderr, b"diff: b: No newline at end of file\n\n");
    assert_eq!(status, 2);
    let result = compare(r#"{"mode":"ed"}"#, b"same", b"same\n");
    assert!(result.0.is_empty());
    assert_eq!(result.2, 2);
    assert_eq!(result.3, br#"{"outcome":"equal"}"#);
}

#[test]
fn brief_retains_outcome_without_formatting() {
    let result = compare(r#"{"brief":true}"#, b"old\n", b"new\n");
    assert!(result.0.is_empty());
    assert_eq!(result.2, 1);
    assert_eq!(result.3, br#"{"outcome":"different"}"#);
}

#[test]
fn brief_compares_large_changed_inputs_without_an_edit_script() {
    let old: String = (0..100_000).map(|n| format!("old {n}\n")).collect();
    let new: String = (0..100_000).rev().map(|n| format!("old {n}\n")).collect();
    assert_eq!(
        compare(r#"{"brief":true}"#, old.as_bytes(), new.as_bytes()),
        (vec![], vec![], 1, br#"{"outcome":"different"}"#.to_vec())
    );
}

#[test]
fn brief_preserves_normalization_newline_and_binary_rules() {
    for (config, old, new, status) in [
        (
            r#"{"brief":true,"ignore_case":true}"#,
            "Ä\n".as_bytes(),
            "ä\n".as_bytes(),
            0,
        ),
        (
            r#"{"brief":true,"ignore_all_space":true}"#,
            b"a \tb\r\n".as_slice(),
            b"ab".as_slice(),
            0,
        ),
        (
            r#"{"brief":true,"ignore_all_space":true}"#,
            b"a\nb\n",
            b"ab\n",
            1,
        ),
        (
            r#"{"brief":true,"ignore_space_change":true}"#,
            b"a  b\n",
            b"a\tb",
            0,
        ),
        (r#"{"brief":true}"#, b"a\n", b"a", 1),
        (r#"{"brief":true,"mode":"ed"}"#, b"a\n", b"a", 1),
        (
            r#"{"brief":true,"ignore_case":true}"#,
            b"A\0\n",
            b"a\0\n",
            1,
        ),
        (r#"{"brief":true}"#, b"same\0\n", b"same\0\n", 0),
    ] {
        let result = compare(config, old, new);
        assert!(result.0.is_empty(), "{config}");
        assert!(result.1.is_empty(), "{config}");
        assert_eq!(result.2, status, "{config}");
        assert_eq!(
            result.3,
            if status == 0 {
                br#"{"outcome":"equal"}"#.as_slice()
            } else {
                br#"{"outcome":"different"}"#.as_slice()
            },
            "{config}"
        );
    }
}

#[test]
fn large_output_drains_in_bounded_chunks() {
    let old = vec![b'x'; 200000];
    let new = vec![b'y'; 200000];
    let result = compare("{}", &old, &new);
    assert!(result.0.len() > 400000);
    assert_eq!(result.2, 1);
}

#[test]
fn unified_zero_and_saturating_context() {
    let zero = compare(
        r#"{"mode":"unified","context":0}"#,
        b"a\nb\nc\n",
        b"a\nx\nc\n",
    );
    assert_eq!(zero.0, b"--- a\n+++ b\n@@ -2 +2 @@\n-b\n+x\n");
    let huge = compare(
        r#"{"mode":"unified","context":1e100}"#,
        b"a\nb\nc\n",
        b"a\nx\nc\n",
    );
    assert_eq!(huge.0, b"--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+x\n c\n");
}

#[test]
fn rejects_invalid_configuration_and_input_lifecycle() {
    assert!(open("diff", br#"{"algorithm":"other"}"#).is_err());
    assert!(open("diff", br#"{"context":-1}"#).is_err());
    let mut stream: Box<dyn Stream> = open("diff", b"{}").unwrap();
    let mut out = Vec::new();
    assert!(stream.finish(&mut out).is_err());
    assert!(stream.feed(b"x", &mut out).is_err());
    assert!(stream.feed_input(2, b"x", &mut out).is_err());
    assert!(stream.end_input(2, &mut out).is_err());
    stream.end_input(0, &mut out).unwrap();
    assert!(stream.feed_input(0, b"x", &mut out).is_err());
    assert!(stream.end_input(0, &mut out).is_err());
    stream.end_input(1, &mut out).unwrap();
    stream.finish(&mut out).unwrap();
    stream.drain(&mut out).unwrap();
    assert!(!stream.busy());
}

const TEN: &[u8] = b"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
const ELEVEN: &[u8] = b"a\nB\nc\nd\ne\nf\ng\nh\nI\nj\nk\n";

#[test]
fn context_and_rcs_formats_match_diffutils() {
    let headed = r#"{"mode":"context","old_header":"o","new_header":"n"}"#;
    let (output, _, status, _) = compare(headed, TEN, ELEVEN);
    assert_eq!(
        output,
        b"*** o\n--- n\n***************\n*** 1,10 ****\n  a\n! b\n  c\n  d\n  e\n  f\n  g\n  h\n! i\n  j\n--- 1,11 ----\n  a\n! B\n  c\n  d\n  e\n  f\n  g\n  h\n! I\n  j\n+ k\n"
    );
    assert_eq!(status, 1);
    let bare = r#"{"mode":"context","context":0,"old_header":"o","new_header":"n"}"#;
    assert_eq!(
        compare(bare, TEN, ELEVEN).0,
        b"*** o\n--- n\n***************\n*** 2 ****\n! b\n--- 2 ----\n! B\n***************\n*** 9 ****\n! i\n--- 9 ----\n! I\n***************\n*** 10 ****\n--- 11 ----\n+ k\n"
    );
    assert_eq!(
        compare(r#"{"mode":"rcs"}"#, TEN, ELEVEN).0,
        b"d2 1\na2 1\nB\nd9 1\na9 1\nI\na10 1\nk\n"
    );
    assert_eq!(compare(r#"{"mode":"rcs"}"#, b"a", b"b").0, b"d1 1\na1 1\nb");
}

#[test]
fn side_by_side_lays_out_columns_and_marks() {
    let old = b"a\nb\nc\nd\nsame\n";
    let new = b"a\nB\nc\nnew\nsame\nmore\n";
    let sides = |extra: &str| format!(r#"{{"mode":"sides","widths":["40"]{extra}}}"#);
    assert_eq!(
        compare(&sides(""), old, new).0,
        b"a\t\t\ta\nb\t\t   |\tB\nc\t\t\tc\nd\t\t   |\tnew\nsame\t\t\tsame\n\t\t   >\tmore\n"
    );
    assert_eq!(
        compare(&sides(r#","suppress_common":true"#), old, new).0,
        b"b\t\t   |\tB\nd\t\t   |\tnew\n\t\t   >\tmore\n"
    );
    assert_eq!(
        compare(&sides(r#","left_column":true"#), old, new).0,
        b"a\t\t   (\nb\t\t   |\tB\nc\t\t   (\nd\t\t   |\tnew\nsame\t\t   (\n\t\t   >\tmore\n"
    );
    assert_eq!(
        compare(&sides(r#","expand_tabs":true"#), b"keep\ngone\n\nboth\n", b"keep\n\nboth\nadded\n").0,
        b"keep                  keep\ngone               <\n\nboth                  both\n                   >  added\n"
    );
    let narrow = r#"{"mode":"sides","widths":["20"]}"#;
    assert_eq!(compare(narrow, b"a", b"b\n").0, b"a     \\\tb\n");
    assert_eq!(compare(narrow, b"b\n", b"a").0, b"b     /\ta\n");
    let (output, _, status, _) = compare(narrow, b"same", b"same");
    assert_eq!((output.as_slice(), status), (b"same\tsame".as_slice(), 0));
}

#[test]
fn blank_and_matching_lines_set_whole_changes_aside() {
    let blank = r#"{"ignore_blank_lines":true}"#;
    assert_eq!(compare(blank, b"a\nb\nc\n", b"a\n\nb\nc\n\n").2, 0);
    let brief = r#"{"ignore_blank_lines":true,"brief":true}"#;
    assert_eq!(compare(brief, b"a\nb\nc\n", b"a\n\nb\nc\n\n").2, 0);
    let old = b"x 1\nkeep\nx 2\n";
    let new = b"x 9\nkeep\nx 8\nnew\n";
    assert_eq!(
        compare(r#"{"ignore_lines":["^x"]}"#, old, new).0,
        b"3c3,4\n< x 2\n---\n> x 8\n> new\n"
    );
    assert_eq!(compare(r#"{"ignore_lines":["^x","^new"]}"#, old, new).2, 0);
    assert_eq!(
        compare(
            r#"{"mode":"unified","ignore_lines":["^x"],"old_header":"a","new_header":"b"}"#,
            old,
            new
        )
        .0,
        b"--- a\n+++ b\n@@ -1,3 +1,4 @@\n-x 1\n+x 9\n keep\n-x 2\n+x 8\n+new\n"
    );
    let crlf = r#"{"strip_trailing_cr":true,"brief":true}"#;
    assert_eq!(compare(crlf, b"a\r\nb\n", b"a\nb\n").2, 0);
}

#[test]
fn function_lines_and_tabs() {
    let old = b"int main(void)\n{\n  a;\n  b;\n  c;\n  d;\n  e;\n  f;\n  g;\n}\nvoid helper_with_a_really_long_name_that_goes_on(int x)\n{\n  h;\n}\n";
    let new = b"int main(void)\n{\n  a;\n  b;\n  c;\n  d;\n  e;\n  f;\n  G;\n}\nvoid helper_with_a_really_long_name_that_goes_on(int x)\n{\n  H;\n}\n";
    assert_eq!(
        compare(
            r#"{"mode":"unified","show_c_function":true,"old_header":"o","new_header":"n"}"#,
            old,
            new
        )
        .0,
        b"--- o\n+++ n\n@@ -6,9 +6,9 @@ int main(void)\n   d;\n   e;\n   f;\n-  g;\n+  G;\n }\n void helper_with_a_really_long_name_that_goes_on(int x)\n {\n-  h;\n+  H;\n }\n"
    );
    assert_eq!(
        compare(
            r#"{"initial_tab":true}"#,
            b"keep\ngone\n\nboth\n",
            b"keep\n\nboth\nadded\n"
        )
        .0,
        b"2d1\n<\tgone\n4a4\n>\tadded\n"
    );
}

#[test]
fn widths_and_patterns_are_refused_as_typed() {
    let refusal = |config: &str| match open("diff", config.as_bytes()) {
        Ok(_) => panic!("{config} opened"),
        Err(error) => (error.message, error.status),
    };
    assert_eq!(
        refusal(r#"{"widths":["0"]}"#),
        (
            "diff: invalid width '0'\ndiff: Try 'diff --help' for more information.".into(),
            2
        )
    );
    assert_eq!(
        refusal(r#"{"widths":["40","20"]}"#),
        ("diff: conflicting width options".into(), 2)
    );
    assert_eq!(
        refusal(r#"{"ignore_lines":["\\("]}"#),
        ("diff: \\(: Unmatched ( or \\(".into(), 2)
    );
    assert_eq!(
        refusal(r#"{"function_lines":["a["]}"#),
        ("diff: a[: Invalid regular expression".into(), 2)
    );
}

/// How many turns the host gets, and what the comparison prints.
fn turns(config: &str, old: &[u8], new: &[u8]) -> (usize, Vec<u8>) {
    let mut stream = open("diff", config.as_bytes()).expect("open diff");
    let mut output = Vec::new();
    for (index, input) in [old, new].into_iter().enumerate() {
        stream.feed_input(index, input, &mut output).unwrap();
        stream.end_input(index, &mut output).unwrap();
    }
    stream.finish(&mut output).unwrap();
    let mut count = 0;
    while stream.busy() {
        count += 1;
        stream.drain(&mut output).unwrap();
    }
    (count, output)
}

#[test]
fn a_heavy_ignore_pattern_gives_the_host_turns() {
    let line = format!("{}\n", "a".repeat(22));
    let config = r#"{"ignore_lines":["\\(a*\\)*\\1b"]}"#;
    let (count, output) = turns(config, line.as_bytes(), b"b\n");
    assert!(count > 1, "{count} turns");
    assert_eq!(output, format!("1c1\n< {line}---\n> b\n").into_bytes());
}

#[test]
fn a_heavy_function_pattern_gives_the_host_turns() {
    let line = "a".repeat(22);
    let old = format!("{line}\nx\n");
    let config = r#"{"mode":"unified","context":0,"old_label":"a","new_label":"b","function_lines":["\\(a*\\)*\\1b"]}"#;
    let (count, output) = turns(config, old.as_bytes(), format!("{line}\ny\n").as_bytes());
    assert!(count > 1, "{count} turns");
    assert!(output.ends_with(b"@@ -2 +2 @@\n-x\n+y\n"), "{output:?}");
}

#[test]
fn expanded_tabs_count_only_printable_ascii() {
    for (line, expected) in [
        (&b"X\tY\n"[..], &b"< X       Y\n"[..]),
        (b"\xc3\xa9\tY\n", b"< \xc3\xa9        Y\n"),
        (b"\xff\tY\n", b"< \xff        Y\n"),
        (b"\x01\tY\n", b"< \x01        Y\n"),
        (b"a\x08b\tY\n", b"< a\x08b       Y\n"),
        (b"\x08\tY\n", b"<         Y\n"),
        (b"ab\rc\tY\n", b"< ab\r< c       Y\n"),
    ] {
        let (output, ..) = compare(r#"{"expand_tabs":true}"#, line, b"z\n");
        let printed = output.split_inclusive(|byte| *byte == b'\n').nth(1);
        assert_eq!(printed, Some(expected), "{line:?}");
    }
}

#[test]
fn large_inputs_report_sparse_changes_the_same() {
    let old: String = (1..=200_000).map(|n| format!("{n}\n")).collect();
    let mut new = String::new();
    for n in 1..=200_000 {
        match n {
            5 => new.push_str("x\n"),
            100_000 => {}
            150_000 => new.push_str("150000\ny\n"),
            _ => new.push_str(&format!("{n}\n")),
        }
    }
    let (output, stderr, status, _) =
        compare(r#"{"mode":"normal"}"#, old.as_bytes(), new.as_bytes());
    assert_eq!(
        String::from_utf8(output).unwrap(),
        "5c5\n< 5\n---\n> x\n100000d99999\n< 100000\n150000a150000\n> y\n"
    );
    assert!(stderr.is_empty());
    assert_eq!(status, 1);
}
