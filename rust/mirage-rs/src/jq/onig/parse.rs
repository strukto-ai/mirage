// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regparse.c. See licenses/third_party/oniguruma.txt.

use super::class::{self, Ctype, Set};

/// How deep groups, alternations and quantifiers may nest: every walk of
/// the tree recurses, and a wasm build has a 1 MiB stack.
const NEST_LIMIT: usize = 250;

/// ONIG_MAX_REPEAT_NUM.
const MAX_REPEAT: u32 = 100_000;

/// ONIG_MAX_BACKREF_NUM.
const MAX_BACKREF: usize = 1000;

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
const INVALID_BACKREF: &str = "invalid backref number/name";
const TOO_LONG_WIDE: &str = "too long wide-char value";
const INVALID_CODE_POINT: &str = "invalid code point value";
const EMPTY_NAME: &str = "group name is empty";
const DEPTH_LIMIT: &str = "parse depth limit over";

fn unsupported(what: &str) -> String {
    format!("{what} is not supported")
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
}

#[derive(Debug)]
pub(super) enum Node {
    Empty,
    Char(char),
    /// A byte `\xHH` names that starts no character.
    Byte(u8),
    Set(Box<Set>),
    /// `.`: with true, a newline too.
    Any(bool),
    Seq(Vec<Node>),
    Alt(Vec<Node>),
    Group(usize, Box<Node>),
    Repeat {
        body: Box<Node>,
        min: u32,
        max: Option<u32>,
        greedy: bool,
    },
    Atomic(Box<Node>),
    Look {
        behind: bool,
        negate: bool,
        body: Box<Node>,
    },
    Anchor(Anchor),
    /// The groups a reference may match, the last tried first, and
    /// whether it ignores case.
    Backref(Vec<usize>, bool),
    /// `(?(n)yes|no)`; without branches it only checks the group is set.
    Cond(Vec<usize>, Option<(Box<Node>, Box<Node>)>),
    /// `\K`.
    Keep,
    /// `\R`.
    Newline,
}

pub(super) struct Parsed {
    pub(super) node: Node,
    pub(super) groups: usize,
    /// Each name and the groups it names, in the order they open.
    pub(super) names: Vec<(String, Vec<usize>)>,
}

enum Atom {
    Node(Node),
    /// `(?i)`: options for the rest of the enclosing group.
    Options(Flags),
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
    /// The highest group a reference or condition names, checked once
    /// every group is known.
    referenced: usize,
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
    };
    let node = parser.alts(false)?;
    if parser.referenced > parser.groups {
        return Err(INVALID_BACKREF.into());
    }
    Ok(Parsed {
        node,
        groups: parser.groups,
        names: parser.names,
    })
}

fn is_word(c: char) -> bool {
    class::contains(class::word(), c as u32)
}

