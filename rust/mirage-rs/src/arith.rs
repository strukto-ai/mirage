//! bash's arithmetic, read and evaluated in one pass as bash does: comma
//! sequences, the assignment operators, the ternary, short-circuit `&&` and
//! `||`, the bitwise, comparison, shift and arithmetic operators,
//! right-grouping `**`, the unary operators, `++` and `--`, and integer
//! constants in any base from 2 to 64, over 64-bit wrapping integers. A
//! variable whose value is not a plain number is read as an expression of
//! its own (`x="1+2"; $((x))` is 3). The variables belong to the host, which
//! answers through `Vars`; the writes an expression makes come back in
//! order, for the host to land. Text is bytes, as the shell's is: a value
//! holding a byte that is no UTF-8 is still read, and named in an error.

use std::collections::HashMap;

/// The blanks bash skips between tokens.
const BLANKS: &[u8] = b" \t\n";

/// How deep variables holding expressions may nest (`x="1+2"; $((x))`): a
/// variable read from an expression this many values deep is past the
/// limit. bash's is 1023; mirage stops at 27, which names the same
/// expression of a reference cycle of 1, 2, 3, 4, 6 or 12 names as bash's
/// limit does (27 and 1023 agree modulo 12).
const MAX_DEPTH: usize = 27;

/// How many operators one evaluation may nest (`((((1))))`, `- - 1`,
/// `a=b=1`), the values it reads included, so the reader's stack stays
/// bounded on every host.
const MAX_NEST: usize = 512;

/// The operators longest first, as bash reads them: `<<=` is never `<<`
/// then `=`.
const OPERATORS: [&[u8]; 39] = [
    b"<<=", b">>=", b"**", b"++", b"--", b"<<", b">>", b"<=", b">=", b"==", b"!=", b"&&", b"||",
    b"-=", b"+=", b"*=", b"/=", b"%=", b"&=", b"^=", b"|=", b"-", b"+", b"*", b"/", b"%", b"<",
    b">", b"=", b"!", b"~", b"&", b"|", b"^", b"?", b":", b"(", b")", b",",
];

const ASSIGN_OPS: [&[u8]; 11] = [
    b"=", b"+=", b"-=", b"*=", b"/=", b"%=", b"<<=", b">>=", b"&=", b"^=", b"|=",
];

/// How tightly a binary operator binds, loosest first; 0 for one that is
/// none. `**` alone groups from the right, and a unary operator binds
/// tighter than all of them (`-2**2` is 4).
fn precedence(op: &[u8]) -> usize {
    match op {
        b"||" => 1,
        b"&&" => 2,
        b"|" => 3,
        b"^" => 4,
        b"&" => 5,
        b"==" | b"!=" => 6,
        b"<" | b"<=" | b">" | b">=" => 7,
        b"<<" | b">>" => 8,
        b"+" | b"-" => 9,
        b"*" | b"/" | b"%" => 10,
        b"**" => 11,
        _ => 0,
    }
}

/// The host's answer to a question it refused: it holds what it raised.
pub struct Halt;

/// The variables an expression reads and writes, which the host holds. A
/// name is ASCII, as bash's are; a subscript, a key and a value are bytes.
pub trait Vars {
    /// What a name's dynamic reader draws (`RANDOM`), for a name the
    /// evaluation was told is dynamic; None falls back to its value.
    fn draw(&mut self, name: &str) -> Result<Option<Vec<u8>>, Halt>;
    /// The scalar a bare name holds, else element 0 of the array it names.
    fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, Halt>;
    /// Whether a name holds an array, indexed or associative, empty or
    /// not, which `set -u` lets stand unset.
    fn holds_array(&mut self, name: &str) -> Result<bool, Halt>;
    /// Whether a name holds an associative array, whose subscript is a key.
    fn assoc(&mut self, name: &str) -> Result<bool, Halt>;
    /// The canonical key one reference names: an associative array's raw
    /// subscript text, or an indexed one's evaluated index.
    fn resolve(&mut self, name: &str, subscript: &[u8]) -> Result<Vec<u8>, Halt>;
    /// The element's stored text, None when it is unset.
    fn element(&mut self, name: &str, key: &[u8]) -> Result<Option<Vec<u8>>, Halt>;
    /// The readonly variable a write to a name reaches, through a
    /// reference, or None when the write lands.
    fn frozen(&mut self, name: &str) -> Result<Option<String>, Halt>;
    /// Hear an assignment to a dynamic name as it is made, so its reader
    /// can act on it at once (bash seeds `RANDOM` at the assignment).
    fn wrote(&mut self, name: &str, value: &str) -> Result<(), Halt>;
}

/// Why an evaluation stopped.
#[derive(Debug)]
pub enum Error {
    /// bash's arithmetic error line: the expression it names, what went
    /// wrong, and the error token, if bash names one. `subscript` marks one
    /// made while an array subscript evaluated, which ends the shell
    /// wherever the subscript is.
    Arith {
        reason: String,
        expression: Vec<u8>,
        token: Option<Vec<u8>>,
        subscript: bool,
    },
    /// A write reached `name`, which is readonly; `subscript` marks one
    /// made inside a subscript.
    Readonly { name: String, subscript: bool },
    /// `set -u` and a name no variable holds.
    Unbound(String),
    /// The host raised; `subscript` marks it raised while a subscript
    /// evaluated.
    Halt { subscript: bool },
}

impl From<Halt> for Box<Error> {
    fn from(_: Halt) -> Self {
        Box::new(Error::Halt { subscript: false })
    }
}

