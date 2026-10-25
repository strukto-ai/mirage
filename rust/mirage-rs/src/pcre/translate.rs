//! A PCRE2 pattern re-emitted for fancy-regex: one scan that refuses what
//! PCRE2 refuses, in its words and at its offsets, and emits what it
//! accepts without leaning on any shorthand whose meaning differs. `\d \w
//! \s \h \v` and the POSIX classes are explicit sets (ASCII for grep, which
//! runs PCRE2 without UCP; Unicode for rg, which sets it), and case folding
//! is applied to each literal and class, by Unicode over UTF-8 and by ASCII
//! over bytes.
// Compile error texts from PCRE2 10.43 and 10.46 (BSD-3-Clause WITH
// PCRE2-exception; see licenses/third_party/pcre2.txt).

use super::charset::{
    self, ASCII_DIGIT, ASCII_SPACE, ASCII_WORD, CharSet, NEWLINE_SEQUENCE, PCRE_HSPACE, PCRE_VSPACE,
};

const MISSING_PAREN: &str = "missing closing parenthesis";
const UNMATCHED_PAREN: &str = "unmatched closing parenthesis";
const MISSING_BRACKET: &str = "missing terminating ] for character class";
const TRAILING_BACKSLASH: &str = "\\ at end of pattern";
const TRAILING_C: &str = "\\c at end of pattern";
const NOTHING_TO_REPEAT: &str = "quantifier does not follow a repeatable item";
const QUANTIFIER_ORDER: &str = "numbers out of order in {} quantifier";
const QUANTIFIER_BIG: &str = "number too big in {} quantifier";
const LOOKBEHIND_UNLIMITED: &str = "length of lookbehind assertion is not limited";
const LOOKBEHIND_LONG: &str = "branch too long in variable-length lookbehind assertion";
/// PCRE2's default limit on a variable-length lookbehind's branches.
const LOOKBEHIND_MAX: usize = 255;
const SURROGATE: &str = "disallowed Unicode code point (>= 0xd800 && <= 0xdfff)";
const UNKNOWN_PROPERTY: &str = "unknown property after \\P or \\p";
const MALFORMED_PROPERTY: &str = "malformed \\P or \\p sequence";
const N_IN_CLASS: &str = "\\N is not supported in a class";
const NO_SUBPATTERN: &str = "reference to non-existent subpattern";
const BAD_GROUP_SYNTAX: &str = "unrecognized character after (? or (?-";
const CODE_POINT_BIG: &str = "character code point value in \\x{} or \\o{} is too large";
const RANGE_BAD: &str = "invalid range in character class";
const RANGE_ORDER: &str = "range out of order in character class";
const POSIX_UNKNOWN: &str = "unknown POSIX class name";
const HEX_BAD: &str = "non-hex character in \\x{} (closing brace missing?)";
const OCTAL_BAD: &str = "non-octal character in \\o{} (closing brace missing?)";
const DIGITS_MISSING: &str = "digits missing after \\x or in \\x{} or \\o{} or \\N{U+}";
const ESCAPE_UNKNOWN: &str = "unrecognized character follows \\";
const NAME_EXPECTED: &str = "subpattern name expected";
const NAME_UNTERMINATED: &str = "syntax error in subpattern name (missing terminator?)";
const NAME_DIGIT: &str = "subpattern name must start with a non-digit";
const NAME_DUPLICATE: &str = "two named subpatterns have the same name (PCRE2_DUPNAMES not set)";
const COMMENT_UNTERMINATED: &str = "missing ) after (?# comment";
const KEEP_IN_LOOKAROUND: &str =
    "\\K is not allowed in lookarounds (but see PCRE2_EXTRA_ALLOW_LOOKAROUND_BSK)";
const NAMED_CHAR_UTF: &str = "\\N{U+dddd} is supported only in Unicode (UTF) mode";
const CASE_ESCAPES: &str = "PCRE2 does not support \\F, \\L, \\l, \\N{name}, \\U, or \\u";
const ESCAPE_IN_CLASS: &str = "escape sequence is invalid in character class";
const G_SYNTAX: &str =
    "\\g is not followed by a braced, angle-bracketed, or quoted name/number or by a plain number";
const K_SYNTAX: &str = "\\k is not followed by a braced, angle-bracketed, or quoted name";

const FLAG_LETTERS: &str = "imnsxJU";

/// A pattern PCRE2 (or mirage's reading of it) refuses: PCRE2's text and
/// where in the pattern, in characters, it reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PcreError {
    pub(crate) message: String,
    pub(crate) offset: usize,
}

fn unsupported(what: &str) -> String {
    format!("{what} is not supported in mirage")
}

/// How the pattern is read and what it is matched against.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Mode {
    /// UTF with UCP (ripgrep's default): Unicode classes and folding.
    pub(crate) unicode: bool,
    /// The subject is bytes, each one a character (PCRE2 without UTF).
    pub(crate) bytes: bool,
    pub(crate) ignore_case: bool,
    pub(crate) multi_line: bool,
    pub(crate) dotall: bool,
    /// PCRE2_NEWLINE_ANYCRLF: `\r` ends a line too, for the anchors and
    /// for `.`.
    pub(crate) crlf: bool,
    /// grep's -x: the match spans the whole record, outside the pattern
    /// PCRE2 reads (so a refusal's offset does not count it).
    pub(crate) whole_line: bool,
}

/// The fancy-regex source, whether the whole pattern folds case, and an
/// extended POSIX expression every match of it also matches (assertions
/// dropped, back-references and sets widened to any character), for
/// finding the literals each match holds.
pub(crate) struct Translated {
    pub(crate) source: String,
    pub(crate) fold: bool,
    pub(crate) regular: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Flags {
    i: bool,
    m: bool,
    n: bool,
    s: bool,
    x: bool,
    xx: bool,
    u: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Group,
    Ahead,
    Behind,
    Atomic,
}

type Width = (usize, Option<usize>);

fn add_width(a: Width, b: Width) -> Width {
    let high = match (a.1, b.1) {
        (Some(x), Some(y)) => Some(x.saturating_add(y)),
        _ => None,
    };
    (a.0.saturating_add(b.0), high)
}

struct Frame {
    open_at: usize,
    out_start: usize,
    flags: Flags,
    kind: Kind,
    negative: bool,
    branches: Vec<usize>,
    widths: Vec<Width>,
    low: usize,
    high: Option<usize>,
}

impl Frame {
    fn new(open_at: usize, out_start: usize, flags: Flags, kind: Kind, negative: bool) -> Self {
        Self {
            open_at,
            out_start,
            flags,
            kind,
            negative,
            branches: Vec::new(),
            widths: Vec::new(),
            low: 0,
            high: Some(0),
        }
    }
}

/// One emitted item: its fancy-regex text and its regular approximation.
#[derive(Clone, Default)]
struct Piece {
    text: String,
    regular: String,
}

impl Piece {
    fn new(text: impl Into<String>, regular: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            regular: regular.into(),
        }
    }

    fn same(text: impl Into<String>) -> Self {
        let text = text.into();
        Self {
            regular: text.clone(),
            text,
        }
    }

    fn assertion(text: impl Into<String>) -> Self {
        Self::new(text, "")
    }
}

