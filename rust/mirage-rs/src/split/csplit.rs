//! csplit: the input opens first, then the patterns parse in GNU's words,
//! and each pattern cuts one piece as the lines stream past. Two cursors
//! decide the cuts: `head`, the first line no piece holds yet, and
//! `seen`, the first line a regex may match; a line the cut lands after
//! goes to the next piece, read already.

use std::collections::VecDeque;
use std::task::Poll;

use serde::Deserialize;

use crate::printf::number::render_integer;
use crate::regex::parse::Dialect;
use crate::regex::posix::{Options, Posix};
use crate::request::{Io, Opening, Refused, Reply, Request, WriteMode, bytes, read_failure};
use crate::{Stream, StreamError, parse_config, quoted};

use super::pieces::{Input, MAX_SUFFIX, Piece, STEPS, write_failure};

/// The longest line csplit holds to test or look back over: past it the
/// run ends as GNU's does once memory runs out.
#[cfg(not(test))]
const MAX_LEN: usize = 1 << 30;
#[cfg(test)]
pub(super) const MAX_LEN: usize = 1 << 12;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default = "prefix", deserialize_with = "crate::latin1")]
    prefix: Vec<u8>,
    /// -n as typed.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    digits: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    suffix_format: Option<Vec<u8>>,
    #[serde(default)]
    keep: bool,
    #[serde(default)]
    silent: bool,
    #[serde(default)]
    suppress: bool,
    #[serde(default)]
    elide: bool,
    #[serde(default)]
    utf8: bool,
    /// FILE as typed, then the patterns.
    #[serde(default, deserialize_with = "crate::latin1_list")]
    operands: Vec<Vec<u8>>,
}

fn prefix() -> Vec<u8> {
    b"xx".to_vec()
}

/// A suffix format: one integer conversion between literal text, which
/// printf's renderer renders.
#[derive(Default)]
struct Format {
    before: Vec<u8>,
    after: Vec<u8>,
    flags: Vec<u8>,
    width: usize,
    precision: Option<usize>,
    conversion: u8,
}

fn number(raw: &[u8], at: &mut usize) -> usize {
    let mut value = 0usize;
    while let Some(digit) = raw.get(*at).filter(|b| b.is_ascii_digit()) {
        value = value
            .saturating_mul(10)
            .saturating_add(usize::from(digit - b'0'));
        *at += 1;
    }
    value
}

impl Format {
    /// -b as GNU checks it: `%%` is a percent sign, and exactly one
    /// conversion of `d i u o x X` with the flags `-0#'`, a width and a
    /// precision.
    fn parse(raw: &[u8]) -> Result<Format, Vec<u8>> {
        let mut format = Format::default();
        let mut at = 0;
        while let Some(&byte) = raw.get(at) {
            at += 1;
            let text = if format.conversion == 0 {
                &mut format.before
            } else {
                &mut format.after
            };
            if byte != b'%' {
                text.push(byte);
                continue;
            }
            if raw.get(at) == Some(&b'%') {
                text.push(b'%');
                at += 1;
                continue;
            }
            if format.conversion != 0 {
                return Err(b"csplit: too many % conversion specifications in suffix".to_vec());
            }
            while let Some(&flag) = raw.get(at).filter(|b| b"-0#'".contains(b)) {
                format.flags.push(flag);
                at += 1;
            }
            format.width = number(raw, &mut at);
            if raw.get(at) == Some(&b'.') {
                at += 1;
                format.precision = Some(number(raw, &mut at));
            }
            match raw.get(at) {
                None => return Err(b"csplit: missing conversion specifier in suffix".to_vec()),
                Some(&conversion) if b"diuoxX".contains(&conversion) => {
                    format.conversion = conversion;
                    at += 1;
                }
                Some(&other) => {
                    let mut refused = b"csplit: invalid conversion specifier in suffix: ".to_vec();
                    refused.push(other);
                    return Err(refused);
                }
            }
        }
        if format.conversion == 0 {
            return Err(b"csplit: missing % conversion specification in suffix".to_vec());
        }
        Ok(format)
    }

