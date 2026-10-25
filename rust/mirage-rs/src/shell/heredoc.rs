use super::lex::{is_blank, is_space};
use super::parser::{Fail, Parser, R};
use super::tree::Syn;

/// A heredoc whose operator line has been read and whose body has not.
#[derive(Debug, Clone)]
pub(super) struct Pending {
    pub delimiter: Vec<u8>,
    /// How many substitutions enclose its operator: bash reads the bodies
    /// of the innermost first.
    pub depth: usize,
    /// A quoted delimiter: the body is not expanded.
    pub raw: bool,
    /// `<<-`: leading tabs are stripped.
    pub dash: bool,
}

impl Parser<'_> {
    /// `<<word` and what follows it on its line, then its body. `children`
    /// holds the descriptor, if any. A second heredoc on a line, or one
    /// whose line goes on past what the grammar nests in its redirect,
    /// leaves its body to be read after the line.
    pub(super) fn heredoc(&mut self, mut children: Vec<Syn>) -> R<Syn> {
        let at = self.i;
        let dash = self.starts(b"<<-");
        let op = if dash { "<<-" } else { "<<" };
        self.i += op.len();
        children.push(Syn::token(op, at, self.i));
        while is_blank(self.peek()) && !self.eof() {
            self.i += 1;
        }
        let (start, end, delimiter, raw) = self.heredoc_word()?;
        children.push(Syn::leaf("heredoc_start", start, end));
        let pending = Pending {
            delimiter,
            depth: self.comsub,
            raw,
            dash,
        };
        if !self.pending.is_empty() {
            self.pending.push(pending);
            return Ok(Syn::node("heredoc_redirect", children));
        }
        self.skip_blank();
        if self.peek() == b'\n' || self.eof() {
            return self.heredoc_finish(children, pending);
        }
        let mark = self.mark();
        let kept = children.len();
        match self.heredoc_tail(&mut children) {
            Ok(()) if (self.peek() == b'\n' || self.eof()) && self.pending.is_empty() => {
                self.heredoc_finish(children, pending)
            }
            _ => {
                self.reset(mark);
                children.truncate(kept);
                self.pending.push(pending);
                Ok(Syn::node("heredoc_redirect", children))
            }
        }
    }

    /// The delimiter word: its span, its text with quotes removed, and
    /// whether any part of it was quoted.
    fn heredoc_word(&mut self) -> R<(usize, usize, Vec<u8>, bool)> {
        let start = self.i;
        let end = self.word_extent(start)?;
        if end == start {
            return self.fail(start);
        }
        self.i = end;
        let (text, raw) = unquote(&self.s[start..end]);
        Ok((start, end, text, raw))
    }

    /// Where a shell word starting at `at` ends: at an unquoted blank or
    /// operator, with quotes and `$(...)`, `${...}` and backticks inside
    /// it taken whole.
    pub(super) fn word_extent(&self, at: usize) -> R<usize> {
        let s = self.s;
        let mut end = at;
        while end < s.len() {
            let byte = s[end];
            if is_space(byte) || matches!(byte, b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')') {
                break;
            }
            end = match byte {
                b'\\' => end + 2,
                b'\'' => close_quote(s, end, b'\'').ok_or_else(|| self.unexpected(s.len()))?,
                b'"' => close_quote(s, end, b'"').ok_or_else(|| self.unexpected(s.len()))?,
                b'`' => close_quote(s, end, b'`').ok_or_else(|| self.unexpected(s.len()))?,
                b'$' if matches!(s.get(end + 1), Some(b'(' | b'{')) => {
                    let (open, close) = if s[end + 1] == b'(' {
                        (b'(', b')')
                    } else {
                        (b'{', b'}')
                    };
                    close_nested(s, end + 1, open, close).ok_or_else(|| self.unexpected(s.len()))?
                }
                b'$' if s.get(end + 1) == Some(&b'\'') => {
                    close_quote(s, end + 1, b'\'').ok_or_else(|| self.unexpected(s.len()))?
                }
                _ => end + 1,
            };
        }
        Ok(end.min(s.len()))
    }

    /// What tree-sitter-bash reads after a heredoc's word on its line: a
    /// pipe into a statement, redirects and an and-or tail, an and-or
    /// tail, or more words of the command.
    fn heredoc_tail(&mut self, children: &mut Vec<Syn>) -> R<()> {
        if self.peek() == b'|' && self.at(1) != b'|' {
            let at = self.i;
            let op = if self.at(1) == b'&' { "|&" } else { "|" };
            self.i += op.len();
            self.skip_space();
            let statement = self.heredoc_pipeline()?;
            children.push(Syn::node(
                "pipeline",
                vec![Syn::token(op, at, at + op.len()), statement],
            ));
            return Ok(());
        }
        let mut redirected = false;
        while self.at_redirect() && !self.starts(b"<<") || self.starts(b"<<<") {
            let redirect = if self.starts(b"<<<") {
                self.herestring()?
            } else {
                self.redirect(true)?
            };
            children.push(redirect.with_field("redirect"));
            redirected = true;
            self.skip_blank();
        }
        if self.starts(b"&&") || self.starts(b"||") {
            let at = self.i;
            let op = if self.peek() == b'&' { "&&" } else { "||" };
            self.i += 2;
            children.push(Syn::token(op, at, at + 2).with_field("operator"));
            self.skip_space();
            children.push(self.statement()?.with_field("right"));
            return Ok(());
        }
        if redirected {
            return Ok(());
        }
        let mut any = false;
        loop {
            self.skip_blank();
            if self.at_command_end() {
                break;
            }
            match self.literal_opt(super::word::Ctx::default())? {
                Some(word) => {
                    children.push(word.with_field("argument"));
                    any = true;
                }
                None => break,
            }
        }
        if any { Ok(()) } else { self.fail(self.i) }
    }

    /// The statement a heredoc's line pipes into. A redirect after a
    /// pipeline there wraps only its last two commands, as the grammar
    /// reduces it.
    fn heredoc_pipeline(&mut self) -> R<Syn> {
        let statement = self.statement()?;
        if !statement.is("redirected_statement") {
            return Ok(statement);
        }
        let mut statement = statement;
        let mut children = std::mem::take(&mut statement.children);
        let mut body = children.remove(0);
        if !body.is("pipeline") || body.children.len() < 5 {
            children.insert(0, body);
            return Ok(Syn::node("redirected_statement", children));
        }
        let mut stages = std::mem::take(&mut body.children);
        let tail = stages.split_off(stages.len() - 3);
        children.insert(0, Syn::node("pipeline", tail).with_field("body"));
        stages.push(Syn::node("redirected_statement", children));
        Ok(Syn::node("pipeline", stages))
    }

    /// The newline after the operator line, the body and the delimiter.
    fn heredoc_finish(&mut self, mut children: Vec<Syn>, pending: Pending) -> R<Syn> {
        if self.peek() == b'\n' {
            let end = self.body_newline_end(Some(&pending));
            children.push(Syn::hidden(self.i, end));
            self.i = end;
        }
        if !self.pending.is_empty() {
            return Err(Fail {
                at: self.i,
                message: "here-document read out of order".into(),
            });
        }
        children.extend(self.heredoc_body(&pending)?);
        Ok(Syn::node("heredoc_redirect", children))
    }

    /// Read the bodies of every pending heredoc after a newline, in order.
    pub(super) fn pending_bodies(&mut self) -> R<Vec<Syn>> {
        let pending = self.take_readable();
        let mut nodes: Vec<Syn> = Vec::new();
        for heredoc in &pending {
            // An empty delimiter's line is its own newline.
            if nodes
                .last()
                .is_some_and(|end| end.is("heredoc_end") && end.start == end.end)
                && self.peek() == b'\n'
            {
                self.i += 1;
            }
            nodes.extend(self.heredoc_body(heredoc)?);
        }
        Ok(nodes)
    }

    /// Take the pending heredocs a newline here reads, the deepest first:
    /// inside a substitution, only those opened in it.
    fn take_readable(&mut self) -> Vec<Pending> {
        let all = std::mem::take(&mut self.pending);
        self.saved.push(all.clone());
        let comsub = self.comsub;
        let (mut readable, outer): (Vec<_>, Vec<_>) =
            all.into_iter().partition(|heredoc| heredoc.depth >= comsub);
        self.pending = outer;
        readable.sort_by_key(|heredoc| std::cmp::Reverse(heredoc.depth));
        readable
    }

    /// The heredoc a newline here reads first, if any: the deepest, the
    /// earliest of those.
    pub(super) fn first_readable(&self) -> Option<&Pending> {
        self.pending
            .iter()
            .filter(|heredoc| heredoc.depth >= self.comsub)
            .rev()
            .max_by_key(|heredoc| heredoc.depth)
    }

    /// Where the newline token before heredoc bodies ends, `first` the
    /// heredoc read first: the grammar lexes the blank lines after it into
    /// the token, but an empty delimiter ends a body at the first of them.
    pub(super) fn body_newline_end(&self, first: Option<&Pending>) -> usize {
        if first.is_some_and(|heredoc| heredoc.delimiter.is_empty()) {
            self.i + 1
        } else {
            self.newline_end()
        }
    }

    /// The blanks, comments and newlines between an array's elements.
    /// bash reads the pending heredocs' bodies at a newline there, then
    /// keeps them pending with each body's text as the delimiter: the next
    /// newline reads them again, and that body is the one the redirect
    /// gets.
    pub(super) fn array_space(&mut self) -> R<()> {
        loop {
            self.skip_blank();
            if self.peek() != b'\n' {
                return Ok(());
            }
            self.i += 1;
            let mut pending = self.take_readable();
            for heredoc in &mut pending {
                let start = self.i;
                let nodes = self.heredoc_body(heredoc)?;
                let end = match nodes.last() {
                    Some(node) if node.is("heredoc_end") => {
                        memchr::memrchr(b'\n', &self.s[start..node.start])
                            .map_or(start, |offset| start + offset + 1)
                    }
                    _ => self.s.len(),
                };
                let mut text = Vec::new();
                for line in self.s[start..end].split_inclusive(|byte| *byte == b'\n') {
                    let tabs = if heredoc.dash {
                        line.iter().take_while(|byte| **byte == b'\t').count()
                    } else {
                        0
                    };
                    text.extend_from_slice(&line[tabs..]);
                }
                heredoc.delimiter = text;
                if end < self.s.len() && self.peek() == b'\n' {
                    self.i += 1;
                }
            }
            self.pending.extend(pending);
        }
    }

    /// One body and its delimiter line, as tree-sitter-bash's scanner
    /// tokenizes them: text runs as `heredoc_content` around the
    /// expansions an unquoted body holds, or one plain body.
    fn heredoc_body(&mut self, heredoc: &Pending) -> R<Vec<Syn>> {
        let mut children = Vec::new();
        let mut body_start = None;
        let mut started = false;
        loop {
            let token_start = self.i;
            match self.scan_content(heredoc, started) {
                Content::End { start, end } => {
                    // The text before the delimiter line, then the line.
                    let first = *body_start.get_or_insert(start);
                    if started {
                        children.push(Syn::leaf("heredoc_content", start, end));
                    }
                    let body = if started {
                        let mut body = Syn::node("heredoc_body", std::mem::take(&mut children));
                        body.start = first;
                        body
                    } else {
                        Syn::leaf("heredoc_body", start, end)
                    };
                    let delimiter_end = self.delimiter_end(heredoc);
                    let mut nodes = vec![body];
                    if let Some(stop) = delimiter_end {
                        nodes.push(Syn::leaf("heredoc_end", self.i, stop));
                        self.i = stop;
                        // The rest of a delimiter line inside a command
                        // substitution is read as the next command.
                        self.line_break = !matches!(self.s.get(stop), None | Some(b'\n'));
                    }
                    return Ok(nodes);
                }
                Content::Expansion { start, end } => {
                    if started {
                        if end > start || body_start.is_some() {
                            children.push(Syn::leaf("heredoc_content", start, end));
                        }
                    } else {
                        body_start = Some(start);
                        started = true;
                    }
                    self.i = end;
                    let mark = self.mark();
                    let parsed = match self.at(1) {
                        b'{' => self.expansion(),
                        b'(' if self.at(2) == b'(' => self.arithmetic_or_substitution(),
                        b'(' => self.command_substitution(),
                        _ => Err(Fail {
                            at: end,
                            message: String::new(),
                        }),
                    };
                    let node = match parsed {
                        Ok(node) => node,
                        Err(_) => {
                            self.reset(mark);
                            if super::lex::is_name_start(self.at(1)) {
                                let name_end = super::lex::name_end(self.s, end + 1);
                                self.i = name_end;
                                Syn::node(
                                    "simple_expansion",
                                    vec![
                                        Syn::token("$", end, end + 1),
                                        Syn::leaf("variable_name", end + 1, name_end),
                                    ],
                                )
                            } else {
                                // bash reads a body's substitutions when it
                                // expands them: one that does not parse is
                                // text here.
                                let text_end = self.text_through_line(end);
                                children.push(Syn::leaf("heredoc_content", end, text_end));
                                self.i = text_end;
                                continue;
                            }
                        }
                    };
                    children.push(node);
                }
                Content::Unterminated => {
                    // bash takes the body to the end of the input.
                    let first = body_start.unwrap_or(token_start);
                    let end = self.s.len();
                    self.i = end;
                    if !started {
                        return Ok(vec![Syn::leaf("heredoc_body", first, end)]);
                    }
                    let rest = &self.s[token_start..end];
                    let mut nodes = Vec::new();
                    if rest.is_empty() || rest == b"\n" {
                        let mut body = Syn::node("heredoc_body", std::mem::take(&mut children));
                        body.start = first;
                        nodes.push(body);
                        nodes.push(Syn::leaf("heredoc_end", end, end));
                    } else {
                        children.push(Syn::leaf("heredoc_content", token_start, end));
                        let mut body = Syn::node("heredoc_body", std::mem::take(&mut children));
                        body.start = first;
                        nodes.push(body);
                    }
                    return Ok(nodes);
                }
            }
        }
    }

    /// The end of the line holding `at`, past its newline.
    fn text_through_line(&self, at: usize) -> usize {
        memchr::memchr(b'\n', &self.s[at..]).map_or(self.s.len(), |offset| at + offset + 1)
    }

    /// Whether the line at the cursor is the delimiter's, after the tabs
    /// `<<-` strips, which it moves past.
    fn at_delimiter_line(&mut self, heredoc: &Pending) -> bool {
        let line = self.i;
        if heredoc.dash {
            while self.peek() == b'\t' {
                self.i += 1;
            }
        }
        if self.delimiter_end(heredoc).is_some() {
            return true;
        }
        self.i = line;
        false
    }

    /// Where the delimiter line's match ends, when the line at the cursor
    /// is the delimiter. Inside a command substitution bash also ends the
    /// body at a line that only starts with it, and the line goes on.
    fn delimiter_end(&self, heredoc: &Pending) -> Option<usize> {
        if heredoc.delimiter.contains(&b'\n') {
            return None;
        }
        let rest = &self.s[self.i..];
        let end = self.i + heredoc.delimiter.len();
        let whole = matches!(self.s.get(end), None | Some(b'\n'));
        let prefix = self.comsub > 0 && !heredoc.delimiter.is_empty();
        (rest.starts_with(&heredoc.delimiter) && (whole || prefix)).then_some(end)
    }

    /// Scan body text from the cursor up to the next expansion or the
    /// delimiter line.
    fn scan_content(&mut self, heredoc: &Pending, started: bool) -> Content {
        let mut start = self.i;
        let mut advanced = false;
        let mut skipped = false;
        let column0 = |at: usize, s: &[u8]| at == 0 || s[at - 1] == b'\n';
        loop {
            if self.eof() {
                return Content::Unterminated;
            }
            match self.peek() {
                b'\\' => {
                    advanced = true;
                    self.i += 2;
                    self.i = self.i.min(self.s.len());
                }
                b'$' if !heredoc.raw => {
                    let next = self.at(1);
                    if advanced {
                        let end = self.i;
                        if next.is_ascii_alphabetic() || next == b'{' || next == b'(' {
                            return Content::Expansion { start, end };
                        }
                        self.i += 1;
                    } else if !started && column0(self.i, self.s) {
                        if next.is_ascii_alphabetic() || next == b'{' || next == b'(' {
                            return Content::Expansion {
                                start: self.i,
                                end: self.i,
                            };
                        }
                        advanced = true;
                        self.i += 1;
                    } else if next.is_ascii_alphabetic() || next == b'{' || next == b'(' {
                        return Content::Expansion {
                            start: self.i,
                            end: self.i,
                        };
                    } else {
                        advanced = true;
                        self.i += 1;
                    }
                }
                b'\n' if heredoc.delimiter.is_empty() && column0(self.i, self.s) => {
                    return Content::End {
                        start: if advanced { start } else { self.i },
                        end: self.i,
                    };
                }
                b'\n' => {
                    self.i += 1;
                    if !advanced {
                        start = self.i;
                    }
                    advanced = true;
                    if self.at_delimiter_line(heredoc) {
                        return Content::End { start, end: self.i };
                    }
                }
                _ => {
                    if column0(self.i, self.s) {
                        if self.at_delimiter_line(heredoc) {
                            if !advanced {
                                start = self.i;
                            }
                            return Content::End { start, end: self.i };
                        }
                        if !advanced && !skipped && !heredoc.delimiter.is_empty() {
                            // The first line's leading blanks are no part of
                            // the body's span, as the grammar scans it.
                            skipped = true;
                            while is_space(self.peek()) && !self.eof() {
                                self.i += 1;
                                start = self.i;
                            }
                            if self.eof() {
                                return Content::Unterminated;
                            }
                            if column0(self.i, self.s) && self.at_delimiter_line(heredoc) {
                                return Content::End { start, end: self.i };
                            }
                            continue;
                        }
                    }
                    advanced = true;
                    self.i += 1;
                }
            }
        }
    }
}