fn join(pieces: &[Piece]) -> Piece {
    let mut out = Piece::default();
    for piece in pieces {
        out.text.push_str(&piece.text);
        out.regular.push_str(&piece.regular);
    }
    out
}

struct Translator {
    src: Vec<char>,
    mode: Mode,
    pos: usize,
    flags: Flags,
    out: Vec<Piece>,
    atom_start: Option<usize>,
    atom_width: Width,
    repeatable: bool,
    quantified: bool,
    look: bool,
    stack: Vec<Frame>,
    total_groups: usize,
    groups: usize,
    names: Vec<String>,
    all_names: Vec<String>,
    backrefs: Vec<(usize, usize)>,
    /// The whole pattern folds outside the translation: sets still fold
    /// before they are negated, literals stay as written.
    folded: bool,
}

fn is_digit(ch: char) -> bool {
    ch.is_ascii_digit()
}

fn is_name_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_name_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn first_outside(text: &[char], allowed: &str) -> usize {
    text.iter()
        .position(|ch| !allowed.contains(*ch))
        .unwrap_or(text.len())
}

const HEX: &str = "0123456789abcdefABCDEF";

fn parse_number(digits: &[char], radix: u32) -> u64 {
    digits.iter().fold(0u64, |acc, ch| {
        acc.saturating_mul(u64::from(radix))
            .saturating_add(u64::from(ch.to_digit(radix).unwrap_or(0)))
    })
}

impl Translator {
    fn new(src: Vec<char>, mode: Mode, flags: Flags) -> Self {
        let total_groups = count_groups(&src);
        let all_names = named_groups(&src);
        Self {
            src,
            mode,
            pos: 0,
            flags,
            out: Vec::new(),
            atom_start: None,
            atom_width: (0, Some(0)),
            repeatable: false,
            quantified: false,
            look: false,
            stack: vec![Frame::new(0, 0, flags, Kind::Group, false)],
            total_groups,
            groups: 0,
            names: Vec::new(),
            all_names,
            backrefs: Vec::new(),
            folded: false,
        }
    }

    fn fail(&self, message: impl Into<String>, offset: Option<usize>) -> PcreError {
        PcreError {
            message: message.into(),
            offset: offset.unwrap_or(self.pos),
        }
    }

    fn peek(&self, ahead: usize) -> Option<char> {
        self.src.get(self.pos + ahead).copied()
    }

    fn starts_with(&self, at: usize, text: &str) -> bool {
        let mut rest = self.src.get(at..).unwrap_or_default().iter();
        text.chars().all(|ch| rest.next() == Some(&ch))
    }

    fn find(&self, from: usize, text: &str) -> Option<usize> {
        let len = text.chars().count();
        (from..self.src.len()).find(|&i| i + len <= self.src.len() && self.starts_with(i, text))
    }

    fn slice(&self, from: usize, to: usize) -> String {
        self.src[from.min(self.src.len())..to.min(self.src.len())]
            .iter()
            .collect()
    }

    fn translate(mut self) -> Result<Translated, PcreError> {
        loop {
            self.skip_space();
            if self.pos >= self.src.len() {
                break;
            }
            self.step()?;
        }
        if self.stack.len() > 1 {
            return Err(self.fail(MISSING_PAREN, Some(self.src.len())));
        }
        for &(number, offset) in &self.backrefs {
            if number == 0 || number > self.groups {
                return Err(self.fail(NO_SUBPATTERN, Some(offset)));
            }
        }
        let joined = join(&self.out);
        Ok(Translated {
            source: joined.text,
            fold: false,
            regular: joined.regular,
        })
    }

    fn skip_space(&mut self) {
        while self.flags.x && self.pos < self.src.len() {
            let ch = self.src[self.pos];
            if " \t\n\r\x0c\x0b".contains(ch) {
                self.pos += 1;
            } else if ch == '#' {
                self.pos = self
                    .find(self.pos, "\n")
                    .map_or(self.src.len(), |end| end + 1);
            } else {
                return;
            }
        }
    }

    fn step(&mut self) -> Result<(), PcreError> {
        let ch = self.src[self.pos];
        match ch {
            '(' => self.open_group(),
            ')' => self.close_group(),
            '|' => {
                self.pos += 1;
                self.alternate();
                Ok(())
            }
            '[' if self.starts_with(self.pos, "[[:<:]]")
                || self.starts_with(self.pos, "[[:>:]]") =>
            {
                let start = self.src[self.pos + 3] == '<';
                self.pos += 7;
                let edge = self.word_edge(start);
                self.assertion(edge);
                Ok(())
            }
            '[' => {
                let cs = self.parse_class()?;
                let piece = self.class_piece(&cs);
                self.atom(piece, (1, Some(1)));
                Ok(())
            }
            '*' | '+' | '?' => self.quantifier(ch),
            '{' if self.interval_at(self.pos)?.is_some() => self.quantifier(ch),
            '\\' => self.escape(),
            '.' => {
                self.pos += 1;
                let ends = if self.mode.crlf {
                    CharSet::chars(&[0x0A, 0x0D])
                } else {
                    CharSet::chars(&[0x0A])
                };
                let cs = if self.flags.s {
                    charset::all()
                } else {
                    charset::all().minus(&ends)
                };
                let piece = self.class_piece(&cs);
                self.atom(piece, (1, Some(1)));
                Ok(())
            }
            '^' => {
                self.pos += 1;
                let text = if self.flags.m {
                    line_start(true, self.mode.crlf)
                } else {
                    "^".to_string()
                };
                self.assertion(text);
                Ok(())
            }
            '$' => {
                self.pos += 1;
                let text = if self.flags.m {
                    line_end(true, self.mode.crlf)
                } else if self.mode.crlf {
                    "(?=(?:\\r\\n?|\\n)?\\z)".to_string()
                } else {
                    "(?=\\n?\\z)".to_string()
                };
                self.assertion(text);
                Ok(())
            }
            _ => {
                self.pos += 1;
                self.literal(u32::from(ch));
                Ok(())
            }
        }
    }

    fn atom(&mut self, piece: Piece, width: Width) {
        self.atom_start = Some(self.out.len());
        self.out.push(piece);
        self.atom_width = width;
        self.repeatable = true;
        self.quantified = false;
        self.look = false;
        let frame = self.stack.last_mut().expect("the outermost frame");
        (frame.low, frame.high) = add_width((frame.low, frame.high), width);
    }

    fn assertion(&mut self, text: String) {
        self.out.push(Piece::assertion(text));
        self.atom_start = None;
        self.repeatable = false;
    }

    fn literal(&mut self, cp: u32) {
        if self.flags.i && !self.folded {
            let folded = charset::fold(&CharSet::chars(&[cp]), self.mode.bytes);
            if folded.single().is_none() {
                let piece = self.class_piece(&folded);
                self.atom(piece, (1, Some(1)));
                return;
            }
        }
        let piece = Piece::new(self.char_text(cp), ere_char(cp));
        self.atom(piece, (1, Some(1)));
    }

    fn set_atom(&mut self, cs: &CharSet) {
        let folded = self.caseless(cs);
        let piece = self.class_piece(&folded);
        self.atom(piece, (1, Some(1)));
    }

