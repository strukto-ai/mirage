// Adapted from jq 1.8.2 (MIT), src/jv.c, src/jv_aux.c and src/jv_print.c. See licenses/third_party/jq.txt.

use std::borrow::Borrow;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use std::sync::Arc;

use super::meter::{self, Charge};

/// jq's MAX_CMP_DEPTH, MAX_PRINT_DEPTH and MAX_PARSING_DEPTH.
pub(crate) const MAX_DEPTH: usize = 10000;

/// A comparison or a parse that went past [`MAX_DEPTH`].
#[derive(Debug)]
pub(crate) struct TooDeep;

/// A jq number: its double, and the literal it was read from, which jq
/// 1.8 prints back as written (`1.000`, `1E+2`) until arithmetic
/// replaces it.
#[derive(Clone, Debug)]
pub(crate) struct Number {
    value: f64,
    literal: Option<Arc<Text>>,
}

impl Number {
    pub(crate) fn new(value: f64) -> Self {
        Self {
            value,
            literal: None,
        }
    }

    /// A number read from `text`, a JSON number literal.
    pub(crate) fn literal(text: &str) -> Self {
        Self {
            value: text.parse::<f64>().unwrap_or(f64::NAN),
            literal: Some(Arc::new(Text::new(canonical(text).into_boxed_str()))),
        }
    }

    pub(crate) fn value(&self) -> f64 {
        self.value
    }

    /// decNumber's minus: a literal keeps its digits, and zero its sign
    /// dropped.
    pub(crate) fn negate(&self) -> Self {
        let literal = self.literal.as_ref().map(|text| {
            if text
                .bytes()
                .take_while(|byte| *byte != b'E')
                .all(|byte| matches!(byte, b'-' | b'0' | b'.'))
            {
                Arc::new(Text::new(text.trim_start_matches('-').into()))
            } else if let Some(rest) = text.strip_prefix('-') {
                Arc::new(Text::new(rest.into()))
            } else {
                Arc::new(Text::new(format!("-{text}").into_boxed_str()))
            }
        });
        Self {
            value: -self.value,
            literal,
        }
    }
}

/// decNumber's to-scientific-string of a JSON number literal.
fn canonical(text: &str) -> String {
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], &rest[at + 1..]),
        None => (rest, "0"),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let exponent: i64 = exponent.parse().unwrap_or(if exponent.starts_with('-') {
        i64::MIN / 4
    } else {
        i64::MAX / 4
    });
    let mut digits: String = int.chars().chain(frac.chars()).collect();
    let _digits_charge = Charge::open(digits.capacity());
    let stripped = digits.trim_start_matches('0').len();
    digits.drain(..digits.len() - stripped);
    if digits.is_empty() {
        digits.push('0');
    }
    let exp = exponent.saturating_sub(frac.len() as i64);
    let n = digits.len() as i64;
    let adjusted = exp.saturating_add(n - 1);
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if exp <= 0 && adjusted >= -6 {
        if exp == 0 {
            out.push_str(&digits);
        } else {
            let point = n + exp;
            if point > 0 {
                out.push_str(&digits[..point as usize]);
                out.push('.');
                out.push_str(&digits[point as usize..]);
            } else {
                out.push_str("0.");
                out.extend(std::iter::repeat_n('0', (-point) as usize));
                out.push_str(&digits);
            }
        }
    } else {
        out.push_str(&digits[..1]);
        if n > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('E');
        if adjusted >= 0 {
            out.push('+');
        }
        out.push_str(&adjusted.to_string());
    }
    let _out_charge = Charge::open(out.capacity());
    out
}

/// jvp_dtoa_fmt: the shortest digits that read back as `x`, laid out the
/// way jq prints a computed number.
pub(crate) fn format_double(x: f64, out: &mut String) {
    if x.is_nan() {
        out.push_str("null");
        return;
    }
    let x = x.clamp(-f64::MAX, f64::MAX);
    if x.is_sign_negative() {
        out.push('-');
    }
    if x == 0.0 {
        out.push('0');
        return;
    }
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let decpt = exp.parse::<i32>().unwrap_or(0) + 1;
    let nd = digits.len() as i32;
    if decpt <= -4 || decpt > nd + 15 {
        out.push_str(&digits[..1]);
        if nd > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let e = decpt - 1;
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&format!("{:02}", e.abs()));
    } else if decpt <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-decpt) as usize));
        out.push_str(&digits);
    } else if decpt >= nd {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (decpt - nd) as usize));
    } else {
        out.push_str(&digits[..decpt as usize]);
        out.push('.');
        out.push_str(&digits[decpt as usize..]);
    }
}

const BASE: usize = 16;
const INDEX: usize = 32;

fn list_bytes(len: usize) -> usize {
    BASE + len * std::mem::size_of::<Value>()
}

/// A string's text, charged to the meter current when it was made.
pub(crate) struct Text {
    text: Box<str>,
    _charge: Charge,
}

impl Text {
    pub(crate) fn new(text: Box<str>) -> Self {
        let charge = Charge::open(BASE + text.len());
        Self {
            text,
            _charge: charge,
        }
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.text
    }
}

impl Deref for Text {
    type Target = str;
    fn deref(&self) -> &str {
        &self.text
    }
}

impl fmt::Display for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl fmt::Debug for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.text, f)
    }
}

impl PartialEq for Text {
    fn eq(&self, other: &Self) -> bool {
        self.text == other.text
    }
}

impl Eq for Text {}

impl PartialEq<str> for Text {
    fn eq(&self, other: &str) -> bool {
        &*self.text == other
    }
}

impl PartialOrd for Text {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Text {
    fn cmp(&self, other: &Self) -> Ordering {
        self.text.cmp(&other.text)
    }
}

impl Hash for Text {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.text.hash(state);
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct Key(Arc<Text>);

impl Key {
    pub(crate) fn text(&self) -> Arc<Text> {
        Arc::clone(&self.0)
    }
}

impl Deref for Key {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl Borrow<str> for Key {
    fn borrow(&self) -> &str {
        self
    }
}

impl From<Arc<Text>> for Key {
    fn from(text: Arc<Text>) -> Self {
        Self(text)
    }
}

impl From<&str> for Key {
    fn from(text: &str) -> Self {
        Self(Arc::new(Text::new(text.into())))
    }
}

impl From<String> for Key {
    fn from(text: String) -> Self {
        Self(Arc::new(Text::new(text.into_boxed_str())))
    }
}

/// An array's items, charged to the meter current when the list was made
/// and kept in step as it grows. Dropping the last reference to a deep
/// value tears it down with a loop, not recursion, so nesting cannot
/// overflow the stack.
pub(crate) struct List {
    items: Vec<Value>,
    charge: Charge,
}

impl List {
    fn new(items: Vec<Value>) -> Self {
        let charge = Charge::open(list_bytes(items.capacity()));
        Self { items, charge }
    }

    fn recharge(&mut self) {
        self.charge.set(list_bytes(self.items.capacity()));
    }

    pub(crate) fn push(&mut self, value: Value) {
        self.items.push(value);
        self.recharge();
    }

    pub(crate) fn extend(&mut self, values: impl IntoIterator<Item = Value>) {
        self.items.extend(values);
        self.recharge();
    }

    pub(crate) fn truncate(&mut self, len: usize) {
        self.items.truncate(len);
        self.recharge();
    }

    /// Set item `at`, padding with null up to it as jv_array_set does.
    pub(crate) fn set(&mut self, at: usize, value: Value) {
        if at >= self.items.len() {
            self.items.resize(at + 1, Value::Null);
        }
        self.items[at] = value;
        self.recharge();
    }
}

impl Default for List {
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

impl Clone for List {
    fn clone(&self) -> Self {
        Self::new(self.items.clone())
    }
}

impl fmt::Debug for List {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.items, f)
    }
}

impl Deref for List {
    type Target = Vec<Value>;
    fn deref(&self) -> &Vec<Value> {
        &self.items
    }
}

impl Drop for List {
    fn drop(&mut self) {
        teardown(std::mem::take(&mut self.items));
    }
}

/// An object's fields in insertion order, which jq prints them in,
/// charged like a list plus its index slots. Keys share their text's charge.
pub(crate) struct Object {
    entries: Vec<(Key, Value)>,
    index: HashMap<Key, usize>,
    charge: Charge,
}

impl Default for Object {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
            charge: Charge::open(BASE),
        }
    }
}

impl Clone for Object {
    fn clone(&self) -> Self {
        let mut object = Self {
            entries: self.entries.clone(),
            index: self.index.clone(),
            charge: Charge::open(0),
        };
        object.recharge();
        object
    }
}

