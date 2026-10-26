// Concatenation and variable-name token rules adapted from tree-sitter-bash
// 0.25.1, src/scanner.c.
// https://github.com/tree-sitter/tree-sitter-bash
// Licensed under MIT. See licenses/third_party/tree-sitter-bash-parser.txt.
use super::lex::{
    blank_end, digits_end, is_blank, is_name, is_name_start, is_space, name_end, number_end,
    word_end,
};
use super::parser::{Close, Fail, Parser, R};
use super::tree::Syn;

/// What closes the construct a word sits in, which ends the word.
#[derive(Clone, Copy, Default)]
pub(super) struct Ctx {
    /// `}` closes it: an expansion's body.
    pub brace: bool,
    /// `]` closes it: a subscript or a `[` test.
    pub bracket: bool,
    /// Inside `[[`, where only a pattern operand reads extglob groups.
    pub conditional: bool,
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
        self.word_from(first, ctx).map(Some)
    }

    /// The word `first` starts: it alone, or it and the pieces after it as
    /// a concatenation.
    pub(super) fn word_from(&mut self, first: Syn, ctx: Ctx) -> R<Syn> {
        let mut pieces = vec![first];
        loop {
            // bash reads an extglob group in any word; the extglob option
            // only decides whether it may run, which the syntax check knows.
            let word = pieces
                .last()
                .is_some_and(|last| last.is("word") && last.end == self.i);
            if self.peek() == b'(' && word && !ctx.conditional && self.at_extglob_group() {
                self.extglob_group(&mut pieces, "word")?;
                continue;
            }
            if !self.concat_continues(ctx) {
                break;
            }
            match self.piece(ctx, false)? {
                Some(piece) => pieces.push(piece),
                None => break,
            }
        }
        Ok(Syn::concat(pieces).expect("a first piece"))
    }

    /// Whether the `(` at the cursor opens an extglob group: an unescaped
    /// `?`, `*`, `+`, `@` or `!` comes right before it.
    pub(super) fn at_extglob_group(&self) -> bool {
        self.i > 0
            && matches!(self.s[self.i - 1], b'?' | b'*' | b'+' | b'@' | b'!')
            && !super::lex::escaped(self.s, self.i - 1)
    }

    /// The extglob group whose `(` is at the cursor, as bash reads it: its
    /// parentheses matched across blanks and newlines, its text runs of
    /// `kind`, which join the run before them, and the quotes, expansions
    /// and substitutions in it pieces of their own.
    pub(super) fn extglob_group(&mut self, pieces: &mut Vec<Syn>, kind: &'static str) -> R<()> {
        let mut depth = 0usize;
        let mut run = self.i;
        loop {
            if self.eof() {
                return Err(Fail::eof(self.s.len(), ')'));
            }
            let at = self.i;
            let piece = match self.peek() {
                b'(' => {
                    depth += 1;
                    None
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        self.i += 1;
                        break;
                    }
                    None
                }
                b'\\' => {
                    self.i += 2;
                    None
                }
                b'"' => Some(self.string()?),
                b'\'' => Some(self.raw_string()?),
                b'`' => Some(self.backtick()?),
                b'$' => Some(self.dollar()?).filter(|node| !node.is("$")),
                b'<' | b'>' if self.at(1) == b'(' => Some(self.process_substitution()?),
                _ => None,
            };
            match piece {
                Some(piece) => {
                    push_run(pieces, kind, run, at);
                    pieces.push(piece);
                    run = self.i;
                }
                None if self.i == at => self.i += 1,
                None => {}
            }
        }
        self.i = self.i.min(self.s.len());
        push_run(pieces, kind, run, self.i);
        Ok(())
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
            next = blank_end(self.s, next);
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
            to = digits_end(self.s, to);
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
            None => Err(Fail::eof(at, '\'')),
        }
    }

    /// `$'...'`, where a backslash escapes the quote.
    fn ansi_c_string(&mut self) -> R<Syn> {
        let at = self.i;
        let Some(end) = super::lex::ansi_c_end(self.s, at) else {
            return Err(Fail::eof(at, '\''));
        };
        self.i = end;
        Ok(Syn::leaf("ansi_c_string", at, end))
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
                return Err(Fail::eof(open_at, '"'));
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
    pub(super) fn dollar_in_string(&mut self) -> R<Option<Syn>> {
        match self.at(1) {
            b'{' => self.expansion().map(Some),
            b'(' if self.at(2) == b'(' => self.arithmetic_or_substitution().map(Some),
            b'(' => self.command_substitution().map(Some),
            b'[' => self.bracket_arithmetic().map(Some),
            b'`' => self.backtick().map(Some),
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
        let body = self.substituted(|parser| parser.substitution_body(Close::Paren));
        children.extend(body?);
        children.push(self.expect(")")?);
        self.leave();
        Ok(Syn::node("command_substitution", children))
    }

    /// `read` inside a `$(...)` or `<(...)`, where a backtick is text and
    /// a newline reads only the heredocs opened inside.
    fn substituted<T>(&mut self, read: impl FnOnce(&mut Self) -> T) -> T {
        let saved = self.in_backtick;
        self.in_backtick = false;
        self.comsub += 1;
        let body = read(self);
        self.comsub -= 1;
        self.in_backtick = saved;
        body
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

    /// `` `...` `` or `` $`...` ``.
    /// bash reads a backtick substitution's text when it runs it: what
    /// the grammar cannot read here, or a body that leaves a heredoc
    /// open at its end, is one raw word.
    pub(super) fn backtick(&mut self) -> R<Syn> {
        if self.in_backtick {
            return self.fail(self.i);
        }
        self.enter()?;
        let open = if self.peek() == b'$' { "$`" } else { "`" };
        let at = self.i + open.len() - 1;
        let Some(end) = super::lex::quote_end(self.s, at, b'`') else {
            return Err(Fail::eof(at, '`'));
        };
        let mark = self.mark();
        let pending = self.pending.len();
        let open = self.expect(open)?;
        let mut children = vec![open];
        self.in_backtick = true;
        let body = self.statements(Close::Backtick, None, false);
        self.in_backtick = false;
        match body {
            Ok(body) if self.i == end - 1 && self.pending.len() == pending => children.extend(body),
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

    /// `<(...)` or `>(...)`. bash reads `<((` to the parenthesis that
    /// matches its first and parses that text when it runs it: a body
    /// that does not parse to there is one raw word.
    pub(super) fn process_substitution(&mut self) -> R<Syn> {
        self.enter()?;
        let at = self.i;
        let op = if self.peek() == b'<' { "<(" } else { ">(" };
        let raw_end = if self.at(2) == b'(' {
            Some(
                super::lex::pair_end(self.s, at + 1, b'(', b')')
                    .ok_or_else(|| Fail::eof(self.s.len(), ')'))?,
            )
        } else {
            None
        };
        self.i += 2;
        let mut children = vec![Syn::token(op, at, at + 2)];
        let mark = self.mark();
        let body = self.substituted(|parser| parser.statements(Close::Paren, None, false));
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

    /// `$((`: arithmetic when the parentheses close with `))`, else a
    /// command substitution whose first command is a subshell, which bash
    /// parses when it runs it.
    pub(super) fn arithmetic_or_substitution(&mut self) -> R<Syn> {
        if self.double_paren_end(self.i + 1).is_some() {
            return self.arithmetic_expansion();
        }
        let at = self.i;
        let mark = self.mark();
        match self.command_substitution() {
            Ok(node) => Ok(node),
            Err(fail) => {
                let Some(end) = super::lex::pair_end(self.s, at + 1, b'(', b')') else {
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

    /// Past the `))` closing the `((` at `at`, if the pair closes with
    /// one; each `$(...)` inside is read by the parser, so a `)` of a case
    /// pattern there does not close the outer pair.
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
                b'$' if self.s.get(end + 1) == Some(&b'\'') => {
                    end = super::lex::ansi_c_end(self.s, end)?;
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
                b'$' if self.s.get(at + 1) == Some(&b'\'') => {
                    at = super::lex::ansi_c_end(self.s, at)
                        .ok_or_else(|| self.unexpected(self.s.len()))?;
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
            i: at,
            depth: self.depth,
            comsub: self.comsub,
            braces: self.braces,
            ..Parser::new(self.s, self.work, self.aliases)
        }
    }
}

/// Text from `start` to `end` as a run of `kind`, joining a run of it that
/// ends there.
pub(super) fn push_run(pieces: &mut Vec<Syn>, kind: &'static str, start: usize, end: usize) {
    if end <= start {
        return;
    }
    match pieces.last_mut() {
        Some(last) if last.is(kind) && last.children.is_empty() && last.end == start => {
            last.end = end
        }
        _ => pieces.push(Syn::leaf(kind, start, end)),
    }
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