    fn render(&self, value: usize) -> Vec<u8> {
        let precision = self.precision.map(|p| p as u64);
        let rendered = render_integer(value as i128, self.conversion, &self.flags, precision);
        let pad = self.width.saturating_sub(rendered.byte_len() as usize);
        let left = self.flags.contains(&b'-');
        let zero = rendered.allow_zero && self.flags.contains(&b'0') && !left;
        let mut out = self.before.clone();
        out.resize(out.len() + if left || zero { 0 } else { pad }, b' ');
        out.extend_from_slice(&rendered.prefix);
        out.resize(out.len() + if zero { pad } else { 0 }, b'0');
        out.extend_from_slice(&rendered.body);
        out.resize(out.len() + rendered.zero_tail as usize, b'0');
        out.extend_from_slice(&rendered.suffix);
        out.resize(out.len() + if left { pad } else { 0 }, b' ');
        out.extend_from_slice(&self.after);
        out
    }
}

enum Cut {
    /// Up to line N, then N more per repetition.
    Line(u64),
    /// The line a regex matches, moved by an offset; `%` writes no piece.
    Regex {
        regex: Box<Posix>,
        offset: i64,
        skip: bool,
    },
}

struct Pattern {
    text: Vec<u8>,
    cut: Cut,
    /// The repetitions after the first: `{N}`, or `{*}` as u64::MAX.
    repeat: u64,
}

/// A number as GNU's decimal scans read it: C blanks, a sign, digits, and
/// nothing after, a value past u128 saturating; None for anything else.
fn decimal(raw: &[u8]) -> Option<(bool, u128)> {
    let start = raw
        .iter()
        .position(|b| !b" \t\n\x0b\x0c\r".contains(b))
        .unwrap_or(raw.len());
    let (negative, digits) = match &raw[start..] {
        [b'-', rest @ ..] => (true, rest),
        [b'+', rest @ ..] => (false, rest),
        rest => (false, rest),
    };
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let value = digits.iter().fold(0u128, |n, d| {
        n.saturating_mul(10).saturating_add(u128::from(d - b'0'))
    });
    Some((negative, value))
}

fn says(text: &[u8], what: &str) -> Vec<u8> {
    format!("csplit: '{}': {what}", quoted(text)).into_bytes()
}

/// The patterns in GNU's order and words; a repeated line number is a
/// warning, written to `warnings`.
fn patterns(
    texts: &[Vec<u8>],
    utf8: bool,
    warnings: &mut Vec<u8>,
) -> Result<Vec<Pattern>, Vec<u8>> {
    let mut patterns: Vec<Pattern> = Vec::new();
    let mut last = 0u64;
    let mut repeated = false;
    for text in texts {
        if let Some(inner) = text.strip_prefix(b"{") {
            let Some(previous) = patterns.last_mut().filter(|_| !repeated) else {
                return Err(says(text, "invalid pattern"));
            };
            let Some(inner) = inner.strip_suffix(b"}") else {
                return Err(says(text, "'}' is required in repeat count"));
            };
            previous.repeat = match decimal(inner) {
                _ if inner == b"*" => u64::MAX,
                Some((false, count)) if count <= u128::from(u64::MAX) => count as u64,
                _ => {
                    let head = quoted(&text[..text.len() - 1]);
                    let what = "}: integer required between '{' and '}'";
                    return Err(format!("csplit: '{head}'{what}").into_bytes());
                }
            };
            repeated = true;
            continue;
        }
        repeated = false;
        let cut = match text.first() {
            Some(&delimiter @ (b'/' | b'%')) => {
                let Some(close) = text[1..].iter().rposition(|&b| b == delimiter) else {
                    let close = [delimiter];
                    let what = [b": closing delimiter '".as_slice(), &close, b"' missing"];
                    return Err([b"csplit: ", text.as_slice(), &what.concat()].concat());
                };
                let options = Options {
                    extended: false,
                    dialect: Dialect::Posix,
                    ignore_case: false,
                    utf8,
                    multiline: false,
                    word: false,
                };
                let regex = Posix::compile(&text[1..close + 1], &options).map_err(|message| {
                    says(text, &format!("invalid regular expression: {message}"))
                })?;
                let tail = &text[close + 2..];
                let offset = if tail.is_empty() {
                    0
                } else {
                    match decimal(tail) {
                        Some((negative, value)) => {
                            let value = i64::try_from(value)
                                .map_err(|_| says(text, "integer expected after delimiter"))?;
                            if negative { -value } else { value }
                        }
                        None => return Err(says(text, "integer expected after delimiter")),
                    }
                };
                Cut::Regex {
                    regex: Box::new(regex),
                    offset,
                    skip: delimiter == b'%',
                }
            }
            _ => {
                let value = decimal(text).filter(|&(negative, _)| !negative);
                let Some(value) = value.and_then(|(_, value)| u64::try_from(value).ok()) else {
                    return Err(says(text, "invalid pattern"));
                };
                if value == 0 {
                    let zero = b": line number must be greater than zero";
                    return Err([b"csplit: ", text.as_slice(), zero].concat());
                }
                if value < last {
                    return Err(format!(
                        "csplit: line number '{}' is smaller than preceding line number, {last}",
                        quoted(text)
                    )
                    .into_bytes());
                }
                if value == last {
                    warnings.extend_from_slice(
                        format!(
                            "csplit: warning: line number '{}' is the same as preceding line number\n",
                            quoted(text)
                        )
                        .as_bytes(),
                    );
                }
                last = value;
                Cut::Line(value)
            }
        };
        patterns.push(Pattern {
            text: text.clone(),
            cut,
            repeat: 0,
        });
    }
    Ok(patterns)
}

