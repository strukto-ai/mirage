use super::{Options, Regex, Search};
use crate::regex::unbounded;

/// Every match `pattern` finds in `hay` as jq's global loop walks it:
/// each group's byte span, group 0 first.
fn spans(pattern: &str, hay: &str, options: Options) -> Vec<Vec<Option<(usize, usize)>>> {
    let regex = Regex::new(pattern, options).expect("compiles");
    let mut out = Vec::new();
    let mut search = Search::new(0);
    loop {
        let found = unbounded(|budget| search.run(&regex, hay.as_bytes(), budget));
        let Some(region) = found.expect("no limit") else {
            break;
        };
        let (start, end) = region[0].expect("a match");
        out.push(region);
        let next = if start == end { end + 1 } else { end };
        if next > hay.len() {
            break;
        }
        search.restart(next);
    }
    out
}

fn strings(pattern: &str, hay: &str) -> Vec<String> {
    spans(pattern, hay, Options::default())
        .into_iter()
        .map(|region| {
            let (start, end) = region[0].expect("a match");
            hay[start..end].to_string()
        })
        .collect()
}

/// Every match ignoring case, as `i` sets it.
fn caseless(pattern: &str, hay: &str) -> Vec<String> {
    let options = Options {
        ignore_case: true,
        ..Options::default()
    };
    spans(pattern, hay, options)
        .into_iter()
        .map(|region| {
            let (start, end) = region[0].expect("a match");
            hay[start..end].to_string()
        })
        .collect()
}

fn error(pattern: &str) -> String {
    match Regex::new(pattern, Options::default()) {
        Ok(_) => panic!("{pattern} compiled"),
        Err(message) => message,
    }
}

#[test]
fn matches_are_leftmost_first() {
    assert_eq!(strings("ab|abcd", "ab abcd"), ["ab", "ab"]);
    assert_eq!(strings("a*?", "aaa"), ["", "", "", ""]);
    assert_eq!(strings("(?>a*)a", "aaa"), Vec::<String>::new());
    assert_eq!(strings("a++b", "aaab"), ["aaab"]);
    assert_eq!(strings("a{2}?", "aaaaaa"), ["aa", "aa", "aa"]);
    assert_eq!(strings("x{", "x{"), ["x{"]);
}

#[test]
fn the_longest_match_anywhere_wins_under_l() {
    let longest = Options {
        longest: true,
        ..Options::default()
    };
    let found = spans("ab|abcd", "ab abcd", longest);
    assert_eq!(found[0][0], Some((3, 7)));
}

#[test]
fn anchors_follow_perl_singleline() {
    assert_eq!(strings("^b", "a\nb"), Vec::<String>::new());
    assert_eq!(strings("(?m)^b", "a\nb"), ["b"]);
    assert_eq!(strings("a$", "a\n"), ["a"]);
    assert_eq!(strings("a$", "a\n\n"), Vec::<String>::new());
    assert_eq!(strings("\\bbar\\b", "foo bar"), ["bar"]);
}

#[test]
fn groups_and_backreferences() {
    let found = spans("(a)|b", "ab", Options::default());
    assert_eq!(found[1][1], None);
    assert_eq!(strings("(?<n>a)\\k<n>", "aa"), ["aa"]);
    assert_eq!(strings("(?<n>a)|(?<n>b)\\k<n>", "bb"), ["bb"]);
    let found = spans("(?:()|())*\\1\\2", "", Options::default());
    assert_eq!(found[0][1], Some((0, 0)));
    assert_eq!(found[0][2], Some((0, 0)));
}

#[test]
fn lookarounds() {
    assert_eq!(strings("(?=u)", "qux"), [""]);
    assert_eq!(strings("(?<=a+)b", "aab"), ["b"]);
    assert_eq!(strings("(?<!a)b", "ab b"), ["b"]);
    assert_eq!(error("(?<=a|bc)b"), "invalid pattern in look-behind");
    assert_eq!(error("(?<=a.*)b"), "invalid pattern in look-behind");
    assert_eq!(error("(?<!(a))b"), "invalid pattern in look-behind");
}