/// A step of an evaluation; the error is boxed, so a frame stays small and
/// a deep expression's stack shallow.
type Step<T> = Result<T, Box<Error>>;

/// One assignment an evaluation made: the name, the canonical key for an
/// element (None for a bare name), and the decimal text stored.
#[derive(Debug)]
pub struct Write {
    pub name: String,
    pub key: Option<Vec<u8>>,
    pub value: String,
}

/// What an evaluation produced: its value or why it stopped, and every
/// write it made before that, in order.
pub struct Outcome {
    pub value: Result<i64, Error>,
    pub writes: Vec<Write>,
}

/// What to evaluate and how: the expression, an integer `+=`'s added text
/// (read after it in the same evaluation and added to it), `set -u`, whether
/// a session's arrays stand behind it (without one every subscript is a
/// syntax error), the names whose reads a dynamic reader answers, and
/// whether its subscripts expand as a variable's value's do (a `let`
/// operand, an `-i` value), where text the host already expanded
/// (`$((...))`) expands no further.
pub struct Request<'a> {
    pub expression: &'a [u8],
    pub added: Option<&'a [u8]>,
    pub nounset: bool,
    pub elements: bool,
    pub dynamic: &'a [String],
    pub expand: bool,
}

/// Evaluate `request` against `vars`.
pub fn evaluate(request: &Request<'_>, vars: &mut dyn Vars) -> Outcome {
    let mut record = Record {
        vars,
        nounset: request.nounset,
        elements: request.elements,
        dynamic: request.dynamic,
        updates: HashMap::new(),
        elem_updates: HashMap::new(),
        writes: Vec::new(),
        nest: 0,
    };
    let expand = request.expand;
    let value = record
        .evaluate(request.expression, 0, false, expand)
        .and_then(|value| match request.added {
            Some(added) => Ok(value.wrapping_add(record.evaluate(added, 0, false, expand)?)),
            None => Ok(value),
        });
    Outcome {
        value: value.map_err(|err| *err),
        writes: record.writes,
    }
}

/// `text` as a plain decimal (ASCII digits, no leading `0`, which would read
/// as octal), wrapped to 64 bits; None when it has to be evaluated.
pub fn plain_decimal(text: &[u8]) -> Option<i64> {
    let start = text.iter().position(|ch| !BLANKS.contains(ch))?;
    let end = text.iter().rposition(|ch| !BLANKS.contains(ch))? + 1;
    let number = &text[start..end];
    if number[0] == b'0' || !number.iter().all(u8::is_ascii_digit) {
        return None;
    }
    digits_value(number, 10).map(|value| value as i64)
}

/// The value of one digit of a `base#digits` constant: below base 37
/// upper- and lowercase letters are interchangeable, above it uppercase
/// continues the range.
fn base_digit(ch: u8, base: u64) -> u64 {
    match ch {
        b'0'..=b'9' => u64::from(ch - b'0'),
        b'a'..=b'z' => u64::from(ch - b'a') + 10,
        b'A'..=b'Z' => u64::from(ch - b'A') + if base <= 36 { 10 } else { 36 },
        b'@' => 62,
        _ => 63,
    }
}

/// The value of `digits` in `base` modulo 2**64, or None when one is too
/// great; kept to 64 bits as it is read, so a long constant stays linear.
fn digits_value(digits: &[u8], base: u64) -> Option<u64> {
    let mut value: u64 = 0;
    for &ch in digits {
        let digit = base_digit(ch, base);
        if digit >= base {
            return None;
        }
        value = value.wrapping_mul(base).wrapping_add(digit);
    }
    Some(value)
}

/// The value of an integer constant, or what bash says of a bad one:
/// decimal, octal after a leading `0`, hexadecimal after `0x` (bare `0x` is
/// 0), or `base#digits` for a base from 2 to 64 written in decimal
/// (`0x10#f` is an invalid number).
fn constant(text: &[u8]) -> Result<i64, &'static str> {
    let value = if let Some(hash) = memchr::memchr(b'#', text) {
        let (base_text, digits) = (&text[..hash], &text[hash + 1..]);
        let base = constant(base_text)?;
        if base_text.starts_with(b"0") {
            return Err("invalid number");
        }
        if !(2..=64).contains(&base) {
            return Err("invalid arithmetic base");
        }
        if digits.is_empty() || digits[0] == b'#' {
            return Err("invalid integer constant");
        }
        if digits.contains(&b'#') {
            return Err("invalid number");
        }
        digits_value(digits, base as u64)
    } else if text.starts_with(b"0x") || text.starts_with(b"0X") {
        digits_value(&text[2..], 16)
    } else if text.starts_with(b"0") {
        digits_value(text, 8)
    } else {
        digits_value(text, 10)
    };
    value
        .map(|value| value as i64)
        .ok_or("value too great for base")
}

/// `base ** exponent` modulo 2**64, by squaring.
fn power(base: i64, mut exponent: i64) -> i64 {
    let mut result: i64 = 1;
    let mut factor = base;
    while exponent > 0 {
        if exponent & 1 == 1 {
            result = result.wrapping_mul(factor);
        }
        factor = factor.wrapping_mul(factor);
        exponent >>= 1;
    }
    result
}

/// A target's name and its subscript, None for a bare name. The name is
/// ASCII, as `name_end` read it.
fn split_target(target: &[u8]) -> (&str, Option<&[u8]>) {
    let (name, subscript) = match memchr::memchr(b'[', target) {
        Some(open) => (&target[..open], Some(&target[open + 1..target.len() - 1])),
        None => (target, None),
    };
    (std::str::from_utf8(name).unwrap_or_default(), subscript)
}

