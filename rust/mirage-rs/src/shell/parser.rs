use super::heredoc::Body;
use super::lex::{is_blank, is_space, is_word};
use super::lower::lower;
use super::tree::{Refusal, Syn, Tree, lay_out, place_comments};

/// How deep constructs may nest before the parser refuses the line, so a
/// hostile line cannot run the host out of stack.
const MAX_DEPTH: usize = 192;

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
    /// Past the text bash names: a refused array's line is read on from
    /// the line after it.
    pub end: usize,
    /// bash's diagnostic lines, without its prefix, the line's own bytes
    /// in them as typed.
    pub lines: Vec<Vec<u8>>,
    /// 2 for a syntax error, 1 for an array bash cannot read, 127 for a
    /// substitution whose body bash cannot parse.
    pub status: u8,
    /// The input ended inside a construct.
    pub eof: bool,
    /// The input ended inside a quote or a matched pair.
    pub matching: bool,
}

/// A construct whose refusal bash gives a status of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Frame {
    /// `$(...)`, `<(...)` or `>(...)`.
    Substitution,
    /// `name=(...)`.
    Array,
}

pub(super) type R<T> = Result<T, Fail>;

/// Where a speculative parse started, to go back to.
#[derive(Clone, Copy)]
pub(super) struct Mark {
    i: usize,
    comments: usize,
    pending: usize,
    taken: usize,
    bodies: usize,
    closes: usize,
    depth: usize,
    ended: bool,
}

/// What a parse and its look aheads spend: the constructs they entered,
/// which a parse that backtracks over nested input would otherwise let
/// grow without bound, and how deep bash's reader's scan of quotes and
/// expansions has nested. `ends` holds where each substitution a scan
/// read closes, by where it opens, and the heredocs still pending there,
/// so a scan inside a scan reads each body once.
#[derive(Default)]
pub(super) struct Budget {
    pub work: std::cell::Cell<usize>,
    pub scans: std::cell::Cell<usize>,
    pub ends: std::cell::RefCell<
        std::collections::BTreeMap<usize, (usize, Vec<super::heredoc::Pending>)>,
    >,
}

/// How deep the scan of quotes and expansions nests, or a `!` chain in a
/// conditional, before the parser refuses the line.
pub(super) const MAX_SCAN: usize = 1000;

/// How many compound commands, substitutions and conditional groups may
/// nest; bash refuses the next opener, as it does one nested past its own
/// reader.
pub(super) const MAX_NESTING: usize = 64;

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
    /// The heredoc bodies read so far, in the order bash reads them.
    pub bodies: Vec<Body>,
    /// Each substitution closed with heredocs opened inside still to
    /// read: its `)` and their `<<`s.
    pub closes: Vec<(usize, Vec<usize>)>,
    /// How many command substitutions enclose the cursor.
    pub comsub: usize,
    /// A heredoc's delimiter line ended mid-line: what follows on it is
    /// a new command.
    pub line_break: bool,
    /// How many brace groups enclose the cursor, where a `}` case pattern
    /// closes the group instead.
    pub braces: usize,
    /// The substitutions and arrays the cursor is inside, innermost last.
    pub frames: Vec<Frame>,
    /// The newline bash supposes at the end of the input was read, so the
    /// input's end is no longer a `newline` token.
    pub ended: bool,
    /// How many compound commands and substitutions enclose the cursor.
    pub nesting: usize,
    /// What this parse and its look aheads have spent.
    pub budget: &'a Budget,
    /// How the line is read.
    pub options: &'a super::Options,
}