#[test]
fn a_character_folds_to_several_as_oniguruma_does() {
    let none: Vec<String> = Vec::new();
    assert_eq!(caseless("ss", "ß"), ["ß"]);
    assert_eq!(caseless("ß", "ss sſ SS ẞ"), ["ss", "sſ", "SS", "ẞ"]);
    assert_eq!(caseless("ẞ", "ß"), ["ß"]);
    assert_eq!(caseless("sss", "sß"), none);
    assert_eq!(caseless("sss", "ßs"), ["ßs"]);
    assert_eq!(caseless("^ffi$", "ﬃ"), ["ﬃ"]);
    assert_eq!(caseless("^ffi$", "ﬀi"), none);
    assert_eq!(caseless("^ﬀi$", "ﬃ"), none);
    assert_eq!(caseless("^i̇$", "İ"), ["İ"]);
    assert_eq!(caseless("^İ$", "i̇"), ["i̇"]);
    assert_eq!(caseless("^İ$", "i"), none);
    assert_eq!(caseless("^i$", "ı"), none);
    assert_eq!(caseless("ʼn", "ŉ"), ["ŉ"]);
    assert_eq!(caseless("s.", "ß"), none);
    assert_eq!(caseless("s\\w", "ß"), none);
    assert_eq!(caseless("\\p{Lower}\\p{Lower}", "ß"), none);
    assert_eq!(caseless("^k$", "K"), ["K"]);
}

/// Consecutive literals fold as one string, across `(?:...)`, `\Q...\E`
/// and `\x{...}`; a group, a quantifier or an option change ends the
/// run.
#[test]
fn a_caseless_run_folds_together_up_to_a_boundary() {
    let none: Vec<String> = Vec::new();
    for pattern in [
        "(?:s)s",
        "(?:(?:s)s)",
        "s(?:s)",
        "s\\Qs\\E",
        "\\x{73 73}",
        "ss{1}",
        "ss|x",
        "(?:ss)+",
        "s(?i)s",
    ] {
        assert_eq!(caseless(pattern, "ß"), ["ß"], "{pattern}");
    }
    for pattern in [
        "(s)s",
        "ss+",
        "ss?",
        "s{2}",
        "(?:s)+s",
        "(?i:s)s",
        "(?i)s(?-i)s",
    ] {
        assert_eq!(caseless(pattern, "ß"), none, "{pattern}");
    }
    assert_eq!(strings("(?i)ss", "ß"), ["ß"]);
    assert_eq!(strings("(?i:(?=a))*", "a"), ["", ""]);
}

/// A scoped option group around one character repeats as that character
/// does, and a look-behind still refuses one around a repeat, as jq does.
#[test]
fn a_scoped_option_group_repeats_as_its_character() {
    let hay = "a".repeat(2_100_000);
    assert_eq!(strings("^(?i:a)*$", &hay).len(), 1);
    assert_eq!(strings("(?<=(?:a+))b", "ab"), ["b"]);
    assert_eq!(error("(?<=(?i:a+))b"), "invalid pattern in look-behind");
}

#[test]
fn a_look_behind_folds_one_character_to_one() {
    let none: Vec<String> = Vec::new();
    assert_eq!(caseless("(?<=ss)$", "xß"), none);
    assert_eq!(caseless("(?<=ss)$", "xss"), [""]);
    assert_eq!(caseless("(?<=ß)$", "xẞ"), [""]);
    assert_eq!(caseless("(?<=ß)$", "xss"), none);
    assert_eq!(caseless("(?<=x)ß(?=y)", "xssy"), ["ss"]);
    assert_eq!(error("(?i)(?<=[ß])"), "invalid pattern in look-behind");
}

#[test]
fn a_class_folds_to_several_characters() {
    let none: Vec<String> = Vec::new();
    assert_eq!(caseless("^[ß]$", "ss"), ["ss"]);
    assert_eq!(caseless("[ß]", "SS sſ ẞ"), ["SS", "sſ", "ẞ"]);
    assert_eq!(caseless("^[ẞ]$", "ss"), ["ss"]);
    assert_eq!(caseless("^[ß-ẞ]$", "ss"), ["ss"]);
    assert_eq!(caseless("^[\\p{Lu}]$", "ss"), ["ss"]);
    assert_eq!(caseless("^\\p{Lu}$", "ss"), none);
    assert_eq!(caseless("^[[:upper:]]$", "ss"), ["ss"]);
    assert_eq!(caseless("^[ß&&ß]$", "ss"), ["ss"]);
    assert_eq!(caseless("^[^ß]$", "ss"), none);
    assert_eq!(caseless("^[^ß]$", "ẞ"), none);
    assert_eq!(caseless("^[^s]$", "ß"), ["ß"]);
    assert_eq!(caseless("[s]s", "ß"), none);
    assert_eq!(caseless("[ß]", "ssß"), ["ss", "ß"]);
    assert_eq!(caseless("[ß]", "ssx"), ["ss"]);
    assert_eq!(caseless("^[ﬁ]$", "fi"), ["fi"]);
    assert_eq!(caseless("^[ﬃ]$", "ffi"), ["ffi"]);
    assert_eq!(caseless("[ﬀﬃ]", "ffi"), ["ff"]);
    assert_eq!(caseless("^[ﬀ]i$", "ﬃ"), none);
    assert_eq!(caseless("[ß]{2}", "ssss"), ["ssss"]);
}

