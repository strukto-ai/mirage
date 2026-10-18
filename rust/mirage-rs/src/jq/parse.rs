// Adapted from jq 1.8.2 (MIT). See licenses/third_party/jq.txt.

use std::collections::{BTreeMap, VecDeque};

use serde::Deserialize;

use super::unicode::{BLOCK, Bytes, DecodeCursor, JsonString, WORK};
use crate::{Stream, StreamError};

const DEPTH: usize = 10000;
const RS: u8 = 0x1e;
const SEPARATOR: &str = "Expected separator between values";
const CONTROL: &str =
    "Invalid string: control characters from U+0000 through U+001F must be escaped";
const SURROGATE: &str = "Invalid \\uXXXX\\uXXXX surrogate pair escape";

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    seq: bool,
    streaming: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Lex {
    Normal,
    String,
    Escape,
    Waiting,
}

#[derive(Clone, Copy, PartialEq)]
enum Last {
    None,
    OpenArray,
    OpenObject,
    Colon,
    Comma,
    Value,
}

enum Container {
    Array(bool),
    Object(bool),
    Key,
}

enum Path {
    Index(u64),
    Key(Option<Bytes>),
}

#[derive(Default)]
struct Paths {
    entries: BTreeMap<usize, Path>,
}

impl Paths {
    fn len(&self) -> usize {
        self.entries.len()
    }

    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn push(&mut self, path: Path) {
        self.entries.insert(self.entries.len(), path);
    }

    fn pop(&mut self) -> Option<Path> {
        self.entries.pop_last().map(|(_, path)| path)
    }

    fn last(&self) -> Option<&Path> {
        self.entries.last_key_value().map(|(_, path)| path)
    }

    fn last_mut(&mut self) -> Option<&mut Path> {
        self.entries.last_entry().map(|entry| entry.into_mut())
    }

    fn get(&self, at: usize) -> Option<&Path> {
        self.entries.get(&at)
    }
}

enum Leaf {
    Null,
    Bool(bool),
    Number(Bytes, usize),
    String(Bytes),
    Array,
    Object,
}

impl Leaf {
    fn is_number(&self) -> bool {
        matches!(self, Self::Number(..))
    }

    fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
}

#[derive(Clone, Copy)]
enum AfterToken {
    Delimiter(u8),
    String,
    Eof,
    Rs(bool),
}

#[derive(Clone, Copy)]
enum Decimal {
    Start,
    Sign,
    Int,
    Dot,
    Fraction,
    DotStart,
    Exp,
    ExpSign,
    ExpDigits,
    Word(u8, usize),
    Invalid,
}

impl Decimal {
    fn byte(self, ch: u8) -> Self {
        let digit = ch.is_ascii_digit();
        match self {
            Self::Start if matches!(ch, b'+' | b'-') => Self::Sign,
            Self::Start | Self::Sign => match ch.to_ascii_lowercase() {
                b'0'..=b'9' => Self::Int,
                b'.' => Self::DotStart,
                b'i' => Self::Word(0, 1),
                b'n' => Self::Word(1, 1),
                b's' => Self::Word(2, 1),
                _ => Self::Invalid,
            },
            Self::Int if digit => Self::Int,
            Self::Int if ch == b'.' => Self::Dot,
            Self::Dot | Self::DotStart | Self::Fraction if digit => Self::Fraction,
            Self::Int | Self::Dot | Self::Fraction if matches!(ch, b'e' | b'E') => Self::Exp,
            Self::Exp if matches!(ch, b'+' | b'-') => Self::ExpSign,
            Self::Exp | Self::ExpSign | Self::ExpDigits if digit => Self::ExpDigits,
            Self::Word(kind, pos) => {
                let expected: &[u8] = match kind {
                    0 => b"infinity",
                    1 => b"nan",
                    _ => b"snan",
                };
                if (pos < expected.len() && ch.to_ascii_lowercase() == expected[pos])
                    || (kind != 0 && pos >= expected.len() && ch == b'0')
                {
                    Self::Word(kind, pos + 1)
                } else {
                    Self::Invalid
                }
            }
            _ => Self::Invalid,
        }
    }

    fn valid(self) -> bool {
        matches!(
            self,
            Self::Int | Self::Dot | Self::Fraction | Self::ExpDigits | Self::Word(0, 3 | 8)
        ) || matches!(self, Self::Word(1, n) if n >= 3)
            || matches!(self, Self::Word(2, n) if n >= 4)
    }
}

