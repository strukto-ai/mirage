use super::*;

fn compile(pattern: &str, mode: Mode) -> Result<Pcre, PcreError> {
    Pcre::new(&pattern.chars().collect::<Vec<_>>(), mode)
}

fn only_in(pattern: &str, text: &str, mode: Mode) -> Vec<String> {
    let pcre = compile(pattern, mode).unwrap_or_else(|err| panic!("{pattern}: {err:?}"));
    let hay = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at <= hay.len() {
        let Some((start, end)) = pcre.find(hay, at).0.unwrap() else {
            break;
        };
        if end > start {
            found.push(String::from_utf8_lossy(&hay[start..end]).into_owned());
        }
        at = if end > at {
            end
        } else {
            at + pcre.unit_len(hay, at)
        };
    }
    found
}

fn only(pattern: &str, text: &str, unicode: bool) -> Vec<String> {
    only_in(
        pattern,
        text,
        Mode {
            unicode,
            ..Mode::default()
        },
    )
}

fn refusal(pattern: &str) -> (String, usize) {
    let bytes = Mode {
        bytes: true,
        ..Mode::default()
    };
    let err = compile(pattern, bytes).err().expect("a refusal");
    (err.message, err.offset)
}

// grep 3.11 -oP (PCRE2 10.46, no UCP) unless the row says unicode, which is
// ripgrep 14.1.1's -oP (PCRE2 10.43 with UTF and UCP).
#[test]
fn matches_as_pcre2() {
    let rows: &[(&str, &str, &[&str], bool)] = &[
        (r"\d+", "abc 123 x45", &["123", "45"], false),
        (r"(?<=id=)\d+", "id=42 name=x", &["42"], false),
        (r"name=\K\w+", "id=42 name=x", &["x"], false),
        (r"\x{00a0}", "a\u{a0}b", &["\u{a0}"], false),
        (r"\t", "a\tb", &["\t"], false),
        (r"\h", "a b", &[" "], false),
        (r"\Q.\E", "a.b", &["."], false),
        (r"\Q.b*", "a.b*c", &[".b*"], false),
        (r"(a)\g{1}", "aa", &["aa"], false),
        (r"(a)\g1", "aa", &["aa"], false),
        (r"(a)\g{-1}", "aa", &["aa"], false),
        (r"(?<x>a)\k<x>", "aa", &["aa"], false),
        ("(?P<x>a)(?P=x)", "aa", &["aa"], false),
        (r"(?'x'a)\k'x'", "aa", &["aa"], false),
        (r"(?<x>a)\k{x}", "aa", &["aa"], false),
        ("(?>a+)a", "aaa", &[], false),
        ("a++a", "aaa", &[], false),
        ("a*+", "aaa", &["aaa"], false),
        ("a?+a", "aaa", &["aa"], false),
        ("(?i)a", "Aa", &["A", "a"], false),
        ("(?i:A)a", "Aa", &["Aa"], false),
        ("a(?i)b", "Ab", &[], false),
        ("(?i)a(?-i)B", "AB", &["AB"], false),
        (r"\Aab\z", "ab", &["ab"], false),
        (r"\Aab\Z", "ab", &["ab"], false),
        (r"\w+", "aé", &["a"], false),
        (r"[[:alpha:]]+", "aé1", &["a"], false),
        (r"[\d]+", "ab12", &["12"], false),
        (r"[^\d]+", "ab12", &["ab"], false),
        (r"a\Kb|x", "ab", &["b"], false),
        (r"a\Ka", "aaa", &["a"], false),
        (r"foo=\K\d", "foo=1 foo=2", &["1", "2"], false),
        ("a(?#comment)b", "abc", &["ab"], false),
        ("(?x) a b # c", "abc", &["ab"], false),
        ("(?m)^a", "abc", &["a"], false),
        (r"\N", "aXb", &["a", "X", "b"], false),
        (r"\101", "A1", &["A"], false),
        ("[[:^alpha:]b]", "ab", &["b"], false),
        (r"\pL+", "ab", &["ab"], false),
        (r"\P{L}", "ab1", &["1"], false),
        (r"\p{L&}+", "ab", &["ab"], false),
        (r"\p{Xan}+", "ab1", &["ab1"], false),
        ("a{,2}", "aaa", &["aa", "a"], false),
        ("a{x}", "a{x}", &["a{x}"], false),
        ("a{,}", "a{,}", &["a{,}"], false),
        ("(?<=a|bc)x", "bcx ax", &["x", "x"], false),
        ("(a(?i)b|c)", "aC", &["C"], false),
        (r"(?x)a\ b", "a b", &["a b"], false),
        ("[[:<:]]a", "a", &["a"], false),
        ("(?i)a(?^)A", "aA", &["aA"], false),
        ("(*UTF)a", "a", &["a"], false),
        ("(?C1)a", "a", &["a"], false),
        ("(?=a)*a", "ab", &["a"], false),
        ("a{1,2}?", "aaa", &["a", "a", "a"], false),
        (r"\w+", "aé", &["aé"], true),
        (r"\d+", "a٣5", &["٣5"], true),
        (r"\s", "a\u{a0}b", &["\u{a0}"], true),
        (r"\s", "a\u{180e}b", &["\u{180e}"], true),
        (r"\w+", "a²b", &["a²b"], true),
        (r"\w+", "a\u{200c}b", &["a", "b"], true),
        ("[[:alpha:]]+", "aé", &["aé"], true),
        (r"\bé", "aé", &[], true),
        (r"\x{e9}", "aé", &["é"], true),
    ];
    for &(pattern, text, found, unicode) in rows {
        assert_eq!(
            only(pattern, text, unicode),
            found,
            "{pattern} over {text:?}"
        );
    }
}

