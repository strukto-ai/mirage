use super::lex::{is_blank, is_space, is_word};
use super::tree::{Syn, Tree, lay_out, place_comments};

/// How deep constructs may nest before the parser refuses the line, so a
/// hostile line cannot run the host out of stack.
const MAX_DEPTH: usize = 128;

/// How many constructs a parse may enter per byte of input, plus a base:
/// a line takes a few per byte with its look aheads, and one whose look
/// aheads would re-read nested input over and over is refused.
const WORK_PER_BYTE: usize = 64;
const WORK_BASE: usize = 4096;

/// Reserved words that close a construct, which bash refuses where no
/// construct is open.
const CLOSERS: &[&[u8]] = &[
    b"then", b"else", b"elif", b"fi", b"do", b"done", b"esac", b"in", b"}", b"]]",
];

/// Whether a statement ends in a compound command, after which bash reads
/// a reserved word with no separator.
fn ends_compound(statement: &Syn) -> bool {
    let mut node = statement;
    loop {
        match node.kind {
            "list" | "pipeline" | "negated_command" | "timed_statement" => {
                match node.children.last() {
                    Some(last) => node = last,
                    None => return false,
                }
            }
            "subshell"
            | "compound_statement"
            | "if_statement"
            | "while_statement"
            | "for_statement"
            | "c_style_for_statement"
            | "case_statement"
            | "function_definition" => return true,
            "test_command" => return node.children.first().is_some_and(|open| open.kind == "[["),
            _ => return false,
        }
    }
}

/// Why the parser stopped: where, and bash's words for it.
#[derive(Debug, Clone)]
pub(super) struct Fail {
    pub at: usize,
    pub message: String,
}

impl Fail {
    /// bash's refusal of input that ends before the `closer` it waits for.
    pub(super) fn eof(at: usize, closer: char) -> Self {
        Self {
            at,
            message: format!("unexpected EOF while looking for matching `{closer}'"),
        }
    }
}

pub(super) type R<T> = Result<T, Fail>;

/// Where a speculative parse started, to go back to.
#[derive(Clone, Copy)]
pub(super) struct Mark {
    i: usize,
    comments: usize,
    pending: usize,
    taken: usize,
    raw_bodies: usize,
    depth: usize,
}

/// What ends a statement list.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Close {
    /// The end of the input.
    Eof,
    /// `)`: a subshell, command or process substitution.
    Paren,
    /// A closing backtick.
    Backtick,
    /// `}` as a reserved word.
    Brace,
    /// One of these reserved words.
    Words(&'static [&'static [u8]]),
    /// `;;`, `;&`, `;;&` or `esac`: a case item's body.
    CaseItem,
}

pub(super) struct Parser<'a> {
    pub s: &'a [u8],
    pub i: usize,
    pub comments: Vec<(usize, usize)>,
    pub depth: usize,
    /// Whether a backtick closes the innermost substitution.
    pub in_backtick: bool,
    /// Heredocs whose bodies start after the next newline.
    pub pending: Vec<super::heredoc::Pending>,
    /// The heredocs each read of bodies took, with their places in
    /// `pending`, for a reset to put back.
    pub taken: Vec<Vec<(usize, super::heredoc::Pending)>>,
    /// The quoted heredoc bodies read so far, whose continuations bash
    /// keeps.
    pub raw_bodies: Vec<(usize, usize)>,
    /// How many command substitutions enclose the cursor.
    pub comsub: usize,
    /// A heredoc's delimiter line ended mid-line: what follows on it is
    /// a new command.
    pub line_break: bool,
    /// How many brace groups enclose the cursor, where a `}` case pattern
    /// closes the group instead.
    pub braces: usize,
    /// Constructs entered so far by this parse and its look aheads, which
    /// a parse that backtracks over nested input would otherwise let grow
    /// without bound.
    pub work: &'a std::cell::Cell<usize>,
}

/// Parse a whole program.
pub(super) fn parse(source: &[u8]) -> Tree {
    let mut pass = parse_pass(source);
    let dropped = continuations(source, &pass);
    if !dropped.is_empty() {
        let mut logical = Vec::with_capacity(source.len());
        let mut map = Vec::with_capacity(source.len() + 1);
        let mut next = dropped.iter().peekable();
        for (at, byte) in source.iter().enumerate() {
            if next.peek() == Some(&&at) {
                next.next();
                continue;
            }
            logical.push(*byte);
            map.push(at);
        }
        map.push(source.len());
        pass = parse_pass(&logical);
        remap(&mut pass.root, &map);
        for comment in &mut pass.comments {
            *comment = span(*comment, &map);
        }
        if let Some((at, _)) = &mut pass.error {
            *at = map[(*at).min(map.len() - 1)];
        }
    }
    let Pass {
        mut root,
        comments,
        error,
        ..
    } = pass;
    place_comments(&mut root, &comments);
    root.start = root
        .children
        .first()
        .map_or(source.len(), |child| child.start);
    root.end = source.len();
    lay_out(source.to_vec(), root, error)
}

