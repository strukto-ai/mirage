use super::lex::{digits_end, is_blank, is_name, is_name_start, is_operator, is_space, name_end};
use super::parser::{Mark, Parser, R};
use super::tree::Syn;

impl Parser<'_> {
    /// A simple command, assignments alone, or redirects alone.
    pub(super) fn command(&mut self) -> R<Syn> {
        let mut prefix: Vec<Syn> = Vec::new();
        let mut marks = Vec::new();
        // bash refuses an array assignment once a redirect has followed an
        // assignment, and reads a first assignment after a redirect more
        // strictly.
        let mut assigned = false;
        let mut redirected = false;
        let mut poisoned = false;
        loop {
            self.skip_blank();
            marks.push(self.mark());
            if self.at_assignment() {
                if poisoned && self.at_compound_assignment() {
                    let open = self.s[self.i..]
                        .iter()
                        .position(|byte| *byte == b'(')
                        .unwrap_or(0);
                    return self.fail(self.i + open);
                }
                prefix.push(self.assignment(redirected && !assigned)?);
                assigned = true;
            } else if self.at_herestring() {
                (poisoned, redirected) = (assigned, true);
                prefix.push(self.herestring()?.with_field("redirect"));
            } else if self.at_redirect() {
                (poisoned, redirected) = (assigned, true);
                if self.starts(b"<<") && !prefix.is_empty() {
                    break;
                }
                if self.starts(b"<<") {
                    // A heredoc with no command: its redirect stands alone.
                    let mut children = Vec::new();
                    while self.at_redirect() || self.at_herestring() {
                        let redirect = if self.at_herestring() {
                            self.herestring()?
                        } else {
                            self.redirect(true)?
                        };
                        children.push(redirect.with_field("redirect"));
                        self.skip_blank();
                    }
                    return Ok(Syn::node("redirected_statement", children));
                }
                prefix.push(self.redirect(false)?.with_field("redirect"));
            } else {
                marks.pop();
                break;
            }
        }
        self.skip_blank();
        if prefix.is_empty() && self.at_command_end() {
            return self.fail(self.i);
        }
        // `name[` opens a subscript bash reads to its `]` at the start of a
        // command.
        if !assigned && is_name_start(self.peek()) {
            let end = name_end(self.s, self.i);
            if self.s.get(end) == Some(&b'[') {
                self.scan_bracket(end + 1, end)?;
            }
        }
        if self.at_command_end() || self.at_word(b"}") && !prefix.is_empty() {
            return self.statement_without_name(prefix, &marks);
        }
        let Some(name) = self.literal_opt(super::word::Ctx::default())? else {
            if prefix.is_empty() {
                return self.fail(self.i);
            }
            return self.statement_without_name(prefix, &marks);
        };
        let coproc = name.is("word") && &self.s[name.start..name.end] == b"coproc";
        let assigns = name.is("word")
            && [
                &b"alias"[..],
                b"declare",
                b"typeset",
                b"export",
                b"readonly",
                b"local",
                b"eval",
                b"let",
            ]
            .contains(&&self.s[name.start..name.end]);
        let unprefixed = prefix.is_empty();
        let mut children = prefix;
        children.push(Syn::node("command_name", vec![name]).with_field("name"));
        self.skip_blank();
        // A name and `(` begin a function definition, which needs its `)`.
        if unprefixed && !coproc && self.peek() == b'(' && !self.at_process_substitution() {
            let open = self.i;
            self.i += 1;
            self.skip_blank();
            if self.peek() != b')' {
                return self.fail(self.i);
            }
            self.i = open;
        }
        if coproc && !self.at_command_end() && !self.starts(b"(") {
            let at = self.i;
            if let Some(word) = self.literal_opt(super::word::Ctx::default())? {
                self.skip_blank();
                if self.starts_compound() {
                    children.push(word.with_field("argument"));
                } else {
                    self.i = at;
                }
            }
        }
        if coproc && (self.at_command_end() && !self.starts(b"(") || self.at_any_closer()) {
            return self.fail(self.i);
        }
        if coproc
            && (self.peek() == b'(' && !self.at_process_substitution() || self.starts_compound())
        {
            children.push(self.element()?);
            return Ok(Syn::node("command", children));
        }
        loop {
            self.skip_blank();
            if self.at_herestring() {
                children.push(self.herestring()?.with_field("redirect"));
                continue;
            }
            if self.at_command_end() {
                break;
            }
            if assigns && self.at_compound_assignment() {
                children.push(self.assignment(false)?.with_field("argument"));
                continue;
            }
            match self.literal_opt(super::word::Ctx::default())? {
                Some(value) => children.push(value.with_field("argument")),
                None => break,
            }
        }
        Ok(Syn::node("command", children))
    }

    /// Assignments and redirects with no command. Redirects after the
    /// assignments are left to the statement around them, which wraps
    /// everything before a redirect, as the grammar binds it.
    fn statement_without_name(&mut self, mut prefix: Vec<Syn>, marks: &[Mark]) -> R<Syn> {
        let assignments = prefix
            .iter()
            .filter(|node| node.is("variable_assignment"))
            .count();
        if assignments == prefix.len() {
            return Ok(if assignments == 1 {
                prefix.into_iter().next().expect("one assignment")
            } else {
                Syn::node("variable_assignments", prefix)
            });
        }
        let leading = prefix
            .iter()
            .take_while(|node| node.is("variable_assignment"))
            .count();
        if assignments > 0 && leading == assignments {
            self.reset(marks[leading]);
            prefix.truncate(leading);
            return Ok(if leading == 1 {
                prefix.pop().expect("one assignment")
            } else {
                Syn::node("variable_assignments", prefix)
            });
        }
        if assignments == 0 {
            let mut children = prefix;
            loop {
                self.skip_blank();
                if self.at_redirect() && !self.starts(b"<<") {
                    children.push(self.redirect(true)?.with_field("redirect"));
                } else if self.at_herestring() {
                    children.push(self.herestring()?.with_field("redirect"));
                } else {
                    break;
                }
            }
            return Ok(Syn::node("redirected_statement", children));
        }
        Ok(Syn::node("command", prefix))
    }

    /// Whether the next token ends a simple command.
    pub(super) fn at_command_end(&self) -> bool {
        let byte = self.peek();
        self.eof()
            || byte == b'\n'
            || (is_operator(byte) && !self.at_process_substitution())
            || (byte == b'`' && self.in_backtick)
            || (byte.is_ascii_digit() && self.at_redirect())
    }

    fn at_process_substitution(&self) -> bool {
        (self.peek() == b'<' || self.peek() == b'>') && self.at(1) == b'('
    }

    /// Whether a name and `=`, `+=` or `[` start an assignment here.
    pub(super) fn at_assignment(&self) -> bool {
        is_name_start(self.peek()) && self.assignment_after_name()
    }

    /// `at_assignment` where a name may start with a digit, as the grammar
    /// reads a declaration's arguments.
    fn at_declared_assignment(&self) -> bool {
        is_name(self.peek()) && self.assignment_after_name()
    }

    fn assignment_after_name(&self) -> bool {
        let at = self.i;
        let end = name_end(self.s, at);
        match self.s.get(end) {
            Some(b'=') => true,
            Some(b'+') => self.s.get(end + 1) == Some(&b'='),
            Some(b'[') => super::lex::bracket_end(self.s, end).is_some_and(|mut close| {
                while self.s[close..].starts_with(b"\\\n") {
                    close += 2;
                }
                self.s.get(close) == Some(&b'=')
                    || (self.s.get(close) == Some(&b'+') && self.s.get(close + 1) == Some(&b'='))
            }),
            _ => false,
        }
    }

    /// `name[a b]=(`: bash refuses an array value for a subscript with a
    /// blank in a declaration's argument.
    fn subscripted_array(&self) -> bool {
        let end = name_end(self.s, self.i);
        if self.s.get(end) != Some(&b'[') {
            return false;
        }
        let Some(close) = super::lex::bracket_end(self.s, end) else {
            return false;
        };
        self.s[end..close].iter().any(|byte| is_blank(*byte)) && self.s[close..].starts_with(b"=(")
    }

    /// `name=(` or `name+=(`: an array assignment, which bash reads as an
    /// argument of the builtins that take assignments.
    fn at_compound_assignment(&self) -> bool {
        if !self.at_assignment() {
            return false;
        }
        let end = name_end(self.s, self.i);
        let value = match self.s.get(end) {
            Some(b'+') => end + 2,
            Some(b'=') => end + 1,
            _ => return false,
        };
        self.s.get(value) == Some(&b'(')
    }

    /// Whether a compound command starts here.
    pub(super) fn starts_compound(&self) -> bool {
        self.peek() == b'('
            || self.at_word(b"{")
            || [
                &b"if"[..],
                b"while",
                b"until",
                b"for",
                b"select",
                b"case",
                b"[[",
            ]
            .iter()
            .any(|word| self.at_word(word))
    }

    /// `name=value`, `name+=value` or `name[index]=value`; `names` checks
    /// an array value's elements as after a redirect.
    fn assignment(&mut self, names: bool) -> R<Syn> {
        let at = self.i;
        let end = name_end(self.s, at);
        let name = if self.s.get(end) == Some(&b'[') {
            self.i = end;
            self.subscript(at)?
        } else {
            self.i = end;
            Syn::leaf("variable_name", at, end)
        };
        while self.starts(b"\\\n") {
            self.i += 2;
        }
        let op_at = self.i;
        let op = if self.peek() == b'+' { "+=" } else { "=" };
        self.i += op.len();
        let mut children = vec![name.with_field("name"), Syn::token(op, op_at, self.i)];
        let byte = self.peek();
        if byte == b'(' {
            children.push(self.array(names)?.with_field("value"));
        } else if byte == b'#' {
            // The grammar ends a `#` value at an expansion or a quote; bash
            // reads the rest of the word into it.
            let start = self.i;
            self.i = super::lex::word_end(self.s, start + 1);
            let head = Syn::leaf("word", start, self.i);
            children.push(
                self.word_from(head, super::word::Ctx::default())?
                    .with_field("value"),
            );
        } else if !(self.eof() || is_space(byte) || byte == b';' || byte == b'&') {
            if let Some(value) = self.literal_opt(super::word::Ctx::default())? {
                children.push(value.with_field("value"));
            }
        }
        Ok(Syn::node("variable_assignment", children))
    }

    /// `(...)`; with `names` an element's `name[` opens a subscript, as
    /// bash reads a first assignment's elements after a redirect.
    pub(super) fn array(&mut self, names: bool) -> R<Syn> {
        let open = self.i;
        let mut children = vec![self.expect("(")?];
        self.frames.push(super::parser::Frame::Array);
        let elements = self.elements(open, names, &mut children);
        self.frames.pop();
        elements?;
        children.push(self.expect(")")?);
        Ok(Syn::node("array", children))
    }

    /// An array's elements up to its `)`, which opens at `open`. bash
    /// reads an element's subscript to its `]` first.
    fn elements(&mut self, open: usize, names: bool, children: &mut Vec<Syn>) -> R<()> {
        loop {
            self.array_space()?;
            if self.peek() == b')' {
                return Ok(());
            }
            if self.eof() {
                return Err(self.matching(open, ')'));
            }
            // A redirect is no element: `{fd}>` and digits before `<` or
            // `>` are bash's tokens for one.
            let digits = digits_end(self.s, self.i);
            if self.redirvar_end(self.i).is_some()
                || digits > self.i
                    && matches!(self.s.get(digits), Some(b'<' | b'>'))
                    && self.s.get(digits + 1) != Some(&b'(')
            {
                return self.fail(self.i);
            }
            let mut at = self.i;
            if names && is_name_start(self.s[at]) {
                at = name_end(self.s, at);
            }
            if self.s.get(at) == Some(&b'[') {
                self.scan_bracket(at + 1, at)?;
            }
            match self.literal_opt(super::word::Ctx::default())? {
                Some(value) => children.push(value),
                None => return self.fail(self.i),
            }
        }
    }

    pub(super) fn subscript(&mut self, name_at: usize) -> R<Syn> {
        let name = Syn::leaf("variable_name", name_at, self.i).with_field("name");
        let open_at = self.i;
        let mut children = vec![name, self.expect("[")?];
        let mark = self.mark();
        self.skip_blank();
        let index = self.subscript_index();
        self.skip_blank();
        match index {
            Ok(index) if self.peek() == b']' => children.push(index.with_field("index")),
            _ => {
                // bash reads an index when it evaluates it: one the
                // grammar cannot read is one raw word.
                let Some(end) = self.subscript_end(open_at) else {
                    return self.fail(self.i);
                };
                self.forget(mark);
                self.check_raw(open_at + 1, end - 1, false)?;
                if end - 1 > open_at + 1 {
                    children.push(Syn::leaf("word", open_at + 1, end - 1).with_field("index"));
                }
                self.i = end - 1;
            }
        }
        children.push(self.expect("]")?);
        Ok(Syn::node("subscript", children))
    }

    /// Where a subscript opened at `open` ends, past its `]`.
    fn subscript_end(&self, open: usize) -> Option<usize> {
        let mut depth = 0usize;
        let mut at = open;
        while at < self.s.len() {
            match self.s[at] {
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(at + 1);
                    }
                }
                b'\\' => at += 1,
                b'\n' => return None,
                _ => {}
            }
            at += 1;
        }
        None
    }

    /// Whether a file or heredoc redirect starts here.
    pub(super) fn at_redirect(&self) -> bool {
        let mut at = self.i;
        at = digits_end(self.s, at);
        let rest = &self.s[at.min(self.s.len())..];
        if rest.starts_with(b"<<<") {
            return false;
        }
        if at > self.i && !(rest.starts_with(b">") || rest.starts_with(b"<")) {
            return false;
        }
        if rest.starts_with(b"<(") || rest.starts_with(b">(") {
            return false;
        }
        rest.starts_with(b">") || rest.starts_with(b"<") || rest.starts_with(b"&>")
    }

    /// A file or heredoc redirect; a file redirect takes every word after
    /// its operator when `greedy`, one otherwise.
    pub(super) fn redirect(&mut self, greedy: bool) -> R<Syn> {
        let mut children = Vec::new();
        let digits = self.i;
        self.i = digits_end(self.s, self.i);
        if self.i > digits {
            children.push(Syn::leaf("file_descriptor", digits, self.i).with_field("descriptor"));
        }
        if self.starts(b"<<") && !self.starts(b"<<<") {
            return self.heredoc(children, greedy);
        }
        let at = self.i;
        let ops: &[&'static str] = &[
            "&>>", "&>", ">>", ">&-", "<&-", ">&", "<&", ">|", "<>", ">", "<",
        ];
        let Some(op) = ops.iter().find(|op| self.starts(op.as_bytes())) else {
            return self.fail(at);
        };
        self.i += op.len();
        children.push(Syn::token(op, at, self.i));
        let closes = *op == ">&-" || *op == "<&-";
        loop {
            self.skip_blank();
            if self.at_command_end() || self.at_redirect() || self.starts(b"<<<") {
                break;
            }
            let word_at = self.i;
            match self.literal_opt(super::word::Ctx::default())? {
                Some(value) => children.push(value.with_field("destination")),
                None => break,
            }
            // `{name}>` is a redirect of its own, refused as a word.
            let word = &self.s[word_at..self.i];
            if word.len() > 2
                && word[0] == b'{'
                && word[word.len() - 1] == b'}'
                && matches!(self.peek(), b'<' | b'>')
            {
                return self.fail(word_at);
            }
            if !greedy || closes {
                break;
            }
        }
        if children
            .last()
            .is_none_or(|child| child.field != Some("destination"))
            && !closes
        {
            return self.fail(self.i);
        }
        Ok(Syn::node("file_redirect", children))
    }

    pub(super) fn at_herestring(&self) -> bool {
        let mut at = self.i;
        at = digits_end(self.s, at);
        self.s[at.min(self.s.len())..].starts_with(b"<<<")
    }

    /// `<<< word`.
    pub(super) fn herestring(&mut self) -> R<Syn> {
        let mut children = Vec::new();
        let digits = self.i;
        self.i = digits_end(self.s, self.i);
        if self.i > digits {
            children.push(Syn::leaf("file_descriptor", digits, self.i).with_field("descriptor"));
        }
        children.push(self.expect("<<<")?);
        self.skip_blank();
        match self.literal_opt(super::word::Ctx::default())? {
            Some(value) => children.push(value),
            None => return self.fail(self.i),
        }
        Ok(Syn::node("herestring_redirect", children))
    }

    /// `declare`, `local` and their kin, or `unset`: names, words, and for
    /// a declaration assignments.
    pub(super) fn declaration(&mut self, word: &'static str, kind: &'static str) -> R<Syn> {
        let mut children = vec![self.keyword(word)?];
        loop {
            self.skip_blank();
            if self.at_command_end() {
                break;
            }
            if kind == "declaration_command" && self.at_declared_assignment() {
                if self.subscripted_array() {
                    return self.fail(self.i);
                }
                children.push(self.assignment(false)?);
                continue;
            }
            if let Some(name) = self.bare_name() {
                children.push(name);
                continue;
            }
            match self.literal_opt(super::word::Ctx::default())? {
                Some(value) => children.push(value),
                None => break,
            }
        }
        Ok(Syn::node(kind, children))
    }

    /// A word that is only a name, which the grammar reads as one.
    fn bare_name(&mut self) -> Option<Syn> {
        let at = self.i;
        let end = name_end(self.s, at);
        if end == at || super::lex::word_end(self.s, at) != end {
            return None;
        }
        if self.s[at..end].iter().all(u8::is_ascii_digit) {
            return None;
        }
        if !matches!(
            self.s.get(end),
            None | Some(b' ' | b'\t' | b'\r' | b'\n' | b';' | b'&' | b'|' | b')' | b'<' | b'>')
        ) {
            return None;
        }
        self.i = end;
        Some(Syn::leaf("variable_name", at, end))
    }
}