/// Parse a whole program as bash reads it: each heredoc's body folded
/// into its line as a `<` redirect from a double-quoted word, then the
/// line continuations dropped. The tree reads that text; its offsets map
/// it back to `source`.
pub(super) fn parse(source: &[u8], options: &super::Options) -> Tree {
    // Whether the line as typed ends in a newline, or in a backslash that
    // continues onto nothing, decides on every pass whether its end is one.
    let ended = source.ends_with(b"\n") || super::heredoc::ends_escaped(source);
    let first = parse_pass(source, options, ended);
    let bodies = &first.bodies;
    if bodies.is_empty() {
        let offsets = (0..=source.len()).collect();
        return joined(
            source.to_vec(),
            first,
            options,
            ended,
            offsets,
            Vec::new(),
            Vec::new(),
            source,
        );
    }
    let mut warned = std::collections::HashSet::new();
    let closes = first
        .closes
        .iter()
        .filter_map(|(close, opened)| {
            let fresh: Vec<usize> = opened
                .iter()
                .copied()
                .filter(|at| warned.insert(*at))
                .collect();
            (!fresh.is_empty()).then_some((*close, fresh))
        })
        .collect();
    let lowered = lower(source, bodies);
    let pass = parse_pass(&lowered.source, options, ended);
    joined(
        lowered.source,
        pass,
        options,
        ended,
        lowered.offsets,
        lowered.heredocs,
        closes,
        source,
    )
}

/// Lay out a pass over `text`, its line continuations dropped first:
/// `offsets` map `text` to `source`, and each heredoc's `at` is in `text`.
/// The error is the last pass's, as bash reads the line joined.
#[allow(clippy::too_many_arguments)]
fn joined(
    text: Vec<u8>,
    mut pass: Pass,
    options: &super::Options,
    ended: bool,
    mut offsets: Vec<usize>,
    mut heredocs: Vec<super::lower::Heredoc>,
    mut closes: Vec<(usize, Vec<usize>)>,
    source: &[u8],
) -> Tree {
    let mut dropped = continuations(&text, &pass);
    let text = if dropped.is_empty() {
        text
    } else {
        let (mut logical, mut places) = without(&text, &dropped);
        pass = parse_pass(&logical, options, ended);
        // A quoted heredoc the joined line brings to light reads its body
        // as typed: the continuations in it stay.
        loop {
            let quoted: Vec<(usize, usize)> = pass
                .bodies
                .iter()
                .filter(|body| body.heredoc.raw)
                .map(|body| (places[body.start], places[body.end.min(logical.len())]))
                .collect();
            let before = dropped.len();
            dropped.retain(|at| !quoted.iter().any(|(from, to)| from <= at && at < to));
            if dropped.len() == before {
                break;
            }
            (logical, places) = without(&text, &dropped);
            pass = parse_pass(&logical, options, ended);
        }
        offsets = places.iter().map(|at| offsets[*at]).collect();
        for heredoc in &mut heredocs {
            heredoc.at -= dropped.partition_point(|&at| at < heredoc.at);
        }
        let mut text = logical;
        // A heredoc a continuation split (`$\⏎(cat <<E)`, `<\⏎<E`) comes to
        // light only now: fold its body in as the first pass folds the
        // others, its places in the line as typed.
        while !pass.bodies.is_empty() {
            let lowered = lower(&text, &pass.bodies);
            let start = |at: usize| offsets[at.min(text.len())];
            let end = |at: usize| at.checked_sub(1).map_or(offsets[0], |last| start(last) + 1);
            let lines = super::lower::newlines(source) + usize::from(!source.ends_with(b"\n"));
            for heredoc in &mut heredocs {
                if let Some(at) = lowered.offsets.iter().position(|at| *at == heredoc.at) {
                    heredoc.at = at;
                }
            }
            for mut heredoc in lowered.heredocs {
                heredoc.operator = start(heredoc.operator);
                heredoc.word_end = end(heredoc.word_end);
                heredoc.body_start = start(heredoc.body_start);
                heredoc.end = end(heredoc.end);
                heredoc.line =
                    super::lower::newlines(&source[..heredoc.body_start.saturating_sub(1)]) + 1;
                heredoc.eof_line = lines.max(heredoc.line);
                heredocs.push(heredoc);
            }
            closes.extend(pass.closes.iter().map(|(close, opened)| {
                (start(*close), opened.iter().map(|at| start(*at)).collect())
            }));
            heredocs.sort_by_key(|heredoc| heredoc.at);
            offsets = lowered.offsets.iter().map(|at| offsets[*at]).collect();
            text = lowered.source;
            pass = parse_pass(&text, options, ended);
        }
        text
    };
    let Pass {
        mut root,
        comments,
        error,
        ..
    } = pass;
    let error = error.map(|fail| {
        let to_source = |at: usize| offsets[at.min(text.len())];
        let first = Fail {
            at: to_source(fail.at),
            end: to_source(fail.end),
            ..fail
        };
        refusals(source, options, ended, first)
    });
    place_comments(&mut root, &comments);
    root.start = root
        .children
        .first()
        .map_or(text.len(), |child| child.start);
    root.end = text.len();
    let mut tree = lay_out(text, root, error);
    tree.original = source.to_vec();
    tree.offsets = offsets;
    tree.heredocs = heredocs;
    tree.closes = closes;
    tree
}

