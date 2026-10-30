// Adapted from jq 1.8.2 (MIT). See licenses/third_party/jq.txt.

use std::collections::{BTreeMap, VecDeque};

use serde::Deserialize;

use super::meter::{self, Charge};
use super::unicode::{BLOCK, Bytes, DecodeCursor, JsonString, WORK, decode_slice};
use super::value::{
    Key, Keys, LITERAL, List, Number, NumberReading, Object, Retirement, Text, Value, number_token,
};
use crate::{Stream, StreamError};
use std::sync::Arc;

const DEPTH: usize = 10000;
/// The work freeing one block of a discarded token costs.
const FREE: usize = BLOCK / 64;
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

/// Under values, an array or object being read, and the key its next
/// value goes under.
enum Open {
    Array(List),
    Object(Object, Option<Key>),
}

impl Open {
    fn close(self) -> Value {
        match self {
            Self::Array(items) => Value::Array(Arc::new(items)),
            Self::Object(fields, _) => Value::object(fields),
        }
    }
}

/// An object key on a `--stream` path: its bytes as read, or under
/// values the string they decode to.
enum Name {
    Bytes(Bytes),
    Text(Arc<Text>),
}

enum Path {
    Index(u64),
    Key(Option<Name>),
}

#[derive(Default)]
struct Paths {
    entries: BTreeMap<usize, Path>,
    charge: Charge,
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
        self.charge
            .set(self.entries.len() * (std::mem::size_of::<Path>() + 64));
    }

    fn pop(&mut self) -> Option<Path> {
        let path = self.entries.pop_last().map(|(_, path)| path);
        self.charge
            .set(self.entries.len() * (std::mem::size_of::<Path>() + 64));
        path
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
    /// Under values: a string as it decodes.
    Text(String),
    /// Under values: a number, or an array or object read whole.
    Value(Value),
    Array,
    Object,
}

impl Leaf {
    fn is_number(&self) -> bool {
        matches!(self, Self::Number(..) | Self::Value(Value::Number(_)))
    }

    fn is_string(&self) -> bool {
        matches!(self, Self::String(_) | Self::Text(_))
    }

