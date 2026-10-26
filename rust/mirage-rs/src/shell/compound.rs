use super::lex::{blank_end, is_operator, is_space, name_end};
use super::parser::{Close, Parser, R};
use super::tree::Syn;

impl Parser<'_> {
    pub(super) fn subshell(&mut self) -> R<Syn> {
        self.enter()?;
        let open = self.expect("(")?;
        let mut children = vec![open];
        children.extend(self.statements(Close::Paren, None, true)?);
        children.push(self.expect(")")?);
        self.leave();
        Ok(Syn::node("subshell", children))
    }

    pub(super) fn compound(&mut self) -> R<Syn> {
        self.enter()?;
        let open = self.expect("{")?;
        let mut children = vec![open];
        self.braces += 1;
        let body = self.statements(Close::Brace, None, true);
        self.braces -= 1;
        children.extend(body?);
        children.push(self.expect("}")?);
        self.leave();
        Ok(Syn::node("compound_statement", children))
    }

    /// `((`: an arithmetic command, or, when what follows does not read as
    /// one, a subshell whose first command is a subshell, as bash rereads
    /// it. One whose matched text ends its line bash rereads that way up
    /// to there and refuses, unless something inside fails first.
    pub(super) fn double_paren(&mut self) -> R<Syn> {
        let at = self.i;
        let end = self.scan_matched(at + 2, at, b'(', b')')?;
        if self.s.get(end + 1) == Some(&b')') && self.double_paren_end(at).is_some() {
            return self.arithmetic_command();
        }
        if matches!(self.s.get(end + 1), None | Some(b'\n')) {
            let mut reread = Parser {
                i: at + 1,
                ended: true,
                frames: self.frames.clone(),
                comsub: self.comsub,
                nesting: self.nesting,
                ..Parser::new(&self.s[..=end], self.budget, self.options)
            };
            return Err(match reread.statements(Close::Paren, None, true) {
                Err(fail) if !fail.eof || fail.matching => fail,
                _ => self.near(end + 1, true),
            });
        }
        self.subshell()
    }

    pub(super) fn if_statement(&mut self) -> R<Syn> {
        self.enter()?;
        let mut children = vec![self.keyword("if")?];
        children.extend(self.statements(Close::Words(&[b"then"]), Some("condition"), true)?);
        children.push(self.keyword("then")?);
        children.extend(self.statements(Close::Words(&[b"elif", b"else", b"fi"]), None, true)?);
        loop {
            self.skip_space();
            if self.at_word(b"elif") {
                let mut clause = vec![self.keyword("elif")?];
                clause.extend(self.statements(Close::Words(&[b"then"]), None, true)?);
                clause.push(self.keyword("then")?);
                clause.extend(self.statements(
                    Close::Words(&[b"elif", b"else", b"fi"]),
                    None,
                    true,
                )?);
                children.push(Syn::node("elif_clause", clause));
            } else if self.at_word(b"else") {
                let mut clause = vec![self.keyword("else")?];
                clause.extend(self.statements(Close::Words(&[b"fi"]), None, true)?);
                children.push(Syn::node("else_clause", clause));
            } else {
                break;
            }
        }
        self.skip_space();
        children.push(self.keyword("fi")?);
        self.leave();
        Ok(Syn::node("if_statement", children))
    }

    pub(super) fn while_statement(&mut self) -> R<Syn> {
        self.enter()?;
        let word = if self.at_word(b"while") {
            "while"
        } else {
            "until"
        };
        let mut children = vec![self.keyword(word)?];
        children.extend(self.statements(Close::Words(&[b"do"]), Some("condition"), true)?);
        children.push(self.do_group()?.with_field("body"));
        self.leave();
        Ok(Syn::node("while_statement", children))
    }

    pub(super) fn do_group(&mut self) -> R<Syn> {
        self.skip_space();
        let mut children = vec![self.keyword("do")?];
        children.extend(self.statements(Close::Words(&[b"done"]), None, true)?);
        children.push(self.keyword("done")?);
        Ok(Syn::node("do_group", children))
    }

    pub(super) fn for_statement(&mut self) -> R<Syn> {
        self.enter()?;
        let word = if self.at_word(b"for") {
            "for"
        } else {
            "select"
        };
        let keyword = self.keyword(word)?;
        self.skip_blank();
        if word == "for" && self.starts(b"((") {
            let node = self.c_style_for(keyword)?;
            self.leave();
            return Ok(node);
        }
        let mut children = vec![keyword];
        let at = self.i;
        let end = name_end(self.s, at);
        let ends_word = self
            .s
            .get(end)
            .is_none_or(|byte| is_space(*byte) || is_operator(*byte));
        if end > at && ends_word {
            self.i = end;
            children.push(Syn::leaf("variable_name", at, end).with_field("variable"));
        } else {
            // bash checks the name when the loop runs.
            match self.literal_opt(super::word::Ctx::default())? {
                Some(word) => children.push(word.with_field("variable")),
                None => return self.fail(at),
            }
        }
        self.skip_space_before_in();
        if self.at_spelled(b"in") {
            children.push(self.keyword("in")?);
            loop {
                self.skip_blank();
                if self.peek() == b';' || self.peek() == b'\n' || self.peek() == b'&' || self.eof()
                {
                    break;
                }
                match self.literal_opt(super::word::Ctx::default())? {
                    Some(value) => children.push(value.with_field("value")),
                    None => return self.fail(self.i),
                }
            }
        }
        self.skip_blank();
        let at = self.i;
        let separated = matches!(self.peek(), b';' | b'\n');
        match self.peek() {
            b';' => {
                self.i += 1;
                children.push(Syn::token(";", at, at + 1));
            }
            b'\n' => {
                self.i += 1;
                children.push(Syn::hidden(at, at + 1));
            }
            _ => {}
        }
        self.skip_space();
        let body = if self.at_word(b"{") && separated {
            self.compound()?
        } else {
            self.do_group()?
        };
        children.push(body.with_field("body"));
        self.leave();
        Ok(Syn::node("for_statement", children))
    }

    /// Skip newlines when `in` follows them, as bash allows before a for
    /// loop's `in`.
    fn skip_space_before_in(&mut self) {
        let mark = self.mark();
        self.skip_space();
        if !self.at_spelled(b"in") {
            self.reset(mark);
            self.skip_blank();
        }
    }

    pub(super) fn case_statement(&mut self) -> R<Syn> {
        self.enter()?;
        let mut children = vec![self.keyword("case")?];
        self.skip_blank();
        match self.literal_opt(super::word::Ctx::default())? {
            Some(value) => children.push(value.with_field("value")),
            None => return self.fail(self.i),
        }
        self.skip_space();
        children.push(self.keyword("in")?);
        let mut items: Vec<Syn> = Vec::new();
        loop {
            let line = self.i;
            self.skip_space();
            if self.at_word(b"esac") {
                break;
            }
            if self.eof() {
                return self.fail(self.i);
            }
            let same_line = items.is_empty() && !self.s[line..self.i].contains(&b'\n');
            items.push(self.case_item(same_line)?);
        }
        if let Some(last) = items.last_mut() {
            for child in &mut last.children {
                if child.field == Some("termination") {
                    child.field = None;
                }
            }
        }
        children.extend(items);
        children.push(self.keyword("esac")?);
        self.leave();
        Ok(Syn::node("case_statement", children))
    }

    fn case_item(&mut self, first_on_in_line: bool) -> R<Syn> {
        let mut children = Vec::new();
        let first_on_in_line = first_on_in_line && self.peek() != b'(';
        if self.peek() == b'(' {
            children.push(self.expect("(")?);
            self.skip_blank();
        }
        loop {
            self.skip_blank();
            // In a brace group a `}` closes it, except as the first
            // pattern on the line of `in`.
            if self.braces > 0 && self.at_word(b"}") && !(first_on_in_line && children.is_empty()) {
                return self.fail(self.i);
            }
            let pattern = self.case_pattern()?;
            children.extend(pattern.into_iter().map(|node| node.with_field("value")));
            self.skip_blank();
            if self.peek() == b'|' {
                children.push(self.expect("|")?);
                continue;
            }
            break;
        }
        children.push(self.expect(")")?);
        while let Some(items) = self.next_statement(Close::CaseItem, None)? {
            children.extend(items);
        }
        self.skip_blank();
        let at = self.i;
        for (text, field) in [
            (";;&", "fallthrough"),
            (";;", "termination"),
            (";&", "fallthrough"),
        ] {
            if self.starts(text.as_bytes()) {
                self.i += text.len();
                children.push(Syn::token(text, at, self.i).with_field(field));
                break;
            }
        }
        Ok(Syn::node("case_item", children))
    }

    /// One case pattern: a word, or an extglob pattern with the quoted
    /// or expanded part that interrupts it.
    /// One pattern of a case item: as bash reads it when it holds an extglob
    /// group or the grammar's scanner stops short of it, as the scanner
    /// reads it otherwise.
    fn case_pattern(&mut self) -> R<Vec<Syn>> {
        let mark = self.mark();
        if let Some((word, group)) = self.pattern_word()? {
            if group || !word.is("extglob_pattern") {
                return Ok(vec![word]);
            }
        }
        self.reset(mark);
        let nodes = self.grammar_case_pattern()?;
        if self.eof() || is_space(self.peek()) || matches!(self.peek(), b'|' | b')') {
            return Ok(nodes);
        }
        self.reset(mark);
        match self.pattern_word()? {
            Some((word, _)) => Ok(vec![word]),
            None => self.fail(self.i),
        }
    }

    fn grammar_case_pattern(&mut self) -> R<Vec<Syn>> {
        if let Some(end) = self.extglob_end() {
            let at = self.i;
            self.i = end;
            let mut nodes = vec![Syn::leaf("extglob_pattern", at, end)];
            if self.peek() == b'"' || self.peek() == b'$' {
                let middle = if self.peek() == b'"' {
                    self.string()?
                } else if self.starts(b"${") {
                    self.expansion()?
                } else {
                    self.command_substitution()?
                };
                nodes.push(middle);
                if let Some(end) = self.extglob_end() {
                    let at = self.i;
                    self.i = end;
                    nodes.push(Syn::leaf("extglob_pattern", at, end));
                }
            }
            return Ok(nodes);
        }
        match self.literal_opt(super::word::Ctx::default())? {
            Some(word) => Ok(vec![word]),
            None => self.fail(self.i),
        }
    }

    /// `function name [()] body` or `name () body`.
    pub(super) fn function_definition(&mut self) -> R<Syn> {
        let mut children = vec![self.keyword("function")?];
        self.skip_blank();
        let at = self.i;
        let end = super::lex::word_end(self.s, at);
        if end == at {
            return self.fail(at);
        }
        self.i = end;
        children.push(Syn::leaf("word", at, end).with_field("name"));
        if let Some((open, close)) = self.empty_parens(self.i) {
            children.extend([
                Syn::token("(", open, open + 1),
                Syn::token(")", close, close + 1),
            ]);
            self.i = close + 1;
        }
        self.function_rest(children)
    }

    /// `name ()` starts a function definition.
    pub(super) fn try_function(&mut self) -> R<Option<Syn>> {
        let at = self.i;
        let end = super::lex::word_end(self.s, at);
        if end == at || matches!(self.s.get(end), Some(b'\'' | b'"' | b'$' | b'`')) {
            return self.try_quoted_function();
        }
        let Some(parens) = self.empty_parens(end) else {
            return Ok(None);
        };
        self.named_function(Syn::leaf("word", at, end), parens)
            .map(Some)
    }

    /// `'f'() body` or `f$x() body`: bash takes any word as the name and
    /// checks it when it defines the function.
    fn try_quoted_function(&mut self) -> R<Option<Syn>> {
        // Find the word and its `()` before parsing the word, so a word
        // that turns out not to be a name is read only once.
        let Ok(end) = self.word_extent(self.i) else {
            return Ok(None);
        };
        if end == self.i || self.empty_parens(end).is_none() {
            return Ok(None);
        }
        let mark = self.mark();
        let Ok(Some(name)) = self.literal_opt(super::word::Ctx::default()) else {
            self.reset(mark);
            return Ok(None);
        };
        let Some(parens) = self.empty_parens(self.i) else {
            self.reset(mark);
            return Ok(None);
        };
        self.named_function(name, parens).map(Some)
    }

    /// The `(` and `)` of an empty pair after the blanks from `at`.
    fn empty_parens(&self, at: usize) -> Option<(usize, usize)> {
        let open = blank_end(self.s, at);
        let close = blank_end(self.s, open + 1);
        (self.s.get(open) == Some(&b'(') && self.s.get(close) == Some(&b')'))
            .then_some((open, close))
    }

    /// `name (open)(close) body`.
    fn named_function(&mut self, name: Syn, (open, close): (usize, usize)) -> R<Syn> {
        self.i = close + 1;
        self.function_rest(vec![
            name.with_field("name"),
            Syn::token("(", open, open + 1),
            Syn::token(")", close, close + 1),
        ])
    }

    fn function_rest(&mut self, mut children: Vec<Syn>) -> R<Syn> {
        self.enter()?;
        self.skip_space();
        if !(self.starts_compound() || self.starts(b"((")) {
            return self.fail(self.i);
        }
        let body = self.primary()?;
        children.push(body.with_field("body"));
        self.skip_blank();
        if self.at_redirect() && !self.starts(b"<<") {
            children.push(self.redirect(false)?.with_field("redirect"));
        } else if self.starts(b"<<<") {
            children.push(self.herestring()?.with_field("redirect"));
        }
        self.leave();
        Ok(Syn::node("function_definition", children))
    }
}