/// `text` less the bytes at `dropped` (sorted), and where each byte left
/// stood in it, then its end.
fn without(text: &[u8], dropped: &[usize]) -> (Vec<u8>, Vec<usize>) {
    let mut kept = Vec::with_capacity(text.len());
    let mut places = Vec::with_capacity(text.len() + 1);
    let mut next = dropped.iter().peekable();
    for (at, byte) in text.iter().enumerate() {
        if next.next_if(|drop| **drop == at).is_some() {
            continue;
        }
        kept.push(*byte);
        places.push(at);
    }
    places.push(text.len());
    (kept, places)
}

struct Pass {
    root: Syn,
    comments: Vec<(usize, usize)>,
    bodies: Vec<Body>,
    closes: Vec<(usize, Vec<usize>)>,
    error: Option<Fail>,
}

fn parse_pass(source: &[u8], options: &super::Options, ended: bool) -> Pass {
    let budget = Budget::default();
    let mut parser = Parser::new(source, &budget, options);
    parser.ended = ended;
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
                error = Some(fail);
                break;
            }
        }
    }
    Pass {
        root: Syn::node("program", children),
        comments: parser.comments,
        bodies: parser.bodies,
        closes: parser.closes,
        error,
    }
}

/// Every refusal bash reports for the line as typed, `source`, which fails
/// with `first`: an array bash cannot read discards only its physical
/// line, and bash reads on from the next, where a later refusal's status
/// wins, but for one that ends inside a quote or pair after an earlier
/// one.
fn refusals(source: &[u8], options: &super::Options, ended: bool, first: Fail) -> Refusal {
    let mut found = vec![first];
    while let Some(last) = found.last().filter(|last| last.status == 1 && !last.eof) {
        let Some(newline) = memchr::memchr(b'\n', &source[last.end.min(source.len())..]) else {
            break;
        };
        let budget = Budget::default();
        let mut parser = Parser::new(source, &budget, options);
        parser.ended = ended;
        parser.i = last.end + newline + 1;
        let mut fail = loop {
            match parser.next_statement(Close::Eof, None) {
                Ok(Some(_)) => {}
                Ok(None) => break None,
                Err(fail) => break Some(fail),
            }
        };
        let Some(mut fail) = fail.take() else {
            break;
        };
        if fail.matching || found.iter().any(|earlier| earlier.matching) {
            fail.status = last.status;
        }
        found.push(fail);
    }
    Refusal {
        at: found[0].at,
        message: found
            .iter()
            .flat_map(|fail| &fail.lines)
            .flat_map(|line| worded(line))
            .collect(),
        status: found.last().map_or(2, |last| last.status),
    }
}

/// One of bash's diagnostic lines as mirage prints it.
fn worded(line: &[u8]) -> Vec<u8> {
    for opener in [
        &b"syntax error near unexpected token `"[..],
        b"syntax error near `",
    ] {
        if let Some(text) = line
            .strip_prefix(opener)
            .and_then(|rest| rest.strip_suffix(b"'"))
        {
            return [&b"mirage: syntax error near '"[..], text, b"'\n"].concat();
        }
    }
    [&b"mirage: "[..], line, b"\n"].concat()
}