/// The lines of the input: those read ahead whole, then the stream.
struct Lines {
    input: Input,
    ahead: VecDeque<Vec<u8>>,
    /// The lines taken from the stream, those read ahead among them.
    taken: u64,
    /// A line partly copied, its end not come yet.
    partial: bool,
    line: Vec<u8>,
}

/// Where a line goes.
enum To<'a> {
    Piece(&'a mut Current),
    Nowhere,
}

/// The piece being cut: a file named by its first byte, or none for `%`.
#[derive(Default)]
struct Current {
    skip: bool,
    piece: Option<Piece>,
    size: u64,
}

/// What a line needs that it cannot have: more input, or more memory.
enum Short {
    Pending,
    Memory,
}

impl Lines {
    /// The index of the next line.
    fn next(&self) -> u64 {
        self.taken - self.ahead.len() as u64
    }

    /// Copy the next line into `into`, streaming it; false at the end.
    fn copy(&mut self, into: To, run: &mut Run) -> Poll<bool> {
        if let Some(line) = self.ahead.pop_front() {
            run.put(into, &line);
            return Poll::Ready(true);
        }
        let rest = self.input.rest();
        if rest.is_empty() {
            if !self.input.ended {
                self.input.pull(&mut run.io);
                return Poll::Pending;
            }
            if std::mem::take(&mut self.partial) {
                self.taken += 1;
                return Poll::Ready(true);
            }
            return Poll::Ready(false);
        }
        let (end, whole) = match memchr::memchr(b'\n', rest) {
            Some(at) => (at + 1, true),
            None => (rest.len(), false),
        };
        run.put(into, &rest[..end]);
        self.input.at += end;
        if whole {
            self.partial = false;
            self.taken += 1;
            return Poll::Ready(true);
        }
        self.partial = true;
        Poll::Pending
    }

    /// The next line from the stream, whole.
    fn fetch(&mut self, io: &mut Io) -> Result<Option<Vec<u8>>, Short> {
        loop {
            let rest = self.input.rest();
            if rest.is_empty() {
                if !self.input.ended {
                    self.input.pull(io);
                    return Err(Short::Pending);
                }
                if self.line.is_empty() {
                    return Ok(None);
                }
                self.taken += 1;
                return Ok(Some(std::mem::take(&mut self.line)));
            }
            let (end, whole) = match memchr::memchr(b'\n', rest) {
                Some(at) => (at + 1, true),
                None => (rest.len(), false),
            };
            if self.line.len() + end > MAX_LEN {
                return Err(Short::Memory);
            }
            self.line.extend_from_slice(&rest[..end]);
            self.input.at += end;
            if whole {
                self.taken += 1;
                return Ok(Some(std::mem::take(&mut self.line)));
            }
        }
    }