enum TokenKind {
    Literal {
        expected: Option<&'static [u8]>,
        valid: bool,
        decimal: Decimal,
        effective: Option<usize>,
    },
    String {
        decoded: Bytes,
        capture: bool,
        streaming: bool,
        utf8: Utf8Check,
        phase: StringPhase,
        quoted: JsonString,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum StringPhase {
    Validate,
    Recapture,
    Source,
    Quoted,
}

#[derive(Default)]
struct Utf8Check {
    remaining: u8,
    point: u32,
    minimum: u32,
    invalid: bool,
}

impl Utf8Check {
    fn push(&mut self, byte: u8) {
        if self.remaining > 0 {
            if (0x80..=0xbf).contains(&byte) {
                self.point = (self.point << 6) | u32::from(byte & 0x3f);
                self.remaining -= 1;
                if self.remaining == 0
                    && (self.point < self.minimum || char::from_u32(self.point).is_none())
                {
                    self.invalid = true;
                }
                return;
            }
            self.invalid = true;
            self.remaining = 0;
        }
        let (remaining, point, minimum) = match byte {
            0..=0x7f => return,
            0xc2..=0xdf => (1, u32::from(byte & 0x1f), 0x80),
            0xe0..=0xef => (2, u32::from(byte & 0x0f), 0x800),
            0xf0..=0xf4 => (3, u32::from(byte & 7), 0x10000),
            _ => {
                self.invalid = true;
                return;
            }
        };
        self.remaining = remaining;
        self.point = point;
        self.minimum = minimum;
    }

    fn valid(&self) -> bool {
        !self.invalid && self.remaining == 0
    }
}

struct Token {
    bytes: Bytes,
    at: usize,
    kind: TokenKind,
    after: AfterToken,
}

impl Token {
    fn literal(bytes: Bytes, after: AfterToken) -> Self {
        let expected: Option<&'static [u8]> = match bytes.get(0) {
            Some(b't') => Some(b"true"),
            Some(b'f') => Some(b"false"),
            Some(b'n') if bytes.get(1) == Some(b'u') => Some(b"null"),
            _ => None,
        };
        Self {
            bytes,
            at: 0,
            kind: TokenKind::Literal {
                expected,
                valid: true,
                decimal: Decimal::Start,
                effective: None,
            },
            after,
        }
    }

    fn string(bytes: Bytes, streaming: bool) -> Self {
        Self {
            bytes,
            at: 0,
            kind: TokenKind::String {
                decoded: Bytes::default(),
                capture: streaming,
                streaming,
                utf8: Utf8Check::default(),
                phase: StringPhase::Validate,
                quoted: JsonString::default(),
            },
            after: AfterToken::String,
        }
    }

    fn step(
        &mut self,
        budget: &mut usize,
        document: &mut Bytes,
    ) -> Option<Result<Leaf, &'static str>> {
        match &mut self.kind {
            TokenKind::Literal {
                expected,
                valid,
                decimal,
                effective,
            } => {
                if self.bytes.get(0) == Some(b'\'') {
                    return Some(Err("Invalid string literal; expected \", but got '"));
                }
                while self.at < self.bytes.len() && *budget > 0 {
                    let ch = self.bytes.get(self.at).unwrap();
                    if let Some(pattern) = expected {
                        *valid &= pattern.get(self.at) == Some(&ch);
                    } else if ch == 0 {
                        *effective = Some(self.at);
                        self.at = self.bytes.len();
                        break;
                    } else {
                        *decimal = decimal.byte(ch);
                    }
                    self.at += 1;
                    *budget -= 1;
                }
                if self.at != self.bytes.len() {
                    return None;
                }
                if let Some(pattern) = expected {
                    if !*valid || self.at != pattern.len() {
                        return Some(Err("Invalid literal"));
                    }
                    return Some(Ok(match *pattern {
                        b"true" => Leaf::Bool(true),
                        b"false" => Leaf::Bool(false),
                        _ => Leaf::Null,
                    }));
                }
                if !decimal.valid() {
                    return Some(Err("Invalid numeric literal"));
                }
                let length = effective.unwrap_or(self.bytes.len());
                Some(Ok(Leaf::Number(std::mem::take(&mut self.bytes), length)))
            }
            TokenKind::String {
                decoded,
                capture,
                streaming,
                utf8,
                phase,
                quoted,
            } => loop {
                if *phase == StringPhase::Source {
                    while self.at < self.bytes.len() && *budget > 0 {
                        document.push(self.bytes.get(self.at).unwrap());
                        self.at += 1;
                        *budget -= 1;
                    }
                    if self.at < self.bytes.len() || *budget == 0 {
                        return None;
                    }
                    document.push(b'"');
                    *budget -= 1;
                    return Some(Ok(Leaf::String(Bytes::default())));
                }
                if *phase == StringPhase::Quoted {
                    if *budget < 2 {
                        return None;
                    }
                    let available = *budget / 2;
                    let mut render_budget = available;
                    let mut output = Vec::with_capacity(BLOCK);
                    let finished = quoted.write(decoded, &mut output, BLOCK, &mut render_budget);
                    document.extend(&output);
                    *budget -= available - render_budget + output.len();
                    if finished {
                        return Some(Ok(Leaf::String(Bytes::default())));
                    }
                    if *budget == 0 {
                        return None;
                    }
                    continue;
                }
                while self.at < self.bytes.len() && *budget > 0 {
                    let ch = self.bytes.get(self.at).unwrap();
                    if !*streaming && *phase == StringPhase::Validate {
                        utf8.push(ch);
                    }
                    if ch < 0x20 {
                        return Some(Err(CONTROL));
                    }
                    if ch != b'\\' {
                        if *capture {
                            decoded.push(ch);
                        }
                        self.at += 1;
                        *budget -= 1;
                        continue;
                    }
                    let Some(code) = self.bytes.get(self.at + 1) else {
                        return Some(Err("Expected escape character at end of string"));
                    };
                    let plain = match code {
                        b'\\' | b'"' | b'/' => Some(code),
                        b'b' => Some(8),
                        b'f' => Some(12),
                        b't' => Some(b'\t'),
                        b'n' => Some(b'\n'),
                        b'r' => Some(b'\r'),
                        _ => None,
                    };
                    if let Some(byte) = plain {
                        if *capture {
                            decoded.push(byte);
                        }
                        self.at += 2;
                        *budget = budget.saturating_sub(2);
                        continue;
                    }
                    if code != b'u' {
                        return Some(Err("Invalid escape"));
                    }
                    if self.at + 6 > self.bytes.len() {
                        return Some(Err("Invalid \\uXXXX escape"));
                    }
                    let Some(mut point) = unhex(&self.bytes, self.at + 2) else {
                        return Some(Err("Invalid characters in \\uXXXX escape"));
                    };
                    let mut taken = 6;
                    if (0xd800..=0xdbff).contains(&point) {
                        if self.at + 12 > self.bytes.len()
                            || self.bytes.get(self.at + 6) != Some(b'\\')
                            || self.bytes.get(self.at + 7) != Some(b'u')
                        {
                            return Some(Err(SURROGATE));
                        }
                        let Some(low) = unhex(&self.bytes, self.at + 8) else {
                            return Some(Err(SURROGATE));
                        };
                        if !(0xdc00..=0xdfff).contains(&low) {
                            return Some(Err(SURROGATE));
                        }
                        point = 0x10000 + (((point - 0xd800) << 10) | (low - 0xdc00));
                        taken = 12;
                    }
                    if *capture {
                        let mut encoded = [0; 4];
                        decoded.extend(
                            char::from_u32(point)
                                .unwrap_or('\u{fffd}')
                                .encode_utf8(&mut encoded)
                                .as_bytes(),
                        );
                    }
                    self.at += taken;
                    *budget = budget.saturating_sub(taken);
                }
                if self.at < self.bytes.len() {
                    return None;
                } else if *streaming {
                    return Some(Ok(Leaf::String(std::mem::take(decoded))));
                } else if *phase == StringPhase::Validate {
                    self.at = 0;
                    if utf8.valid() {
                        *phase = StringPhase::Source;
                    } else {
                        *phase = StringPhase::Recapture;
                        *capture = true;
                    }
                } else {
                    document.pop();
                    *phase = StringPhase::Quoted;
                }
                if *budget == 0 {
                    return None;
                }
            },
        }
    }
}

fn unhex(bytes: &Bytes, at: usize) -> Option<u32> {
    let mut point = 0;
    for i in at..at + 4 {
        point = (point << 4) | char::from(bytes.get(i)?).to_digit(16)?;
    }
    Some(point)
}

enum Mutation {
    None,
    Advance,
    Pop,
}

struct Event {
    path_len: usize,
    leaf: Option<Leaf>,
    close: bool,
    mutation: Mutation,
    phase: u8,
    path_at: usize,
    separator: bool,
    small: Vec<u8>,
    small_at: usize,
    string: Option<JsonString>,
    number_at: usize,
}

