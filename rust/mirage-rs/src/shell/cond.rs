use super::parser::{Fail, Parser, R, line};

/// Unary operators of a conditional command.
const UNARY: &[&[u8]] = &[
    b"-a", b"-b", b"-c", b"-d", b"-e", b"-f", b"-g", b"-h", b"-k", b"-p", b"-r", b"-s", b"-t",
    b"-u", b"-w", b"-x", b"-G", b"-L", b"-N", b"-O", b"-S", b"-z", b"-n", b"-o", b"-v", b"-R",
];

/// Binary operators of a conditional command spelled as words.
const BINARY: &[&[u8]] = &[
    b"==", b"=", b"!=", b"=~", b"-eq", b"-ne", b"-lt", b"-le", b"-gt", b"-ge", b"-nt", b"-ot",
    b"-ef",
];

/// Every operator bash reads, longest first.
const OPERATORS: &[&[u8]] = &[
    b";;&", b"&>>", b"<<<", b"<<-", b";;", b";&", b"&&", b"||", b"|&", b"&>", b"<<", b">>", b"<&",
    b">&", b"<>", b">|", b";", b"&", b"|", b"<", b">", b"(", b")",
];

/// Bytes that end an unquoted word.
fn word_break(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')' | b'<' | b'>')
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Word,
    Op,
    Newline,
    Eof,
}

#[derive(Clone, Copy)]
struct Tok {
    kind: Kind,
    start: usize,
    end: usize,
    /// No quote, escape or expansion in it.
    plain: bool,
}

/// What stops a conditional: a refusal from inside a word, or one of the
/// conditional's own, which bash words as its own lines and then the text
/// it stopped at.
enum Stop {
    Refused(Fail),
    Test { lines: Vec<Vec<u8>>, at: Tok, eof: bool },
}

impl From<Fail> for Stop {
    fn from(fail: Fail) -> Self {
        Stop::Refused(fail)
    }
}

type S<T> = Result<T, Stop>;

fn test<T>(line: Vec<u8>, at: Tok) -> S<T> {
    Err(Stop::Test {
        lines: vec![line],
        at,
        eof: at.kind == Kind::Eof,
    })
}

/// bash's reading of `[[ ... ]]`, which refuses what the tree's grammar
/// takes and words its refusals in a family of its own.
struct Cond<'p, 'a> {
    parser: &'p Parser<'a>,
    pos: usize,
    /// The newline bash supposes at the end of the input was read.
    ended: bool,
    /// How many `(` groups enclose the cursor.
    depth: usize,
}

impl Cond<'_, '_> {
    fn s(&self) -> &[u8] {
        self.parser.s
    }

    fn n(&self) -> usize {
        self.parser.s.len()
    }

    fn byte(&self, at: usize) -> u8 {
        self.s().get(at).copied().unwrap_or(0)
    }

    fn char_at(&self, at: usize) -> u8 {
        self.parser.char_at(at)
    }

    fn text(&self, tok: Tok) -> Vec<u8> {
        match tok.kind {
            Kind::Newline => b"newline".to_vec(),
            Kind::Eof => b"EOF".to_vec(),
            _ => {
                let raw = &self.s()[tok.start..tok.end];
                let mut out = Vec::with_capacity(raw.len());
                let mut at = 0;
                while at < raw.len() {
                    if raw[at..].starts_with(b"\\\n") {
                        at += 2;
                        continue;
                    }
                    out.push(raw[at]);
                    at += 1;
                }
                out
            }
        }
    }

    /// A line with the token's text between `before` and `after`.
    fn naming(&self, before: &str, tok: Tok, after: &str) -> Vec<u8> {
        line(&[before.as_bytes(), &self.text(tok), after.as_bytes()])
    }

    fn is(&self, tok: Tok, kind: Kind, text: &[u8]) -> bool {
        tok.kind == kind && self.text(tok) == text
    }

    fn is_close(&self, tok: Tok) -> bool {
        tok.kind == Kind::Word && tok.plain && self.text(tok) == b"]]"
    }

    fn blank_end(&self, mut at: usize) -> usize {
        loop {
            if at < self.n() && matches!(self.s()[at], b' ' | b'\t') {
                at += 1;
            } else if self.s()[at.min(self.n())..].starts_with(b"\\\n") {
                at += 2;
            } else {
                return at;
            }
        }
    }

