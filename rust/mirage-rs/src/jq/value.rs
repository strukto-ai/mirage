// Adapted from jq 1.8.2 (MIT), src/jv.c, src/jv_aux.c and src/jv_print.c. See licenses/third_party/jq.txt.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::Arc;

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
    literal: Option<Arc<str>>,
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
            literal: Some(canonical(text).into()),
        }
    }

    pub(crate) fn value(&self) -> f64 {
        self.value
    }

    /// decNumber's minus: a literal keeps its digits, and zero its sign
    /// dropped.
    pub(crate) fn negate(&self) -> Self {
        let literal = self.literal.as_ref().map(|text| {
            if normalize(text).1.is_empty() {
                Arc::from(text.trim_start_matches('-'))
            } else if let Some(rest) = text.strip_prefix('-') {
                Arc::from(rest)
            } else {
                Arc::from(format!("-{text}"))
            }
        });
        Self {
            value: -self.value,
            literal,
        }
    }

    /// jq's number order: the doubles, and when those tie between two
    /// literals, the decimals they spell, as decNumber compares them.
    pub(crate) fn cmp_exact(&self, other: &Number) -> Ordering {
        let order = compare_numbers(self.value, other.value);
        if order != Ordering::Equal || self.value.is_nan() {
            return order;
        }
        match (&self.literal, &other.literal) {
            (Some(a), Some(b)) => compare_decimal(&normalize(a), &normalize(b)),
            _ => Ordering::Equal,
        }
    }

    pub(crate) fn write(&self, out: &mut String) {
        match &self.literal {
            Some(text) => out.push_str(text),
            None => format_double(self.value, out),
        }
    }
}

/// Two normalized decimals (see `normalize`) in numeric order.
fn compare_decimal(a: &(bool, String, i64), b: &(bool, String, i64)) -> Ordering {
    let sign = |d: &(bool, String, i64)| match (d.1.is_empty(), d.0) {
        (true, _) => 0,
        (false, true) => -1,
        (false, false) => 1,
    };
    let order = sign(a).cmp(&sign(b));
    if order != Ordering::Equal || sign(a) == 0 {
        return order;
    }
    let adjusted = |d: &(bool, String, i64)| d.2.saturating_add(d.1.len() as i64);
    let magnitude = adjusted(a).cmp(&adjusted(b)).then_with(|| {
        let (x, y) = (a.1.as_bytes(), b.1.as_bytes());
        (0..x.len().max(y.len()))
            .map(|i| {
                let p = x.get(i).copied().unwrap_or(b'0');
                let q = y.get(i).copied().unwrap_or(b'0');
                p.cmp(&q)
            })
            .find(|o| *o != Ordering::Equal)
            .unwrap_or(Ordering::Equal)
    });
    if a.0 { magnitude.reverse() } else { magnitude }
}