    /// A set folded when `i` is in force: by Unicode over UTF-8, by
    /// ASCII over bytes.
    fn caseless(&self, cs: &CharSet) -> CharSet {
        if self.flags.i {
            charset::fold(cs, self.mode.bytes)
        } else {
            cs.clone()
        }
    }

    fn alternate(&mut self) {
        let frame = self.stack.last_mut().expect("the outermost frame");
        frame.widths.push((frame.low, frame.high));
        (frame.low, frame.high) = (0, Some(0));
        self.out.push(Piece::same("|"));
        let len = self.out.len();
        self.stack
            .last_mut()
            .expect("the outermost frame")
            .branches
            .push(len);
        self.atom_start = None;
        self.repeatable = false;
    }

    fn open_group(&mut self) -> Result<(), PcreError> {
        let start = self.pos;
        if self.starts_with(start, "(*") {
            return self.verb(start);
        }
        self.pos += 1;
        if self.peek(0) != Some('?') {
            if self.flags.n {
                self.push(start, Piece::new("(?:", "("), Kind::Group, false);
            } else {
                self.capture(start, None)?;
            }
            return Ok(());
        }
        self.pos += 1;
        let Some(ch) = self.peek(0) else {
            return Err(self.fail(MISSING_PAREN, Some(self.src.len())));
        };
        let next = self.peek(1);
        if ch == '<' && matches!(next, Some('=') | Some('!')) {
            self.pos += 2;
            let negative = next == Some('!');
            let opener = if negative { "(?<!" } else { "(?<=" };
            self.push(start, Piece::new(opener, ""), Kind::Behind, negative);
            return Ok(());
        }
        if ch == '=' || ch == '!' {
            self.pos += 1;
            let opener = if ch == '!' { "(?!" } else { "(?=" };
            self.push(start, Piece::new(opener, ""), Kind::Ahead, ch == '!');
            return Ok(());
        }
        if ch == '<' || ch == '\'' || (ch == 'P' && next == Some('<')) {
            self.pos += if ch == 'P' { 2 } else { 1 };
            let name = self.group_name(if ch == '\'' { '\'' } else { '>' })?;
            self.capture(start, Some(name))?;
            return Ok(());
        }
        match ch {
            ':' => {
                self.pos += 1;
                self.push(start, Piece::new("(?:", "("), Kind::Group, false);
                return Ok(());
            }
            '>' => {
                self.pos += 1;
                self.push(start, Piece::new("(?>", "("), Kind::Atomic, false);
                return Ok(());
            }
            '#' => {
                let Some(close) = self.find(self.pos, ")") else {
                    return Err(self.fail(COMMENT_UNTERMINATED, Some(self.src.len())));
                };
                self.pos = close + 1;
                return Ok(());
            }
            'C' => {
                let Some(close) = self.find(self.pos, ")") else {
                    return Err(self.fail(MISSING_PAREN, Some(self.src.len())));
                };
                self.pos = close + 1;
                return Ok(());
            }
            _ => {}
        }
        if ch == 'P' && matches!(next, Some('=') | Some('>')) {
            if next == Some('>') {
                return Err(self.fail(unsupported("(?P>name) recursion"), Some(start)));
            }
            self.pos += 2;
            let Some(close) = self.find(self.pos, ")") else {
                return Err(self.fail(NAME_UNTERMINATED, Some(self.src.len())));
            };
            let name = self.slice(self.pos, close);
            let at = self.pos;
            self.pos = close + 1;
            return self.named_backref(&name, at);
        }
        if ch == '|' {
            return Err(self.fail(unsupported("(?| branch reset"), Some(start)));
        }
        if ch == '(' {
            return Err(self.fail(unsupported("(?( conditional group"), Some(start)));
        }
        if "R&+".contains(ch) || is_digit(ch) || (ch == '-' && next.is_some_and(is_digit)) {
            return Err(self.fail(unsupported("recursion"), Some(start)));
        }
        if ch == '*' {
            return Err(self.fail(unsupported("(?* non-atomic lookaround"), Some(start)));
        }
        self.inline_flags(start)
    }

    fn verb(&mut self, start: usize) -> Result<(), PcreError> {
        let Some(close) = self.find(start, ")") else {
            return Err(self.fail(MISSING_PAREN, Some(self.src.len())));
        };
        let name = self.slice(start + 2, close);
        if (start == 0 || self.out.is_empty())
            && [
                "UTF",
                "UTF8",
                "UCP",
                "NO_JIT",
                "NO_START_OPT",
                "NO_AUTO_POSSESS",
                "NO_DOTSTAR_ANCHOR",
            ]
            .contains(&name.as_str())
        {
            self.pos = close + 1;
            return Ok(());
        }
        Err(self.fail(unsupported(&format!("(*{name})")), Some(start)))
    }

    fn capture(&mut self, start: usize, name: Option<String>) -> Result<(), PcreError> {
        self.groups += 1;
        let opener = match name {
            Some(name) => {
                if self.names.contains(&name) {
                    return Err(self.fail(NAME_DUPLICATE, None));
                }
                let opener = format!("(?<{name}>");
                self.names.push(name);
                opener
            }
            None => "(".to_string(),
        };
        self.push(start, Piece::new(opener, "("), Kind::Group, false);
        Ok(())
    }

    fn group_name(&mut self, terminator: char) -> Result<String, PcreError> {
        let begin = self.pos;
        match self.peek(0) {
            None => return Err(self.fail(NAME_EXPECTED, None)),
            Some(ch) if ch == terminator => return Err(self.fail(NAME_EXPECTED, None)),
            Some(ch) if is_digit(ch) => return Err(self.fail(NAME_DIGIT, None)),
            Some(ch) if !is_name_start(ch) => return Err(self.fail(NAME_EXPECTED, None)),
            _ => {}
        }
        while self.peek(0).is_some_and(is_name_char) {
            self.pos += 1;
        }
        let end = self.pos;
        if self.peek(0) != Some(terminator) {
            return Err(self.fail(NAME_UNTERMINATED, None));
        }
        self.pos += 1;
        Ok(self.slice(begin, end))
    }

    fn push(&mut self, start: usize, opener: Piece, kind: Kind, negative: bool) {
        let mut frame = Frame::new(start, self.out.len(), self.flags, kind, negative);
        self.out.push(opener);
        frame.branches.push(self.out.len());
        self.stack.push(frame);
        self.atom_start = None;
        self.repeatable = false;
    }

    fn inline_flags(&mut self, start: usize) -> Result<(), PcreError> {
        let mut flags = self.flags;
        let mut on = true;
        if self.peek(0) == Some('^') {
            flags = Flags {
                u: flags.u,
                ..Flags::default()
            };
            self.pos += 1;
        }
        let end = loop {
            if self.pos >= self.src.len() {
                return Err(self.fail(MISSING_PAREN, Some(self.src.len())));
            }
            let ch = self.src[self.pos];
            self.pos += 1;
            if ch == ':' || ch == ')' {
                break ch;
            }
            if ch == '-' && on {
                on = false;
                continue;
            }
            if !FLAG_LETTERS.contains(ch) {
                return Err(self.fail(BAD_GROUP_SYNTAX, Some(self.pos - 1)));
            }
            match ch {
                'J' => {}
                'x' if self.peek(0) == Some('x') => {
                    self.pos += 1;
                    flags.x = on;
                    flags.xx = on;
                }
                'i' => flags.i = on,
                'm' => flags.m = on,
                'n' => flags.n = on,
                's' => flags.s = on,
                'x' => flags.x = on,
                _ => flags.u = on,
            }
        };
        if end == ':' {
            self.push(start, Piece::new("(?:", "("), Kind::Group, false);
        } else {
            self.atom_start = None;
            self.repeatable = false;
        }
        self.flags = flags;
        Ok(())
    }

