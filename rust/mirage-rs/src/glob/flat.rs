use super::compile::{Atom, Program, is};

enum Token {
    Star,
    Any,
    Literal(u32),
    Bracket { negate: bool, atoms: Vec<Atom> },
}

impl Token {
    fn accepts(&self, cp: u32) -> bool {
        match self {
            Self::Star | Self::Any => true,
            Self::Literal(unit) => *unit == cp,
            Self::Bracket { negate, atoms } => {
                atoms.iter().any(|atom| atom.contains(cp)) != *negate
            }
        }
    }
}

/// A pattern with no extglob group, as the evaluator reads it: every token
/// but a star takes one character, so a whole match needs no allocation
/// and only the last star seen as a point to retry from.
pub(super) struct Flat(Vec<Token>);

impl Flat {
    pub(super) fn new(program: &Program) -> Option<Self> {
        if program.extglob && !program.groups.is_empty() {
            return None;
        }
        let mut tokens = Vec::new();
        let mut state = 0;
        while let Some(&cp) = program.units.get(state) {
            if let Some(bracket) = program.brackets.get(&state) {
                tokens.push(Token::Bracket {
                    negate: bracket.negate && bracket.valid,
                    atoms: if bracket.valid {
                        bracket.atoms.clone()
                    } else {
                        Vec::new()
                    },
                });
                state = bracket.end;
                continue;
            }
            tokens.push(if is(cp, b'*') {
                Token::Star
            } else if is(cp, b'?') {
                Token::Any
            } else {
                Token::Literal(program.literal(cp))
            });
            state += 1;
        }
        Some(Self(tokens))
    }

    /// The one subject the pattern matches, when every token is a literal:
    /// a host compares names against it without a call.
    pub(super) fn literal(&self) -> Option<Vec<u32>> {
        self.0
            .iter()
            .map(|token| match token {
                Token::Literal(unit) => Some(*unit),
                _ => None,
            })
            .collect()
    }

    /// Whether `subject` matches whole; `period` keeps every wildcard off
    /// its first character.
    pub(super) fn matches(&self, subject: &[u32], period: bool) -> bool {
        let tokens = &self.0;
        if period
            && tokens
                .first()
                .is_some_and(|token| !matches!(token, Token::Literal(_)))
        {
            return false;
        }
        let (mut at, mut next) = (0, 0);
        let mut retry = None;
        loop {
            match tokens.get(at) {
                Some(Token::Star) => {
                    retry = Some((at + 1, next));
                    at += 1;
                    continue;
                }
                Some(token) if subject.get(next).is_some_and(|&cp| token.accepts(cp)) => {
                    at += 1;
                    next += 1;
                    continue;
                }
                None if next == subject.len() => return true,
                _ => {}
            }
            match retry {
                Some((star, from)) if from < subject.len() => {
                    retry = Some((star, from + 1));
                    at = star;
                    next = from + 1;
                }
                _ => return false,
            }
        }
    }
}