impl Event {
    fn new(path_len: usize, leaf: Option<Leaf>, close: bool, mutation: Mutation) -> Self {
        Self {
            path_len,
            leaf,
            close,
            mutation,
            phase: 0,
            path_at: 0,
            separator: false,
            small: Vec::new(),
            small_at: 0,
            string: None,
            number_at: 0,
        }
    }

    fn small(&mut self, text: &[u8]) {
        self.small.extend_from_slice(text);
    }

    fn write(&mut self, path: &Paths, out: &mut Vec<u8>, max: usize, budget: &mut usize) -> bool {
        while out.len() < max && *budget > 0 {
            if self.small_at < self.small.len() {
                out.push(self.small[self.small_at]);
                self.small_at += 1;
                *budget -= 1;
                continue;
            }
            self.small.clear();
            self.small_at = 0;
            match self.phase {
                0 => {
                    self.small(b"[[");
                    self.phase = 1;
                }
                1 if self.path_at == self.path_len => {
                    self.small(b"]");
                    self.phase = 3;
                }
                1 if self.path_at > 0 && !self.separator => {
                    self.small(b",");
                    self.separator = true;
                }
                1 => {
                    match path.get(self.path_at).unwrap() {
                        Path::Index(index) => self.small(index.to_string().as_bytes()),
                        Path::Key(Some(bytes)) => {
                            let string = self.string.get_or_insert_with(JsonString::default);
                            if !string.write(bytes, out, max, budget) {
                                return false;
                            }
                            self.string = None;
                        }
                        Path::Key(None) => self.small(b"null"),
                    }
                    self.path_at += 1;
                    self.separator = false;
                }
                3 if self.leaf.is_some() => {
                    self.small(b",");
                    self.phase = 4;
                }
                3 => {
                    self.small(b"]");
                    self.phase = 5;
                }
                4 => {
                    match self.leaf.as_mut().unwrap() {
                        Leaf::Null => self.small(b"null"),
                        Leaf::Bool(true) => self.small(b"true"),
                        Leaf::Bool(false) => self.small(b"false"),
                        Leaf::Array => self.small(b"[]"),
                        Leaf::Object => self.small(b"{}"),
                        Leaf::String(bytes) => {
                            let string = self.string.get_or_insert_with(JsonString::default);
                            if !string.write(bytes, out, max, budget) {
                                return false;
                            }
                            self.string = None;
                        }
                        Leaf::Number(bytes, length) => {
                            while self.number_at < *length && out.len() < max && *budget > 0 {
                                out.push(bytes.get(self.number_at).unwrap());
                                self.number_at += 1;
                                *budget -= 1;
                            }
                            if self.number_at != *length {
                                return false;
                            }
                        }
                    }
                    self.phase = 6;
                }
                6 => {
                    self.small(b"]");
                    self.phase = 5;
                }
                _ => return true,
            }
        }
        self.phase == 5 && self.small_at == self.small.len()
    }
}

enum Emission {
    Document { bytes: Bytes, cursor: DecodeCursor },
    Event(Event),
    Error(String),
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = crate::parse_config(config)?;
    Ok(Box::new(Scanner::new(config)))
}

struct Scanner {
    config: Config,
    lex: Lex,
    last: Last,
    stack: Vec<Container>,
    path: Paths,
    next: Option<Leaf>,
    token: Bytes,
    document: Bytes,
    task: Option<Token>,
    emission: Option<Emission>,
    input: Vec<u8>,
    input_at: usize,
    bom: usize,
    restart_bom: bool,
    line: u64,
    column: u64,
    last_ws: bool,
    eof: bool,
    ended: bool,
    trash: VecDeque<Bytes>,
    old_paths: VecDeque<Paths>,
}

impl Scanner {
    fn new(config: Config) -> Self {
        let lex = if config.seq {
            Lex::Waiting
        } else {
            Lex::Normal
        };
        Self {
            config,
            lex,
            last: Last::None,
            stack: Vec::new(),
            path: Paths::default(),
            next: None,
            token: Bytes::default(),
            document: Bytes::default(),
            task: None,
            emission: None,
            input: Vec::new(),
            input_at: 0,
            bom: 0,
            restart_bom: false,
            line: 1,
            column: 0,
            last_ws: false,
            eof: false,
            ended: false,
            trash: VecDeque::new(),
            old_paths: VecDeque::new(),
        }
    }

    fn discard(&mut self, bytes: Bytes) {
        if !bytes.is_empty() {
            self.trash.push_back(bytes);
        }
    }

    fn discard_leaf(&mut self, leaf: Leaf) {
        match leaf {
            Leaf::String(bytes) | Leaf::Number(bytes, _) => self.discard(bytes),
            _ => {}
        }
    }

    fn reset(&mut self) {
        let token = std::mem::take(&mut self.token);
        let document = std::mem::take(&mut self.document);
        self.discard(token);
        self.discard(document);
        if let Some(leaf) = self.next.take() {
            self.discard_leaf(leaf);
        }
        if !self.path.is_empty() {
            self.old_paths.push_back(std::mem::take(&mut self.path));
        }
        self.stack.clear();
        self.lex = Lex::Normal;
        self.last = Last::None;
    }

    fn begin_discard(&mut self) {
        self.ended = true;
        self.eof = true;
        self.restart_bom = false;
        self.input.clear();
        self.input_at = self.input.len();
        self.reset();
        if let Some(task) = self.task.take() {
            self.discard(task.bytes);
            if let TokenKind::String { decoded, .. } = task.kind {
                self.discard(decoded);
            }
        }
        match self.emission.take() {
            Some(Emission::Document { bytes, .. }) => self.discard(bytes),
            Some(Emission::Event(mut event)) => {
                if let Some(leaf) = event.leaf.take() {
                    self.discard_leaf(leaf);
                }
            }
            _ => {}
        }
    }

    fn error(&mut self, message: &str, eof: bool, rs: bool) {
        let where_ = if eof { "at EOF at" } else { "at" };
        let suffix = if self.config.seq && !eof && !rs {
            " (need RS to resync)"
        } else {
            ""
        };
        let message = format!(
            "{message} {where_} line {}, column {}{suffix}",
            self.line, self.column
        );
        self.reset();
        if self.config.seq && eof {
            self.lex = Lex::Waiting;
        }
        if !self.config.seq || eof {
            self.ended = true;
        }
        self.emission = Some(Emission::Error(message));
    }