#[test]
fn a_backreference_compares_case_foldings() {
    let none: Vec<String> = Vec::new();
    assert_eq!(caseless("(ss)\\1", "ßß"), ["ßß"]);
    assert_eq!(caseless("(ss)\\1", "ßss"), none);
    assert_eq!(caseless("^(ß)\\1$", "ßss"), none);
    assert_eq!(caseless("^(s)\\1ß$", "ssß"), ["ssß"]);
    assert_eq!(caseless("^(ß)\\1$", "ßẞ"), none);
    assert_eq!(caseless("(ẞ)\\1", "ẞßx"), ["ẞß"]);
    assert_eq!(caseless("^(K)\\1$", "K\u{212a}"), none);
    assert_eq!(caseless("^(K)\\1$", "\u{212a}K"), none);
    assert_eq!(caseless("^(K)\\1$", "\u{212a}k"), none);
    assert_eq!(
        caseless("^(K)\\1$", "\u{212a}\u{212a}"),
        ["\u{212a}\u{212a}"]
    );
    assert_eq!(caseless("^(\u{212a})\\1$", "K\u{212a}"), none);
    assert_eq!(caseless("^(fi)\\1$", "ﬁﬁ"), ["ﬁﬁ"]);
    assert_eq!(caseless("^(fi)\\1$", "fiﬁ"), none);
    assert_eq!(caseless("^(σ)\\1$", "σς"), ["σς"]);
}

#[test]
fn errors_use_oniguruma_words() {
    assert_eq!(error("("), "end pattern with unmatched parenthesis");
    assert_eq!(error("a)"), "unmatched close parenthesis");
    assert_eq!(error("["), "premature end of char-class");
    assert_eq!(error("[]"), "empty char-class");
    assert_eq!(error("*a"), "target of repeat operator is not specified");
    assert_eq!(error("(?=a)*"), "target of repeat operator is invalid");
    assert_eq!(
        error("a{2,1}"),
        "upper is smaller than lower in repeat range"
    );
    assert_eq!(error("x{100001}"), "too big number for repeat range");
    assert_eq!(error("\\1"), "invalid backref number/name");
    assert_eq!(error("\\k<zz>"), "undefined name <zz> reference");
    assert_eq!(error("(?<1a>a)"), "invalid group name <1a>");
    assert_eq!(error("\\p{Foo}"), "invalid character property name {Foo}");
    assert_eq!(error("[[:foo:]]"), "invalid POSIX bracket type");
    assert_eq!(error("[z-a]"), "empty range in char class");
    assert_eq!(error("(?z)"), "undefined group option");
    assert_eq!(error("\\"), "end pattern at escape");
    assert_eq!(error("\\xc3"), "too short multibyte code string");
}

#[test]
fn a_pathological_pattern_stops_at_the_retry_limit() {
    let regex = Regex::new("^(a+)+$", Options::default()).unwrap();
    let hay = format!("{}!", "a".repeat(30));
    let mut search = Search::new(0);
    let found = unbounded(|budget| search.run(&regex, hay.as_bytes(), budget));
    assert_eq!(found, Err("retry-limit-in-match over"));
}

#[test]
fn a_search_pauses_and_resumes_with_the_same_answer() {
    let regex = Regex::new("(a|b)*c", Options::default()).unwrap();
    let hay = format!("{}c", "ab".repeat(500));
    let mut search = Search::new(0);
    let mut pauses = 0;
    let found = loop {
        let mut budget = 16;
        match search.run(&regex, hay.as_bytes(), &mut budget) {
            crate::regex::Step::Done(found) => break found,
            crate::regex::Step::Paused => pauses += 1,
        }
    };
    assert!(pauses > 10, "{pauses} pauses");
    assert_eq!(found.unwrap().unwrap()[0], Some((0, hay.len())));
}
