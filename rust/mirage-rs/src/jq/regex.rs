// Adapted from jq 1.8.2 (MIT), src/builtin.c. See licenses/third_party/jq.txt.

use std::sync::Arc;

use super::builtin::{Fault, array_limit, type_error};
use super::onig::{Options, Regex, Region, Search};
use super::value::{Object, Value};
use super::vm::Limits;
use crate::regex::Step;

/// For a regex builtin called with a literal pattern (and literal or no
/// modifiers), the reason this matcher cannot run it, if it cannot: the
/// compiler then refuses the program, which the host runs on libjq.
/// Patterns jq itself rejects are left to fail at run time as jq's do.
pub(crate) fn unsupported(pattern: &str, modifiers: Option<&str>) -> Option<String> {
    let mut options = Options::default();
    for letter in modifiers.unwrap_or("").chars() {
        match letter {
            'i' => options.ignore_case = true,
            'x' => options.extend = true,
            'm' | 's' | 'p' => options.dotall |= letter != 's',
            'l' => options.longest = true,
            'n' => options.not_empty = true,
            'g' => {}
            _ => return None,
        }
    }
    match Regex::new(pattern, options) {
        Err(message)
            if message.ends_with(" is not supported") || message == "parse depth limit over" =>
        {
            Some(message)
        }
        _ => None,
    }
}

/// One `_match_impl` call in progress: jq's f_match, whose search can stop
/// when the step budget runs out and go on at the next drain.
pub(crate) struct Matching {
    regex: Regex,
    input: Arc<str>,
    test: bool,
    global: bool,
    search: Search,
    found: Vec<Value>,
    names: Vec<Value>,
    chars: Chars,
}

/// Counts characters up to a byte offset as jq's offsets do, going on
/// from the last offset asked about.
#[derive(Default)]
struct Chars {
    at: usize,
    count: usize,
}

impl Chars {
    /// How many characters start before `pos`.
    fn before(&mut self, text: &[u8], pos: usize) -> usize {
        while self.at > pos {
            self.at -= 1;
            while self.at > 0 && !starts_char(text, self.at) {
                self.at -= 1;
            }
            self.count -= 1;
        }
        while self.at < text.len() {
            let len = char_len(text[self.at]);
            if self.at + len > pos {
                break;
            }
            self.at += len;
            self.count += 1;
        }
        self.count + usize::from(pos > self.at)
    }

    /// The offset and length jq reports for `text[start..end]`: counted in
    /// characters, from the start of the subject when `start` falls inside
    /// one.
    fn span(&mut self, text: &[u8], start: usize, end: usize) -> (usize, usize) {
        if starts_char(text, start) {
            let before_start = self.before(text, start);
            let before_end = self.before(text, end);
            (before_start, before_end.saturating_sub(before_start))
        } else {
            (0, self.before(text, end))
        }
    }
}

fn char_len(lead: u8) -> usize {
    match lead {
        0xF0..=0xFF => 4,
        0xE0..=0xEF => 3,
        0xC0..=0xDF => 2,
        _ => 1,
    }
}

fn starts_char(text: &[u8], pos: usize) -> bool {
    text.get(pos).is_none_or(|b| !(0x80..0xC0).contains(b))
}

fn key(name: &str) -> Arc<str> {
    Arc::from(name)
}

fn number(n: usize) -> Value {
    Value::number(n as f64)
}

impl Matching {
    /// Checks the operands as f_match does and compiles the pattern.
    pub(crate) fn begin(args: &[Value]) -> Result<Matching, Fault> {
        let input = &args[0];
        let regex = &args[1];
        let modifiers = &args[2];
        let test = matches!(args[3], Value::True);
        let Value::String(text) = input else {
            return Err(type_error(
                input,
                "cannot be matched, as it is not a string",
            ));
        };
        let Value::String(pattern) = regex else {
            return Err(type_error(regex, "is not a string"));
        };
        let mut options = Options::default();
        let mut global = false;
        match modifiers {
            Value::String(letters) => {
                for letter in letters.chars() {
                    match letter {
                        'g' => global = true,
                        'i' => options.ignore_case = true,
                        'x' => options.extend = true,
                        'm' | 's' | 'p' => options.dotall |= letter != 's',
                        'l' => options.longest = true,
                        'n' => options.not_empty = true,
                        _ => {
                            return Err(Fault::Error(Value::string(format!(
                                "{letters} is not a valid modifier string"
                            ))));
                        }
                    }
                }
            }
            Value::Null => {}
            _ => return Err(type_error(modifiers, "is not a string")),
        }
        let regex = Regex::new(pattern, options)
            .map_err(|message| Fault::Error(Value::string(format!("Regex failure: {message}"))))?;
        let mut names = vec![Value::Null; regex.groups()];
        for (name, groups) in regex.names() {
            let name = Value::string(name.as_str());
            for &group in groups {
                names[group - 1] = name.clone();
            }
        }
        Ok(Matching {
            regex,
            input: Arc::clone(text),
            test,
            global,
            search: Search::new(0),
            found: Vec::new(),
            names,
            chars: Chars::default(),
        })
    }