fn seq(mut items: Vec<Node>) -> Node {
    match items.len() {
        0 => Node::Empty,
        1 => items.pop().unwrap_or(Node::Empty),
        _ => Node::Seq(items),
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

    fn enter(&mut self) -> Result<(), String> {
        self.depth += 1;
        if self.depth > NEST_LIMIT {
            return Err(DEPTH_LIMIT.into());
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
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

    /// Branches up to the end or, in a group, its `)`, which this takes.
    fn alts(&mut self, in_group: bool) -> Result<Node, String> {
        self.enter()?;
        let saved = self.flags;
        let mut branches = vec![self.branch(in_group)?];
        loop {
            match self.next() {
                Some('|') => branches.push(self.branch(in_group)?),
                Some(')') => break,
                None if in_group => return Err(UNMATCHED_OPEN.into()),
                None => break,
                Some(_) => unreachable!("a branch ends at | or )"),
            }
        }
        self.flags = saved;
        self.leave();
        Ok(if branches.len() == 1 {
            branches.pop().unwrap_or(Node::Empty)
        } else {
            Node::Alt(branches)
        })
    }

    fn branch(&mut self, in_group: bool) -> Result<Node, String> {
        self.enter()?;
        let mut items = Vec::new();
        loop {
            self.skip()?;
            match self.peek() {
                None | Some('|') => break,
                Some(')') if in_group => break,
                Some(')') => return Err(UNMATCHED_CLOSE.into()),
                Some(_) => {}
            }
            match self.atom()? {
                Atom::Options(flags) => self.flags = flags,
                Atom::Node(node) => {
                    let node = self.quantified(node)?;
                    items.push(node);
                }
            }
        }
        self.leave();
        Ok(seq(items))
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
            if min == 1 && max == Some(1) {
                continue;
            }
            stacked += 1;
            if self.depth + stacked > NEST_LIMIT {
                return Err(DEPTH_LIMIT.into());
            }
            let repeat = Node::Repeat {
                body: Box::new(node),
                min,
                max,
                greedy,
            };
            node = if possessive {
                Node::Atomic(Box::new(repeat))
            } else {
                repeat
            };
        }
    }

    fn literal(&self, c: char) -> Node {
        if self.flags.ignore_case {
            let set = class::fold(class::single(c));
            if class::size(&set) > 1 {
                return Node::Set(Box::new(set));
            }
        }
        Node::Char(c)
    }

    fn code_point(&self, code: u32) -> Node {
        match char::from_u32(code) {
            Some(c) => self.literal(c),
            None => Node::Set(Box::new(Set::empty())),
        }
    }

    fn atom(&mut self) -> Result<Atom, String> {
        let Some(c) = self.next() else {
            unreachable!("atom at the end")
        };
        let node = match c {
            '\\' => return self.escape().map(Atom::Node),
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
            '(' => return self.group(),
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
            '[' => self.class()?,
            c => self.literal(c),
        };
        Ok(Atom::Node(node))
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
            'y' | 'Y' => return Err(unsupported("text segment boundary \\y")),
            'X' => return Err(unsupported("text segment \\X")),
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
                    Node::Backref(vec![number], self.flags.ignore_case)
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
                let groups = self.reference(open)?;
                Node::Backref(groups, self.flags.ignore_case)
            }
            'g' if matches!(self.peek(), Some('<' | '\'')) => {
                return Err(unsupported("subexp call"));
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
                    let name: String = self.chars[start..self.at - 1].iter().collect();
                    return class::property(&name).map_err(|known| {
                        if known {
                            unsupported(&format!("character property {{{name}}}"))
                        } else {
                            format!("invalid character property name {{{name}}}")
                        }
                    });
                }
                None | Some('(' | ')' | '{' | '|') => return Err(UNMATCHED_OPEN.into()),
                Some(_) => {}
            }
        }
    }

    /// A group name or number after `<` or `'` (or, for a condition,
    /// none), up to and past its closing mark; `is_ref` allows numbers.
    fn name(&mut self, open: char, is_ref: bool) -> Result<Name, String> {
        let close = match open {
            '<' => '>',
            '\'' => '\'',
            _ => ')',
        };
        let start = self.at;
        let first = match self.next() {
            None => return Err(EMPTY_NAME.into()),
            Some(c) if c == close => return Err(EMPTY_NAME.into()),
            Some(c) => c,
        };
        let mut error: Option<&str> = None;
        let mut numeric = false;
        let mut sign = 0i64;
        if first.is_ascii_digit() {
            if is_ref {
                numeric = true;
            } else {
                error = Some("invalid group name");
            }
        } else if first == '-' || first == '+' {
            if is_ref {
                numeric = true;
                sign = if first == '-' { -1 } else { 1 };
            } else {
                error = Some("invalid group name");
            }
        } else if !is_word(first) {
            error = Some("invalid char in group name");
        }
        let mut end = self.at;
        let mut closed = false;
        let mut stopped = false;
        while let Some(c) = self.peek() {
            end = self.at;
            self.at += 1;
            if c == close || c == ')' {
                closed = c == close;
                stopped = true;
                break;
            }
            numeric &= c.is_ascii_digit();
        }
        if let Some(error) = error {
            if !stopped {
                end = self.chars.len();
            }
            let text: String = self.chars[start..end].iter().collect();
            return Err(format!("{error} <{text}>"));
        }
        let text: String = self.chars[start..end].iter().collect();
        if !closed {
            return Err(format!("invalid group name <{text}>"));
        }
        if !numeric {
            return Ok(Name::Text(text));
        }
        let digits = if sign == 0 { &text[..] } else { &text[1..] };
        if digits.is_empty() {
            return Err(format!("invalid group name <{text}>"));
        }
        let number: i64 = digits.parse().map_err(|_| TOO_BIG_NUMBER)?;
        if sign != 0 && number == 0 {
            return Err(format!("invalid group name <{text}>"));
        }
        Ok(match sign {
            0 => Name::Number(number),
            1 => Name::Number(self.groups as i64 + number),
            _ => Name::Number(self.groups as i64 + 1 - number),
        })
    }

    /// The groups `\k<...>` or a condition names.
    fn reference(&mut self, open: char) -> Result<Vec<usize>, String> {
        match self.name(open, true)? {
            Name::Number(number) => {
                if number <= 0 {
                    return Err(INVALID_BACKREF.into());
                }
                let number = usize::try_from(number).map_err(|_| INVALID_BACKREF)?;
                self.referenced = self.referenced.max(number);
                Ok(vec![number])
            }
            Name::Text(text) => {
                let name = match level(&text) {
                    Some((name, 0)) => name,
                    Some(_) => return Err(unsupported("backreference with a level")),
                    None => &text,
                };
                match self.names.iter().find(|(known, _)| known == name) {
                    Some((_, groups)) => Ok(groups.clone()),
                    None => Err(format!("undefined name <{text}> reference")),
                }
            }
        }
    }

    fn open_group(&mut self) -> usize {
        self.groups += 1;
        self.groups
    }

    fn group(&mut self) -> Result<Atom, String> {
        if self.peek().is_none() {
            return Err(UNMATCHED_OPEN.into());
        }
        if self.peek() == Some('*') {
            return Err(unsupported("callout"));
        }
        if self.peek() != Some('?') {
            let index = self.open_group();
            let body = self.alts(true)?;
            return Ok(Atom::Node(Node::Group(index, Box::new(body))));
        }
        self.at += 1;
        let Some(c) = self.next() else {
            return Err(END_IN_GROUP.into());
        };
        let node = match c {
            ':' => self.alts(true)?,
            '=' | '!' => Node::Look {
                behind: false,
                negate: c == '!',
                body: Box::new(self.alts(true)?),
            },
            '>' => Node::Atomic(Box::new(self.alts(true)?)),
            '<' => match self.peek() {
                None => return Err(UNMATCHED_OPEN.into()),
                Some(c @ ('=' | '!')) => {
                    self.at += 1;
                    Node::Look {
                        behind: true,
                        negate: c == '!',
                        body: Box::new(self.alts(true)?),
                    }
                }
                Some(_) => self.named('<')?,
            },
            '\'' => self.named('\'')?,
            '~' => return Err(unsupported("absent operator")),
            '{' => return Err(unsupported("callout")),
            '(' => self.condition()?,
            '&' | 'R' => return Err(unsupported("subexp call")),
            '0'..='9' => return Err(unsupported("subexp call")),
            '-' | '+' if self.peek().is_some_and(|c| c.is_ascii_digit()) => {
                return Err(unsupported("subexp call"));
            }
            '-' | 'i' | 'm' | 's' | 'x' => {
                self.at -= 1;
                return self.options();
            }
            _ => return Err(UNDEFINED_OPTION.into()),
        };
        Ok(Atom::Node(node))
    }

    fn named(&mut self, open: char) -> Result<Node, String> {
        let Name::Text(name) = self.name(open, false)? else {
            unreachable!("a definition takes no number")
        };
        let index = self.open_group();
        match self.names.iter_mut().find(|(known, _)| *known == name) {
            Some((_, groups)) => groups.push(index),
            None => self.names.push((name, vec![index])),
        }
        let body = self.alts(true)?;
        Ok(Node::Group(index, Box::new(body)))
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
                    let saved = self.flags;
                    self.flags = flags;
                    let body = self.alts(true);
                    self.flags = saved;
                    return body.map(Atom::Node);
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
    fn condition(&mut self) -> Result<Node, String> {
        let Some(c) = self.peek() else {
            return Err(END_IN_GROUP.into());
        };
        if self.peek_at(1).is_none() {
            return Err(END_IN_GROUP.into());
        }
        let groups = match c {
            '<' | '\'' => {
                self.at += 1;
                let groups = self.reference(c)?;
                if self.next() != Some(')') {
                    return Err(END_IN_GROUP.into());
                }
                groups
            }
            c if c.is_ascii_digit() || c == '-' || c == '+' => {
                let start = self.at;
                match self.name('(', true) {
                    Ok(Name::Number(number)) => {
                        if number <= 0 {
                            return Err(INVALID_BACKREF.into());
                        }
                        let number = usize::try_from(number).map_err(|_| INVALID_BACKREF)?;
                        self.referenced = self.referenced.max(number);
                        vec![number]
                    }
                    _ => {
                        self.at = start;
                        return Err(unsupported("a condition that is no group reference"));
                    }
                }
            }
            _ => return Err(unsupported("a condition that is no group reference")),
        };
        if self.peek().is_none() {
            return Err(END_IN_GROUP.into());
        }
        if self.peek() == Some(')') {
            self.at += 1;
            return Ok(Node::Cond(groups, None));
        }
        let then_empty = self.peek() == Some('|');
        if then_empty {
            self.at += 1;
        }
        let body = self.alts(true)?;
        let (yes, no) = if then_empty {
            (Node::Empty, body)
        } else {
            match body {
                Node::Alt(mut branches) => {
                    let yes = branches.remove(0);
                    let no = if branches.len() == 1 {
                        branches.pop().unwrap_or(Node::Empty)
                    } else {
                        Node::Alt(branches)
                    };
                    (yes, no)
                }
                body => (body, Node::Empty),
            }
        };
        Ok(Node::Cond(groups, Some((Box::new(yes), Box::new(no)))))
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
            set = class::fold(set);
        }
        if negate {
            set = class::negate(set);
        }
        self.leave();
        Ok(Node::Set(Box::new(set)))
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
            Node::Char(c) => Item::Char(c as u32),
            Node::Set(set) => Item::Set(*set),
            Node::Byte(byte) => Item::Char(u32::from(byte)),
            _ => unreachable!("one character"),
        })
    }
}

/// A quantifier's bounds, whether it is greedy and whether it is
/// possessive.
type Quantifier = (u32, Option<u32>, bool, bool);

enum Name {
    Text(String),
    Number(i64),
}

/// `name+n` or `name-n`: a reference's recursion level.
fn level(text: &str) -> Option<(&str, i64)> {
    let at = text.rfind(['+', '-'])?;
    let (name, digits) = (&text[..at], &text[at + 1..]);
    if name.is_empty() || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let level: i64 = digits.parse().ok()?;
    Some((name, level))
}

/// Anchors, lookarounds and `\K` take no quantifier, nor does an
/// alternation holding one.
fn invalid_target(node: &Node) -> bool {
    match node {
        Node::Anchor(_) | Node::Look { .. } | Node::Keep => true,
        Node::Alt(items) => items.iter().any(invalid_target),
        _ => false,
    }
}