    fn close_group(&mut self) -> Result<(), PcreError> {
        if self.stack.len() == 1 {
            return Err(self.fail(UNMATCHED_PAREN, None));
        }
        let mut frame = self.stack.pop().expect("an open group");
        self.pos += 1;
        frame.widths.push((frame.low, frame.high));
        self.flags = frame.flags;
        if frame.kind == Kind::Behind {
            return self.close_lookbehind(frame);
        }
        let closer = if frame.kind == Kind::Ahead {
            Piece::new(")", "")
        } else {
            Piece::same(")")
        };
        self.out.push(closer);
        let mut whole = join(&self.out[frame.out_start..]);
        if frame.kind == Kind::Ahead {
            whole.regular.clear();
            self.out.truncate(frame.out_start);
            self.out.push(whole);
            self.atom_start = Some(frame.out_start);
            self.atom_width = (0, Some(0));
            self.repeatable = true;
            self.quantified = false;
            self.look = true;
            return Ok(());
        }
        let low = frame.widths.iter().map(|w| w.0).min().unwrap_or(0);
        let high = if frame.widths.iter().any(|w| w.1.is_none()) {
            None
        } else {
            frame.widths.iter().filter_map(|w| w.1).max()
        };
        let width = (low, high);
        self.out.truncate(frame.out_start);
        self.out.push(whole);
        self.atom_start = Some(frame.out_start);
        self.atom_width = width;
        self.repeatable = true;
        self.quantified = false;
        self.look = false;
        let parent = self.stack.last_mut().expect("the outermost frame");
        (parent.low, parent.high) = add_width((parent.low, parent.high), width);
        Ok(())
    }

    /// `(?<=` / `(?<!`, which PCRE2 takes when each alternative is
    /// bounded, a variable one to 255 characters.
    fn close_lookbehind(&mut self, frame: Frame) -> Result<(), PcreError> {
        for &(low, high) in &frame.widths {
            let Some(high) = high else {
                return Err(self.fail(LOOKBEHIND_UNLIMITED, Some(frame.open_at)));
            };
            if low != high && high > LOOKBEHIND_MAX {
                return Err(self.fail(LOOKBEHIND_LONG, Some(frame.open_at)));
            }
        }
        let opener = if frame.negative { "(?<!" } else { "(?<=" };
        let body = join(&self.out[frame.out_start + 1..]).text;
        let text = format!("{opener}{body})");
        self.out.truncate(frame.out_start);
        self.out.push(Piece::assertion(text));
        self.atom_start = None;
        self.repeatable = false;
        Ok(())
    }

    fn quantifier(&mut self, op: char) -> Result<(), PcreError> {
        let mut at = self.pos;
        let (low, high, token) = if op == '{' {
            let (low, high, end) = self.interval_at(self.pos)?.expect("an interval");
            self.pos = end;
            at = end - 1;
            let token = match high {
                Some(high) if high == low => format!("{{{low}}}"),
                None => format!("{{{low},}}"),
                Some(high) => format!("{{{low},{high}}}"),
            };
            (low, high, token)
        } else {
            self.pos += 1;
            let (low, high) = match op {
                '*' => (0, None),
                '+' => (1, None),
                _ => (0, Some(1)),
            };
            (low, high, op.to_string())
        };
        let start = match self.atom_start {
            Some(start) if self.repeatable && !self.quantified => start,
            _ => return Err(self.fail(NOTHING_TO_REPEAT, Some(at))),
        };
        let mut suffix = match self.peek(0) {
            Some(ch @ ('?' | '+')) => {
                self.pos += 1;
                Some(ch)
            }
            _ => None,
        };
        if self.flags.u {
            suffix = match suffix {
                None => Some('?'),
                Some('?') => None,
                other => other,
            };
        }
        if self.look {
            if low == 0 {
                self.out.truncate(start);
            }
            self.repeatable = false;
            return Ok(());
        }
        let mut body = join(&self.out[start..]);
        if self.out.len() - start > 1 {
            body = Piece::new(format!("(?:{})", body.text), format!("({})", body.regular));
        }
        let width = self.atom_width;
        let frame = self.stack.last_mut().expect("the outermost frame");
        frame.low -= width.0;
        if let (Some(high), Some(w)) = (frame.high, width.1) {
            frame.high = Some(high - w);
        }
        let least = width.0.saturating_mul(low);
        let mut most = match (high, width.1) {
            (Some(h), Some(w)) => Some(w.saturating_mul(h)),
            _ => None,
        };
        if high.is_none() && width.1 == Some(0) {
            most = Some(0);
        }
        (frame.low, frame.high) = add_width((frame.low, frame.high), (least, most));
        let regular = format!("{}{token}", body.regular);
        let text = match suffix {
            Some('+') => format!("(?>{}{token})", body.text),
            Some('?') => format!("{}{token}?", body.text),
            _ => format!("{}{token}", body.text),
        };
        self.out.truncate(start);
        self.out.push(Piece::new(text, regular));
        self.quantified = true;
        self.atom_width = (least, most);
        Ok(())
    }

    /// A `{n}`, `{n,}`, `{n,m}` or `{,m}` quantifier at `i`: its bounds and
    /// the index past the `}`, or None when the brace is a literal.
    fn interval_at(&self, i: usize) -> Result<Option<(usize, Option<usize>, usize)>, PcreError> {
        let src = &self.src;
        let blanks = |mut j: usize| {
            while j < src.len() && (src[j] == ' ' || src[j] == '\t') {
                j += 1;
            }
            j
        };
        let digits = |mut j: usize| {
            let begin = j;
            while j < src.len() && is_digit(src[j]) {
                j += 1;
            }
            (begin, j)
        };
        if src.get(i) != Some(&'{') {
            return Ok(None);
        }
        let mut j = blanks(i + 1);
        let (low_begin, low_end) = digits(j);
        j = blanks(low_end);
        let mut comma = false;
        let (mut high_begin, mut high_end) = (j, j);
        if src.get(j) == Some(&',') {
            comma = true;
            j = blanks(j + 1);
            (high_begin, high_end) = digits(j);
            j = blanks(high_end);
        }
        if src.get(j) != Some(&'}') {
            return Ok(None);
        }
        let end = j + 1;
        let low_text = &src[low_begin..low_end];
        let high_text = &src[high_begin..high_end];
        if low_text.is_empty() && !(comma && !high_text.is_empty()) {
            return Ok(None);
        }
        let low = parse_number(low_text, 10);
        let high = if !comma {
            Some(low)
        } else if high_text.is_empty() {
            None
        } else {
            Some(parse_number(high_text, 10))
        };
        if low > 65535 || high.is_some_and(|h| h > 65535) {
            return Err(self.fail(QUANTIFIER_BIG, Some(end - 1)));
        }
        if high.is_some_and(|h| h < low) {
            return Err(self.fail(QUANTIFIER_ORDER, Some(end - 1)));
        }
        Ok(Some((low as usize, high.map(|h| h as usize), end)))
    }