    fn value(&mut self, leaf: Leaf) -> Result<(), &'static str> {
        if self.next.is_some() || (self.config.streaming && self.last == Last::Value) {
            self.discard_leaf(leaf);
            return Err(SEPARATOR);
        }
        if self.config.streaming {
            self.last = if self.path.is_empty() {
                Last::None
            } else {
                Last::Value
            };
        }
        self.next = Some(leaf);
        Ok(())
    }

    fn top_done(&mut self) -> Option<Leaf> {
        if (self.config.streaming && self.path.is_empty())
            || (!self.config.streaming && self.stack.is_empty())
        {
            self.next.take()
        } else {
            None
        }
    }

    fn output(&mut self, leaf: Leaf, before: Option<u8>) {
        if self.config.streaming {
            self.emission = Some(Emission::Event(Event::new(
                0,
                Some(leaf),
                false,
                Mutation::None,
            )));
        } else {
            self.discard_leaf(leaf);
            let mut bytes = std::mem::take(&mut self.document);
            if let Some(ch) = before {
                bytes.pop();
                if !separator(ch) {
                    self.document.push(ch);
                }
            }
            self.emission = Some(Emission::Document {
                bytes,
                cursor: DecodeCursor::default(),
            });
        }
    }

    fn delimiter(&mut self, ch: u8) {
        self.last_ws = whitespace(ch);
        let before = self.top_done();
        let result = if ch == b'"' {
            self.lex = Lex::String;
            Ok(())
        } else if structure(ch) {
            if self.config.streaming {
                self.stream_token(ch)
            } else {
                self.normal_token(ch)
            }
        } else {
            Ok(())
        };
        if let Err(message) = result {
            if let Some(leaf) = before {
                self.discard_leaf(leaf);
            }
            self.error(message, false, false);
            return;
        }
        if let Some(leaf) = self.top_done() {
            if let Some(old) = before {
                self.discard_leaf(old);
            }
            self.output(leaf, None);
        } else if let Some(leaf) = before {
            self.output(leaf, Some(ch));
        }
    }

    fn normal_token(&mut self, ch: u8) -> Result<(), &'static str> {
        match ch {
            b'[' | b'{' => {
                if self.stack.len() >= DEPTH {
                    return Err("Exceeds depth limit for parsing");
                }
                if self.next.is_some() {
                    return Err(SEPARATOR);
                }
                self.stack.push(if ch == b'[' {
                    Container::Array(false)
                } else {
                    Container::Object(false)
                });
            }
            b':' => {
                let Some(leaf) = self.next.as_ref() else {
                    return Err("Expected string key before ':'");
                };
                if !matches!(self.stack.last(), Some(Container::Object(_))) {
                    return Err("':' not as part of an object");
                }
                if !leaf.is_string() {
                    return Err("Object keys must be strings");
                }
                let leaf = self.next.take().unwrap();
                self.discard_leaf(leaf);
                self.stack.push(Container::Key);
            }
            b',' => {
                if self.next.is_none() {
                    return Err("Expected value before ','");
                }
                match self.stack.last_mut() {
                    None => return Err("',' not as part of an object or array"),
                    Some(Container::Array(nonempty)) => *nonempty = true,
                    Some(Container::Key) => {
                        self.stack.pop();
                        if let Some(Container::Object(nonempty)) = self.stack.last_mut() {
                            *nonempty = true;
                        }
                    }
                    _ => return Err("Objects must consist of key:value pairs"),
                }
                let leaf = self.next.take().unwrap();
                self.discard_leaf(leaf);
            }
            b']' => {
                let Some(Container::Array(nonempty)) = self.stack.last() else {
                    return Err("Unmatched ']'");
                };
                if self.next.is_none() && *nonempty {
                    return Err("Expected another array element");
                }
                if let Some(leaf) = self.next.take() {
                    self.discard_leaf(leaf);
                }
                self.stack.pop();
                self.next = Some(Leaf::Array);
            }
            b'}' => {
                if self.stack.is_empty() {
                    return Err("Unmatched '}'");
                }
                if self.next.is_some() {
                    if !matches!(self.stack.last(), Some(Container::Key)) {
                        return Err("Objects must consist of key:value pairs");
                    }
                    let leaf = self.next.take().unwrap();
                    self.discard_leaf(leaf);
                    self.stack.pop();
                } else {
                    let Some(Container::Object(nonempty)) = self.stack.last() else {
                        return Err("Unmatched '}'");
                    };
                    if *nonempty {
                        return Err("Expected another key-value pair");
                    }
                }
                self.stack.pop();
                self.next = Some(Leaf::Object);
            }
            _ => {}
        }
        Ok(())
    }

    fn stream_token(&mut self, ch: u8) -> Result<(), &'static str> {
        let last = self.last;
        if matches!(ch, b'[' | b'{') && self.path.len() >= DEPTH {
            return Err("Exceeds depth limit for parsing");
        }
        match ch {
            b'[' | b'{' => {
                if (ch == b'[' && self.next.is_some()) || (ch == b'{' && last == Last::Value) {
                    return Err("Expected a separator between values");
                }
                if last == Last::OpenObject {
                    return Err(if ch == b'[' {
                        "Expected string key after '{', not '['"
                    } else {
                        "Expected string key after '{', not '{'"
                    });
                }
                if last == Last::Comma && !matches!(self.path.last(), Some(Path::Index(_))) {
                    return Err(if ch == b'[' {
                        "Expected string key after ',' in object, not '['"
                    } else {
                        "Expected string key after ',' in object, not '{'"
                    });
                }
                self.path.push(if ch == b'[' {
                    Path::Index(0)
                } else {
                    Path::Key(None)
                });
                self.last = if ch == b'[' {
                    Last::OpenArray
                } else {
                    Last::OpenObject
                };
            }
            b':' => {
                if !matches!(self.path.last(), Some(Path::Key(_))) {
                    return Err("':' not as part of an object");
                }
                if self.next.is_none() || last == Last::None {
                    return Err("Expected string key before ':'");
                }
                if !self.next.as_ref().unwrap().is_string() {
                    return Err("Object keys must be strings");
                }
                if last != Last::Value {
                    return Err("':' should follow a key");
                }
                let Some(Leaf::String(key)) = self.next.take() else {
                    unreachable!()
                };
                if let Some(Path::Key(old)) = self.path.last_mut() {
                    if let Some(bytes) = old.replace(key) {
                        self.trash.push_back(bytes);
                    }
                }
                self.last = Last::Colon;
            }
            b',' => {
                if last != Last::Value {
                    return Err("Expected value before ','");
                }
                if self.path.is_empty() {
                    return Err("',' not as part of an object or array");
                }
                if matches!(self.path.last(), Some(Path::Key(None))) {
                    return Err("Objects must consist of key:value pairs");
                }
                self.last = Last::Comma;
                if let Some(leaf) = self.next.take() {
                    self.emission = Some(Emission::Event(Event::new(
                        self.path.len(),
                        Some(leaf),
                        false,
                        Mutation::Advance,
                    )));
                } else {
                    self.mutate(Mutation::Advance);
                }
            }
            b']' | b'}' => {
                if self.path.is_empty() {
                    return Err(if ch == b']' {
                        "Unmatched ']' at the top-level"
                    } else {
                        "Unmatched '}' at the top-level"
                    });
                }
                if last == Last::Comma {
                    return Err(if ch == b']' {
                        "Expected another array element"
                    } else {
                        "Expected another key:value pair"
                    });
                }
                if ch == b']' && !matches!(self.path.last(), Some(Path::Index(_))) {
                    return Err("Unmatched ']' in the middle of an object");
                }
                if ch == b'}' && matches!(self.path.last(), Some(Path::Index(_))) {
                    return Err("Unmatched '}' in the middle of an array");
                }
                if ch == b'}'
                    && self.next.is_some()
                    && !matches!(self.path.last(), Some(Path::Key(Some(_))))
                {
                    return Err("Objects must consist of key:value pairs");
                }
                if ch == b'}' && self.next.is_none() {
                    if last == Last::Colon {
                        return Err("Missing value in key:value pair");
                    }
                    if last == Last::OpenArray {
                        return Err("Unmatched '}' in the middle of an array");
                    }
                    if !matches!(last, Last::Value | Last::OpenObject) {
                        return Err("Unmatched '}'");
                    }
                }
                let empty = last
                    == if ch == b']' {
                        Last::OpenArray
                    } else {
                        Last::OpenObject
                    };
                let (length, leaf, close) = if empty {
                    (
                        self.path.len() - 1,
                        Some(if ch == b']' {
                            Leaf::Array
                        } else {
                            Leaf::Object
                        }),
                        false,
                    )
                } else {
                    let leaf = self.next.take();
                    let close = leaf.is_some();
                    (self.path.len(), leaf, close)
                };
                self.emission = Some(Emission::Event(Event::new(
                    length,
                    leaf,
                    close,
                    Mutation::Pop,
                )));
            }
            _ => {}
        }
        Ok(())
    }

    fn mutate(&mut self, mutation: Mutation) {
        match mutation {
            Mutation::None => {}
            Mutation::Advance => match self.path.last_mut() {
                Some(Path::Index(index)) => *index = index.saturating_add(1),
                Some(Path::Key(key)) => {
                    if let Some(bytes) = key.take() {
                        self.trash.push_back(bytes);
                    }
                }
                _ => {}
            },
            Mutation::Pop => {
                if let Some(Path::Key(Some(bytes))) = self.path.pop() {
                    self.trash.push_back(bytes);
                }
                self.last = if self.path.is_empty() {
                    Last::None
                } else {
                    Last::Value
                };
            }
        }
    }

    fn rs(&mut self) {
        let truncated = if self.config.streaming {
            !self.path.is_empty()
                || self
                    .next
                    .as_ref()
                    .is_some_and(|v| !matches!(v, Leaf::String(_) | Leaf::Array | Leaf::Object))
        } else {
            !self.last_ws
                && (!self.stack.is_empty()
                    || !self.token.is_empty()
                    || self.next.as_ref().is_some_and(Leaf::is_number))
        };
        if !self.token.is_empty() {
            self.task = Some(Token::literal(
                std::mem::take(&mut self.token),
                AfterToken::Rs(truncated),
            ));
        } else {
            self.after_rs(truncated, None);
        }
    }

    fn after_rs(&mut self, truncated: bool, failure: Option<&'static str>) {
        if truncated {
            let top = if self.config.streaming {
                self.path.is_empty()
            } else {
                self.stack.is_empty()
            };
            let message =
                if failure.is_none() && top && self.next.as_ref().is_some_and(Leaf::is_number) {
                    "Potentially truncated top-level numeric value"
                } else {
                    "Truncated value"
                };
            self.error(message, false, true);
        } else if let Some(message) = failure {
            self.error(message, false, true);
        } else if self.lex == Lex::Normal {
            if let Some(leaf) = self.top_done() {
                self.output(leaf, Some(RS));
            } else {
                self.reset();
            }
        } else {
            self.reset();
        }
    }

    fn after_task(&mut self, after: AfterToken, result: Result<Leaf, &'static str>) {
        let result = match result {
            Ok(leaf) => self.value(leaf),
            Err(message) => Err(message),
        };
        if let AfterToken::Rs(truncated) = after {
            self.after_rs(truncated, result.err());
            return;
        }
        if let Err(message) = result {
            self.error(message, matches!(after, AfterToken::Eof), false);
            return;
        }
        match after {
            AfterToken::Delimiter(ch) => self.delimiter(ch),
            AfterToken::String => {
                self.lex = Lex::Normal;
                if let Some(leaf) = self.top_done() {
                    self.output(leaf, None);
                }
            }
            AfterToken::Eof => self.at_eof(),
            AfterToken::Rs(_) => unreachable!(),
        }
    }

    fn at_eof(&mut self) {
        if self.lex == Lex::Waiting {
            self.error("Unfinished abandoned text", true, false);
            return;
        }
        if self.lex != Lex::Normal {
            self.error("Unfinished string", true, false);
            return;
        }
        if !self.token.is_empty() {
            self.task = Some(Token::literal(
                std::mem::take(&mut self.token),
                AfterToken::Eof,
            ));
            return;
        }
        let nested = if self.config.streaming {
            !self.path.is_empty()
        } else {
            !self.stack.is_empty()
        };
        if nested {
            self.error("Unfinished JSON term", true, false);
            return;
        }
        if !self.config.streaming
            && self.config.seq
            && !self.last_ws
            && self.next.as_ref().is_some_and(Leaf::is_number)
        {
            self.error("Potentially truncated top-level numeric value", true, false);
            return;
        }
        self.ended = true;
        if let Some(leaf) = self.next.take() {
            self.output(leaf, None);
        } else {
            let document = std::mem::take(&mut self.document);
            self.discard(document);
        }
    }

    fn input_byte(&mut self, ch: u8) {
        if self.bom < 3 {
            if ch == b"\xef\xbb\xbf"[self.bom] {
                self.bom += 1;
                return;
            }
            if self.bom > 0 {
                self.bom = 255;
                if !self.config.seq {
                    self.reset();
                    self.ended = true;
                    self.emission = Some(Emission::Error("Malformed BOM".to_owned()));
                    return;
                }
                self.reset();
            } else {
                self.bom = 3;
            }
        }
        self.column = self.column.saturating_add(1);
        if ch == b'\n' {
            self.line = self.line.saturating_add(1);
            self.column = 0;
        }
        if self.lex == Lex::Waiting {
            if ch == RS {
                self.lex = Lex::Normal;
            }
            return;
        }
        if !self.config.streaming
            && self.lex == Lex::Normal
            && (!self.document.is_empty() || !separator(ch))
        {
            self.document.push(ch);
        }
        if self.config.seq && ch == RS {
            self.rs();
            return;
        }
        match self.lex {
            Lex::Normal => {
                if !whitespace(ch) && !structure(ch) && ch != b'"' {
                    self.token.push(ch);
                    self.last_ws = false;
                } else if !self.token.is_empty() {
                    self.task = Some(Token::literal(
                        std::mem::take(&mut self.token),
                        AfterToken::Delimiter(ch),
                    ));
                } else {
                    self.delimiter(ch);
                }
            }
            Lex::String if ch == b'"' => {
                self.last_ws = false;
                self.task = Some(Token::string(
                    std::mem::take(&mut self.token),
                    self.config.streaming,
                ));
            }
            Lex::String | Lex::Escape => {
                self.token.push(ch);
                self.last_ws = false;
                self.lex = if ch == b'\\' && self.lex == Lex::String {
                    Lex::Escape
                } else {
                    Lex::String
                };
            }
            Lex::Waiting => unreachable!(),
        }
    }

    fn emit(&mut self, out: &mut Vec<u8>, start: usize, budget: &mut usize) -> bool {
        let Some(mut emission) = self.emission.take() else {
            return false;
        };
        if let Emission::Error(message) = emission {
            frame(3, message.as_bytes(), out);
            self.restart_bom = self.config.seq && self.bom == 255;
            return true;
        }
        let max = (WORK - (out.len() - start)).saturating_sub(5);
        let mut payload = Vec::with_capacity(max.min(BLOCK));
        let finished = match &mut emission {
            Emission::Document { bytes, cursor } => {
                cursor.write_document(bytes, &mut payload, max, budget)
            }
            Emission::Event(event) => event.write(&self.path, &mut payload, max, budget),
            Emission::Error(_) => unreachable!(),
        };
        if !payload.is_empty() {
            frame(1, &payload, out);
        }
        if !finished || out.len() - start + 5 > WORK {
            self.emission = Some(emission);
            return false;
        }
        frame(2, &[], out);
        self.restart_bom = self.config.seq && self.bom == 255;
        if let Emission::Event(mut event) = emission {
            if let Some(leaf) = event.leaf.take() {
                self.discard_leaf(leaf);
            }
            if event.close {
                self.emission = Some(Emission::Event(Event::new(
                    event.path_len,
                    None,
                    false,
                    event.mutation,
                )));
            } else {
                self.mutate(event.mutation);
            }
        }
        true
    }

    fn cleanup(&mut self, budget: &mut usize) {
        while *budget > 0 {
            if let Some(bytes) = self.trash.front_mut() {
                let done = bytes.discard_block();
                *budget = budget.saturating_sub(BLOCK);
                if done {
                    self.trash.pop_front();
                }
            } else if let Some(path) = self.old_paths.front_mut() {
                if let Some(Path::Key(Some(bytes))) = path.pop() {
                    self.trash.push_back(bytes);
                }
                *budget -= 1;
                if path.is_empty() {
                    self.old_paths.pop_front();
                }
            } else {
                break;
            }
        }
    }

    fn step(&mut self, out: &mut Vec<u8>) {
        let start = out.len();
        let mut budget = WORK;
        while budget > 0 {
            if self.emission.is_some() {
                self.emit(out, start, &mut budget);
                return;
            }
            if self.restart_bom {
                self.restart_bom = false;
                self.reset();
            }
            if let Some(mut task) = self.task.take() {
                if let Some(result) = task.step(&mut budget, &mut self.document) {
                    let after = task.after;
                    self.discard(task.bytes);
                    if let TokenKind::String { decoded, .. } = task.kind {
                        self.discard(decoded);
                    }
                    self.after_task(after, result);
                } else {
                    self.task = Some(task);
                    return;
                }
                continue;
            }
            self.cleanup(&mut budget);
            if budget == 0 {
                return;
            }
            if self.ended {
                return;
            }
            if self.input_at < self.input.len() {
                let ch = self.input[self.input_at];
                self.input_at += 1;
                budget -= 1;
                self.input_byte(ch);
            } else if self.eof {
                self.at_eof();
            } else {
                return;
            }
        }
    }
}