    fn extglob_at(&self, j: usize) -> bool {
        matches!(self.byte(j), b'@' | b'!' | b'+' | b'*' | b'?') && self.byte(j + 1) == b'('
    }

    // -- tokens ---------------------------------------------------------

    fn lex(&self, mut at: usize) -> R<Tok> {
        loop {
            at = self.blank_end(at);
            if self.byte(at) == b'#' && at < self.n() {
                at = memchr::memchr(b'\n', &self.s()[at..]).map_or(self.n(), |offset| at + offset);
                continue;
            }
            break;
        }
        if at >= self.n() {
            let kind = if self.ended { Kind::Eof } else { Kind::Newline };
            return Ok(Tok {
                kind,
                start: self.n(),
                end: self.n(),
                plain: true,
            });
        }
        let byte = self.s()[at];
        if byte == b'\n' {
            return Ok(Tok {
                kind: Kind::Newline,
                start: at,
                end: at + 1,
                plain: true,
            });
        }
        if matches!(byte, b'<' | b'>') && self.char_at(at + 1) == b'(' {
            return self.word(at);
        }
        if let Some(end) = self.operator(at) {
            return Ok(Tok {
                kind: Kind::Op,
                start: at,
                end,
                plain: true,
            });
        }
        self.word(at)
    }

    /// Where the operator at `at` ends, continued lines joined.
    fn operator(&self, at: usize) -> Option<usize> {
        let mut spelled = Vec::new();
        let mut ends = Vec::new();
        let mut j = at;
        while spelled.len() < 3 && j < self.n() {
            if self.s()[j..].starts_with(b"\\\n") {
                j += 2;
                continue;
            }
            if !matches!(self.s()[j], b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')' | b'-') {
                break;
            }
            spelled.push(self.s()[j]);
            j += 1;
            ends.push(j);
        }
        OPERATORS
            .iter()
            .find(|op| spelled.starts_with(op))
            .map(|op| ends[op.len() - 1])
    }

    fn word(&self, at: usize) -> R<Tok> {
        let mut j = at;
        let mut plain = true;
        while j < self.n() {
            let byte = self.s()[j];
            if byte == b'\\' {
                if self.byte(j + 1) != b'\n' {
                    plain = false;
                }
                j += 2;
                continue;
            }
            if self.parser.options.extglob && self.extglob_at(j) {
                j = self.parser.scan_extended_pattern(j)?;
                plain = false;
                continue;
            }
            if word_break(byte) {
                if matches!(byte, b'<' | b'>') && self.char_at(j + 1) == b'(' {
                    j = self.parser.scan_process_substitution(j)?;
                    plain = false;
                    continue;
                }
                break;
            }
            if matches!(byte, b'\'' | b'"' | b'`' | b'$') {
                plain = false;
            }
            j = self.parser.scan_word_char(j)?;
        }
        Ok(Tok {
            kind: Kind::Word,
            start: at,
            end: j.min(self.n()),
            plain,
        })
    }

    fn peek(&self) -> R<Tok> {
        self.lex(self.pos)
    }

    fn take(&mut self, tok: Tok) {
        self.pos = tok.end;
        if tok.kind == Kind::Newline && tok.start == tok.end {
            self.ended = true;
        }
    }

    fn linebreak(&mut self) -> R<()> {
        loop {
            let tok = self.peek()?;
            if tok.kind != Kind::Newline {
                return Ok(());
            }
            self.take(tok);
        }
    }

    // -- the grammar ----------------------------------------------------

    /// The next token, newlines skipped.
    fn test_peek(&mut self) -> R<Tok> {
        self.linebreak()?;
        self.peek()
    }

    /// The token after a whole test; ending inside a quote there, bash
    /// adds that it was looking for `]]`.
    fn test_after(&mut self) -> S<Tok> {
        if self.depth > 0 {
            return Ok(self.test_peek()?);
        }
        operand("unexpected EOF while looking for `]]'", self.test_peek())
    }

