// Heredoc token rules adapted from tree-sitter-bash 0.25.1, src/scanner.c.
// https://github.com/tree-sitter/tree-sitter-bash
// Licensed under MIT. See licenses/third_party/tree-sitter-bash-parser.txt.
use super::lex::{ansi_c_end, blank_end, is_space, pair_end, quote_end};
use super::parser::{Parser, R};
use super::tree::Syn;

/// A heredoc whose operator line has been read and whose body has not.
#[derive(Debug, Clone)]
pub(super) struct Pending {
    /// Where its `<<` stands.
    pub operator: usize,
    /// Where its delimiter word starts and ends.
    pub word_start: usize,
    pub word_end: usize,
    pub delimiter: Vec<u8>,
    /// How many substitutions enclose its operator: bash reads the bodies
    /// of the innermost first.
    pub depth: usize,
    /// A quoted delimiter: the body is not expanded, and a backslash
    /// ending one of its lines continues nothing.
    pub raw: bool,
    /// `<<-`: leading tabs are stripped.
    pub dash: bool,
}

/// A body as bash reads it: its lines, continued ones joined unless the
/// delimiter was quoted and leading tabs stripped for `<<-`, each ended
/// by a newline.
#[derive(Debug, Clone)]
pub(super) struct Body {
    pub heredoc: Pending,
    /// Where its first line starts.
    pub start: usize,
    /// Past its delimiter line, or the end of the input.
    pub end: usize,
    pub text: Vec<u8>,
    /// Where each byte of `text` sits in the source; a newline joined in
    /// sits at the newline it stands for.
    pub offsets: Vec<usize>,
    /// Whether the delimiter line ended it, not the end of the input.
    pub terminated: bool,
    /// The line bash's reader stands on when the input ends inside it.
    pub eof_line: usize,
}

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
        let (start, end, delimiter, raw) = self.heredoc_word()?;
        children.push(Syn::leaf("heredoc_start", start, end));
        self.pending.push(Pending {
            operator: at,
            word_start: start,
            word_end: end,
            delimiter,
            depth: self.comsub,
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
                b'\'' | b'"' | b'`' => {
                    quote_end(s, end, byte).ok_or_else(|| self.matching(end, char::from(byte)))?
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

    /// Take the pending heredocs a newline here reads, the deepest first:
    /// inside a substitution, only those opened in it.
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
        readable.sort_by_key(|heredoc| std::cmp::Reverse(heredoc.depth));
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
                    Some(body) if body.terminated => {
                        memchr::memrchr(b'\n', &self.s[start..body.end.saturating_sub(1).max(start)])
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

/// What `read_lines` read.
struct Lines {
    text: Vec<u8>,
    offsets: Vec<usize>,
    end: usize,
    terminated: bool,
    eof_line: usize,
    /// Inside a substitution, where a line holding the delimiter and then
    /// the substitution's close goes on after the delimiter.
    resume: Option<usize>,
}

/// Read a body's lines from `start` up to its delimiter line, or to the
/// end of `s`.
fn read_lines(s: &[u8], start: usize, heredoc: &Pending, nested: bool) -> Lines {
    let mut text = Vec::new();
    let mut offsets = Vec::new();
    let mut at = start;
    let mut eof_line = memchr::memchr_iter(b'\n', s).count() + usize::from(!s.ends_with(b"\n"));
    while at < s.len() {
        let mut line = Vec::new();
        let mut places = Vec::new();
        let mut continued = false;
        while at < s.len() {
            let newline = memchr::memchr(b'\n', &s[at..]).map(|offset| at + offset);
            let end = newline.unwrap_or(s.len());
            line.extend_from_slice(&s[at..end]);
            places.extend(at..end);
            at = newline.map_or(s.len(), |newline| newline + 1);
            continued = !heredoc.raw && ends_escaped(&line) && newline.is_some();
            if !continued {
                break;
            }
            line.pop();
            places.pop();
        }
        if continued && line.is_empty() {
            break;
        }
        let tabs = if heredoc.dash {
            line.iter().take_while(|byte| **byte == b'\t').count()
        } else {
            0
        };
        let kept = &line[tabs..];
        if kept == heredoc.delimiter.as_slice() {
            return Lines {
                text,
                offsets,
                end: at,
                terminated: true,
                eof_line,
                resume: None,
            };
        }
        if nested
            && kept.starts_with(&heredoc.delimiter)
            && closes_substitution(&kept[heredoc.delimiter.len()..])
        {
            let resume = places
                .get(tabs + heredoc.delimiter.len())
                .copied()
                .unwrap_or(at);
            return Lines {
                text,
                offsets,
                end: resume,
                terminated: true,
                eof_line,
                resume: Some(resume),
            };
        }
        if continued {
            eof_line += 1;
        }
        text.extend_from_slice(kept);
        offsets.extend_from_slice(&places[tabs..]);
        text.push(b'\n');
        offsets.push(at.saturating_sub(1).min(s.len()));
    }
    Lines {
        text,
        offsets,
        end: at,
        terminated: false,
        eof_line,
        resume: None,
    }
}

/// Whether an odd run of backslashes ends `line`, so its last one escapes
/// what follows it.
pub(super) fn ends_escaped(line: &[u8]) -> bool {
    line.iter().rev().take_while(|byte| **byte == b'\\').count() % 2 == 1
}

/// Whether a heredoc line's text after its delimiter holds an unquoted
/// `)`: inside a substitution, such a line ends the body there.
fn closes_substitution(rest: &[u8]) -> bool {
    let mut quote = 0u8;
    let mut at = 0;
    while at < rest.len() {
        let byte = rest[at];
        if quote != 0 {
            if byte == b'\\' && quote == b'"' {
                at += 1;
            } else if byte == quote {
                quote = 0;
            }
        } else if matches!(byte, b'\'' | b'"') {
            quote = byte;
        } else if byte == b'\\' {
            at += 1;
        } else if byte == b')' {
            return true;
        }
        at += 1;
    }
    false
}

/// A word with its line continuations dropped, as bash's reader drops
/// them before it reads the word: not inside single quotes or `$'...'`.
fn joined(word: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    if memchr::memmem::find(word, b"\\\n").is_none() {
        return std::borrow::Cow::Borrowed(word);
    }
    let mut out = Vec::with_capacity(word.len());
    let mut double = false;
    let mut at = 0;
    while at < word.len() {
        let end = match word[at] {
            b'\\' if word.get(at + 1) == Some(&b'\n') => {
                at += 2;
                continue;
            }
            b'\\' => at + 2,
            b'"' => {
                double = !double;
                at + 1
            }
            b'\'' if !double => quote_end(word, at, b'\'').unwrap_or(word.len()),
            b'$' if !double && word.get(at + 1) == Some(&b'\'') => {
                ansi_c_end(word, at).unwrap_or(word.len())
            }
            _ => at + 1,
        };
        let end = end.min(word.len());
        out.extend_from_slice(&word[at..end]);
        at = end;
    }
    std::borrow::Cow::Owned(out)
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
                let end = quote_end(word, at, b'\'').unwrap_or(word.len());
                text.extend_from_slice(&word[at + 1..end.saturating_sub(1).max(at + 1)]);
                at = end;
            }
            b'"' => {
                quoted = true;
                let end = quote_end(word, at, b'"').unwrap_or(word.len());
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
                let end = ansi_c_end(word, at).unwrap_or(word.len());
                ansi_c(&word[at + 2..end.saturating_sub(1).max(at + 2)], &mut text);
                at = end;
            }
            // A substitution's text stays as typed, its quotes too, and
            // quotes nothing.
            b'$' if matches!(word.get(at + 1), Some(b'(' | b'{')) => {
                let close = if word[at + 1] == b'(' { b')' } else { b'}' };
                let end = pair_end(word, at + 1, word[at + 1], close).unwrap_or(word.len());
                text.extend_from_slice(&word[at..end]);
                at = end;
            }
            b'`' => {
                let end = quote_end(word, at, b'`').unwrap_or(word.len());
                text.extend_from_slice(&word[at..end]);
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

/// `$'...'` text with its escapes applied, as bash decodes it under a
/// UTF-8 locale: a NUL ends the text, and an escape it does not know
/// keeps its backslash. In a delimiter bash keeps the `\x01` it marks a
/// `\x01` or `\x7f` byte with, so those come out doubled.
fn ansi_c(text: &[u8], out: &mut Vec<u8>) {
    let mut at = 0;
    while at < text.len() {
        if text[at] != b'\\' || at + 1 == text.len() {
            push_marked(text[at], out);
            at += 1;
            continue;
        }
        let marker = text[at + 1];
        at += 2;
        let value = match marker {
            b'a' => 7,
            b'b' => 8,
            b'e' | b'E' => 0x1b,
            b'f' => 0x0c,
            b'n' => 10,
            b'r' => 13,
            b't' => 9,
            b'v' => 0x0b,
            b'\\' | b'\'' | b'"' | b'?' => u32::from(marker),
            b'0'..=b'7' => {
                let (value, end) = digits(text, at - 1, 3, 8);
                at = end;
                value & 0xff
            }
            b'x' | b'u' | b'U' => {
                let width = match marker {
                    b'x' => 2,
                    b'u' => 4,
                    _ => 8,
                };
                let (value, end) = digits(text, at, width, 16);
                if end == at {
                    out.extend_from_slice(&[b'\\', marker]);
                    continue;
                }
                at = end;
                if marker != b'x' && value > 0x7f {
                    utf8_shaped(value, out);
                    continue;
                }
                value
            }
            b'c' if at < text.len() => {
                let operand = text[at];
                at += 1;
                if operand == b'\\' && text.get(at) == Some(&b'\\') {
                    at += 1;
                }
                if operand == b'?' {
                    0x7f
                } else {
                    u32::from(operand.to_ascii_uppercase() & 0x1f)
                }
            }
            _ => {
                out.extend_from_slice(&[b'\\', marker]);
                continue;
            }
        };
        if value == 0 {
            return;
        }
        push_marked(value as u8, out);
    }
}

fn push_marked(byte: u8, out: &mut Vec<u8>) {
    if matches!(byte, 0x01 | 0x7f) {
        out.push(0x01);
    }
    out.push(byte);
}

/// Up to `width` digits in `radix` from `at`: their value and where they
/// end.
fn digits(text: &[u8], at: usize, width: usize, radix: u32) -> (u32, usize) {
    let mut value = 0u32;
    let mut end = at;
    while end < text.len() && end - at < width {
        let Some(digit) = char::from(text[end]).to_digit(radix) else {
            break;
        };
        value = value * radix + digit;
        end += 1;
    }
    (value, end)
}

/// A value's UTF-8 form, as bash writes any value under 2^31: surrogates
/// and values past Unicode take the same shape.
fn utf8_shaped(value: u32, out: &mut Vec<u8>) {
    let len = match value {
        0..0x800 => 2,
        0x800..0x1_0000 => 3,
        0x1_0000..0x20_0000 => 4,
        0x20_0000..0x400_0000 => 5,
        0x400_0000..0x8000_0000 => 6,
        _ => return,
    };
    let lead: u8 = [0xc0, 0xe0, 0xf0, 0xf8, 0xfc][len - 2];
    out.push(lead | (value >> (6 * (len - 1))) as u8);
    for shift in (0..len - 1).rev() {
        out.push(0x80 | ((value >> (6 * shift)) & 0x3f) as u8);
    }
}
