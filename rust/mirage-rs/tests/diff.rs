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
    (output, stderr, stream.status(), metadata)
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