/// A literal as sign, significant digits and exponent, trailing zeros
/// folded into the exponent; zero is (false, "", 0).
fn normalize(text: &str) -> (bool, String, i64) {
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (mantissa, exponent) = match rest.find('E') {
        Some(at) => (&rest[..at], rest[at + 1..].parse::<i64>().unwrap_or(0)),
        None => (rest, 0),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits: String = int.chars().chain(frac.chars()).collect();
    let digits = digits.trim_start_matches('0');
    let trimmed = digits.trim_end_matches('0');
    if trimmed.is_empty() {
        return (false, String::new(), 0);
    }
    let exp = exponent - frac.len() as i64 + (digits.len() - trimmed.len()) as i64;
    (negative, trimmed.to_string(), exp)
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

/// An array's items. Dropping the last reference to a deep value tears it
/// down with a loop, not recursion, so nesting cannot overflow the stack.
#[derive(Clone, Debug, Default)]
pub(crate) struct List(pub(crate) Vec<Value>);

impl Deref for List {
    type Target = Vec<Value>;
    fn deref(&self) -> &Vec<Value> {
        &self.0
    }
}

impl DerefMut for List {
    fn deref_mut(&mut self) -> &mut Vec<Value> {
        &mut self.0
    }
}

impl Drop for List {
    fn drop(&mut self) {
        teardown(std::mem::take(&mut self.0));
    }
}

/// An object's fields in insertion order, which jq prints them in.
#[derive(Clone, Debug, Default)]
pub(crate) struct Object {
    entries: Vec<(Arc<str>, Value)>,
    index: HashMap<Arc<str>, usize>,
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
pub(crate) fn shed(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => match Arc::try_unwrap(items) {
            Ok(mut list) => std::mem::take(&mut list.0),
            Err(_) => Vec::new(),
        },
        Value::Object(fields) => match Arc::try_unwrap(fields) {
            Ok(mut object) => {
                object.index.clear();
                object.entries.drain(..).map(|(_, v)| v).collect()
            }
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn teardown(mut stack: Vec<Value>) {
    while let Some(value) = stack.pop() {
        match value {
            Value::Array(items) => {
                if let Ok(mut list) = Arc::try_unwrap(items) {
                    stack.append(&mut list.0);
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
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.index.get(key).map(|at| &self.entries[*at].1)
    }

    pub(crate) fn insert(&mut self, key: Arc<str>, value: Value) {
        match self.index.get(&*key) {
            Some(at) => self.entries[*at].1 = value,
            None => {
                self.index.insert(Arc::clone(&key), self.entries.len());
                self.entries.push((key, value));
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
        }
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &Value)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub(crate) fn entry(&self, at: usize) -> Option<(&Arc<str>, &Value)> {
        self.entries.get(at).map(|(k, v)| (k, v))
    }

    pub(crate) fn sorted_keys(&self) -> Vec<&Arc<str>> {
        let mut keys: Vec<&Arc<str>> = self.entries.iter().map(|(k, _)| k).collect();
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
    String(Arc<str>),
    Array(Arc<List>),
    Object(Arc<Object>),
}

impl Value {
    pub(crate) fn number(value: f64) -> Self {
        Self::Number(Number::new(value))
    }

    pub(crate) fn string(text: impl Into<Arc<str>>) -> Self {
        Self::String(text.into())
    }

    pub(crate) fn array(items: Vec<Value>) -> Self {
        Self::Array(Arc::new(List(items)))
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
        match (self, other) {
            (Self::Number(a), Self::Number(b)) => {
                Ok(a.value() == b.value() && a.cmp_exact(b) == Ordering::Equal)
            }
            _ if self.identical(other) => Ok(true),
            _ => Ok(try_compare(self, other)? == Ordering::Equal),
        }
    }

    /// jq's compact dump, as `tojson` and the main loop print it.
    pub(crate) fn dump(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    pub(crate) fn write(&self, out: &mut String) {
        enum Step<'a> {
            Value(&'a Value, usize),
            Text(&'static str),
            Key(&'a str),
        }
        let mut stack = vec![Step::Value(self, 0)];
        while let Some(step) = stack.pop() {
            match step {
                Step::Text(text) => out.push_str(text),
                Step::Key(key) => {
                    write_string(key, out);
                    out.push(':');
                }
                Step::Value(_, depth) if depth > MAX_DEPTH => out.push_str("<skipped: too deep>"),
                Step::Value(value, depth) => match value {
                    Value::Null => out.push_str("null"),
                    Value::False => out.push_str("false"),
                    Value::True => out.push_str("true"),
                    Value::Number(n) => n.write(out),
                    Value::String(s) => write_string(s, out),
                    Value::Array(items) => {
                        out.push('[');
                        stack.push(Step::Text("]"));
                        for (i, item) in items.iter().enumerate().rev() {
                            stack.push(Step::Value(item, depth + 1));
                            if i > 0 {
                                stack.push(Step::Text(","));
                            }
                        }
                    }
                    Value::Object(fields) => {
                        out.push('{');
                        stack.push(Step::Text("}"));
                        let entries: Vec<_> = fields.iter().collect();
                        for (i, (k, v)) in entries.into_iter().enumerate().rev() {
                            stack.push(Step::Value(v, depth + 1));
                            stack.push(Step::Key(k));
                            if i > 0 {
                                stack.push(Step::Text(","));
                            }
                        }
                    }
                },
            }
        }
    }

    /// jv_dump_string_trunc with jq's 30-byte buffer, as error messages
    /// quote a value.
    pub(crate) fn dump_trunc(&self) -> String {
        const BUF: usize = 30;
        let text = match self {
            Value::String(s) if s.len() > BUF => {
                Value::string(s.chars().take(BUF).collect::<String>()).dump()
            }
            other => other.dump(),
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

pub(crate) fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
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

/// jv_cmp's total order, walked with a stack so depth cannot overflow, and refused
/// past jq's MAX_CMP_DEPTH as jq refuses it.
pub(crate) fn try_compare(a: &Value, b: &Value) -> Result<Ordering, TooDeep> {
    enum Frame<'a> {
        Array(&'a [Value], &'a [Value], usize),
        Object(Vec<&'a Arc<str>>, &'a Object, &'a Object, usize),
    }
    let mut stack: Vec<Frame> = Vec::new();
    let (mut x, mut y) = (a, b);
    loop {
        if stack.len() > MAX_DEPTH {
            return Err(TooDeep);
        }
        let order = x.rank().cmp(&y.rank());
        if order != Ordering::Equal {
            return Ok(order);
        }
        match (x, y) {
            (Value::Number(p), Value::Number(q)) => {
                let order = p.cmp_exact(q);
                if order != Ordering::Equal {
                    return Ok(order);
                }
            }
            (Value::String(p), Value::String(q)) => {
                let order = p.as_bytes().cmp(q.as_bytes());
                if order != Ordering::Equal {
                    return Ok(order);
                }
            }
            (Value::Array(p), Value::Array(q)) => stack.push(Frame::Array(p, q, 0)),
            (Value::Object(p), Value::Object(q)) => {
                let kp = p.sorted_keys();
                let kq = q.sorted_keys();
                let order = kp
                    .iter()
                    .map(|k| k.as_bytes())
                    .cmp(kq.iter().map(|k| k.as_bytes()));
                if order != Ordering::Equal {
                    return Ok(order);
                }
                stack.push(Frame::Object(kp, p, q, 0));
            }
            _ => {}
        }
        loop {
            match stack.last_mut() {
                None => return Ok(Ordering::Equal),
                Some(Frame::Array(p, q, i)) => {
                    if *i < p.len() && *i < q.len() {
                        (x, y) = (&p[*i], &q[*i]);
                        *i += 1;
                        break;
                    }
                    let order = p.len().cmp(&q.len());
                    stack.pop();
                    if order != Ordering::Equal {
                        return Ok(order);
                    }
                }
                Some(Frame::Object(keys, p, q, i)) => {
                    if *i < keys.len() {
                        let key: &str = keys[*i];
                        let (Some(u), Some(v)) = (p.get(key), q.get(key)) else {
                            unreachable!("keys compared equal");
                        };
                        (x, y) = (u, v);
                        *i += 1;
                        break;
                    }
                    stack.pop();
                }
            }
        }
    }
}

/// Parse one JSON document, as the host hands it over already checked.
/// Numbers keep their literal. Nesting is walked with a stack.
pub(crate) fn parse_json(text: &str) -> Result<Value, String> {
    enum Open {
        Array(Vec<Value>),
        Object(Object, Option<Arc<str>>),
    }
    let bytes = text.as_bytes();
    let mut at = 0;
    let mut stack: Vec<Open> = Vec::new();
    let mut after_comma = false;
    let skip = |at: &mut usize| {
        while *at < bytes.len() && matches!(bytes[*at], b' ' | b'\t' | b'\n' | b'\r') {
            *at += 1;
        }
    };
    loop {
        skip(&mut at);
        if let Some(Open::Object(_, None)) = stack.last() {
            if bytes.get(at) == Some(&b'}') {
                if after_comma {
                    return Err(format!(
                        "Expected another key-value pair{}",
                        place(bytes, at)
                    ));
                }
                at += 1;
                let Some(Open::Object(object, _)) = stack.pop() else {
                    unreachable!()
                };
                if let Some(value) = close(&mut stack, Value::object(object), bytes, &mut at)? {
                    return finish(value, bytes, at);
                }
                after_comma = true;
                continue;
            }
            if bytes.get(at) != Some(&b'"') {
                return Err(format!("Object keys must be strings at offset {at}"));
            }
            let key = parse_string(bytes, &mut at)?;
            skip(&mut at);
            if bytes.get(at) != Some(&b':') {
                return Err(format!(
                    "Objects must consist of key:value pairs at offset {at}"
                ));
            }
            at += 1;
            after_comma = false;
            if let Some(Open::Object(_, slot)) = stack.last_mut() {
                *slot = Some(key.into());
            }
            continue;
        }
        let value = match bytes.get(at) {
            None => return Err("Unfinished JSON term".into()),
            Some(b']') if after_comma => {
                return Err(format!(
                    "Expected another array element{}",
                    place(bytes, at)
                ));
            }
            Some(b'[') => {
                after_comma = false;
                at += 1;
                skip(&mut at);
                if stack.len() >= MAX_DEPTH {
                    return Err("Exceeds depth limit for parsing".into());
                }
                if bytes.get(at) == Some(&b']') {
                    at += 1;
                    Value::array(Vec::new())
                } else {
                    stack.push(Open::Array(Vec::new()));
                    continue;
                }
            }
            Some(b'{') => {
                if stack.len() >= MAX_DEPTH {
                    return Err("Exceeds depth limit for parsing".into());
                }
                at += 1;
                after_comma = false;
                stack.push(Open::Object(Object::default(), None));
                continue;
            }
            Some(b'"') => Value::string(parse_string(bytes, &mut at)?),
            Some(b't') if bytes[at..].starts_with(b"true") => {
                at += 4;
                Value::True
            }
            Some(b'f') if bytes[at..].starts_with(b"false") => {
                at += 5;
                Value::False
            }
            Some(b'n') if bytes[at..].starts_with(b"null") => {
                at += 4;
                Value::Null
            }
            Some(b'-' | b'+' | b'.' | b'0'..=b'9' | b'n' | b'N' | b'I') => {
                let start = at;
                while at < bytes.len()
                    && !matches!(
                        bytes[at],
                        b'[' | b']'
                            | b'{'
                            | b'}'
                            | b','
                            | b':'
                            | b'"'
                            | b' '
                            | b'\t'
                            | b'\n'
                            | b'\r'
                    )
                {
                    at += 1;
                }
                let token = &text[start..at];
                let token = token.split('\0').next().unwrap_or(token);
                number_token(token).ok_or_else(|| format!("Invalid literal at offset {start}"))?
            }
            Some(_) => return Err(format!("Invalid literal at offset {at}")),
        };
        if let Some(value) = close(&mut stack, value, bytes, &mut at)? {
            return finish(value, bytes, at);
        }
        after_comma = true;
    }

    fn close(
        stack: &mut Vec<Open>,
        mut value: Value,
        bytes: &[u8],
        at: &mut usize,
    ) -> Result<Option<Value>, String> {
        loop {
            match stack.last_mut() {
                None => return Ok(Some(value)),
                Some(Open::Array(items)) => items.push(value),
                Some(Open::Object(object, key)) => {
                    let key = key.take().ok_or("Object keys must be strings")?;
                    object.insert(key, value);
                }
            }
            while *at < bytes.len() && matches!(bytes[*at], b' ' | b'\t' | b'\n' | b'\r') {
                *at += 1;
            }
            match (stack.last(), bytes.get(*at)) {
                (_, Some(b',')) => {
                    *at += 1;
                    return Ok(None);
                }
                (Some(Open::Array(_)), Some(b']')) => {
                    *at += 1;
                    let Some(Open::Array(items)) = stack.pop() else {
                        unreachable!()
                    };
                    value = Value::array(items);
                }
                (Some(Open::Object(..)), Some(b'}')) => {
                    *at += 1;
                    let Some(Open::Object(object, _)) = stack.pop() else {
                        unreachable!()
                    };
                    value = Value::object(object);
                }
                _ => return Err(format!("Expected separator between values at offset {at}")),
            }
        }
    }

    fn finish(value: Value, bytes: &[u8], mut at: usize) -> Result<Value, String> {
        while at < bytes.len() && matches!(bytes[at], b' ' | b'\t' | b'\n' | b'\r') {
            at += 1;
        }
        if at < bytes.len() {
            return Err(format!("Unexpected extra JSON values at offset {at}"));
        }
        Ok(value)
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
    match body {
        "nan" | "NaN" => return Some(Value::number(f64::NAN)),
        "Infinity" | "infinity" => {
            return Some(Value::number(if negative {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }));
        }
        _ => {}
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

/// One string token. Like jv_parse, a raw control character or an
/// unpaired high surrogate escape fails the token, reported where it ends.
fn parse_string(bytes: &[u8], at: &mut usize) -> Result<String, String> {
    *at += 1;
    let mut out: Vec<u8> = Vec::new();
    let mut fault: Option<&str> = None;
    loop {
        match bytes.get(*at) {
            None => return Err("Unfinished string".into()),
            Some(b'"') => {
                if let Some(fault) = fault {
                    return Err(format!("{fault}{}", place(bytes, *at)));
                }
                *at += 1;
                return Ok(String::from_utf8_lossy(&out).into_owned());
            }
            Some(byte) if *byte < 0x20 => {
                fault.get_or_insert(
                    "Invalid string: control characters from U+0000 through U+001F must be escaped",
                );
                *at += 1;
            }
            Some(b'\\') => {
                let escape = bytes.get(*at + 1).copied();
                *at += 2;
                match escape {
                    Some(b'n') => out.push(b'\n'),
                    Some(b't') => out.push(b'\t'),
                    Some(b'r') => out.push(b'\r'),
                    Some(b'b') => out.push(8),
                    Some(b'f') => out.push(12),
                    Some(b'/') => out.push(b'/'),
                    Some(b'\\') => out.push(b'\\'),
                    Some(b'"') => out.push(b'"'),
                    Some(b'u') => {
                        let unit = hex4(bytes, *at)?;
                        *at += 4;
                        let point = if (0xD800..0xDC00).contains(&unit)
                            && bytes.get(*at) == Some(&b'\\')
                            && bytes.get(*at + 1) == Some(&b'u')
                        {
                            let low = hex4(bytes, *at + 2)?;
                            if (0xDC00..0xE000).contains(&low) {
                                *at += 6;
                                0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                            } else {
                                fault.get_or_insert("Invalid \\uXXXX\\uXXXX surrogate pair escape");
                                0xFFFD
                            }
                        } else if (0xD800..0xDC00).contains(&unit) {
                            fault.get_or_insert("Invalid \\uXXXX\\uXXXX surrogate pair escape");
                            0xFFFD
                        } else {
                            unit
                        };
                        let ch = char::from_u32(point).unwrap_or('\u{FFFD}');
                        let mut buf = [0u8; 4];
                        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                    }
                    _ => return Err("Invalid escape".into()),
                }
            }
            Some(byte) => {
                out.push(*byte);
                *at += 1;
            }
        }
    }
}

fn hex4(bytes: &[u8], at: usize) -> Result<u32, String> {
    let digits = bytes.get(at..at + 4).ok_or("Invalid \\uXXXX escape")?;
    let text = std::str::from_utf8(digits).map_err(|_| "Invalid \\uXXXX escape")?;
    u32::from_str_radix(text, 16).map_err(|_| "Invalid \\uXXXX escape".into())
}