/// Index of the `]` closing the `[` at `start`, quote-aware: an associative
/// key may hold a bracket (`m["a]b"]`), and an indexed subscript another
/// reference (`a[b[0]]`).
fn matching_bracket(text: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = start;
    while i < text.len() {
        let ch = text[i];
        if ch == b'"' || ch == b'\'' {
            i += 1 + memchr::memchr(ch, &text[i + 1..])? + 1;
            continue;
        }
        if ch == b'[' {
            depth += 1;
        } else if ch == b']' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn name_end(text: &[u8], pos: usize) -> Option<usize> {
    let first = *text.get(pos)?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let len = text[pos + 1..]
        .iter()
        .take_while(|ch| ch.is_ascii_alphanumeric() || **ch == b'_')
        .count();
    Some(pos + 1 + len)
}

fn literal_end(text: &[u8], pos: usize) -> Option<usize> {
    if !text.get(pos)?.is_ascii_digit() {
        return None;
    }
    let len = text[pos + 1..]
        .iter()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'@' | b'#'))
        .count();
    Some(pos + 1 + len)
}

/// Index of the `))` closing a `$((` whose text starts at `start`.
fn arith_close(text: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, &ch) in text.iter().enumerate().skip(start) {
        match ch {
            b'(' => depth += 1,
            b')' if depth == 0 => return (text.get(i + 1) == Some(&b')')).then_some(i),
            b')' => depth -= 1,
            _ => {}
        }
    }
    None
}

/// An error made while a subscript evaluated, marked so.
fn in_subscript(mut err: Box<Error>) -> Box<Error> {
    if let Error::Arith { subscript, .. } | Error::Halt { subscript } = &mut *err {
        *subscript = true;
    }
    err
}

fn operator_at(text: &[u8], pos: usize) -> Option<&'static [u8]> {
    let rest = &text[pos..];
    OPERATORS.iter().find(|op| rest.starts_with(op)).copied()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    End,
    Name,
    Num,
    Op,
    Pre,
    Post,
    Bad,
}

/// One evaluation: the host's variables, and the writes it has made, which
/// later reads in it see first. A variable's value and an indexed subscript
/// are expressions of their own, read in this same record one level deeper
/// (`x='y=5'; $((x))` leaves y at 5). A subscript in a value expands once
/// before it is used (`x='e[$i]'; $((x))`), as bash expands it.
struct Record<'v, 'd> {
    vars: &'v mut dyn Vars,
    nounset: bool,
    elements: bool,
    dynamic: &'d [String],
    updates: HashMap<String, Vec<u8>>,
    elem_updates: HashMap<(String, Vec<u8>), Vec<u8>>,
    writes: Vec<Write>,
    nest: usize,
}

impl Record<'_, '_> {
    fn dynamic(&self, name: &str) -> bool {
        self.dynamic.iter().any(|dynamic| dynamic == name)
    }

    fn evaluate(&mut self, text: &[u8], depth: usize, subscript: bool, stored: bool) -> Step<i64> {
        let start = text
            .iter()
            .position(|ch| !BLANKS.contains(ch))
            .unwrap_or(text.len());
        Reader {
            record: self,
            text: &text[start..],
            depth,
            subscript,
            stored,
            pos: 0,
            tok_start: 0,
            kind: Kind::End,
            tok: (0, 0),
            value: 0,
            skip: 0,
        }
        .run()
    }

    /// A variable's value as a number: its text read as an expression.
    fn coerce(&mut self, raw: Option<Vec<u8>>, depth: usize, subscript: bool) -> Step<i64> {
        let raw = raw.unwrap_or_default();
        match plain_decimal(&raw) {
            Some(value) => Ok(value),
            None => self.evaluate(&raw, depth + 1, subscript, true),
        }
    }

    /// The canonical element key a target names, None for a scalar;
    /// resolved once per reference, so `a[RANDOM]+=1` draws once. In a
    /// `stored` text the subscript expands first.
    fn key_of(&mut self, target: &[u8], depth: usize, stored: bool) -> Step<Option<Vec<u8>>> {
        let (name, inner) = split_target(target);
        let Some(inner) = inner else {
            return Ok(None);
        };
        if !self.elements {
            return Err(Box::new(Error::Arith {
                reason: "syntax error: operand expected".to_owned(),
                expression: target.to_vec(),
                token: Some(target[name.len()..].to_vec()),
                subscript: false,
            }));
        }
        let expanded;
        let inner = if stored && inner.iter().any(|ch| b"$`\\\"".contains(ch)) {
            expanded = self.expand(inner, depth).map_err(in_subscript)?;
            &expanded[..]
        } else {
            inner
        };
        if self.vars.assoc(name)? {
            return Ok(Some(self.vars.resolve(name, inner)?));
        }
        let index = match plain_decimal(inner) {
            Some(index) => index,
            None => self
                .evaluate(inner, depth + 1, true, false)
                .map_err(in_subscript)?,
        };
        Ok(Some(self.vars.resolve(name, index.to_string().as_bytes())?))
    }

    /// The value a target holds: a dynamic name's reader first, the
    /// pending writes next, then the host; an array's bare name reads
    /// element 0.
    fn read_target(
        &mut self,
        target: &[u8],
        key: Option<&[u8]>,
        depth: usize,
        subscript: bool,
    ) -> Step<i64> {
        let name = split_target(target).0;
        if let Some(key) = key {
            let pending = self
                .elem_updates
                .get(&(name.to_owned(), key.to_vec()))
                .cloned();
            let raw = match pending {
                Some(raw) => Some(raw),
                None => self.vars.element(name, key)?,
            };
            return self.coerce(raw, depth, subscript);
        }
        let value = self.text_of(name)?;
        self.coerce(value, depth, subscript)
    }