    /// The next line whole: one read ahead, or the stream's.
    fn whole(&mut self, io: &mut Io) -> Result<Option<Vec<u8>>, Short> {
        match self.ahead.pop_front() {
            Some(line) => Ok(Some(line)),
            None => self.fetch(io),
        }
    }

    /// Whether line `index` exists: the lines before it read ahead, then
    /// a byte of it looked for, so the line itself still streams.
    fn exists(&mut self, index: u64, io: &mut Io) -> Result<bool, Short> {
        while self.taken < index {
            match self.fetch(io)? {
                Some(line) => self.ahead.push_back(line),
                None => return Ok(false),
            }
        }
        if self.taken > index || !self.input.rest().is_empty() {
            return Ok(true);
        }
        if self.input.ended {
            return Ok(false);
        }
        self.input.pull(io);
        Err(Short::Pending)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Open,
    /// The next pattern, or its next repetition.
    Next,
    /// A line number's piece: lines up to `to`.
    Line {
        to: u64,
    },
    /// After a line number's cut: line `seen` must follow.
    Check,
    Search,
    /// A positive offset's lines after the match.
    Tail {
        left: u64,
    },
    /// The end of a pattern: under --suppress-matched the line at the cut
    /// goes.
    After,
    Rest,
    /// The run stops: its failure is reported once every request it made
    /// is answered, then the pieces it wrote are removed.
    Failing,
    Done,
}

/// What a run holds besides its lines, so a line can be copied into the
/// piece.
struct Run {
    io: Io,
    format: Format,
    prefix: Vec<u8>,
    elide: bool,
    named: usize,
}

impl Run {
    /// The next piece's file: its number counts the files written.
    fn name(&mut self) -> Piece {
        let name = [self.prefix.as_slice(), &self.format.render(self.named)].concat();
        self.named += 1;
        Piece::new(name)
    }