    fn escape(&mut self) -> Result<(), PcreError> {
        let start = self.pos;
        if self.pos + 1 >= self.src.len() {
            return Err(self.fail(TRAILING_BACKSLASH, Some(self.src.len())));
        }
        let ch = self.src[self.pos + 1];
        self.pos += 2;
        match ch {
            'Q' => {
                let end = self.find(self.pos, "\\E");
                let text: Vec<char> = self.src[self.pos..end.unwrap_or(self.src.len())].to_vec();
                self.pos = end.map_or(self.src.len(), |end| end + 2);
                for c in text {
                    self.literal(u32::from(c));
                }
                return Ok(());
            }
            'E' => return Ok(()),
            'K' => return self.keep(),
            'G' => return Err(self.fail(unsupported("\\G"), Some(start))),
            'X' | 'C' => return Err(self.fail(unsupported(&format!("\\{ch}")), Some(start))),
            'R' => {
                let class = self.class_piece(&CharSet::of(NEWLINE_SEQUENCE));
                let text = format!("(?>\\r\\n|{})", class.text);
                self.atom(Piece::new(text, "..?"), (1, Some(2)));
                return Ok(());
            }
            'b' | 'B' => {
                let text = self.boundary(ch == 'b');
                self.assertion(text);
                return Ok(());
            }
            'A' => {
                self.assertion("\\A".to_string());
                return Ok(());
            }
            'z' => {
                self.assertion("\\z".to_string());
                return Ok(());
            }
            'Z' => {
                self.assertion("(?=\\n?\\z)".to_string());
                return Ok(());
            }
            'N' if self.peek(0) == Some('{') => return self.named_char(),
            _ => {}
        }
        if (ch == 'g' || ch == 'k' || (is_digit(ch) && ch != '0')) && self.reference(start, ch)? {
            return Ok(());
        }
        if let Some(cs) = self.class_escape(ch)? {
            self.set_atom(&cs);
            return Ok(());
        }
        let cp = self.char_escape(ch, false)?;
        self.literal(cp);
        Ok(())
    }

    fn named_char(&mut self) -> Result<(), PcreError> {
        if self.mode.bytes {
            return Err(self.fail(NAMED_CHAR_UTF, None));
        }
        let close = self.find(self.pos, "}");
        let body: Vec<char> = match close {
            Some(close) if close > 0 => self.src[self.pos + 1..close].to_vec(),
            _ => Vec::new(),
        };
        if !(body.len() >= 2 && body[0] == 'U' && body[1] == '+') {
            return Err(self.fail(CASE_ESCAPES, None));
        }
        let digits = &body[2..];
        if digits.is_empty() || digits.iter().any(|d| !HEX.contains(*d)) {
            return Err(self.fail(DIGITS_MISSING, None));
        }
        let close = close.expect("a closing brace");
        self.pos = close + 1;
        let cp = self.code_point(parse_number(digits, 16), close)?;
        self.literal(cp);
        Ok(())
    }

    fn keep(&mut self) -> Result<(), PcreError> {
        if self
            .stack
            .iter()
            .any(|f| f.kind == Kind::Ahead || f.kind == Kind::Behind)
        {
            return Err(self.fail(KEEP_IN_LOOKAROUND, Some(self.src.len())));
        }
        self.out.push(Piece::assertion("\\K"));
        self.atom_start = None;
        self.repeatable = false;
        Ok(())
    }

    /// A back-reference, or false when `\ddd` is an octal escape.
    fn reference(&mut self, start: usize, ch: char) -> Result<bool, PcreError> {
        if is_digit(ch) {
            let mut end = self.pos;
            while end < self.src.len() && is_digit(self.src[end]) {
                end += 1;
            }
            let mut digits = vec![ch];
            digits.extend_from_slice(&self.src[self.pos..end]);
            let number = parse_number(&digits, 10);
            if number >= 10 && number > self.total_groups as u64 {
                if ch == '8' || ch == '9' {
                    return Err(self.fail(NO_SUBPATTERN, Some(end)));
                }
                return Ok(false);
            }
            self.pos = end;
            self.backref(number as usize, self.pos - 1);
            return Ok(true);
        }
        if ch == 'g' {
            let Some((reference, end)) = self.g_reference(self.pos) else {
                if matches!(self.peek(0), Some('<') | Some('\'')) {
                    return Err(self.fail(unsupported("subroutine calls"), Some(start)));
                }
                return Err(self.fail(G_SYNTAX, None));
            };
            self.pos = end;
            match reference {
                Reference::Name(name, at) => self.named_backref(&name, at)?,
                Reference::Number(number) => {
                    let number = if number < 0 {
                        self.groups as i64 + 1 + number
                    } else {
                        number
                    };
                    if number <= 0 {
                        return Err(self.fail(NO_SUBPATTERN, None));
                    }
                    self.backref(number as usize, self.pos - 1);
                }
            }
            return Ok(true);
        }
        let Some((name, begin, end)) = self.k_reference(self.pos) else {
            return Err(self.fail(K_SYNTAX, None));
        };
        self.pos = end;
        self.named_backref(&name, begin)?;
        Ok(true)
    }

    fn g_reference(&self, at: usize) -> Option<(Reference, usize)> {
        let src = &self.src;
        let number = |from: usize| {
            let mut j = from;
            if src.get(j) == Some(&'-') {
                j += 1;
            }
            let digits_start = j;
            while j < src.len() && is_digit(src[j]) {
                j += 1;
            }
            (j > digits_start).then(|| {
                let value = parse_number(&src[digits_start..j], 10).min(i64::MAX as u64) as i64;
                (if src[from] == '-' { -value } else { value }, j)
            })
        };
        if src.get(at) == Some(&'{') {
            if let Some((value, end)) =
                number(at + 1).filter(|&(_, end)| src.get(end) == Some(&'}'))
            {
                return Some((Reference::Number(value), end + 1));
            }
            if src.get(at + 1).copied().is_some_and(is_name_start) {
                let mut j = at + 2;
                while j < src.len() && is_name_char(src[j]) {
                    j += 1;
                }
                if src.get(j) == Some(&'}') {
                    return Some((Reference::Name(self.slice(at + 1, j), at + 1), j + 1));
                }
            }
            return None;
        }
        number(at).map(|(value, end)| (Reference::Number(value), end))
    }

    fn k_reference(&self, at: usize) -> Option<(String, usize, usize)> {
        let src = &self.src;
        let close = match src.get(at) {
            Some('<') => '>',
            Some('\'') => '\'',
            Some('{') => '}',
            _ => return None,
        };
        if !src.get(at + 1).copied().is_some_and(is_name_start) {
            return None;
        }
        let mut j = at + 2;
        while j < src.len() && is_name_char(src[j]) {
            j += 1;
        }
        (src.get(j) == Some(&close)).then(|| (self.slice(at + 1, j), at + 1, j + 1))
    }

