// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regparse.c. See licenses/third_party/oniguruma.txt.

use std::iter::once;

use super::callout::{self, Arg, Callout, Kind as CalloutKind};
use super::class::{self, Ctype, Set};
use super::fold;

/// jq's onig_set_parse_depth_limit(1024): each alternation, branch and
/// class costs one, and each quantifier one on top of its branch.
const PARSE_DEPTH_LIMIT: usize = 1024;

/// ONIG_MAX_REPEAT_NUM.
const MAX_REPEAT: u32 = 100_000;

/// ONIG_MAX_BACKREF_NUM.
const MAX_BACKREF: usize = 1000;

/// MAX_ERROR_PAR_LEN - 3: the bytes of a name an error message shows.
const ERROR_PAR_LEN: usize = 27;

pub(super) const END_AT_ESCAPE: &str = "end pattern at escape";
const END_AT_CONTROL: &str = "end pattern at control";
const PREMATURE_END_OF_CLASS: &str = "premature end of char-class";
const EMPTY_CLASS: &str = "empty char-class";
const VALUE_AT_END_OF_RANGE: &str = "char-class value at end of range";
const EMPTY_RANGE: &str = "empty range in char class";
const NOT_SPECIFIED: &str = "target of repeat operator is not specified";
const INVALID_TARGET: &str = "target of repeat operator is invalid";
const UNMATCHED_CLOSE: &str = "unmatched close parenthesis";
const UNMATCHED_OPEN: &str = "end pattern with unmatched parenthesis";
const END_IN_GROUP: &str = "end pattern in group";
const UNDEFINED_OPTION: &str = "undefined group option";
const INVALID_POSIX: &str = "invalid POSIX bracket type";
const TOO_BIG_NUMBER: &str = "too big number";
const TOO_BIG_REPEAT: &str = "too big number for repeat range";
const UPPER_SMALLER: &str = "upper is smaller than lower in repeat range";
const TOO_SHORT_MULTIBYTE: &str = "too short multibyte code string";
pub(super) const INVALID_BACKREF: &str = "invalid backref number/name";
const TOO_LONG_WIDE: &str = "too long wide-char value";
const INVALID_CODE_POINT: &str = "invalid code point value";
const EMPTY_NAME: &str = "group name is empty";
const DEPTH_LIMIT: &str = "parse depth limit over";
const INVALID_IF_ELSE: &str = "invalid if-else syntax";
const INVALID_CALLOUT_PATTERN: &str = "invalid callout pattern";
const INVALID_CALLOUT_NAME: &str = "invalid callout name";
const UNDEFINED_CALLOUT_NAME: &str = "undefined callout name";
const INVALID_CALLOUT_TAG: &str = "invalid callout tag name";
const INVALID_CALLOUT_ARG: &str = "invalid callout arg";
const INVALID_GROUP_NAME: &str = "invalid group name";
const INVALID_CHAR_IN_NAME: &str = "invalid char in group name";

/// An error naming part of the pattern, cut as onig_error_code_to_str
/// cuts it: 27 bytes and `...`, a split character shown as U+FFFD.
pub(super) fn named(message: &str, text: &str) -> String {
    let (open, close) = if message.ends_with("property name") {
        ('{', '}')
    } else {
        ('<', '>')
    };
    let bytes = text.as_bytes();
    let shown = if bytes.len() > ERROR_PAR_LEN {
        format!("{}...", String::from_utf8_lossy(&bytes[..ERROR_PAR_LEN]))
    } else {
        text.to_string()
    };
    match message {
        "undefined name" | "undefined group" => format!("{message} {open}{shown}{close} reference"),
        "multiplex definition name" => format!("{message} {open}{shown}{close} call"),
        _ => format!("{message} {open}{shown}{close}"),
    }
}

/// The options a pattern is read under, which `(?imsx)` changes.
#[derive(Clone, Copy, Default)]
pub(super) struct Flags {
    pub(super) ignore_case: bool,
    pub(super) extend: bool,
    /// ONIG_OPTION_MULTILINE: `.` also matches a newline.
    pub(super) dotall: bool,
    /// ONIG_OPTION_SINGLELINE: `^` is `\A` and `$` is `\Z`.
    pub(super) singleline: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Anchor {
    /// `\A`.
    BufStart,
    /// `\z`.
    BufEnd,
    /// `\Z`: the end, or before a newline that ends the subject.
    SemiEnd,
    LineStart,
    LineEnd,
    /// `\G`: where the search began.
    SearchStart,
    WordBoundary,
    NotWordBoundary,
    /// `\y`: an extended grapheme cluster boundary.
    TextSegmentBoundary,
    /// `\Y`.
    NotTextSegmentBoundary,
}

/// A subexp call, resolved to its group once every group is known.
#[derive(Debug)]
pub(super) struct Call {
    pub(super) group: usize,
    /// The text between the brackets, for an error.
    pub(super) text: String,
    pub(super) by_name: bool,
    /// Whether the call is reachable from its own group's body, so its
    /// length is unknown (Oniguruma's ND_ST_RECURSION on a call).
    pub(super) recursive: bool,
}

/// What a SAVE_VAL gimmick keeps on the stack.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Saved {
    /// The current position.
    Pos,
    /// The right range the absent operator narrows.
    Right,
}

/// An UPDATE_VAR gimmick.
#[derive(Clone, Copy, Debug)]
pub(super) enum Update {
    /// The right range becomes the position a SAVE_VAL of that id kept.
    RightFromPos(usize),
    /// The right range becomes what a SAVE_VAL of that id kept.
    RightFromRight(usize),
    /// The position becomes what a SAVE_VAL of that id kept.
    PosFromPos(usize),
    /// The right range becomes the end of the subject.
    RightInit,
}

#[derive(Debug)]
pub(super) enum Node {
    Empty,
    Char(char),
    /// A literal read under ignore-case, which `fold::unravel` rewrites
    /// before the tree is compiled.
    Caseless(char),
    /// A byte `\xHH` names that starts no character.
    Byte(u8),
    Set(Box<Set>),
    /// `.`: with true, a newline too.
    Any(bool),
    Seq(Vec<Node>),
    Alt(Vec<Node>),
    /// An alternation whose branches survive an atomic cut (Oniguruma's
    /// ND_ST_SUPER), from the absent stopper and range clear.
    Super(Vec<Node>),
    Group(usize, Box<Node>),
    Repeat {
        body: Box<Node>,
        min: u32,
        max: Option<u32>,
        greedy: bool,
    },
    Atomic(Box<Node>),
    /// `(?i:...)`: its own node, so a caseless run never joins across it.
    Options(Box<Node>),
    Look {
        behind: bool,
        negate: bool,
        body: Box<Node>,
    },
    Anchor(Anchor),
    /// The groups a reference may match, the last tried first, whether it
    /// ignores case and its recursion level (`\k<n+l>`).
    Backref {
        groups: Vec<usize>,
        fold: bool,
        level: Option<i64>,
    },
    /// `(?(n)...)`'s test: whether a group is set, at a level.
    Check {
        groups: Vec<usize>,
        level: Option<i64>,
    },
    /// `(?(cond)yes|no)`.
    Cond {
        cond: Box<Node>,
        then: Box<Node>,
        otherwise: Box<Node>,
    },
    /// `\K`.
    Keep,
    /// `\R`.
    Newline,
    Call(Call),
    /// `\X`.
    TextSegment,
    Fail,
    SaveVal(Saved, usize),
    /// The flag marks the absent stopper's update, which a look-behind
    /// refuses (ABSENT_WITH_SIDE_EFFECTS).
    UpdateVar(Update, bool),
    /// An entry of `Parsed::callouts`.
    Callout(usize),
}

impl Node {
    pub(super) fn children<'a>(&'a self, stack: &mut Vec<&'a Node>) {
        match self {
            Node::Seq(items) | Node::Alt(items) | Node::Super(items) => {
                stack.extend(items.iter().rev())
            }
            Node::Group(_, body)
            | Node::Repeat { body, .. }
            | Node::Atomic(body)
            | Node::Options(body)
            | Node::Look { body, .. } => stack.push(body),
            Node::Cond {
                cond,
                then,
                otherwise,
            } => {
                stack.push(otherwise);
                stack.push(then);
                stack.push(cond);
            }
            _ => {}
        }
    }

    pub(super) fn children_mut<'a>(&'a mut self, stack: &mut Vec<&'a mut Node>) {
        match self {
            Node::Seq(items) | Node::Alt(items) | Node::Super(items) => {
                stack.extend(items.iter_mut().rev())
            }
            Node::Group(_, body)
            | Node::Repeat { body, .. }
            | Node::Atomic(body)
            | Node::Options(body)
            | Node::Look { body, .. } => stack.push(body),
            Node::Cond {
                cond,
                then,
                otherwise,
            } => {
                stack.push(otherwise);
                stack.push(then);
                stack.push(cond);
            }
            _ => {}
        }
    }
}