impl Stream for Scanner {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !input.is_empty() {
            if input.len() > WORK {
                return Err(StreamError::new("jq scanner input exceeds 16384 bytes"));
            }
            if self.eof {
                return Err(StreamError::new("jq scanner input has ended"));
            }
            if self.ended {
                self.ended = false;
                self.input_at = self.input.len();
            }
            if self.input_at < self.input.len() {
                return Err(StreamError::new("jq scanner has pending input"));
            }
            if self.config.seq && self.bom == 255 {
                self.restart_bom = true;
            }
            self.input = input.to_vec();
            self.input_at = 0;
        }
        self.step(out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.eof = true;
        self.step(out);
        Ok(())
    }

    fn busy(&self) -> bool {
        self.emission.is_some()
            || self.task.is_some()
            || !self.trash.is_empty()
            || !self.old_paths.is_empty()
            || (!self.ended && (self.input_at < self.input.len() || self.eof))
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }

    fn done(&self) -> bool {
        self.ended
    }

    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let config: super::BeginConfig = crate::parse_config(config)?;
        if !config.discard {
            return Err(StreamError::new("jq scanner begin requires discard=true"));
        }
        self.begin_discard();
        Ok(())
    }
}

fn whitespace(ch: u8) -> bool {
    matches!(ch, b' ' | b'\t' | b'\r' | b'\n')
}
fn separator(ch: u8) -> bool {
    whitespace(ch) || ch == RS
}
fn structure(ch: u8) -> bool {
    matches!(ch, b'[' | b',' | b']' | b'{' | b':' | b'}')
}