/// A diagnostic line from its pieces.
pub(super) fn line(pieces: &[&[u8]]) -> Vec<u8> {
    pieces.concat()
}

/// The bytes bash's reader deletes as line continuations: a backslash
/// that an odd run ends, before a newline or the end of the input, and
/// that newline. Single-quoted and ANSI-C text and a comment keep theirs.
fn continuations(source: &[u8], pass: &Pass) -> Vec<usize> {
    if memchr::memmem::find(source, b"\\\n").is_none() && !source.ends_with(b"\\") {
        return Vec::new();
    }
    let mut verbatim = pass.comments.clone();
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
        let live = (end - start) % 2 == 1
            && matches!(source.get(end), None | Some(b'\n'))
            && covered <= last;
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

impl<'a> Parser<'a> {
    /// A parser at the start of `s`, spending from `budget`.
    pub(super) fn new(s: &'a [u8], budget: &'a Budget, options: &'a super::Options) -> Self {
        Self {
            s,
            i: 0,
            comments: Vec::new(),
            depth: 0,
            in_backtick: false,
            pending: Vec::new(),
            taken: Vec::new(),
            bodies: Vec::new(),
            closes: Vec::new(),
            comsub: 0,
            line_break: false,
            braces: 0,
            frames: Vec::new(),
            ended: s.ends_with(b"\n"),
            nesting: 0,
            budget,
            options,
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
            bodies: self.bodies.len(),
            closes: self.closes.len(),
            depth: self.depth,
            ended: self.ended,
        }
    }

    /// Go back to `mark`: the comments and heredocs read since are
    /// forgotten, heredocs whose bodies were read since are pending again,
    /// and the constructs a failed parse entered are left.
    pub(super) fn reset(&mut self, mark: Mark) {
        self.i = mark.i;
        self.depth = mark.depth;
        self.ended = mark.ended;
        self.comments.truncate(mark.comments);
        self.bodies.truncate(mark.bodies);
        self.closes.truncate(mark.closes);
        let reads: Vec<_> = self.taken.drain(mark.taken..).collect();
        self.put_back(reads, mark.pending);
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

    /// A refusal at `at` in bash's `lines`, its status set by where the
    /// parser stands: inside an array 1, the input ending there too;
    /// otherwise inside a substitution 127, and 2 elsewhere.
    pub(super) fn refusal(&self, at: usize, end: usize, lines: Vec<Vec<u8>>, eof: bool) -> Fail {
        let status = if eof {
            if self.frames.contains(&Frame::Array) {
                1
            } else {
                2
            }
        } else {
            match self.frames.last() {
                None => 2,
                Some(Frame::Array) => 1,
                Some(Frame::Substitution) => 127,
            }
        };
        Fail {
            at,
            end,
            lines,
            status,
            eof,
            matching: false,
        }
    }

    /// bash's refusal of input that ends before the `closer` the construct
    /// at `at` waits for.
    pub(super) fn matching(&self, at: usize, closer: char) -> Fail {
        let mut closer_bytes = [0; 4];
        let closer = closer.encode_utf8(&mut closer_bytes).as_bytes();
        let line = line(&[b"unexpected EOF while looking for matching `", closer, b"'"]);
        Fail {
            matching: true,
            ..self.refusal(at, self.s.len(), vec![line], true)
        }
    }

    /// Past the `{name}` of a `{name}>` or `{name}<` redirect at `at`.
    pub(super) fn redirvar_end(&self, at: usize) -> Option<usize> {
        if self.s.get(at) != Some(&b'{') {
            return None;
        }
        let close = at + memchr::memchr(b'}', &self.s[at..])?;
        let name = &self.s[at + 1..close];
        let named = name
            .first()
            .is_some_and(|byte| super::lex::is_name_start(*byte))
            && name.iter().all(|byte| super::lex::is_name(*byte));
        (named
            && matches!(self.s.get(close + 1), Some(b'<' | b'>'))
            && self.s.get(close + 2) != Some(&b'('))
        .then_some(close + 1)
    }

    /// What bash says when the input ends where it waits for more.
    pub(super) fn eof_line(&self) -> &'static str {
        if self.frames.contains(&Frame::Substitution) {
            "unexpected EOF while looking for matching `)'"
        } else {
            "syntax error: unexpected end of file"
        }
    }

    /// bash's refusal of the token at `at`. At the end of the input it is
    /// the newline bash supposes there, unless that was read.
    pub(super) fn unexpected(&self, at: usize) -> Fail {
        // `{name}>` is one token, which bash names by the text up to it.
        if let Some(end) = self.redirvar_end(at) {
            return self.near(end + 1, false);
        }
        if at >= self.s.len() {
            if !self.ended {
                let line = "syntax error near unexpected token `newline'".into();
                return self.refusal(at, at, vec![line], false);
            }
            return self.refusal(at, at, vec![self.eof_line().into()], true);
        }
        let token = match self.token_text(at) {
            Ok(token) => token,
            Err(fail) => return fail,
        };
        let end = at + token.len().max(1);
        let token = if token == b"\n" {
            b"newline".to_vec()
        } else {
            token
        };
        self.refusal(
            at,
            end,
            vec![line(&[
                b"syntax error near unexpected token `",
                &token,
                b"'",
            ])],
            false,
        )
    }

    /// The token at `at` as bash names it; bash's lexer reads a word
    /// whole first, refusing one that the input ends inside.
    fn token_text(&self, at: usize) -> R<Vec<u8>> {
        let rest = &self.s[at..];
        let ops: &[&[u8]] = &[
            b";;&", b";;", b";&", b"&&", b"||", b"|&", b">>", b"<<", b"&>", b">&", b"<&", b">|",
            b"\n", b";", b"&", b"|", b"(", b")", b"<", b">",
        ];
        for op in ops {
            if rest.starts_with(op) {
                return Ok(op.to_vec());
            }
        }
        let end = self.scan_word(at)?.max(at + 1);
        let mut word = Vec::with_capacity(end - at);
        let mut from = at;
        while from < end {
            if self.s[from..end].starts_with(b"\\\n") {
                from += 2;
                continue;
            }
            word.push(self.s[from]);
            from += 1;
        }
        Ok(word)
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
        let work = &self.budget.work;
        work.set(work.get() + 1);
        let line = if self.depth > MAX_DEPTH {
            "syntax error: nesting too deep"
        } else if work.get() > WORK_PER_BYTE * self.s.len() + WORK_BASE {
            "syntax error: too complex to parse"
        } else {
            return Ok(());
        };
        Err(Fail {
            status: 2,
            ..self.refusal(self.i, self.i, vec![line.into()], false)
        })
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

    /// Skip blanks, newlines, continuations and comments, the newline
    /// bash supposes at the end of the input too.
    pub(super) fn skip_space(&mut self) {
        loop {
            self.skip_blank();
            if self.peek() == b'\n' {
                self.i += 1;
            } else {
                self.ended |= self.eof();
                break;
            }
        }
    }

    /// `skip_space`, reading the body of each pending heredoc at the
    /// newline it starts after.
    pub(super) fn skip_space_bodies(&mut self) {
        loop {
            self.skip_blank();
            if self.peek() != b'\n' {
                self.ended |= self.eof();
                return;
            }
            self.i += 1;
            self.pending_bodies();
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

    /// Whether the reserved word `word` is next. An alias of that name is
    /// a command instead, as bash expands it before it reads a reserved
    /// word, but for inside a substitution, which bash reads first.
    pub(super) fn at_word(&self, word: &[u8]) -> bool {
        self.at_spelled(word)
            && (self.comsub > 0 || !self.options.aliases.iter().any(|alias| alias == word))
    }

    /// Whether the word `word` is next, whatever aliases there are: a
    /// header's `in`, where no alias expands.
    pub(super) fn at_spelled(&self, word: &[u8]) -> bool {
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
        self.skip_space_bodies();
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
            self.i = if self.pending.is_empty() {
                self.newline_end()
            } else {
                at + 1
            };
            items.push(Syn::hidden(at, self.i));
            self.pending_bodies();
        } else if !self.at_close(close)
            && !self.eof()
            && !(ends_compound(&items[index]) && self.at_any_closer())
        {
            // After a compound command bash reads `((` as arithmetic first,
            // naming what it holds.
            if ends_compound(&items[index]) && self.starts(b"((") {
                let end = self.scan_matched(at + 2, at, b'(', b')')?;
                if self.s.get(end + 1) == Some(&b')') {
                    let inner = &self.s[at + 2..end];
                    let line = line(&[b"syntax error near unexpected token `", inner, b"'"]);
                    return Err(self.refusal(at, end + 2, vec![line], false));
                }
            }
            return self.fail(at);
        }
        if self.eof() {
            self.ended = true;
            self.pending_bodies();
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
            terminated = items
                .last()
                .is_some_and(|last| matches!(last.kind, ";" | "&" | "") || ends_compound(last));
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
                self.skip_space_bodies();
                let right = self.primary()?;
                children.push(self.pipeline_rest(right)?);
                left = Syn::node("list", children);
            } else if self.at_redirect() {
                let mut children = vec![left.with_field("body")];
                while self.at_redirect() {
                    children.push(self.redirect(false)?.with_field("redirect"));
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
            self.skip_space_bodies();
            if self.at_bang() {
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
                    wrapped.push(self.redirect(false)?.with_field("redirect"));
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
    }

    /// A command or a compound command, as one stage of a pipeline; a
    /// compound one nested `MAX_NESTING` deep is refused at its opener.
    pub(super) fn element(&mut self) -> R<Syn> {
        self.skip_blank();
        let compound = self.peek() == b'('
            || [
                &b"{"[..],
                b"[[",
                b"if",
                b"while",
                b"until",
                b"for",
                b"select",
                b"case",
                b"function",
                b"coproc",
            ]
            .iter()
            .any(|word| self.at_word(word));
        if !compound {
            return self.element_body();
        }
        if self.nesting >= MAX_NESTING {
            return self.fail(self.i);
        }
        self.nesting += 1;
        let node = self.element_body();
        self.nesting -= 1;
        node
    }

    fn element_body(&mut self) -> R<Syn> {
        let at = self.i;
        if self.eof() {
            return self.fail(at);
        }
        if self.at_bang() {
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
            return self.test_command();
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
        if let Some((word, kind)) = self.at_declaration() {
            return self.declaration(Vec::new(), word, kind);
        }
        if !self.at_assignment() {
            if let Some(definition) = self.try_function()? {
                return Ok(definition);
            }
        }
        self.command()
    }

    /// The declaration builtin named here, and the node it reads as.
    pub(super) fn at_declaration(&self) -> Option<(&'static str, &'static str)> {
        [
            ("declare", "declaration_command"),
            ("typeset", "declaration_command"),
            ("export", "declaration_command"),
            ("readonly", "declaration_command"),
            ("local", "declaration_command"),
            ("unset", "unset_command"),
            ("unsetenv", "unset_command"),
        ]
        .into_iter()
        .find(|(word, _)| self.at_word(word.as_bytes()))
    }

    /// A keyword token at the cursor, consumed. A header's `in` is read
    /// whatever aliases there are.
    pub(super) fn keyword(&mut self, word: &'static str) -> R<Syn> {
        let spelled = if word == "in" {
            self.at_spelled(word.as_bytes())
        } else {
            self.at_word(word.as_bytes())
        };
        if !spelled {
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

    /// Whether a `!` that negates a pipeline is next: one that ends its
    /// word, as a `(` does too where extglob does not take it.
    fn at_bang(&self) -> bool {
        self.peek() == b'!'
            && (matches!(
                self.at(1),
                0 | b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'<' | b'>' | b')'
            ) || self.at(1) == b'(' && !self.options.extglob)
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