    fn put(&mut self, into: To, data: &[u8]) {
        let To::Piece(current) = into else {
            return;
        };
        if current.skip || data.is_empty() {
            return;
        }
        current.size += data.len() as u64;
        if current.piece.is_none() {
            current.piece = Some(self.name());
        }
        if let Some(piece) = &mut current.piece {
            piece.put(data, &mut self.io);
        }
    }
}

struct Csplit {
    run: Run,
    lines: Lines,
    texts: Vec<Vec<u8>>,
    patterns: Vec<Pattern>,
    utf8: bool,
    keep: bool,
    silent: bool,
    suppress: bool,
    pattern: usize,
    repetition: u64,
    head: u64,
    seen: u64,
    /// Under a negative offset, the lines read since the last that is
    /// surely the piece's, and the bytes they hold.
    window: VecDeque<Vec<u8>>,
    looked_back: usize,
    current: Current,
    state: State,
    /// The piece a flush commits, and its size.
    closing: Option<(Vec<u8>, u64)>,
    created: Vec<Vec<u8>>,
    failure: Option<Vec<u8>>,
    failed: bool,
    asked: bool,
    stderr: Vec<u8>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    // getopt reads -n, a decimal from 0 to INT_MAX, before any operand.
    let digits = match config.digits.as_deref().map(|raw| (raw, decimal(raw))) {
        None => 2,
        Some((_, Some((negative, n)))) if (!negative || n == 0) && n <= i32::MAX as u128 => {
            n as usize
        }
        Some((raw, scanned)) => {
            let reason = scanned.map_or("", |_| ": Value too large for defined data type");
            let refused = format!("csplit: invalid number: '{}'{reason}", quoted(raw));
            return Ok(Box::new(Refused::new(refused.into_bytes())));
        }
    };
    if config.operands.len() < 2 {
        return Ok(Box::new(Refused::new(missing(config.operands.first()))));
    }
    let format = match &config.suffix_format {
        Some(raw) => Format::parse(raw),
        None => Ok(Format {
            flags: b"0".to_vec(),
            width: digits,
            conversion: b'd',
            ..Format::default()
        }),
    };
    let format = match format {
        Ok(format) if format.width.max(format.precision.unwrap_or(0)) > MAX_SUFFIX => {
            return Ok(Box::new(Refused::new(b"csplit: memory exhausted".to_vec())));
        }
        Ok(format) => format,
        Err(refused) => return Ok(Box::new(Refused::new(refused))),
    };
    let mut operands = config.operands.into_iter();
    let file = operands.next().unwrap_or_default();
    let mut io = Io::default();
    let input = Input::new(&mut io, file, Opening::Operand(1));
    let texts = operands.collect();
    Ok(Box::new(Csplit {
        run: Run {
            io,
            format,
            prefix: config.prefix,
            elide: config.elide,
            named: 0,
        },
        lines: Lines {
            input,
            ahead: VecDeque::new(),
            taken: 0,
            partial: false,
            line: Vec::new(),
        },
        texts,
        patterns: Vec::new(),
        utf8: config.utf8,
        keep: config.keep,
        silent: config.silent,
        suppress: config.suppress,
        pattern: 0,
        repetition: 0,
        head: 0,
        seen: 0,
        window: VecDeque::new(),
        looked_back: 0,
        current: Current::default(),
        state: State::Open,
        closing: None,
        created: Vec::new(),
        failure: None,
        failed: false,
        asked: false,
        stderr: Vec::new(),
    }))
}

fn missing(last: Option<&Vec<u8>>) -> Vec<u8> {
    let after = last.map(|last| [b" after '", last.as_slice(), b"'"].concat());
    let hint = b"\nTry 'csplit --help' for more information.";
    [
        b"csplit: missing operand",
        after.unwrap_or_default().as_slice(),
        hint,
    ]
    .concat()
}

fn content(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\n").unwrap_or(line)
}

impl Csplit {
    fn text(&self) -> &[u8] {
        &self.patterns[self.pattern].text
    }

    /// The pattern's failure, naming the repetition past the first when
    /// `counted`: a regex's offset landing outside the input names none.
    fn says(&self, what: &str, counted: bool) -> Vec<u8> {
        let mut message = says(self.text(), what);
        if self.repetition > 0 && counted {
            message.extend_from_slice(format!(" on repetition {}", self.repetition).as_bytes());
        }
        message.push(b'\n');
        message
    }

    fn fail(&mut self, message: Vec<u8>) {
        self.failure = Some(message);
        self.state = State::Failing;
    }

    fn begin(&mut self, skip: bool) {
        self.current = Current {
            skip,
            ..Current::default()
        };
    }

    /// Commit the piece, unless `%` cut it or -z drops it empty.
    fn close(&mut self) {
        let current = std::mem::take(&mut self.current);
        if current.skip || (current.size == 0 && self.run.elide) {
            return;
        }
        let piece = current.piece.unwrap_or_else(|| self.run.name());
        self.closing = Some((piece.name.clone(), current.size));
        piece.close(&mut self.run.io);
    }

    fn short(&mut self, short: Short) {
        if let Short::Memory = short {
            self.settle();
            self.fail(b"csplit: memory exhausted\n".to_vec());
        }
    }

    /// Commit the piece a failing run was writing, so the cleanup that
    /// follows finds it whole, or keeps it under -k.
    fn settle(&mut self) {
        if self.current.piece.is_some() {
            self.close();
        }
    }

    fn advance(&mut self) {
        self.repetition += 1;
        if self.repetition > self.patterns[self.pattern].repeat {
            self.pattern += 1;
            self.repetition = 0;
        }
        self.state = State::Next;
    }