impl fmt::Debug for Object {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl Drop for Object {
    fn drop(&mut self) {
        self.index.clear();
        teardown(self.entries.drain(..).map(|(_, v)| v).collect());
    }
}

/// Take a value apart one level: the children its last reference held,
/// so a caller can free a deep or wide value a bounded number of nodes at
/// a time.
pub(crate) enum Retirement {
    Values {
        values: Vec<Value>,
        _charge: Charge,
    },
    Object {
        entries: std::vec::IntoIter<(Key, Value)>,
        index: std::collections::hash_map::IntoIter<Key, usize>,
        _charge: Charge,
    },
}

impl Retirement {
    pub(crate) fn values(values: Vec<Value>) -> Self {
        let charge = Charge::open(values.capacity() * std::mem::size_of::<Value>());
        Self::Values {
            values,
            _charge: charge,
        }
    }

    pub(crate) fn next(&mut self) -> Option<Value> {
        match self {
            Self::Values { values, .. } => values.pop(),
            Self::Object { entries, index, .. } => entries
                .next_back()
                .map(|(_, value)| value)
                .or_else(|| index.next().map(|_| Value::Null)),
        }
    }

    pub(crate) fn split(value: Value) -> Option<Self> {
        match value {
            Value::Array(items) => Arc::try_unwrap(items).ok().map(|mut list| Self::Values {
                values: std::mem::take(&mut list.items),
                _charge: std::mem::replace(&mut list.charge, Charge::open(0)),
            }),
            Value::Object(fields) => Arc::try_unwrap(fields).ok().map(|mut fields| Self::Object {
                entries: std::mem::take(&mut fields.entries).into_iter(),
                index: std::mem::take(&mut fields.index).into_iter(),
                _charge: std::mem::replace(&mut fields.charge, Charge::open(0)),
            }),
            _ => None,
        }
    }
}

fn teardown(mut stack: Vec<Value>) {
    while let Some(value) = stack.pop() {
        match value {
            Value::Array(items) => {
                if let Ok(mut list) = Arc::try_unwrap(items) {
                    stack.append(&mut list.items);
                }
            }
            Value::Object(fields) => {
                if let Ok(mut object) = Arc::try_unwrap(fields) {
                    object.index.clear();
                    stack.extend(object.entries.drain(..).map(|(_, v)| v));
                }
            }
            _ => {}
        }
    }
}

impl Object {
    fn recharge(&mut self) {
        self.charge.set(
            BASE + self.entries.capacity() * std::mem::size_of::<(Key, Value)>()
                + self.index.capacity() * INDEX,
        );
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.index.get(key).map(|at| &self.entries[*at].1)
    }

    pub(crate) fn insert(&mut self, key: Key, value: Value) {
        match self.index.get(&*key) {
            Some(at) => self.entries[*at].1 = value,
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
                self.recharge();
            }
        }
    }

    pub(crate) fn remove(&mut self, key: &str) {
        if let Some(at) = self.index.remove(key) {
            self.entries.remove(at);
            for slot in self.index.values_mut() {
                if *slot > at {
                    *slot -= 1;
                }
            }
            self.recharge();
        }
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&Key, &Value)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub(crate) fn entry(&self, at: usize) -> Option<(&Key, &Value)> {
        self.entries.get(at).map(|(k, v)| (k, v))
    }