    fn backref(&mut self, number: usize, offset: usize) {
        let text = if self.flags.i {
            format!("(?i:\\{number})")
        } else {
            format!("(?:\\{number})")
        };
        self.atom(Piece::new(text, self.widened()), (0, None));
        self.backrefs.push((number, offset));
    }

    fn named_backref(&mut self, name: &str, at: usize) -> Result<(), PcreError> {
        if !self.names.iter().any(|n| n == name) && !self.all_names.iter().any(|n| n == name) {
            return Err(self.fail(NO_SUBPATTERN, Some(at)));
        }
        let text = if self.flags.i {
            format!("(?i:\\k<{name}>)")
        } else {
            format!("\\k<{name}>")
        };
        self.atom(Piece::new(text, self.widened()), (0, None));
        Ok(())
    }

    /// What stands for a back-reference in the regular approximation: any
    /// run of characters.
    fn widened(&self) -> String {
        ".*".to_string()
    }

    fn class_escape(&mut self, ch: char) -> Result<Option<CharSet>, PcreError> {
        if ch == 'N' {
            return Ok(Some(charset::all().minus(&CharSet::chars(&[0x0A]))));
        }
        let unicode = self.mode.unicode;
        let base = match ch.to_ascii_lowercase() {
            'd' if unicode => Some(charset::category("Nd")),
            'd' => Some(CharSet::of(ASCII_DIGIT)),
            's' if unicode => Some(CharSet::of(PCRE_HSPACE).union(&CharSet::of(PCRE_VSPACE))),
            's' => Some(CharSet::of(ASCII_SPACE)),
            'w' if unicode => Some(charset::pcre_word().clone()),
            'w' => Some(CharSet::of(ASCII_WORD)),
            'h' => Some(CharSet::of(PCRE_HSPACE)),
            'v' => Some(CharSet::of(PCRE_VSPACE)),
            _ => None,
        };
        if let Some(cs) = base {
            return Ok(Some(if ch.is_ascii_uppercase() {
                cs.negate()
            } else {
                cs
            }));
        }
        if ch == 'p' || ch == 'P' {
            let cs = self.property()?;
            return Ok(Some(if ch == 'P' { cs.negate() } else { cs }));
        }
        Ok(None)
    }

    fn property(&mut self) -> Result<CharSet, PcreError> {
        let name = if self.peek(0) == Some('{') {
            let Some(close) = self.find(self.pos, "}") else {
                return Err(self.fail(UNKNOWN_PROPERTY, Some(self.src.len())));
            };
            let name = self.slice(self.pos + 1, close);
            self.pos = close + 1;
            name
        } else if let Some(ch) = self.peek(0) {
            self.pos += 1;
            if !ch.is_alphabetic() {
                return Err(self.fail(MALFORMED_PROPERTY, None));
            }
            ch.to_string()
        } else {
            return Err(self.fail(MALFORMED_PROPERTY, Some(self.src.len())));
        };
        let (negated, bare) = match name.strip_prefix('^') {
            Some(rest) => (true, rest),
            None => (false, name.as_str()),
        };
        let Some(cs) = charset::pcre_property(bare) else {
            return Err(self.fail(unsupported(&format!("\\p{{{name}}}")), None));
        };
        Ok(if negated { cs.negate() } else { cs })
    }

    fn char_escape(&mut self, ch: char, in_class: bool) -> Result<u32, PcreError> {
        match ch {
            'a' => return Ok(0x07),
            'e' => return Ok(0x1B),
            'f' => return Ok(0x0C),
            'n' => return Ok(0x0A),
            'r' => return Ok(0x0D),
            't' => return Ok(0x09),
            'b' if in_class => return Ok(0x08),
            _ => {}
        }
        if ch == 'c' {
            let Some(letter) = self.peek(0) else {
                return Err(self.fail(TRAILING_C, Some(self.src.len())));
            };
            self.pos += 1;
            let upper = letter.to_uppercase().next().unwrap_or(letter);
            return Ok(u32::from(upper) ^ 0x40);
        }
        if ch == 'x' {
            return self.hex_escape();
        }
        if ch == 'o' {
            if self.peek(0) != Some('{') {
                return Err(self.fail(DIGITS_MISSING, None));
            }
            let close = self.find(self.pos, "}");
            let digits: Vec<char> = match close {
                Some(close) if close > 0 => self.src[self.pos + 1..close].to_vec(),
                _ => Vec::new(),
            };
            if close.is_none()
                || digits.is_empty()
                || digits.iter().any(|d| !"01234567".contains(*d))
            {
                let message = if !digits.is_empty() || close.is_none() {
                    OCTAL_BAD
                } else {
                    DIGITS_MISSING
                };
                return Err(self.fail(
                    message,
                    Some(self.pos + 1 + first_outside(&digits, "01234567")),
                ));
            }
            let close = close.expect("a closing brace");
            self.pos = close + 1;
            return self.code_point(parse_number(&digits, 8), close);
        }
        if is_digit(ch) {
            if ch == '8' || ch == '9' {
                return Ok(u32::from(ch));
            }
            let mut end = self.pos;
            while end < self.src.len() && end < self.pos + 2 && ('0'..='7').contains(&self.src[end])
            {
                end += 1;
            }
            let mut digits = vec![ch];
            digits.extend_from_slice(&self.src[self.pos..end]);
            self.pos = end;
            return Ok(parse_number(&digits, 8) as u32);
        }
        if "LlUu".contains(ch) || (ch == 'N' && self.peek(0) == Some('{')) {
            return Err(self.fail(CASE_ESCAPES, None));
        }
        if ch.is_ascii_alphanumeric() {
            return Err(self.fail(ESCAPE_UNKNOWN, Some(self.pos - 1)));
        }
        Ok(u32::from(ch))
    }

    fn hex_escape(&mut self) -> Result<u32, PcreError> {
        if self.peek(0) == Some('{') {
            let close = self.find(self.pos, "}");
            let digits: Vec<char> = match close {
                Some(close) if close > 0 => self.src[self.pos + 1..close].to_vec(),
                _ => Vec::new(),
            };
            if close.is_none() || digits.iter().any(|d| !HEX.contains(*d)) {
                return Err(self.fail(HEX_BAD, Some(self.pos + 1 + first_outside(&digits, HEX))));
            }
            if digits.is_empty() {
                return Err(self.fail(DIGITS_MISSING, None));
            }
            let close = close.expect("a closing brace");
            self.pos = close + 1;
            return self.code_point(parse_number(&digits, 16), close);
        }
        let mut end = self.pos;
        while end < self.src.len() && end < self.pos + 2 && HEX.contains(self.src[end]) {
            end += 1;
        }
        if end == self.pos {
            return Err(self.fail(DIGITS_MISSING, None));
        }
        let value = parse_number(&self.src[self.pos..end], 16) as u32;
        self.pos = end;
        Ok(value)
    }

    fn code_point(&self, value: u64, offset: usize) -> Result<u32, PcreError> {
        let limit = if self.mode.bytes { 0xFF } else { 0x10FFFF };
        if value > limit {
            return Err(self.fail(CODE_POINT_BIG, Some(offset)));
        }
        if (0xD800..=0xDFFF).contains(&value) {
            return Err(self.fail(SURROGATE, Some(offset)));
        }
        Ok(value as u32)
    }