    fn step(&mut self) {
        match self.state {
            State::Open => self.open(),
            State::Next => self.next(),
            State::Line { to } => {
                if self.lines.next() >= to {
                    self.close();
                    self.head = to;
                    self.seen = self.seen.max(to);
                    self.state = if self.suppress {
                        State::After
                    } else {
                        State::Check
                    };
                    return;
                }
                if let Poll::Ready(false) =
                    self.lines.copy(To::Piece(&mut self.current), &mut self.run)
                {
                    self.close();
                    let message = self.says("line number out of range", true);
                    self.fail(message);
                }
            }
            State::Check => match self.lines.exists(self.seen, &mut self.run.io) {
                Ok(true) => self.state = State::After,
                Ok(false) => {
                    let message = self.says("line number out of range", true);
                    self.fail(message);
                }
                Err(short) => self.short(short),
            },
            State::Search => self.search(),
            State::Tail { left: 0 } => {
                self.close();
                self.head = self.lines.next();
                self.seen = self.head + 1;
                self.state = State::After;
            }
            State::Tail { left } => {
                match self.lines.copy(To::Piece(&mut self.current), &mut self.run) {
                    Poll::Ready(true) => self.state = State::Tail { left: left - 1 },
                    Poll::Ready(false) => {
                        self.close();
                        let message = self.says("line number out of range", false);
                        self.fail(message);
                    }
                    Poll::Pending => {}
                }
            }
            State::After => {
                if !self.suppress {
                    self.advance();
                    return;
                }
                match self.lines.copy(To::Nowhere, &mut self.run) {
                    Poll::Ready(true) => {
                        self.head += 1;
                        self.seen = self.seen.max(self.head);
                        self.advance();
                    }
                    Poll::Ready(false) => self.advance(),
                    Poll::Pending => {}
                }
            }
            State::Rest => {
                if let Poll::Ready(false) =
                    self.lines.copy(To::Piece(&mut self.current), &mut self.run)
                {
                    self.close();
                    self.state = State::Done;
                }
            }
            State::Failing => {
                self.failed = true;
                if let Some(failure) = self.failure.take() {
                    self.stderr.extend_from_slice(&failure);
                }
                if !self.keep {
                    for path in std::mem::take(&mut self.created) {
                        self.run.io.push(Request::Unlink { path });
                    }
                }
                self.state = State::Done;
            }
            State::Done => {}
        }
    }

    /// The input opens before the patterns parse, so a missing file is
    /// reported first.
    fn open(&mut self) {
        if !std::mem::replace(&mut self.asked, true) {
            self.lines.input.pull(&mut self.run.io);
            return;
        }
        let mut warnings = Vec::new();
        let parsed = patterns(&self.texts, self.utf8, &mut warnings);
        self.stderr.extend_from_slice(&warnings);
        match parsed {
            Ok(patterns) => {
                self.patterns = patterns;
                self.state = State::Next;
            }
            Err(mut refused) => {
                refused.push(b'\n');
                self.fail(refused);
            }
        }
    }

    fn next(&mut self) {
        let Some(pattern) = self.patterns.get(self.pattern) else {
            self.begin(false);
            self.state = State::Rest;
            return;
        };
        match &pattern.cut {
            &Cut::Line(number) => {
                if self.suppress {
                    match self.lines.exists(self.seen, &mut self.run.io) {
                        Ok(true) => {}
                        Ok(false) => {
                            self.begin(false);
                            self.close();
                            let message = self.says("line number out of range", true);
                            self.fail(message);
                            return;
                        }
                        Err(short) => return self.short(short),
                    }
                }
                let target = number.saturating_mul(self.repetition.saturating_add(1));
                self.begin(false);
                self.state = State::Line {
                    to: self.head.max(target - 1),
                };
            }
            Cut::Regex { skip, .. } => {
                let skip = *skip;
                self.begin(skip);
                self.window.clear();
                self.looked_back = 0;
                self.state = State::Search;
            }
        }
    }