    /// The text a bare name holds: a dynamic name's reader first, the
    /// pending writes next, then the host.
    fn text_of(&mut self, name: &str) -> Step<Option<Vec<u8>>> {
        if self.dynamic(name) {
            if let Some(drawn) = self.vars.draw(name)? {
                return Ok(Some(drawn));
            }
        }
        if let Some(pending) = self.updates.get(name).cloned() {
            return Ok(Some(pending));
        }
        let value = self.vars.read(name)?;
        if value.is_none() && self.nounset && !(self.elements && self.vars.holds_array(name)?) {
            return Err(Box::new(Error::Unbound(name.to_owned())));
        }
        Ok(value)
    }

    /// A subscript expanded as bash expands one in a value, as if double
    /// quoted: `$name` and `${name}` substitute what the name holds,
    /// `$((...))` its value, a backslash quotes `$`, `` ` ``, `"` and
    /// itself, and a double quote is removed. A command substitution and
    /// every other parameter stay as typed, for the evaluator to refuse.
    fn expand(&mut self, text: &[u8], depth: usize) -> Step<Vec<u8>> {
        if depth >= MAX_DEPTH {
            return Err(Box::new(Error::Arith {
                reason: "expression recursion level exceeded".to_owned(),
                expression: text.to_vec(),
                token: Some(text.to_vec()),
                subscript: false,
            }));
        }
        let mut out = Vec::with_capacity(text.len());
        let mut i = 0;
        while i < text.len() {
            let ch = text[i];
            if ch == b'\\' && text.get(i + 1).is_some_and(|next| b"$`\"\\".contains(next)) {
                out.push(text[i + 1]);
                i += 2;
                continue;
            }
            if ch == b'"' {
                i += 1;
                continue;
            }
            if ch != b'$' {
                out.push(ch);
                i += 1;
                continue;
            }
            if text[i..].starts_with(b"$((") {
                if let Some(close) = arith_close(text, i + 3) {
                    let inner = self.expand(&text[i + 3..close], depth + 1)?;
                    let value = self.evaluate(&inner, depth + 1, true, false)?;
                    out.extend_from_slice(value.to_string().as_bytes());
                    i = close + 2;
                    continue;
                }
            }
            let braced = text.get(i + 1) == Some(&b'{');
            let start = i + 1 + usize::from(braced);
            let end = name_end(text, start).filter(|&end| !braced || text.get(end) == Some(&b'}'));
            let Some(end) = end else {
                out.push(ch);
                i += 1;
                continue;
            };
            let name = std::str::from_utf8(&text[start..end]).unwrap_or_default();
            out.extend(self.text_of(name)?.unwrap_or_default());
            i = end + usize::from(braced);
        }
        Ok(out)
    }

    /// Record a write, or refuse one to a readonly name.
    fn write_target(
        &mut self,
        target: &[u8],
        key: Option<Vec<u8>>,
        value: i64,
        subscript: bool,
    ) -> Step<()> {
        let name = split_target(target).0;
        if let Some(refused) = self.vars.frozen(name)? {
            return Err(Box::new(Error::Readonly {
                name: refused,
                subscript,
            }));
        }
        let text = value.to_string();
        self.writes.push(Write {
            name: name.to_owned(),
            key: key.clone(),
            value: text.clone(),
        });
        match key {
            Some(key) => {
                self.elem_updates
                    .insert((name.to_owned(), key), text.into_bytes());
            }
            None => {
                if self.dynamic(name) {
                    self.vars.wrote(name, &text)?;
                }
                self.updates.insert(name.to_owned(), text.into_bytes());
            }
        }
        Ok(())
    }
}

/// Reads one expression and evaluates it as it goes, as bash does. A token
/// is read only when the grammar needs it, and every value is computed the
/// moment its operands are, so an assignment before an error has already
/// been made (`x=7, 1+` leaves x at 7) and an error names the text from the
/// token the reader stood on (`tok_start`). Inside the branch `&&`, `||` or
/// `?:` skips (`skip`) nothing is read from a variable or written to one and
/// a zero divisor is no error, but the grammar is still checked, an integer
/// constant still judged and a negative exponent still refused.
struct Reader<'r, 'v, 'd, 't> {
    record: &'r mut Record<'v, 'd>,
    text: &'t [u8],
    depth: usize,
    subscript: bool,
    stored: bool,
    pos: usize,
    tok_start: usize,
    kind: Kind,
    tok: (usize, usize),
    value: i64,
    skip: usize,
}