enum Content {
    /// Text from `start` to `end`, then the delimiter line at the cursor.
    End {
        start: usize,
        end: usize,
    },
    /// Text from `start` to `end`, then an expansion at `end`.
    Expansion {
        start: usize,
        end: usize,
    },
    Unterminated,
}

/// Past the quote that closes the one at `at`; a backslash escapes in
/// double quotes and backticks.
fn close_quote(s: &[u8], at: usize, quote: u8) -> Option<usize> {
    let mut end = at + 1;
    while end < s.len() {
        if s[end] == b'\\' && quote != b'\'' {
            end += 2;
            continue;
        }
        if s[end] == quote {
            return Some(end + 1);
        }
        end += 1;
    }
    None
}

/// Past the bracket that closes the one at `at`, quotes inside skipped.
fn close_nested(s: &[u8], at: usize, open: u8, close: u8) -> Option<usize> {
    let mut depth = 0usize;
    let mut end = at;
    while end < s.len() {
        match s[end] {
            b'\\' => end += 1,
            b'\'' | b'"' | b'`' => {
                end = close_quote(s, end, s[end])?;
                continue;
            }
            byte if byte == open => depth += 1,
            byte if byte == close => {
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

/// A delimiter word with its quotes removed, and whether it had any.
fn unquote(word: &[u8]) -> (Vec<u8>, bool) {
    let mut text = Vec::new();
    let mut quoted = false;
    let mut at = 0;
    while at < word.len() {
        match word[at] {
            b'\\' => {
                quoted = true;
                if let Some(next) = word.get(at + 1) {
                    text.push(*next);
                }
                at += 2;
            }
            b'\'' => {
                quoted = true;
                let end = close_quote(word, at, b'\'').unwrap_or(word.len());
                text.extend_from_slice(&word[at + 1..end.saturating_sub(1).max(at + 1)]);
                at = end;
            }
            b'"' => {
                quoted = true;
                let end = close_quote(word, at, b'"').unwrap_or(word.len());
                let mut inner = at + 1;
                while inner + 1 < end {
                    if word[inner] == b'\\'
                        && matches!(word.get(inner + 1), Some(b'"' | b'\\' | b'$' | b'`'))
                    {
                        inner += 1;
                    }
                    text.push(word[inner]);
                    inner += 1;
                }
                at = end;
            }
            b'$' if word.get(at + 1) == Some(&b'\'') => {
                quoted = true;
                let end = close_quote(word, at + 1, b'\'').unwrap_or(word.len());
                ansi_c(&word[at + 2..end.saturating_sub(1).max(at + 2)], &mut text);
                at = end;
            }
            b'$' if word.get(at + 1) == Some(&b'"') => {
                at += 1;
            }
            byte => {
                text.push(byte);
                at += 1;
            }
        }
    }
    (text, quoted)
}

/// `$'...'` text with its escapes applied.
fn ansi_c(text: &[u8], out: &mut Vec<u8>) {
    let mut at = 0;
    while at < text.len() {
        if text[at] != b'\\' || at + 1 >= text.len() {
            out.push(text[at]);
            at += 1;
            continue;
        }
        let escaped = match text[at + 1] {
            b'a' => 7,
            b'b' => 8,
            b'e' | b'E' => 0x1b,
            b'f' => 0x0c,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'v' => 0x0b,
            other => other,
        };
        out.push(escaped);
        at += 2;
    }
}
