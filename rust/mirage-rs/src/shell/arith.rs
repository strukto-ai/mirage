use super::lex::{is_name, is_name_start, is_space, name_end};
use super::parser::{Parser, R};
use super::tree::Syn;
use super::word::push_run;

/// Binary operators of arithmetic and test expressions by precedence, as
/// tree-sitter-bash ranks them; the longest spelling of each first, so
/// `<<=` is not read as `<<`.
pub(super) const BINARY: &[(&str, u8)] = &[
    ("**=", 0),
    ("<<=", 0),
    (">>=", 0),
    ("+=", 0),
    ("-=", 0),
    ("*=", 0),
    ("/=", 0),
    ("%=", 0),
    ("&=", 0),
    ("^=", 0),
    ("|=", 0),
    ("||", 3),
    ("&&", 4),
    ("==", 8),
    ("!=", 8),
    ("<=", 9),
    (">=", 9),
    ("<<", 12),
    (">>", 12),
    ("**", 15),
    ("=~", 1),
    ("=", 1),
    ("|", 5),
    ("^", 6),
    ("&", 7),
    ("<", 9),
    (">", 9),
    ("+", 13),
    ("-", 13),
    ("*", 14),
    ("/", 14),
    ("%", 14),
];

/// The C-style for loop's operators: no `=` (an assignment is its own
/// node there) and `-o`/`-a` beside `||`/`&&`.
const C_STYLE: &[(&str, u8)] = &[
    ("**=", 0),
    ("<<=", 0),
    (">>=", 0),
    ("+=", 0),
    ("-=", 0),
    ("*=", 0),
    ("/=", 0),
    ("%=", 0),
    ("&=", 0),
    ("^=", 0),
    ("|=", 0),
    ("||", 3),
    ("-o", 3),
    ("&&", 4),
    ("-a", 4),
    ("==", 8),
    ("!=", 8),
    ("<=", 9),
    (">=", 9),
    ("<<", 12),
    (">>", 12),
    ("**", 15),
    ("|", 5),
    ("^", 6),
    ("&", 7),
    ("<", 9),
    (">", 9),
    ("+", 13),
    ("-", 13),
    ("*", 14),
    ("/", 14),
    ("%", 14),
];

pub(super) const TERNARY: u8 = 2;
pub(super) const UNARY: u8 = 11;
pub(super) const PREFIX: u8 = 17;

/// Which expression grammar a parse follows.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Grammar {
    /// `$((...))`, `((...))` and `$[...]`.
    Arithmetic,
    /// `for ((...))`.
    CStyle,
}