impl<'t> Reader<'_, '_, '_, 't> {
    fn tok(&self) -> &'t [u8] {
        &self.text[self.tok.0..self.tok.1]
    }

    /// The error bash reports at the token the reader stands on, or at `at`.
    fn fail(&self, reason: &str, at: Option<usize>) -> Box<Error> {
        let start = at.unwrap_or(self.tok_start);
        Box::new(Error::Arith {
            reason: reason.to_owned(),
            expression: self.text.to_vec(),
            token: Some(self.text[start..].to_vec()),
            subscript: false,
        })
    }

    fn set(&mut self, end: usize, kind: Kind, start: usize) {
        self.pos = end;
        self.kind = kind;
        self.tok = (start, end);
    }

    /// Read the next token. `++` and `--` after a name are its postfix
    /// operators, before a name (blanks between allowed) its prefix ones,
    /// and anywhere else two signs (`1++2` is `1 + +2`). A name joined to a
    /// `[` takes its subscript along unread. At the end the reader stays on
    /// the last token, which an error then names. A byte that starts no
    /// token is one of its own; an error names the text from it on, so its
    /// width never shows.
    fn advance(&mut self) -> Step<()> {
        let text = self.text;
        let mut pos = self.pos;
        while pos < text.len() && BLANKS.contains(&text[pos]) {
            pos += 1;
        }
        let after_name = self.kind == Kind::Name;
        if pos >= text.len() {
            self.set(pos, Kind::End, pos);
            return Ok(());
        }
        self.tok_start = pos;
        if let Some(mut end) = name_end(text, pos) {
            if text.get(end) == Some(&b'[') {
                let Some(close) = matching_bracket(text, end) else {
                    return Err(self.fail("bad array subscript", None));
                };
                end = close + 1;
            }
            self.set(end, Kind::Name, pos);
            return Ok(());
        }
        if let Some(end) = literal_end(text, pos) {
            let literal = &text[pos..end];
            match constant(literal) {
                Ok(value) => self.value = value,
                Err(reason) => {
                    return Err(Box::new(Error::Arith {
                        reason: reason.to_owned(),
                        expression: text[..end].to_vec(),
                        token: Some(literal.to_vec()),
                        subscript: false,
                    }));
                }
            }
            self.set(end, Kind::Num, pos);
            return Ok(());
        }
        let Some(op) = operator_at(text, pos) else {
            self.set(pos + 1, Kind::Bad, pos);
            return Ok(());
        };
        let mut len = op.len();
        if op == b"++" || op == b"--" {
            if after_name {
                self.set(pos + 2, Kind::Post, pos);
                return Ok(());
            }
            let mut ahead = pos + 2;
            while ahead < text.len() && BLANKS.contains(&text[ahead]) {
                ahead += 1;
            }
            if name_end(text, ahead).is_some() {
                self.set(pos + 2, Kind::Pre, pos);
                return Ok(());
            }
            len = 1;
        }
        self.set(pos + len, Kind::Op, pos);
        Ok(())
    }

    fn at(&self, op: &[u8]) -> bool {
        self.kind == Kind::Op && self.tok() == op
    }

    fn at_assign(&self) -> bool {
        self.kind == Kind::Op && ASSIGN_OPS.contains(&self.tok())
    }

    /// The error for a token where an operator or closer belongs.
    fn stray(&self, reason: &str) -> Box<Error> {
        if self.kind == Kind::Bad {
            return self.fail("syntax error: invalid arithmetic operator", None);
        }
        self.fail(reason, None)
    }

    /// Enter one more nested operator, or stop past `MAX_NEST`, naming the
    /// whole expression as bash names a recursion it gave up on.
    fn nest(&mut self) -> Step<()> {
        if self.record.nest >= MAX_NEST {
            return Err(Box::new(Error::Arith {
                reason: "expression recursion level exceeded".to_owned(),
                expression: self.text.to_vec(),
                token: Some(self.text.to_vec()),
                subscript: false,
            }));
        }
        self.record.nest += 1;
        Ok(())
    }

    fn run(mut self) -> Step<i64> {
        self.advance()?;
        if self.kind == Kind::End {
            return Ok(0);
        }
        let value = self.comma()?;
        if self.kind != Kind::End {
            return Err(self.stray("syntax error in expression"));
        }
        Ok(value)
    }

    fn comma(&mut self) -> Step<i64> {
        let mut value = self.assign()?;
        while self.at(b",") {
            self.advance()?;
            value = self.assign()?;
        }
        Ok(value)
    }

    fn assign(&mut self) -> Step<i64> {
        self.nest()?;
        let value = self.assign_nested();
        self.record.nest -= 1;
        value
    }

    fn assign_nested(&mut self) -> Step<i64> {
        if self.kind == Kind::Name {
            let saved = (self.pos, self.tok_start, self.kind, self.tok);
            let target = self.tok();
            let at = self.tok_start;
            self.advance()?;
            if self.at_assign() {
                return self.assignment(target, at);
            }
            (self.pos, self.tok_start, self.kind, self.tok) = saved;
        }
        let value = self.ternary()?;
        if self.at_assign() {
            return Err(self.fail("attempted assignment to non-variable", None));
        }
        Ok(value)
    }

    /// An assignment to `target`, the reader on its operator. bash
    /// evaluates a plain assignment's right side before it resolves the
    /// target's subscript (`x=0, a[x++]=x++` stores 0 at index 1), and a
    /// compound one reads its target before the right side. In a skipped
    /// branch nothing is read or written, but a compound one still computes
    /// over 0, so its value can refuse a negative exponent
    /// (`1 || 2**(x-=1)`).
    fn assignment(&mut self, target: &[u8], at: usize) -> Step<i64> {
        let op = self.tok();
        let binary = &op[..op.len() - 1];
        self.advance()?;
        let divisor = self.tok_start;
        let (key, value) = if op == b"=" {
            let value = self.assign()?;
            if self.skip > 0 {
                return Ok(value);
            }
            (self.record.key_of(target, self.depth, self.stored)?, value)
        } else if self.skip > 0 {
            let right = self.assign()?;
            return self.apply(binary, 0, right, divisor);
        } else {
            let (key, current) = self.lookup(target, at)?;
            let right = self.assign()?;
            (key, self.apply(binary, current, right, divisor)?)
        };
        self.record
            .write_target(target, key, value, self.subscript)?;
        Ok(value)
    }

    fn ternary(&mut self) -> Step<i64> {
        let cond = self.binary(1)?;
        if !self.at(b"?") {
            return Ok(cond);
        }
        self.advance()?;
        if self.kind == Kind::End || self.at(b":") {
            return Err(self.fail("expression expected", None));
        }
        let taken = cond != 0;
        self.skip += usize::from(!taken);
        let then = self.comma()?;
        self.skip -= usize::from(!taken);
        if !self.at(b":") {
            return Err(self.stray("`:' expected for conditional expression"));
        }
        self.advance()?;
        if self.kind == Kind::End {
            return Err(self.fail("expression expected", None));
        }
        self.skip += usize::from(taken);
        self.nest()?;
        let other = self.ternary();
        self.record.nest -= 1;
        self.skip -= usize::from(taken);
        let other = other?;
        Ok(if taken { then } else { other })
    }

    /// Binary operators binding at least as tightly as `floor`.
    fn binary(&mut self, floor: usize) -> Step<i64> {
        let mut left = self.unary()?;
        while self.kind == Kind::Op {
            let op = self.tok();
            let precedence = precedence(op);
            if precedence < floor {
                break;
            }
            self.advance()?;
            let divisor = self.tok_start;
            if op == b"&&" || op == b"||" {
                let and = op == b"&&";
                let skipped = (left == 0) == and;
                self.skip += usize::from(skipped);
                let right = self.binary(precedence + 1)?;
                self.skip -= usize::from(skipped);
                let truth = if and {
                    left != 0 && right != 0
                } else {
                    left != 0 || right != 0
                };
                left = i64::from(truth);
                continue;
            }
            // `**` binds right to left, so its right side recurses once per
            // operator, which a variable's text can repeat without bound.
            let right = if op == b"**" {
                self.nest()?;
                let right = self.binary(precedence);
                self.record.nest -= 1;
                right?
            } else {
                self.binary(precedence + 1)?
            };
            left = self.apply(op, left, right, divisor)?;
        }
        Ok(left)
    }

    /// One binary operator over 64-bit wrapping integers; division
    /// truncates toward zero and `%` takes the dividend's sign, as in C.
    /// `divisor` is where the right operand starts, which a division by 0
    /// names.
    fn apply(&self, op: &[u8], a: i64, b: i64, divisor: usize) -> Step<i64> {
        Ok(match op {
            b"/" | b"%" if b == 0 => {
                if self.skip > 0 {
                    return Ok(0);
                }
                return Err(self.fail("division by 0", Some(divisor)));
            }
            b"/" => a.wrapping_div(b),
            b"%" => a.wrapping_rem(b),
            b"**" => {
                if b < 0 {
                    return Err(self.fail("exponent less than 0", None));
                }
                power(a, b)
            }
            b"+" => a.wrapping_add(b),
            b"-" => a.wrapping_sub(b),
            b"*" => a.wrapping_mul(b),
            b"<<" => a.wrapping_shl((b & 63) as u32),
            b">>" => a >> (b & 63),
            b"&" => a & b,
            b"|" => a | b,
            b"^" => a ^ b,
            b"==" => i64::from(a == b),
            b"!=" => i64::from(a != b),
            b"<" => i64::from(a < b),
            b"<=" => i64::from(a <= b),
            b">" => i64::from(a > b),
            _ => i64::from(a >= b),
        })
    }

    fn unary(&mut self) -> Step<i64> {
        self.nest()?;
        let value = self.unary_nested();
        self.record.nest -= 1;
        value
    }

    fn unary_nested(&mut self) -> Step<i64> {
        if self.kind == Kind::Op && matches!(self.tok(), b"!" | b"~" | b"-" | b"+") {
            let op = self.tok();
            self.advance()?;
            let value = self.unary()?;
            return Ok(match op {
                b"!" => i64::from(value == 0),
                b"~" => !value,
                b"-" => value.wrapping_neg(),
                _ => value,
            });
        }
        if self.kind == Kind::Pre {
            let step = if self.tok() == b"++" { 1 } else { -1 };
            self.advance()?;
            let target = self.tok();
            let at = self.tok_start;
            self.advance()?;
            let value = self.step(target, step, true, at)?;
            if self.kind == Kind::Post {
                let op = if self.tok() == b"++" { "++" } else { "--" };
                return Err(self.fail(&format!("{op}: assignment requires lvalue"), None));
            }
            return Ok(value);
        }
        self.primary()
    }

    /// `++` or `--` on `target`: the new value before it, the old one after
    /// it. bash makes the write once it has read the token after the
    /// operand: a prefix one after the token past the name (`++x 08`
    /// refuses the constant and leaves x), a postfix one before the token
    /// past the operator (`x++ 08` leaves x stepped). In a skipped branch
    /// it computes over 0 without reading or writing.
    fn step(&mut self, target: &[u8], step: i64, prefix: bool, at: usize) -> Step<i64> {
        if self.skip > 0 {
            return Ok(if prefix { step } else { 0 });
        }
        let (key, value) = self.lookup(target, at)?;
        let stepped = value.wrapping_add(step);
        self.record
            .write_target(target, key, stepped, self.subscript)?;
        Ok(if prefix { stepped } else { value })
    }

    /// The element key `target` names and the value it holds. A variable
    /// read from an expression `MAX_DEPTH` values deep is past the recursion
    /// limit, which names this expression and the reference (`x='(x)'` is
    /// `(x): expression recursion level exceeded (error token is "x)")`).
    fn lookup(&mut self, target: &[u8], at: usize) -> Step<(Option<Vec<u8>>, i64)> {
        if self.depth >= MAX_DEPTH {
            return Err(self.fail("expression recursion level exceeded", Some(at)));
        }
        let key = self.record.key_of(target, self.depth, self.stored)?;
        let value = self
            .record
            .read_target(target, key.as_deref(), self.depth, self.subscript)?;
        Ok((key, value))
    }

    fn primary(&mut self) -> Step<i64> {
        if self.at(b"(") {
            self.advance()?;
            let value = self.comma()?;
            if !self.at(b")") {
                return Err(self.stray("missing `)'"));
            }
            self.advance()?;
            return Ok(value);
        }
        if self.kind == Kind::Num {
            let value = self.value;
            self.advance()?;
            return Ok(value);
        }
        if self.kind == Kind::Name {
            let target = self.tok();
            let at = self.tok_start;
            self.advance()?;
            if self.kind == Kind::Post {
                let step = if self.tok() == b"++" { 1 } else { -1 };
                let value = self.step(target, step, false, at)?;
                self.advance()?;
                return Ok(value);
            }
            // A name before `=` here is a target the assignment level
            // refuses (`1+x=2`), and bash reads nothing of it.
            if self.skip > 0 || self.at(b"=") {
                return Ok(0);
            }
            return Ok(self.lookup(target, at)?.1);
        }
        Err(self.fail("syntax error: operand expected", None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Session {
        scalars: HashMap<String, String>,
        arrays: HashMap<String, HashMap<String, String>>,
        readonly: Vec<String>,
    }

    fn bytes(text: Option<&String>) -> Option<Vec<u8>> {
        text.map(|text| text.clone().into_bytes())
    }

    impl Vars for Session {
        fn draw(&mut self, _: &str) -> Result<Option<Vec<u8>>, Halt> {
            Ok(Some(b"7".to_vec()))
        }
        fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, Halt> {
            let element = self.arrays.get(name).and_then(|array| array.get("0"));
            Ok(bytes(self.scalars.get(name).or(element)))
        }
        fn holds_array(&mut self, name: &str) -> Result<bool, Halt> {
            Ok(self.arrays.contains_key(name))
        }
        fn assoc(&mut self, _: &str) -> Result<bool, Halt> {
            Ok(false)
        }
        fn resolve(&mut self, name: &str, subscript: &[u8]) -> Result<Vec<u8>, Halt> {
            if subscript.starts_with(b"-") && name == "halts" {
                return Err(Halt);
            }
            Ok(subscript.to_vec())
        }
        fn element(&mut self, name: &str, key: &[u8]) -> Result<Option<Vec<u8>>, Halt> {
            let key = String::from_utf8_lossy(key);
            Ok(bytes(
                self.arrays
                    .get(name)
                    .and_then(|array| array.get(key.as_ref())),
            ))
        }
        fn frozen(&mut self, name: &str) -> Result<Option<String>, Halt> {
            Ok(self.readonly.iter().find(|held| *held == name).cloned())
        }
        fn wrote(&mut self, name: &str, value: &str) -> Result<(), Halt> {
            self.scalars
                .insert(format!("wrote {name}"), value.to_owned());
            Ok(())
        }
    }

    fn run(expression: &[u8], session: &mut Session) -> Outcome {
        let request = Request {
            expression,
            added: None,
            nounset: false,
            elements: true,
            dynamic: &["D".to_owned()],
            expand: false,
        };
        evaluate(&request, session)
    }

    fn value(expression: &str) -> i64 {
        match run(expression.as_bytes(), &mut Session::default()).value {
            Ok(value) => value,
            Err(_) => panic!("{expression} failed"),
        }
    }

    fn line(expression: &[u8], session: &mut Session) -> Vec<u8> {
        match run(expression, session).value {
            Err(Error::Arith {
                reason,
                expression,
                token,
                ..
            }) => {
                let mut line = expression;
                line.extend_from_slice(b": ");
                line.extend_from_slice(reason.as_bytes());
                if let Some(token) = token {
                    line.extend_from_slice(b" (error token is \"");
                    line.extend_from_slice(&token);
                    line.extend_from_slice(b"\")");
                }
                line
            }
            _ => panic!("{} did not fail", String::from_utf8_lossy(expression)),
        }
    }

    #[test]
    fn operators_bind_and_wrap_as_bash_reads_them() {
        assert_eq!(value("1 + 2 * 3"), 7);
        assert_eq!(value("2 ** 3 ** 2"), 512);
        assert_eq!(value("7 / -2"), -3);
        assert_eq!(value("7 % -2"), 1);
        assert_eq!(value("-16 >> 2"), -4);
        assert_eq!(value("(1 << 63) - 1 + 1"), i64::MIN);
        assert_eq!(value("3 ** 41"), -420491770248316829);
        assert_eq!(value("-2**2"), 4);
        assert_eq!(value("1++2"), 3);
        assert_eq!(value("64#_ + 0x10 + 010 + 2#101"), 63 + 16 + 8 + 5);
        assert_eq!(value("0 ? 1/0 : 2"), 2);
    }

    #[test]
    fn an_error_names_the_expression_and_token_bash_names() {
        let mut session = Session::default();
        let cases: [(&[u8], &[u8]); 6] = [
            (
                b"1+",
                b"1+: syntax error: operand expected (error token is \"+\")",
            ),
            (
                b"09+1",
                b"09: value too great for base (error token is \"09\")",
            ),
            (
                "1 é".as_bytes(),
                "1 é: syntax error: invalid arithmetic operator (error token is \"é\")".as_bytes(),
            ),
            (
                b"\xff+1",
                b"\xff+1: syntax error: operand expected (error token is \"\xff+1\")",
            ),
            (b"x[1", b"x[1: bad array subscript (error token is \"x[1\")"),
            (
                b"1 ? : 3",
                b"1 ? : 3: expression expected (error token is \": 3\")",
            ),
        ];
        for (expression, expected) in cases {
            assert_eq!(line(expression, &mut session), expected);
        }
        session.scalars.insert("x".to_owned(), "y".to_owned());
        session.scalars.insert("y".to_owned(), "x".to_owned());
        assert_eq!(
            line(b"x", &mut session),
            b"y: expression recursion level exceeded (error token is \"y\")"
        );
    }

    #[test]
    fn writes_come_back_in_order_and_later_reads_see_them() {
        let mut session = Session::default();
        session.scalars.insert("x".to_owned(), "y=5".to_owned());
        let outcome = run(b"x, y + 1, a[y]=2, a[5]++", &mut session);
        assert_eq!(outcome.value.ok(), Some(2));
        let writes: Vec<_> = outcome
            .writes
            .iter()
            .map(|write| {
                (
                    write.name.as_str(),
                    write.key.as_deref(),
                    write.value.as_str(),
                )
            })
            .collect();
        let five: &[u8] = b"5";
        assert_eq!(
            writes,
            [
                ("y", None, "5"),
                ("a", Some(five), "2"),
                ("a", Some(five), "3")
            ]
        );
    }

    #[test]
    fn a_subscript_in_a_value_expands_once() {
        let mut session = Session::default();
        let e = [("0", "5"), ("1", "6"), ("2", "7")];
        let e = e.map(|(k, v)| (k.to_owned(), v.to_owned()));
        session.arrays.insert("e".to_owned(), e.into());
        for (name, value) in [
            ("i", "2"),
            ("v", "$i"),
            ("x", "e[$i]"),
            ("y", "e[ \"${i}\" - $((i-1)) ]"),
            ("z", "e[$v]"),
        ] {
            session.scalars.insert(name.to_owned(), value.to_owned());
        }
        assert_eq!(run(b"x", &mut session).value.ok(), Some(7));
        assert_eq!(run(b"(i=0) + x", &mut session).value.ok(), Some(5));
        assert_eq!(run(b"y", &mut session).value.ok(), Some(6));
        assert_eq!(
            line(b"z", &mut session),
            b"$i: syntax error: operand expected (error token is \"$i\")"
        );
        assert_eq!(
            line(b"e[$i]", &mut session),
            b"$i: syntax error: operand expected (error token is \"$i\")"
        );
        let deep = format!("e[{}1{}]", "$((".repeat(100_000), "))".repeat(100_000));
        session.scalars.insert("d".to_owned(), deep);
        let error = line(b"d", &mut session);
        let reason = b": expression recursion level exceeded (error token is";
        assert!(error.windows(reason.len()).any(|w| w == reason));
    }

    #[test]
    fn a_dynamic_name_draws_and_hears_its_assignment() {
        let mut session = Session::default();
        let outcome = run(b"D=4, D + x", &mut session);
        assert_eq!(outcome.value.ok(), Some(7));
        assert_eq!(
            session.scalars.get("wrote D").map(String::as_str),
            Some("4")
        );
        assert!(!session.scalars.contains_key("wrote x"));
    }

    #[test]
    fn a_readonly_write_stops_after_the_writes_before_it() {
        let mut session = Session::default();
        session.readonly.push("R".to_owned());
        let outcome = run(b"X=5, R=3, X=6", &mut session);
        assert!(matches!(
            outcome.value,
            Err(Error::Readonly { ref name, subscript: false }) if name == "R"
        ));
        assert_eq!(outcome.writes.len(), 1);
    }

    #[test]
    fn a_host_refusal_inside_a_subscript_says_so() {
        let outcome = run(b"b[halts[-1]]", &mut Session::default());
        assert!(matches!(
            outcome.value,
            Err(Error::Halt { subscript: true })
        ));
    }

    #[test]
    fn deep_nesting_stops_with_bash_s_recursion_error() {
        let deep = format!("{}1{}", "(".repeat(5000), ")".repeat(5000));
        let outcome = run(deep.as_bytes(), &mut Session::default());
        assert!(matches!(
            outcome.value,
            Err(Error::Arith { ref reason, .. }) if reason == "expression recursion level exceeded"
        ));
        assert_eq!(
            value(&format!("{}1{}", "(".repeat(250), ")".repeat(250))),
            1
        );
    }

    #[test]
    fn long_power_and_conditional_chains_stop_with_the_recursion_error() {
        let power = format!("1{}", "**1".repeat(100_000));
        let ternary = format!("{}0", "0?1:".repeat(100_000));
        for chain in [power, ternary] {
            let outcome = run(chain.as_bytes(), &mut Session::default());
            assert!(matches!(
                outcome.value,
                Err(Error::Arith { ref reason, .. }) if reason == "expression recursion level exceeded"
            ));
        }
        assert_eq!(value(&format!("2{}", "**1".repeat(200))), 2);
        assert_eq!(value(&format!("{}7", "0?1:".repeat(200))), 7);
        // The arm not taken still parses: bash refuses a broken one.
        let broken = run(b"1?2:3+", &mut Session::default());
        assert!(matches!(
            broken.value,
            Err(Error::Arith { ref reason, .. }) if reason == "syntax error: operand expected"
        ));
    }

    #[test]
    fn a_plain_decimal_is_read_without_evaluating() {
        assert_eq!(plain_decimal(b" 42\t"), Some(42));
        assert_eq!(plain_decimal(b"042"), None);
        assert_eq!(plain_decimal(b" "), None);
        assert_eq!(
            plain_decimal(b"99999999999999999999999"),
            Some(200376420520689663)
        );
    }
}