fn frame(tag: u8, payload: &[u8], out: &mut Vec<u8>) {
    out.push(tag);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(
        data: &[u8],
        config: &str,
        chunk: usize,
        finish_pending: bool,
    ) -> Vec<(String, String)> {
        let mut scanner = open(config.as_bytes()).unwrap();
        let mut frames = Vec::new();
        let chunk = chunk.clamp(1, WORK);
        for (index, input) in data.chunks(chunk).enumerate() {
            if scanner.done() {
                break;
            }
            let mut out = Vec::new();
            scanner.feed(input, &mut out).unwrap();
            assert!(out.len() <= WORK);
            frames.extend(out);
            if !finish_pending || (index + 1) * chunk < data.len() {
                while scanner.busy() {
                    let mut out = Vec::new();
                    scanner.drain(&mut out).unwrap();
                    assert!(out.len() <= WORK);
                    frames.extend(out);
                }
            }
        }
        let mut out = Vec::new();
        scanner.finish(&mut out).unwrap();
        assert!(out.len() <= WORK);
        frames.extend(out);
        while scanner.busy() {
            let mut out = Vec::new();
            scanner.drain(&mut out).unwrap();
            assert!(out.len() <= WORK);
            frames.extend(out);
        }
        let mut text = Vec::new();
        let mut items = Vec::new();
        let mut at = 0;
        while at < frames.len() {
            let tag = frames[at];
            let length = u32::from_le_bytes(frames[at + 1..at + 5].try_into().unwrap()) as usize;
            let payload = &frames[at + 5..at + 5 + length];
            match tag {
                1 => text.extend_from_slice(payload),
                2 => items.push((
                    "text".into(),
                    String::from_utf8(std::mem::take(&mut text)).unwrap(),
                )),
                3 => {
                    assert!(text.is_empty());
                    items.push(("error".into(), String::from_utf8(payload.to_vec()).unwrap()));
                }
                _ => panic!("unknown scanner frame"),
            }
            at += 5 + length;
        }
        assert!(text.is_empty());
        let mut ended = Vec::new();
        scanner.finish(&mut ended).unwrap();
        assert!(ended.is_empty());
        items
    }

    fn fixture_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../integ/fixtures/jq/scanner.json")
    }

    #[test]
    fn shared_scanner_corpus_at_input_boundaries() {
        let fixtures: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(fixture_path()).unwrap()).unwrap();
        for case in fixtures.as_array().unwrap() {
            let hex = case["input"].as_str().unwrap();
            let data: Vec<u8> = hex
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            let config =
                serde_json::json!({"seq": case["seq"], "streaming": case["streaming"]}).to_string();
            let expected: Vec<(String, String)> =
                serde_json::from_value(case["events"].clone()).unwrap();
            for chunk in [1, 7, 4091, 16384, data.len().max(1)] {
                assert_eq!(
                    collect(&data, &config, chunk, false),
                    expected,
                    "input {hex}, config {config}, chunk {chunk}"
                );
            }
        }
    }

    #[test]
    fn large_literals_and_strings_preserve_text_in_bounded_frames() {
        let number = "1".repeat(200_000);
        let data = format!("{{\"b\":{number},\"1\":1.000}}");
        for chunk in [4095, data.len()] {
            assert_eq!(
                collect(data.as_bytes(), "{}", chunk, false),
                [("text".into(), data.clone())]
            );
        }
        let data = format!("[{number},\"{}\"]", "a".repeat(200_000));
        let output = collect(data.as_bytes(), r#"{"streaming":true}"#, data.len(), true);
        assert_eq!(
            output,
            [
                ("text".into(), format!("[[0],{number}]")),
                ("text".into(), format!("[[1],\"{}\"]", "a".repeat(200_000))),
                ("text".into(), "[[1]]".into()),
            ]
        );
    }

    #[test]
    fn finish_keeps_pending_input_and_token_validation() {
        let text = format!("\"{}\" 1.000", "a".repeat(100_000));
        assert_eq!(
            collect(text.as_bytes(), "{}", text.len(), true),
            [
                ("text".into(), format!("\"{}\"", "a".repeat(100_000))),
                ("text".into(), "1.000".into()),
            ]
        );
        let invalid = format!("\"{}\\ud800\"", "a".repeat(100_000));
        assert_eq!(
            collect(invalid.as_bytes(), "{}", invalid.len(), true),
            [(
                "error".into(),
                format!("{SURROGATE} at line 1, column {}", invalid.len())
            )]
        );
    }

    #[test]
    fn normal_depth_counts_pending_object_keys() {
        let arrays = "[".repeat(DEPTH + 1);
        assert_eq!(
            collect(arrays.as_bytes(), "{}", 4095, false),
            [(
                "error".into(),
                format!(
                    "Exceeds depth limit for parsing at line 1, column {}",
                    DEPTH + 1
                )
            )]
        );
        let objects = "{\"a\":".repeat(DEPTH / 2 + 1);
        assert_eq!(
            collect(objects.as_bytes(), "{}", 4095, false),
            [(
                "error".into(),
                "Exceeds depth limit for parsing at line 1, column 25001".into()
            )]
        );
        let objects = "{\"a\":".repeat(DEPTH + 1);
        assert_eq!(
            collect(objects.as_bytes(), r#"{"streaming":true}"#, 4095, false),
            [(
                "error".into(),
                "Exceeds depth limit for parsing at line 1, column 50001".into()
            )]
        );
    }

    #[test]
    fn seq_diagnostics_keep_the_existing_recovery_order() {
        assert_eq!(
            collect(b"\x1ex {] y", r#"{"seq":true}"#, 1, false),
            [
                (
                    "error".into(),
                    "Invalid numeric literal at line 1, column 3 (need RS to resync)".into()
                ),
                (
                    "error".into(),
                    "Unmatched ']' at line 1, column 5 (need RS to resync)".into()
                ),
                (
                    "error".into(),
                    "Invalid numeric literal at EOF at line 1, column 7".into()
                ),
            ]
        );
    }

    #[test]
    fn configuration_refuses_unknown_fields() {
        assert!(open(br#"{"stream":true}"#).is_err());
        assert!(open(br#"{"seq":1}"#).is_err());
    }

    fn leaf_blocks(leaf: &Leaf) -> usize {
        match leaf {
            Leaf::Number(bytes, _) | Leaf::String(bytes) => bytes.block_count(),
            _ => 0,
        }
    }

    fn path_blocks(path: &Paths) -> usize {
        path.entries
            .values()
            .map(|part| match part {
                Path::Key(Some(bytes)) => bytes.block_count(),
                _ => 0,
            })
            .sum()
    }

    fn retained_blocks(scanner: &Scanner) -> usize {
        let task = scanner.task.as_ref().map_or(0, |task| {
            task.bytes.block_count()
                + match &task.kind {
                    TokenKind::String { decoded, .. } => decoded.block_count(),
                    _ => 0,
                }
        });
        let emission = scanner
            .emission
            .as_ref()
            .map_or(0, |emission| match emission {
                Emission::Document { bytes, .. } => bytes.block_count(),
                Emission::Event(event) => event.leaf.as_ref().map_or(0, leaf_blocks),
                Emission::Error(_) => 0,
            });
        scanner.token.block_count()
            + scanner.document.block_count()
            + scanner.next.as_ref().map_or(0, leaf_blocks)
            + path_blocks(&scanner.path)
            + scanner.old_paths.iter().map(path_blocks).sum::<usize>()
            + scanner.trash.iter().map(Bytes::block_count).sum::<usize>()
            + task
            + emission
    }

    fn assert_discard_cleanup(scanner: &mut Scanner) {
        let before = retained_blocks(scanner);
        assert!(before > WORK / BLOCK);
        scanner.begin(br#"{"discard":true}"#).unwrap();
        assert_eq!(retained_blocks(scanner), before);
        assert_eq!(scanner.input_at, scanner.input.len());
        assert!(scanner.input.capacity() <= WORK);
        assert!(scanner.task.is_none());
        assert!(scanner.emission.is_none());
        let mut previous = before;
        while scanner.busy() {
            let mut out = Vec::new();
            scanner.drain(&mut out).unwrap();
            assert!(out.is_empty());
            let remaining = retained_blocks(scanner);
            assert!(previous - remaining <= WORK / BLOCK);
            previous = remaining;
        }
        assert_eq!(retained_blocks(scanner), 0);
        assert!(scanner.done());
        assert!(scanner.feed(b"x", &mut Vec::new()).is_err());
        let mut out = Vec::new();
        scanner.finish(&mut out).unwrap();
        assert!(out.is_empty());
        scanner.begin(br#"{"discard":true}"#).unwrap();
        assert!(!scanner.busy());
    }

    #[test]
    fn discard_retires_large_unfinished_tokens_and_validation() {
        for streaming in [false, true] {
            let mut scanner = Scanner::new(Config {
                streaming,
                seq: false,
            });
            scanner.feed(b"\"", &mut Vec::new()).unwrap();
            for _ in 0..100 {
                scanner.feed(&vec![b'a'; 4095], &mut Vec::new()).unwrap();
                while scanner.busy() {
                    scanner.drain(&mut Vec::new()).unwrap();
                }
            }
            if streaming {
                scanner.feed(b"\"", &mut Vec::new()).unwrap();
                assert!(scanner.task.is_some());
            }
            assert_discard_cleanup(&mut scanner);
        }
    }

    #[test]
    fn discard_during_emission_retires_document_leaf_and_path_key() {
        for streaming in [false, true] {
            let text = format!(
                "{{\"{}\":\"{}\"}}",
                "k".repeat(200_000),
                "v".repeat(200_000)
            );
            let mut scanner = Scanner::new(Config {
                streaming,
                seq: false,
            });
            let mut started = false;
            for input in text.as_bytes().chunks(4095) {
                let mut out = Vec::new();
                scanner.feed(input, &mut out).unwrap();
                while out.is_empty() && scanner.busy() {
                    scanner.drain(&mut out).unwrap();
                }
                if !out.is_empty() {
                    started = true;
                    break;
                }
            }
            assert!(started);
            assert!(scanner.emission.is_some());
            if streaming {
                assert!(path_blocks(&scanner.path) > WORK / BLOCK);
            }
            assert_discard_cleanup(&mut scanner);
        }
    }

    #[test]
    fn discard_requires_explicit_configuration_and_bounded_input() {
        let mut scanner = open(b"{}").unwrap();
        assert!(scanner.begin(b"{}").is_err());
        assert!(scanner.begin(br#"{"discard":false}"#).is_err());
        assert!(scanner.begin(br#"{"discard":true,"extra":true}"#).is_err());
        assert!(
            scanner
                .feed(&vec![b'a'; WORK + 1], &mut Vec::new())
                .is_err()
        );
        assert!(!scanner.busy());
    }

    #[test]
    fn malformed_strings_decode_their_unescaped_contents_before_handoff() {
        let cases: &[(&[u8], &str)] = &[
            (b"\"\xe2\"", "\"�\""),
            (b"\"\xe2a\"", "\"�\""),
            (b"\"\xe2\\n\"", "\"�\""),
            (b"\"\xe2\\u000a\"", "\"�\""),
            (b"\"\xe2\\u0000\"", "\"�\""),
            (b"\"\xe2a\\n\"", "\"�a\\n\""),
            (b"\"\xe2\\n\\t\"", "\"�\\n\\t\""),
            (b"\"\xe2\\\"\"", "\"�\""),
            (b"\"\\u0061\xe2\"", "\"a�\""),
        ];
        for &(data, text) in cases {
            for chunk in [1, 7, WORK] {
                assert_eq!(
                    collect(data, "{}", chunk, false),
                    [("text".into(), text.into())]
                );
                assert_eq!(
                    collect(data, r#"{"streaming":true}"#, chunk, false),
                    [("text".into(), format!("[[],{text}]"))]
                );
                let mut seq = vec![RS];
                seq.extend_from_slice(data);
                seq.push(b'\n');
                assert_eq!(
                    collect(&seq, r#"{"seq":true}"#, chunk, false),
                    [("text".into(), text.into())]
                );
            }
        }
        let data = b"{\"\xe2a\": 100000000000000000001, \"b\":\"\xe2\\n\", \"1\":1.000}";
        assert_eq!(
            collect(data, "{}", 1, false),
            [(
                "text".into(),
                "{\"�\": 100000000000000000001, \"b\":\"�\", \"1\":1.000}".into()
            )]
        );
        let valid = br#"{"b":"a\u00e9","1":1.000,"n":100000000000000000001}"#;
        assert_eq!(
            collect(valid, "{}", 1, false),
            [("text".into(), std::str::from_utf8(valid).unwrap().into())]
        );
    }

    #[test]
    fn malformed_string_normalization_is_bounded_and_discardable() {
        let mut data = b"\"".to_vec();
        data.extend_from_slice(&b"\\u0061".repeat(40_000));
        data.extend_from_slice(b"\xe2\\n\"");
        assert_eq!(
            collect(&data, "{}", WORK, false),
            [("text".into(), format!("\"{}�\"", "a".repeat(40_000)))]
        );
        let mut scanner = Scanner::new(Config::default());
        scanner.feed(b"\"", &mut Vec::new()).unwrap();
        for _ in 0..100 {
            scanner.feed(&vec![b'a'; 4095], &mut Vec::new()).unwrap();
            while scanner.busy() {
                scanner.drain(&mut Vec::new()).unwrap();
            }
        }
        scanner.feed(b"\xe2\"", &mut Vec::new()).unwrap();
        loop {
            if matches!(
                scanner.task.as_ref().map(|task| &task.kind),
                Some(TokenKind::String {
                    phase: StringPhase::Quoted,
                    ..
                })
            ) {
                break;
            }
            let mut out = Vec::new();
            scanner.drain(&mut out).unwrap();
            assert!(out.is_empty());
        }
        assert_discard_cleanup(&mut scanner);
    }

    #[test]
    fn numeric_nul_suffix_replacement_preserves_structural_boundaries() {
        let cases: &[(&[u8], &str)] = &[
            (b"[1\0\xe2]", "[1\0�]"),
            (b"[1\0\xe2a]", "[1\0�a]"),
            (b"{\"b\":1\0\xe2}", "{\"b\":1\0�}"),
            (b"1\0\xe2", "1\0�"),
            (b"1\x002", "1\x002"),
            (b"[1.000\0\xf0\x80\x80\x80]", "[1.000\0����]"),
        ];
        for &(data, text) in cases {
            for chunk in [1, 7, WORK] {
                assert_eq!(
                    collect(data, "{}", chunk, false),
                    [("text".into(), text.into())]
                );
            }
        }
    }
}