    pub(crate) fn sorted_keys(&self) -> Vec<&Key> {
        let mut keys: Vec<&Key> = self.entries.iter().map(|(k, _)| k).collect();
        keys.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        keys
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Value {
    Null,
    False,
    True,
    Number(Number),
    String(Arc<Text>),
    Array(Arc<List>),
    Object(Arc<Object>),
}

impl Value {
    pub(crate) fn number(value: f64) -> Self {
        Self::Number(Number::new(value))
    }

    pub(crate) fn string(text: impl Into<Box<str>>) -> Self {
        Self::String(Arc::new(Text::new(text.into())))
    }

    pub(crate) fn array(items: Vec<Value>) -> Self {
        Self::Array(Arc::new(List::new(items)))
    }

    pub(crate) fn object(object: Object) -> Self {
        Self::Object(Arc::new(object))
    }

    pub(crate) fn bool(b: bool) -> Self {
        if b { Self::True } else { Self::False }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::False | Self::True => "boolean",
            Self::Number(_) => "number",
            Self::String(_) => "string",
            Self::Array(_) => "array",
            Self::Object(_) => "object",
        }
    }

    fn rank(&self) -> u8 {
        match self {
            Self::Null => 0,
            Self::False => 1,
            Self::True => 2,
            Self::Number(_) => 3,
            Self::String(_) => 4,
            Self::Array(_) => 5,
            Self::Object(_) => 6,
        }
    }

    pub(crate) fn truthy(&self) -> bool {
        !matches!(self, Self::Null | Self::False)
    }

    pub(crate) fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(n.value()),
            _ => None,
        }
    }

    /// jv_identical: the same container, or the same scalar.
    pub(crate) fn identical(&self, other: &Value) -> bool {
        match (self, other) {
            (Self::Null, Self::Null) | (Self::False, Self::False) | (Self::True, Self::True) => {
                true
            }
            (Self::Number(a), Self::Number(b)) => a.value().to_bits() == b.value().to_bits(),
            (Self::String(a), Self::String(b)) => Arc::ptr_eq(a, b),
            (Self::Array(a), Self::Array(b)) => Arc::ptr_eq(a, b),
            (Self::Object(a), Self::Object(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    /// jv_equal.
    pub(crate) fn equals(&self, other: &Value) -> bool {
        self.try_equals(other).unwrap_or(false)
    }

    pub(crate) fn try_equals(&self, other: &Value) -> Result<bool, TooDeep> {
        let _recording = meter::record_only();
        let mut budget = u64::MAX;
        Comparing::equality(self.clone(), other.clone())
            .run(&mut budget)
            .expect("an unbounded comparison finishes")
            .map(|order| order == Ordering::Equal)
    }

    /// jq's compact dump, as `tojson` and the main loop print it.
    pub(crate) fn dump(&self) -> String {
        let _recording = meter::record_only();
        let mut budget = u64::MAX;
        Dumping::begin(self.clone())
            .run(&mut budget)
            .unwrap_or_else(|| unreachable!("an unbounded budget finishes the dump"))
    }

    /// jv_dump_string_trunc with jq's 30-byte buffer, as error messages
    /// quote a value.
    pub(crate) fn dump_trunc(&self) -> String {
        let _recording = meter::record_only();
        const BUF: usize = 30;
        let text = match self {
            Value::String(s) if s.len() > BUF => {
                Value::string(s.chars().take(BUF).collect::<String>()).dump()
            }
            other => {
                let mut dumping = Dumping::begin(other.clone());
                loop {
                    if let Some(text) = dumping.run(&mut 1) {
                        break text;
                    }
                    if dumping.written() >= BUF {
                        break std::mem::take(&mut dumping.out);
                    }
                }
            }
        };
        if text.len() < BUF {
            return text;
        }
        let delim = match text.as_bytes()[0] {
            b'"' => Some('"'),
            b'[' => Some(']'),
            b'{' => Some('}'),
            _ => None,
        };
        let mut l = BUF - if delim.is_some() { 5 } else { 4 };
        while !text.is_char_boundary(l) {
            l -= 1;
        }
        let mut out = text[..l].to_string();
        out.push_str("...");
        out.extend(delim);
        out
    }
}

fn write_character(ch: char, out: &mut String, escape_del: bool) {
    match ch {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        '\n' => out.push_str("\\n"),
        '\t' => out.push_str("\\t"),
        '\r' => out.push_str("\\r"),
        '\u{8}' => out.push_str("\\b"),
        '\u{c}' => out.push_str("\\f"),
        c if (c as u32) < 0x20 || escape_del && c as u32 == 0x7f => {
            out.push_str(&format!("\\u{:04x}", c as u32));
        }
        c => out.push(c),
    }
}

enum Piece {
    Value(Value, usize),
    Array(Arc<List>, usize, usize),
    Object(Arc<Object>, usize, usize),
    String(Arc<Text>, usize),
    Raw(Arc<Text>, usize),
    Key(Key, usize),
    Static(&'static str),
}

/// A compact dump in progress, retaining one cursor per open container
/// and string so even a single large value yields between pieces.
pub(crate) struct Dumping {
    stack: Vec<Piece>,
    retired: Vec<Value>,
    escape_del: bool,
    out: String,
    charge: Charge,
}

impl Dumping {
    pub(crate) fn begin(value: Value) -> Self {
        Self {
            stack: vec![Piece::Value(value, 0)],
            retired: Vec::new(),
            escape_del: true,
            out: String::new(),
            charge: Charge::open(0),
        }
    }

    pub(crate) fn raw(text: Arc<Text>) -> Self {
        let mut dumping = Self::begin(Value::Null);
        dumping.stack[0] = Piece::Raw(text, 0);
        dumping
    }

    pub(crate) fn halt(text: Option<String>, string: bool, code: Option<f64>) -> Self {
        let mut dumping = Self::begin(Value::Null);
        dumping.escape_del = false;
        dumping.out = format!(
            "{{\"code\":{},\"message\":",
            serde_json::to_string(&code).expect("an optional float serializes")
        );
        dumping.stack[0] = Piece::Static(if string {
            ",\"string\":true}"
        } else {
            ",\"string\":false}"
        });
        match text {
            Some(text) => dumping.stack.push(Piece::Value(Value::string(text), 0)),
            None => dumping.stack.push(Piece::Static("null")),
        }
        dumping.recharge();
        dumping
    }

    fn recharge(&mut self) {
        self.charge.set(
            self.out.capacity()
                + self.stack.capacity() * std::mem::size_of::<Piece>()
                + self.retired.capacity() * std::mem::size_of::<Value>(),
        );
    }

    pub(crate) fn written(&self) -> usize {
        self.out.len()
    }

    pub(crate) fn retire(&mut self) -> Option<Value> {
        self.stack
            .pop()
            .map(|piece| match piece {
                Piece::Value(value, _) => value,
                Piece::Array(items, ..) => Value::Array(items),
                Piece::Object(fields, ..) => Value::Object(fields),
                Piece::String(text, _) => Value::String(text),
                Piece::Key(..) | Piece::Raw(..) | Piece::Static(_) => Value::Null,
            })
            .or_else(|| self.retired.pop())
    }

    pub(crate) fn run(&mut self, budget: &mut u64) -> Option<String> {
        while *budget > 0 {
            let Some(piece) = self.stack.pop() else {
                break;
            };
            let before = self.out.len();
            self.write(piece);
            self.charge.set(
                self.out.capacity()
                    + self.stack.capacity() * std::mem::size_of::<Piece>()
                    + self.retired.capacity() * std::mem::size_of::<Value>(),
            );
            *budget = budget.saturating_sub(1 + (self.out.len() - before) as u64 / 64);
            if meter::should_pause() {
                *budget = 0;
                return None;
            }
        }
        if self.stack.is_empty() {
            self.charge.set(
                self.stack.capacity() * std::mem::size_of::<Piece>()
                    + self.retired.capacity() * std::mem::size_of::<Value>(),
            );
            Some(std::mem::take(&mut self.out))
        } else {
            None
        }
    }

    fn string_piece(&mut self, text: &str, at: usize, key: bool) -> Option<usize> {
        let mut end = at;
        for ch in text[at..].chars() {
            write_character(ch, &mut self.out, self.escape_del);
            end += ch.len_utf8();
            if end - at >= 64 {
                break;
            }
        }
        if end == text.len() {
            self.out.push('"');
            if key {
                self.out.push(':');
            }
            None
        } else {
            Some(end)
        }
    }

    fn write(&mut self, piece: Piece) {
        match piece {
            Piece::Static(text) => self.out.push_str(text),
            Piece::Raw(text, at) => {
                let mut end = (at + 64).min(text.len());
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                self.out.push_str(&text[at..end]);
                if end < text.len() {
                    self.stack.push(Piece::Raw(text, end));
                }
            }
            Piece::String(text, at) => {
                if let Some(at) = self.string_piece(&text, at, false) {
                    self.stack.push(Piece::String(text, at));
                }
            }
            Piece::Key(key, at) => {
                if at == 0 {
                    self.out.push('"');
                }
                if let Some(at) = self.string_piece(&key, at, true) {
                    self.stack.push(Piece::Key(key, at));
                }
            }
            Piece::Array(items, at, depth) => {
                if let Some(item) = items.get(at).cloned() {
                    if at > 0 {
                        self.out.push(',');
                    }
                    self.stack.push(Piece::Array(items, at + 1, depth));
                    self.stack.push(Piece::Value(item, depth));
                } else {
                    self.out.push(']');
                    self.retired.push(Value::Array(items));
                }
            }
            Piece::Object(fields, at, depth) => {
                if let Some((key, value)) = fields.entries.get(at) {
                    let key = key.clone();
                    let value = value.clone();
                    if at > 0 {
                        self.out.push(',');
                    }
                    self.stack.push(Piece::Object(fields, at + 1, depth));
                    self.stack.push(Piece::Value(value, depth));
                    self.stack.push(Piece::Key(key, 0));
                } else {
                    self.out.push('}');
                    self.retired.push(Value::Object(fields));
                }
            }
            Piece::Value(value, depth) if depth > MAX_DEPTH => {
                self.out.push_str("<skipped: too deep>");
                self.retired.push(value);
            }
            Piece::Value(value, depth) => match value {
                Value::Null => self.out.push_str("null"),
                Value::False => self.out.push_str("false"),
                Value::True => self.out.push_str("true"),
                Value::Number(n) => match n.literal {
                    Some(text) => self.stack.push(Piece::Raw(text, 0)),
                    None => format_double(n.value, &mut self.out),
                },
                Value::String(text) => {
                    self.out.push('"');
                    self.stack.push(Piece::String(text, 0));
                }
                Value::Array(items) => {
                    self.out.push('[');
                    self.stack.push(Piece::Array(items, 0, depth + 1));
                }
                Value::Object(fields) => {
                    self.out.push('{');
                    self.stack.push(Piece::Object(fields, 0, depth + 1));
                }
            },
        }
    }
}

fn compare_numbers(a: f64, b: f64) -> Ordering {
    if a.is_nan() {
        return if b.is_nan() {
            Ordering::Equal
        } else {
            Ordering::Less
        };
    }
    if b.is_nan() {
        return Ordering::Greater;
    }
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// jq's value order, with the same cursor used by sliced comparisons.
pub(crate) fn try_compare(a: &Value, b: &Value) -> Result<Ordering, TooDeep> {
    let _recording = meter::record_only();
    let mut budget = u64::MAX;
    Comparing::begin(a.clone(), b.clone())
        .run(&mut budget)
        .expect("an unbounded comparison finishes")
}

fn bytes_piece(a: &[u8], b: &[u8], at: &mut usize) -> Option<Ordering> {
    let end = (*at + 64).min(a.len()).min(b.len());
    let order = a[*at..end].cmp(&b[*at..end]);
    *at = end;
    if order != Ordering::Equal {
        Some(order)
    } else if end == a.len().min(b.len()) {
        Some(a.len().cmp(&b.len()))
    } else {
        None
    }
}

struct KeySorting {
    fields: Arc<Object>,
    order: Vec<usize>,
    merged: Vec<usize>,
    width: usize,
    start: usize,
    i: usize,
    j: usize,
    slot: usize,
    bytes: usize,
    charge: Charge,
}

impl KeySorting {
    fn begin(fields: Arc<Object>) -> Self {
        Self {
            fields,
            order: Vec::new(),
            merged: Vec::new(),
            width: 1,
            start: 0,
            i: 0,
            j: 1,
            slot: 0,
            bytes: 0,
            charge: Charge::open(0),
        }
    }

    fn step(&mut self) -> bool {
        let n = self.fields.len();
        if self.order.len() < n {
            self.order.push(self.order.len());
            self.merged.push(0);
            self.charge.set(
                (self.order.capacity() + self.merged.capacity()) * std::mem::size_of::<usize>(),
            );
            return false;
        }
        if self.width >= n {
            return true;
        }
        let mid = (self.start + self.width).min(n);
        let end = (self.start + 2 * self.width).min(n);
        if self.slot < end {
            let left = if self.i >= mid {
                false
            } else if self.j >= end {
                true
            } else {
                let a = &self.fields.entries[self.order[self.i]].0;
                let b = &self.fields.entries[self.order[self.j]].0;
                let Some(order) = bytes_piece(a.as_bytes(), b.as_bytes(), &mut self.bytes) else {
                    return false;
                };
                order != Ordering::Greater
            };
            self.bytes = 0;
            let from = if left { &mut self.i } else { &mut self.j };
            self.merged[self.slot] = self.order[*from];
            *from += 1;
            self.slot += 1;
        } else {
            self.start = end;
            if end == n {
                std::mem::swap(&mut self.order, &mut self.merged);
                self.width *= 2;
                self.start = 0;
            }
            self.i = self.start;
            self.j = (self.start + self.width).min(n);
            self.slot = self.start;
        }
        false
    }
}

struct DecimalScan {
    text: Arc<Text>,
    at: usize,
    negative: bool,
    first: usize,
    digits: usize,
    trailing: usize,
    fractional: usize,
    dot: bool,
    exponent: i64,
    exponent_negative: bool,
    in_exponent: bool,
}

impl DecimalScan {
    fn begin(text: Arc<Text>) -> Self {
        Self {
            text,
            at: 0,
            negative: false,
            first: 0,
            digits: 0,
            trailing: 0,
            fractional: 0,
            dot: false,
            exponent: 0,
            exponent_negative: false,
            in_exponent: false,
        }
    }

    fn step(&mut self) -> bool {
        let Some(byte) = self.text.as_bytes().get(self.at).copied() else {
            return true;
        };
        if self.in_exponent {
            match byte {
                b'-' => self.exponent_negative = true,
                b'0'..=b'9' => {
                    self.exponent = self
                        .exponent
                        .saturating_mul(10)
                        .saturating_add(i64::from(byte - b'0'))
                }
                _ => {}
            }
        } else {
            match byte {
                b'-' => self.negative = true,
                b'.' => self.dot = true,
                b'E' | b'e' => self.in_exponent = true,
                b'0'..=b'9' => {
                    self.fractional += usize::from(self.dot);
                    if self.digits != 0 || byte != b'0' {
                        if self.digits == 0 {
                            self.first = self.at;
                        }
                        self.digits += 1;
                        self.trailing = if byte == b'0' { self.trailing + 1 } else { 0 };
                    }
                }
                _ => {}
            }
        }
        self.at += 1;
        false
    }

    fn sign(&self) -> i8 {
        if self.digits == 0 {
            0
        } else if self.negative {
            -1
        } else {
            1
        }
    }
    fn adjusted(&self) -> i64 {
        let exp = if self.exponent_negative {
            -self.exponent
        } else {
            self.exponent
        };
        exp.saturating_sub(self.fractional as i64)
            .saturating_add(self.digits as i64)
    }
}

struct DecimalComparing {
    a: DecimalScan,
    b: DecimalScan,
    x: usize,
    y: usize,
    at: usize,
}

impl DecimalComparing {
    fn step(&mut self) -> Option<Ordering> {
        if !self.a.step() {
            return None;
        }
        if !self.b.step() {
            return None;
        }
        let order = self.a.sign().cmp(&self.b.sign());
        if order != Ordering::Equal || self.a.sign() == 0 {
            return Some(order);
        }
        let order = self.a.adjusted().cmp(&self.b.adjusted());
        if order != Ordering::Equal {
            return Some(if self.a.negative {
                order.reverse()
            } else {
                order
            });
        }
        if self.at == 0 {
            self.x = self.a.first;
            self.y = self.b.first;
        }
        let len_a = self.a.digits - self.a.trailing;
        let len_b = self.b.digits - self.b.trailing;
        if self.at >= len_a.max(len_b) {
            return Some(Ordering::Equal);
        }
        if self.a.text.as_bytes().get(self.x) == Some(&b'.') {
            self.x += 1;
        }
        if self.b.text.as_bytes().get(self.y) == Some(&b'.') {
            self.y += 1;
        }
        let a = if self.at < len_a {
            self.a.text.as_bytes()[self.x]
        } else {
            b'0'
        };
        let b = if self.at < len_b {
            self.b.text.as_bytes()[self.y]
        } else {
            b'0'
        };
        self.x += 1;
        self.y += 1;
        self.at += 1;
        let order = a.cmp(&b);
        if order == Ordering::Equal {
            None
        } else {
            Some(if self.a.negative {
                order.reverse()
            } else {
                order
            })
        }
    }
}

struct ObjectComparing {
    a: KeySorting,
    b: KeySorting,
    keys: usize,
    bytes: usize,
    at: usize,
    depth: usize,
}

enum ComparePiece {
    Value(Value, Value, usize),
    Array(Arc<List>, Arc<List>, usize, usize),
    String(Arc<Text>, Arc<Text>, usize),
    Number(Box<DecimalComparing>),
    Object(Box<ObjectComparing>),
}

pub(crate) struct Comparing {
    stack: Vec<ComparePiece>,
    answer: Option<Result<Ordering, TooDeep>>,
    equality: bool,
    charge: Charge,
}

impl Comparing {
    pub(crate) fn begin(a: Value, b: Value) -> Self {
        Self {
            stack: vec![ComparePiece::Value(a, b, 0)],
            answer: None,
            equality: false,
            charge: Charge::open(std::mem::size_of::<ComparePiece>()),
        }
    }

    pub(crate) fn equality(a: Value, b: Value) -> Self {
        let mut comparing = Self::begin(a, b);
        comparing.equality = true;
        comparing
    }

    pub(crate) fn retire(&mut self) -> Option<Value> {
        self.stack.pop().map(|piece| match piece {
            ComparePiece::Value(a, b, _) => Value::array(vec![a, b]),
            ComparePiece::Array(a, b, ..) => Value::array(vec![Value::Array(a), Value::Array(b)]),
            ComparePiece::String(a, b, _) => Value::array(vec![Value::String(a), Value::String(b)]),
            ComparePiece::Number(n) => {
                Value::array(vec![Value::String(n.a.text), Value::String(n.b.text)])
            }
            ComparePiece::Object(o) => {
                Value::array(vec![Value::Object(o.a.fields), Value::Object(o.b.fields)])
            }
        })
    }

    pub(crate) fn run(&mut self, budget: &mut u64) -> Option<Result<Ordering, TooDeep>> {
        while *budget > 0 {
            *budget -= 1;
            if self.answer.is_some() {
                if self.stack.pop().is_none() {
                    return self.answer.take();
                }
                continue;
            }
            let Some(piece) = self.stack.pop() else {
                return Some(Ok(Ordering::Equal));
            };
            match self.step(piece) {
                Ok(Some(order)) if order != Ordering::Equal => self.answer = Some(Ok(order)),
                Err(deep) => self.answer = Some(Err(deep)),
                _ => {}
            }
            self.charge
                .set(self.stack.capacity() * std::mem::size_of::<ComparePiece>());
            if meter::should_pause() {
                *budget = 0;
                return None;
            }
        }
        None
    }

    fn step(&mut self, piece: ComparePiece) -> Result<Option<Ordering>, TooDeep> {
        match piece {
            ComparePiece::Value(a, b, depth) => {
                if self.equality {
                    match (&a, &b) {
                        (Value::Number(x), Value::Number(y)) => {
                            if x.value() != y.value() {
                                return Ok(Some(Ordering::Greater));
                            }
                        }
                        _ if a.identical(&b) => return Ok(Some(Ordering::Equal)),
                        _ => {}
                    }
                }

                if depth > MAX_DEPTH {
                    return Err(TooDeep);
                }
                let order = a.rank().cmp(&b.rank());
                if order != Ordering::Equal {
                    return Ok(Some(order));
                }
                match (a, b) {
                    (Value::Number(a), Value::Number(b)) => {
                        let order = compare_numbers(a.value, b.value);
                        if order != Ordering::Equal || a.value.is_nan() {
                            return Ok(Some(order));
                        }
                        if let (Some(a), Some(b)) = (a.literal, b.literal) {
                            self.stack
                                .push(ComparePiece::Number(Box::new(DecimalComparing {
                                    a: DecimalScan::begin(a),
                                    b: DecimalScan::begin(b),
                                    x: 0,
                                    y: 0,
                                    at: 0,
                                })));
                        }
                    }
                    (Value::String(a), Value::String(b)) => {
                        self.stack.push(ComparePiece::String(a, b, 0))
                    }
                    (Value::Array(a), Value::Array(b)) => {
                        self.stack.push(ComparePiece::Array(a, b, 0, depth))
                    }
                    (Value::Object(a), Value::Object(b)) => {
                        self.stack
                            .push(ComparePiece::Object(Box::new(ObjectComparing {
                                a: KeySorting::begin(a),
                                b: KeySorting::begin(b),
                                keys: 0,
                                bytes: 0,
                                at: 0,
                                depth,
                            })))
                    }
                    _ => {}
                }
            }
            ComparePiece::String(a, b, mut at) => {
                if let Some(order) = bytes_piece(a.as_bytes(), b.as_bytes(), &mut at) {
                    return Ok(Some(order));
                }
                self.stack.push(ComparePiece::String(a, b, at));
            }
            ComparePiece::Number(mut n) => {
                if let Some(order) = n.step() {
                    return Ok(Some(order));
                }
                self.stack.push(ComparePiece::Number(n));
            }
            ComparePiece::Array(a, b, at, depth) => {
                if at == a.len().min(b.len()) {
                    return Ok(Some(a.len().cmp(&b.len())));
                }
                let (x, y) = (a[at].clone(), b[at].clone());
                self.stack.push(ComparePiece::Array(a, b, at + 1, depth));
                self.stack.push(ComparePiece::Value(x, y, depth + 1));
            }
            ComparePiece::Object(mut o) => {
                if !o.a.step() || !o.b.step() {
                    self.stack.push(ComparePiece::Object(o));
                    return Ok(None);
                }
                if o.keys < o.a.order.len().min(o.b.order.len()) {
                    let a = &o.a.fields.entries[o.a.order[o.keys]].0;
                    let b = &o.b.fields.entries[o.b.order[o.keys]].0;
                    if let Some(order) = bytes_piece(a.as_bytes(), b.as_bytes(), &mut o.bytes) {
                        if order != Ordering::Equal {
                            return Ok(Some(order));
                        }
                        o.bytes = 0;
                        o.keys += 1;
                    }
                    self.stack.push(ComparePiece::Object(o));
                    return Ok(None);
                }
                let order = o.a.order.len().cmp(&o.b.order.len());
                if order != Ordering::Equal {
                    return Ok(Some(order));
                }
                if o.at == o.keys {
                    return Ok(Some(Ordering::Equal));
                }
                let a = o.a.fields.entries[o.a.order[o.at]].1.clone();
                let b = o.b.fields.entries[o.b.order[o.at]].1.clone();
                let depth = o.depth;
                o.at += 1;
                self.stack.push(ComparePiece::Object(o));
                self.stack.push(ComparePiece::Value(a, b, depth + 1));
            }
        }
        Ok(None)
    }
}

enum Open {
    Array(List),
    Object(Object, Option<Key>),
}

enum ReadPhase {
    Value,
    Key,
    Colon,
    Separator,
    Close(Value),
    End(Value),
}

struct NumberReading {
    start: usize,
    end: usize,
    at: usize,
    first: Option<usize>,
    digits: usize,
    fractional: usize,
    dot: bool,
    exponent: bool,
    exp_negative: bool,
    exp: i64,
    overflow: bool,
    exponent_at: usize,
    exponent_digits: usize,
    mantissa_digits: usize,
    special: bool,
    prefix: String,
    sticky: bool,
    out: String,
    build: bool,
    scientific: bool,
    point: i64,
    adjusted: i64,
    copied: usize,
    charge: Charge,
}

impl NumberReading {
    fn begin(start: usize, end: usize) -> Self {
        Self {
            start,
            end,
            at: start,
            first: None,
            digits: 0,
            fractional: 0,
            dot: false,
            exponent: false,
            exp_negative: false,
            exp: 0,
            overflow: false,
            exponent_at: 0,
            exponent_digits: 0,
            mantissa_digits: 0,
            special: false,
            prefix: String::new(),
            sticky: false,
            out: String::new(),
            build: false,
            scientific: false,
            point: 0,
            adjusted: 0,
            copied: 0,
            charge: Charge::open(0),
        }
    }

    fn step(&mut self, bytes: &[u8]) -> Result<Option<Value>, String> {
        if self.end - self.start <= 4096 {
            let token =
                std::str::from_utf8(&bytes[self.start..self.end]).map_err(|_| "Invalid literal")?;
            let token = token.split('\0').next().unwrap_or(token);
            return number_token(token)
                .map(Some)
                .ok_or_else(|| format!("Invalid literal at offset {}", self.start));
        }
        if self.at == self.start {
            let body = self.start + usize::from(bytes[self.start] == b'-');
            let body = body + usize::from(bytes.get(body) == Some(&b'+'));
            let tail = &bytes[body..self.end];
            let prefix = if tail
                .get(..4)
                .is_some_and(|word| word.eq_ignore_ascii_case(b"snan"))
            {
                4
            } else if tail
                .get(..3)
                .is_some_and(|word| word.eq_ignore_ascii_case(b"nan"))
            {
                3
            } else {
                0
            };
            if prefix != 0 {
                self.special = true;
                self.at = body + prefix;
            }
        }
        if self.special {
            if self.at == self.end || bytes[self.at] == 0 {
                return Ok(Some(Value::number(f64::NAN)));
            }
            if bytes[self.at] != b'0' {
                return Err(format!("Invalid literal at offset {}", self.start));
            }
            self.at += 1;
            return Ok(None);
        }
        if !self.build {
            if self.at < self.end {
                let byte = bytes[self.at];
                if byte == 0 {
                    self.end = self.at;
                    return Ok(None);
                }
                if self.exponent {
                    match byte {
                        b'-' if self.at == self.exponent_at => self.exp_negative = true,
                        b'+' if self.at == self.exponent_at => {}
                        b'0'..=b'9' => {
                            self.exponent_digits += 1;
                            match self
                                .exp
                                .checked_mul(10)
                                .and_then(|exp| exp.checked_add(i64::from(byte - b'0')))
                            {
                                Some(exp) => self.exp = exp,
                                None => self.overflow = true,
                            }
                        }
                        _ => return Err(format!("Invalid literal at offset {}", self.start)),
                    }
                } else {
                    match byte {
                        b'-' | b'+' if self.at == self.start => {}
                        b'.' if !self.dot => self.dot = true,
                        b'e' | b'E' if self.mantissa_digits > 0 => {
                            self.exponent = true;
                            self.exponent_at = self.at + 1;
                        }
                        b'0'..=b'9' => {
                            self.mantissa_digits += 1;
                            self.fractional += usize::from(self.dot);
                            if byte != b'0' || self.first.is_some() {
                                self.first.get_or_insert(self.at);
                                self.digits += 1;
                                if self.prefix.len() < 2048 {
                                    self.prefix.push(char::from(byte));
                                } else {
                                    self.sticky |= byte != b'0';
                                }
                            }
                        }
                        _ => return Err(format!("Invalid literal at offset {}", self.start)),
                    }
                }
                self.at += 1;
            } else {
                if self.mantissa_digits == 0 || (self.exponent && self.exponent_digits == 0) {
                    return Err(format!("Invalid literal at offset {}", self.start));
                }
                let exp = if self.overflow {
                    if self.exp_negative {
                        i64::MIN / 4
                    } else {
                        i64::MAX / 4
                    }
                } else if self.exp_negative {
                    -self.exp
                } else {
                    self.exp
                };
                self.exp = exp.saturating_sub(self.fractional as i64);
                self.digits = self.digits.max(1);
                self.adjusted = self.exp.saturating_add(self.digits as i64 - 1);
                self.scientific = self.exp > 0 || self.adjusted < -6;
                self.point = self.digits as i64 + self.exp;
                self.at = self.first.unwrap_or(self.end);
                if bytes[self.start] == b'-' {
                    self.out.push('-');
                }
                if !self.scientific && self.point <= 0 {
                    self.out.push_str("0.");
                    for _ in 0..-self.point {
                        self.out.push('0');
                    }
                }
                self.build = true;
            }
        } else if self.copied < self.digits {
            if (self.scientific && self.copied == 1)
                || (!self.scientific && self.point > 0 && self.copied as i64 == self.point)
            {
                self.out.push('.');
            }
            if bytes.get(self.at) == Some(&b'.') {
                self.at += 1;
            }
            let byte = if self.first.is_none() {
                b'0'
            } else {
                bytes[self.at]
            };
            self.out.push(char::from(byte));
            self.at += 1;
            self.copied += 1;
        } else {
            if self.scientific {
                self.out.push('E');
                if self.adjusted >= 0 {
                    self.out.push('+');
                }
                let exponent = self.adjusted.to_string();
                let _charge = Charge::open(exponent.capacity());
                self.out.push_str(&exponent);
                self.charge
                    .set(self.out.capacity() + self.prefix.capacity());
            }
            if self.prefix.is_empty() {
                self.prefix.push('0');
            }
            if self.sticky {
                self.prefix.push('1');
            }
            self.charge
                .set(self.out.capacity() + self.prefix.capacity());
            let exponent = self
                .exp
                .saturating_add(self.digits as i64 - self.prefix.len() as i64);
            let value = {
                let short = format!(
                    "{}{}e{exponent}",
                    if bytes[self.start] == b'-' { "-" } else { "" },
                    self.prefix
                );
                let _charge = Charge::open(short.capacity());
                short.parse::<f64>().unwrap_or(f64::NAN)
            };
            let literal = std::mem::take(&mut self.out).into_boxed_str();
            self.charge.set(self.prefix.capacity());
            let literal = Arc::new(Text::new(literal));
            return Ok(Some(Value::Number(Number {
                value,
                literal: Some(literal),
            })));
        }
        self.charge
            .set(self.out.capacity() + self.prefix.capacity());
        Ok(None)
    }
}

struct StringReading {
    key: bool,
    out: String,
    fault: Option<&'static str>,
}

pub(crate) struct Parsing {
    text: Vec<u8>,
    at: usize,
    stack: Vec<Open>,
    after_comma: bool,
    phase: ReadPhase,
    string: Option<StringReading>,
    number: Option<usize>,
    numeric: Option<NumberReading>,
    validation_at: usize,
    charge: Charge,
}

pub(crate) fn parse_json(text: &str) -> Result<Value, String> {
    let _recording = meter::record_only();
    let mut budget = u64::MAX;
    Parsing::begin(text.to_string())
        .run(&mut budget)
        .unwrap_or_else(|| unreachable!("an unbounded budget finishes the parse"))
}

impl Parsing {
    pub(crate) fn begin(text: String) -> Self {
        Self::from_bytes(text.into_bytes())
    }

    pub(crate) fn from_bytes(text: Vec<u8>) -> Self {
        let charge = Charge::open(text.capacity());
        let validation_at = text.len();
        Self {
            text,
            at: 0,
            stack: Vec::new(),
            after_comma: false,
            phase: ReadPhase::Value,
            string: None,
            number: None,
            numeric: None,
            validation_at,
            charge,
        }
    }

    pub(crate) fn document(text: Vec<u8>) -> Self {
        let mut parsing = Self::from_bytes(text);
        parsing.validation_at = 0;
        parsing
    }

    fn validate(&mut self, budget: &mut u64) -> Result<bool, String> {
        while self.validation_at < self.text.len() && *budget > 0 {
            *budget -= 1;
            let end = (self.validation_at + 4096).min(self.text.len());
            match std::str::from_utf8(&self.text[self.validation_at..end]) {
                Ok(_) => self.validation_at = end,
                Err(error) if error.error_len().is_none() && end < self.text.len() => {
                    self.validation_at += error.valid_up_to()
                }
                Err(_) => return Err("jq_eval: document is not UTF-8".into()),
            }
        }
        Ok(self.validation_at == self.text.len())
    }

    pub(crate) fn retire(&mut self) -> Option<Value> {
        if let ReadPhase::Close(value) | ReadPhase::End(value) =
            std::mem::replace(&mut self.phase, ReadPhase::Value)
        {
            return Some(value);
        }
        self.stack.pop().map(|open| match open {
            Open::Array(items) => Value::Array(Arc::new(items)),
            Open::Object(fields, _) => Value::object(fields),
        })
    }

    fn recharge(&mut self) {
        self.charge.set(
            self.text.capacity()
                + self.stack.capacity() * std::mem::size_of::<Open>()
                + self
                    .string
                    .as_ref()
                    .map_or(0, |string| string.out.capacity()),
        );
    }

    pub(crate) fn run(&mut self, budget: &mut u64) -> Option<Result<Value, String>> {
        match self.validate(budget) {
            Ok(true) => {}
            Ok(false) => return None,
            Err(message) => return Some(Err(message)),
        }
        while *budget > 0 {
            *budget -= 1;
            let step = self.step();
            self.recharge();
            if meter::should_pause() {
                if let Ok(Some(value)) = step {
                    self.phase = ReadPhase::End(value);
                }
                *budget = 0;
                return None;
            }
            match step {
                Ok(None) => {}
                result => return Some(result.map(|value| value.expect("a completed document"))),
            }
        }
        None
    }

    fn step(&mut self) -> Result<Option<Value>, String> {
        if let Some(mut numeric) = self.numeric.take() {
            match numeric.step(&self.text)? {
                Some(value) => self.phase = ReadPhase::Close(value),
                None => self.numeric = Some(numeric),
            }
            return Ok(None);
        }
        if let Some(mut string) = self.string.take() {
            if self.string_step(&mut string)? {
                if string.key {
                    self.recharge();
                    if let Some(Open::Object(_, key)) = self.stack.last_mut() {
                        *key = Some(string.out.into());
                    }
                    self.phase = ReadPhase::Colon;
                } else {
                    self.recharge();
                    self.phase = ReadPhase::Close(Value::string(string.out));
                }
            } else {
                self.string = Some(string);
            }
            return Ok(None);
        }
        if let Some(start) = self.number {
            if self.text.get(self.at).is_some_and(|byte| {
                !matches!(
                    byte,
                    b'[' | b']' | b'{' | b'}' | b',' | b':' | b'"' | b' ' | b'\t' | b'\n' | b'\r'
                )
            }) {
                self.at += 1;
            } else {
                self.numeric = Some(NumberReading::begin(start, self.at));
                self.number = None;
            }
            return Ok(None);
        }
        let phase = std::mem::replace(&mut self.phase, ReadPhase::Value);
        if let ReadPhase::Close(value) = phase {
            match self.stack.last_mut() {
                None => self.phase = ReadPhase::End(value),
                Some(Open::Array(items)) => {
                    items.push(value);
                    self.phase = ReadPhase::Separator;
                }
                Some(Open::Object(object, key)) => {
                    let key = key.take().ok_or("Object keys must be strings")?;
                    object.insert(key, value);
                    self.phase = ReadPhase::Separator;
                }
            }
            return Ok(None);
        }
        if self
            .text
            .get(self.at)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
        {
            self.at += 1;
            self.phase = phase;
            return Ok(None);
        }
        match phase {
            ReadPhase::End(value) => {
                if self.at == self.text.len() {
                    return Ok(Some(value));
                }
                self.phase = ReadPhase::End(value);
                return Err(format!(
                    "Unexpected extra JSON values at offset {}",
                    self.at
                ));
            }
            ReadPhase::Colon => {
                if self.text.get(self.at) != Some(&b':') {
                    return Err(format!(
                        "Objects must consist of key:value pairs at offset {}",
                        self.at
                    ));
                }
                self.at += 1;
                self.after_comma = false;
            }
            ReadPhase::Key => match self.text.get(self.at) {
                Some(b'}') if self.after_comma => {
                    return Err(format!(
                        "Expected another key-value pair{}",
                        place(&self.text, self.at)
                    ));
                }
                Some(b'}') => {
                    self.at += 1;
                    self.close_container();
                }
                Some(b'"') => {
                    self.at += 1;
                    self.string = Some(StringReading {
                        key: true,
                        out: String::new(),
                        fault: None,
                    });
                }
                _ => return Err(format!("Object keys must be strings at offset {}", self.at)),
            },
            ReadPhase::Separator => match self.text.get(self.at) {
                Some(b',') => {
                    self.at += 1;
                    self.after_comma = true;
                    self.phase = if matches!(self.stack.last(), Some(Open::Object(..))) {
                        ReadPhase::Key
                    } else {
                        ReadPhase::Value
                    };
                }
                Some(b']') if matches!(self.stack.last(), Some(Open::Array(_))) => {
                    self.at += 1;
                    self.close_container();
                }
                Some(b'}') if matches!(self.stack.last(), Some(Open::Object(..))) => {
                    self.at += 1;
                    self.close_container();
                }
                _ => {
                    return Err(format!(
                        "Expected separator between values at offset {}",
                        self.at
                    ));
                }
            },
            ReadPhase::Value => match self.text.get(self.at) {
                None => return Err("Unfinished JSON term".into()),
                Some(b']') if self.after_comma => {
                    return Err(format!(
                        "Expected another array element{}",
                        place(&self.text, self.at)
                    ));
                }
                Some(b']') if matches!(self.stack.last(), Some(Open::Array(items)) if items.is_empty()) =>
                {
                    self.at += 1;
                    self.close_container();
                }
                Some(b'[' | b'{') => {
                    if self.stack.len() >= MAX_DEPTH {
                        return Err("Exceeds depth limit for parsing".into());
                    }
                    let object = self.text[self.at] == b'{';
                    self.at += 1;
                    self.after_comma = false;
                    if object {
                        self.stack.push(Open::Object(Object::default(), None));
                        self.phase = ReadPhase::Key;
                    } else {
                        self.stack.push(Open::Array(List::default()));
                    }
                }
                Some(b'"') => {
                    self.at += 1;
                    self.string = Some(StringReading {
                        key: false,
                        out: String::new(),
                        fault: None,
                    });
                }
                Some(b't') if self.text[self.at..].starts_with(b"true") => {
                    self.at += 4;
                    self.phase = ReadPhase::Close(Value::True);
                }
                Some(b'f') if self.text[self.at..].starts_with(b"false") => {
                    self.at += 5;
                    self.phase = ReadPhase::Close(Value::False);
                }
                Some(b'n') if self.text[self.at..].starts_with(b"null") => {
                    self.at += 4;
                    self.phase = ReadPhase::Close(Value::Null);
                }
                Some(
                    b'-' | b'+' | b'.' | b'0'..=b'9' | b'n' | b'N' | b'i' | b'I' | b's' | b'S',
                ) => self.number = Some(self.at),
                Some(_) => return Err(format!("Invalid literal at offset {}", self.at)),
            },
            ReadPhase::Close(_) => unreachable!(),
        }
        Ok(None)
    }

    fn close_container(&mut self) {
        let value = match self.stack.pop().expect("an open container") {
            Open::Array(items) => Value::Array(Arc::new(items)),
            Open::Object(fields, _) => Value::object(fields),
        };
        self.phase = ReadPhase::Close(value);
    }

    fn string_step(&mut self, string: &mut StringReading) -> Result<bool, String> {
        let bytes = &self.text;
        match bytes.get(self.at).copied() {
            None => return Err("Unfinished string".into()),
            Some(b'"') => {
                if let Some(fault) = string.fault {
                    return Err(format!("{fault}{}", place(bytes, self.at)));
                }
                self.at += 1;
                return Ok(true);
            }
            Some(byte) if byte < 0x20 => {
                string.fault.get_or_insert(
                    "Invalid string: control characters from U+0000 through U+001F must be escaped",
                );
                self.at += 1;
            }
            Some(b'\\') => {
                let escape = bytes.get(self.at + 1).copied();
                self.at += 2;
                match escape {
                    Some(b'n') => string.out.push('\n'),
                    Some(b't') => string.out.push('\t'),
                    Some(b'r') => string.out.push('\r'),
                    Some(b'b') => string.out.push('\u{8}'),
                    Some(b'f') => string.out.push('\u{c}'),
                    Some(b'/') => string.out.push('/'),
                    Some(b'\\') => string.out.push('\\'),
                    Some(b'"') => string.out.push('"'),
                    Some(b'u') => {
                        let unit = hex4(bytes, self.at)?;
                        self.at += 4;
                        let point = if (0xD800..0xDC00).contains(&unit)
                            && bytes.get(self.at) == Some(&b'\\')
                            && bytes.get(self.at + 1) == Some(&b'u')
                        {
                            let low = hex4(bytes, self.at + 2)?;
                            if (0xDC00..0xE000).contains(&low) {
                                self.at += 6;
                                0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                            } else {
                                string
                                    .fault
                                    .get_or_insert("Invalid \\uXXXX\\uXXXX surrogate pair escape");
                                0xFFFD
                            }
                        } else if (0xD800..0xDC00).contains(&unit) {
                            string
                                .fault
                                .get_or_insert("Invalid \\uXXXX\\uXXXX surrogate pair escape");
                            0xFFFD
                        } else {
                            unit
                        };
                        string.out.push(char::from_u32(point).unwrap_or('\u{FFFD}'));
                    }
                    _ => return Err("Invalid escape".into()),
                }
            }
            Some(byte) => {
                let count = match byte {
                    0..=0x7f => 1,
                    0xc2..=0xdf => 2,
                    0xe0..=0xef => 3,
                    _ => 4,
                };
                let text = std::str::from_utf8(&bytes[self.at..(self.at + count).min(bytes.len())])
                    .map_err(|_| "Invalid string")?;
                string.out.push_str(text);
                self.at += count;
            }
        }
        Ok(false)
    }
}

/// A number as jq's reader spells it: a decimal literal (a sign, leading
/// zeros and a bare point allowed), `nan` or `Infinity`. The reader stops
/// a token at a NUL.
fn number_token(token: &str) -> Option<Value> {
    let (negative, body) = match token.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, token),
    };
    let word = body.strip_prefix('+').unwrap_or(body);
    let nan = ["snan", "nan"]
        .into_iter()
        .find_map(|prefix| {
            word.get(..prefix.len())
                .filter(|start| start.eq_ignore_ascii_case(prefix))
                .map(|_| &word[prefix.len()..])
        })
        .is_some_and(|rest| rest.bytes().all(|b| b == b'0'));
    if nan {
        return Some(Value::number(f64::NAN));
    }
    if word.eq_ignore_ascii_case("inf") || word.eq_ignore_ascii_case("infinity") {
        return Some(Value::number(if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        }));
    }
    let digits = body.strip_prefix('+').unwrap_or(body);
    let (mantissa, exponent) = match digits.find(['e', 'E']) {
        Some(at) => (&digits[..at], Some(&digits[at + 1..])),
        None => (digits, None),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let valid = (!int.is_empty() || !frac.is_empty())
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.bytes().all(|b| b.is_ascii_digit())
        && exponent.is_none_or(|e| {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            !e.is_empty() && e.bytes().all(|b| b.is_ascii_digit())
        });
    valid.then(|| Value::Number(Number::literal(token)))
}

/// " at line L, column C" for byte `at`, as jv_parse places an error.
fn place(bytes: &[u8], at: usize) -> String {
    let before = &bytes[..at.min(bytes.len())];
    let line = before.iter().filter(|b| **b == b'\n').count() + 1;
    let start = before
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |p| p + 1);
    format!(" at line {line}, column {}", at - start + 1)
}

fn hex4(bytes: &[u8], at: usize) -> Result<u32, String> {
    let digits = bytes.get(at..at + 4).ok_or("Invalid \\uXXXX escape")?;
    let text = std::str::from_utf8(digits).map_err(|_| "Invalid \\uXXXX escape")?;
    u32::from_str_radix(text, 16).map_err(|_| "Invalid \\uXXXX escape".into())
}

#[cfg(test)]
mod tests {
    use super::super::meter::{self, Meter};
    use super::*;

    #[test]
    fn pending_tasks_stop_on_memory_even_with_the_maximum_step_budget() {
        let source = Value::string("\n".repeat(10000));
        let meter = Arc::new(Meter::limited(4096));
        let _installed = meter::install(&meter);
        let mut dump = Dumping::begin(source);
        let mut budget = u64::MAX;
        assert!(dump.run(&mut budget).is_none());
        assert_eq!(budget, 0);
        assert!(meter.exceeded());
        assert!(dump.written() < 20002);
        drop(dump);
        assert_eq!(meter.live(), 0);
        meter.reset();
        let mut parsing = Parsing::begin(format!("\"{}\"", "x".repeat(5000)));
        let mut budget = u64::MAX;
        assert!(parsing.run(&mut budget).is_none());
        assert_eq!(budget, 0);
        assert!(meter.exceeded());
        drop(parsing);
        assert_eq!(meter.live(), 0);
        let meter = Arc::new(Meter::limited(8));
        let _installed = meter::install(&meter);
        let mut comparing = Comparing::begin(Value::number(1.0), Value::number(2.0));
        let mut budget = u64::MAX;
        assert!(comparing.run(&mut budget).is_none());
        assert_eq!(budget, 0);
        assert!(meter.exceeded());
        drop(comparing);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn dumps_advance_one_container_or_scalar_piece() {
        let mut dump = Dumping::begin(Value::array(vec![Value::Null; 100_000]));
        assert!(dump.run(&mut 1).is_none());
        assert_eq!(dump.out, "[");
        assert_eq!(dump.stack.len(), 1);
        assert!(dump.run(&mut 1).is_none());
        assert!(dump.stack.len() <= 2);
        let mut dump = Dumping::begin(Value::string("é".repeat(100_000)));
        assert!(dump.run(&mut 1).is_none());
        assert!(dump.run(&mut 1).is_none());
        assert!(dump.written() <= 65);
        let mut dump = Dumping::begin(Value::Number(Number::literal(&"1".repeat(100_000))));
        assert!(dump.run(&mut 1).is_none());
        assert!(dump.run(&mut 1).is_none());
        assert_eq!(dump.written(), 64);
    }

    #[test]
    fn readers_yield_inside_whitespace_strings_and_numbers() {
        let mut parsing = Parsing::begin(format!("{}null", " ".repeat(100_000)));
        assert!(parsing.run(&mut 1).is_none());
        assert_eq!(parsing.at, 1);
        let mut parsing = Parsing::begin(format!("\"{}\"", "x".repeat(100_000)));
        assert!(parsing.run(&mut 1).is_none());
        assert!(parsing.run(&mut 1).is_none());
        assert_eq!(parsing.at, 2);
        let mut parsing = Parsing::begin("1".repeat(100_000));
        assert!(parsing.run(&mut 1).is_none());
        assert!(parsing.run(&mut 1).is_none());
        assert_eq!(parsing.at, 1);
        while parsing.numeric.is_none() {
            assert!(parsing.run(&mut 1).is_none());
        }
        assert!(parsing.run(&mut 1).is_none());
        assert_eq!(parsing.numeric.as_ref().unwrap().at, 1);
    }

    #[test]
    fn long_number_cursors_preserve_literals_and_double_rounding() {
        let zeros = "0".repeat(5000);
        for text in [
            format!("1{zeros}"),
            format!("-1.{zeros}1e-20"),
            format!("0.{zeros}1"),
            format!("1{}e-5000", "2".repeat(5000)),
            format!("0{zeros}.00e-99999999999999999999"),
            format!("1.{}1", "0".repeat(5000)),
            format!("nan{zeros}"),
        ] {
            let expected = number_token(&text).unwrap();
            let mut parsing = Parsing::begin(text.clone());
            let actual = loop {
                if let Some(result) = parsing.run(&mut 7) {
                    break result.unwrap();
                }
            };
            assert_eq!(actual.dump(), expected.dump(), "{text}");
            let (Value::Number(actual), Value::Number(expected)) = (actual, expected) else {
                unreachable!()
            };
            assert!(
                actual.value.is_nan() && expected.value.is_nan()
                    || actual.value.to_bits() == expected.value.to_bits(),
                "{text}"
            );
        }
        for suffix in ["e--1", "e+1-2", "e+", "e", "e1+2", "e.2"] {
            let mut parsing = Parsing::begin(format!("{}{suffix}", "1".repeat(5000)));
            let result = loop {
                if let Some(result) = parsing.run(&mut 7) {
                    break result;
                }
            };
            assert!(result.is_err(), "{suffix}");
        }
    }

    #[test]
    fn comparisons_yield_inside_long_strings_arrays_objects_and_numbers() {
        let arrays = Value::array(vec![Value::Null; 100_000]);
        let mut comparing = Comparing::begin(arrays.clone(), arrays);
        assert!(comparing.run(&mut 1).is_none());
        assert_eq!(comparing.stack.len(), 1);
        let text = Value::string("x".repeat(100_000));
        let mut comparing = Comparing::begin(text.clone(), text);
        assert!(comparing.run(&mut 1).is_none());
        assert!(comparing.run(&mut 1).is_none());
        assert!(matches!(
            comparing.stack.last(),
            Some(ComparePiece::String(_, _, 64))
        ));
        let number = Value::Number(Number::literal(&"1".repeat(100_000)));
        let mut comparing = Comparing::begin(number.clone(), number);
        assert!(comparing.run(&mut 1).is_none());
        assert!(comparing.run(&mut 1).is_none());
        let mut fields = Object::default();
        for at in 0..10_000 {
            fields.insert(at.to_string().into(), Value::Null);
        }
        let fields = Value::object(fields);
        let mut comparing = Comparing::begin(fields.clone(), fields);
        assert!(comparing.run(&mut 1).is_none());
        assert!(comparing.run(&mut 1).is_none());
        let Some(ComparePiece::Object(object)) = comparing.stack.last() else {
            unreachable!()
        };
        assert_eq!(object.a.order.len(), 1);
    }

    #[test]
    fn sliced_comparisons_preserve_nested_and_decimal_order() {
        let values = [
            "null",
            "false",
            "true",
            "0",
            "-0",
            "1.000",
            "1.001",
            "1e100",
            "1.0e100",
            "1.01e100",
            "\"ab\"",
            "\"abc\"",
            "[1,2]",
            "[1,2,3]",
            "{\"b\":0,\"a\":1}",
            "{\"a\":1,\"b\":2}",
            "{\"a\":0,\"c\":0}",
        ];
        for a in values {
            for b in values {
                let (a, b) = (parse_json(a).unwrap(), parse_json(b).unwrap());
                let expected = try_compare(&a, &b).unwrap();
                for budget in [1, 7, 128] {
                    let mut comparing = Comparing::begin(a.clone(), b.clone());
                    let actual = loop {
                        if let Some(result) = comparing.run(&mut budget.clone()) {
                            break result.unwrap();
                        }
                    };
                    assert_eq!(actual, expected, "{} / {}", a.dump(), b.dump());
                }
            }
        }
    }

    #[test]
    fn object_and_array_retirement_keep_storage_charged_until_freed() {
        let meter = Arc::new(Meter::default());
        let _installed = meter::install(&meter);
        let mut fields = Object::default();
        for at in 0..10_000 {
            fields.insert(at.to_string().into(), Value::Null);
        }
        let before = meter.live();
        let mut retirement = Retirement::split(Value::object(fields)).unwrap();
        assert_eq!(meter.live(), before);
        assert!(retirement.next().is_some());
        let Retirement::Object { entries, index, .. } = &retirement else {
            unreachable!()
        };
        assert_eq!(entries.len(), 9999);
        assert_eq!(index.len(), 10000);
        drop(retirement);
        assert_eq!(meter.live(), 0);
        let array = Value::array(vec![Value::Null; 10000]);
        let before = meter.live();
        let mut retirement = Retirement::split(array).unwrap();
        assert_eq!(meter.live(), before);
        assert!(retirement.next().is_some());
        assert_eq!(meter.live(), before);
        drop(retirement);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn error_previews_stop_before_dumping_a_large_value() {
        let input = Value::array((0..100000).map(|n| Value::number(f64::from(n))).collect());
        let full = input.dump();
        let expected = format!("{}...]", &full[..25]);
        let number = Value::Number(Number::literal(&"1".repeat(100000)));
        let meter = Arc::new(Meter::limited(1024));
        let _installed = meter::install(&meter);
        assert_eq!(input.dump_trunc(), expected);
        assert!(!meter.exceeded());
        assert_eq!(meter.live(), 0);
        let preview = number.dump_trunc();
        assert_eq!(preview.len(), 29);
        assert!(!meter.exceeded());
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn scalar_buffer_transfers_do_not_charge_one_allocation_twice() {
        let meter = Arc::new(Meter::limited(250000));
        let _installed = meter::install(&meter);
        let mut text = String::with_capacity(100002);
        text.push('"');
        text.push_str(&"x".repeat(100000));
        text.push('"');
        let mut parsing = Parsing::begin(text);
        let value = loop {
            if let Some(result) = parsing.run(&mut 128) {
                break result.unwrap();
            }
            assert!(!meter.exceeded(), "{} retained bytes", meter.live());
        };
        assert!(!meter.exceeded());
        drop(value);
        drop(parsing);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn numeric_buffer_transfer_preserves_the_literal_within_the_cap() {
        let meter = Arc::new(Meter::limited(22000));
        let _installed = meter::install(&meter);
        let mut parsing = Parsing::begin("1".repeat(5000));
        let value = loop {
            let result = parsing.run(&mut 1);
            assert!(!meter.exceeded(), "{} retained bytes", meter.live());
            if let Some(result) = result {
                break result.unwrap();
            }
        };
        drop(parsing);
        assert_eq!(value.dump(), "1".repeat(5000));
        assert!(!meter.exceeded());
        drop(value);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn long_number_final_scratch_latches_its_peak_before_release() {
        let prepare = || {
            let mut parsing = Parsing::begin(format!("1{}", "0".repeat(4999)));
            while !parsing
                .numeric
                .as_ref()
                .is_some_and(|number| number.build && number.copied == number.digits)
            {
                assert!(parsing.run(&mut 1).is_none());
            }
            parsing
        };
        let meter = Arc::new(Meter::default());
        let installed = meter::install(&meter);
        let parsing = prepare();
        let retained = meter.live();
        drop(parsing);
        assert_eq!(meter.live(), 0);
        drop(installed);
        for budget in [7, u64::MAX] {
            for (limit, exceeded) in [(retained, true), (retained + 20000, false)] {
                let meter = Arc::new(Meter::limited(limit));
                let _installed = meter::install(&meter);
                let mut parsing = prepare();
                assert!(!meter.exceeded(), "input and retained buffers fit");
                let mut budget = budget;
                let result = parsing.run(&mut budget);
                assert_eq!(
                    meter.exceeded(),
                    exceeded,
                    "{retained} retained bytes, limit {limit}"
                );
                assert!(meter.live() <= retained, "final scratch was released");
                drop(result);
                drop(parsing);
                assert_eq!(meter.live(), 0);
                assert_eq!(meter.exceeded(), exceeded);
                meter.reset();
                assert!(!meter.exceeded());
            }
        }
    }

    #[test]
    fn parser_dump_and_number_buffers_charge_and_release() {
        let meter = Arc::new(Meter::default());
        let _installed = meter::install(&meter);
        let mut parsing = Parsing::begin(format!("\"{}\"", "x".repeat(10000)));
        let input = meter.live();
        assert!(parsing.run(&mut 5000).is_none());
        assert!(meter.live() > input);
        drop(parsing);
        assert_eq!(meter.live(), 0);
        let mut dump = Dumping::begin(Value::array(vec![Value::Null; 10000]));
        let input = meter.live();
        assert!(dump.run(&mut 1000).is_none());
        assert!(meter.live() > input);
        drop(dump);
        assert_eq!(meter.live(), 0);
        let number = Number::literal(&"1".repeat(10000));
        assert!(meter.live() >= 10000);
        let shared = number.clone();
        let input = meter.live();
        drop(number);
        assert_eq!(meter.live(), input);
        drop(shared);
        assert_eq!(meter.live(), 0);
    }
}