#[test]
fn caseless_back_references_fold() {
    let caseless = Mode {
        ignore_case: true,
        ..Mode::default()
    };
    assert_eq!(only_in(r"(a)\1", "aA", caseless), ["aA"]);
    assert_eq!(only(r"(?i)(a)\1", "aA", false), ["aA"]);
    let unicode_caseless = Mode {
        unicode: true,
        ignore_case: true,
        ..Mode::default()
    };
    assert_eq!(only_in("é", "Éé", unicode_caseless), ["É", "é"]);
}

// ripgrep 14.1.1 -iP (with and without --no-pcre2-unicode) and grep 3.11
// -iP: a caseless negated set leaves out both cases of what it names.
#[test]
fn caseless_negated_sets_exclude_both_cases() {
    for (unicode, bytes) in [(true, false), (false, false), (false, true)] {
        let mode = Mode {
            unicode,
            bytes,
            ignore_case: true,
            ..Mode::default()
        };
        assert_eq!(only_in("[^a]+", "aAbB", mode), ["bB"]);
    }
    let unicode_caseless = Mode {
        unicode: true,
        ignore_case: true,
        ..Mode::default()
    };
    assert_eq!(only_in(r"[^\x{e9}]+", "aÉéb", unicode_caseless), ["a", "b"]);
}

#[test]
fn keep_of_an_unmatched_branch_is_skipped() {
    assert_eq!(
        only(r"foo=\K\d|a\Ka", "foo=1 foo=2 aaa", false),
        ["1", "2", "a"]
    );
}

#[test]
fn groups_number_as_the_pattern_does() {
    let pcre = compile(r"a\K(b)(?<n>c)", Mode::default()).unwrap();
    let mut groups = Vec::new();
    assert_eq!(pcre.captures(b"abc", 0, &mut groups).0, Ok(true));
    assert_eq!(groups, [Some((1, 3)), Some((1, 2)), Some((2, 3))]);
    assert_eq!(pcre.capture_names().collect::<Vec<_>>(), [("n", 2)]);
}