struct Pass {
    root: Syn,
    comments: Vec<(usize, usize)>,
    raw_bodies: Vec<(usize, usize)>,
    error: Option<(usize, String)>,
}

fn parse_pass(source: &[u8]) -> Pass {
    let work = std::cell::Cell::new(0);
    let mut parser = Parser::new(source, &work);
    let mut children = Vec::new();
    let mut error = None;
    loop {
        match parser.next_statement(Close::Eof, None) {
            Ok(Some(mut items)) => children.append(&mut items),
            Ok(None) => break,
            Err(fail) => {
                let start = children.last().map_or(0, |child: &Syn| child.end);
                let start = parser.skip_from(start).min(source.len());
                let mut node = Syn::empty("ERROR", start);
                node.end = source.len();
                children.push(node);
                parser.comments.retain(|&(at, _)| at < start);
                error = Some((fail.at, fail.message));
                break;
            }
        }
    }
    Pass {
        root: Syn::node("program", children),
        comments: parser.comments,
        raw_bodies: parser.raw_bodies,
        error,
    }
}

/// The bytes bash's reader deletes as line continuations: a backslash
/// that an odd run ends, before a newline or the end, and that newline.
/// Single-quoted and ANSI-C text, a comment and a quoted heredoc's body
/// keep theirs.
fn continuations(source: &[u8], pass: &Pass) -> Vec<usize> {
    if memchr::memmem::find(source, b"\\\n").is_none() {
        return Vec::new();
    }
    let mut verbatim = [&pass.comments[..], &pass.raw_bodies[..]].concat();
    collect_verbatim(&pass.root, source, &mut verbatim);
    if let Some(error) = pass
        .root
        .children
        .last()
        .filter(|node| node.kind == "ERROR")
    {
        scan_verbatim(source, error.start, &mut verbatim);
    }
    verbatim.sort_unstable();
    // The candidates come in order: a sweep finds the spans holding each.
    let mut spans = verbatim.iter().peekable();
    let mut covered = 0;
    let mut dropped = Vec::new();
    let mut at = 0;
    while let Some(offset) = memchr::memchr(b'\\', &source[at..]) {
        let start = at + offset;
        let mut end = start;
        while source.get(end) == Some(&b'\\') {
            end += 1;
        }
        let last = end - 1;
        while let Some(&(_, to)) = spans.next_if(|span| span.0 <= last) {
            covered = covered.max(to);
        }
        let live = (end - start) % 2 == 1 && source.get(end) == Some(&b'\n') && covered <= last;
        if live {
            dropped.push(last);
            if end < source.len() {
                dropped.push(end);
            }
        }
        at = end;
    }
    dropped
}

fn collect_verbatim(root: &Syn, source: &[u8], spans: &mut Vec<(usize, usize)>) {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        verbatim_of(node, source, spans);
        stack.extend(&node.children);
    }
}

fn verbatim_of(node: &Syn, source: &[u8], spans: &mut Vec<(usize, usize)>) {
    match node.kind {
        "raw_string" | "ansi_c_string" => spans.push((node.start, node.end)),
        "heredoc_start" => scan_verbatim(&source[..node.end], node.start, spans),
        _ => {}
    }
}

/// Quoted text and comments from `at` on, read without a parse: what an
/// unparsed tail keeps of its continuations.
fn scan_verbatim(source: &[u8], mut at: usize, spans: &mut Vec<(usize, usize)>) {
    let mut quoted = false;
    while at < source.len() {
        let byte = source[at];
        if quoted {
            match byte {
                b'\\' => at += 1,
                b'"' => quoted = false,
                _ => {}
            }
            at += 1;
            continue;
        }
        match byte {
            b'\\' => at += 1,
            b'"' => quoted = true,
            b'\'' => {
                let end = memchr::memchr(b'\'', &source[at + 1..])
                    .map_or(source.len(), |offset| at + offset + 2);
                spans.push((at, end));
                at = end;
                continue;
            }
            b'$' if source.get(at + 1) == Some(&b'\'') => {
                let end = super::lex::ansi_c_end(source, at).unwrap_or(source.len());
                spans.push((at, end));
                at = end;
                continue;
            }
            b'#' if at == 0
                || is_space(source[at - 1])
                || matches!(source[at - 1], b';' | b'&' | b'|' | b'(' | b')') =>
            {
                let end =
                    memchr::memchr(b'\n', &source[at..]).map_or(source.len(), |offset| at + offset);
                spans.push((at, end));
                at = end;
                continue;
            }
            _ => {}
        }
        at += 1;
    }
}

