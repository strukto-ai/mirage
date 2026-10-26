// Token rules for test operators, regexes and extglob patterns adapted from
// tree-sitter-bash 0.25.1, src/scanner.c.
// https://github.com/tree-sitter/tree-sitter-bash
// Licensed under MIT. See licenses/third_party/tree-sitter-bash-parser.txt.
use super::arith::{BINARY, PREFIX, TERNARY, UNARY};
use super::lex::is_space;
use super::parser::{Parser, R};
use super::tree::Syn;
use super::word::{Ctx, push_run};

/// Where a `-op` test operator binds.
const TEST: u8 = 10;

/// Where a test expression ends.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Closer {
    /// `]`.
    Single,
    /// `]]`.
    Double,
    /// `)` of a parenthesized expression elsewhere, as in `${x:(i)}`.
    Paren,
}

impl Parser<'_> {
    /// `[ expression ]` or `[[ expression ]]`.
    pub(super) fn test_command(&mut self, double: bool) -> R<Syn> {
        self.enter()?;
        let (open, close, closer) = if double {
            ("[[", "]]", Closer::Double)
        } else {
            ("[", "]", Closer::Single)
        };
        let mut children = vec![self.expect(open)?];
        if double {
            self.check_conditional(self.i)?;
        }
        self.test_space(closer);
        if !self.at_test_close(closer) {
            let expression = if double {
                self.top_test_expression()?
            } else {
                self.test_expression(closer, 0)?
            };
            children.push(expression);
            self.test_space(closer);
        }
        if !self.at_test_close(closer) {
            return self.fail(self.i);
        }
        children.push(self.expect(close)?);
        self.leave();
        Ok(Syn::node("test_command", children))
    }

    fn at_test_close(&self, closer: Closer) -> bool {
        let (text, len): (&[u8], usize) = match closer {
            Closer::Single => (b"]", 1),
            Closer::Double => (b"]]", 2),
            Closer::Paren => (b")", 1),
        };
        self.starts(text)
            && (closer == Closer::Paren
                || self.s.get(self.i + len).is_none_or(|byte| {
                    is_space(*byte) || matches!(byte, b';' | b'&' | b'|' | b')' | b'<' | b'>')
                }))
    }

    /// `[[ left = right ]]` reads its right side as a pattern up to a
    /// blank; anything else is an ordinary expression.
    fn top_test_expression(&mut self) -> R<Syn> {
        let mark = self.mark();
        let left = self.test_unary(Closer::Double)?;
        self.test_space(Closer::Double);
        if self.peek() == b'=' && is_space(self.at(1)) {
            let at = self.i;
            self.i += 1;
            let op = Syn::token("=", at, at + 1).with_field("operator");
            self.test_space(Closer::Double);
            if let Some(end) = self.regex_no_space_end() {
                let regex_at = self.i;
                self.i = end;
                let right = Syn::leaf("regex", regex_at, end).with_field("right");
                self.test_space(Closer::Double);
                if self.at_test_close(Closer::Double) {
                    return Ok(Syn::node(
                        "binary_expression",
                        vec![left.with_field("left"), op, right],
                    ));
                }
            }
        }
        self.reset(mark);
        self.test_expression(Closer::Double, 0)
    }

    /// A test expression whose binary operators bind at least `min`.
    fn test_expression(&mut self, closer: Closer, min: u8) -> R<Syn> {
        self.enter()?;
        let mut left = self.test_unary(closer)?;
        loop {
            self.test_space(closer);
            if self.at_test_close(closer) || self.eof() {
                break;
            }
            if self.peek() == b'?' && TERNARY >= min {
                let question = self.expect("?")?;
                self.test_space(closer);
                let consequence = self.test_expression(closer, 0)?;
                self.test_space(closer);
                let colon = self.expect(":")?;
                self.test_space(closer);
                let alternative = self.test_expression(closer, TERNARY + 1)?;
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
            let at = self.i;
            let (op, prec) = if let Some(end) = self.test_operator_end() {
                self.i = end;
                (Syn::leaf("test_operator", at, end), TEST)
            } else if let Some((text, prec)) = self.test_binary_operator() {
                // A list or pipe operator ends a `[` command's words.
                if prec < min || closer == Closer::Single && matches!(text, "&&" | "||" | "|") {
                    break;
                }
                self.i += text.len();
                (Syn::token(text, at, self.i), prec)
            } else {
                break;
            };
            if prec < min {
                self.i = at;
                break;
            }
            let op = op.with_field("operator");
            self.test_space(closer);
            let right = match op.kind {
                "=~" => self.regex_operand(closer)?,
                "==" | "!=" => self.pattern_operand(closer, prec)?,
                "=" if closer != Closer::Single => {
                    let mark = self.mark();
                    match self.pattern_word()? {
                        Some((word, true)) => word,
                        _ => {
                            self.reset(mark);
                            self.test_expression(closer, prec + 1)?
                        }
                    }
                }
                _ => {
                    let next = if op.kind == "**" { prec } else { prec + 1 };
                    self.test_expression(closer, next)?
                }
            };
            left = Syn::node(
                "binary_expression",
                vec![left.with_field("left"), op, right.with_field("right")],
            );
        }
        self.leave();
        Ok(left)
    }

    fn test_binary_operator(&self) -> Option<(&'static str, u8)> {
        BINARY
            .iter()
            .find(|(text, _)| self.starts(text.as_bytes()))
            .copied()
    }

    /// A `-op` test operator: a dash, letters, then a blank.
    fn test_operator_end(&self) -> Option<usize> {
        if self.peek() != b'-' {
            return None;
        }
        let mut end = self.i + 1;
        while self.s.get(end).is_some_and(u8::is_ascii_alphabetic) {
            end += 1;
        }
        (end > self.i + 1 && self.s.get(end).is_some_and(|byte| is_space(*byte))).then_some(end)
    }

    fn test_unary(&mut self, closer: Closer) -> R<Syn> {
        let at = self.i;
        if let Some(end) = self.test_operator_end() {
            self.i = end;
            let op = Syn::leaf("test_operator", at, end).with_field("operator");
            self.test_space(closer);
            if self.at_test_close(closer) {
                self.i = at;
                return self.test_operand(closer);
            }
            let operand = self.test_expression(closer, TEST)?;
            return Ok(Syn::node("unary_expression", vec![op, operand]));
        }
        let prefix: Option<(&'static str, u8)> = if self.starts(b"++") {
            Some(("++", PREFIX))
        } else if self.starts(b"--") {
            Some(("--", PREFIX))
        } else {
            match self.peek() {
                b'!' if is_space(self.at(1)) || self.at(1) == b'(' => Some(("!", UNARY)),
                b'-' | b'+' | b'~' if !is_space(self.at(1)) => {
                    let text = match self.peek() {
                        b'-' => "-",
                        b'+' => "+",
                        _ => "~",
                    };
                    Some((text, UNARY))
                }
                _ => None,
            }
        };
        if let Some((text, prec)) = prefix {
            self.i += text.len();
            let op = Syn::token(text, at, self.i).with_field("operator");
            self.test_space(closer);
            let operand = if text == "!" {
                self.test_expression(closer, UNARY)?
            } else {
                self.test_expression(closer, prec + 1)?
            };
            return Ok(Syn::node("unary_expression", vec![op, operand]));
        }
        let mut operand = self.test_operand(closer)?;
        loop {
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

    fn test_operand(&mut self, closer: Closer) -> R<Syn> {
        if self.peek() == b'(' {
            return self.parenthesized();
        }
        let ctx = Ctx {
            bracket: closer == Closer::Single,
            conditional: closer != Closer::Single,
            ..Default::default()
        };
        match self.literal_opt(ctx)? {
            Some(node) => Ok(node),
            None => self.fail(self.i),
        }
    }

    /// The blanks and newlines between a test's tokens. Inside `[[ ]]` a
    /// newline reads the bodies of the heredocs pending there, as it does
    /// between commands.
    fn test_space(&mut self, closer: Closer) {
        if closer == Closer::Double {
            self.skip_space_bodies();
        } else {
            self.skip_space();
        }
    }

    /// `(expression)`, in a test or where an expansion's offset takes one.
    pub(super) fn parenthesized(&mut self) -> R<Syn> {
        let open = self.expect("(")?;
        self.skip_space();
        let inner = self.test_expression(Closer::Paren, 0)?;
        self.skip_space();
        let close = self.expect(")")?;
        Ok(Syn::node(
            "parenthesized_expression",
            vec![open, inner, close],
        ))
    }

    /// A subscript's index: a word, or a test expression up to `]`.
    pub(super) fn subscript_index(&mut self) -> R<Syn> {
        self.test_expression(Closer::Single, 0)
    }

    /// The right side of `=~`: a regex up to a blank when it holds more
    /// than letters, digits, `$`, `-` and `_`; an ordinary operand
    /// otherwise. bash reads an empty regex before `&&`.
    fn regex_operand(&mut self, closer: Closer) -> R<Syn> {
        if self.starts(b"&&") {
            return Ok(Syn::leaf("regex", self.i, self.i));
        }
        if let Some(end) = self.regex_no_space_end() {
            let at = self.i;
            self.i = end;
            return Ok(Syn::leaf("regex", at, end));
        }
        self.test_expression(closer, 2)
    }

    /// Where a regex without blanks ends, if one starts here; an `&`
    /// outside parentheses ends it, as it ends bash's.
    fn regex_no_space_end(&self) -> Option<usize> {
        if self.peek() == b'"' {
            return None;
        }
        let mut end = self.i;
        let mut special = false;
        let mut depth = 0usize;
        let mut quoted = false;
        while end < self.s.len() {
            let byte = self.s[end];
            if quoted {
                if byte == b'\'' {
                    quoted = false;
                }
                end += 1;
                continue;
            }
            match byte {
                b'\\' => {
                    special = true;
                    end += 2;
                    continue;
                }
                b'\'' => {
                    quoted = true;
                    special = true;
                }
                b'(' => depth += 1,
                b')' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                b'&' if depth == 0 => break,
                b'$' => {
                    if self.s.get(end + 1) == Some(&b'(') {
                        return None;
                    }
                    if self.s.get(end + 1).is_some_and(|next| is_space(*next)) {
                        return Some(end + 1);
                    }
                }
                _ if is_space(byte) && depth == 0 => break,
                _ => {}
            }
            if !(byte.is_ascii_alphanumeric() || matches!(byte, b'$' | b'-' | b'_')) {
                special = true;
            }
            end += 1;
        }
        (special && end > self.i).then_some(end.min(self.s.len()))
    }

    /// The right side of `==` and `!=`: an extglob pattern when the
    /// grammar's pattern scanner takes one, an expression otherwise. Inside
    /// `[[`, the word bash reads where the scanner stops short of it or it
    /// holds an extglob group, one pattern token where the scanner takes
    /// all of it.
    fn pattern_operand(&mut self, closer: Closer, prec: u8) -> R<Syn> {
        let at = self.i;
        let grammar = self.extglob_end();
        if closer != Closer::Single {
            let mark = self.mark();
            if let Some((word, group)) = self.pattern_word()? {
                let literal = word.is("extglob_pattern");
                if grammar == Some(self.i) && literal {
                    return Ok(Syn::leaf("extglob_pattern", at, self.i));
                }
                if group || grammar.is_some() || !literal {
                    return Ok(word);
                }
            }
            self.reset(mark);
        }
        if let Some(end) = grammar {
            self.i = end;
            return Ok(Syn::leaf("extglob_pattern", at, end));
        }
        self.test_expression(closer, prec + 1)
    }

    /// A pattern word as bash reads it, its extglob groups matched across
    /// blanks and newlines: runs of pattern text with the quotes and
    /// expansions in it as their own nodes, and whether it holds a group.
    /// None when no word starts here.
    pub(super) fn pattern_word(&mut self) -> R<Option<(Syn, bool)>> {
        let start = self.i;
        let mut pieces = Vec::new();
        let mut run = start;
        let mut group = false;
        loop {
            let byte = self.peek();
            if self.eof()
                || is_space(byte)
                || matches!(byte, b';' | b'&' | b'|' | b'<' | b'>' | b')')
            {
                break;
            }
            let at = self.i;
            let piece = match byte {
                b'(' if self.i > start && self.at_extglob_group() => {
                    push_run(&mut pieces, "extglob_pattern", run, at);
                    self.extglob_group(&mut pieces, "extglob_pattern")?;
                    run = self.i;
                    group = true;
                    continue;
                }
                b'(' => break,
                b'\\' => {
                    self.i += 2;
                    continue;
                }
                b'"' => self.string()?,
                b'\'' => self.raw_string()?,
                b'`' => self.backtick()?,
                b'$' => self.dollar()?,
                _ => {
                    self.i += 1;
                    continue;
                }
            };
            if piece.is("$") {
                continue;
            }
            push_run(&mut pieces, "extglob_pattern", run, at);
            pieces.push(piece);
            run = self.i;
        }
        self.i = self.i.min(self.s.len());
        push_run(&mut pieces, "extglob_pattern", run, self.i);
        Ok(Syn::concat(pieces).map(|word| (word, group)))
    }

    /// Where an extglob pattern ends, if the pattern scanner of
    /// tree-sitter-bash takes one here.
    pub(super) fn extglob_end(&self) -> Option<usize> {
        let s = self.s;
        let get = |at: usize| s.get(at).copied().unwrap_or(0);
        let mut la = self.i;
        // The grammar's scanner first tries a test operator, which takes a
        // dash and the letters after it even when it then finds none.
        if get(la) == b'-' {
            la += 1;
            while get(la).is_ascii_alphabetic() {
                la += 1;
            }
            if la > self.i + 1 && is_space(get(la)) {
                return None;
            }
        }
        let first = get(la);
        if !(matches!(
            first,
            b'?' | b'*' | b'+' | b'@' | b'!' | b'-' | b')' | b'\\' | b'.' | b'['
        ) || first.is_ascii_alphabetic())
        {
            return None;
        }
        if first == b'\\' {
            la += 1;
            let next = get(la);
            if (is_space(next) || next == b'"') && next != b'\r' && next != b'\n' {
                la += 1;
            } else {
                return None;
            }
        }
        if get(la) == b')' {
            la += 1;
            if is_space(get(la)) {
                return None;
            }
        }
        let mut mark = la;
        let was_non_alpha = !get(la).is_ascii_alphabetic();
        if get(la) != b'[' {
            if get(la) == b'e' {
                mark = la;
                la += 1;
                if get(la) == b's' {
                    la += 1;
                    if get(la) == b'a' {
                        la += 1;
                        if get(la) == b'c' {
                            la += 1;
                            if is_space(get(la)) {
                                return None;
                            }
                        }
                    }
                }
            } else {
                la += 1;
            }
        }
        if get(la) == b'-' {
            la += 1;
            while get(la).is_ascii_alphanumeric() {
                la += 1;
            }
            if matches!(get(la), b')' | b'\\' | b'.') {
                return None;
            }
            mark = la;
        }
        if get(la) == b')' {
            mark = la;
            la += 1;
            if is_space(get(la)) {
                return was_non_alpha.then_some(mark);
            }
        }
        if is_space(get(la)) {
            return Some(la);
        }
        if get(la) == b'$' {
            mark = la;
            la += 1;
            if matches!(get(la), b'{' | b'(') {
                return Some(mark);
            }
        }
        if get(la) == b'|' {
            return Some(la);
        }
        let byte = get(la);
        if !(byte.is_ascii_alphanumeric()
            || matches!(byte, b'(' | b'"' | b'[' | b'?' | b'/' | b'\\' | b'_' | b'*'))
        {
            return None;
        }
        let mut saw = was_non_alpha;
        let (mut paren, mut bracket, mut brace) = (0i64, 0i64, 0i64);
        loop {
            let byte = get(la);
            let mut done = false;
            match byte {
                0 => return None,
                b'(' => paren += 1,
                b'[' => bracket += 1,
                b'{' => brace += 1,
                b')' => {
                    done = paren == 0;
                    paren -= 1;
                }
                b']' => {
                    done = bracket == 0;
                    bracket -= 1;
                }
                b'}' => {
                    done = brace == 0;
                    brace -= 1;
                }
                _ => {}
            }
            if get(la) == b'|' {
                mark = la;
                la += 1;
                if paren == 0 && bracket == 0 && brace == 0 {
                    return Some(mark);
                }
            }
            if done {
                break;
            }
            let was_space = is_space(get(la));
            if get(la) == b'$' {
                mark = la;
                saw = true;
                la += 1;
                if matches!(get(la), b'(' | b'{') {
                    return saw.then_some(mark);
                }
            }
            if was_space || get(la) == b'"' {
                return saw.then_some(la);
            }
            if get(la) == b'\\' {
                la += 1;
                if is_space(get(la)) || get(la) == b'"' {
                    la += 1;
                }
            } else {
                let byte = get(la);
                if !byte.is_ascii_alphabetic() && byte != b'.' && byte != b'\\' {
                    saw = true;
                }
                la += 1;
            }
            mark = la;
        }
        saw.then_some(mark)
    }
}