// grep prints the message after `grep: `; ripgrep adds the offset. Each
// offset is ripgrep 14.1.1's for `(?:PATTERN)` less the three characters of
// its wrapper.
#[test]
fn refusals_in_pcre2s_words() {
    let rows: &[(&str, &str, usize)] = &[
        ("(", "missing closing parenthesis", 1),
        ("(?:()", "missing closing parenthesis", 5),
        ("(?:a))", "unmatched closing parenthesis", 5),
        ("(?:[a)", "missing terminating ] for character class", 6),
        ("a\\", "\\ at end of pattern", 2),
        ("(?:*a)", "quantifier does not follow a repeatable item", 3),
        ("(?:a{2,1})", "numbers out of order in {} quantifier", 8),
        (
            "(?:(?<=a+)b)",
            "length of lookbehind assertion is not limited",
            3,
        ),
        ("(?:(a)\\2)", "reference to non-existent subpattern", 7),
        ("(?:(?z))", "unrecognized character after (? or (?-", 5),
        (
            "(?:\\x{110000})",
            "character code point value in \\x{} or \\o{} is too large",
            12,
        ),
        ("a**", "quantifier does not follow a repeatable item", 2),
        ("\\b*a", "quantifier does not follow a repeatable item", 2),
        ("a{2}{3}", "quantifier does not follow a repeatable item", 6),
        ("[\\d-z]", "invalid range in character class", 4),
        ("[z-a]", "range out of order in character class", 3),
        ("[[:foo:]]", "unknown POSIX class name", 8),
        (
            "\\x{zz}",
            "non-hex character in \\x{} (closing brace missing?)",
            3,
        ),
        (
            "\\o{8}",
            "non-octal character in \\o{} (closing brace missing?)",
            3,
        ),
        (
            "\\x",
            "digits missing after \\x or in \\x{} or \\o{} or \\N{U+}",
            2,
        ),
        ("\\y", "unrecognized character follows \\", 1),
        ("\\p", "malformed \\P or \\p sequence", 2),
        ("[\\N]", "\\N is not supported in a class", 3),
        ("a{65536}", "number too big in {} quantifier", 7),
        ("(?<", "subpattern name expected", 3),
        (
            "(?<a",
            "syntax error in subpattern name (missing terminator?)",
            4,
        ),
        ("(?<1a>x)", "subpattern name must start with a non-digit", 3),
        (
            "(?<a>x)(?<a>y)",
            "two named subpatterns have the same name (PCRE2_DUPNAMES not set)",
            12,
        ),
        ("\\k<zz>", "reference to non-existent subpattern", 3),
        ("(?#x", "missing ) after (?# comment", 4),
        (
            "(?<=a\\Kb)c",
            "\\K is not allowed in lookarounds (but see PCRE2_EXTRA_ALLOW_LOOKAROUND_BSK)",
            10,
        ),
        (
            "\\N{U+41}",
            "\\N{U+dddd} is supported only in Unicode (UTF) mode",
            2,
        ),
        ("\\c", "\\c at end of pattern", 2),
        ("\\8", "reference to non-existent subpattern", 1),
        ("(?", "missing closing parenthesis", 2),
        (
            "\\ga",
            "\\g is not followed by a braced, angle-bracketed, or quoted name/number or by a plain number",
            2,
        ),
    ];
    for &(pattern, message, offset) in rows {
        assert_eq!(refusal(pattern), (message.to_string(), offset), "{pattern}");
    }
}

#[test]
fn what_mirage_cannot_express_is_refused() {
    for pattern in [
        r"\Gab",
        r"\X",
        "(ab)(?1)",
        "(?R)?a",
        r"(a)\g<1>",
        "(?|(a)|(b))",
        "(a)(?(1)b|c)",
        r"\p{Greek}",
        "(?*a)",
        "(*SKIP)a",
    ] {
        assert!(
            refusal(pattern).0.ends_with("is not supported in mirage"),
            "{pattern}"
        );
    }
}

#[test]
fn bytes_mode_matches_a_byte_per_dot() {
    let pcre = compile(
        "^.$",
        Mode {
            bytes: true,
            ..Mode::default()
        },
    )
    .unwrap();
    assert_eq!(pcre.find(b"\xff", 0).0, Ok(Some((0, 1))));
    assert_eq!(pcre.find("é".as_bytes(), 0).0, Ok(None));
}

#[test]
fn utf8_mode_matches_a_character_per_dot_and_skips_invalid_bytes() {
    let pcre = compile("^.$", Mode::default()).unwrap();
    assert_eq!(pcre.find("é".as_bytes(), 0).0, Ok(Some((0, 2))));
    assert_eq!(pcre.find(b"\xff", 0).0, Ok(None));
}

#[test]
fn a_runaway_search_stops_at_the_limit() {
    let pcre = compile("^(a|a)+\\1c", Mode::default()).unwrap();
    let mut hay = vec![b'a'; 40];
    hay.extend_from_slice(b"xc");
    assert_eq!(pcre.find(&hay, 0), (Err(Exceeded), 10_000_000));
    let linear = compile("(a+)+$", Mode::default()).unwrap();
    assert_eq!(linear.find(&[b'a'; 40], 0), (Ok(Some((0, 40))), 1 << 8));
}

#[test]
fn a_costly_search_reports_the_limit_it_climbed_to() {
    let pcre = compile("^(a|a)+\\1c|x$", Mode::default()).unwrap();
    let mut hay = vec![b'a'; 16];
    hay.push(b'x');
    let (found, steps) = pcre.find(&hay, 0);
    assert_eq!(found, Ok(Some((16, 17))));
    assert!((1 << 16..10_000_000).contains(&steps), "{steps}");
}

#[test]
fn what_pcre2_takes_that_mirage_once_refused() {
    assert_eq!(only("(?<=a?b)c", "abc bc", false), ["c", "c"]);
    assert_eq!(only("(?<!x|y{2,3})b", "xb yyb zb", false), ["b"]);
    assert_eq!(only(r"(a)(?i)\1", "aA", false), ["aA"]);
    assert_eq!(only(r"\x{100}", "Ā", false), ["Ā"]);
    assert_eq!(only(r"\N{U+41}", "A", false), ["A"]);
    let caseless = Mode {
        ignore_case: true,
        ..Mode::default()
    };
    assert_eq!(only_in("(?i)é|x", "É", caseless), ["É"]);
}