    fn test_close(&mut self) -> S<()> {
        let tok = self.test_after()?;
        if self.is_close(tok) {
            self.take(tok);
            return Ok(());
        }
        if tok.kind == Kind::Eof {
            return Err(Stop::Test {
                lines: vec!["unexpected EOF while looking for `]]'".into()],
                at: tok,
                eof: true,
            });
        }
        if tok.kind == Kind::Word {
            return test("syntax error in conditional expression".into(), tok);
        }
        test(
            self.naming("syntax error in conditional expression: unexpected token `", tok, "'"),
            tok,
        )
    }

    fn test_or(&mut self) -> S<()> {
        self.test_and()?;
        loop {
            let tok = self.test_after()?;
            if !self.is(tok, Kind::Op, b"||") {
                return Ok(());
            }
            self.take(tok);
            self.test_and()?;
        }
    }

    fn test_and(&mut self) -> S<()> {
        self.test_term()?;
        loop {
            let tok = self.test_after()?;
            if !self.is(tok, Kind::Op, b"&&") {
                return Ok(());
            }
            self.take(tok);
            self.test_term()?;
        }
    }

    fn test_term(&mut self) -> S<()> {
        let mut tok = self.test_peek()?;
        let mut bangs = 0;
        while tok.kind == Kind::Word && tok.plain && self.text(tok) == b"!" {
            bangs += 1;
            if bangs >= super::parser::MAX_SCAN {
                return Err(Stop::Refused(self.parser.too_deep()));
            }
            self.take(tok);
            tok = self.test_peek()?;
        }
        if tok.kind == Kind::Eof {
            return Err(Stop::Test {
                lines: vec!["unexpected token `EOF' in conditional command".into()],
                at: tok,
                eof: true,
            });
        }
        if self.is_close(tok) {
            return Err(Stop::Test {
                lines: Vec::new(),
                at: tok,
                eof: false,
            });
        }
        if self.is(tok, Kind::Op, b"(") {
            return self.test_group(tok);
        }
        if tok.kind != Kind::Word {
            return test(
                self.naming("unexpected token `", tok, "' in conditional command"),
                tok,
            );
        }
        if tok.plain && UNARY.contains(&self.text(tok).as_slice()) {
            self.take(tok);
            let arg = operand(
                "unexpected argument to conditional unary operator",
                self.peek(),
            )?;
            if arg.kind != Kind::Word || self.is_close(arg) {
                return test(
                    self.naming("unexpected argument `", arg, "' to conditional unary operator"),
                    arg,
                );
            }
            self.take(arg);
            return Ok(());
        }
        self.take(tok);
        let op = operand("conditional binary operator expected", self.peek())?;
        let text = self.text(op);
        let binary = (op.kind == Kind::Word && op.plain && BINARY.contains(&text.as_slice()))
            || (op.kind == Kind::Op && matches!(text.as_slice(), b"<" | b">"));
        if binary {
            self.take(op);
            let arg = match text.as_slice() {
                b"=~" => self.regex_word(),
                b"==" | b"=" | b"!=" => self.pattern_word(),
                _ => self.peek(),
            };
            let arg = operand("unexpected argument to conditional binary operator", arg)?;
            if arg.kind != Kind::Word || self.is_close(arg) {
                return test(
                    self.naming("unexpected argument `", arg, "' to conditional binary operator"),
                    arg,
                );
            }
            self.take(arg);
            return Ok(());
        }
        if (op.kind == Kind::Op && matches!(text.as_slice(), b"&&" | b"||" | b")"))
            || self.is_close(op)
        {
            return Ok(());
        }
        if op.kind == Kind::Word {
            return test("conditional binary operator expected".into(), op);
        }
        test(
            self.naming("unexpected token `", op, "', conditional binary operator expected"),
            op,
        )
    }