/// A span of the joined text as a span of the source.
fn span((start, end): (usize, usize), map: &[usize]) -> (usize, usize) {
    let from = map[start.min(map.len() - 1)];
    let to = if end > start { map[end - 1] + 1 } else { from };
    (from, to)
}

fn remap(root: &mut Syn, map: &[usize]) {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        (node.start, node.end) = span((node.start, node.end), map);
        stack.extend(node.children.iter_mut());
    }
}

impl<'a> Parser<'a> {
    /// A parser at the start of `s`, counting its work in `work`.
    pub(super) fn new(s: &'a [u8], work: &'a std::cell::Cell<usize>) -> Self {
        Self {
            s,
            i: 0,
            comments: Vec::new(),
            depth: 0,
            in_backtick: false,
            pending: Vec::new(),
            taken: Vec::new(),
            raw_bodies: Vec::new(),
            comsub: 0,
            line_break: false,
            braces: 0,
            work,
        }
    }
}

impl Parser<'_> {
    pub(super) fn mark(&self) -> Mark {
        Mark {
            i: self.i,
            comments: self.comments.len(),
            pending: self.pending.len(),
            taken: self.taken.len(),
            raw_bodies: self.raw_bodies.len(),
            depth: self.depth,
        }
    }

    /// Go back to `mark`: the comments and heredocs read since are
    /// forgotten, heredocs whose bodies were read since are pending again,
    /// and the constructs a failed parse entered are left.
    pub(super) fn reset(&mut self, mark: Mark) {
        self.i = mark.i;
        self.depth = mark.depth;
        self.comments.truncate(mark.comments);
        self.raw_bodies.truncate(mark.raw_bodies);
        // Each read kept the rest in order, so undoing the reads newest
        // first puts every heredoc back where it was.
        let reads: Vec<_> = self.taken.drain(mark.taken..).collect();
        for taken in reads.into_iter().rev() {
            for (index, heredoc) in taken {
                self.pending.insert(index.min(self.pending.len()), heredoc);
            }
        }
        self.pending.truncate(mark.pending);
    }

    /// `reset`, keeping the cursor where it is.
    pub(super) fn forget(&mut self, mark: Mark) {
        let at = self.i;
        self.reset(mark);
        self.i = at;
    }

    pub(super) fn peek(&self) -> u8 {
        self.s.get(self.i).copied().unwrap_or(0)
    }

    pub(super) fn at(&self, offset: usize) -> u8 {
        self.s.get(self.i + offset).copied().unwrap_or(0)
    }

    pub(super) fn eof(&self) -> bool {
        self.i >= self.s.len()
    }

    pub(super) fn starts(&self, text: &[u8]) -> bool {
        self.s[self.i.min(self.s.len())..].starts_with(text)
    }

    pub(super) fn fail<T>(&self, at: usize) -> R<T> {
        Err(self.unexpected(at))
    }

    /// bash's refusal of the token at `at`.
    pub(super) fn unexpected(&self, at: usize) -> Fail {
        if at >= self.s.len() {
            return Fail {
                at,
                message: "syntax error: unexpected end of file".into(),
            };
        }
        let token = self.token_text(at);
        Fail {
            at,
            message: format!("syntax error near unexpected token `{token}'"),
        }
    }

    fn token_text(&self, at: usize) -> String {
        let rest = &self.s[at..];
        let ops: &[&[u8]] = &[
            b";;&", b";;", b";&", b"&&", b"||", b"|&", b">>", b"<<", b"&>", b">&", b"<&", b">|",
            b"\n", b";", b"&", b"|", b"(", b")", b"<", b">",
        ];
        for op in ops {
            if rest.starts_with(op) {
                return if *op == b"\n" {
                    "newline".into()
                } else {
                    String::from_utf8_lossy(op).into_owned()
                };
            }
        }
        let end = super::lex::word_end(self.s, at).max(at + 1);
        String::from_utf8_lossy(&self.s[at..end]).into_owned()
    }

    /// Where the next token after `at` starts, blanks and newlines skipped.
    fn skip_from(&self, mut at: usize) -> usize {
        while at < self.s.len() && is_space(self.s[at]) {
            at += 1;
        }
        at
    }

    pub(super) fn enter(&mut self) -> R<()> {
        self.depth += 1;
        self.work.set(self.work.get() + 1);
        if self.depth > MAX_DEPTH {
            return Err(Fail {
                at: self.i,
                message: "syntax error: nesting too deep".into(),
            });
        }
        if self.work.get() > WORK_PER_BYTE * self.s.len() + WORK_BASE {
            return Err(Fail {
                at: self.i,
                message: "syntax error: too complex to parse".into(),
            });
        }
        Ok(())
    }

    pub(super) fn leave(&mut self) {
        self.depth -= 1;
    }

    /// Skip blanks, line continuations and comments, not newlines.
    pub(super) fn skip_blank(&mut self) {
        loop {
            let byte = self.peek();
            if is_blank(byte) && !self.eof() {
                self.i += 1;
            } else if byte == b'\\' && self.at(1) == b'\n' {
                self.i += 2;
            } else if byte == b'\\' && self.at(1) == b'\r' && self.at(2) == b'\n' {
                self.i += 3;
            } else if byte == b'#' {
                self.comment();
            } else {
                break;
            }
        }
    }

    /// Skip blanks, newlines, continuations and comments.
    pub(super) fn skip_space(&mut self) {
        loop {
            self.skip_blank();
            if self.peek() == b'\n' {
                self.i += 1;
            } else {
                break;
            }
        }
    }

    /// `skip_space`, reading the body of each pending heredoc at the
    /// newline it starts after.
    fn skip_space_bodies(&mut self, out: &mut Vec<Syn>) -> R<()> {
        loop {
            self.skip_blank();
            if self.peek() != b'\n' {
                return Ok(());
            }
            self.i += 1;
            if !self.pending.is_empty() {
                out.extend(self.pending_bodies()?);
            }
        }
    }

    fn comment(&mut self) {
        let start = self.i;
        while !self.eof() && self.peek() != b'\n' {
            self.i += 1;
        }
        self.comments.push((start, self.i));
    }

    /// Where a newline token at the cursor ends: the grammar lexes the
    /// blanks after it into the token up to the run's last newline.
    pub(super) fn newline_end(&self) -> usize {
        let mut end = self.i + 1;
        let mut at = end;
        while at < self.s.len() && is_space(self.s[at]) {
            at += 1;
            if self.s[at - 1] == b'\n' {
                end = at;
            }
        }
        end
    }

    /// Whether the reserved word `word` is next.
    pub(super) fn at_word(&self, word: &[u8]) -> bool {
        is_word(self.s, self.i, word)
            || (self.in_backtick
                && self.s[self.i..].starts_with(word)
                && self.s.get(self.i + word.len()) == Some(&b'`'))
    }

    fn at_close(&self, close: Close) -> bool {
        match close {
            Close::Eof => self.eof(),
            Close::Paren => self.peek() == b')',
            Close::Backtick => self.peek() == b'`',
            Close::Brace => self.at_word(b"}"),
            Close::Words(words) => words.iter().any(|word| self.at_word(word)),
            Close::CaseItem => self.at_case_end() || self.at_word(b"esac"),
        }
    }

    /// Whether a reserved word that closes some construct is next, which
    /// bash reads after a compound command with no separator.
    pub(super) fn at_any_closer(&self) -> bool {
        CLOSERS.iter().any(|word| self.at_word(word))
    }

    fn at_case_end(&self) -> bool {
        self.starts(b";;") || self.starts(b";&")
    }

    /// One statement of a list and its terminator, or None at the list's
    /// close. Children of a field name take it.
    pub(super) fn next_statement(
        &mut self,
        close: Close,
        field: Option<&'static str>,
    ) -> R<Option<Vec<Syn>>> {
        let mut items = Vec::new();
        self.skip_space_bodies(&mut items)?;
        if self.at_close(close) || self.eof() {
            if self.eof() && close != Close::Eof {
                return self.fail(self.i);
            }
            return Ok((!items.is_empty()).then_some(items));
        }
        let statement = self.statement()?;
        let index = items.len();
        items.push(statement);
        self.skip_blank();
        let at = self.i;
        if std::mem::take(&mut self.line_break) {
            items.push(Syn::hidden(at, at));
        } else if self.starts(b";;") || self.starts(b";&") {
            if close != Close::CaseItem {
                return self.fail(at);
            }
        } else if self.peek() == b';' {
            self.i += 1;
            items.push(Syn::token(";", at, at + 1));
        } else if self.peek() == b'&' && !self.starts(b"&&") && !self.starts(b"&>") {
            self.i += 1;
            items.push(Syn::token("&", at, at + 1));
        } else if self.peek() == b'\n' {
            self.i = self.body_newline_end(self.first_readable());
            items.push(Syn::hidden(at, self.i));
            if !self.pending.is_empty() {
                items.extend(self.pending_bodies()?);
            }
        } else if !self.at_close(close)
            && !self.eof()
            && !(ends_compound(&items[index]) && self.at_any_closer())
        {
            return self.fail(at);
        }
        if self.eof() && !self.pending.is_empty() {
            items.extend(self.pending_bodies()?);
        }
        if let Some(field) = field {
            items = Syn::fielded(items, field);
        }
        Ok(Some(items))
    }

    /// A statement list up to `close`; `required` refuses an empty one,
    /// as bash does for every list but a case item's and a substitution's.
    pub(super) fn statements(
        &mut self,
        close: Close,
        field: Option<&'static str>,
        required: bool,
    ) -> R<Vec<Syn>> {
        let mut children = Vec::new();
        let mut terminated = true;
        while let Some(items) = self.next_statement(close, field)? {
            terminated = items.last().is_some_and(|last| {
                matches!(last.kind, ";" | "&" | "" | "heredoc_body" | "heredoc_end")
                    || ends_compound(last)
            });
            children.extend(items);
            if !terminated && !self.at_close(close) {
                return self.fail(self.i);
            }
        }
        if required && children.is_empty() {
            return self.fail(self.i);
        }
        if required && !terminated && close != Close::Paren && close != Close::Backtick {
            return self.fail(self.i);
        }
        Ok(children)
    }

    /// An and-or list: pipelines joined by `&&` and `||`, each redirect
    /// after them wrapping everything before it.
    pub(super) fn statement(&mut self) -> R<Syn> {
        self.enter()?;
        let first = self.primary()?;
        let mut left = self.pipeline_rest(first)?;
        loop {
            self.skip_blank();
            let at = self.i;
            if self.starts(b"&&") || self.starts(b"||") {
                let op = if self.peek() == b'&' { "&&" } else { "||" };
                self.i += 2;
                let mut children = vec![left, Syn::token(op, at, at + 2)];
                self.skip_space_bodies(&mut children)?;
                let right = self.primary()?;
                children.push(self.pipeline_rest(right)?);
                left = Syn::node("list", children);
            } else if self.at_redirect() {
                let mut children = vec![left.with_field("body")];
                while self.at_redirect() {
                    children.push(self.redirect(true)?.with_field("redirect"));
                    self.skip_blank();
                }
                if self.at_herestring() {
                    children.push(self.herestring()?);
                }
                left = Syn::node("redirected_statement", children);
                left = self.pipeline_rest(left)?;
            } else if self.at_herestring() {
                let herestring = self.herestring()?;
                left = Syn::node(
                    "redirected_statement",
                    vec![left.with_field("body"), herestring],
                );
                left = self.pipeline_rest(left)?;
            } else {
                break;
            }
        }
        self.leave();
        Ok(left)
    }

    fn pipeline_rest(&mut self, first: Syn) -> R<Syn> {
        self.skip_blank();
        if !self.at_pipe() {
            return Ok(first);
        }
        let mut children = vec![first];
        while self.at_pipe() {
            let at = self.i;
            let op = if self.at(1) == b'&' { "|&" } else { "|" };
            self.i += op.len();
            children.push(Syn::token(op, at, self.i));
            self.skip_space_bodies(&mut children)?;
            if self.peek() == b'!' && (is_space(self.at(1)) || self.at(1) == 0) {
                return self.fail(self.i);
            }
            children.push(self.element()?);
            self.skip_blank();
        }
        Ok(Syn::node("pipeline", children))
    }

    fn at_pipe(&self) -> bool {
        self.peek() == b'|' && self.at(1) != b'|'
    }

    /// What starts a pipeline: `time` and the pipeline it times, or a
    /// command.
    pub(super) fn primary(&mut self) -> R<Syn> {
        self.skip_blank();
        if self.at_word(b"time") {
            return self.timed();
        }
        self.element()
    }

    /// `time [-p] [--] pipeline`, the redirects after it included; alone
    /// before a separator, it times nothing.
    fn timed(&mut self) -> R<Syn> {
        self.enter()?;
        let mut children = vec![self.keyword("time")?];
        self.skip_blank();
        for option in ["-p", "--"] {
            if self.at_word(option.as_bytes()) {
                children.push(self.keyword(option)?);
                self.skip_blank();
            }
        }
        if !self.at_list_end() {
            let first = self.primary()?;
            let mut body = self.pipeline_rest(first)?;
            self.skip_blank();
            if self.at_redirect() {
                let mut wrapped = vec![body.with_field("body")];
                while self.at_redirect() {
                    wrapped.push(self.redirect(true)?.with_field("redirect"));
                    self.skip_blank();
                }
                body = Syn::node("redirected_statement", wrapped);
            }
            children.push(body);
        }
        self.leave();
        Ok(Syn::node("timed_statement", children))
    }

    /// Whether a separator ends the list here, so a `!` or `time` before
    /// it stands alone.
    fn at_list_end(&self) -> bool {
        self.eof()
            || self.peek() == b'\n'
            || (self.peek() == b';' && !self.starts(b";;") && !self.starts(b";&"))
            || (self.peek() == b'&' && !self.starts(b"&&") && !self.starts(b"&>"))
    }

    /// A command or a compound command, as one stage of a pipeline.
    pub(super) fn element(&mut self) -> R<Syn> {
        self.skip_blank();
        let at = self.i;
        if self.eof() {
            return self.fail(at);
        }
        if self.peek() == b'!' && (is_space(self.at(1)) || self.at(1) == 0) {
            return self.negated();
        }
        if self.starts(b"((") {
            return self.double_paren();
        }
        if self.peek() == b'(' {
            return self.subshell();
        }
        if self.at_word(b"{") {
            return self.compound();
        }
        if self.at_word(b"[[") {
            return self.test_command(true);
        }
        if self.peek() == b'[' && is_space(self.at(1)) {
            // `[` is a command: one whose words the grammar cannot read
            // as a test, or that has no `]`, still runs.
            let mark = self.mark();
            match self.test_command(false) {
                Ok(node) => return Ok(node),
                Err(_) => {
                    self.reset(mark);
                    return self.command();
                }
            }
        }
        if self.at_word(b"if") {
            return self.if_statement();
        }
        if self.at_word(b"while") || self.at_word(b"until") {
            return self.while_statement();
        }
        if self.at_word(b"for") || self.at_word(b"select") {
            return self.for_statement();
        }
        if self.at_word(b"case") {
            return self.case_statement();
        }
        if self.at_word(b"function") {
            return self.function_definition();
        }
        for word in CLOSERS {
            if self.at_word(word) {
                return self.fail(at);
            }
        }
        for (word, kind) in [
            ("declare", "declaration_command"),
            ("typeset", "declaration_command"),
            ("export", "declaration_command"),
            ("readonly", "declaration_command"),
            ("local", "declaration_command"),
            ("unset", "unset_command"),
            ("unsetenv", "unset_command"),
        ] {
            if self.at_word(word.as_bytes()) {
                return self.declaration(word, kind);
            }
        }
        if !self.at_assignment() {
            if let Some(definition) = self.try_function()? {
                return Ok(definition);
            }
        }
        self.command()
    }

    /// A keyword token at the cursor, consumed.
    pub(super) fn keyword(&mut self, word: &'static str) -> R<Syn> {
        if !self.at_word(word.as_bytes()) {
            return self.fail(self.i);
        }
        let at = self.i;
        self.i += word.len();
        Ok(Syn::token(word, at, self.i))
    }

    /// An operator token at the cursor, consumed.
    pub(super) fn expect(&mut self, text: &'static str) -> R<Syn> {
        if !self.starts(text.as_bytes()) {
            return self.fail(self.i);
        }
        let at = self.i;
        self.i += text.len();
        Ok(Syn::token(text, at, self.i))
    }

    fn negated(&mut self) -> R<Syn> {
        self.enter()?;
        let mut children = vec![self.expect("!")?];
        self.skip_blank();
        if !self.at_list_end() {
            children.push(self.primary()?);
        }
        self.leave();
        Ok(Syn::node("negated_command", children))
    }
}
