use super::{Text, Whitespace};

pub(crate) fn whitespace(unit: u32, dialect: Whitespace) -> bool {
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

/// How many patterns one written pattern's groups may expand into.
pub const GROUP_CAP: usize = 64;

const OPEN: u32 = 123;
const CLOSE: u32 = 125;
const COMMA: u32 = 44;
const STAR: u32 = 42;
const SPACE: u32 = 32;

fn members(word: &[u32]) -> Result<Vec<Text>, String> {
    let Some(open) = word.iter().position(|&unit| unit == OPEN) else {
        if word.contains(&CLOSE) && word.contains(&COMMA) {
            return Err("a group has no opening brace or holds a space".into());
        }
        return Ok(vec![word.to_vec()]);
    };
    let Some(span) = word[open + 1..].iter().position(|&unit| unit == CLOSE) else {
        if word[open..].contains(&COMMA) {
            return Err("a group is not closed or holds a space".into());
        }
        return Ok(vec![word.to_vec()]);
    };
    let close = open + 1 + span;
    let inner = &word[open + 1..close];
    let (head, tail) = (&word[..open], members(&word[close + 1..])?);
    if inner.contains(&OPEN) {
        return Err("a group holds another group".into());
    }
    if !inner.contains(&COMMA) {
        return Ok(tail
            .into_iter()
            .map(|rest| [head, &word[open..=close], &rest].concat())
            .collect());
    }
    let mut out = Vec::new();
    for member in inner.split(|&unit| unit == COMMA) {
        if member.is_empty() {
            return Err("a group has an empty member".into());
        }
        if member.contains(&STAR) {
            return Err("a group member holds a *".into());
        }
        for rest in &tail {
            out.push([head, member, rest].concat());
            if out.len() > GROUP_CAP {
                return Err(format!("a group expands to more than {GROUP_CAP} patterns"));
            }
        }
    }
    Ok(out)
}

/// The patterns a written pattern stands for: each `{a,b}` group in a
/// word gives one pattern per member, in order (`gh pr {view,diff}` is
/// `gh pr view`, then `gh pr diff`). A group holds a comma, so `{}` and
/// `{x}` are words as written; it holds no space, no other group, no
/// empty member and no `*`, and one pattern expands to at most
/// `GROUP_CAP`. A pattern with no group is returned as written.
pub fn expand_pattern(pattern: &[u32], dialect: Whitespace) -> Result<Vec<Text>, String> {
    let words: Vec<&[u32]> = pattern
        .split(|&unit| whitespace(unit, dialect))
        .filter(|word| !word.is_empty())
        .collect();
    let mut choices = Vec::with_capacity(words.len());
    for word in &words {
        choices.push(members(word)?);
    }
    if choices.iter().all(|options| options.len() == 1) {
        return Ok(vec![pattern.to_vec()]);
    }
    let mut out: Vec<Text> = vec![Vec::new()];
    for options in choices {
        let mut next = Vec::with_capacity(out.len() * options.len());
        for done in &out {
            for option in &options {
                let mut text = done.clone();
                if !text.is_empty() {
                    text.push(SPACE);
                }
                text.extend_from_slice(option);
                next.push(text);
            }
        }
        if next.len() > GROUP_CAP {
            return Err(format!("a group expands to more than {GROUP_CAP} patterns"));
        }
        out = next;
    }
    Ok(out)
}

/// A written pattern's expansions, or the pattern itself when its
/// groups are malformed, which the document refuses before it gets here.
pub fn expanded(pattern: &[u32], dialect: Whitespace) -> Vec<Text> {
    expand_pattern(pattern, dialect).unwrap_or_else(|_| vec![pattern.to_vec()])
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

    fn expand(pattern: &str) -> Result<Vec<String>, String> {
        expand_pattern(&text(pattern), Whitespace::Python).map(|patterns| {
            patterns
                .iter()
                .map(|p| p.iter().map(|&u| char::from_u32(u).unwrap()).collect())
                .collect()
        })
    }

    #[test]
    fn a_group_expands_in_order_and_needs_a_comma() {
        assert_eq!(
            expand("gh pr {view,diff}").unwrap(),
            ["gh pr view", "gh pr diff"]
        );
        assert_eq!(
            expand("gh {pr,issue} {view,list}").unwrap(),
            ["gh pr view", "gh pr list", "gh issue view", "gh issue list"]
        );
        assert_eq!(
            expand("curl --request={PUT,PATCH}").unwrap(),
            ["curl --request=PUT", "curl --request=PATCH"]
        );
        assert_eq!(expand("find -exec rm {} ;").unwrap(), ["find -exec rm {} ;"]);
        assert_eq!(expand("awk {x}").unwrap(), ["awk {x}"]);
        assert_eq!(expand("git  status").unwrap(), ["git  status"]);
    }

    #[test]
    fn a_malformed_group_is_refused() {
        for bad in [
            "gh pr {view, diff}",
            "gh pr {view,diff",
            "gh {pr,{a,b}}",
            "gh pr {view,}",
            "gh {*,pr}",
        ] {
            assert!(expand(bad).is_err(), "{bad}");
        }
        let members: Vec<String> = (0..65).map(|n| format!("v{n}")).collect();
        let wide = format!("x {{{}}}", members.join(","));
        assert!(expand(&wide).unwrap_err().contains("64"));
        let square = "x {a,b,c,d,e,f,g,h} {a,b,c,d,e,f,g,h} {a,b}";
        assert!(expand(square).is_err());
        assert_eq!(expanded(&text("gh {a,"), Whitespace::Python), vec![text("gh {a,")]);
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
