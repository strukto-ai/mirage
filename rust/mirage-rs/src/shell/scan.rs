use super::parser::{Parser, R};

/// How bash's reader skips quotes, expansions and matched pairs before
/// it parses what they hold: where each ends, or its refusal of one the
/// input ends inside.
impl Parser<'_> {
    fn byte_at(&self, at: usize) -> u8 {
        self.s.get(at).copied().unwrap_or(0)
    }

    /// Where the next byte is once line continuations are skipped.
    pub(super) fn joined(&self, mut at: usize) -> usize {
        while self.s[at.min(self.s.len())..].starts_with(b"\\\n") {
            at += 2;
        }
        at
    }

    pub(super) fn char_at(&self, at: usize) -> u8 {
        self.byte_at(self.joined(at))
    }

    /// `scan` one level deeper, refusing a line whose quotes and
    /// expansions nest `MAX_SCAN` deep, as bash refuses one nested past its
    /// reader.
    fn deeper<T>(&self, scan: impl FnOnce() -> R<T>) -> R<T> {
        let scans = &self.budget.scans;
        if scans.get() >= super::parser::MAX_SCAN {
            return Err(self.too_deep());
        }
        scans.set(scans.get() + 1);
        let out = scan();
        scans.set(scans.get() - 1);
        out
    }

    /// bash's refusal of a line nested past its reader.
    pub(super) fn too_deep(&self) -> super::parser::Fail {
        super::parser::Fail {
            status: 2,
            ..self.refusal(
                self.i,
                self.i,
                vec![b"syntax error: nesting too deep".to_vec()],
                false,
            )
        }
    }

    pub(super) fn scan_single_quote(&self, at: usize) -> R<usize> {
        match memchr::memchr(b'\'', &self.s[at + 1..]) {
            Some(offset) => Ok(at + 1 + offset + 1),
            None => Err(self.matching(at, '\'')),
        }
    }

    pub(super) fn scan_double_quote(&self, at: usize) -> R<usize> {
        self.deeper(|| {
            let mut j = at + 1;
            while j < self.s.len() {
                match self.s[j] {
                    b'"' => return Ok(j + 1),
                    b'\\' => j += 2,
                    b'`' => j = self.scan_escaped_quote(j, b'`')?,
                    b'$' => j = self.scan_dollar(j, true)?,
                    _ => j += 1,
                }
            }
            Err(self.matching(at, '"'))
        })
    }

    /// A quote whose backslash escapes the next byte: `$'...'`, or a
    /// backquoted substitution, whose body bash parses when it runs.
    pub(super) fn scan_escaped_quote(&self, at: usize, closer: u8) -> R<usize> {
        let mut j = at + 1;
        while j < self.s.len() {
            match self.s[j] {
                b'\\' => j += 2,
                byte if byte == closer => return Ok(j + 1),
                _ => j += 1,
            }
        }
        Err(self.matching(at, char::from(closer)))
    }

    pub(super) fn scan_dollar(&self, at: usize, quoted: bool) -> R<usize> {
        self.deeper(|| {
            let next = self.joined(at + 1);
            match self.byte_at(next) {
                b'$' => Ok(next + 1),
                b'(' => {
                    let inner = self.joined(next + 1);
                    if self.byte_at(inner) == b'(' {
                        let end = self.scan_matched(inner + 1, at, b'(', b')')?;
                        if self.byte_at(end + 1) == b')' {
                            return Ok(end + 2);
                        }
                        return Ok(self.scan_matched(next + 1, at, b'(', b')')? + 1);
                    }
                    self.scan_substitution(at)
                }
                b'{' => self.scan_brace(next + 1, at),
                b'[' => Ok(self.scan_matched(next + 1, at, b'[', b']')? + 1),
                b'\'' if !quoted => self.scan_escaped_quote(next, b'\''),
                b'"' if !quoted => self.scan_double_quote(next),
                _ => Ok(at + 1),
            }
        })
    }

    /// A substitution opening at `at`, its body parsed.
    pub(super) fn scan_substitution(&self, at: usize) -> R<usize> {
        if let Some((end, _)) = self.budget.ends.borrow().get(&at) {
            return Ok(*end);
        }
        let mut probe = self.probe(at);
        if self.byte_at(at) == b'$' {
            probe.command_substitution()?;
        } else {
            probe.process_substitution()?;
        }
        self.budget
            .ends
            .borrow_mut()
            .insert(at, (probe.i, probe.pending));
        Ok(probe.i)
    }

    pub(super) fn scan_process_substitution(&self, at: usize) -> R<usize> {
        let next = self.joined(at + 1);
        if self.char_at(next + 1) == b'(' {
            return Ok(self.scan_matched(next + 1, at, b'(', b')')? + 1);
        }
        self.scan_substitution(at)
    }

    pub(super) fn scan_brace(&self, mut j: usize, opened: usize) -> R<usize> {
        self.deeper(|| {
            while j < self.s.len() {
                let byte = self.s[j];
                if byte == b'}' {
                    return Ok(j + 1);
                }
                if matches!(byte, b'<' | b'>') && self.char_at(j + 1) == b'(' {
                    j = self.scan_process_substitution(j)?;
                    continue;
                }
                j = self.scan_word_char(j)?;
            }
            Err(self.matching(opened, '}'))
        })
    }

    /// Where the `right` that matches an opener closes, read as text:
    /// quotes, `$'...'` and `$(` skipped, any other expansion text.
    pub(super) fn scan_matched(
        &self,
        mut j: usize,
        opened: usize,
        left: u8,
        right: u8,
    ) -> R<usize> {
        self.deeper(|| {
            let mut depth = 1usize;
            while j < self.s.len() {
                let byte = self.s[j];
                if byte == right {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(j);
                    }
                    j += 1;
                } else if byte == left {
                    depth += 1;
                    j += 1;
                } else {
                    j = match byte {
                        b'\\' => j + 2,
                        b'\'' => self.scan_single_quote(j)?,
                        b'"' => self.scan_double_quote(j)?,
                        b'`' => self.scan_escaped_quote(j, b'`')?,
                        b'$' if self.char_at(j + 1) == b'(' => self.scan_dollar(j, false)?,
                        b'$' if self.char_at(j + 1) == b'\'' => {
                            self.scan_escaped_quote(self.joined(j + 1), b'\'')?
                        }
                        _ => j + 1,
                    };
                }
            }
            Err(self.matching(opened, char::from(right)))
        })
    }

    pub(super) fn scan_extended_pattern(&self, at: usize) -> R<usize> {
        self.deeper(|| {
            let mut j = at + 2;
            let mut depth = 1usize;
            while j < self.s.len() {
                let byte = self.s[j];
                if matches!(byte, b'\'' | b'"' | b'`' | b'$' | b'\\') {
                    j = self.scan_word_char(j)?;
                    continue;
                }
                if matches!(byte, b'<' | b'>') && self.char_at(j + 1) == b'(' {
                    j = self.scan_process_substitution(j)?;
                    continue;
                }
                if byte == b'(' {
                    depth += 1;
                } else if byte == b')' {
                    depth -= 1;
                }
                j += 1;
                if depth == 0 {
                    return Ok(j);
                }
            }
            Err(self.matching(at + 1, ')'))
        })
    }

    pub(super) fn scan_word_char(&self, j: usize) -> R<usize> {
        match self.s[j] {
            b'\\' => Ok(j + 2),
            b'\'' => self.scan_single_quote(j),
            b'"' => self.scan_double_quote(j),
            b'`' => self.scan_escaped_quote(j, b'`'),
            b'$' => self.scan_dollar(j, false),
            _ => Ok(j + 1),
        }
    }

    /// Where the text bash quotes back from where its reader stopped
    /// lies: back over blanks, then to a blank or past one of `;&|`.
    pub(super) fn near_span(&self, at: usize) -> (usize, usize) {
        let s = self.s;
        let mut end = at.min(s.len());
        while end > 0 && matches!(s[end - 1], b' ' | b'\t' | b'\n') {
            end -= 1;
        }
        let mut start = end;
        while start > 0 {
            let byte = s[start - 1];
            if matches!(byte, b' ' | b'\t' | b'\n') {
                break;
            }
            start -= 1;
            if matches!(byte, b';' | b'&' | b'|') {
                break;
            }
        }
        (start, end)
    }

    /// bash's `syntax error near `X'`, the text quoted back from `at`;
    /// its status the end of input's when `eof` says so.
    pub(super) fn near(&self, at: usize, eof: bool) -> super::parser::Fail {
        let (from, to) = self.near_span(at);
        if from == to {
            return self.refusal(
                self.s.len(),
                self.s.len(),
                vec![self.eof_line().into()],
                true,
            );
        }
        let line = super::parser::line(&[b"syntax error near `", &self.s[from..to], b"'"]);
        self.refusal(from, to, vec![line], eof)
    }

    /// Where the word at `at` ends as bash's reader takes it whole: its
    /// quotes, expansions and substitutions in it.
    pub(super) fn scan_word(&self, mut at: usize) -> R<usize> {
        while at < self.s.len() {
            let byte = self.s[at];
            if byte == b'\\' {
                at += 2;
                continue;
            }
            if self.options.extglob
                && matches!(byte, b'@' | b'!' | b'+' | b'*' | b'?')
                && self.byte_at(at + 1) == b'('
            {
                at = self.scan_extended_pattern(at)?;
                continue;
            }
            if matches!(
                byte,
                b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')' | b'<' | b'>'
            ) {
                if matches!(byte, b'<' | b'>') && self.char_at(at + 1) == b'(' {
                    at = self.scan_process_substitution(at)?;
                    continue;
                }
                break;
            }
            at = self.scan_word_char(at)?;
        }
        Ok(at.min(self.s.len()))
    }

    /// Past the `]` closing a subscript's `[`, nested brackets counted and
    /// blanks taken; `j` is just past the `[` at `opened`.
    pub(super) fn scan_bracket(&self, mut j: usize, opened: usize) -> R<usize> {
        let mut depth = 1usize;
        while j < self.s.len() {
            match self.s[j] {
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(j + 1);
                    }
                }
                _ => {}
            }
            j = self.scan_word_char(j)?;
        }
        Err(self.matching(opened, ']'))
    }
}