    /// Searches on, spending `budget`: None when it ran out before the
    /// answer.
    pub(crate) fn run(&mut self, budget: &mut u64, limits: Limits) -> Option<Result<Value, Fault>> {
        let input = Arc::clone(&self.input);
        let text = input.as_bytes();
        if *budget == 0 {
            *budget = 1;
        }
        loop {
            let region = match self.search.run(&self.regex, text, budget) {
                Step::Paused => return None,
                Step::Done(Err(message)) => {
                    return Some(Err(Fault::Error(Value::string(format!(
                        "Regex failure: {message}"
                    )))));
                }
                Step::Done(Ok(None)) => break,
                Step::Done(Ok(Some(region))) => region,
            };
            if self.test {
                return Some(Ok(Value::True));
            }
            let Some((start, end)) = region[0] else {
                unreachable!("a match spans its subject")
            };
            let (value, next) = if start == end {
                (self.empty_match(text, &region, start), end + 1)
            } else {
                (self.match_value(text, &region, start, end), end)
            };
            self.found.push(value);
            if self.found.len() > limits.items {
                return Some(array_limit(std::mem::take(&mut self.found), limits));
            }
            if !self.global || next > text.len() {
                break;
            }
            self.search.restart(next);
        }
        Some(Ok(if self.test {
            Value::False
        } else {
            Value::array(std::mem::take(&mut self.found))
        }))
    }

    /// A match of no characters: every group it set reports where the
    /// match is.
    fn empty_match(&mut self, text: &[u8], region: &Region, at: usize) -> Value {
        let offset = self.chars.before(text, at);
        let mut object = Object::default();
        object.insert(key("offset"), number(offset));
        object.insert(key("length"), number(0));
        object.insert(key("string"), Value::string(""));
        let captures = region[1..]
            .iter()
            .zip(&self.names)
            .map(|(span, name)| {
                let mut cap = Object::default();
                match span {
                    None => {
                        cap.insert(key("offset"), Value::number(-1.0));
                        cap.insert(key("string"), Value::Null);
                    }
                    Some(_) => {
                        cap.insert(key("offset"), number(offset));
                        cap.insert(key("string"), Value::string(""));
                    }
                }
                cap.insert(key("length"), number(0));
                cap.insert(key("name"), name.clone());
                Value::object(cap)
            })
            .collect();
        object.insert(key("captures"), Value::array(captures));
        Value::object(object)
    }

    fn match_value(&mut self, text: &[u8], region: &Region, start: usize, end: usize) -> Value {
        let mut object = Object::default();
        let (offset, length) = self.chars.span(text, start, end);
        object.insert(key("offset"), number(offset));
        object.insert(key("length"), number(length));
        object.insert(
            key("string"),
            Value::string(String::from_utf8_lossy(&text[start..end])),
        );
        let mut captures = Vec::with_capacity(region.len() - 1);
        for (span, name) in region[1..].iter().zip(&self.names) {
            let mut cap = Object::default();
            match *span {
                None => {
                    cap.insert(key("offset"), Value::number(-1.0));
                    cap.insert(key("string"), Value::Null);
                    cap.insert(key("length"), number(0));
                }
                Some((from, to)) if from == to => {
                    let offset = self.chars.before(text, from);
                    cap.insert(key("offset"), number(offset));
                    cap.insert(key("string"), Value::string(""));
                    cap.insert(key("length"), number(0));
                }
                Some((from, to)) => {
                    let (offset, length) = self.chars.span(text, from, to);
                    cap.insert(key("offset"), number(offset));
                    cap.insert(key("length"), number(length));
                    cap.insert(
                        key("string"),
                        Value::string(String::from_utf8_lossy(&text[from..to.max(from)])),
                    );
                }
            }
            cap.insert(key("name"), name.clone());
            captures.push(Value::object(cap));
        }
        object.insert(key("captures"), Value::array(captures));
        Value::object(object)
    }
}