    fn search(&mut self) {
        let Cut::Regex { offset, .. } = self.patterns[self.pattern].cut else {
            return;
        };
        let index = self.lines.next();
        if index < self.seen && offset >= 0 {
            if let Poll::Ready(false) = self.lines.copy(To::Piece(&mut self.current), &mut self.run)
            {
                self.not_found();
            }
            return;
        }
        let line = match self.lines.whole(&mut self.run.io) {
            Ok(Some(line)) => line,
            Ok(None) => return self.not_found(),
            Err(short) => return self.short(short),
        };
        let Cut::Regex { regex, .. } = &mut self.patterns[self.pattern].cut else {
            return;
        };
        if index < self.seen || !regex.test(content(&line)) {
            if offset >= 0 {
                self.run.put(To::Piece(&mut self.current), &line);
                return;
            }
            self.looked_back += line.len();
            self.window.push_back(line);
            if self.window.len() as u64 > offset.unsigned_abs() {
                if let Some(old) = self.window.pop_front() {
                    self.looked_back -= old.len();
                    self.run.put(To::Piece(&mut self.current), &old);
                }
            }
            if self.looked_back > MAX_LEN {
                self.short(Short::Memory);
            }
            return;
        }
        if offset > 0 {
            self.run.put(To::Piece(&mut self.current), &line);
            self.state = State::Tail {
                left: offset.unsigned_abs() - 1,
            };
            return;
        }
        let cut = i128::from(index) + i128::from(offset);
        if cut < i128::from(self.head) {
            self.close();
            let message = self.says("line number out of range", false);
            return self.fail(message);
        }
        self.close();
        self.lines.ahead.push_front(line);
        while let Some(back) = self.window.pop_back() {
            self.lines.ahead.push_front(back);
        }
        self.head = u64::try_from(cut).unwrap_or_default();
        self.seen = index + 1;
        self.state = State::After;
    }

    /// No line matched: the piece takes the rest, which ends `{*}` and
    /// fails any other.
    fn not_found(&mut self) {
        while let Some(line) = self.window.pop_front() {
            self.run.put(To::Piece(&mut self.current), &line);
        }
        self.close();
        if self.patterns[self.pattern].repeat == u64::MAX {
            self.state = State::Done;
        } else {
            let message = self.says("match not found", true);
            self.fail(message);
        }
    }

    fn answer(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let reply = Reply::decode(reply).map_err(StreamError::new)?;
        let Some(request) = self.run.io.in_flight.take() else {
            return Err(StreamError::new("no request is waiting"));
        };
        if let Some(fatal) = &reply.fatal {
            self.run.io.requests.clear();
            self.fail([b"csplit: ", bytes(fatal).as_slice(), b"\n"].concat());
            return Ok(());
        }
        if let Request::Read { .. } = request {
            if let Some(failed) = self.lines.input.answer(reply, data) {
                self.run.io.requests.clear();
                self.settle();
                let line = read_failure(b"csplit", b"-", &failed);
                self.fail(line);
            }
            return Ok(());
        }
        if let Some(line) = write_failure(b"csplit", &request, &reply) {
            if let Request::Unlink { .. } = request {
                self.stderr.extend_from_slice(&line);
            } else {
                self.run.io.requests.clear();
                self.closing = None;
                self.fail(line);
            }
            return Ok(());
        }
        match &request {
            // A piece is the run's to remove once its file exists.
            Request::Write {
                path,
                mode: WriteMode::Create,
                ..
            } => self.created.push(path.clone()),
            Request::Flush { path: Some(path) } => {
                let closed = self.closing.take_if(|(name, _)| name == path);
                if let Some((_, size)) = closed.filter(|_| !self.silent) {
                    out.extend_from_slice(format!("{size}\n").as_bytes());
                }
            }
            _ => {}
        }
        Ok(())
    }
}

impl Stream for Csplit {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("csplit reads its input through requests"))
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn busy(&self) -> bool {
        self.run.io.idle() && self.state != State::Done
    }

    fn drain(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        for _ in 0..STEPS {
            if !self.busy() {
                break;
            }
            self.step();
        }
        Ok(())
    }

    /// Output closed early: the run goes on to its end, its sizes unread,
    /// so a failure still reports and removes its pieces.
    fn cancel(&mut self) -> bool {
        true
    }

    fn status(&self) -> i32 {
        i32::from(self.failed)
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }

    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        self.run.io.take(data)
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.answer(reply, data, out)
    }
}
