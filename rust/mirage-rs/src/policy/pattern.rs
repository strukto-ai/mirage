use super::{Text, Whitespace};

fn whitespace(unit: u32, dialect: Whitespace) -> bool {
    matches!(unit, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000)
        || match dialect {
            Whitespace::Python => matches!(unit, 0x1c..=0x1f | 0x85),
            Whitespace::EcmaScript => unit == 0xfeff,
        }
}

pub fn split_pattern(pattern: &[u32], dialect: Whitespace) -> Vec<Text> {
    let mut tokens: Vec<Text> = pattern
        .split(|&unit| whitespace(unit, dialect))
        .filter(|token| !token.is_empty())
        .map(<[u32]>::to_vec)
        .collect();
    while tokens.last().is_some_and(|token| token == &[42]) {
        tokens.pop();
    }
    tokens
}

pub fn pattern_matches(pattern: &[u32], tokens: &[Text], dialect: Whitespace) -> bool {
    let want = split_pattern(pattern, dialect);
    want.len() <= tokens.len() && prefix_matches(&want, tokens)
}

pub fn pattern_reaches(pattern: &[u32], tokens: &[Text], dialect: Whitespace) -> bool {
    prefix_matches(&split_pattern(pattern, dialect), tokens)
}

pub(crate) fn prefix_matches(want: &[Text], tokens: &[Text]) -> bool {
    want.iter()
        .zip(tokens)
        .all(|(word, token)| word == &[42] || word == token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> Text {
        value.chars().map(u32::from).collect()
    }

    #[test]
    fn prefix_patterns_and_host_whitespace() {
        let words = vec![text("git"), text("push"), text("origin")];
        assert!(pattern_matches(
            &text("git * *"),
            &words,
            Whitespace::Python
        ));
        assert!(!pattern_matches(
            &text("git pull"),
            &words,
            Whitespace::Python
        ));
        assert!(pattern_reaches(
            &text("git push"),
            &words[..1],
            Whitespace::Python
        ));
        assert_eq!(
            split_pattern(&text("git\u{85}push"), Whitespace::Python).len(),
            2
        );
        assert_eq!(
            split_pattern(&text("git\u{85}push"), Whitespace::EcmaScript).len(),
            1
        );
        assert_eq!(
            split_pattern(&text("git\u{feff}push"), Whitespace::Python).len(),
            1
        );
        assert_eq!(
            split_pattern(&text("git\u{feff}push"), Whitespace::EcmaScript).len(),
            2
        );
    }
}