impl Parser<'_> {
    fn arith_blank(&mut self) {
        loop {
            if is_space(self.peek()) && !self.eof() {
                self.i += 1;
            } else if self.peek() == b'\\' && self.at(1) == b'\n' {
                self.i += 2;
            } else {
                break;
            }
        }
    }

    /// `$((a, b))`.
    pub(super) fn arithmetic_expansion(&mut self) -> R<Syn> {
        self.enter()?;
        let open = self.expect("$((")?;
        let node = self.arithmetic_body(open, "arithmetic_expansion");
        self.leave();
        node
    }

    /// The expressions of `$((` or `((` up to `))`. bash evaluates them
    /// when it runs them, so a body the grammar cannot read, or an empty
    /// one, is one raw word.
    fn arithmetic_body(&mut self, open: Syn, kind: &'static str) -> R<Syn> {
        let start = self.i;
        let Some(end) = self.double_paren_end(open.end - 2) else {
            return self.fail(start);
        };
        let mark = self.mark();
        let mut children = vec![open];
        let parsed = self.arithmetic_list(&mut children);
        self.arith_blank();
        if parsed.is_err() || self.i != end - 2 {
            self.forget(mark);
            children.truncate(1);
            self.i = start;
            self.arith_blank();
            let mut last = end - 2;
            while last > self.i && is_space(self.s[last - 1]) {
                last -= 1;
            }
            self.check_raw(self.i, last, false)?;
            children.extend(self.raw_body(self.i, last));
            self.i = end - 2;
        }
        children.push(self.expect("))")?);
        Ok(Syn::node(kind, children))
    }

    /// A body bash reads only when it runs it, from `start` to `end`: runs
    /// of text as words between the pieces bash expands first, as in a
    /// double-quoted word (`$x`, `${x}`, `$(…)`, `$((…))`, `` `…` ``,
    /// `"…"`), or None for an empty body. A body holding a piece is a
    /// concatenation, so each one evaluates as one expression.
    fn raw_body(&mut self, start: usize, end: usize) -> Option<Syn> {
        let mut pieces = Vec::new();
        let mut run = start;
        let mut at = start;
        while at < end {
            let byte = self.s[at];
            if byte == b'\\' {
                at += 2;
                continue;
            }
            if !matches!(byte, b'$' | b'`' | b'"') {
                at += 1;
                continue;
            }
            self.i = at;
            let mark = self.mark();
            let read = match byte {
                b'$' => self.dollar_in_string(),
                b'`' => self.backtick().map(Some),
                _ => self.string().map(Some),
            };
            match read {
                Ok(Some(piece)) if self.i <= end => {
                    push_run(&mut pieces, "word", run, at);
                    pieces.push(piece);
                    at = self.i;
                    run = at;
                }
                _ => {
                    self.reset(mark);
                    at += 1;
                }
            }
        }
        push_run(&mut pieces, "word", run, end);
        if pieces.len() > 1 || pieces.first().is_some_and(|piece| !piece.is("word")) {
            Some(Syn::node("concatenation", pieces))
        } else {
            pieces.pop()
        }
    }

    /// `$[a]`.
    pub(super) fn bracket_arithmetic(&mut self) -> R<Syn> {
        self.enter()?;
        let at = self.i;
        self.scan_matched(at + 2, at, b'[', b']')?;
        let Some(end) = super::lex::bracket_end(self.s, at + 1) else {
            return self.fail(at);
        };
        let open = self.expect("$[")?;
        let mark = self.mark();
        self.arith_blank();
        let parsed = self.arith(Grammar::Arithmetic, 0);
        self.arith_blank();
        let mut children = vec![open];
        match parsed {
            Ok(expression) if self.i == end - 1 => children.push(expression),
            _ => {
                self.forget(mark);
                self.check_raw(at + 2, end - 1, false)?;
                children.extend(self.raw_body(at + 2, end - 1));
                self.i = end - 1;
            }
        }
        children.push(self.expect("]")?);
        self.leave();
        Ok(Syn::node("arithmetic_expansion", children))
    }

    /// `((a, b))` as a command.
    pub(super) fn arithmetic_command(&mut self) -> R<Syn> {
        self.enter()?;
        let open = self.expect("((")?;
        let node = self.arithmetic_body(open, "compound_statement");
        self.leave();
        node
    }

    fn arithmetic_list(&mut self, children: &mut Vec<Syn>) -> R<()> {
        loop {
            self.arith_blank();
            children.push(self.arith(Grammar::Arithmetic, 0)?);
            self.arith_blank();
            if self.peek() == b',' {
                children.push(self.expect(",")?);
                continue;
            }
            return Ok(());
        }
    }

    /// `for ((init; condition; update)) body`.
    pub(super) fn c_style_for(&mut self, keyword: Syn) -> R<Syn> {
        let open_at = self.i;
        let close = self.scan_matched(open_at + 2, open_at, b'(', b')')?;
        if self.s.get(close + 1) != Some(&b')') {
            let end_of_line = matches!(self.s.get(close + 1), None | Some(b'\n'));
            return Err(self.near(if end_of_line { close + 1 } else { close + 3 }, false));
        }
        let parts = semicolons(&self.s[open_at + 2..close]);
        let mut children = vec![keyword, self.expect("((")?];
        let mark = self.mark();
        let kept = children.len();
        if self.c_style_header(&mut children).is_err() {
            // bash splits the header at its `;`s and evaluates each part
            // when the loop runs: a part the grammar cannot read is a raw
            // body.
            self.forget(mark);
            children.truncate(kept);
            self.check_raw(open_at + 2, close, false)?;
            self.c_style_raw(open_at + 2, close, &mut children);
            self.i = close;
        }
        children.push(self.expect("))")?);
        self.skip_blank();
        if self.peek() == b';' {
            children.push(self.expect(";")?);
        } else if self.peek() == b'\n' {
            let at = self.i;
            self.i += 1;
            children.push(Syn::hidden(at, at + 1));
        }
        self.skip_space();
        let body = if self.peek() == b'{' {
            self.primary()?
        } else {
            self.do_group()?
        };
        children.push(body.with_field("body"));
        // bash counts the header's expressions once the body is read.
        if parts != 2 {
            let first = if parts < 2 {
                "arithmetic expression required"
            } else {
                "`;' unexpected"
            };
            let whole = &self.s[open_at..close + 2];
            let lines = vec![
                super::parser::line(&[b"syntax error: ", first.as_bytes()]),
                super::parser::line(&[b"syntax error: `", whole, b"'"]),
            ];
            return Err(self.refusal(open_at, close + 2, lines, false));
        }
        Ok(Syn::node("c_style_for_statement", children))
    }

    /// The three parts of a C-style for header as raw bodies; none when
    /// the header does not hold three, which bash refuses.
    fn c_style_raw(&mut self, start: usize, end: usize, children: &mut Vec<Syn>) {
        let separators = self.header_separators(start, end);
        if separators.len() != 2 {
            return;
        }
        let fields = ["initializer", "condition", "update"];
        let mut from = start;
        for (index, to) in separators.iter().copied().chain([end]).enumerate() {
            let (mut first, mut last) = (from, to);
            while first < last && is_space(self.s[first]) {
                first += 1;
            }
            while last > first && is_space(self.s[last - 1]) {
                last -= 1;
            }
            if let Some(body) = self.raw_body(first, last) {
                children.push(body.with_field(fields[index]));
            }
            if to < end {
                children.push(Syn::token(";", to, to + 1));
            }
            from = to + 1;
        }
    }

    /// The `;`s that split a C-style for header: outside its quotes,
    /// substitutions and parentheses, where bash splits it.
    fn header_separators(&self, start: usize, end: usize) -> Vec<usize> {
        let mut found = Vec::new();
        let mut depth = 0usize;
        let mut at = start;
        while at < end {
            at = match self.s[at] {
                b'\\' => at + 2,
                b'\'' => super::lex::quote_end(self.s, at, b'\'').unwrap_or(end),
                b'"' | b'`' | b'$' => self.piece_end(at).unwrap_or(at + 1),
                b'(' => {
                    depth += 1;
                    at + 1
                }
                b')' => {
                    depth = depth.saturating_sub(1);
                    at + 1
                }
                b';' => {
                    if depth == 0 {
                        found.push(at);
                    }
                    at + 1
                }
                _ => at + 1,
            };
        }
        found
    }

    /// Where the quoted string, substitution or expansion at `at` ends, as
    /// a double-quoted word reads it; None when none starts there.
    fn piece_end(&self, at: usize) -> Option<usize> {
        let mut probe = self.probe(at);
        let read = match self.s[at] {
            b'"' => probe.string().map(Some),
            b'`' => probe.backtick().map(Some),
            _ => probe.dollar_in_string(),
        };
        matches!(read, Ok(Some(_))).then_some(probe.i)
    }

    fn c_style_header(&mut self, children: &mut Vec<Syn>) -> R<()> {
        for (index, field) in ["initializer", "condition", "update"]
            .into_iter()
            .enumerate()
        {
            self.arith_blank();
            let mut part = Vec::new();
            if !(self.peek() == b';' || self.starts(b"))")) {
                loop {
                    self.arith_blank();
                    part.push(self.c_expression()?);
                    self.arith_blank();
                    if self.peek() == b',' {
                        part.push(self.expect(",")?);
                        continue;
                    }
                    break;
                }
            }
            children.extend(Syn::fielded(part, field));
            self.arith_blank();
            if index < 2 {
                let at = self.i;
                match self.peek() {
                    b';' => children.push(self.expect(";")?),
                    b'&' => children.push(self.expect("&")?),
                    b'\n' => {
                        self.i += 1;
                        children.push(Syn::hidden(at, at + 1));
                    }
                    _ => return self.fail(at),
                }
            }
        }
        self.arith_blank();
        if self.starts(b"))") {
            Ok(())
        } else {
            self.fail(self.i)
        }
    }

    /// One expression of a C-style for loop: an assignment or an
    /// expression.
    fn c_expression(&mut self) -> R<Syn> {
        if is_name_start(self.peek()) {
            let end = name_end(self.s, self.i);
            let mut after = end;
            while self
                .s
                .get(after)
                .is_some_and(|byte| *byte == b' ' || *byte == b'\t')
            {
                after += 1;
            }
            if self.s.get(after) == Some(&b'=') && self.s.get(after + 1) != Some(&b'=') {
                let name = Syn::leaf("variable_name", self.i, end).with_field("name");
                self.i = after;
                let op = self.expect("=")?;
                self.arith_blank();
                self.enter()?;
                let value = self.c_expression()?.with_field("value");
                self.leave();
                return Ok(Syn::node("variable_assignment", vec![name, op, value]));
            }
        }
        self.arith(Grammar::CStyle, 0)
    }

    /// A binary expression whose operators bind at least `min`.
    fn arith(&mut self, grammar: Grammar, min: u8) -> R<Syn> {
        self.enter()?;
        let mut left = self.arith_unary(grammar)?;
        loop {
            self.arith_blank();
            if grammar == Grammar::Arithmetic && self.peek() == b'?' && TERNARY >= min {
                let question = self.expect("?")?;
                self.arith_blank();
                let consequence = self.arith(grammar, 0)?;
                self.arith_blank();
                let colon = self.expect(":")?;
                self.arith_blank();
                let alternative = self.arith(grammar, TERNARY + 1)?;
                left = Syn::node(
                    "ternary_expression",
                    vec![
                        left.with_field("condition"),
                        question,
                        consequence.with_field("consequence"),
                        colon,
                        alternative.with_field("alternative"),
                    ],
                );
                continue;
            }
            let Some((text, prec)) = self.binary_operator(grammar) else {
                break;
            };
            if prec < min {
                break;
            }
            let at = self.i;
            self.i += text.len();
            let op = Syn::token(text, at, self.i).with_field("operator");
            self.arith_blank();
            let next = if text == "**" && grammar == Grammar::CStyle {
                prec
            } else {
                prec + 1
            };
            let right = self.arith(grammar, next)?;
            left = Syn::node(
                "binary_expression",
                vec![left.with_field("left"), op, right.with_field("right")],
            );
        }
        self.leave();
        Ok(left)
    }

    fn binary_operator(&self, grammar: Grammar) -> Option<(&'static str, u8)> {
        let table = match grammar {
            Grammar::Arithmetic => BINARY,
            Grammar::CStyle => C_STYLE,
        };
        table
            .iter()
            .find(|(text, _)| {
                self.starts(text.as_bytes())
                    && !((*text == "-o" || *text == "-a") && is_name(self.at(2)))
            })
            .copied()
    }

    /// A prefix operator and its operand, or a postfix one's.
    fn arith_unary(&mut self, grammar: Grammar) -> R<Syn> {
        let at = self.i;
        let prefix: Option<(&'static str, u8)> = if self.starts(b"++") {
            Some(("++", PREFIX))
        } else if self.starts(b"--") {
            Some(("--", PREFIX))
        } else if grammar == Grammar::Arithmetic
            || !(self.peek() == b'-' && self.at(1).is_ascii_digit())
        {
            match self.peek() {
                b'-' => Some(("-", UNARY)),
                b'+' => Some(("+", UNARY)),
                b'~' => Some(("~", UNARY)),
                b'!' => Some(("!", UNARY)),
                _ => None,
            }
        } else {
            None
        };
        if let Some((text, prec)) = prefix {
            self.i += text.len();
            let op = Syn::token(text, at, self.i).with_field("operator");
            self.arith_blank();
            let operand = if prec == PREFIX {
                self.arith_postfix(grammar)?
            } else {
                self.arith(grammar, prec + 1)?
            };
            return Ok(Syn::node("unary_expression", vec![op, operand]));
        }
        self.arith_postfix(grammar)
    }

    fn arith_postfix(&mut self, grammar: Grammar) -> R<Syn> {
        let mut operand = self.arith_primary(grammar)?;
        loop {
            self.arith_blank();
            let at = self.i;
            let text = if self.starts(b"++") {
                "++"
            } else if self.starts(b"--") {
                "--"
            } else {
                return Ok(operand);
            };
            self.i += 2;
            let op = Syn::token(text, at, self.i).with_field("operator");
            operand = Syn::node("postfix_expression", vec![operand, op]);
        }
    }

    fn arith_primary(&mut self, grammar: Grammar) -> R<Syn> {
        let at = self.i;
        match self.peek() {
            b'(' => {
                let open = self.expect("(")?;
                self.arith_blank();
                let mut children = vec![open];
                loop {
                    let inner = if grammar == Grammar::CStyle {
                        self.c_expression()?
                    } else {
                        self.arith(grammar, 0)?
                    };
                    children.push(inner);
                    self.arith_blank();
                    if grammar == Grammar::CStyle && self.peek() == b',' {
                        children.push(self.expect(",")?);
                        self.arith_blank();
                        continue;
                    }
                    break;
                }
                children.push(self.expect(")")?);
                Ok(Syn::node("parenthesized_expression", children))
            }
            b'$' if !matches!(self.at(1), b'\'' | b'"') => self.dollar(),
            b'"' => self.string(),
            b'\'' if grammar == Grammar::Arithmetic => self.raw_string(),
            b'`' => self.backtick(),
            b'-' if grammar == Grammar::CStyle => {
                let end = super::lex::number_end(self.s, at).unwrap_or(at + 1);
                self.i = end;
                Ok(Syn::leaf("number", at, end))
            }
            byte if byte.is_ascii_digit() => {
                let end = super::lex::number_end(self.s, at).unwrap_or(at + 1);
                let end = if self.s.get(end).is_some_and(|b| is_name(*b)) {
                    name_end(self.s, end)
                } else {
                    end
                };
                self.i = end;
                Ok(Syn::leaf("number", at, end))
            }
            byte if is_name_start(byte) => {
                let end = name_end(self.s, at);
                self.i = end;
                if grammar == Grammar::Arithmetic && self.peek() == b'[' {
                    return self.subscript(at);
                }
                let kind = if grammar == Grammar::CStyle {
                    "word"
                } else {
                    "variable_name"
                };
                Ok(Syn::leaf(kind, at, end))
            }
            _ => self.fail(at),
        }
    }
}

/// How many `;`s divide an arithmetic `for` header's expressions, as bash
/// counts them: outside quotes, `${...}` and parentheses.
fn semicolons(body: &[u8]) -> usize {
    let mut count = 0;
    let mut depth = 0isize;
    let mut quote = 0u8;
    let mut at = 0;
    while at < body.len() {
        let byte = body[at];
        if quote != 0 {
            if byte == b'\\' && quote != b'\'' {
                at += 1;
            } else if byte == quote {
                quote = 0;
            }
        } else if matches!(byte, b'\'' | b'"' | b'`') {
            quote = byte;
        } else if byte == b'\\' {
            at += 1;
        } else if body[at..].starts_with(b"${") {
            at = memchr::memchr(b'}', &body[at..]).map_or(body.len(), |offset| at + offset);
        } else if byte == b'(' {
            depth += 1;
        } else if byte == b')' {
            depth -= 1;
        } else if byte == b';' && depth == 0 {
            count += 1;
        }
        at += 1;
    }
    count
}