    /// `( EXPR )`: every refusal inside adds that bash expected the `)`.
    fn test_group(&mut self, tok: Tok) -> S<()> {
        if self.parser.nesting + self.depth >= super::parser::MAX_NESTING {
            let line = b"syntax error near unexpected token `('".to_vec();
            return Err(Stop::Refused(self.parser.refusal(tok.start, tok.end, vec![line], false)));
        }
        self.take(tok);
        self.depth += 1;
        let inside = self.test_or().and_then(|()| Ok(self.test_peek()?));
        self.depth -= 1;
        let close = match inside {
            Ok(close) => close,
            Err(Stop::Test { mut lines, at, eof }) => {
                lines.push("expected `)'".into());
                return Err(Stop::Test { lines, at, eof });
            }
            Err(Stop::Refused(mut fail)) => {
                if fail.eof {
                    fail.lines.push("expected `)'".into());
                }
                return Err(Stop::Refused(fail));
            }
        };
        if self.is(close, Kind::Op, b")") {
            self.take(close);
            return Ok(());
        }
        if close.kind == Kind::Word && !self.is_close(close) {
            return test("expected `)'".into(), close);
        }
        test(self.naming("unexpected token `", close, "', expected `)'"), close)
    }

    /// The right side of `==`, `=` or `!=`, read with extglob on.
    fn pattern_word(&self) -> R<Tok> {
        let at = self.blank_end(self.pos);
        let tok = self.lex(at)?;
        if tok.kind != Kind::Word && !self.extglob_at(at) {
            return Ok(tok);
        }
        let mut j = at;
        let mut extended = false;
        while j < self.n() {
            if self.extglob_at(j) {
                j = self.parser.scan_extended_pattern(j)?;
                extended = true;
                continue;
            }
            if word_break(self.s()[j]) {
                break;
            }
            j = self.parser.scan_word_char(j)?;
        }
        if !extended {
            return Ok(tok);
        }
        Ok(Tok {
            kind: Kind::Word,
            start: at,
            end: j.min(self.n()),
            plain: false,
        })
    }

    /// The right side of `=~`: parentheses group blanks into it and `|`
    /// is part of it; `;`, `<`, `>`, `)` and `&` end it, and one of them
    /// first is an empty pattern.
    fn regex_word(&self) -> R<Tok> {
        let at = self.blank_end(self.pos);
        if at >= self.n() || matches!(self.s()[at], b'\n' | b'#') {
            return self.lex(at);
        }
        if matches!(self.s()[at], b';' | b'<' | b'>' | b')' | b'&') {
            return Ok(Tok {
                kind: Kind::Word,
                start: at,
                end: at,
                plain: true,
            });
        }
        let mut j = at;
        while j < self.n() {
            let byte = self.s()[j];
            if byte == b'(' {
                j = self.parser.scan_matched(j + 1, j, b'(', b')')? + 1;
                continue;
            }
            if matches!(byte, b' ' | b'\t' | b'\n' | b';' | b'<' | b'>' | b')' | b'&') {
                break;
            }
            j = self.parser.scan_word_char(j)?;
        }
        let tok = Tok {
            kind: Kind::Word,
            start: at,
            end: j.min(self.n()),
            plain: false,
        };
        let plain = self.text(tok) == b"]]";
        Ok(Tok { plain, ..tok })
    }
}

/// A test's next token; ending inside a quote there, bash adds `line`.
fn operand(line: &str, read: R<Tok>) -> S<Tok> {
    read.map_err(|mut fail| {
        if fail.eof {
            fail.lines.push(line.into());
        }
        Stop::Refused(fail)
    })
}

impl Parser<'_> {
    /// Read `[[ ... ]]` from `start`, just past its `[[`, as bash does:
    /// where it ends, or bash's refusal of it.
    pub(super) fn check_conditional(&self, start: usize) -> R<usize> {
        let mut cond = Cond {
            parser: self,
            pos: start,
            ended: self.ended,
            depth: 0,
        };
        let read = cond.test_or().and_then(|()| cond.test_close());
        match read {
            Ok(()) => Ok(cond.pos),
            Err(Stop::Refused(fail)) => Err(fail),
            Err(Stop::Test { mut lines, at, eof }) => {
                if eof {
                    lines.push(self.eof_line().into());
                    return Err(self.refusal(self.s.len(), self.s.len(), lines, true));
                }
                let reach = at.end + usize::from(at.kind != Kind::Newline);
                let (from, to) = self.near_span(reach);
                lines.push(line(&[b"syntax error near `", &self.s[from..to], b"'"]));
                Err(self.refusal(from, to, lines, false))
            }
        }
    }
}
