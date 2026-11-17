// Heredoc token rules adapted from tree-sitter-bash 0.25.1, src/scanner.c.
// https://github.com/tree-sitter/tree-sitter-bash
// Licensed under MIT. See licenses/third_party/tree-sitter-bash-parser.txt.
use super::heredoc_body::{Body, Pending, joined, read_lines, unquote};
use super::lex::{ansi_c_end, blank_end, is_space, pair_end, quote_end};
use super::parser::{Parser, R};
use super::tree::Syn;

impl Parser<'_> {
    /// `<<word`: its body is read after the newline that ends its line.
    /// `children` holds the descriptor, if any; a `greedy` one takes the
    /// words after it, as a file redirect does.
    pub(super) fn heredoc(&mut self, mut children: Vec<Syn>, greedy: bool) -> R<Syn> {
        let at = self.i;
        let dash = self.starts(b"<<-");
        let op = if dash { "<<-" } else { "<<" };
        self.i += op.len();
        children.push(Syn::token(op, at, self.i));
        loop {
            self.i = blank_end(self.s, self.i);
            if !self.starts(b"\\\n") {
                break;
            }
            self.i += 2;
        }
        // A `#` there starts a comment, which leaves the delimiter out.
        if self.peek() == b'#' {
            let line_end =
                memchr::memchr(b'\n', &self.s[self.i..]).map_or(self.s.len(), |n| self.i + n);
            return self.fail(line_end);
        }
        let (start, end, delimiter, raw) = self.heredoc_word()?;
        children.push(Syn::leaf("heredoc_start", start, end));
        self.pending.push(Pending {
            operator: at,
            word_start: start,
            word_end: end,
            delimiter,
            depth: self.comsub,
            carried: false,
            raw,
            dash,
        });
        if greedy {
            loop {
                self.skip_blank();
                if self.at_command_end() || self.at_redirect() || self.starts(b"<<<") {
                    break;
                }
                match self.literal_opt(super::word::Ctx::default())? {
                    Some(word) => children.push(word.with_field("argument")),
                    None => break,
                }
            }
        }
        Ok(Syn::node("heredoc_redirect", children))
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
        let (text, raw) = unquote(&joined(&self.s[start..end]));
        Ok((start, end, text, raw))
    }

    /// Where a shell word starting at `at` ends: at an unquoted blank or
    /// operator, or the backtick closing the body it is in, with quotes
    /// and `$(...)`, `${...}` and backticks inside it taken whole.
    pub(super) fn word_extent(&self, at: usize) -> R<usize> {
        let s = self.s;
        let mut end = at;
        while end < s.len() {
            let byte = s[end];
            // A process substitution is part of the word.
            if matches!(byte, b'<' | b'>') && s.get(end + 1) == Some(&b'(') {
                end = pair_end(s, end + 1, b'(', b')').ok_or_else(|| self.matching(end, ')'))?;
                continue;
            }
            if is_space(byte)
                || matches!(byte, b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')')
                || (byte == b'`' && self.in_backtick)
            {
                break;
            }
            end = match byte {
                b'\\' => end + 2,
                b'\'' | b'"' | b'`' => {
                    quote_end(s, end, byte).ok_or_else(|| self.matching(end, char::from(byte)))?
                }
                // bash parses a substitution in the word as it reads it.
                b'$' if s.get(end + 1) == Some(&b'(') && s.get(end + 2) != Some(&b'(') => {
                    let mut probe = self.probe(end);
                    probe.command_substitution()?;
                    probe.i
                }
                b'$' if matches!(s.get(end + 1), Some(b'(' | b'{')) => {
                    let (open, close) = if s[end + 1] == b'(' {
                        (b'(', b')')
                    } else {
                        (b'{', b'}')
                    };
                    pair_end(s, end + 1, open, close)
                        .ok_or_else(|| self.matching(end, char::from(close)))?
                }
                b'$' if s.get(end + 1) == Some(&b'\'') => {
                    ansi_c_end(s, end).ok_or_else(|| self.matching(end, '\''))?
                }
                _ => end + 1,
            };
        }
        Ok(end.min(s.len()))
    }

    /// Read the bodies of the heredocs a newline at the cursor's left
    /// reads, in bash's order.
    pub(super) fn pending_bodies(&mut self) {
        for heredoc in self.take_readable() {
            if self.read_body(heredoc) {
                break;
            }
        }
    }

    /// Take the pending heredocs a newline here reads, those substitutions
    /// handed out first: inside a substitution, only those opened in it.
    fn take_readable(&mut self) -> Vec<Pending> {
        let comsub = self.comsub;
        if !self.pending.iter().any(|heredoc| heredoc.depth >= comsub) {
            return Vec::new();
        }
        let mut taken = Vec::new();
        let mut kept = Vec::new();
        for (index, heredoc) in std::mem::take(&mut self.pending).into_iter().enumerate() {
            if heredoc.depth >= comsub {
                taken.push((index, heredoc));
            } else {
                kept.push(heredoc);
            }
        }
        self.pending = kept;
        let mut readable: Vec<Pending> = taken.iter().map(|(_, heredoc)| heredoc.clone()).collect();
        self.taken.push(taken);
        readable.sort_by_key(|heredoc| !heredoc.carried);
        readable
    }

    /// Undo `reads`, newest first, as far as the first `keep` heredocs:
    /// each read kept the others in order, so its heredocs go back between
    /// them, and only those among the first `keep` matter.
    pub(super) fn put_back(&mut self, reads: Vec<Vec<(usize, Pending)>>, keep: usize) {
        let mut wanted = Vec::with_capacity(reads.len());
        let mut want = keep;
        for taken in &reads {
            wanted.push(want);
            want -= taken.iter().filter(|(index, _)| *index < want).count();
        }
        for (taken, want) in reads.into_iter().zip(wanted).rev() {
            let mut taken = taken
                .into_iter()
                .filter(|(index, _)| *index < want)
                .peekable();
            if taken.peek().is_none() {
                continue;
            }
            let mut kept = std::mem::take(&mut self.pending).into_iter();
            self.pending = (0..want)
                .filter_map(|at| match taken.next_if(|(index, _)| *index == at) {
                    Some((_, heredoc)) => Some(heredoc),
                    None => kept.next(),
                })
                .collect();
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
                self.read_body(heredoc.clone());
                let end = match self.bodies.last() {
                    Some(body) if body.terminated => memchr::memrchr(
                        b'\n',
                        &self.s[start..body.end.saturating_sub(1).max(start)],
                    )
                    .map_or(start, |offset| start + offset + 1),
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
            }
            self.pending.extend(pending);
        }
    }

    /// Read one body from the cursor, as bash's reader takes it, and note
    /// it. Inside a substitution a line that opens with the delimiter and
    /// closes the substitution after it ends the body there too: the rest
    /// of that line is read on, and the bodies still pending are dropped,
    /// which this answers true for.
    fn read_body(&mut self, heredoc: Pending) -> bool {
        let start = self.i;
        let mut lines = read_lines(self.s, start, &heredoc, self.comsub > 0);
        let cut = lines.resume.is_some();
        if let Some(resume) = lines.resume {
            // The body is the lines before the delimiter's, as if the
            // input ended there.
            let line = memchr::memrchr(b'\n', &self.s[..resume]).map_or(0, |at| at + 1);
            lines = read_lines(&self.s[..line], start, &heredoc, false);
            lines.end = resume;
            lines.terminated = true;
        }
        self.i = lines.end;
        // The rest of a delimiter line inside a substitution is read as the
        // next command.
        self.line_break = cut;
        self.bodies.push(Body {
            heredoc,
            start,
            end: lines.end,
            text: lines.text,
            offsets: lines.offsets,
            terminated: lines.terminated,
            eof_line: lines.eof_line,
        });
        cut
    }
}
