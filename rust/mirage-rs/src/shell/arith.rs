use super::lex::{is_name, is_name_start, is_space, name_end};
use super::parser::{Parser, R};
use super::tree::Syn;

/// Binary operators by precedence, as tree-sitter-bash ranks them; the
/// longest spelling of each first, so `<<=` is not read as `<<`.
const ARITHMETIC: &[(&str, u8)] = &[
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

const TERNARY: u8 = 2;
const UNARY: u8 = 11;
const PREFIX: u8 = 17;

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
            if last > self.i {
                children.push(Syn::leaf("word", self.i, last));
            }
            self.i = end - 2;
        }
        children.push(self.expect("))")?);
        Ok(Syn::node(kind, children))
    }

    /// `$[a]`.
    pub(super) fn bracket_arithmetic(&mut self) -> R<Syn> {
        self.enter()?;
        let at = self.i;
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
                if end - 1 > at + 2 {
                    children.push(Syn::leaf("word", at + 2, end - 1));
                }
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
        let mut children = vec![keyword, self.expect("((")?];
        let mark = self.mark();
        let kept = children.len();
        if self.c_style_header(&mut children).is_err() {
            // bash splits the header at its `;`s and evaluates each part
            // when the loop runs: a part the grammar cannot read is one
            // raw word.
            let Some(end) = self.double_paren_end(open_at) else {
                return self.fail(self.i);
            };
            self.forget(mark);
            children.truncate(kept);
            self.check_raw(open_at + 2, end - 2, false)?;
            if !self.c_style_raw(open_at + 2, end - 2, &mut children) {
                return Err(super::parser::Fail {
                    at: open_at,
                    message: "syntax error: arithmetic expression required".into(),
                });
            }
            self.i = end - 2;
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
        Ok(Syn::node("c_style_for_statement", children))
    }

    /// The three parts of a C-style for header as raw words; false when
    /// the header does not hold three.
    fn c_style_raw(&self, start: usize, end: usize, children: &mut Vec<Syn>) -> bool {
        let mut part = start;
        let mut depth = 0usize;
        let mut index = 0;
        let fields = ["initializer", "condition", "update"];
        let push = |from: usize, to: usize, children: &mut Vec<Syn>, index: usize| {
            let mut from = from;
            let mut to = to;
            while from < to && is_space(self.s[from]) {
                from += 1;
            }
            while to > from && is_space(self.s[to - 1]) {
                to -= 1;
            }
            if to > from {
                children.push(Syn::leaf("word", from, to).with_field(fields[index.min(2)]));
            }
        };
        let mut at = start;
        while at < end {
            match self.s[at] {
                b'(' => depth += 1,
                b')' => depth = depth.saturating_sub(1),
                b';' if depth == 0 && index < 2 => {
                    push(part, at, children, index);
                    children.push(Syn::token(";", at, at + 1));
                    index += 1;
                    part = at + 1;
                }
                _ => {}
            }
            at += 1;
        }
        push(part, end, children, index);
        let separators = self.s[start..end]
            .iter()
            .filter(|byte| **byte == b';')
            .count();
        index == 2 && separators == 2
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
                let value = self.c_expression()?.with_field("value");
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
            Grammar::Arithmetic => ARITHMETIC,
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
            b'$' => match self.literal_dollar()? {
                Some(node) => Ok(node),
                None => self.fail(at),
            },
            b'"' => self.string(),
            b'\'' if grammar == Grammar::Arithmetic => self.raw_string(),
            b'`' => match Some(self.backtick()?) {
                Some(node) => Ok(node),
                None => self.fail(at),
            },
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

    /// A `$` construct in an expression.
    fn literal_dollar(&mut self) -> R<Option<Syn>> {
        if self.at(1) == b'\'' || self.at(1) == b'"' {
            return Ok(None);
        }
        self.dollar().map(Some)
    }
}
