use super::lex::{is_blank, is_name, is_name_start, is_space, name_end, number_end, word_end};
use super::parser::{Close, Parser, R};
use super::tree::Syn;

/// What closes the construct a word sits in, which ends the word.
#[derive(Clone, Copy, Default)]
pub(super) struct Ctx {
    /// `}` closes it: an expansion's body.
    pub brace: bool,
    /// `]` closes it: a subscript or a `[` test.
    pub bracket: bool,
}

/// Bytes after `$` that name a special parameter.
pub(super) const SPECIAL: &[u8] = b"*@?!#-$";

impl Parser<'_> {
    /// A word: one piece, or adjacent pieces as a concatenation.
    pub(super) fn literal_opt(&mut self, ctx: Ctx) -> R<Option<Syn>> {
        if let Some(run) = self.special_run(ctx) {
            return Ok(Some(run));
        }
        let Some(first) = self.piece(ctx, true)? else {
            return Ok(None);
        };
        let mut pieces = vec![first];
        while self.concat_continues(ctx) {
            match self.piece(ctx, false)? {
                Some(piece) => pieces.push(piece),
                None => break,
            }
        }
        Ok(Some(if pieces.len() == 1 {
            pieces.pop().expect("one piece")
        } else {
            Syn::node("concatenation", pieces)
        }))
    }

    /// Lone `{ } [ ]` words separated only by blanks, which the grammar
    /// reads as one word.
    fn special_run(&mut self, ctx: Ctx) -> Option<Syn> {
        let lone = |at: usize, s: &[u8]| {
            matches!(s.get(at), Some(b'{' | b'}' | b'[' | b']'))
                && s.get(at + 1).is_none_or(|next| {
                    is_blank(*next)
                        || *next == b'\n'
                        || matches!(next, b';' | b'&' | b'|' | b')' | b'<' | b'>')
                })
        };
        let at = self.i;
        if !lone(at, self.s)
            || (ctx.brace && self.peek() == b'}')
            || (ctx.bracket && self.peek() == b']')
        {
            return None;
        }
        if self.peek() == b'{' && self.brace_expression_at(at) {
            return None;
        }
        let mut end = at + 1;
        let mut next = end;
        loop {
            while self.s.get(next).is_some_and(|byte| is_blank(*byte)) {
                next += 1;
            }
            let closes = (ctx.brace && self.s.get(next) == Some(&b'}'))
                || (ctx.bracket && self.s.get(next) == Some(&b']'));
            if next > end && lone(next, self.s) && !closes {
                end = next + 1;
                next = end;
            } else {
                break;
            }
        }
        if end == at + 1 {
            return None;
        }
        self.i = end;
        Some(Syn::leaf("word", at, end))
    }

    fn brace_expression_at(&self, at: usize) -> bool {
        self.probe(at).brace_expression().is_some()
    }

    /// Whether the next byte continues the word before it.
    pub(super) fn concat_continues(&self, ctx: Ctx) -> bool {
        let byte = self.peek();
        if self.eof() || is_space(byte) {
            return false;
        }
        match byte {
            b'>' | b'<' | b')' | b'(' | b';' | b'&' | b'|' => false,
            b'`' => !self.in_backtick,
            b'}' => !ctx.brace,
            b']' => !ctx.bracket,
            b'\\' => !(self.at(1) == b'\n' || (self.at(1) == b'\r' && self.at(2) == b'\n')),
            _ => true,
        }
    }

    /// One piece of a word.
    fn piece(&mut self, ctx: Ctx, first: bool) -> R<Option<Syn>> {
        let at = self.i;
        if self.eof() {
            return Ok(None);
        }
        match self.peek() {
            b'"' => self.string().map(Some),
            b'\'' => self.raw_string().map(Some),
            b'$' => self.dollar().map(Some),
            b'`' if self.in_backtick => Ok(None),
            b'`' => self.backtick().map(Some),
            b'<' | b'>' if first && self.at(1) == b'(' => self.process_substitution().map(Some),
            b'{' => {
                if let Some(node) = self.brace_expression() {
                    return Ok(Some(node));
                }
                self.i += 1;
                Ok(Some(Syn::leaf("word", at, at + 1)))
            }
            b'}' if ctx.brace => Ok(None),
            b']' if ctx.bracket => Ok(None),
            b'}' | b'[' | b']' => {
                self.i += 1;
                Ok(Some(Syn::leaf("word", at, at + 1)))
            }
            b'#' if !first => {
                let end = word_end(self.s, at + 1);
                self.i = end;
                Ok(Some(Syn::leaf("word", at, end)))
            }
            _ => Ok(self.plain_word()),
        }
    }

    /// A word or a number token.
    fn plain_word(&mut self) -> Option<Syn> {
        let at = self.i;
        let end = word_end(self.s, at);
        if end == at {
            return None;
        }
        self.i = end;
        let kind = if number_end(self.s, at).is_some_and(|number| number >= end) {
            "number"
        } else {
            "word"
        };
        Some(Syn::leaf(kind, at, end))
    }

    /// `{N..M}`, which the grammar reads as a brace expression.
    fn brace_expression(&mut self) -> Option<Syn> {
        let at = self.i;
        let digits = |from: usize| {
            let mut to = from;
            while self.s.get(to).is_some_and(u8::is_ascii_digit) {
                to += 1;
            }
            to
        };
        let first = digits(at + 1);
        if first == at + 1 || !self.s[first..].starts_with(b"..") {
            return None;
        }
        let second = digits(first + 2);
        if second == first + 2 || self.s.get(second) != Some(&b'}') {
            return None;
        }
        self.i = second + 1;
        Some(Syn::node(
            "brace_expression",
            vec![
                Syn::token("{", at, at + 1),
                Syn::leaf("number", at + 1, first),
                Syn::token("..", first, first + 2),
                Syn::leaf("number", first + 2, second),
                Syn::token("}", second, second + 1),
            ],
        ))
    }

    /// `'...'`.
    pub(super) fn raw_string(&mut self) -> R<Syn> {
        let at = self.i;
        match memchr::memchr(b'\'', &self.s[at + 1..]) {
            Some(offset) => {
                self.i = at + 1 + offset + 1;
                Ok(Syn::leaf("raw_string", at, self.i))
            }
            None => Err(super::parser::Fail {
                at,
                message: "unexpected EOF while looking for matching `''".into(),
            }),
        }
    }

    /// `$'...'`, where a backslash escapes the quote.
    fn ansi_c_string(&mut self) -> R<Syn> {
        let at = self.i;
        let mut end = at + 2;
        while end < self.s.len() {
            match self.s[end] {
                b'\\' => end += 2,
                b'\'' => {
                    self.i = end + 1;
                    return Ok(Syn::leaf("ansi_c_string", at, self.i));
                }
                _ => end += 1,
            }
        }
        Err(super::parser::Fail {
            at,
            message: "unexpected EOF while looking for matching `''".into(),
        })
    }

    /// `"..."`: text runs, expansions and substitutions. Blanks the text
    /// could start with join the token after them when that token is not
    /// text, as the grammar's lexer prefers it; a newline before them is
    /// only skipped.
    pub(super) fn string(&mut self) -> R<Syn> {
        let open_at = self.i;
        self.i += 1;
        let mut children = vec![Syn::token("\"", open_at, open_at + 1)];
        loop {
            let mut lead = self.i;
            loop {
                match self.peek() {
                    b' ' | b'\t' | 0x0b | 0x0c => self.i += 1,
                    b'\n' | b'\r' => {
                        self.i += 1;
                        lead = self.i;
                    }
                    b'\\' if self.at(1) == b'\n' => self.i += 2,
                    b'\\' if self.at(1) == b'\r' && self.at(2) == b'\n' => self.i += 3,
                    _ => break,
                }
                if self.eof() {
                    break;
                }
            }
            if self.eof() {
                return Err(super::parser::Fail {
                    at: open_at,
                    message: "unexpected EOF while looking for matching `\"'".into(),
                });
            }
            match self.peek() {
                b'"' => {
                    self.i += 1;
                    children.push(Syn::token("\"", lead, self.i));
                    break;
                }
                b'`' => {
                    let mut node = self.backtick()?;
                    retarget_start(&mut node, lead);
                    children.push(node);
                }
                b'$' => {
                    let at = self.i;
                    match self.dollar_in_string()? {
                        Some(mut node) => {
                            retarget_start(&mut node, lead);
                            children.push(node);
                        }
                        None => {
                            self.i = at + 1;
                            children.push(Syn::token("$", lead, at + 1));
                        }
                    }
                }
                _ => {
                    self.i = lead;
                    while !self.eof() {
                        match self.peek() {
                            b'"' | b'`' | b'$' | b'\n' | b'\r' => break,
                            b'\\' => {
                                self.i += if self.at(1) == b'\r' && self.at(2) == b'\n' {
                                    3
                                } else {
                                    2
                                };
                            }
                            _ => self.i += 1,
                        }
                    }
                    self.i = self.i.min(self.s.len());
                    children.push(Syn::leaf("string_content", lead, self.i));
                }
            }
        }
        Ok(Syn::node("string", children))
    }

    /// A `$` construct inside double quotes, or None for a literal `$`.
    fn dollar_in_string(&mut self) -> R<Option<Syn>> {
        match self.at(1) {
            b'{' => self.expansion().map(Some),
            b'(' if self.at(2) == b'(' => self.arithmetic_or_substitution().map(Some),
            b'(' => self.command_substitution().map(Some),
            b'[' => self.bracket_arithmetic().map(Some),
            b'`' => self.dollar_backtick().map(Some),
            byte if is_name(byte) || SPECIAL.contains(&byte) => Ok(self.simple_expansion()),
            _ => Ok(None),
        }
    }

    /// A `$` construct outside double quotes; a lone `$` is a token.
    pub(super) fn dollar(&mut self) -> R<Syn> {
        let at = self.i;
        match self.at(1) {
            b'\'' => self.ansi_c_string(),
            b'"' => {
                self.i += 1;
                let string = self.string()?;
                Ok(Syn::node(
                    "translated_string",
                    vec![Syn::token("$", at, at + 1), string],
                ))
            }
            _ => match self.dollar_in_string()? {
                Some(node) => Ok(node),
                None => {
                    self.i += 1;
                    Ok(Syn::token("$", at, at + 1))
                }
            },
        }
    }

    /// `$name`, `$1` or `$?`.
    pub(super) fn simple_expansion(&mut self) -> Option<Syn> {
        let at = self.i;
        let byte = self.at(1);
        let (kind, end) = if byte.is_ascii_digit() {
            ("variable_name", at + 2)
        } else if byte == b'_' && !is_name(self.at(2)) {
            ("special_variable_name", at + 2)
        } else if is_name_start(byte) {
            ("variable_name", name_end(self.s, at + 1))
        } else if SPECIAL.contains(&byte) {
            ("special_variable_name", at + 2)
        } else {
            return None;
        };
        self.i = end;
        Some(Syn::node(
            "simple_expansion",
            vec![Syn::token("$", at, at + 1), Syn::leaf(kind, at + 1, end)],
        ))
    }

    /// `$(...)` or `$(< file)`.
    pub(super) fn command_substitution(&mut self) -> R<Syn> {
        self.enter()?;
        let open = self.expect("$(")?;
        let mut children = vec![open];
        let saved = self.in_backtick;
        self.in_backtick = false;
        self.comsub += 1;
        let body = self.substitution_body(Close::Paren);
        self.comsub -= 1;
        self.in_backtick = saved;
        children.extend(body?);
        children.push(self.expect(")")?);
        self.leave();
        Ok(Syn::node("command_substitution", children))
    }

    /// The statements of a substitution; a lone redirect is the
    /// `$(< file)` form.
    fn substitution_body(&mut self, close: Close) -> R<Vec<Syn>> {
        self.skip_space();
        let start = self.i;
        if self.at_redirect() && !self.starts(b"<<") {
            let redirect = self.redirect(true)?;
            self.skip_space();
            if self.peek() == b')' {
                return Ok(vec![redirect.with_field("redirect")]);
            }
            self.i = start;
        }
        self.statements(close, None, false)
    }

    /// `` `...` ``.
    /// bash reads a backtick substitution's text when it runs it: what
    /// the grammar cannot read here is one raw word.
    pub(super) fn backtick(&mut self) -> R<Syn> {
        if self.in_backtick {
            return self.fail(self.i);
        }
        self.enter()?;
        let at = self.i;
        let Some(end) = super::lex::quote_end(self.s, at, b'`') else {
            return Err(super::parser::Fail {
                at,
                message: "unexpected EOF while looking for matching ``'".into(),
            });
        };
        let mark = self.mark();
        let open = self.expect("`")?;
        let mut children = vec![open];
        self.in_backtick = true;
        let body = self.statements(Close::Backtick, None, false);
        self.in_backtick = false;
        match body {
            Ok(body) if self.i == end - 1 => children.extend(body),
            _ => {
                self.forget(mark);
                if end - 1 > at + 1 {
                    children.push(Syn::leaf("word", at + 1, end - 1));
                }
                self.i = end - 1;
            }
        }
        children.push(self.expect("`")?);
        self.leave();
        Ok(Syn::node("command_substitution", children))
    }

    /// `` $`...` ``.
    fn dollar_backtick(&mut self) -> R<Syn> {
        self.enter()?;
        let open = self.expect("$`")?;
        let mut children = vec![open];
        self.in_backtick = true;
        let body = self.statements(Close::Backtick, None, false);
        self.in_backtick = false;
        children.extend(body?);
        children.push(self.expect("`")?);
        self.leave();
        Ok(Syn::node("command_substitution", children))
    }

    /// `<(...)` or `>(...)`. bash reads `<((` to the parenthesis that
    /// matches its first and parses that text when it runs it: a body
    /// that does not parse to there is one raw word.
    pub(super) fn process_substitution(&mut self) -> R<Syn> {
        self.enter()?;
        let at = self.i;
        let op = if self.peek() == b'<' { "<(" } else { ">(" };
        let raw_end = if self.at(2) == b'(' {
            Some(
                paren_end(self.s, at + 1).ok_or_else(|| super::parser::Fail {
                    at: self.s.len(),
                    message: "unexpected EOF while looking for matching `)'".into(),
                })?,
            )
        } else {
            None
        };
        self.i += 2;
        let mut children = vec![Syn::token(op, at, at + 2)];
        let mark = self.mark();
        let saved = self.in_backtick;
        self.in_backtick = false;
        self.comsub += 1;
        let body = self.statements(Close::Paren, None, false);
        self.comsub -= 1;
        self.in_backtick = saved;
        match (body, raw_end) {
            (Ok(body), Some(end)) if self.i + 1 == end => children.extend(body),
            (body, None) => children.extend(body?),
            (_, Some(end)) => {
                self.reset(mark);
                self.check_raw(at + 2, end - 1, false)?;
                children.push(Syn::leaf("word", at + 2, end - 1));
                self.i = end - 1;
            }
        }
        children.push(self.expect(")")?);
        self.leave();
        Ok(Syn::node("process_substitution", children))
    }

    /// `$((`: an arithmetic expansion, or a command substitution whose
    /// first command is a subshell when the text does not read as one.
    /// `$((`: arithmetic when the parentheses close with `))`, else a
    /// command substitution, which bash then parses when it runs it.
    pub(super) fn arithmetic_or_substitution(&mut self) -> R<Syn> {
        if self.double_paren_end(self.i + 1).is_some() {
            return self.arithmetic_expansion();
        }
        let at = self.i;
        let mark = self.mark();
        match self.command_substitution() {
            Ok(node) => Ok(node),
            Err(fail) => {
                let Some(end) = paren_end(self.s, at + 1) else {
                    return Err(fail);
                };
                self.reset(mark);
                self.check_raw(at + 2, end - 1, false)?;
                self.i = end;
                Ok(Syn::node(
                    "command_substitution",
                    vec![
                        Syn::token("$(", at, at + 2),
                        Syn::leaf("word", at + 2, end - 1),
                        Syn::token(")", end - 1, end),
                    ],
                ))
            }
        }
    }

    /// `double_paren_end`, with each `$(...)` inside read by the parser,
    /// so a `)` of a case pattern there does not close the outer pair.
    pub(super) fn double_paren_end(&self, at: usize) -> Option<usize> {
        let mut depth = 0usize;
        let mut end = at + 2;
        while end < self.s.len() {
            match self.s[end] {
                b'\\' => end += 1,
                b'\'' | b'"' | b'`' => {
                    end = super::lex::quote_end(self.s, end, self.s[end])?;
                    continue;
                }
                b'$' if self.s.get(end + 1) == Some(&b'(')
                    && self.s.get(end + 2) != Some(&b'(') =>
                {
                    let mut probe = self.probe(end);
                    probe.command_substitution().ok()?;
                    end = probe.i;
                    continue;
                }
                b'(' => depth += 1,
                b')' if depth > 0 => depth -= 1,
                b')' => {
                    return (self.s.get(end + 1) == Some(&b')')).then_some(end + 2);
                }
                _ => {}
            }
            end += 1;
        }
        None
    }

    /// bash parses the command substitutions inside text it reads raw,
    /// and its quoted strings, so one there that does not parse is
    /// refused; `braces` checks a bare `${` too.
    pub(super) fn check_raw(&self, start: usize, end: usize, braces: bool) -> R<()> {
        let mut at = start;
        while at < end {
            match self.s[at] {
                b'\\' => at += 2,
                b'\'' => {
                    at = super::lex::quote_end(self.s, at, b'\'')
                        .ok_or_else(|| self.unexpected(self.s.len()))?
                }
                b'"' => {
                    let mut probe = self.probe(at);
                    probe.string()?;
                    at = probe.i;
                }
                b'$' if self.s.get(at + 1) == Some(&b'{') && !braces => at += 2,
                b'$' if matches!(self.s.get(at + 1), Some(b'(' | b'{')) => {
                    let mut probe = self.probe(at);
                    if self.s[at + 1] == b'{' {
                        probe.expansion()?;
                    } else if self.s.get(at + 2) == Some(&b'(') {
                        probe.arithmetic_or_substitution()?;
                    } else {
                        probe.command_substitution()?;
                    }
                    at = probe.i;
                }
                _ => at += 1,
            }
        }
        Ok(())
    }

    /// A parser over the same source at `at`, for a look ahead.
    pub(super) fn probe(&self, at: usize) -> Parser<'_> {
        Parser {
            s: self.s,
            i: at,
            comments: Vec::new(),
            depth: self.depth,
            in_backtick: false,
            pending: Vec::new(),
            saved: Vec::new(),
            comsub: self.comsub,
            line_break: false,
            braces: self.braces,
            work: self.work,
        }
    }
}

/// Past the `)` closing the `(` at `at`, quotes skipped.
fn paren_end(s: &[u8], at: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut end = at;
    while end < s.len() {
        match s[end] {
            b'\\' => end += 1,
            b'\'' | b'"' | b'`' => {
                end = super::lex::quote_end(s, end, s[end])?;
                continue;
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(end + 1);
                }
            }
            _ => {}
        }
        end += 1;
    }
    None
}

/// Move a node's start, and its first token's, back over blanks the
/// grammar lexed into that token.
fn retarget_start(node: &mut Syn, start: usize) {
    if start >= node.start {
        return;
    }
    node.start = start;
    if let Some(first) = node.children.first_mut() {
        retarget_start(first, start);
    }
}