    fn parse_class(&mut self) -> Result<CharSet, PcreError> {
        self.pos += 1;
        let mut negated = false;
        if self.peek(0) == Some('^') {
            negated = true;
            self.pos += 1;
        }
        let mut cs = CharSet::default();
        let mut first = true;
        loop {
            if self.flags.xx {
                while matches!(self.peek(0), Some(' ') | Some('\t')) {
                    self.pos += 1;
                }
            }
            if self.pos >= self.src.len() {
                return Err(self.fail(MISSING_BRACKET, Some(self.src.len())));
            }
            let ch = self.src[self.pos];
            if ch == ']' && !first {
                self.pos += 1;
                break;
            }
            first = false;
            if self.starts_with(self.pos, "\\Q") {
                let end = self.find(self.pos + 2, "\\E");
                let text: Vec<u32> = self.src[self.pos + 2..end.unwrap_or(self.src.len())]
                    .iter()
                    .map(|&c| u32::from(c))
                    .collect();
                self.pos = end.map_or(self.src.len(), |end| end + 2);
                cs = cs.union(&CharSet::chars(&text));
                continue;
            }
            if self.starts_with(self.pos, "\\E") {
                self.pos += 2;
                continue;
            }
            if let Some(posix) = self.posix_class()? {
                cs = cs.union(&posix);
                continue;
            }
            let low = self.class_char()?;
            let ranged = self.peek(0) == Some('-') && !matches!(self.peek(1), Some(']') | None);
            let low = match low {
                Member::Set(set) => {
                    if ranged && !self.starts_with(self.pos + 1, "\\E") {
                        return Err(self.fail(RANGE_BAD, Some(self.pos + 1)));
                    }
                    cs = cs.union(&set);
                    continue;
                }
                Member::Char(low) => low,
            };
            if !ranged {
                cs = cs.union(&CharSet::chars(&[low]));
                continue;
            }
            self.pos += 1;
            if self.starts_with(self.pos, "[:") && self.posix_name().is_some() {
                return Err(self.fail(RANGE_BAD, Some(self.pos)));
            }
            let high = match self.class_char()? {
                Member::Set(_) => return Err(self.fail(RANGE_BAD, Some(self.pos - 1))),
                Member::Char(high) => high,
            };
            if high < low {
                return Err(self.fail(RANGE_ORDER, Some(self.pos - 1)));
            }
            cs = cs.union(&CharSet::of(&[(low, high)]));
        }
        let cs = self.caseless(&cs);
        Ok(if negated { cs.negate() } else { cs })
    }

    fn posix_name(&self) -> Option<String> {
        let close = self.find(self.pos + 2, ":]")?;
        let name = self.slice(self.pos + 2, close);
        let body = name.strip_prefix('^').unwrap_or(&name);
        (!body.is_empty()
            && body
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '<' || c == '>'))
        .then_some(name)
    }

    fn posix_class(&mut self) -> Result<Option<CharSet>, PcreError> {
        if !self.starts_with(self.pos, "[:") {
            return Ok(None);
        }
        let Some(name) = self.posix_name() else {
            return Ok(None);
        };
        let (negated, bare) = match name.strip_prefix('^') {
            Some(rest) => (true, rest.to_string()),
            None => (false, name.clone()),
        };
        if bare == "<" || bare == ">" {
            return Err(self.fail(unsupported(&format!("[[:{bare}:]]")), None));
        }
        let close = self.find(self.pos + 2, ":]").expect("a closing :]");
        let Some(cs) = charset::posix_set(&bare, self.mode.unicode) else {
            return Err(self.fail(POSIX_UNKNOWN, Some(close + 2)));
        };
        self.pos = close + 2;
        Ok(Some(if negated { cs.negate() } else { cs }))
    }

    fn class_char(&mut self) -> Result<Member, PcreError> {
        let ch = self.src[self.pos];
        if ch != '\\' {
            self.pos += 1;
            return Ok(Member::Char(u32::from(ch)));
        }
        if self.pos + 1 >= self.src.len() {
            return Err(self.fail(TRAILING_BACKSLASH, Some(self.src.len())));
        }
        let letter = self.src[self.pos + 1];
        self.pos += 2;
        if letter == 'N' {
            return Err(self.fail(N_IN_CLASS, None));
        }
        if "BRXGKAzZgk".contains(letter) {
            return Err(self.fail(ESCAPE_IN_CLASS, None));
        }
        if let Some(cs) = self.class_escape(letter)? {
            return Ok(Member::Set(cs));
        }
        Ok(Member::Char(self.char_escape(letter, true)?))
    }

    fn word_class(&self) -> CharSet {
        if self.mode.unicode {
            charset::pcre_word().clone()
        } else {
            CharSet::of(ASCII_WORD)
        }
    }

    /// Spencer's `[[:<:]]` / `[[:>:]]`: a word's start or end.
    fn word_edge(&self, start: bool) -> String {
        let w = self.class_piece(&self.word_class()).text;
        if start {
            format!("(?<!{w})(?={w})")
        } else {
            format!("(?<={w})(?!{w})")
        }
    }

    /// `\b` (`word`) or `\B` over the dialect's word class.
    fn boundary(&self, word: bool) -> String {
        if self.mode.bytes || (word && !self.mode.unicode) {
            return if word { "(?-u:\\b)" } else { "(?-u:\\B)" }.to_string();
        }
        let w = self.class_piece(&self.word_class()).text;
        if word {
            format!("(?:(?<={w})(?!{w})|(?<!{w})(?={w}))")
        } else {
            format!("(?:(?<={w})(?={w})|(?<!{w})(?!{w}))")
        }
    }

    /// One literal code point outside a class.
    fn char_text(&self, cp: u32) -> String {
        if (0x20..=0x7E).contains(&cp) {
            let ch = char::from_u32(cp).expect("printable ASCII");
            if "\\^$.|?*+()[]{}".contains(ch) {
                return format!("\\{ch}");
            }
            return ch.to_string();
        }
        self.code_text(cp)
    }

    fn code_text(&self, cp: u32) -> String {
        if self.mode.bytes {
            format!("\\x{cp:02X}")
        } else {
            format!("\\x{{{cp:X}}}")
        }
    }

    /// A set as one atom that matches exactly its members: in byte mode
    /// only the code points a byte can be.
    fn class_piece(&self, cs: &CharSet) -> Piece {
        let cs = if self.mode.bytes {
            cs.intersect(&CharSet::of(&[(0, 0xFF)]))
        } else {
            cs.intersect(&charset::all())
        };
        if let Some(single) = cs.single() {
            return Piece::new(self.char_text(single), ere_char(single));
        }
        if cs.is_empty() {
            return Piece::new("(*FAIL)", "");
        }
        let mut text = String::from("[");
        for &(low, high) in cs.ranges() {
            text.push_str(&self.code_text(low));
            if high > low {
                text.push('-');
                text.push_str(&self.code_text(high));
            }
        }
        text.push(']');
        if self.mode.bytes {
            text = format!("(?-u:{text})");
        }
        Piece::new(text, ".")
    }
}