pub(super) struct Parsed {
    pub(super) node: Node,
    pub(super) groups: usize,
    /// Each name and the groups it names, in the order they open.
    pub(super) names: Vec<(String, Vec<usize>)>,
    pub(super) callouts: Vec<Callout>,
}

enum Atom {
    Node(Node),
    /// `(?i)`: options for the rest of the enclosing group.
    Options(Flags),
    Open {
        kind: Body,
        flags: Flags,
    },
}

enum Body {
    Root,
    Plain,
    Group(usize),
    Look(bool, bool),
    Atomic,
    Options,
    Absent(bool),
    Condition,
    Conditional { cond: Box<Node>, then_empty: bool },
}

struct Branches {
    kind: Body,
    saved: Flags,
    branches: Vec<Node>,
    items: Vec<Node>,
}

/// What a class item adds: a character, or a set (`\w`, `[:alpha:]`).
enum Item {
    Char(u32),
    Set(Set),
    Range,
    Close,
}

struct Parser {
    chars: Vec<char>,
    at: usize,
    flags: Flags,
    groups: usize,
    names: Vec<(String, Vec<usize>)>,
    depth: usize,
    /// The highest group a backreference or condition names.
    referenced: usize,
    /// Whether `\g<0>` or `(?0)` calls the whole pattern.
    calls_zero: bool,
    callouts: Vec<Callout>,
    /// Each callout tag and the callout it names.
    tags: Vec<(String, usize)>,
    /// SAVE_VAL ids handed out so far.
    saves: usize,
}

pub(super) fn parse(pattern: &str, flags: Flags) -> Result<Parsed, String> {
    let mut parser = Parser {
        chars: pattern.chars().collect(),
        at: 0,
        flags,
        groups: 0,
        names: Vec::new(),
        depth: 0,
        referenced: 0,
        calls_zero: false,
        callouts: Vec::new(),
        tags: Vec::new(),
        saves: 0,
    };
    let mut node = parser.alts()?;
    if parser.calls_zero {
        node = Node::Group(0, Box::new(node));
    }
    let groups = parser.groups;
    if parser.referenced > groups {
        return Err(INVALID_BACKREF.into());
    }
    resolve_calls(&mut node, groups, &parser.names)?;
    let callouts = callout::resolve_tags(parser.callouts, &parser.tags)?;
    Ok(Parsed {
        node: fold::unravel(node, false),
        groups,
        names: parser.names,
        callouts,
    })
}

/// Points every call at its group (check_call_reference), in tree order.
fn resolve_calls(
    node: &mut Node,
    groups: usize,
    names: &[(String, Vec<usize>)],
) -> Result<(), String> {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if let Node::Call(call) = node {
            if call.by_name {
                match names.iter().find(|(known, _)| *known == call.text) {
                    None => return Err(named("undefined name", &call.text)),
                    Some((_, found)) if found.len() > 1 => {
                        return Err(named("multiplex definition name", &call.text));
                    }
                    Some((_, found)) => call.group = found[0],
                }
            } else if call.group > groups {
                return Err(named("undefined group", &call.text));
            }
        }
        node.children_mut(&mut stack);
    }
    Ok(())
}

fn is_word(c: char) -> bool {
    class::contains(class::word(), c as u32)
}

/// A character a callout name or tag may hold.
fn is_callout_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

pub(super) fn seq(mut items: Vec<Node>) -> Node {
    match items.len() {
        0 => Node::Empty,
        1 => items.pop().unwrap_or(Node::Empty),
        _ => Node::Seq(items),
    }
}

