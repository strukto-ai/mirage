// Expansion word and regex token rules adapted from tree-sitter-bash 0.25.1,
// src/scanner.c.
// https://github.com/tree-sitter/tree-sitter-bash
// Licensed under MIT. See licenses/third_party/tree-sitter-bash-parser.txt.
use super::lex::{blank_end, digits_end, is_name, is_name_start, is_space, name_end};
use super::parser::{Parser, R};
use super::tree::Syn;
use super::word::{Ctx, SPECIAL, push_run};

impl Parser<'_> {
    /// `${...}`.
    /// bash reads only where the braces close; the body is checked when
    /// it expands, so one the grammar cannot read is one raw word.
    pub(super) fn expansion(&mut self) -> R<Syn> {
        self.enter()?;
        let at = self.i;
        let mark = self.mark();
        self.i += 2;
        let mut children = vec![Syn::token("${", at, at + 2)];
        let parsed = self.expansion_body(&mut children);
        if parsed.is_err() || self.peek() != b'}' {
            let Some(end) = super::lex::pair_end(self.s, at + 1, b'{', b'}') else {
                return match parsed {
                    Err(fail) => Err(fail),
                    Ok(()) => self.fail(self.i),
                };
            };
            self.forget(mark);
            children.truncate(1);
            self.check_raw(at + 2, end - 1, true)?;
            if end - 1 > at + 2 {
                children.push(Syn::leaf("word", at + 2, end - 1));
            }
            self.i = end - 1;
        }
        children.push(Syn::token("}", self.i, self.i + 1));
        self.i += 1;
        self.leave();
        Ok(Syn::node("expansion", children))
    }

    fn op(&mut self, text: &'static str) -> Syn {
        let at = self.i;
        self.i += text.len();
        Syn::token(text, at, self.i).with_field("operator")
    }

    fn expansion_body(&mut self, children: &mut Vec<Syn>) -> R<()> {
        if self.peek() == b'}' {
            return Ok(());
        }
        // `${#}`, `${!#}`, `${#x}`, `${!x}` and their kin.
        let mut prefixed = false;
        if self.peek() == b'#' || self.peek() == b'!' {
            let next = self.at(1);
            let lone = next == b'}';
            if lone {
                let text = if self.peek() == b'#' { "#" } else { "!" };
                children.push(self.op(text));
                return Ok(());
            }
            if self.peek() == b'!' && next == b'#' && self.at(2) == b'}' {
                children.push(self.op("!"));
                children.push(self.op("#"));
                return Ok(());
            }
            if is_name(next) || SPECIAL.contains(&next) {
                let text = if self.peek() == b'#' { "#" } else { "!" };
                children.push(self.op(text));
                prefixed = true;
            }
        }
        // The parameter.
        let at = self.i;
        let byte = self.peek();
        if is_name_start(byte) || byte.is_ascii_digit() {
            let end = if byte.is_ascii_digit() {
                let mut end = at;
                end = digits_end(self.s, end);
                end
            } else {
                name_end(self.s, at)
            };
            self.i = end;
            if self.peek() == b'[' {
                children.push(self.subscript(at)?);
            } else {
                children.push(Syn::leaf("variable_name", at, end));
            }
        } else if SPECIAL.contains(&byte) || byte == b'_' {
            self.i += 1;
            children.push(Syn::leaf("special_variable_name", at, at + 1));
        } else {
            return self.fail(at);
        }
        // `${!prefix@}` and `${!prefix*}`.
        let indirect = prefixed && children.get(1).is_some_and(|op| op.kind == "!");
        if indirect && (self.peek() == b'@' || self.peek() == b'*') && self.at(1) == b'}' {
            let text = if self.peek() == b'@' { "@" } else { "*" };
            children.push(self.op(text));
            return Ok(());
        }
        self.expansion_operator(children)
    }

    fn expansion_operator(&mut self, children: &mut Vec<Syn>) -> R<()> {
        if self.peek() == b'}' {
            return Ok(());
        }
        for text in [":-", ":=", ":+", ":?", "-", "=", "+", "?"] {
            if self.starts(text.as_bytes()) {
                children.push(self.op(text));
                return self.expansion_value(children);
            }
        }
        for text in ["##", "#", "%%", "%"] {
            if self.starts(text.as_bytes()) {
                children.push(self.op(text));
                return self.expansion_pattern(children);
            }
        }
        for text in ["//", "/#", "/%", "/"] {
            if self.starts(text.as_bytes()) {
                children.push(self.op(text));
                return self.expansion_replacement(children);
            }
        }
        for text in [",,", ",", "^^", "^"] {
            if self.starts(text.as_bytes()) {
                children.push(self.op(text));
                if self.peek() != b'}' {
                    let at = self.i;
                    let end = self.regex_end(at);
                    self.i = end;
                    children.push(Syn::leaf("regex", at, end));
                }
                return Ok(());
            }
        }
        if self.peek() == b':' {
            // bash reads a substring's offset and length as arithmetic only
            // when the word runs: they are words here, which the executor
            // splits at their separator and evaluates then.
            children.push(self.op(":"));
            return self.substring_operands(children);
        }
        if self.peek() == b'@' {
            children.push(self.op("@"));
            let byte = self.peek();
            let text = match byte {
                b'U' => "U",
                b'u' => "u",
                b'L' => "L",
                b'Q' => "Q",
                b'E' => "E",
                b'P' => "P",
                b'A' => "A",
                b'K' => "K",
                b'a' => "a",
                b'k' => "k",
                _ => return self.fail(self.i),
            };
            children.push(self.op(text));
            return Ok(());
        }
        self.fail(self.i)
    }

    /// A substring's offset and length up to the `}`: their text as words,
    /// the quotes and expansions in it as their own nodes.
    fn substring_operands(&mut self, children: &mut Vec<Syn>) -> R<()> {
        let mut pieces = Vec::new();
        let mut run = self.i;
        loop {
            if self.eof() {
                return self.fail(self.i);
            }
            let at = self.i;
            let piece = match self.peek() {
                b'}' => break,
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
            push_run(&mut pieces, "word", run, at);
            pieces.push(piece);
            run = self.i;
        }
        push_run(&mut pieces, "word", run, self.i);
        children.extend(Syn::concat(pieces));
        Ok(())
    }

    /// The word after `:-`, `=` and their kin: pieces up to `}`, where a
    /// blank-led run of text is one word with its blanks.
    fn expansion_value(&mut self, children: &mut Vec<Syn>) -> R<()> {
        let mut pieces: Vec<Syn> = Vec::new();
        loop {
            if self.eof() {
                return self.fail(self.i);
            }
            if self.peek() == b'}' {
                break;
            }
            let at = self.i;
            if self.peek() == b'\\' && self.at(1) == b'\n' {
                self.i += 2;
                continue;
            }
            if is_space(self.peek()) {
                if let Some(end) = self.expansion_word_end(at) {
                    self.i = end;
                    pieces.push(Syn::leaf("word", at, end));
                    continue;
                }
                while is_space(self.peek()) {
                    self.i += 1;
                }
                continue;
            }
            let piece = match self.peek() {
                b'(' => self.array()?,
                b'"' => self.string()?,
                b'\'' => self.raw_string()?,
                b'$' => self.dollar()?,
                b'`' => self.backtick()?,
                b'<' | b'>' if self.at(1) == b'(' => self.process_substitution()?,
                _ => {
                    let end = self.value_word_end(at);
                    if end == at {
                        return self.fail(at);
                    }
                    self.i = end;
                    Syn::leaf("word", at, end)
                }
            };
            pieces.push(piece);
        }
        children.extend(Syn::concat(pieces));
        Ok(())
    }

    /// Where a blank-led run of text in an expansion's value ends, or None
    /// when a quote cuts it.
    fn expansion_word_end(&self, at: usize) -> Option<usize> {
        let mut end = at;
        let mut text = false;
        while end < self.s.len() {
            match self.s[end] {
                b'}' => return (end > at).then_some(end),
                b'"' | b'\'' => return None,
                b'$' => {
                    let next = self.s.get(end + 1).copied().unwrap_or(0);
                    if next == b'{' || next == b'(' || next == b'\'' || next.is_ascii_alphanumeric()
                    {
                        return text.then_some(end);
                    }
                    text = true;
                    end += 1;
                }
                byte => {
                    text |= !is_space(byte);
                    end += 1;
                }
            }
        }
        None
    }

    /// A text run of an expansion's value, up to a blank, quote, `$` or
    /// `}`.
    fn value_word_end(&self, at: usize) -> usize {
        let mut end = at;
        while end < self.s.len() {
            match self.s[end] {
                b'}' | b'"' | b'\'' | b'$' | b'`' => break,
                b'\\' if self.s.get(end + 1) == Some(&b'\n') => break,
                b'\\' => end += 2,
                byte if is_space(byte) => break,
                _ => end += 1,
            }
        }
        end.min(self.s.len())
    }

    /// Where a pattern operand ends: before the `}` closing its expansion,
    /// with trailing blanks left out.
    fn regex_end(&self, at: usize) -> usize {
        let mut end = at;
        let mut last = at;
        let mut brace = 0usize;
        let mut quoted = false;
        while end < self.s.len() {
            let byte = self.s[end];
            if quoted {
                if byte == b'\'' {
                    quoted = false;
                }
                end += 1;
                last = end;
                continue;
            }
            match byte {
                b'\\' => {
                    end += 2;
                    last = end.min(self.s.len());
                    continue;
                }
                b'\'' => quoted = true,
                b'{' => brace += 1,
                b'}' if brace == 0 => break,
                b'}' => brace -= 1,
                _ => {}
            }
            end += 1;
            if !is_space(byte) {
                last = end;
            }
        }
        last.min(self.s.len())
    }

    fn expansion_pattern(&mut self, children: &mut Vec<Syn>) -> R<()> {
        loop {
            if self.eof() {
                return self.fail(self.i);
            }
            match self.peek() {
                b'}' => return Ok(()),
                b'"' => children.push(self.string()?),
                b'\'' => children.push(self.raw_string()?),
                byte if is_space(byte) => {
                    let at = self.i;
                    while is_space(self.peek()) {
                        self.i += 1;
                    }
                    if self.peek() == b'}' {
                        children.push(Syn::leaf("regex", at, self.i));
                    }
                }
                _ => {
                    let at = self.i;
                    let end = self.regex_end(at);
                    if end == at {
                        return self.fail(at);
                    }
                    self.i = end;
                    children.push(Syn::leaf("regex", at, end));
                }
            }
        }
    }

    fn expansion_replacement(&mut self, children: &mut Vec<Syn>) -> R<()> {
        // The pattern, up to an unescaped `/`.
        match self.peek() {
            b'}' => return Ok(()),
            b'"' => {
                children.push(self.string()?);
            }
            b'$' if self.at(1) == b'(' => {
                children.push(self.command_substitution()?);
            }
            b'/' => {}
            _ => {
                let at = self.i;
                let mut end = at;
                while end < self.s.len() && !matches!(self.s[end], b'/' | b'}') {
                    if self.s[end] == b'\\' {
                        end += 1;
                    }
                    end += 1;
                }
                end = end.min(self.s.len());
                self.i = end;
                if end > at {
                    children.push(Syn::leaf("regex", at, end));
                }
            }
        }
        if self.peek() != b'/' {
            return Ok(());
        }
        children.push(self.op("/"));
        // The replacement: a word up to `}`.
        let mut pieces: Vec<Syn> = Vec::new();
        loop {
            self.i = blank_end(self.s, self.i);
            if self.eof() {
                return self.fail(self.i);
            }
            if self.peek() == b'}' {
                break;
            }
            let ctx = Ctx {
                brace: true,
                ..Default::default()
            };
            match self.literal_opt(ctx)? {
                Some(piece) => pieces.push(piece),
                None => return self.fail(self.i),
            }
        }
        children.extend(Syn::concat(pieces));
        Ok(())
    }
}