    /// The value a leaf read under values is.
    fn into_value(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(b) => Value::bool(b),
            Self::Text(text) => Value::string(text),
            Self::Value(value) => value,
            Self::Array => Value::array(Vec::new()),
            Self::Object => Value::object(Object::default()),
            Self::Number(..) | Self::String(_) => unreachable!("a leaf kept as text"),
        }
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
        /// Under values, a literal longer than a page: its text gathered a
        /// budget at a time to the length read, charged while it is held,
        /// and its reading.
        reading: Option<(Vec<u8>, usize, Charge, NumberReading)>,
    },
    String {
        decoded: Captured,
        capture: bool,
        /// Whether its source must be valid UTF-8 to be written back as
        /// it was read.
        validate: bool,
        utf8: Utf8Check,
        phase: StringPhase,
        quoted: JsonString,
        /// Under values, the string its malformed bytes decode to.
        replaced: String,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum StringPhase {
    Validate,
    Recapture,
    Source,
    Quoted,
    Replace,
}

/// Where a string token's decoded bytes go: blocks the text is written
/// back from, or under values the one buffer its string is made of.
enum Captured {
    Blocks(Bytes),
    Buffer(Vec<u8>, Charge),
}

impl Captured {
    fn extend(&mut self, bytes: &[u8]) {
        match self {
            Self::Blocks(blocks) => blocks.extend(bytes),
            Self::Buffer(buffer, charge) => {
                let capacity = buffer.capacity();
                buffer.extend_from_slice(bytes);
                if buffer.capacity() != capacity {
                    charge.set(buffer.capacity());
                }
            }
        }
    }

    fn push(&mut self, byte: u8) {
        self.extend(&[byte]);
    }

    fn blocks(&mut self) -> &mut Bytes {
        match self {
            Self::Blocks(blocks) => blocks,
            Self::Buffer(..) => unreachable!("a string read as a value"),
        }
    }
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
    /// Whether it is read as a value rather than written back as text.
    values: bool,
}

impl Token {
    fn literal(bytes: Bytes, after: AfterToken, values: bool) -> Self {
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
                reading: None,
            },
            after,
            values,
        }
    }

    fn string(bytes: Bytes, streaming: bool, values: bool) -> Self {
        let decoded = if values {
            let buffer = Vec::with_capacity(bytes.len());
            let charge = Charge::open(buffer.capacity());
            Captured::Buffer(buffer, charge)
        } else {
            Captured::Blocks(Bytes::default())
        };
        Self {
            bytes,
            at: 0,
            kind: TokenKind::String {
                decoded,
                capture: streaming || values,
                validate: !streaming && !values,
                utf8: Utf8Check::default(),
                phase: StringPhase::Validate,
                quoted: JsonString::default(),
                replaced: String::new(),
            },
            after: AfterToken::String,
            values,
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
                reading,
            } => loop {
                if let Some((text, length, _, number)) = reading {
                    while text.len() < *length && *budget > 0 {
                        let run = self.bytes.run_at(text.len());
                        let taken = run.len().min(*length - text.len()).min(*budget);
                        if taken == 0 {
                            return Some(Err("Invalid numeric literal"));
                        }
                        text.extend_from_slice(&run[..taken]);
                        *budget -= taken;
                    }
                    while text.len() == *length && *budget > 0 {
                        *budget -= 1;
                        match number.step(text) {
                            Ok(Some(value)) => return Some(Ok(Leaf::Value(value))),
                            Ok(None) => {}
                            Err(_) => return Some(Err("Invalid numeric literal")),
                        }
                    }
                    return None;
                }
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
                if !self.values {
                    return Some(Ok(Leaf::Number(std::mem::take(&mut self.bytes), length)));
                }
                let first = self.bytes.run_at(0);
                if length <= LITERAL && first.len() >= length {
                    return Some(
                        std::str::from_utf8(&first[..length])
                            .ok()
                            .and_then(number_token)
                            .map(Leaf::Value)
                            .ok_or("Invalid numeric literal"),
                    );
                }
                let text = Vec::with_capacity(length);
                let charge = Charge::open(text.capacity());
                *reading = Some((text, length, charge, NumberReading::begin(0, length)));
            },
            TokenKind::String {
                decoded,
                capture,
                validate,
                utf8,
                phase,
                quoted,
                replaced,
            } => loop {
                if *phase == StringPhase::Replace {
                    let Captured::Buffer(bytes, charge) = decoded else {
                        unreachable!("only a value is replaced")
                    };
                    while self.at < bytes.len() && *budget > 0 {
                        let (point, taken) = decode_slice(bytes, self.at);
                        replaced.push(point);
                        self.at += taken;
                        *budget = budget.saturating_sub(taken);
                    }
                    charge.set(bytes.capacity() + replaced.capacity());
                    if self.at < bytes.len() {
                        return None;
                    }
                    return Some(Ok(Leaf::Text(std::mem::take(replaced))));
                }
                if *phase == StringPhase::Source {
                    while self.at < self.bytes.len() && *budget > 0 {
                        let run = self.bytes.run_at(self.at);
                        let run = &run[..run.len().min(*budget)];
                        document.extend(run);
                        self.at += run.len();
                        *budget -= run.len();
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
                    let finished =
                        quoted.write(decoded.blocks(), &mut output, BLOCK, &mut render_budget);
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
                    let run = self.bytes.run_at(self.at);
                    let plain = run
                        .iter()
                        .take(*budget)
                        .take_while(|b| **b >= 0x20 && **b != b'\\')
                        .count();
                    if plain > 0 {
                        let run = &run[..plain];
                        if *validate
                            && *phase == StringPhase::Validate
                            && !(utf8.remaining == 0 && run.is_ascii())
                        {
                            for byte in run {
                                utf8.push(*byte);
                            }
                        }
                        if *capture {
                            decoded.extend(run);
                        }
                        self.at += plain;
                        *budget -= plain;
                        continue;
                    }
                    let ch = self.bytes.get(self.at).unwrap();
                    if *validate && *phase == StringPhase::Validate {
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
                } else if self.values {
                    let Captured::Buffer(bytes, _) = decoded else {
                        unreachable!("a value is read into a buffer")
                    };
                    *budget = budget.saturating_sub(bytes.len() / 64);
                    match String::from_utf8(std::mem::take(bytes)) {
                        Ok(text) => return Some(Ok(Leaf::Text(text))),
                        Err(error) => {
                            *bytes = error.into_bytes();
                            replaced.reserve(bytes.len());
                            self.at = 0;
                            *phase = StringPhase::Replace;
                        }
                    }
                } else if !*validate {
                    return Some(Ok(Leaf::String(std::mem::take(decoded.blocks()))));
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
                        Path::Key(Some(Name::Bytes(bytes))) => {
                            let string = self.string.get_or_insert_with(JsonString::default);
                            if !string.write(bytes, out, max, budget) {
                                return false;
                            }
                            self.string = None;
                        }
                        Path::Key(Some(Name::Text(_))) => unreachable!("a name read as a value"),
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
                        Leaf::Text(_) | Leaf::Value(_) => unreachable!("a leaf read as a value"),
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
    Document {
        bytes: Bytes,
        cursor: DecodeCursor,
    },
    Event(Event),
    /// Under values, a document read whole.
    Value(Value),
    Error(String),
}

/// What the scanner read under values: a document, or under `--stream`
/// an event, or the parse error that stopped it.
pub(crate) enum Scanned {
    Value(Value),
    Error(String),
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = crate::parse_config(config)?;
    Ok(Box::new(Scanner::new(config, false)))
}

/// jq's scanner, a document or event as it reads it: written back as
/// literal-preserving text in frames, or under values built as the
/// value it is, which `take` hands over after each step.
pub(crate) struct Scanner {
    config: Config,
    lex: Lex,
    last: Last,
    stack: Vec<Container>,
    path: Paths,
    next: Option<Leaf>,
    token: Bytes,
    /// A finished token's buffer, emptied for the next token to fill.
    spare: Option<Bytes>,
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
    values: bool,
    /// Under values, the arrays and objects open around the next value.
    opened: Vec<Open>,
    keys: Keys,
    /// Under values, what an abandoned document held, freed a node a
    /// step.
    retiring: Vec<Retirement>,
    scanned: Option<Scanned>,
    charge: Charge,
}

impl Scanner {
    /// The scanner jq reads its inputs and `fromjson` its text with, each
    /// document or `--stream` event built as a value.
    pub(crate) fn values(seq: bool, streaming: bool) -> Self {
        Self::new(Config { seq, streaming }, true)
    }

    fn new(config: Config, values: bool) -> Self {
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
            spare: None,
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
            values,
            opened: Vec::new(),
            keys: Keys::default(),
            retiring: Vec::new(),
            scanned: None,
            charge: Charge::open(0),
        }
    }

    /// The document, event or error the last step read under values.
    pub(crate) fn take(&mut self) -> Option<Scanned> {
        self.scanned.take()
    }

    fn recharge(&mut self) {
        self.charge
            .set(self.opened.capacity() * std::mem::size_of::<Open>() + self.keys.bytes());
    }

    /// Leave a value given up to be freed a node a step.
    pub(crate) fn retire(&mut self, value: Value) {
        if matches!(value, Value::Array(_) | Value::Object(_)) {
            self.retiring.push(Retirement::values(vec![value]));
        }
    }

    fn drop_name(&mut self, name: Name) {
        if let Name::Bytes(bytes) = name {
            self.trash.push_back(bytes);
        }
    }

    fn discard(&mut self, bytes: Bytes) {
        if !bytes.is_empty() {
            self.trash.push_back(bytes);
        }
    }

    /// A finished token's buffer: the spare the next token fills when it
    /// holds one block, else trash.
    fn recycle(&mut self, mut bytes: Bytes) {
        if self.spare.is_none() && bytes.clear_one() {
            self.spare = Some(bytes);
        } else {
            self.discard(bytes);
        }
    }

    /// The token read so far, a spare buffer taking its place.
    fn take_token(&mut self) -> Bytes {
        std::mem::replace(&mut self.token, self.spare.take().unwrap_or_default())
    }

    fn discard_leaf(&mut self, leaf: Leaf) {
        match leaf {
            Leaf::String(bytes) | Leaf::Number(bytes, _) => self.discard(bytes),
            Leaf::Value(value) => self.retire(value),
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
        if !self.opened.is_empty() {
            let opened = self.opened.drain(..).map(Open::close).collect();
            self.retiring.push(Retirement::values(opened));
        }
        self.keys.clear();
        self.recharge();
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
            self.discard_task(task);
        }
        match self.emission.take() {
            Some(Emission::Document { bytes, .. }) => self.discard(bytes),
            Some(Emission::Event(mut event)) => {
                if let Some(leaf) = event.leaf.take() {
                    self.discard_leaf(leaf);
                }
            }
            Some(Emission::Value(value)) => self.retire(value),
            _ => {}
        }
        if let Some(Scanned::Value(value)) = self.scanned.take() {
            self.retire(value);
        }
    }

    fn discard_task(&mut self, task: Token) {
        self.discard(task.bytes);
        if let TokenKind::String {
            decoded: Captured::Blocks(decoded),
            ..
        } = task.kind
        {
            self.discard(decoded);
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
        } else if self.values {
            self.keys.clear();
            self.recharge();
            self.emission = Some(Emission::Value(leaf.into_value()));
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
                if self.values {
                    self.opened.push(if ch == b'[' {
                        Open::Array(List::default())
                    } else {
                        Open::Object(Object::default(), None)
                    });
                    self.recharge();
                }
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
                if let Leaf::Text(text) = leaf {
                    let key = self.keys.key(text);
                    if let Some(Open::Object(_, slot)) = self.opened.last_mut() {
                        *slot = Some(key);
                    }
                    self.recharge();
                } else {
                    self.discard_leaf(leaf);
                }
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
                self.element(leaf);
            }
            b']' => {
                let Some(Container::Array(nonempty)) = self.stack.last() else {
                    return Err("Unmatched ']'");
                };
                if self.next.is_none() && *nonempty {
                    return Err("Expected another array element");
                }
                if let Some(leaf) = self.next.take() {
                    self.element(leaf);
                }
                self.stack.pop();
                self.next = Some(self.closed(Leaf::Array));
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
                    self.element(leaf);
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
                self.next = Some(self.closed(Leaf::Object));
            }
            _ => {}
        }
        Ok(())
    }

    /// An array's element or an object's value read whole: under values
    /// placed in the container it closes.
    fn element(&mut self, leaf: Leaf) {
        if !self.values {
            self.discard_leaf(leaf);
            return;
        }
        let value = leaf.into_value();
        match self.opened.last_mut() {
            Some(Open::Array(items)) => items.push(value),
            Some(Open::Object(fields, key)) => {
                fields.insert(key.take().expect("a key read before its value"), value);
            }
            None => unreachable!("an element outside a container"),
        }
    }

    /// The array or object a bracket closed: under values the one built.
    fn closed(&mut self, leaf: Leaf) -> Leaf {
        if !self.values {
            return leaf;
        }
        let value = self.opened.pop().expect("an open container").close();
        self.recharge();
        Leaf::Value(value)
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
                let name = match self.next.take() {
                    Some(Leaf::String(key)) => Name::Bytes(key),
                    Some(Leaf::Text(text)) => {
                        Name::Text(Arc::new(Text::new(text.into_boxed_str())))
                    }
                    _ => unreachable!(),
                };
                let old = match self.path.last_mut() {
                    Some(Path::Key(slot)) => slot.replace(name),
                    _ => None,
                };
                if let Some(old) = old {
                    self.drop_name(old);
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
            Mutation::Advance => {
                let old = match self.path.last_mut() {
                    Some(Path::Index(index)) => {
                        *index = index.saturating_add(1);
                        None
                    }
                    Some(Path::Key(key)) => key.take(),
                    None => None,
                };
                if let Some(old) = old {
                    self.drop_name(old);
                }
            }
            Mutation::Pop => {
                if let Some(Path::Key(Some(name))) = self.path.pop() {
                    self.drop_name(name);
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
                || self.next.as_ref().is_some_and(|v| {
                    !matches!(
                        v,
                        Leaf::String(_) | Leaf::Text(_) | Leaf::Array | Leaf::Object
                    )
                })
        } else {
            !self.last_ws
                && (!self.stack.is_empty()
                    || !self.token.is_empty()
                    || self.next.as_ref().is_some_and(Leaf::is_number))
        };
        if !self.token.is_empty() {
            self.task = Some(Token::literal(
                self.take_token(),
                AfterToken::Rs(truncated),
                self.values,
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
                self.take_token(),
                AfterToken::Eof,
                self.values,
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
        if !self.values
            && !self.config.streaming
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
                if literal(ch) {
                    self.token.push(ch);
                    self.last_ws = false;
                } else if !self.token.is_empty() {
                    self.task = Some(Token::literal(
                        self.take_token(),
                        AfterToken::Delimiter(ch),
                        self.values,
                    ));
                } else {
                    self.delimiter(ch);
                }
            }
            Lex::String if ch == b'"' => {
                self.last_ws = false;
                self.task = Some(Token::string(
                    self.take_token(),
                    self.config.streaming,
                    self.values,
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
            if self.values {
                self.scanned = Some(Scanned::Error(message));
            } else {
                frame(3, message.as_bytes(), out);
            }
            self.restart_bom = self.config.seq && self.bom == 255;
            return true;
        }
        if self.values {
            let value = match emission {
                Emission::Value(value) => value,
                Emission::Event(mut event) => {
                    let value = self.event(&mut event, budget);
                    self.after_event(event);
                    value
                }
                Emission::Document { .. } | Emission::Error(_) => unreachable!(),
            };
            self.scanned = Some(Scanned::Value(value));
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
            Emission::Value(_) | Emission::Error(_) => unreachable!(),
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
            self.after_event(event);
        }
        true
    }

    /// The `--stream` event as a value: its path, and its leaf unless it
    /// closes a container.
    fn event(&self, event: &mut Event, budget: &mut usize) -> Value {
        *budget = budget.saturating_sub(event.path_len);
        let path = (0..event.path_len)
            .map(
                |at| match self.path.get(at).expect("a path as long as its event") {
                    Path::Index(index) => Value::Number(Number::literal(&index.to_string())),
                    Path::Key(Some(Name::Text(text))) => Value::String(Arc::clone(text)),
                    Path::Key(None) => Value::Null,
                    Path::Key(Some(Name::Bytes(_))) => unreachable!("a name kept as text"),
                },
            )
            .collect();
        let path = Value::array(path);
        Value::array(match event.leaf.take() {
            Some(leaf) => vec![path, leaf.into_value()],
            None => vec![path],
        })
    }

    fn after_event(&mut self, event: Event) {
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

    /// Free the trash a block at a time, keeping a buffer of one block as
    /// the spare the next token fills.
    fn cleanup(&mut self, budget: &mut usize) {
        while *budget > 0 {
            if let Some(bytes) = self.trash.front_mut() {
                if self.spare.is_none() && bytes.clear_one() {
                    self.spare = self.trash.pop_front();
                    *budget -= 1;
                    continue;
                }
                if bytes.discard_block() {
                    self.trash.pop_front();
                }
                *budget = budget.saturating_sub(FREE);
            } else if let Some(chunk) = self.retiring.last_mut() {
                match chunk.next() {
                    Some(value) => {
                        if let Some(children) = Retirement::split(value) {
                            self.retiring.push(children);
                        }
                    }
                    None => {
                        self.retiring.pop();
                    }
                }
                *budget -= 1;
            } else if let Some(path) = self.old_paths.front_mut() {
                if let Some(Path::Key(Some(Name::Bytes(bytes)))) = path.pop() {
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
                    let bytes = std::mem::take(&mut task.bytes);
                    self.discard_task(task);
                    self.recycle(bytes);
                    self.after_task(after, result);
                } else {
                    self.task = Some(task);
                    return;
                }
                continue;
            }
            if !self.trash.is_empty() || !self.retiring.is_empty() || !self.old_paths.is_empty() {
                self.cleanup(&mut budget);
                if budget == 0 {
                    return;
                }
            }
            if self.ended {
                return;
            }
            if self.lex == Lex::String && self.bom >= 3 {
                let plain = self.input[self.input_at..]
                    .iter()
                    .take(budget)
                    .take_while(|b| **b >= 0x20 && **b != b'"' && **b != b'\\')
                    .count();
                if plain > 0 {
                    self.token
                        .extend(&self.input[self.input_at..self.input_at + plain]);
                    self.input_at += plain;
                    self.column = self.column.saturating_add(plain as u64);
                    self.last_ws = false;
                    budget -= plain;
                    continue;
                }
            }
            if self.lex == Lex::Normal && self.bom >= 3 {
                let plain = self.input[self.input_at..]
                    .iter()
                    .take(budget)
                    .take_while(|b| literal(**b) && **b != RS)
                    .count();
                if plain > 0 {
                    let run = &self.input[self.input_at..self.input_at + plain];
                    self.token.extend(run);
                    if !self.values && !self.config.streaming {
                        self.document.extend(run);
                    }
                    self.input_at += plain;
                    self.column = self.column.saturating_add(plain as u64);
                    self.last_ws = false;
                    budget -= plain;
                    continue;
                }
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
            || !self.retiring.is_empty()
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
/// A byte of a literal token: not whitespace, structure or a quote.
fn literal(ch: u8) -> bool {
    !whitespace(ch) && !structure(ch) && ch != b'"'
}

fn frame(tag: u8, payload: &[u8], out: &mut Vec<u8>) {
    out.push(tag);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

/// jv_parse_sized: the one JSON value `text` holds, read by the scanner
/// jq reads its inputs with, or jq's message for why it holds none, more
/// than one, or a bad one, naming the text up to its first NUL.
pub(crate) fn parse_value(text: &[u8]) -> Result<Value, String> {
    let _recording = meter::record_only();
    let mut budget = u64::MAX;
    Decoding::begin(text)
        .run(&mut budget)
        .unwrap_or_else(|| unreachable!("an unbounded budget finishes the decode"))
}

struct Wrapping {
    message: String,
    at: usize,
    out: String,
    charge: Charge,
}

impl Wrapping {
    fn begin(message: String) -> Self {
        let charge = Charge::open(message.capacity());
        Self {
            message,
            at: 0,
            out: String::new(),
            charge,
        }
    }

    fn step(&mut self, text: &[u8]) -> Option<String> {
        if self.out.is_empty() {
            self.out.push_str(&self.message);
            self.out.push_str(" (while parsing '");
        }
        let start = self.at;
        let mut ended = false;
        while self.at < text.len() && self.at - start < 64 {
            let byte = text[self.at];
            if byte == 0 {
                ended = true;
                break;
            }
            let len = match byte {
                0..=0x7f => 1,
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => 1,
            };
            let piece = &text[self.at..(self.at + len).min(text.len())];
            match std::str::from_utf8(piece) {
                Ok(piece) => {
                    self.out.push_str(piece);
                    self.at += piece.len();
                }
                Err(error) => {
                    self.out.push('\u{fffd}');
                    self.at += error.error_len().unwrap_or(piece.len());
                }
            }
        }
        self.charge
            .set(self.message.capacity() + self.out.capacity());
        if ended || self.at == text.len() {
            self.out.push_str("')");
            self.charge.set(self.message.capacity());
            Some(std::mem::take(&mut self.out))
        } else {
            None
        }
    }
}

enum DecodeText {
    Shared(Arc<Text>),
    Raw { bytes: Vec<u8>, _charge: Charge },
}

impl DecodeText {
    fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Shared(text) => text.as_bytes(),
            Self::Raw { bytes, .. } => bytes,
        }
    }
    fn len(&self) -> usize {
        self.as_bytes().len()
    }
}

/// One `fromjson` in progress: jq's scanner over the text, a chunk per
/// step, building the one document it holds, so a long text is decoded
/// a bounded slice at a time.
pub(crate) struct Decoding {
    text: DecodeText,
    scanner: Scanner,
    fed: usize,
    finished: bool,
    values: Vec<Value>,
    error: Option<String>,
    charge: Charge,
    retiring: bool,
    wrapping: Option<Wrapping>,
}

impl Decoding {
    pub(crate) fn retire(&mut self) -> Option<Value> {
        if let Some(value) = self.values.pop() {
            return Some(value);
        }
        if !self.retiring {
            self.scanner.begin_discard();
            self.retiring = true;
        }
        let mut budget = BLOCK;
        self.scanner.cleanup(&mut budget);
        if self.scanner.busy() {
            return Some(Value::Null);
        }
        None
    }

    pub(crate) fn begin(text: &[u8]) -> Self {
        let bytes = text.to_vec();
        let charge = Charge::open(bytes.capacity());
        Self::open(DecodeText::Raw {
            bytes,
            _charge: charge,
        })
    }

    pub(crate) fn from_text(text: Arc<Text>) -> Self {
        Self::open(DecodeText::Shared(text))
    }

    fn open(text: DecodeText) -> Self {
        Self {
            text,
            scanner: Scanner::values(false, false),
            fed: 0,
            finished: false,
            values: Vec::new(),
            error: None,
            charge: Charge::open(0),
            retiring: false,
            wrapping: None,
        }
    }

    /// Works on, a scanner chunk per step plus one per 64 bytes it
    /// read: the value or jq's message once the text is read, None when
    /// `budget` ran out first.
    pub(crate) fn run(&mut self, budget: &mut u64) -> Option<Result<Value, String>> {
        while *budget > 0 {
            if let Some(wrapping) = &mut self.wrapping {
                *budget -= 1;
                let message = wrapping.step(self.text.as_bytes());
                if meter::should_pause() {
                    *budget = 0;
                    return None;
                }
                if let Some(message) = message {
                    return Some(Err(message));
                }
                continue;
            }
            let moved = match self.scan() {
                Ok(Some(moved)) => moved,
                Ok(None) => match self.decide() {
                    Ok(value) => return Some(Ok(value)),
                    Err(message) => {
                        self.wrapping = Some(Wrapping::begin(message));
                        continue;
                    }
                },
                Err(message) => return Some(Err(message)),
            };
            self.recharge();
            *budget = budget.saturating_sub(1 + moved as u64 / 64);
            if meter::should_pause() {
                *budget = 0;
                return None;
            }
        }
        None
    }

    fn recharge(&mut self) {
        self.charge.set(
            self.values.capacity() * std::mem::size_of::<Value>()
                + self.scanner.input.capacity()
                + self.scanner.stack.capacity() * std::mem::size_of::<Container>(),
        );
    }

    fn scan(&mut self) -> Result<Option<usize>, String> {
        if self.scanner.busy() {
            self.scanner.drain(&mut Vec::new()).map_err(|e| e.message)?;
            self.take();
            return Ok(Some(WORK));
        }
        if self.values.len() > 1 || self.error.is_some() {
            return Ok(None);
        }
        if self.fed < self.text.len() {
            let end = (self.fed + WORK).min(self.text.len());
            self.scanner
                .feed(&self.text.as_bytes()[self.fed..end], &mut Vec::new())
                .map_err(|e| e.message)?;
            self.take();
            let chunk = end - self.fed;
            self.fed = end;
            return Ok(Some(chunk));
        }
        if !self.finished {
            self.finished = true;
            self.scanner
                .finish(&mut Vec::new())
                .map_err(|e| e.message)?;
            self.take();
            return Ok(Some(WORK));
        }
        Ok(None)
    }

    fn take(&mut self) {
        match self.scanner.take() {
            Some(Scanned::Value(value)) => self.values.push(value),
            Some(Scanned::Error(message)) => self.error = Some(message),
            None => {}
        }
    }

    fn decide(&mut self) -> Result<Value, String> {
        match (self.values.len(), self.error.take()) {
            (0, Some(message)) | (1, Some(message)) => Err(message),
            (0, None) => Err("Expected JSON value".to_string()),
            (1, None) => Ok(self.values.pop().expect("one document")),
            _ => Err("Unexpected extra JSON values".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoded_document_transfer_stays_within_the_cap_and_releases() {
        let meter = Arc::new(meter::Meter::limited(60000));
        let _installed = meter::install(&meter);
        let text = format!("\"{}\"", r"\u0061".repeat(1666));
        let mut decoding = Decoding::begin(text.as_bytes());
        let value = loop {
            let result = decoding.run(&mut 1);
            assert!(!meter.exceeded(), "{} retained bytes", meter.live());
            if let Some(result) = result {
                break result.unwrap();
            }
        };
        drop(decoding);
        assert_eq!(value.dump(), format!("\"{}\"", "a".repeat(1666)));
        assert!(!meter.exceeded());
        drop(value);
        assert_eq!(meter.live(), 0);
    }

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

    /// What the scanner read last under values, as `collect` names a
    /// frame: the document's or event's dump, or the error.
    fn take_scanned(scanner: &mut Scanner, items: &mut Vec<(String, String)>) {
        match scanner.take() {
            Some(Scanned::Value(value)) => items.push(("text".into(), value.dump())),
            Some(Scanned::Error(message)) => items.push(("error".into(), message)),
            None => {}
        }
    }

    /// The scanner under values, collected as `collect` collects its
    /// frames: each document's or event's dump, or each error.
    fn collect_values(
        data: &[u8],
        seq: bool,
        streaming: bool,
        chunk: usize,
    ) -> Vec<(String, String)> {
        let mut scanner = Scanner::values(seq, streaming);
        let mut items = Vec::new();
        for input in data.chunks(chunk.clamp(1, WORK)) {
            if scanner.done() {
                break;
            }
            scanner.feed(input, &mut Vec::new()).unwrap();
            take_scanned(&mut scanner, &mut items);
            while scanner.busy() {
                scanner.drain(&mut Vec::new()).unwrap();
                take_scanned(&mut scanner, &mut items);
            }
        }
        scanner.finish(&mut Vec::new()).unwrap();
        take_scanned(&mut scanner, &mut items);
        while scanner.busy() {
            scanner.drain(&mut Vec::new()).unwrap();
            take_scanned(&mut scanner, &mut items);
        }
        items
    }

    /// What the scanner writes as text, each document read back as
    /// jq_eval reads a document's text.
    fn reparsed(data: &[u8], seq: bool, streaming: bool, chunk: usize) -> Vec<(String, String)> {
        let config = serde_json::json!({"seq": seq, "streaming": streaming}).to_string();
        collect(data, &config, chunk, false)
            .into_iter()
            .map(|(kind, text)| match kind.as_str() {
                "text" => match super::super::value::parse_json(&text) {
                    Ok(value) => (kind, value.dump()),
                    Err(message) => ("reparse".into(), message),
                },
                _ => (kind, text),
            })
            .collect()
    }

    /// A small deterministic generator of JSON texts, valid and not.
    struct Texts(u64);

    impl Texts {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }

        fn pick<'a>(&mut self, from: &[&'a [u8]]) -> &'a [u8] {
            from[self.below(from.len())]
        }

        fn space(&mut self, out: &mut Vec<u8>) {
            out.extend_from_slice(self.pick(&[b"", b"", b" ", b"\n", b"\t ", b"\r\n"]));
        }

        fn value(&mut self, depth: usize, out: &mut Vec<u8>) {
            match self.below(if depth > 4 { 3 } else { 5 }) {
                0 => out.extend_from_slice(self.pick(&[
                    b"0",
                    b"-0",
                    b"1.000",
                    b"100000000000000000001",
                    b"1e1000",
                    b"-1.5E-7",
                    b"0.0000001",
                    b"nan",
                    b"-Infinity",
                    b"1\x00x",
                    b"12",
                    b"3.25",
                    b"1E+2",
                    b"true",
                    b"false",
                    b"null",
                    b"nul",
                    b"01",
                    b"+1",
                    b".5",
                    b"1.",
                ])),
                1 | 2 => {
                    out.push(b'"');
                    for _ in 0..self.below(5) {
                        out.extend_from_slice(self.pick(&[
                            b"a",
                            b"key",
                            b"\xc3\xa9",
                            b"\\n",
                            b"\\u00e9",
                            b"\\u0000",
                            b"\\ud83d\\ude00",
                            b"\\udc00",
                            b"\\\"",
                            b"\\/",
                            b"\xe2",
                            b"\xff",
                            b"\xe2\x82",
                            b"\xf0\x80\x80\x80",
                            b"\xed\xa0\x80",
                        ]));
                    }
                    out.push(b'"');
                }
                3 => {
                    out.push(b'[');
                    for i in 0..self.below(4) {
                        if i > 0 {
                            out.push(b',');
                        }
                        self.space(out);
                        self.value(depth + 1, out);
                    }
                    out.push(b']');
                }
                _ => {
                    out.push(b'{');
                    for i in 0..self.below(4) {
                        if i > 0 {
                            out.push(b',');
                        }
                        out.extend_from_slice(self.pick(&[
                            b"\"a\"",
                            b"\"b\"",
                            b"\"a\"",
                            b"\"\xe2\"",
                        ]));
                        out.push(b':');
                        self.space(out);
                        self.value(depth + 1, out);
                    }
                    out.push(b'}');
                }
            }
        }

        fn text(&mut self, seq: bool) -> Vec<u8> {
            let mut out = Vec::new();
            if self.below(8) == 0 {
                out.extend_from_slice(b"\xef\xbb\xbf");
            }
            for _ in 0..1 + self.below(3) {
                if seq {
                    out.push(RS);
                }
                self.value(0, &mut out);
                self.space(&mut out);
            }
            if self.below(4) == 0 {
                let at = self.below(out.len() + 1);
                let byte =
                    self.pick(&[b",", b"]", b"}", b":", b"\"", b"x", b"\x1e", b"\x00", b" "]);
                out.splice(at..at, byte.iter().copied());
            }
            out
        }
    }

    #[test]
    fn values_are_the_documents_the_text_reads_back_as() {
        let fixtures: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(fixture_path()).unwrap()).unwrap();
        let mut cases: Vec<(Vec<u8>, bool, bool)> = Vec::new();
        for case in fixtures.as_array().unwrap() {
            let hex = case["input"].as_str().unwrap();
            let data = hex
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            cases.push((data, case["seq"] == true, case["streaming"] == true));
        }
        let long = "1".repeat(5000);
        for data in [
            format!("{{\"b\":{long},\"1\":1.000}} [{long}.{long}e-9999]"),
            format!("\"{}\" -{long}", "\\u0061\u{e9}".repeat(3000)),
            format!("[{}1{}]", "[".repeat(300), "]".repeat(300)),
            format!("{{\"{}\":[1,{{\"x\":[]}}]}}", "k".repeat(20_000)),
            format!("nan{} {long}\u{0}x", "0".repeat(5000)),
        ] {
            for (seq, streaming) in [(false, false), (false, true), (true, false)] {
                let mut data = data.clone().into_bytes();
                if seq {
                    data.insert(0, RS);
                }
                cases.push((data, seq, streaming));
            }
        }
        let mut texts = Texts(0x9e37_79b9_7f4a_7c15);
        for _ in 0..1500 {
            let seq = texts.below(4) == 0;
            let streaming = texts.below(3) == 0;
            cases.push((texts.text(seq), seq, streaming));
        }
        for (data, seq, streaming) in &cases {
            for chunk in [1, 7, WORK] {
                assert_eq!(
                    collect_values(data, *seq, *streaming, chunk),
                    reparsed(data, *seq, *streaming, chunk),
                    "input {:?}, seq {seq}, streaming {streaming}, chunk {chunk}",
                    String::from_utf8_lossy(data)
                );
            }
        }
    }

    #[test]
    fn an_abandoned_document_is_freed_a_slice_at_a_time() {
        let meter = Arc::new(meter::Meter::default());
        let _installed = meter::install(&meter);
        for streaming in [false, true] {
            let mut scanner = Scanner::values(false, streaming);
            let text = format!("[{}", "[1,{\"a\":\"b\"}],".repeat(20_000));
            for input in text.as_bytes().chunks(4095) {
                scanner.feed(input, &mut Vec::new()).unwrap();
                while scanner.busy() {
                    scanner.drain(&mut Vec::new()).unwrap();
                    if streaming {
                        assert!(matches!(scanner.take(), Some(Scanned::Value(_)) | None));
                    }
                }
            }
            assert!(scanner.take().is_none());
            assert!(meter.live() > 0);
            scanner.begin(br#"{"discard":true}"#).unwrap();
            let mut drains = 0;
            while scanner.busy() {
                scanner.drain(&mut Vec::new()).unwrap();
                assert!(scanner.take().is_none());
                drains += 1;
            }
            assert!(streaming || drains > 1, "{drains} drains");
            assert!(scanner.retiring.is_empty() && scanner.opened.is_empty());
            drop(scanner);
            assert_eq!(meter.live(), 0);
        }
    }

    /// How much of a long literal's text the scanner has gathered.
    fn gathered(scanner: &Scanner) -> Option<usize> {
        match scanner.task.as_ref().map(|task| &task.kind) {
            Some(TokenKind::Literal {
                reading: Some((text, ..)),
                ..
            }) => Some(text.len()),
            _ => None,
        }
    }

    #[test]
    fn a_long_literal_is_gathered_a_slice_at_a_time() {
        let mut scanner = Scanner::values(false, false);
        let text = format!("{} ", "1".repeat(200_000));
        let mut sizes = Vec::new();
        let mut read = Vec::new();
        for input in text.as_bytes().chunks(4095) {
            scanner.feed(input, &mut Vec::new()).unwrap();
            sizes.extend(gathered(&scanner));
            read.extend(scanner.take());
            while scanner.busy() {
                scanner.drain(&mut Vec::new()).unwrap();
                sizes.extend(gathered(&scanner));
                read.extend(scanner.take());
            }
        }
        assert!(
            sizes.iter().any(|size| *size > 0 && *size < 200_000),
            "{sizes:?}"
        );
        assert!(
            sizes.windows(2).all(|pair| pair[1] - pair[0] <= WORK),
            "{sizes:?}"
        );
        let [Scanned::Value(value)] = read.as_slice() else {
            panic!("one number");
        };
        assert_eq!(value.dump(), "1".repeat(200_000));
    }

    #[test]
    fn a_long_literal_is_charged_while_it_is_read() {
        // Leading zeros read to a small number, but the reader holds the
        // literal's text twice while it reads it.
        let meter = Arc::new(meter::Meter::limited(150_000));
        let _installed = meter::install(&meter);
        let mut scanner = Scanner::values(false, false);
        let mut read = Vec::new();
        let text = format!("{}1 ", "0".repeat(100_000));
        for input in text.as_bytes().chunks(4095) {
            scanner.feed(input, &mut Vec::new()).unwrap();
            read.extend(scanner.take());
            while scanner.busy() {
                scanner.drain(&mut Vec::new()).unwrap();
                read.extend(scanner.take());
            }
        }
        let [Scanned::Value(value)] = read.as_slice() else {
            panic!("one number");
        };
        assert_eq!(value.dump(), "1");
        assert!(meter.exceeded());
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
                Path::Key(Some(Name::Bytes(bytes))) => bytes.block_count(),
                _ => 0,
            })
            .sum()
    }

    fn retained_blocks(scanner: &Scanner) -> usize {
        let task = scanner.task.as_ref().map_or(0, |task| {
            task.bytes.block_count()
                + match &task.kind {
                    TokenKind::String {
                        decoded: Captured::Blocks(decoded),
                        ..
                    } => decoded.block_count(),
                    _ => 0,
                }
        });
        let emission = scanner
            .emission
            .as_ref()
            .map_or(0, |emission| match emission {
                Emission::Document { bytes, .. } => bytes.block_count(),
                Emission::Event(event) => event.leaf.as_ref().map_or(0, leaf_blocks),
                Emission::Value(_) | Emission::Error(_) => 0,
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
            assert!(previous - remaining <= WORK / FREE);
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
            let mut scanner = Scanner::new(
                Config {
                    streaming,
                    seq: false,
                },
                false,
            );
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
            let mut scanner = Scanner::new(
                Config {
                    streaming,
                    seq: false,
                },
                false,
            );
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
        let mut scanner = Scanner::new(Config::default(), false);
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