fn alt(mut items: Vec<Node>) -> Node {
    match items.len() {
        1 => items.pop().unwrap_or(Node::Empty),
        _ => Node::Alt(items),
    }
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn peek_at(&self, ahead: usize) -> Option<char> {
        self.chars.get(self.at + ahead).copied()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.at += 1;
        Some(c)
    }

    fn at_end(&self) -> bool {
        self.at >= self.chars.len()
    }

    fn text(&self, from: usize, to: usize) -> String {
        self.chars[from..to].iter().collect()
    }

    fn enter(&mut self) -> Result<(), String> {
        self.depth += 1;
        if self.depth > PARSE_DEPTH_LIMIT {
            return Err(DEPTH_LIMIT.into());
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    fn save_id(&mut self) -> usize {
        self.saves += 1;
        self.saves
    }

    /// Skips what no token is made of: `(?#...)` comments, and under `x`
    /// blanks and `#` comments.
    fn skip(&mut self) -> Result<(), String> {
        loop {
            match self.peek() {
                Some(' ' | '\t' | '\n' | '\r' | '\x0c') if self.flags.extend => self.at += 1,
                Some('#') if self.flags.extend => {
                    while let Some(c) = self.next() {
                        if c == '\n' {
                            break;
                        }
                    }
                }
                Some('(') if self.peek_at(1) == Some('?') && self.peek_at(2) == Some('#') => {
                    self.at += 3;
                    loop {
                        match self.next() {
                            None => return Err(END_IN_GROUP.into()),
                            Some('\\') => {
                                self.next();
                            }
                            Some(')') => break,
                            Some(_) => {}
                        }
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    fn open(&self, kind: Body) -> Atom {
        Atom::Open {
            kind,
            flags: self.flags,
        }
    }

    fn branches(&mut self, kind: Body, flags: Flags) -> Result<Branches, String> {
        self.enter()?;
        self.enter()?;
        let saved = std::mem::replace(&mut self.flags, flags);
        Ok(Branches {
            kind,
            saved,
            branches: Vec::new(),
            items: Vec::new(),
        })
    }

    /// Groups retain their branches on a stack, so pattern nesting does
    /// not consume the host stack.
    fn alts(&mut self) -> Result<Node, String> {
        let mut frames = vec![self.branches(Body::Root, self.flags)?];
        loop {
            self.skip()?;
            let frame = frames.last_mut().expect("the root is open");
            let closed = match self.peek() {
                None if !matches!(frame.kind, Body::Root) => return Err(UNMATCHED_OPEN.into()),
                None => true,
                Some(')') if matches!(frame.kind, Body::Root) => return Err(UNMATCHED_CLOSE.into()),
                Some(')') => {
                    self.at += 1;
                    true
                }
                Some('|') => {
                    self.at += 1;
                    frame.branches.push(seq(std::mem::take(&mut frame.items)));
                    continue;
                }
                Some(_) => false,
            };
            let atom = if closed {
                let mut frame = frames.pop().expect("a closing group");
                frame.branches.push(seq(frame.items));
                self.flags = frame.saved;
                self.leave();
                self.leave();
                let node = alt(frame.branches);
                if matches!(frame.kind, Body::Root) {
                    return Ok(node);
                }
                self.finish_body(frame.kind, node)?
            } else {
                self.atom()?
            };
            match atom {
                Atom::Options(flags) => self.flags = flags,
                Atom::Open { kind, flags } => frames.push(self.branches(kind, flags)?),
                Atom::Node(node) => {
                    let node = self.quantified(node)?;
                    frames
                        .last_mut()
                        .expect("the parent remains open")
                        .items
                        .push(node);
                }
            }
        }
    }

    fn finish_body(&mut self, kind: Body, body: Node) -> Result<Atom, String> {
        Ok(Atom::Node(match kind {
            Body::Root => unreachable!("the root is returned directly"),
            Body::Plain => body,
            Body::Group(index) => Node::Group(index, Box::new(body)),
            Body::Look(behind, negate) => Node::Look {
                behind,
                negate,
                body: Box::new(body),
            },
            Body::Atomic => Node::Atomic(Box::new(body)),
            Body::Options => Node::Options(Box::new(body)),
            Body::Absent(head_bar) => self.absent_body(body, head_bar),
            Body::Condition => return self.condition_body(body, false),
            Body::Conditional { cond, then_empty } => {
                let (then, otherwise) = if then_empty {
                    (Node::Empty, body)
                } else {
                    match body {
                        Node::Alt(mut branches) => {
                            let then = branches.remove(0);
                            (then, alt(branches))
                        }
                        body => (body, Node::Empty),
                    }
                };
                Node::Cond {
                    cond,
                    then: Box::new(then),
                    otherwise: Box::new(otherwise),
                }
            }
        }))
    }

    /// A quantifier at the cursor: its bounds, whether it is greedy and
    /// whether it is possessive.
    fn quantifier(&mut self) -> Result<Option<Quantifier>, String> {
        let (min, max) = match self.peek() {
            Some('*') => (0, None),
            Some('+') => (1, None),
            Some('?') => (0, Some(1)),
            Some('{') => match self.interval()? {
                Some((min, max, end)) => {
                    self.at = end - 1;
                    (min, max)
                }
                None => return Ok(None),
            },
            _ => return Ok(None),
        };
        self.at += 1;
        if self.peek() == Some('?') {
            self.at += 1;
            return Ok(Some((min, max, false, false)));
        }
        if self.peek() == Some('+') {
            self.at += 1;
            return Ok(Some((min, max, true, true)));
        }
        Ok(Some((min, max, true, false)))
    }

    /// `{n,m}` at the cursor: its bounds and where it ends, or None when
    /// the brace is a plain character.
    #[allow(clippy::type_complexity)]
    fn interval(&self) -> Result<Option<(u32, Option<u32>, usize)>, String> {
        let mut at = self.at + 1;
        let number = |at: &mut usize| -> Result<Option<u32>, String> {
            let start = *at;
            let mut value: u64 = 0;
            while let Some(d) = self.chars.get(*at).and_then(|c| c.to_digit(10)) {
                value = value * 10 + u64::from(d);
                if value > u64::from(MAX_REPEAT) {
                    return Err(TOO_BIG_REPEAT.into());
                }
                *at += 1;
            }
            Ok((*at > start).then_some(value as u32))
        };
        let Some(low) = number(&mut at)? else {
            return Ok(None);
        };
        let (min, max) = match self.chars.get(at) {
            Some(',') => {
                at += 1;
                (low, number(&mut at)?)
            }
            _ => (low, Some(low)),
        };
        if self.chars.get(at) != Some(&'}') {
            return Ok(None);
        }
        if max.is_some_and(|max| min > max) {
            return Err(UPPER_SMALLER.into());
        }
        Ok(Some((min, max, at + 1)))
    }

    fn quantified(&mut self, mut node: Node) -> Result<Node, String> {
        let mut stacked = 0;
        loop {
            self.skip()?;
            let Some((min, max, greedy, possessive)) = self.quantifier()? else {
                return Ok(node);
            };
            if invalid_target(&node) {
                return Err(INVALID_TARGET.into());
            }
            stacked += 1;
            if self.depth + stacked > PARSE_DEPTH_LIMIT {
                return Err(DEPTH_LIMIT.into());
            }
            if min == 1 && max == Some(1) {
                continue;
            }
            let repeat = match node {
                Node::Repeat {
                    body,
                    min: inner,
                    max: Some(upper),
                    ..
                } if max == Some(min) && inner == upper => {
                    let count = fixed_count(min, inner).ok_or(TOO_BIG_REPEAT)?;
                    Node::Repeat {
                        body,
                        min: count,
                        max: Some(count),
                        greedy,
                    }
                }
                node => Node::Repeat {
                    body: Box::new(node),
                    min,
                    max,
                    greedy,
                },
            };
            node = if possessive {
                Node::Atomic(Box::new(repeat))
            } else {
                repeat
            };
        }
    }

    fn literal(&mut self, c: char) -> Node {
        if self.flags.ignore_case {
            Node::Caseless(c)
        } else {
            Node::Char(c)
        }
    }

    fn code_point(&mut self, code: u32) -> Node {
        match char::from_u32(code) {
            Some(c) => self.literal(c),
            None => Node::Set(Box::new(Set::empty())),
        }
    }

    fn atom(&mut self) -> Result<Atom, String> {
        let Some(c) = self.next() else {
            unreachable!("atom at the end")
        };
        match c {
            '\\' => self.escape().map(Atom::Node),
            '(' => self.group(),
            '[' => self.class().map(Atom::Node),
            c => self.plain(c).map(Atom::Node),
        }
    }

    /// An atom that opens nothing.
    fn plain(&mut self, c: char) -> Result<Node, String> {
        Ok(match c {
            '.' => Node::Any(self.flags.dotall),
            '*' | '+' | '?' => return Err(NOT_SPECIFIED.into()),
            '{' => {
                self.at -= 1;
                if self.interval()?.is_some() {
                    return Err(NOT_SPECIFIED.into());
                }
                self.at += 1;
                self.literal('{')
            }
            '^' => Node::Anchor(if self.flags.singleline {
                Anchor::BufStart
            } else {
                Anchor::LineStart
            }),
            '$' => Node::Anchor(if self.flags.singleline {
                Anchor::SemiEnd
            } else {
                Anchor::LineEnd
            }),
            c => self.literal(c),
        })
    }

    fn hex(&mut self, max: usize) -> Result<(u32, usize), String> {
        let mut code: u32 = 0;
        let mut n = 0;
        while n < max {
            let Some(d) = self.peek().and_then(|c| c.to_digit(16)) else {
                break;
            };
            code = code.checked_mul(16).ok_or(TOO_BIG_NUMBER)? + d;
            self.at += 1;
            n += 1;
        }
        Ok((code, n))
    }

    fn octal(&mut self, max: usize) -> Result<(u32, usize), String> {
        let mut code: u32 = 0;
        let mut n = 0;
        while n < max {
            let Some(d) = self.peek().and_then(|c| c.to_digit(8)) else {
                break;
            };
            code = code.checked_mul(8).ok_or(TOO_BIG_NUMBER)? + d;
            self.at += 1;
            n += 1;
        }
        Ok((code, n))
    }

    /// `\x{...}` or `\o{...}` after the brace: its code points, or None
    /// when no digit follows and the escape is a plain letter.
    fn braced(&mut self, base: u32) -> Result<Option<Vec<u32>>, String> {
        let start = self.at;
        let max = if base == 16 { 8 } else { 11 };
        let read = |parser: &mut Parser| {
            if base == 16 {
                parser.hex(max)
            } else {
                parser.octal(max)
            }
        };
        let digit = |c: Option<char>| c.is_some_and(|c| c.is_digit(base));
        let (first, n) = read(self)?;
        if n == 0 {
            self.at = start;
            return Ok(None);
        }
        if digit(self.peek()) {
            return Err(TOO_LONG_WIDE.into());
        }
        let mut codes = vec![first];
        loop {
            match self.next() {
                Some('}') => return Ok(Some(codes)),
                Some(' ' | '\n') => {
                    while matches!(self.peek(), Some(' ' | '\n')) {
                        self.at += 1;
                    }
                    if self.peek() == Some('}') {
                        self.at += 1;
                        return Ok(Some(codes));
                    }
                    let (code, n) = read(self)?;
                    if n == 0 {
                        return Err(INVALID_CODE_POINT.into());
                    }
                    if digit(self.peek()) {
                        return Err(TOO_LONG_WIDE.into());
                    }
                    codes.push(code);
                }
                _ => return Err(INVALID_CODE_POINT.into()),
            }
        }
    }

    /// `\cx` and the control letters, after the backslash: the code point
    /// a plain escape names.
    fn escaped_value(&mut self) -> Result<u32, String> {
        let Some(c) = self.next() else {
            return Err(END_AT_ESCAPE.into());
        };
        Ok(match c {
            'c' => {
                // `\c\c...x` nests one control escape in the next; read the
                // chain with a loop: masking twice masks as once.
                let mut nested = false;
                loop {
                    let Some(c) = self.next() else {
                        return Err(END_AT_CONTROL.into());
                    };
                    match c {
                        '?' if nested => break 0x7f & 0x9f,
                        '?' => break 0x7f,
                        '\\' => match self.peek() {
                            Some('c') => {
                                self.next();
                                nested = true;
                            }
                            _ => break self.escaped_value()? & 0x9f,
                        },
                        c => break (c as u32) & 0x9f,
                    }
                }
            }
            'n' => 0x0a,
            't' => 0x09,
            'r' => 0x0d,
            'f' => 0x0c,
            'a' => 0x07,
            'b' => 0x08,
            'e' => 0x1b,
            c => c as u32,
        })
    }

    /// The raw bytes `\xHH` and octal escapes name, run together into one
    /// UTF-8 character when the first byte leads one.
    fn crude(&mut self, first: u8) -> Result<Node, String> {
        let len = match first {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        if len == 1 {
            return Ok(if first < 0x80 {
                self.literal(char::from(first))
            } else {
                Node::Byte(first)
            });
        }
        let mut bytes = vec![first];
        while bytes.len() < len {
            match self.crude_byte()? {
                Some(byte) => bytes.push(byte),
                None => return Err(TOO_SHORT_MULTIBYTE.into()),
            }
        }
        match std::str::from_utf8(&bytes) {
            Ok(text) => Ok(self.literal(text.chars().next().unwrap_or('\0'))),
            Err(_) => Err(INVALID_CODE_POINT.into()),
        }
    }

    /// The next token when it is a `\xHH` or octal byte.
    fn crude_byte(&mut self) -> Result<Option<u8>, String> {
        let start = self.at;
        if self.peek() != Some('\\') {
            return Ok(None);
        }
        self.at += 1;
        match self.next() {
            Some('x') if self.peek() != Some('{') => Ok(Some(self.hex(2)?.0 as u8)),
            Some(c @ '0'..='7') => {
                if c != '0' {
                    self.at -= 1;
                }
                let (code, _) = self.octal(if c == '0' { 2 } else { 3 })?;
                if code >= 256 {
                    return Err(TOO_BIG_NUMBER.into());
                }
                Ok(Some(code as u8))
            }
            _ => {
                self.at = start;
                Ok(None)
            }
        }
    }

    fn escape(&mut self) -> Result<Node, String> {
        let Some(c) = self.next() else {
            return Err(END_AT_ESCAPE.into());
        };
        Ok(match c {
            'w' => Node::Set(Box::new(class::word().clone())),
            'W' => Node::Set(Box::new(class::negate(class::word().clone()))),
            's' | 'S' | 'd' | 'D' => {
                let ctype = if c.eq_ignore_ascii_case(&'s') {
                    Ctype::Space
                } else {
                    Ctype::Digit
                };
                let set = class::ctype(ctype, false).clone();
                Node::Set(Box::new(if c.is_ascii_uppercase() {
                    class::negate(set)
                } else {
                    set
                }))
            }
            'b' => Node::Anchor(Anchor::WordBoundary),
            'B' => Node::Anchor(Anchor::NotWordBoundary),
            'y' => Node::Anchor(Anchor::TextSegmentBoundary),
            'Y' => Node::Anchor(Anchor::NotTextSegmentBoundary),
            'X' => Node::TextSegment,
            'K' => Node::Keep,
            'R' => Node::Newline,
            'N' => Node::Any(false),
            'O' => Node::Any(true),
            'A' => Node::Anchor(Anchor::BufStart),
            'Z' => Node::Anchor(Anchor::SemiEnd),
            'z' => Node::Anchor(Anchor::BufEnd),
            'G' => Node::Anchor(Anchor::SearchStart),
            'o' | 'x' if self.peek() == Some('{') => {
                self.at += 1;
                match self.braced(if c == 'x' { 16 } else { 8 })? {
                    Some(codes) => seq(codes
                        .into_iter()
                        .map(|code| self.code_point(code))
                        .collect()),
                    None => {
                        self.at -= 1;
                        self.literal(c)
                    }
                }
            }
            'x' => {
                let (code, _) = self.hex(2)?;
                self.crude(code as u8)?
            }
            '1'..='9' => {
                let start = self.at - 1;
                let mut number: usize = 0;
                let mut overflow = false;
                self.at = start;
                while let Some(d) = self.peek().and_then(|c| c.to_digit(10)) {
                    number = number.saturating_mul(10).saturating_add(d as usize);
                    overflow |= number > i32::MAX as usize;
                    self.at += 1;
                }
                if !overflow && number <= MAX_BACKREF && (number <= self.groups || number <= 9) {
                    self.referenced = self.referenced.max(number);
                    Node::Backref {
                        groups: vec![number],
                        fold: self.flags.ignore_case,
                        level: None,
                    }
                } else if c == '8' || c == '9' {
                    self.at = start + 1;
                    self.literal(c)
                } else {
                    self.at = start;
                    let (code, _) = self.octal(3)?;
                    if code >= 256 {
                        return Err(TOO_BIG_NUMBER.into());
                    }
                    self.crude(code as u8)?
                }
            }
            '0' => {
                let (code, _) = self.octal(2)?;
                self.crude(code as u8)?
            }
            'k' if matches!(self.peek(), Some('<' | '\'')) => {
                let open = self.next().unwrap_or('<');
                let (groups, level) = self.reference(open)?;
                Node::Backref {
                    groups,
                    fold: self.flags.ignore_case,
                    level,
                }
            }
            'g' if matches!(self.peek(), Some('<' | '\'')) => {
                let open = self.next().unwrap_or('<');
                Node::Call(self.call(open)?)
            }
            'Q' => {
                let mut items = Vec::new();
                while let Some(c) = self.next() {
                    if c == '\\' && self.peek() == Some('E') {
                        self.at += 1;
                        break;
                    }
                    items.push(self.literal(c));
                }
                seq(items)
            }
            'p' | 'P' if self.peek() == Some('{') => {
                self.at += 1;
                let mut negate = c == 'P';
                if self.peek() == Some('^') {
                    self.at += 1;
                    negate = !negate;
                }
                let set = self.property()?;
                Node::Set(Box::new(if negate { class::negate(set) } else { set }))
            }
            _ => {
                self.at -= 1;
                let code = self.escaped_value()?;
                self.code_point(code)
            }
        })
    }

    /// `\p{name}` after the brace (and any `^`).
    fn property(&mut self) -> Result<Set, String> {
        let start = self.at;
        loop {
            match self.next() {
                Some('}') => {
                    let name = self.text(start, self.at - 1);
                    return class::property(&name)
                        .ok_or_else(|| named("invalid character property name", &name));
                }
                None | Some('(' | ')' | '{' | '|') => return Err(UNMATCHED_OPEN.into()),
                Some(_) => {}
            }
        }
    }

    /// A group name or number after `<`, `'` or `(`, up to and past its
    /// closing mark (fetch_name); `is_ref` allows numbers.
    fn name(&mut self, open: char, is_ref: bool) -> Result<Name, String> {
        let close = close_of(open);
        let src = self.at;
        let Some(first) = self.next() else {
            return Err(EMPTY_NAME.into());
        };
        if first == close {
            return Err(EMPTY_NAME.into());
        }
        let mut error: Option<&str> = None;
        let mut numeric = NumType::Not;
        let mut sign = 1i64;
        let mut num_head = src;
        if first.is_ascii_digit() {
            if is_ref {
                numeric = NumType::Abs;
            } else {
                error = Some(INVALID_GROUP_NAME);
            }
        } else if first == '-' || first == '+' {
            if is_ref {
                numeric = NumType::Rel;
                sign = if first == '-' { -1 } else { 1 };
                num_head = self.at;
            } else {
                error = Some(INVALID_GROUP_NAME);
            }
        } else if !is_word(first) {
            error = Some(INVALID_CHAR_IN_NAME);
        }
        let mut name_end = self.chars.len();
        let mut c = first;
        if let Some(error) = error {
            while let Some(ch) = self.next() {
                name_end = self.at - 1;
                if ch == close || ch == ')' {
                    break;
                }
            }
            if self.at_end() {
                name_end = self.chars.len();
            }
            return Err(named(error, &self.text(src, name_end)));
        }
        while let Some(ch) = self.next() {
            name_end = self.at - 1;
            c = ch;
            if c == close || c == ')' {
                break;
            }
            if numeric != NumType::Not && !c.is_ascii_digit() {
                numeric = NumType::Not;
            }
        }
        if c != close {
            return Err(named(INVALID_GROUP_NAME, &self.text(src, name_end)));
        }
        let text = self.text(src, name_end);
        if numeric == NumType::Not {
            return Ok(Name::Text(text));
        }
        let number = self.number(num_head, name_end)?;
        if number == 0 && numeric == NumType::Rel {
            return Err(named(INVALID_GROUP_NAME, &text));
        }
        Ok(Name::Number(self.absolute(numeric, sign * number), text))
    }

    /// A reference's name or number after `<` or `'` (or, for a
    /// condition, `(`), with its recursion level `+n`/`-n` when given
    /// (fetch_name_with_level).
    fn name_with_level(&mut self, open: char) -> Result<(Name, Option<i64>), String> {
        let close = close_of(open);
        let src = self.at;
        let Some(first) = self.next() else {
            return Err(EMPTY_NAME.into());
        };
        if first == close {
            return Err(EMPTY_NAME.into());
        }
        let mut error: Option<&str> = None;
        let mut numeric = NumType::Not;
        let mut sign = 1i64;
        let mut digits = 0;
        let mut num_head = src;
        if first.is_ascii_digit() {
            numeric = NumType::Abs;
            digits += 1;
        } else if first == '-' || first == '+' {
            numeric = NumType::Rel;
            sign = if first == '-' { -1 } else { 1 };
            num_head = self.at;
        } else if !is_word(first) {
            error = Some(INVALID_CHAR_IN_NAME);
        }
        let mut name_end = self.chars.len();
        let mut c = first;
        while let Some(ch) = self.next() {
            name_end = self.at - 1;
            c = ch;
            if c == close || c == ')' || c == '+' || c == '-' {
                if numeric != NumType::Not && digits == 0 {
                    error = Some(INVALID_GROUP_NAME);
                }
                break;
            }
            if numeric != NumType::Not {
                if c.is_ascii_digit() {
                    digits += 1;
                } else {
                    error = Some(INVALID_GROUP_NAME);
                    numeric = NumType::Not;
                }
            } else if !is_word(c) {
                error = Some(INVALID_CHAR_IN_NAME);
            }
        }
        let mut level = None;
        if error.is_none() && c != close {
            let mut bad = true;
            if c == '+' || c == '-' {
                let flag = if c == '-' { -1 } else { 1 };
                if self.at_end() {
                    return Err(named(INVALID_CHAR_IN_NAME, &self.text(src, name_end)));
                }
                if self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    let start = self.at;
                    while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                        self.at += 1;
                    }
                    let value = self.number(start, self.at)?;
                    level = Some(flag * value);
                    if self.next() == Some(close) {
                        bad = false;
                    }
                }
            }
            if bad {
                return Err(named(INVALID_GROUP_NAME, &self.text(src, self.chars.len())));
            }
        }
        if let Some(error) = error {
            return Err(named(error, &self.text(src, name_end)));
        }
        let text = self.text(src, name_end);
        if numeric == NumType::Not {
            return Ok((Name::Text(text), level));
        }
        let number = self.number(num_head, name_end)?;
        if number == 0 && numeric == NumType::Rel {
            return Err(named(INVALID_GROUP_NAME, &text));
        }
        Ok((
            Name::Number(self.absolute(numeric, sign * number), text),
            level,
        ))
    }

    /// The decimal in `chars[from..to]`, which scan_number limits to i32.
    fn number(&self, from: usize, to: usize) -> Result<i64, String> {
        let mut value: i64 = 0;
        for c in &self.chars[from..to] {
            let Some(d) = c.to_digit(10) else {
                break;
            };
            value = value * 10 + i64::from(d);
            if value > i64::from(i32::MAX) {
                return Err(TOO_BIG_NUMBER.into());
            }
        }
        Ok(value)
    }

    /// backref_rel_to_abs: a relative number counted from the groups open
    /// so far.
    fn absolute(&self, numeric: NumType, number: i64) -> i64 {
        match numeric {
            NumType::Rel if number > 0 => self.groups as i64 + number,
            NumType::Rel => self.groups as i64 + 1 + number,
            _ => number,
        }
    }

    /// The groups `\k<...>` or a condition names, and the level.
    #[allow(clippy::type_complexity)]
    fn reference(&mut self, open: char) -> Result<(Vec<usize>, Option<i64>), String> {
        let (name, level) = self.name_with_level(open)?;
        self.resolve(name, level)
    }

    /// The groups a reference's name or number stands for.
    #[allow(clippy::type_complexity)]
    fn resolve(
        &mut self,
        name: Name,
        level: Option<i64>,
    ) -> Result<(Vec<usize>, Option<i64>), String> {
        match name {
            Name::Number(number, _) => {
                if number <= 0 {
                    return Err(INVALID_BACKREF.into());
                }
                let number = usize::try_from(number).map_err(|_| INVALID_BACKREF)?;
                self.referenced = self.referenced.max(number);
                Ok((vec![number], level))
            }
            Name::Text(text) => match self.names.iter().find(|(known, _)| *known == text) {
                Some((_, groups)) => Ok((groups.clone(), level)),
                None => Err(named("undefined name", &text)),
            },
        }
    }

    /// The call `\g<...>`, `(?&...)` or `(?n)` names, `open` being the
    /// bracket read.
    fn call(&mut self, open: char) -> Result<Call, String> {
        let name = if open == '&' {
            self.name('(', false)?
        } else {
            self.name(open, true)?
        };
        let call = match name {
            Name::Number(number, text) => {
                if number < 0 {
                    return Err(named("undefined group", &text));
                }
                if number == 0 {
                    self.calls_zero = true;
                }
                Call {
                    group: number as usize,
                    text,
                    by_name: false,
                    recursive: false,
                }
            }
            Name::Text(text) if open == '(' => {
                let _ = text;
                return Err(named(INVALID_GROUP_NAME, ""));
            }
            Name::Text(text) => Call {
                group: 0,
                text,
                by_name: true,
                recursive: false,
            },
        };
        Ok(call)
    }

    fn open_group(&mut self) -> usize {
        self.groups += 1;
        self.groups
    }

    fn group(&mut self) -> Result<Atom, String> {
        match self.peek() {
            None => Err(UNMATCHED_OPEN.into()),
            Some('*') => {
                self.at += 1;
                self.callout_name().map(Atom::Node)
            }
            Some('?') => {
                self.at += 1;
                self.extended()
            }
            Some(_) => {
                let index = self.open_group();
                Ok(self.open(Body::Group(index)))
            }
        }
    }

    /// A group after `(?`: what it opens is read first, so the body is
    /// parsed from one place.
    fn extended(&mut self) -> Result<Atom, String> {
        let kind = match self.extended_kind()? {
            Kind::Done(atom) => return Ok(atom),
            Kind::Absent => return self.absent(),
            Kind::Cond => return self.condition(),
            Kind::Options => return self.options(),
            kind => kind,
        };
        Ok(self.open(match kind {
            Kind::Plain => Body::Plain,
            Kind::Look(behind, negate) => Body::Look(behind, negate),
            Kind::Atomic => Body::Atomic,
            Kind::Named(index) => Body::Group(index),
            Kind::Done(_) | Kind::Absent | Kind::Cond | Kind::Options => {
                unreachable!("handled above")
            }
        }))
    }

    /// What `(?` opens, reading up to its body.
    fn extended_kind(&mut self) -> Result<Kind, String> {
        let Some(c) = self.next() else {
            return Err(END_IN_GROUP.into());
        };
        Ok(match c {
            ':' => Kind::Plain,
            '=' | '!' => Kind::Look(false, c == '!'),
            '>' => Kind::Atomic,
            '<' => match self.peek() {
                None => return Err(UNMATCHED_OPEN.into()),
                Some(c @ ('=' | '!')) => {
                    self.at += 1;
                    Kind::Look(true, c == '!')
                }
                Some(_) => Kind::Named(self.named('<')?),
            },
            '\'' => Kind::Named(self.named('\'')?),
            '~' => Kind::Absent,
            '{' => Kind::Done(Atom::Node(self.callout_contents()?)),
            '(' => Kind::Cond,
            '&' => Kind::Done(Atom::Node(Node::Call(self.call('&')?))),
            'R' => Kind::Done(Atom::Node(self.call_whole()?)),
            '0'..='9' => {
                self.at -= 1;
                Kind::Done(Atom::Node(Node::Call(self.call('(')?)))
            }
            '-' | '+' if self.peek().is_some_and(|c| c.is_ascii_digit()) => {
                self.at -= 1;
                Kind::Done(Atom::Node(Node::Call(self.call('(')?)))
            }
            '-' | 'i' | 'm' | 's' | 'x' => {
                self.at -= 1;
                Kind::Options
            }
            _ => return Err(UNDEFINED_OPTION.into()),
        })
    }

    /// `(?R)`, which Oniguruma reads as a call of the whole pattern and
    /// leaves the `)` in place, so it then closes nothing.
    fn call_whole(&mut self) -> Result<Node, String> {
        if self.peek() != Some(')') {
            return Err(UNDEFINED_OPTION.into());
        }
        self.calls_zero = true;
        Ok(Node::Call(Call {
            group: 0,
            text: String::new(),
            by_name: false,
            recursive: false,
        }))
    }

    /// Opens the group `(?<name>` or `(?'name'` names: its index.
    fn named(&mut self, open: char) -> Result<usize, String> {
        let Name::Text(name) = self.name(open, false)? else {
            unreachable!("a definition takes no number")
        };
        let index = self.open_group();
        match self.names.iter_mut().find(|(known, _)| *known == name) {
            Some((_, groups)) => groups.push(index),
            None => self.names.push((name, vec![index])),
        }
        Ok(index)
    }

    fn options(&mut self) -> Result<Atom, String> {
        let mut flags = self.flags;
        let mut negate = false;
        loop {
            let Some(c) = self.next() else {
                return Err(END_IN_GROUP.into());
            };
            match c {
                ')' => return Ok(Atom::Options(flags)),
                ':' => {
                    return Ok(Atom::Open {
                        kind: Body::Options,
                        flags,
                    });
                }
                '-' => negate = true,
                'i' => flags.ignore_case = !negate,
                'x' => flags.extend = !negate,
                's' => flags.dotall = !negate,
                'm' => flags.singleline = negate,
                _ => return Err(UNDEFINED_OPTION.into()),
            }
        }
    }

    /// `(?(cond)yes|no)` after `(?(`.
    fn condition(&mut self) -> Result<Atom, String> {
        let Some(c) = self.next() else {
            return Err(END_IN_GROUP.into());
        };
        if self.at_end() {
            return Err(END_IN_GROUP.into());
        }
        let start = self.at;
        let mut cond = None;
        let mut checker = false;
        if c.is_ascii_digit() || c == '-' || c == '+' || c == '<' || c == '\'' {
            let enclosed = c == '<' || c == '\'';
            if !enclosed {
                self.at -= 1;
            }
            match self.name_with_level(if enclosed { c } else { '(' }) {
                Ok((name, level)) => {
                    let (groups, level) = self.resolve(name, level)?;
                    if enclosed && self.next() != Some(')') {
                        return Err(END_IN_GROUP.into());
                    }
                    cond = Some(Node::Check { groups, level });
                    checker = true;
                }
                Err(error) if enclosed => return Err(error),
                // A number or name that does not read is a plain
                // condition instead.
                Err(_) => self.at = start - 1,
            }
        } else if c == '?' && self.peek() == Some('{') {
            self.at += 1;
            cond = Some(self.callout_contents()?);
        } else if c == '*' {
            cond = Some(self.callout_name()?);
        } else {
            self.at -= 1;
        }
        match cond {
            Some(cond) => self.condition_body(cond, checker),
            None => Ok(self.open(Body::Condition)),
        }
    }

    fn condition_body(&mut self, cond: Node, checker: bool) -> Result<Atom, String> {
        if self.at_end() {
            return Err(END_IN_GROUP.into());
        }
        if self.peek() == Some(')') {
            if !checker {
                return Err(INVALID_IF_ELSE.into());
            }
            self.at += 1;
            return Ok(Atom::Node(cond));
        }
        let then_empty = self.peek() == Some('|');
        if then_empty {
            self.at += 1;
        }
        Ok(self.open(Body::Conditional {
            cond: Box::new(cond),
            then_empty,
        }))
    }

    /// `(?~absent)`, `(?~|absent|exp)`, `(?~|absent)` and `(?~|)` after
    /// `(?~`, built as Oniguruma's make_absent_tree builds them.
    fn absent(&mut self) -> Result<Atom, String> {
        if self.at_end() {
            return Err(END_IN_GROUP.into());
        }
        let head_bar = self.peek() == Some('|');
        if head_bar {
            self.at += 1;
            if self.at_end() {
                return Err(END_IN_GROUP.into());
            }
            if self.peek() == Some(')') {
                self.at += 1;
                return Ok(Atom::Node(self.range_clear()));
            }
        }
        Ok(self.open(Body::Absent(head_bar)))
    }

    fn absent_body(&mut self, parsed: Node, head_bar: bool) -> Node {
        let (absent, expr, cutter) = if head_bar {
            match parsed {
                Node::Alt(mut branches) => {
                    let absent = branches.remove(0);
                    (absent, Some(alt(branches)), false)
                }
                absent => (absent, None, true),
            }
        } else {
            (parsed, None, false)
        };
        self.absent_tree(absent, expr, cutter)
    }

    fn range_clear(&mut self) -> Node {
        let id = self.save_id();
        Node::Seq(vec![
            Node::SaveVal(Saved::Right, id),
            Node::Super(vec![
                Node::UpdateVar(Update::RightInit, true),
                Node::Seq(vec![
                    Node::UpdateVar(Update::RightFromRight(id), false),
                    Node::Fail,
                ]),
            ]),
        ])
    }

    fn absent_tree(&mut self, absent: Node, expr: Option<Node>, cutter: bool) -> Node {
        if cutter {
            return self.absent_general(absent, expr, true);
        }
        let (min, max, body, possessive) = match expr {
            None => (0, None, Node::Any(true), false),
            Some(expr) => match one_char_repeat(expr) {
                Ok(simple) => simple,
                Err(expr) => return self.absent_general(absent, Some(expr), false),
            },
        };
        let id = self.save_id();
        Node::Seq(vec![
            Node::SaveVal(Saved::Right, id),
            self.absent_engine(id, absent, body, min, max, possessive, false),
            Node::UpdateVar(Update::RightFromRight(id), false),
        ])
    }

    fn absent_general(&mut self, absent: Node, expr: Option<Node>, cutter: bool) -> Node {
        let id1 = self.save_id();
        let id2 = self.save_id();
        let engine = self.absent_engine(id1, absent, Node::Any(true), 0, None, true, cutter);
        let mut items = vec![
            Node::SaveVal(Saved::Right, id1),
            Node::SaveVal(Saved::Pos, id2),
            engine,
            Node::UpdateVar(Update::PosFromPos(id2), false),
        ];
        if !cutter {
            let id = self.save_id();
            items.push(expr.unwrap_or(Node::Empty));
            items.push(Node::SaveVal(Saved::Right, id));
            items.push(Node::Alt(vec![
                Node::UpdateVar(Update::RightFromRight(id1), false),
                Node::Seq(vec![
                    Node::UpdateVar(Update::RightFromRight(id), false),
                    Node::Fail,
                ]),
            ]));
        }
        Node::Seq(items)
    }

    /// make_absent_engine: a loop over `step` that fails once `absent`
    /// matches ahead, narrowing the right range to where it did.
    #[allow(clippy::too_many_arguments)]
    fn absent_engine(
        &mut self,
        saved_right: usize,
        absent: Node,
        step: Node,
        min: u32,
        max: Option<u32>,
        possessive: bool,
        cutter: bool,
    ) -> Node {
        let id = self.save_id();
        let body = Node::Alt(vec![
            Node::Seq(vec![
                Node::SaveVal(Saved::Pos, id),
                absent,
                Node::UpdateVar(Update::RightFromPos(id), cutter),
                Node::Fail,
            ]),
            step,
        ]);
        let mut repeat = Node::Repeat {
            body: Box::new(body),
            min,
            max,
            greedy: true,
        };
        if possessive {
            repeat = Node::Atomic(Box::new(repeat));
        }
        let branches = vec![
            repeat,
            Node::Seq(vec![
                Node::UpdateVar(Update::RightFromRight(saved_right), false),
                Node::Fail,
            ]),
        ];
        if cutter {
            Node::Super(branches)
        } else {
            Node::Alt(branches)
        }
    }

    /// `(?{...}[tag]X)` after `(?{`, which runs nothing: jq sets no
    /// callout function.
    fn callout_contents(&mut self) -> Result<Node, String> {
        if self.at_end() {
            return Err(INVALID_CALLOUT_PATTERN.into());
        }
        let mut nest = 0;
        while self.peek() == Some('{') {
            nest += 1;
            self.at += 1;
            if self.at_end() {
                return Err(INVALID_CALLOUT_PATTERN.into());
            }
        }
        loop {
            let Some(c) = self.next() else {
                return Err(INVALID_CALLOUT_PATTERN.into());
            };
            if c != '}' {
                continue;
            }
            let mut left = nest;
            while left > 0 {
                let Some(c) = self.next() else {
                    return Err(INVALID_CALLOUT_PATTERN.into());
                };
                if c != '}' {
                    break;
                }
                left -= 1;
            }
            if left == 0 {
                break;
            }
        }
        let Some(mut c) = self.next() else {
            return Err(END_IN_GROUP.into());
        };
        let mut tag = None;
        if c == '[' {
            tag = Some(self.tag()?);
            let Some(next) = self.next() else {
                return Err(END_IN_GROUP.into());
            };
            c = next;
        }
        if matches!(c, 'X' | '<' | '>') {
            let Some(next) = self.next() else {
                return Err(END_IN_GROUP.into());
            };
            c = next;
        }
        if c != ')' {
            return Err(INVALID_CALLOUT_PATTERN.into());
        }
        self.register(Callout {
            kind: CalloutKind::Contents,
            tag,
        })
    }

    /// `[tag]` after the bracket: the tag, past its `]`.
    fn tag(&mut self) -> Result<String, String> {
        if self.at_end() {
            return Err(END_IN_GROUP.into());
        }
        let start = self.at;
        let mut end = self.at;
        while let Some(c) = self.next() {
            end = self.at - 1;
            if c == ']' {
                break;
            }
        }
        let text = self.text(start, end);
        if text.is_empty()
            || !text.chars().all(is_callout_name_char)
            || text.starts_with(|c: char| c.is_ascii_digit())
        {
            return Err(INVALID_CALLOUT_TAG.into());
        }
        Ok(text)
    }

    fn register(&mut self, callout: Callout) -> Result<Node, String> {
        let index = self.callouts.len();
        if let Some(tag) = &callout.tag {
            if self.tags.iter().any(|(known, _)| known == tag) {
                return Err(named("multiplex defined name", tag));
            }
            self.tags.push((tag.clone(), index));
        }
        self.callouts.push(callout);
        Ok(Node::Callout(index))
    }

    /// `(*name[tag]{args})` after `(*`.
    fn callout_name(&mut self) -> Result<Node, String> {
        if self.at_end() {
            return Err(INVALID_CALLOUT_PATTERN.into());
        }
        let start = self.at;
        let mut c;
        loop {
            let Some(next) = self.next() else {
                return Err(END_IN_GROUP.into());
            };
            c = next;
            if c == ')' || c == '[' || c == '{' {
                break;
            }
        }
        let name = self.text(start, self.at - 1);
        if name.is_empty()
            || !name.chars().all(is_callout_name_char)
            || name.starts_with(|c: char| c.is_ascii_digit())
        {
            return Err(INVALID_CALLOUT_NAME.into());
        }
        let mut tag = None;
        if c == '[' {
            tag = Some(self.tag()?);
            let Some(next) = self.next() else {
                return Err(END_IN_GROUP.into());
            };
            c = next;
        }
        let mut args = Vec::new();
        if c == '{' {
            if self.at_end() {
                return Err(END_IN_GROUP.into());
            }
            let save = self.at;
            self.callout_args(None)?;
            self.at = save;
            let Some(builtin) = callout::builtin(&name) else {
                return Err(UNDEFINED_CALLOUT_NAME.into());
            };
            args = self.callout_args(Some(builtin.types))?;
            let Some(next) = self.next() else {
                return Err(END_IN_GROUP.into());
            };
            c = next;
        }
        let Some(builtin) = callout::builtin(&name) else {
            return Err(UNDEFINED_CALLOUT_NAME.into());
        };
        if args.len() > builtin.types.len() || args.len() < builtin.types.len() - builtin.optional {
            return Err(INVALID_CALLOUT_ARG.into());
        }
        if c != ')' {
            return Err(INVALID_CALLOUT_PATTERN.into());
        }
        let kind = (builtin.build)(&args);
        self.register(Callout { kind, tag })
    }

    /// The arguments up to `}` (prs_callout_args): only checked when
    /// `types` is None, else each read as its type.
    fn callout_args(&mut self, types: Option<&[callout::Type]>) -> Result<Vec<Arg>, String> {
        const MAX_ARG_BYTES: usize = 128;
        if self.at_end() {
            return Err(INVALID_CALLOUT_PATTERN.into());
        }
        let mut args = Vec::new();
        let mut count = 0;
        let mut c = ' ';
        while count < callout::MAX_ARGS {
            let mut text = String::new();
            let mut escaped = false;
            let mut escapes = false;
            let mut chars = 0;
            loop {
                let Some(next) = self.next() else {
                    return Err(INVALID_CALLOUT_PATTERN.into());
                };
                c = next;
                if escaped {
                    escaped = false;
                    if !(c == '\\' || c == '}' || c == ',') {
                        text.push('\\');
                        chars += 1;
                    }
                } else if c == '\\' {
                    escaped = true;
                    escapes = true;
                    continue;
                } else if c == '}' || c == ',' {
                    break;
                }
                if types.is_some() && text.len() + c.len_utf8() > MAX_ARG_BYTES {
                    return Err(INVALID_CALLOUT_ARG.into());
                }
                text.push(c);
                chars += 1;
            }
            if chars != 0 {
                if let Some(types) = types {
                    let Some(kind) = types.get(count) else {
                        return Err(INVALID_CALLOUT_ARG.into());
                    };
                    args.push(callout::arg(*kind, &text, chars, escapes)?);
                }
                count += 1;
            }
            if c == '}' {
                break;
            }
        }
        if c != '}' {
            return Err(INVALID_CALLOUT_PATTERN.into());
        }
        Ok(args)
    }

    fn class(&mut self) -> Result<Node, String> {
        self.enter()?;
        let negate = self.peek() == Some('^');
        if negate {
            self.at += 1;
        }
        let mut item = self.class_item()?;
        if matches!(item, Item::Close) {
            if !self.closes_later() {
                return Err(EMPTY_CLASS.into());
            }
            item = Item::Char(']' as u32);
        }
        let mut set = Set::empty();
        let add = |set: &mut Set, from: u32, to: u32| {
            if let (Some(from), Some(to)) = (char::from_u32(from), char::from_u32(to.min(0x10FFFF)))
            {
                set.union(&class::range(from, to));
            }
        };
        enum State {
            Start,
            Value(u32),
            Prop,
            Range(u32),
            Complete,
        }
        let mut state = State::Start;
        loop {
            match item {
                Item::Close => break,
                Item::Char(c) => {
                    state = match state {
                        State::Value(prev) => {
                            add(&mut set, prev, prev);
                            State::Value(c)
                        }
                        State::Range(from) => {
                            if from > c {
                                return Err(EMPTY_RANGE.into());
                            }
                            add(&mut set, from, c);
                            State::Complete
                        }
                        _ => State::Value(c),
                    };
                }
                Item::Set(members) => {
                    match state {
                        State::Range(_) => return Err(VALUE_AT_END_OF_RANGE.into()),
                        State::Value(prev) => add(&mut set, prev, prev),
                        _ => {}
                    }
                    set.union(&members);
                    state = State::Prop;
                }
                Item::Range => match state {
                    State::Value(prev) => {
                        let next = self.class_item()?;
                        match next {
                            Item::Close => {
                                add(&mut set, prev, prev);
                                add(&mut set, '-' as u32, '-' as u32);
                                break;
                            }
                            next => {
                                state = State::Range(prev);
                                item = next;
                                continue;
                            }
                        }
                    }
                    State::Prop => {
                        state = State::Value('-' as u32);
                        item = self.class_item()?;
                        continue;
                    }
                    State::Start => state = State::Value('-' as u32),
                    State::Range(from) => {
                        if from > '-' as u32 {
                            return Err(EMPTY_RANGE.into());
                        }
                        add(&mut set, from, '-' as u32);
                        state = State::Complete;
                    }
                    State::Complete => {
                        let next = self.class_item()?;
                        if matches!(next, Item::Close) {
                            add(&mut set, '-' as u32, '-' as u32);
                            break;
                        }
                        state = State::Value('-' as u32);
                        item = next;
                        continue;
                    }
                },
            }
            item = self.class_item()?;
        }
        if let State::Value(prev) = state {
            add(&mut set, prev, prev);
        }
        if self.flags.ignore_case {
            set = fold::close(set);
        }
        if negate {
            set = class::negate(set);
        }
        self.leave();
        let alternatives = if self.flags.ignore_case && !negate {
            fold::alternatives(&set)
        } else {
            Vec::new()
        };
        let class = Node::Set(Box::new(set));
        if alternatives.is_empty() {
            return Ok(class);
        }
        Ok(Node::Alt(once(class).chain(alternatives).collect()))
    }

    /// Whether an unescaped `]` follows, so `[]` starts a class holding
    /// `]`.
    fn closes_later(&self) -> bool {
        let mut escaped = false;
        for &c in &self.chars[self.at..] {
            if escaped {
                escaped = false;
            } else if c == ']' {
                return true;
            } else if c == '\\' {
                escaped = true;
            }
        }
        false
    }

    fn class_item(&mut self) -> Result<Item, String> {
        let Some(c) = self.next() else {
            return Err(PREMATURE_END_OF_CLASS.into());
        };
        Ok(match c {
            ']' => Item::Close,
            '-' => Item::Range,
            '[' if self.peek() == Some(':') && self.posix_start() => {
                self.at += 1;
                Item::Set(self.posix()?)
            }
            '\\' => return self.class_escape(),
            c => Item::Char(c as u32),
        })
    }

    /// Whether `[:` at the cursor opens a POSIX bracket: letters (after
    /// an optional `^`) and then `:]`.
    fn posix_start(&self) -> bool {
        for (i, &c) in self.chars[self.at + 1..].iter().enumerate() {
            if c == ':' {
                return i > 0 && self.chars.get(self.at + 2 + i) == Some(&']');
            }
            if !(c == '^' && i == 0) && !c.is_ascii_alphabetic() {
                return false;
            }
        }
        false
    }

    fn posix(&mut self) -> Result<Set, String> {
        let negate = self.peek() == Some('^');
        if negate {
            self.at += 1;
        }
        const NAMES: [(&str, Ctype); 14] = [
            ("alnum", Ctype::Alnum),
            ("alpha", Ctype::Alpha),
            ("blank", Ctype::Blank),
            ("cntrl", Ctype::Cntrl),
            ("digit", Ctype::Digit),
            ("graph", Ctype::Graph),
            ("lower", Ctype::Lower),
            ("print", Ctype::Print),
            ("punct", Ctype::Punct),
            ("space", Ctype::Space),
            ("upper", Ctype::Upper),
            ("xdigit", Ctype::Xdigit),
            ("ascii", Ctype::Ascii),
            ("word", Ctype::Word),
        ];
        for (name, ctype) in NAMES {
            let len = name.chars().count();
            let matches = self.chars[self.at..]
                .iter()
                .take(len)
                .copied()
                .eq(name.chars());
            if matches {
                if self.chars.get(self.at + len) != Some(&':')
                    || self.chars.get(self.at + len + 1) != Some(&']')
                {
                    break;
                }
                self.at += len + 2;
                let set = class::ctype(ctype, true).clone();
                return Ok(if negate { class::negate(set) } else { set });
            }
        }
        Err(INVALID_POSIX.into())
    }

    fn class_escape(&mut self) -> Result<Item, String> {
        let Some(c) = self.next() else {
            return Err(END_AT_ESCAPE.into());
        };
        Ok(match c {
            'w' => Item::Set(class::word().clone()),
            'W' => Item::Set(class::negate(class::word().clone())),
            's' | 'S' | 'd' | 'D' => {
                let ctype = if c.eq_ignore_ascii_case(&'s') {
                    Ctype::Space
                } else {
                    Ctype::Digit
                };
                let set = class::ctype(ctype, false).clone();
                Item::Set(if c.is_ascii_uppercase() {
                    class::negate(set)
                } else {
                    set
                })
            }
            'p' | 'P' if self.peek() == Some('{') => {
                self.at += 1;
                let mut negate = c == 'P';
                if self.peek() == Some('^') {
                    self.at += 1;
                    negate = !negate;
                }
                let set = self.property()?;
                Item::Set(if negate { class::negate(set) } else { set })
            }
            'o' | 'x' if self.peek() == Some('{') => {
                self.at += 1;
                match self.braced(if c == 'x' { 16 } else { 8 })? {
                    Some(codes) if codes.len() == 1 => Item::Char(codes[0]),
                    Some(codes) => {
                        let mut set = Set::empty();
                        for code in codes {
                            if let Some(c) = char::from_u32(code) {
                                set.union(&class::single(c));
                            }
                        }
                        Item::Set(set)
                    }
                    None => {
                        self.at -= 1;
                        Item::Char(c as u32)
                    }
                }
            }
            'x' => {
                let (code, _) = self.hex(2)?;
                self.class_crude(code as u8)?
            }
            '0'..='7' => {
                self.at -= 1;
                let (code, _) = self.octal(3)?;
                if code >= 256 {
                    return Err(TOO_BIG_NUMBER.into());
                }
                self.class_crude(code as u8)?
            }
            _ => {
                self.at -= 1;
                Item::Char(self.escaped_value()?)
            }
        })
    }

    fn class_crude(&mut self, first: u8) -> Result<Item, String> {
        Ok(match self.crude(first)? {
            Node::Char(c) | Node::Caseless(c) => Item::Char(c as u32),
            Node::Byte(byte) => Item::Char(u32::from(byte)),
            _ => unreachable!("one character"),
        })
    }
}

/// A quantifier's bounds, whether it is greedy and whether it is
/// possessive.
type Quantifier = (u32, Option<u32>, bool, bool);

/// What `(?` opens.
enum Kind {
    /// `(?:`.
    Plain,
    Look(bool, bool),
    Atomic,
    /// A named group, opened.
    Named(usize),
    Absent,
    Cond,
    Options,
    /// A group that takes no body, read whole.
    Done(Atom),
}

enum Name {
    Text(String),
    /// A number and the text it was read from.
    Number(i64, String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NumType {
    Not,
    Abs,
    Rel,
}

fn close_of(open: char) -> char {
    match open {
        '<' => '>',
        '\'' => '\'',
        _ => ')',
    }
}

/// An absent generator that is a greedy repeat of one character (Oniguruma's
/// is_simple_one_char_repeat): its bounds, body and possessiveness, or
/// the node back.
#[allow(clippy::type_complexity)]
fn one_char_repeat(node: Node) -> Result<(u32, Option<u32>, Node, bool), Node> {
    let (repeat, possessive) = match node {
        Node::Atomic(inner) if matches!(*inner, Node::Repeat { .. }) => (*inner, true),
        node @ Node::Repeat { .. } => (node, false),
        node => return Err(node),
    };
    let Node::Repeat {
        body,
        min,
        max,
        greedy,
    } = repeat
    else {
        unreachable!("a repeat")
    };
    if !greedy || !matches!(*body, Node::Char(_) | Node::Caseless(_) | Node::Set(_)) {
        let repeat = Node::Repeat {
            body,
            min,
            max,
            greedy,
        };
        return Err(if possessive {
            Node::Atomic(Box::new(repeat))
        } else {
            repeat
        });
    }
    Ok((min, max, *body, possessive))
}

/// A fixed count of a fixed count, as onig_reduce_nested_quantifier folds
/// it into one: None where onig_positive_int_multiply finds it too big.
fn fixed_count(outer: u32, inner: u32) -> Option<u32> {
    if outer == 0 || inner == 0 {
        return Some(0);
    }
    (outer < i32::MAX as u32 / inner).then(|| outer * inner)
}

/// Anchors, lookarounds, `\K`, `(*FAIL)` and callouts take no quantifier,
/// nor does an alternation holding one.
fn invalid_target(node: &Node) -> bool {
    match node {
        Node::Anchor(_) | Node::Look { .. } | Node::Keep | Node::Fail | Node::Callout(_) => true,
        Node::Alt(items) => items.iter().any(invalid_target),
        _ => false,
    }
}