#[test]
fn utf8_refusals_name_the_surrogates_and_long_lookbehinds() {
    let err = compile(r"\x{d800}", Mode::default()).err().unwrap();
    assert_eq!(
        (err.message.as_str(), err.offset),
        ("disallowed Unicode code point (>= 0xd800 && <= 0xdfff)", 7)
    );
    let err = compile("(?<=a{1,256})b", Mode::default()).err().unwrap();
    assert_eq!(
        (err.message.as_str(), err.offset),
        ("branch too long in variable-length lookbehind assertion", 0)
    );
    assert!(compile("(?<=a{300})b", Mode::default()).is_ok());
}

// grep 3.11 -P under C.UTF-8 and C and ripgrep 14.1.1 -P over k s K ſ K(U+212A)
// é -: case folding leaves type escapes alone, folds a POSIX class by ASCII
// only without UCP, and reads \p{Lu}, \p{Ll} and \p{Lt} as any cased letter.
#[test]
fn caseless_sets_fold_as_pcre2_does() {
    let lines = ["k", "s", "K", "ſ", "\u{212A}", "é", "-"];
    let utf = Mode::default();
    let bytes = Mode {
        bytes: true,
        ..Mode::default()
    };
    let ucp = Mode {
        unicode: true,
        ..Mode::default()
    };
    let rows: &[(&str, bool, Mode, &[usize])] = &[
        (r"(?i)^\W$", false, utf, &[3, 4, 5, 6]),
        (r"(?i)^[^\w]$", false, utf, &[3, 4, 5, 6]),
        (r"(?i)^\w$", false, utf, &[0, 1, 2]),
        (r"(?i)^[^[:alpha:]]$", false, utf, &[3, 4, 5, 6]),
        (r"(?i)^\P{Ll}$", false, utf, &[6]),
        (r"^\W$", true, utf, &[3, 4, 5, 6]),
        (r"^[^[:lower:]]$", true, utf, &[3, 4, 5, 6]),
        (r"^\p{Lu}$", true, utf, &[0, 1, 2, 3, 4, 5]),
        (r"^[[:upper:]]$", true, utf, &[0, 1, 2]),
        (r"(?i)^\W$", false, bytes, &[6]),
        (r"(?i)^\w$", false, bytes, &[0, 1, 2]),
        (r"^\p{Lu}$", true, bytes, &[0, 1, 2]),
        (r"^[^[:lower:]]$", true, bytes, &[6]),
        (r"(?i)^\W$", false, ucp, &[6]),
        (r"(?i)^\w$", false, ucp, &[0, 1, 2, 3, 4, 5]),
        (r"(?i)^[^[:alpha:]]$", false, ucp, &[6]),
        (r"^[^[:lower:]]$", true, ucp, &[2, 4, 6]),
        (r"^[[:upper:]]$", true, ucp, &[2, 4]),
        (r"^\P{Ll}$", true, ucp, &[6]),
    ];
    for &(pattern, ignore_case, mode, want) in rows {
        let mode = Mode {
            ignore_case,
            ..mode
        };
        let pcre = compile(pattern, mode).unwrap_or_else(|err| panic!("{pattern}: {err:?}"));
        let got: Vec<usize> = (0..lines.len())
            .filter(|&i| pcre.find(lines[i].as_bytes(), 0).0.unwrap().is_some())
            .collect();
        assert_eq!(got, want, "{pattern} ignore_case={ignore_case} {mode:?}");
    }
}

// grep 3.11 -P under C.UTF-8 with the pattern in a -f file.
#[test]
fn a_pattern_that_is_not_utf8_is_refused_in_pcre2s_words() {
    let rows: &[(&[u8], &str)] = &[
        (b"a\xffb", "illegal byte (0xfe or 0xff)"),
        (b"a\xc3", "1 byte missing at end"),
        (b"\xe3", "2 bytes missing at end"),
        (b"\xe3\x81A", "byte 3 top bits not 0x80"),
        (
            b"\xf8\x88\x80\x80\x80",
            "5-byte character is not allowed (RFC 3629)",
        ),
        (b"\xf8\x80\x80\x80\x80", "overlong 5-byte sequence"),
        (
            b"\xf4\x90\x80\x80",
            "code points greater than 0x10ffff are not defined",
        ),
        (b"\xed\xa0\x80", "code points 0xd800-0xdfff are not defined"),
        (b"\xc1\xbf", "overlong 2-byte sequence"),
        (b"ok\xbf", "isolated byte with 0x80 bit set"),
    ];
    for &(pattern, want) in rows {
        let err = pattern_chars(pattern, false).expect_err("a refusal");
        assert_eq!(err.message, format!("UTF-8 error: {want}"));
        assert!(pattern_chars(pattern, true).is_ok());
    }
}
