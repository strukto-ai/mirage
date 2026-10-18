use super::*;
use serde_json::{Value, json};
fn units(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}
fn collect(stream: &mut dyn Stream) -> Value {
    let mut out = Vec::new();
    stream.finish(&mut out).unwrap();
    let mut calls = 0;
    while stream.busy() {
        stream.drain(&mut out).unwrap();
        calls += 1;
        assert!(calls < 1_000_000, "operation failed to complete");
    }
    serde_json::from_slice(&out).unwrap()
}
fn request(
    pattern: &[u32],
    subject: &[u32],
    operation: Value,
    python: bool,
    extglob: bool,
    period: bool,
) -> Value {
    let config = json!({"pattern": pattern, "dialect": if python { "python" } else { "shell" }, "extglob": extglob, "period": period, "operation": operation});
    let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
    let bytes: Vec<u8> = subject.iter().flat_map(|cp| cp.to_le_bytes()).collect();
    for chunk in bytes.chunks(7) {
        stream.feed(chunk, &mut Vec::new()).unwrap();
    }
    collect(stream.as_mut())
}
fn matches(name: &str, pattern: &str, extglob: bool) -> bool {
    request(
        &units(pattern),
        &units(name),
        json!({"kind":"matches"}),
        false,
        extglob,
        false,
    )
    .as_bool()
    .unwrap()
}
#[test]
fn host_boolean_corpus() {
    let cases: &[(&str, &str, bool, bool, bool, bool)] = &[
        ("c.txt", "[!ab].txt", true, false, false, false),
        ("a.txt", "[!ab].txt", false, false, false, false),
        ("c.txt", "[^ab].txt", true, false, false, false),
        ("a.txt", "[^ab].txt", false, false, false, false),
        ("b.txt", "[ab].txt", true, false, false, false),
        ("c.txt", "[a-c].txt", true, false, false, false),
        ("d.txt", "[a-c].txt", false, false, false, false),
        ("hello", "h*o", true, false, false, false),
        ("hello", "h?llo", true, false, false, false),
        ("Hello", "hello", false, false, false, false),
        ("x", "[x^]", true, false, false, false),
        ("^", "[x^]", true, false, false, false),
        ("😀.txt", "?.txt", true, false, false, false),
        ("a.txt", "[^a]*", true, true, false, false),
        ("^x", "[^a]*", true, true, false, false),
        ("b.txt", "[^a]*", false, true, false, false),
        ("b.txt", "[!a]*", true, true, false, false),
        ("😀.txt", "?.txt", true, true, false, false),
        ("c", "[^ab]*", true, false, false, false),
        ("a", "[^ab]*", false, false, false, false),
        ("^", "[a^]", true, false, false, false),
        ("b", "[a^]", false, false, false, false),
        ("^", "[[^b]", true, false, false, false),
        ("!", "[[^b]", false, false, false, false),
        ("]", "[^]a]", false, false, false, false),
        ("[^ab", "[^ab", true, false, false, false),
        ("[^]", "[^]", true, false, false, false),
        ("", "@(a|b)", false, false, true, false),
        ("a", "@(a|b)", true, false, true, false),
        ("b", "@(a|b)", true, false, true, false),
        ("c", "@(a|b)", false, false, true, false),
        ("ab", "@(a|b)", false, false, true, false),
        ("abc", "@(a|b)", false, false, true, false),
        ("bb", "@(a|b)", false, false, true, false),
        ("aa", "@(a|b)", false, false, true, false),
        ("ac", "@(a|b)", false, false, true, false),
        ("a(b)", "@(a|b)", false, false, true, false),
        ("a(b|d)", "@(a|b)", false, false, true, false),
        ("a|b", "@(a|b)", false, false, true, false),
        ("123", "@(a|b)", false, false, true, false),
        ("😀", "@(a|b)", false, false, true, false),
        ("a\nb", "@(a|b)", false, false, true, false),
        ("", "?(a|b)", true, false, true, false),
        ("a", "?(a|b)", true, false, true, false),
        ("b", "?(a|b)", true, false, true, false),
        ("c", "?(a|b)", false, false, true, false),
        ("ab", "?(a|b)", false, false, true, false),
        ("abc", "?(a|b)", false, false, true, false),
        ("bb", "?(a|b)", false, false, true, false),
        ("aa", "?(a|b)", false, false, true, false),
        ("ac", "?(a|b)", false, false, true, false),
        ("a(b)", "?(a|b)", false, false, true, false),
        ("a(b|d)", "?(a|b)", false, false, true, false),
        ("a|b", "?(a|b)", false, false, true, false),
        ("123", "?(a|b)", false, false, true, false),
        ("😀", "?(a|b)", false, false, true, false),
        ("a\nb", "?(a|b)", false, false, true, false),
        ("", "*(a|b)", true, false, true, false),
        ("a", "*(a|b)", true, false, true, false),
        ("b", "*(a|b)", true, false, true, false),
        ("c", "*(a|b)", false, false, true, false),
        ("ab", "*(a|b)", true, false, true, false),
        ("abc", "*(a|b)", false, false, true, false),
        ("bb", "*(a|b)", true, false, true, false),
        ("aa", "*(a|b)", true, false, true, false),
        ("ac", "*(a|b)", false, false, true, false),
        ("a(b)", "*(a|b)", false, false, true, false),
        ("a(b|d)", "*(a|b)", false, false, true, false),
        ("a|b", "*(a|b)", false, false, true, false),
        ("123", "*(a|b)", false, false, true, false),
        ("😀", "*(a|b)", false, false, true, false),
        ("a\nb", "*(a|b)", false, false, true, false),
        ("", "+(a|b)", false, false, true, false),
        ("a", "+(a|b)", true, false, true, false),
        ("b", "+(a|b)", true, false, true, false),
        ("c", "+(a|b)", false, false, true, false),
        ("ab", "+(a|b)", true, false, true, false),
        ("abc", "+(a|b)", false, false, true, false),
        ("bb", "+(a|b)", true, false, true, false),
        ("aa", "+(a|b)", true, false, true, false),
        ("ac", "+(a|b)", false, false, true, false),
        ("a(b)", "+(a|b)", false, false, true, false),
        ("a(b|d)", "+(a|b)", false, false, true, false),
        ("a|b", "+(a|b)", false, false, true, false),
        ("123", "+(a|b)", false, false, true, false),
        ("😀", "+(a|b)", false, false, true, false),
        ("a\nb", "+(a|b)", false, false, true, false),
        ("", "!(a|b)", true, false, true, false),
        ("a", "!(a|b)", false, false, true, false),
        ("b", "!(a|b)", false, false, true, false),
        ("c", "!(a|b)", true, false, true, false),
        ("ab", "!(a|b)", true, false, true, false),
        ("abc", "!(a|b)", true, false, true, false),
        ("bb", "!(a|b)", true, false, true, false),
        ("aa", "!(a|b)", true, false, true, false),
        ("ac", "!(a|b)", true, false, true, false),
        ("a(b)", "!(a|b)", true, false, true, false),
        ("a(b|d)", "!(a|b)", true, false, true, false),
        ("a|b", "!(a|b)", true, false, true, false),
        ("123", "!(a|b)", true, false, true, false),
        ("😀", "!(a|b)", true, false, true, false),
        ("a\nb", "!(a|b)", true, false, true, false),
        ("", "!(a)*", true, false, true, false),
        ("a", "!(a)*", true, false, true, false),
        ("b", "!(a)*", true, false, true, false),
        ("c", "!(a)*", true, false, true, false),
        ("ab", "!(a)*", true, false, true, false),
        ("abc", "!(a)*", true, false, true, false),
        ("bb", "!(a)*", true, false, true, false),
        ("aa", "!(a)*", true, false, true, false),
        ("ac", "!(a)*", true, false, true, false),
        ("a(b)", "!(a)*", true, false, true, false),
        ("a(b|d)", "!(a)*", true, false, true, false),
        ("a|b", "!(a)*", true, false, true, false),
        ("123", "!(a)*", true, false, true, false),
        ("😀", "!(a)*", true, false, true, false),
        ("a\nb", "!(a)*", true, false, true, false),
        ("", "a!(b)c", false, false, true, false),
        ("a", "a!(b)c", false, false, true, false),
        ("b", "a!(b)c", false, false, true, false),
        ("c", "a!(b)c", false, false, true, false),
        ("ab", "a!(b)c", false, false, true, false),
        ("abc", "a!(b)c", false, false, true, false),
        ("bb", "a!(b)c", false, false, true, false),
        ("aa", "a!(b)c", false, false, true, false),
        ("ac", "a!(b)c", true, false, true, false),
        ("a(b)", "a!(b)c", false, false, true, false),
        ("a(b|d)", "a!(b)c", false, false, true, false),
        ("a|b", "a!(b)c", false, false, true, false),
        ("123", "a!(b)c", false, false, true, false),
        ("😀", "a!(b)c", false, false, true, false),
        ("a\nb", "a!(b)c", false, false, true, false),
        ("", "@(a|+(b|c))", false, false, true, false),
        ("a", "@(a|+(b|c))", true, false, true, false),
        ("b", "@(a|+(b|c))", true, false, true, false),
        ("c", "@(a|+(b|c))", true, false, true, false),
        ("ab", "@(a|+(b|c))", false, false, true, false),
        ("abc", "@(a|+(b|c))", false, false, true, false),
        ("bb", "@(a|+(b|c))", true, false, true, false),
        ("aa", "@(a|+(b|c))", false, false, true, false),
        ("ac", "@(a|+(b|c))", false, false, true, false),
        ("a(b)", "@(a|+(b|c))", false, false, true, false),
        ("a(b|d)", "@(a|+(b|c))", false, false, true, false),
        ("a|b", "@(a|+(b|c))", false, false, true, false),
        ("123", "@(a|+(b|c))", false, false, true, false),
        ("😀", "@(a|+(b|c))", false, false, true, false),
        ("a\nb", "@(a|+(b|c))", false, false, true, false),
        ("", "*(!(a))", true, false, true, false),
        ("a", "*(!(a))", false, false, true, false),
        ("b", "*(!(a))", true, false, true, false),
        ("c", "*(!(a))", true, false, true, false),
        ("ab", "*(!(a))", true, false, true, false),
        ("abc", "*(!(a))", true, false, true, false),
        ("bb", "*(!(a))", true, false, true, false),
        ("aa", "*(!(a))", true, false, true, false),
        ("ac", "*(!(a))", true, false, true, false),
        ("a(b)", "*(!(a))", true, false, true, false),
        ("a(b|d)", "*(!(a))", true, false, true, false),
        ("a|b", "*(!(a))", true, false, true, false),
        ("123", "*(!(a))", true, false, true, false),
        ("😀", "*(!(a))", true, false, true, false),
        ("a\nb", "*(!(a))", true, false, true, false),
        ("", "+(?(a))", true, false, true, false),
        ("a", "+(?(a))", true, false, true, false),
        ("b", "+(?(a))", false, false, true, false),
        ("c", "+(?(a))", false, false, true, false),
        ("ab", "+(?(a))", false, false, true, false),
        ("abc", "+(?(a))", false, false, true, false),
        ("bb", "+(?(a))", false, false, true, false),
        ("aa", "+(?(a))", true, false, true, false),
        ("ac", "+(?(a))", false, false, true, false),
        ("a(b)", "+(?(a))", false, false, true, false),
        ("a(b|d)", "+(?(a))", false, false, true, false),
        ("a|b", "+(?(a))", false, false, true, false),
        ("123", "+(?(a))", false, false, true, false),
        ("😀", "+(?(a))", false, false, true, false),
        ("a\nb", "+(?(a))", false, false, true, false),
        ("", "@(|a)", true, false, true, false),
        ("a", "@(|a)", true, false, true, false),
        ("b", "@(|a)", false, false, true, false),
        ("c", "@(|a)", false, false, true, false),
        ("ab", "@(|a)", false, false, true, false),
        ("abc", "@(|a)", false, false, true, false),
        ("bb", "@(|a)", false, false, true, false),
        ("aa", "@(|a)", false, false, true, false),
        ("ac", "@(|a)", false, false, true, false),
        ("a(b)", "@(|a)", false, false, true, false),
        ("a(b|d)", "@(|a)", false, false, true, false),
        ("a|b", "@(|a)", false, false, true, false),
        ("123", "@(|a)", false, false, true, false),
        ("😀", "@(|a)", false, false, true, false),
        ("a\nb", "@(|a)", false, false, true, false),
        ("", "!()", false, false, true, false),
        ("a", "!()", true, false, true, false),
        ("b", "!()", true, false, true, false),
        ("c", "!()", true, false, true, false),
        ("ab", "!()", true, false, true, false),
        ("abc", "!()", true, false, true, false),
        ("bb", "!()", true, false, true, false),
        ("aa", "!()", true, false, true, false),
        ("ac", "!()", true, false, true, false),
        ("a(b)", "!()", true, false, true, false),
        ("a(b|d)", "!()", true, false, true, false),
        ("a|b", "!()", true, false, true, false),
        ("123", "!()", true, false, true, false),
        ("😀", "!()", true, false, true, false),
        ("a\nb", "!()", true, false, true, false),
        ("", "@(a(b)|c)", false, false, true, false),
        ("a", "@(a(b)|c)", false, false, true, false),
        ("b", "@(a(b)|c)", false, false, true, false),
        ("c", "@(a(b)|c)", true, false, true, false),
        ("ab", "@(a(b)|c)", false, false, true, false),
        ("abc", "@(a(b)|c)", false, false, true, false),
        ("bb", "@(a(b)|c)", false, false, true, false),
        ("aa", "@(a(b)|c)", false, false, true, false),
        ("ac", "@(a(b)|c)", false, false, true, false),
        ("a(b)", "@(a(b)|c)", true, false, true, false),
        ("a(b|d)", "@(a(b)|c)", false, false, true, false),
        ("a|b", "@(a(b)|c)", false, false, true, false),
        ("123", "@(a(b)|c)", false, false, true, false),
        ("😀", "@(a(b)|c)", false, false, true, false),
        ("a\nb", "@(a(b)|c)", false, false, true, false),
        ("", "@(a(b|d)|c)", false, false, true, false),
        ("a", "@(a(b|d)|c)", false, false, true, false),
        ("b", "@(a(b|d)|c)", false, false, true, false),
        ("c", "@(a(b|d)|c)", true, false, true, false),
        ("ab", "@(a(b|d)|c)", false, false, true, false),
        ("abc", "@(a(b|d)|c)", false, false, true, false),
        ("bb", "@(a(b|d)|c)", false, false, true, false),
        ("aa", "@(a(b|d)|c)", false, false, true, false),
        ("ac", "@(a(b|d)|c)", false, false, true, false),
        ("a(b)", "@(a(b|d)|c)", false, false, true, false),
        ("a(b|d)", "@(a(b|d)|c)", true, false, true, false),
        ("a|b", "@(a(b|d)|c)", false, false, true, false),
        ("123", "@(a(b|d)|c)", false, false, true, false),
        ("😀", "@(a(b|d)|c)", false, false, true, false),
        ("a\nb", "@(a(b|d)|c)", false, false, true, false),
        ("", "+([[:digit:]])", false, false, true, false),
        ("a", "+([[:digit:]])", false, false, true, false),
        ("b", "+([[:digit:]])", false, false, true, false),
        ("c", "+([[:digit:]])", false, false, true, false),
        ("ab", "+([[:digit:]])", false, false, true, false),
        ("abc", "+([[:digit:]])", false, false, true, false),
        ("bb", "+([[:digit:]])", false, false, true, false),
        ("aa", "+([[:digit:]])", false, false, true, false),
        ("ac", "+([[:digit:]])", false, false, true, false),
        ("a(b)", "+([[:digit:]])", false, false, true, false),
        ("a(b|d)", "+([[:digit:]])", false, false, true, false),
        ("a|b", "+([[:digit:]])", false, false, true, false),
        ("123", "+([[:digit:]])", true, false, true, false),
        ("😀", "+([[:digit:]])", false, false, true, false),
        ("a\nb", "+([[:digit:]])", false, false, true, false),
        ("", "@(😀|a)", false, false, true, false),
        ("a", "@(😀|a)", true, false, true, false),
        ("b", "@(😀|a)", false, false, true, false),
        ("c", "@(😀|a)", false, false, true, false),
        ("ab", "@(😀|a)", false, false, true, false),
        ("abc", "@(😀|a)", false, false, true, false),
        ("bb", "@(😀|a)", false, false, true, false),
        ("aa", "@(😀|a)", false, false, true, false),
        ("ac", "@(😀|a)", false, false, true, false),
        ("a(b)", "@(😀|a)", false, false, true, false),
        ("a(b|d)", "@(😀|a)", false, false, true, false),
        ("a|b", "@(😀|a)", false, false, true, false),
        ("123", "@(😀|a)", false, false, true, false),
        ("😀", "@(😀|a)", true, false, true, false),
        ("a\nb", "@(😀|a)", false, false, true, false),
        ("", "@([!a]|ab)", false, false, true, false),
        ("a", "@([!a]|ab)", false, false, true, false),
        ("b", "@([!a]|ab)", true, false, true, false),
        ("c", "@([!a]|ab)", true, false, true, false),
        ("ab", "@([!a]|ab)", true, false, true, false),
        ("abc", "@([!a]|ab)", false, false, true, false),
        ("bb", "@([!a]|ab)", false, false, true, false),
        ("aa", "@([!a]|ab)", false, false, true, false),
        ("ac", "@([!a]|ab)", false, false, true, false),
        ("a(b)", "@([!a]|ab)", false, false, true, false),
        ("a(b|d)", "@([!a]|ab)", false, false, true, false),
        ("a|b", "@([!a]|ab)", false, false, true, false),
        ("123", "@([!a]|ab)", false, false, true, false),
        ("😀", "@([!a]|ab)", true, false, true, false),
        ("a\nb", "@([!a]|ab)", false, false, true, false),
        ("", "@(a[|]b|c)", false, false, true, false),
        ("a", "@(a[|]b|c)", false, false, true, false),
        ("b", "@(a[|]b|c)", false, false, true, false),
        ("c", "@(a[|]b|c)", true, false, true, false),
        ("ab", "@(a[|]b|c)", false, false, true, false),
        ("abc", "@(a[|]b|c)", false, false, true, false),
        ("bb", "@(a[|]b|c)", false, false, true, false),
        ("aa", "@(a[|]b|c)", false, false, true, false),
        ("ac", "@(a[|]b|c)", false, false, true, false),
        ("a(b)", "@(a[|]b|c)", false, false, true, false),
        ("a(b|d)", "@(a[|]b|c)", false, false, true, false),
        ("a|b", "@(a[|]b|c)", true, false, true, false),
        ("123", "@(a[|]b|c)", false, false, true, false),
        ("😀", "@(a[|]b|c)", false, false, true, false),
        ("a\nb", "@(a[|]b|c)", false, false, true, false),
        (".h", "@(.h|a)", true, false, true, true),
        (".h", "?(.h)", true, false, true, true),
        (".h", "*(.h)", true, false, true, true),
        (".h", "!(a)", false, false, true, true),
        (".h", "!(a).h", false, false, true, true),
        (".h", "*(x).h", true, false, true, true),
        (".h", "*.h", false, false, true, true),
        (".h", "@([.]h|a)", false, false, true, true),
        (".h", "@(.*|a)", true, false, true, true),
    ];
    for &(name, pattern, expected, python, extglob, period) in cases {
        assert_eq!(
            request(
                &units(pattern),
                &units(name),
                json!({"kind":"matches"}),
                python,
                extglob,
                period
            ),
            json!(expected),
            "pattern {pattern:?}, name {name:?}"
        );
    }
}
#[test]
fn long_negative_and_nullable_patterns() {
    let cases = [
        ("+(*)", "", true),
        ("+(*)b", "", false),
        ("*(*)", "", true),
        ("+(a|*)b", "", false),
        ("*+(*)", "", true),
        ("+(aa)", "", true),
        ("+(aa)", "a", false),
        ("+(*(aa))", "", true),
        ("+(?(aa))", "a", false),
        ("*(+(aa)|b)", "c", false),
        ("+(@(*(aa)|b))", "", true),
        ("*!(a)", "", true),
        ("*!(*)", "", false),
        ("*!(a*)", "", true),
        ("*!(*a)", "", true),
        ("*!(*b)", "", true),
        ("*!(+(aa))", "a", true),
    ];
    for (pattern, tail, expected) in cases {
        assert_eq!(
            matches(&("a".repeat(16000) + tail), pattern, true),
            expected,
            "{pattern}"
        );
    }
}
#[test]
fn suffix_extents_preserve_units() {
    let cases = [
        ("ab".repeat(16000), "*a".to_owned(), [None, None]),
        ("ab".repeat(16000), "a*".to_owned(), [Some(31998), Some(0)]),
        ("xab".to_owned(), "@(b|ab)".to_owned(), [Some(2), Some(1)]),
        ("ba".to_owned(), "+(@(a|b))".to_owned(), [Some(1), Some(0)]),
        ("xa)".to_owned(), "!(a)".to_owned(), [Some(3), Some(0)]),
        ("xa(b)|c".to_owned(), "(b)|c".to_owned(), [Some(2), Some(2)]),
        (
            "xa(b)".to_owned(),
            "@(a(b)|z)".to_owned(),
            [Some(1), Some(1)],
        ),
        ("x[a".to_owned(), "[a".to_owned(), [Some(1), Some(1)]),
        ("x|)".to_owned(), "[)|]".to_owned(), [Some(2), Some(2)]),
    ];
    for (name, pattern, expected) in cases {
        for (index, longest) in [false, true].into_iter().enumerate() {
            assert_eq!(
                request(
                    &units(&pattern),
                    &units(&name),
                    json!({"kind":"suffix","longest":longest}),
                    false,
                    true,
                    false
                ),
                json!(expected[index]),
                "pattern {pattern:?}, name length {}",
                name.len()
            );
        }
    }
    assert_eq!(
        request(
            &[0xdcff, 0xd83d],
            &[120, 0xdcff, 0xd83d],
            json!({"kind":"suffix"}),
            false,
            true,
            false
        ),
        json!(1)
    );
}
#[test]
fn deep_groups_use_explicit_stacks() {
    for operator in ["@", "?", "+", "*"] {
        let pattern = (operator.to_owned() + "(").repeat(1200) + "a" + &")".repeat(1200);
        assert!(matches("a", &pattern, true));
        assert!(!matches("b", &pattern, true));
    }
}
#[test]
fn repeated_end_queries_reuse_the_subject() {
    let config = json!({"pattern":units("*b"), "operation":{"kind":"end","start":0}});
    let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
    stream
        .feed(
            &units(&" ".repeat(16000))
                .iter()
                .flat_map(|cp| cp.to_le_bytes())
                .collect::<Vec<_>>(),
            &mut Vec::new(),
        )
        .unwrap();
    assert_eq!(collect(stream.as_mut()), Value::Null);
    for start in 1..=16000 {
        stream
            .begin(
                &serde_json::to_vec(&json!({"kind":"end","start":start,"reuse_subject":true}))
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(collect(stream.as_mut()), Value::Null);
    }
}
#[test]
fn replacement_spans_skip_empty_matches() {
    for (name, pattern, all, anchor, spans) in [
        ("abcab", "*b", false, None, json!([[0, 5]])),
        (
            "abcab",
            "?",
            true,
            None,
            json!([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]),
        ),
        ("abcab", "a*", false, Some("%"), json!([[0, 5]])),
        ("abcab", "*b", false, Some("#"), json!([[0, 5]])),
        ("", "*", true, None, json!([[0, 0]])),
        ("abc", "?(x)", true, None, json!([])),
        ("baab", "+(?(a))", true, None, json!([[1, 3]])),
    ] {
        assert_eq!(
            request(
                &units(pattern),
                &units(name),
                json!({"kind":"replace","all":all,"anchor":anchor}),
                false,
                true,
                false
            ),
            spans
        );
    }
}
#[test]
fn classification_keeps_groups_and_literal_slashes() {
    assert_eq!(
        request(
            &units("a@(b/c|d)/e"),
            &[],
            json!({"kind":"shape"}),
            false,
            false,
            false
        ),
        json!(units("a*/e"))
    );
    assert_eq!(
        request(
            &units("a@(b/c|d)/e"),
            &[],
            json!({"kind":"parts"}),
            false,
            false,
            false
        ),
        json!([units("a@(b/c|d)"), units("e")])
    );
    assert_eq!(
        request(
            &units("/a//"),
            &[],
            json!({"kind":"parts"}),
            false,
            false,
            false
        ),
        json!([units(""), units("a"), units(""), units("")])
    );
}
#[test]
fn dialects_and_quoted_units_remain_distinct() {
    assert_eq!(
        request(
            &[0xfdd0],
            &[42],
            json!({"kind":"matches"}),
            false,
            true,
            false
        ),
        json!(true)
    );
    assert_eq!(
        request(
            &[0xfdd0],
            &[42],
            json!({"kind":"matches"}),
            true,
            true,
            false
        ),
        json!(false)
    );
    assert_eq!(
        request(
            &units("[[:digit:]]"),
            &units("5"),
            json!({"kind":"matches"}),
            true,
            true,
            false
        ),
        json!(false)
    );
    assert_eq!(
        request(
            &[0xdcff, 0xd83d],
            &[0xdcff, 0xd83d],
            json!({"kind":"matches"}),
            false,
            false,
            false
        ),
        json!(true)
    );
    for python in [true, false] {
        assert_eq!(
            request(
                &units("[a"),
                &units("x[a"),
                json!({"kind":"suffix"}),
                python,
                false,
                false
            ),
            json!(1)
        );
    }
    for (name, pattern, expected) in [
        ("z", "[z-a]", false),
        ("-", "[z-a]", false),
        ("b", "[z-ab]", true),
        ("b", "[!z-a]", true),
    ] {
        assert_eq!(matches(name, pattern, false), expected);
    }
}
#[test]
fn long_compilation_yields_and_truncated_units_fail() {
    let config = json!({"pattern":units(&"a".repeat(10000)), "operation":{"kind":"matches"}});
    let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
    stream.finish(&mut Vec::new()).unwrap();
    stream.drain(&mut Vec::new()).unwrap();
    assert!(stream.busy());
    let mut stream = open(br#"{"pattern":[],"operation":{"kind":"matches"}}"#).unwrap();
    stream.feed(&[1, 2, 3], &mut Vec::new()).unwrap();
    assert!(stream.finish(&mut Vec::new()).is_err());
}

#[test]
fn python_invalid_ranges_normalize_before_negation() {
    for (pattern, excluded) in [
        ("[a--!]", ""),
        ("[a-!!]", ""),
        ("[a-^!]", ""),
        ("[a--!b]", "b"),
        ("[!a--!]", "!"),
        ("[a--!-!]", "-!"),
        ("[z-a!-z]", "-z"),
    ] {
        for cp in 0..=127 {
            assert_eq!(
                request(
                    &units(pattern),
                    &[cp],
                    json!({"kind":"matches"}),
                    true,
                    false,
                    false
                ),
                json!(!excluded.chars().any(|ch| u32::from(ch) == cp)),
                "pattern {pattern:?}, unit {cp}"
            );
        }
    }
    for name in ["a", "-", "!", "^"] {
        for pattern in ["[a--!]", "[a-!!]", "[a-^!]"] {
            assert_eq!(matches(name, pattern, false), name == "!");
        }
    }
}

#[test]
fn star_before_extglob_includes_every_tail() {
    // Bash 5.2.37 tries only some tails here; the shared shell contract includes the empty tail.
    for (name, pattern, expected) in [
        ("a", "*!(a)", true),
        ("", "*@(|b)", true),
        ("", "*!(a)x", false),
    ] {
        assert_eq!(matches(name, pattern, true), expected);
    }
}

#[test]
fn replacement_reuses_large_active_state_sets() {
    let alternatives: Vec<String> = (0..65).map(|index| format!("*b{index}")).collect();
    let pattern = format!("@({})", alternatives.join("|"));
    let config = json!({"pattern": units(&pattern), "extglob": true, "operation": {"kind": "replace", "all": true}});
    for tail in ["", "b64"] {
        let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
        let subject = units(&format!("{}{tail}", "a".repeat(256)));
        let bytes: Vec<u8> = subject.iter().flat_map(|cp| cp.to_le_bytes()).collect();
        let mut output = Vec::new();
        stream.feed(&bytes, &mut output).unwrap();
        stream.finish(&mut output).unwrap();
        let mut chunks = 0;
        while stream.busy() {
            stream.drain(&mut output).unwrap();
            chunks += 1;
            assert!(
                chunks <= 1024,
                "failed replacement starts exceeded 1024 work chunks"
            );
        }
        let expected = if tail.is_empty() {
            json!([])
        } else {
            json!([[0, subject.len()]])
        };
        assert_eq!(serde_json::from_slice::<Value>(&output).unwrap(), expected);
    }
}

#[test]
fn large_state_identity_survives_drain_boundaries() {
    let alternatives: Vec<String> = (0..=WORK).map(|index| format!("*b{index}")).collect();
    let pattern = format!("@({})", alternatives.join("|"));
    let subject = format!("ab{WORK}");
    assert_eq!(
        request(
            &units(&pattern),
            &units(&subject),
            json!({"kind":"replace","all":true}),
            false,
            true,
            false
        ),
        json!([[0, subject.len()]])
    );
}

#[test]
fn large_tail_cache_follows_subject_and_direction() {
    let alternatives: Vec<String> = (0..65).map(|index| format!("*b{index}")).collect();
    let pattern = format!("@({})", alternatives.join("|"));
    let config = json!({"pattern": units(&pattern), "extglob": true, "operation": {"kind": "replace", "all": true}});
    let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
    let bytes: Vec<u8> = units(&"a".repeat(256))
        .iter()
        .flat_map(|cp| cp.to_le_bytes())
        .collect();
    stream.feed(&bytes, &mut Vec::new()).unwrap();
    assert_eq!(collect(stream.as_mut()), json!([]));
    stream.begin(br#"{"kind":"replace","all":true}"#).unwrap();
    let bytes: Vec<u8> = units("aab64")
        .iter()
        .flat_map(|cp| cp.to_le_bytes())
        .collect();
    stream.feed(&bytes, &mut Vec::new()).unwrap();
    assert_eq!(collect(stream.as_mut()), json!([[0, 5]]));
    stream
        .begin(br#"{"kind":"suffix","longest":true,"reuse_subject":true}"#)
        .unwrap();
    assert_eq!(collect(stream.as_mut()), json!(0));
    stream
        .begin(br#"{"kind":"suffix","longest":false,"reuse_subject":true}"#)
        .unwrap();
    assert_eq!(collect(stream.as_mut()), json!(2));
}

#[test]
fn adjacent_stars_share_one_state() {
    for (name, pattern, extglob, expected) in [
        ("b", "**(a)", true, true),
        ("ba", "**(a)", true, true),
        ("xaa", "x**(a)", true, true),
        ("", "***", false, true),
        ("*", "[**]", false, true),
        ("a", "[**]", false, false),
        ("a*b", "a[*]**b", false, true),
        ("ab", "a[*]**b", false, false),
    ] {
        assert_eq!(
            matches(name, pattern, extglob),
            expected,
            "{name} {pattern}"
        );
    }
    let stars = "*".repeat(1024);
    let subject = units(&"a".repeat(200_000));
    for (pattern, operation, expected) in [
        (stars.clone(), json!({"kind":"matches"}), json!(true)),
        (
            format!("*a{stars}b"),
            json!({"kind":"matches"}),
            json!(false),
        ),
        (
            format!("a{stars}"),
            json!({"kind":"end","longest":false}),
            json!(1),
        ),
        (
            format!("{stars}a"),
            json!({"kind":"suffix","longest":false}),
            json!(subject.len() - 1),
        ),
    ] {
        let config = json!({"pattern": units(&pattern), "operation": operation});
        let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
        let bytes: Vec<u8> = subject.iter().flat_map(|cp| cp.to_le_bytes()).collect();
        let mut output = Vec::new();
        stream.feed(&bytes, &mut output).unwrap();
        stream.finish(&mut output).unwrap();
        let mut chunks = 0;
        while stream.busy() {
            stream.drain(&mut output).unwrap();
            chunks += 1;
            assert!(chunks <= 4096, "{pattern:.8} exceeded 4096 work chunks");
        }
        assert_eq!(serde_json::from_slice::<Value>(&output).unwrap(), expected);
    }
}
