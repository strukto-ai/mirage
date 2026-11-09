//! `--transform`: the sed-style expressions that rewrite member names, as
//! tar 1.35 reads and applies them.

use crate::regex::Step;
use crate::regex::parse::Dialect;
use crate::regex::posix::{Options, Posix, Spans, Walk};

/// What a name stands for, which an expression's scope flags can leave out.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Scope {
    Regular,
    Symlink,
}

enum Part {
    Text(Vec<u8>),
    Group(usize),
    Case(u8),
}

struct Rule {
    regex: Posix,
    parts: Vec<Part>,
    global: bool,
    occurrence: usize,
    regular: bool,
    symlink: bool,
}

/// The expressions of a run, applied in the order typed.
#[derive(Default)]
pub(super) struct Transforms {
    rules: Vec<Rule>,
}

const INVALID: &[u8] = b"Invalid transform expression";

/// The text up to the next unescaped `delimiter`, its escaped delimiters
/// unescaped, and what follows it.
fn delimited(text: &[u8], delimiter: u8) -> Option<(Vec<u8>, &[u8])> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < text.len() {
        match text[at] {
            b'\\' if text.get(at + 1) == Some(&delimiter) => {
                out.push(delimiter);
                at += 2;
            }
            b'\\' if at + 1 < text.len() => {
                out.extend_from_slice(&text[at..at + 2]);
                at += 2;
            }
            byte if byte == delimiter => return Some((out, &text[at + 1..])),
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    None
}

fn replacement(raw: &[u8], groups: usize) -> Result<Vec<Part>, Vec<u8>> {
    let mut parts = Vec::new();
    let mut literal = Vec::new();
    let mut at = 0;
    while at < raw.len() {
        let next = raw.get(at + 1).copied();
        match (raw[at], next) {
            (b'&', _) => {
                parts.push(Part::Text(std::mem::take(&mut literal)));
                parts.push(Part::Group(0));
                at += 1;
            }
            (b'\\', Some(digit)) if digit.is_ascii_digit() => {
                let group = usize::from(digit - b'0');
                if group > groups {
                    return Err(
                        b"Invalid transform replacement: back reference out of range".to_vec(),
                    );
                }
                parts.push(Part::Text(std::mem::take(&mut literal)));
                parts.push(Part::Group(group));
                at += 2;
            }
            (b'\\', Some(case)) if b"LUluE".contains(&case) => {
                parts.push(Part::Text(std::mem::take(&mut literal)));
                parts.push(Part::Case(case));
                at += 2;
            }
            (b'\\', Some(escaped)) => {
                literal.push(match escaped {
                    b'n' => b'\n',
                    b't' => b'\t',
                    other => other,
                });
                at += 2;
            }
            (byte, _) => {
                literal.push(byte);
                at += 1;
            }
        }
    }
    parts.push(Part::Text(literal));
    Ok(parts)
}

/// One expression and what follows its `;`.
fn rule(text: &[u8]) -> Result<(Rule, &[u8]), Vec<u8>> {
    let (Some(b's'), Some(&delimiter)) = (text.first().copied(), text.get(1)) else {
        return Err(INVALID.to_vec());
    };
    let (pattern, rest) = delimited(&text[2..], delimiter).ok_or_else(|| INVALID.to_vec())?;
    let (raw, mut rest) = delimited(rest, delimiter).ok_or_else(|| INVALID.to_vec())?;
    let (mut global, mut ignore_case, mut extended) = (false, false, false);
    let (mut regular, mut symlink) = (true, true);
    let mut occurrence = 0usize;
    while let Some((&flag, tail)) = rest.split_first() {
        rest = tail;
        match flag {
            b';' => break,
            b'g' => global = true,
            b'i' => ignore_case = true,
            b'x' => extended = true,
            b'r' | b's' | b'h' | b'H' => {
                if flag == b's' {
                    symlink = true;
                } else if flag == b'r' {
                    regular = true;
                }
            }
            b'R' => regular = false,
            b'S' => symlink = false,
            b'0'..=b'9' => {
                occurrence = occurrence
                    .saturating_mul(10)
                    .saturating_add(usize::from(flag - b'0'));
            }
            other => {
                return Err([
                    b"Unknown flag in transform expression: ".as_slice(),
                    &[other],
                ]
                .concat());
            }
        }
    }
    let options = Options {
        extended,
        dialect: Dialect::Sed,
        ignore_case,
        utf8: false,
        multiline: false,
        word: false,
    };
    let regex = Posix::compile(&pattern, &options)
        .map_err(|_| b"Invalid transform expression: Invalid regular expression".to_vec())?;
    let parts = replacement(&raw, regex.groups())?;
    let rule = Rule {
        regex,
        parts,
        global,
        occurrence: occurrence.max(1),
        regular,
        symlink,
    };
    Ok((rule, rest))
}

fn expand(parts: &[Part], name: &[u8], groups: &Spans, out: &mut Vec<u8>) {
    let (mut mode, mut pending) = (None::<bool>, None::<bool>);
    for part in parts {
        let text = match part {
            Part::Case(b'u') => {
                pending = Some(true);
                continue;
            }
            Part::Case(b'l') => {
                pending = Some(false);
                continue;
            }
            Part::Case(case) => {
                mode = (*case != b'E').then_some(*case == b'U');
                pending = None;
                continue;
            }
            Part::Group(group) => match groups.get(*group).copied().flatten() {
                Some((start, end)) => &name[start..end],
                None => b"".as_slice(),
            },
            Part::Text(text) => text,
        };
        for &byte in text {
            let upper = pending.take().or(mode);
            out.push(match upper {
                Some(true) => byte.to_ascii_uppercase(),
                Some(false) => byte.to_ascii_lowercase(),
                None => byte,
            });
        }
    }
}

impl Rule {
    fn apply(&mut self, name: &[u8]) -> Option<Vec<u8>> {
        let (mut out, mut at, mut seen, mut replaced) = (Vec::new(), 0, 0, false);
        let mut walk = Walk::default();
        loop {
            let mut budget = u64::MAX;
            let Step::Done(Some(groups)) = self.regex.next(name, &mut walk, &mut budget) else {
                break;
            };
            seen += 1;
            if seen < self.occurrence {
                continue;
            }
            let (start, end) = groups[0].unwrap_or((at, at));
            out.extend_from_slice(&name[at..start]);
            expand(&self.parts, name, &groups, &mut out);
            at = end;
            replaced = true;
            if !self.global {
                break;
            }
        }
        replaced.then(|| {
            out.extend_from_slice(&name[at..]);
            out
        })
    }
}

impl Transforms {
    /// The expressions of one `--transform`, or the words of its refusal.
    pub(super) fn add(&mut self, mut text: &[u8]) -> Result<(), Vec<u8>> {
        while !text.is_empty() {
            let (rule, rest) = rule(text)?;
            self.rules.push(rule);
            text = rest;
        }
        Ok(())
    }

    pub(super) fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// `name` as the expressions whose scope takes it leave it.
    pub(super) fn apply(&mut self, name: &[u8], scope: Scope) -> Vec<u8> {
        let mut name = name.to_vec();
        for rule in &mut self.rules {
            let applies = match scope {
                Scope::Regular => rule.regular,
                Scope::Symlink => rule.symlink,
            };
            if applies {
                if let Some(changed) = rule.apply(&name) {
                    name = changed;
                }
            }
        }
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(exprs: &[&str], name: &str, scope: Scope) -> String {
        let mut transforms = Transforms::default();
        for expr in exprs {
            transforms.add(expr.as_bytes()).unwrap();
        }
        String::from_utf8(transforms.apply(name.as_bytes(), scope)).unwrap()
    }

    fn refused(expr: &str) -> String {
        let error = Transforms::default().add(expr.as_bytes()).unwrap_err();
        String::from_utf8(error).unwrap()
    }

    #[test]
    fn expressions_run_in_order_and_take_their_flags() {
        assert_eq!(apply(&["s,^d,e,"], "d/a.txt", Scope::Regular), "e/a.txt");
        assert_eq!(
            apply(&["s/a/X/g;s/b/Y/"], "d/sub/b.txt", Scope::Regular),
            "d/suY/b.txt"
        );
        assert_eq!(
            apply(&["s/.*txt/&.b/", "s/^d/q/"], "d/a.txt", Scope::Regular),
            "q/a.txt.b"
        );
        assert_eq!(
            apply(&["s/A/z/i", "s/a/k/2"], "d/a.txt", Scope::Regular),
            "d/z.txt"
        );
        assert_eq!(apply(&["s/\\(a\\)/\\U\\1/"], "d/a", Scope::Regular), "d/A");
    }

    #[test]
    fn scope_flags_leave_out_what_they_name() {
        assert_eq!(apply(&["s/c/Z/"], "c.log", Scope::Symlink), "Z.log");
        assert_eq!(apply(&["s/c/Z/S"], "c.log", Scope::Symlink), "c.log");
        assert_eq!(apply(&["s/c/Z/R"], "c.log", Scope::Regular), "c.log");
    }

    #[test]
    fn a_bad_expression_is_refused_in_tars_words() {
        assert_eq!(refused("s/a"), "Invalid transform expression");
        assert_eq!(refused("x/a/b/"), "Invalid transform expression");
        assert_eq!(
            refused("s/a/b/q"),
            "Unknown flag in transform expression: q"
        );
        assert_eq!(
            refused("s/[/b/"),
            "Invalid transform expression: Invalid regular expression"
        );
        assert_eq!(
            refused("s,\\(.*\\)\\.txt,\\1.md,x"),
            "Invalid transform replacement: back reference out of range"
        );
    }
}