/// One literal in the extended POSIX approximation: printable ASCII as
/// itself, anything else as any character.
fn ere_char(cp: u32) -> String {
    match char::from_u32(cp) {
        Some(ch) if ch.is_ascii_graphic() || ch == ' ' => {
            if "\\.[()*+?{|^$".contains(ch) {
                format!("\\{ch}")
            } else {
                ch.to_string()
            }
        }
        _ => ".".to_string(),
    }
}

enum Member {
    Char(u32),
    Set(CharSet),
}

enum Reference {
    Number(i64),
    Name(String, usize),
}

/// `^` under `m`: also just after a `\n` (or a lone `\r` in CRLF mode).
fn line_start(multi_line: bool, crlf: bool) -> String {
    if !multi_line {
        return "^".to_string();
    }
    if crlf {
        "(?:^|(?<=\\n)|(?<=\\r)(?!\\n))".to_string()
    } else {
        "(?:^|(?<=\\n))".to_string()
    }
}

/// `$` under `m`: also just before a `\n` (or a `\r` in CRLF mode, never
/// between `\r` and `\n`).
fn line_end(multi_line: bool, crlf: bool) -> String {
    if !multi_line {
        return "\\z".to_string();
    }
    if crlf {
        "(?:(?=\\r)|(?<!\\r)(?=\\n)|\\z)".to_string()
    } else {
        "(?=\\n|\\z)".to_string()
    }
}

/// How many capturing groups a PCRE2 pattern has, for `\10`.
fn count_groups(pattern: &[char]) -> usize {
    let starts = |i: usize, text: &str| {
        text.chars()
            .enumerate()
            .all(|(k, c)| pattern.get(i + k) == Some(&c))
    };
    let mut count = 0;
    let mut i = 0;
    while i < pattern.len() {
        let ch = pattern[i];
        if ch == '\\' {
            if starts(i, "\\Q") {
                i = (i + 2..pattern.len())
                    .find(|&j| starts(j, "\\E"))
                    .map_or(pattern.len(), |end| end + 2);
                continue;
            }
            i += 2;
            continue;
        }
        if ch == '[' {
            i += 1;
            if pattern.get(i) == Some(&'^') {
                i += 1;
            }
            if pattern.get(i) == Some(&']') {
                i += 1;
            }
            while i < pattern.len() && pattern[i] != ']' {
                i += if pattern[i] == '\\' { 2 } else { 1 };
            }
            i += 1;
            continue;
        }
        if ch == '(' {
            let named = (starts(i + 1, "?<") || starts(i + 1, "?'") || starts(i + 1, "?P<"))
                && !(starts(i + 1, "?<=") || starts(i + 1, "?<!"));
            if !(starts(i + 1, "?") || starts(i + 1, "*")) || named {
                count += 1;
            }
        }
        i += 1;
    }
    count
}

/// The group names a PCRE2 pattern defines anywhere.
fn named_groups(pattern: &[char]) -> Vec<String> {
    let mut names = Vec::new();
    for i in 0..pattern.len() {
        if pattern[i] != '(' || pattern.get(i + 1) != Some(&'?') {
            continue;
        }
        let (mut j, close) = match (pattern.get(i + 2), pattern.get(i + 3)) {
            (Some('P'), Some('<')) => (i + 4, '>'),
            (Some('<'), _) => (i + 3, '>'),
            (Some('\''), _) => (i + 3, '\''),
            _ => continue,
        };
        if !pattern.get(j).copied().is_some_and(is_name_start) {
            continue;
        }
        let begin = j;
        while j < pattern.len() && is_name_char(pattern[j]) {
            j += 1;
        }
        if pattern.get(j) == Some(&close) {
            names.push(pattern[begin..j].iter().collect());
        }
    }
    names
}

/// An inline option group that could change case sensitivity (or, with
/// `x`, what the text of the pattern is).
fn has_inline_case(pattern: &[char]) -> bool {
    (0..pattern.len()).any(|i| {
        if pattern[i] != '(' || pattern.get(i + 1) != Some(&'?') {
            return false;
        }
        let mut j = i + 2;
        let mut last = None;
        while let Some(&c) = pattern.get(j) {
            if c.is_ascii_alphabetic() || c == '^' || c == '-' {
                last = Some(c);
                if c == 'i' || c == '^' {
                    return true;
                }
                j += 1;
            } else {
                break;
            }
        }
        matches!(last, Some('i') | Some('^'))
    })
}

/// Translate a PCRE2 pattern, given as the characters PCRE2 reads.
pub(crate) fn translate(pattern: &[char], mode: Mode) -> Result<Translated, PcreError> {
    let flags = Flags {
        i: mode.ignore_case,
        m: mode.multi_line,
        s: mode.dotall,
        ..Flags::default()
    };
    let folded = mode.ignore_case && !has_inline_case(pattern);
    let mut translator = Translator::new(pattern.to_vec(), mode, flags);
    translator.folded = folded;
    let mut translated = translator.translate()?;
    translated.fold = folded;
    Ok(translated)
}

/// The source fancy-regex compiles: the translation, folded throughout
/// when it asks.
pub(crate) fn source(translated: &Translated, whole_line: bool) -> String {
    let fold = if translated.fold { "(?i)" } else { "" };
    if whole_line {
        format!("{fold}^(?:{})\\z", translated.source)
    } else {
        format!("{fold}{}", translated.source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(text: &str) -> Vec<char> {
        text.chars().collect()
    }

    fn err(pattern: &str) -> (String, usize) {
        let error = translate(&chars(pattern), Mode::default())
            .err()
            .expect("a refusal");
        (error.message, error.offset)
    }

    #[test]
    fn refusals_keep_pcre2_wording_and_offsets() {
        assert_eq!(err("a("), (MISSING_PAREN.into(), 2));
        assert_eq!(err("a)"), (UNMATCHED_PAREN.into(), 1));
        assert_eq!(err("[a"), (MISSING_BRACKET.into(), 2));
        assert_eq!(err("*a"), (NOTHING_TO_REPEAT.into(), 0));
        assert_eq!(err("a{3,2}"), (QUANTIFIER_ORDER.into(), 5));
        assert_eq!(err("(?<=a+)b"), (LOOKBEHIND_UNLIMITED.into(), 0));
        assert_eq!(err("\\2(a)"), (NO_SUBPATTERN.into(), 1));
        assert_eq!(
            err("(?|a)").0,
            "(?| branch reset is not supported in mirage"
        );
    }

    #[test]
    fn group_counting_skips_lookarounds_and_classes() {
        assert_eq!(count_groups(&chars("(a)(?:b)(?<n>c)(?<=d)[(]\\(")), 2);
    }

    #[test]
    fn a_caseless_line_without_inline_options_folds_throughout() {
        let mode = Mode {
            ignore_case: true,
            ..Mode::default()
        };
        let translated = translate(&chars("ab"), mode).unwrap();
        assert!(translated.fold);
        assert_eq!(source(&translated, false), "(?i)ab");
        assert_eq!(source(&translated, true), "(?i)^(?:ab)\\z");
    }

    #[test]
    fn lookarounds_and_back_references_leave_the_regular_reading() {
        let translated = translate(&chars("(?<=x)(ab)\\1(?=y)"), Mode::default()).unwrap();
        assert_eq!(translated.regular, "(ab).*");
        assert_eq!(translated.source, "(?<=x)(ab)(?:\\1)(?=y)");
    }
}
