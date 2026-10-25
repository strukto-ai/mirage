use super::lex::{is_blank, is_space};
use super::parser::{Fail, Parser, R};

/// Unary operators of a conditional command, without their dash.
const UNARY: &[&[u8]] = &[
    b"a", b"b", b"c", b"d", b"e", b"f", b"g", b"h", b"k", b"p", b"r", b"s", b"t", b"u", b"w", b"x",
    b"G", b"L", b"N", b"O", b"S", b"z", b"n", b"o", b"v", b"R",
];

/// Binary operators of a conditional command.
const BINARY: &[&[u8]] = &[
    b"==", b"=", b"!=", b"<", b">", b"=~", b"-eq", b"-ne", b"-lt", b"-le", b"-gt", b"-ge", b"-ef",
    b"-nt", b"-ot",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Token {
    And,
    Or,
    Not,
    Open,
    Close,
    Less,
    Greater,
    Newline,
    End,
    /// A word and its span.
    Word(usize, usize),
}

/// bash's grammar for the inside of `[[ ... ]]`, checked over the text
/// the tree was built from: the grammar's expression rules take more
/// than bash does, so a tree alone cannot tell a refused line.
struct Cond<'p, 'a> {
    parser: &'p Parser<'a>,
    at: usize,
    end: usize,
}

impl Cond<'_, '_> {
    pub(super) fn fail<T>(&self, at: usize) -> R<T> {
        Err(Fail {
            at,
            message: "syntax error in conditional expression".into(),
        })
    }

    fn text(&self, start: usize, end: usize) -> &[u8] {
        &self.parser.s[start..end]
    }

    /// The next token, the cursor left after it.
    pub(super) fn next(&mut self) -> R<Token> {
        let s = self.parser.s;
        while self.at < self.end && is_blank(s[self.at]) {
            self.at += 1;
        }
        if self.at >= self.end {
            return Ok(Token::End);
        }
        let at = self.at;
        let rest = &s[at..self.end];
        let (token, len) = if rest.starts_with(b"&&") {
            (Token::And, 2)
        } else if rest.starts_with(b"||") {
            (Token::Or, 2)
        } else if rest[0] == b'\n' {
            (Token::Newline, 1)
        } else if rest[0] == b'(' {
            (Token::Open, 1)
        } else if rest[0] == b')' {
            (Token::Close, 1)
        } else if rest[0] == b'<' && rest.get(1) != Some(&b'(') {
            (Token::Less, 1)
        } else if rest[0] == b'>' && rest.get(1) != Some(&b'(') {
            (Token::Greater, 1)
        } else if rest[0] == b'!' && rest.get(1).is_none_or(|byte| is_space(*byte)) {
            (Token::Not, 1)
        } else if matches!(rest[0], b';' | b'&' | b'|')
            || (matches!(rest[0], b'<' | b'>') && rest.get(1) != Some(&b'('))
        {
            return self.fail(at);
        } else {
            let word_end = self.word_end(at)?;
            if &s[at..word_end] == b"]]" {
                return self.fail(at);
            }
            self.at = word_end;
            return Ok(Token::Word(at, word_end));
        };
        self.at = at + len;
        Ok(token)
    }

    /// Where a word starting at `at` ends; an extglob's `(...)` is part
    /// of it.
    fn word_end(&self, at: usize) -> R<usize> {
        let s = self.parser.s;
        let mut probe = self.parser.probe(at);
        let mut end = match probe.literal_opt(super::word::Ctx::default())? {
            Some(_) => probe.i,
            None => return self.fail(at),
        };
        while s.get(end) == Some(&b'(')
            && end > at
            && matches!(s[end - 1], b'@' | b'!' | b'*' | b'+' | b'?')
        {
            let mut depth = 0usize;
            let mut close = end;
            loop {
                match s.get(close) {
                    None => return self.fail(end),
                    Some(b'(') => depth += 1,
                    Some(b')') => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    Some(b'\\') => close += 1,
                    Some(&quote @ (b'\'' | b'"' | b'`')) => {
                        close = super::lex::quote_end(s, close, quote)
                            .ok_or_else(|| self.parser.unexpected(s.len()))?
                            - 1;
                    }
                    _ => {}
                }
                close += 1;
            }
            end = close + 1;
            let mut probe = self.parser.probe(end);
            if probe.concat_continues(super::word::Ctx::default())
                && probe.literal_opt(super::word::Ctx::default())?.is_some()
            {
                end = probe.i;
            }
        }
        Ok(end)
    }

    /// The next token, newlines skipped where bash allows them.
    fn next_skipping(&mut self) -> R<Token> {
        loop {
            let token = self.next()?;
            if token != Token::Newline {
                return Ok(token);
            }
        }
    }

    fn or(&mut self, first: Token) -> R<Token> {
        let mut after = self.and(first)?;
        while after == Token::Or {
            let next = self.next_skipping()?;
            after = self.and(next)?;
        }
        Ok(after)
    }

    fn and(&mut self, first: Token) -> R<Token> {
        let mut after = self.term(first)?;
        while after == Token::And {
            let next = self.next_skipping()?;
            after = self.term(next)?;
        }
        Ok(after)
    }

    /// One term from `first`; returns the token after it.
    fn term(&mut self, first: Token) -> R<Token> {
        match first {
            Token::Not => {
                let next = self.next_skipping()?;
                self.term(next)
            }
            Token::Open => {
                let next = self.next_skipping()?;
                let close = self.or(next)?;
                if close != Token::Close {
                    return self.fail(self.at);
                }
                self.next_skipping()
            }
            Token::Word(start, end) => {
                let word = self.text(start, end);
                if word.len() > 1 && word[0] == b'-' && UNARY.contains(&&word[1..]) {
                    let operand = self.next()?;
                    if let Token::Word(..) = operand {
                        return self.next_skipping();
                    }
                    if !matches!(operand, Token::End | Token::And | Token::Or | Token::Close) {
                        return self.fail(self.at);
                    }
                    return self.fail(start);
                }
                let after = self.next()?;
                match after {
                    Token::End | Token::And | Token::Or | Token::Close => Ok(after),
                    Token::Less | Token::Greater => self.right(false),
                    Token::Word(op_start, op_end)
                        if BINARY.contains(&self.text(op_start, op_end)) =>
                    {
                        let regex = self.text(op_start, op_end) == b"=~";
                        self.right(regex)
                    }
                    _ => self.fail(self.at),
                }
            }
            _ => self.fail(self.at),
        }
    }

    /// A binary operator's right side, and the token after it.
    fn right(&mut self, regex: bool) -> R<Token> {
        if regex {
            return self.regex();
        }
        match self.next()? {
            Token::Word(..) => {}
            _ => return self.fail(self.at),
        }
        let after = self.next_skipping()?;
        match after {
            Token::End | Token::And | Token::Or | Token::Close => Ok(after),
            _ => self.fail(self.at),
        }
    }

    /// The word after `=~`: up to a blank or `&` outside parentheses,
    /// where a `;` or redirection operator outside them is refused. A
    /// `&&` right after the operator leaves the regex empty.
    fn regex(&mut self) -> R<Token> {
        let s = self.parser.s;
        while self.at < self.end && is_blank(s[self.at]) {
            self.at += 1;
        }
        if s[self.at..self.end].starts_with(b"&&") {
            return self.next();
        }
        let start = self.at;
        let mut depth = 0usize;
        while self.at < self.end {
            match s[self.at] {
                b'\\' => self.at += 1,
                b'\'' | b'"' => {
                    self.at = super::lex::quote_end(s, self.at, s[self.at]).unwrap_or(self.end) - 1;
                }
                b'$' if matches!(s.get(self.at + 1), Some(b'(' | b'{')) => {
                    let mut probe = self.parser.probe(self.at);
                    let parsed = if s[self.at + 1] == b'(' {
                        probe.command_substitution()
                    } else {
                        probe.expansion()
                    };
                    if parsed.is_err() {
                        return self.fail(self.at);
                    }
                    self.at = probe.i;
                    continue;
                }
                b'(' => depth += 1,
                b')' if depth > 0 => depth -= 1,
                b')' | b'&' if depth == 0 => break,
                b';' | b'<' | b'>' if depth == 0 => return self.fail(self.at),
                byte if is_space(byte) && depth == 0 => break,
                _ => {}
            }
            self.at += 1;
        }
        if self.at == start {
            return self.fail(start);
        }
        let after = self.next_skipping()?;
        match after {
            Token::End | Token::And | Token::Or | Token::Close => Ok(after),
            _ => self.fail(self.at),
        }
    }
}

impl Parser<'_> {
    /// Check `start..end`, the inside of a `[[ ... ]]`, against bash's
    /// conditional grammar.
    pub(super) fn check_conditional(&self, start: usize, end: usize) -> R<()> {
        let mut cond = Cond {
            parser: self,
            at: start,
            end,
        };
        let first = cond.next_skipping()?;
        if first == Token::End {
            return cond.fail(start);
        }
        let after = cond.or(first)?;
        if after != Token::End {
            return cond.fail(cond.at);
        }
        Ok(())
    }
}
