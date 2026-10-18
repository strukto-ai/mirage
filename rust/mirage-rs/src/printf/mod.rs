mod number;
mod scan;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};
use number::Rendered;
use scan::{NumberScan, NumberValue};

const STEP: usize = 16 * 1024;

#[derive(Default)]
struct Input {
    pages: BTreeMap<usize, Vec<u8>>,
    len: usize,
}

impl Input {
    fn push(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let n = bytes.len().min(STEP - self.len % STEP);
            if self.len % STEP == 0 {
                self.pages.insert(self.len / STEP, Vec::with_capacity(n));
            }
            self.pages
                .get_mut(&(self.len / STEP))
                .expect("input page")
                .extend_from_slice(&bytes[..n]);
            self.len += n;
            bytes = &bytes[n..];
        }
    }

    fn get(&self, at: usize) -> Option<u8> {
        (at < self.len).then(|| self.pages[&(at / STEP)][at % STEP])
    }

    fn copy(&self, at: usize, n: usize, out: &mut Vec<u8>) -> usize {
        let n = n.min(self.len - at).min(STEP - at % STEP);
        if n != 0 {
            out.extend_from_slice(&self.pages[&(at / STEP)][at % STEP..at % STEP + n]);
        }
        n
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Builtin,
    Program,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    mode: Mode,
    #[serde(default)]
    posix: bool,
    argument_count: usize,
    #[serde(default)]
    utf8: bool,
}

#[derive(Clone, Copy, Default)]
enum Field {
    #[default]
    Absent,
    Count(u64),
    Argument,
}

#[derive(Default)]
struct Spec {
    flags: Vec<u8>,
    width: Field,
    precision: Field,
    kind: u8,
}

impl Spec {
    fn flag(&self, flag: u8) -> bool {
        self.flags.contains(&flag)
    }
    fn width(&self) -> u64 {
        if let Field::Count(n) = self.width {
            n
        } else {
            0
        }
    }
    fn precision(&self) -> Option<u64> {
        if let Field::Count(n) = self.precision {
            Some(n)
        } else {
            None
        }
    }
}

enum ParseField {
    Flags,
    Width,
    Dot,
    Precision,
    Kind,
}
struct Parse {
    start: usize,
    spec: Spec,
    field: ParseField,
}

#[derive(Clone, Copy)]
enum Target {
    Width,
    Precision,
    Value,
}

enum End {
    Complete,
    FormatEscape,
    ArgumentEscape,
    Refusal,
}

enum Work {
    Loading,
    Format,
    Parse(Parse),
    Evaluate(Spec),
    Number {
        spec: Spec,
        target: Target,
        raw: Arc<Input>,
        scan: NumberScan,
    },
    Text {
        spec: Spec,
        raw: Arc<Input>,
        at: usize,
        expanded_len: u64,
        ansi: bool,
        plain_len: u64,
        ansi_len: u64,
    },
    End(End),
}

#[derive(Clone, Copy, PartialEq)]
enum QuoteStyle {
    Shell,
    Ansi,
    Diagnostic,
}

enum Segment {
    Escapes {
        input: Arc<Input>,
        at: usize,
        end: usize,
        left: u64,
        pending: VecDeque<u8>,
    },
    Bytes(VecDeque<u8>),
    Raw {
        input: Arc<Input>,
        at: usize,
        end: usize,
    },
    Repeat {
        byte: u8,
        left: u64,
    },
    Quote {
        input: Arc<Input>,
        at: usize,
        style: QuoteStyle,
    },
}

impl Segment {
    fn bytes(bytes: impl Into<Vec<u8>>) -> Self {
        Self::Bytes(bytes.into().into())
    }
    fn raw(input: Arc<Input>) -> Self {
        let end = input.len;
        Self::Raw { input, at: 0, end }
    }
    fn emit(&mut self, out: &mut Vec<u8>, budget: usize) -> (bool, usize) {
        let before = out.len();
        let mut scanned = 0;
        let done = match self {
            Self::Escapes {
                input,
                at,
                end,
                left,
                pending,
            } => {
                if pending.is_empty() && *left != 0 && *at < *end {
                    let start = *at;
                    let bytes = if input.get(*at) == Some(b'\\') {
                        let (bytes, next, _, _) = escape(input, *at, true);
                        *at = next;
                        bytes
                    } else {
                        let byte = input.get(*at).expect("escape byte");
                        *at += 1;
                        vec![byte]
                    };
                    scanned = *at - start;
                    pending.extend(bytes.into_iter().take((*left).min(6) as usize));
                }
                let n = budget.min(pending.len());
                out.extend(pending.drain(..n));
                *left -= n as u64;
                *left == 0 || (*at == *end && pending.is_empty())
            }
            Self::Bytes(bytes) => {
                let n = budget.min(bytes.len());
                out.extend(bytes.drain(..n));
                bytes.is_empty()
            }
            Self::Raw { input, at, end } => {
                *at += input.copy(*at, budget.min(*end - *at), out);
                *at == *end
            }
            Self::Repeat { byte, left } => {
                let n = (*left).min(budget as u64) as usize;
                out.resize(out.len() + n, *byte);
                *left -= n as u64;
                *left == 0
            }
            Self::Quote { input, at, style } => {
                let mut used = 0;
                while *at < input.len && used + 4 <= budget {
                    let byte = input.get(*at).expect("quote byte");
                    let before = out.len();
                    quote_byte(byte, *at, *style, out);
                    *at += 1;
                    used += out.len() - before;
                }
                *at == input.len
            }
        };
        (done, (out.len() - before).max(scanned).max(1))
    }
}

struct Event {
    stderr: bool,
    segment: Segment,
}

struct Printf {
    config: Config,
    inputs: BTreeMap<usize, Arc<Input>>,
    loading: Input,
    work: Work,
    format_at: usize,
    argument: usize,
    cycle_argument: usize,
    failed: bool,
    pending: VecDeque<Event>,
    stderr: Vec<u8>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(Printf {
        config: parse_config(config)?,
        inputs: BTreeMap::new(),
        loading: Input::default(),
        work: Work::Loading,
        format_at: 0,
        argument: 1,
        cycle_argument: 1,
        failed: false,
        pending: VecDeque::new(),
        stderr: Vec::new(),
    }))
}

impl Printf {
    fn output(&mut self, segment: Segment) {
        self.pending.push_back(Event {
            stderr: false,
            segment,
        });
    }

    fn diagnostic(&mut self, parts: Vec<Segment>) {
        if self.config.mode == Mode::Builtin {
            self.pending.push_back(Event {
                stderr: true,
                segment: Segment::bytes(b"bash: ".to_vec()),
            });
        }
        self.pending.extend(parts.into_iter().map(|segment| Event {
            stderr: true,
            segment,
        }));
    }

    fn warning(&mut self, text: impl Into<Vec<u8>>) {
        self.diagnostic(vec![Segment::bytes(text)]);
    }

    fn next_argument(&mut self) -> Option<Arc<Input>> {
        let value = self.inputs.get(&self.argument).cloned();
        self.argument += usize::from(value.is_some());
        value
    }

    fn number_error(&mut self, raw: Arc<Input>, read: usize, erange: bool) {
        if self.config.mode == Mode::Program {
            let problem = if erange {
                "Numerical result out of range"
            } else if read == 0 {
                "expected a numeric value"
            } else if read < raw.len {
                "value not completely converted"
            } else {
                return;
            };
            self.diagnostic(vec![
                Segment::bytes(b"printf: '".to_vec()),
                Segment::Quote {
                    input: raw,
                    at: 0,
                    style: QuoteStyle::Diagnostic,
                },
                Segment::bytes(format!("': {problem}\n").into_bytes()),
            ]);
            self.failed = true;
        } else if read < raw.len {
            let base = if raw.get(0) == Some(b'0') && raw.get(1).is_some_and(|b| b.is_ascii_digit())
            {
                "octal "
            } else if raw.get(0) == Some(b'0') && raw.get(1) == Some(b'x') {
                "hex "
            } else {
                ""
            };
            self.diagnostic(vec![
                Segment::bytes(b"printf: ".to_vec()),
                Segment::raw(raw),
                Segment::bytes(format!(": invalid {base}number\n").into_bytes()),
            ]);
            self.failed = true;
        } else if erange {
            self.diagnostic(vec![
                Segment::bytes(b"printf: warning: ".to_vec()),
                Segment::raw(raw),
                Segment::bytes(b": Numerical result out of range\n".to_vec()),
            ]);
        }
    }

    fn render(&mut self, spec: &Spec, rendered: Rendered) {
        let len = rendered.byte_len();
        let pad = spec.width().saturating_sub(len);
        let zero = rendered.allow_zero && spec.flag(b'0') && !spec.flag(b'-');
        if !spec.flag(b'-') && !zero {
            self.output(Segment::Repeat {
                byte: b' ',
                left: pad,
            });
        }
        self.output(Segment::bytes(rendered.prefix));
        if zero {
            self.output(Segment::Repeat {
                byte: b'0',
                left: pad,
            });
        }
        self.output(Segment::bytes(rendered.body));
        self.output(Segment::Repeat {
            byte: b'0',
            left: rendered.zero_tail,
        });
        self.output(Segment::bytes(rendered.suffix));
        if spec.flag(b'-') {
            self.output(Segment::Repeat {
                byte: b' ',
                left: pad,
            });
        }
    }

    fn text_output(&mut self, spec: &Spec, input: Arc<Input>, end: usize, stop: bool) -> Work {
        let end = spec
            .precision()
            .map_or(end, |n| end.min(usize::try_from(n).unwrap_or(usize::MAX)));
        let pad = spec.width().saturating_sub(end as u64);
        if !spec.flag(b'-') {
            self.output(Segment::Repeat {
                byte: b' ',
                left: pad,
            });
        }
        self.output(Segment::Raw { input, at: 0, end });
        if spec.flag(b'-') {
            self.output(Segment::Repeat {
                byte: b' ',
                left: pad,
            });
        }
        if stop {
            self.failed = false;
            Work::End(End::ArgumentEscape)
        } else {
            Work::Format
        }
    }

    fn escaped_output(
        &mut self,
        spec: &Spec,
        input: Arc<Input>,
        end: usize,
        len: u64,
        stop: bool,
    ) -> Work {
        let pad = spec.width().saturating_sub(len);
        if !spec.flag(b'-') {
            self.output(Segment::Repeat {
                byte: b' ',
                left: pad,
            });
        }
        self.output(Segment::Escapes {
            input,
            at: 0,
            end,
            left: len,
            pending: VecDeque::new(),
        });
        if spec.flag(b'-') {
            self.output(Segment::Repeat {
                byte: b' ',
                left: pad,
            });
        }
        if stop {
            self.failed = false;
            Work::End(End::ArgumentEscape)
        } else {
            Work::Format
        }
    }

    fn number_done(
        &mut self,
        mut spec: Spec,
        target: Target,
        raw: Option<Arc<Input>>,
        value: NumberValue,
    ) -> Work {
        if let Some(raw) = &raw {
            self.number_error(raw.clone(), value.read, value.erange);
        }
        match target {
            Target::Width | Target::Precision => {
                let NumberValue { integer: mut n, .. } = value;
                if !(i32::MIN as i128..=i32::MAX as i128).contains(&n) {
                    if self.config.mode == Mode::Program
                        && !(matches!(target, Target::Precision) && n < 0)
                    {
                        let field = if matches!(target, Target::Precision) {
                            "precision"
                        } else {
                            "field width"
                        };
                        self.diagnostic(vec![
                            Segment::bytes(format!("printf: invalid {field}: '").into_bytes()),
                            Segment::Quote {
                                input: raw.expect("present star argument"),
                                at: 0,
                                style: QuoteStyle::Diagnostic,
                            },
                            Segment::bytes(b"'\n".to_vec()),
                        ]);
                        self.failed = true;
                        return Work::End(End::Refusal);
                    }
                    if self.config.mode == Mode::Builtin {
                        if let Some(following) = self.inputs.get(&self.argument).cloned() {
                            self.diagnostic(vec![
                                Segment::bytes(b"printf: warning: ".to_vec()),
                                Segment::raw(following),
                                Segment::bytes(b": Numerical result out of range\n".to_vec()),
                            ]);
                        }
                        n = n.clamp(i32::MIN as i128, i32::MAX as i128);
                    }
                }
                match target {
                    Target::Precision => {
                        spec.precision = if n < 0 {
                            Field::Absent
                        } else {
                            Field::Count(n as u64)
                        }
                    }
                    Target::Width => {
                        if n < 0 && !spec.flag(b'-') {
                            spec.flags.push(b'-');
                        }
                        spec.width = Field::Count(n.unsigned_abs() as u64);
                    }
                    Target::Value => unreachable!(),
                }
                Work::Evaluate(spec)
            }
            Target::Value => {
                let rendered = if b"diouxX".contains(&spec.kind) {
                    number::render_integer(value.integer, spec.kind, &spec.flags, spec.precision())
                } else {
                    number::render_float(value.float, spec.kind, &spec.flags, spec.precision())
                };
                self.render(&spec, rendered);
                Work::Format
            }
        }
    }

    fn evaluate(&mut self, spec: Spec) -> Work {
        let target = if matches!(spec.width, Field::Argument) {
            Target::Width
        } else if matches!(spec.precision, Field::Argument) {
            Target::Precision
        } else {
            Target::Value
        };
        if !matches!(target, Target::Value) || !b"sbcq".contains(&spec.kind) {
            let signed = !matches!(target, Target::Value) || b"di".contains(&spec.kind);
            let integer = !matches!(target, Target::Value) || b"diouxX".contains(&spec.kind);
            if let Some(raw) = self.next_argument() {
                if matches!(raw.get(0), Some(b'\'' | b'"')) {
                    let (code, end) = character(&raw, 1, self.config.utf8);
                    if end == 1 && self.config.mode == Mode::Program {
                        self.number_error(raw.clone(), 0, false);
                    } else if self.config.mode == Mode::Program
                        && !self.config.posix
                        && end < raw.len
                    {
                        self.diagnostic(vec![
                            Segment::bytes(b"printf: warning: ".to_vec()),
                            Segment::Raw {
                                input: raw.clone(),
                                at: end,
                                end: raw.len,
                            },
                            Segment::bytes(
                                b": character(s) following character constant have been ignored\n"
                                    .to_vec(),
                            ),
                        ]);
                    }
                    let value = NumberValue {
                        integer: code as i128,
                        float: code as f64,
                        read: raw.len,
                        erange: false,
                    };
                    return self.number_done(spec, target, Some(raw), value);
                }
                Work::Number {
                    spec,
                    target,
                    raw,
                    scan: NumberScan::new(integer, signed),
                }
            } else {
                self.number_done(
                    spec,
                    target,
                    None,
                    NumberValue {
                        integer: 0,
                        float: 0.0,
                        read: 0,
                        erange: false,
                    },
                )
            }
        } else {
            let raw = self.next_argument().unwrap_or_default();
            match spec.kind {
                b's' => {
                    let len = raw.len;
                    self.text_output(&spec, raw, len, false)
                }
                b'c' => {
                    let mut byte = Input::default();
                    byte.push(&[raw.get(0).unwrap_or(0)]);
                    let mut spec = spec;
                    spec.precision = Field::Absent;
                    self.text_output(&spec, Arc::new(byte), 1, false)
                }
                _ => Work::Text {
                    spec,
                    raw,
                    at: 0,
                    expanded_len: 0,
                    ansi: false,
                    plain_len: 0,
                    ansi_len: 0,
                },
            }
        }
    }

    fn step(&mut self, work: Work) -> Work {
        match work {
            Work::Format => {
                let format = self.inputs[&0].clone();
                let Some(byte) = format.get(self.format_at) else {
                    if self.argument < self.inputs.len() && self.argument != self.cycle_argument {
                        self.cycle_argument = self.argument;
                        self.format_at = 0;
                        return Work::Format;
                    }
                    if self.config.mode == Mode::Program {
                        if let Some(raw) = self.inputs.get(&self.argument).cloned() {
                            self.diagnostic(vec![
                                Segment::bytes(
                                    b"printf: warning: ignoring excess arguments, starting with '"
                                        .to_vec(),
                                ),
                                Segment::Quote {
                                    input: raw,
                                    at: 0,
                                    style: QuoteStyle::Diagnostic,
                                },
                                Segment::bytes(b"'\n".to_vec()),
                            ]);
                        }
                    }
                    return Work::End(End::Complete);
                };
                if byte == b'%' {
                    let start = self.format_at;
                    self.format_at += 1;
                    Work::Parse(Parse {
                        start,
                        spec: Spec::default(),
                        field: ParseField::Flags,
                    })
                } else if byte == b'\\' {
                    let (bytes, next, stop, warning) = escape(&format, self.format_at, false);
                    self.format_at = next;
                    if let Some(warning) = warning {
                        self.warning(warning);
                    }
                    self.output(Segment::bytes(bytes));
                    if stop {
                        Work::End(End::FormatEscape)
                    } else {
                        Work::Format
                    }
                } else {
                    self.output(Segment::Raw {
                        input: format,
                        at: self.format_at,
                        end: self.format_at + 1,
                    });
                    self.format_at += 1;
                    Work::Format
                }
            }
            Work::Parse(mut parse) => {
                let byte = self.inputs[&0].get(self.format_at);
                match parse.field {
                    ParseField::Flags if byte.is_some_and(|b| b"-+ 0#".contains(&b)) => {
                        let b = byte.expect("flag");
                        if !parse.spec.flag(b) {
                            parse.spec.flags.push(b);
                        }
                        self.format_at += 1;
                    }
                    ParseField::Flags => parse.field = ParseField::Width,
                    ParseField::Width if byte == Some(b'*') => {
                        parse.spec.width = Field::Argument;
                        self.format_at += 1;
                        parse.field = ParseField::Dot;
                    }
                    ParseField::Width if byte.is_some_and(|b| b.is_ascii_digit()) => {
                        let n = if let Field::Count(n) = parse.spec.width {
                            n
                        } else {
                            0
                        };
                        parse.spec.width = Field::Count(
                            n.saturating_mul(10)
                                .saturating_add((byte.expect("width") - b'0') as u64),
                        );
                        self.format_at += 1;
                    }
                    ParseField::Width => parse.field = ParseField::Dot,
                    ParseField::Dot if byte == Some(b'.') => {
                        self.format_at += 1;
                        parse.spec.precision = Field::Count(0);
                        parse.field = ParseField::Precision;
                    }
                    ParseField::Dot => parse.field = ParseField::Kind,
                    ParseField::Precision if byte == Some(b'*') => {
                        parse.spec.precision = Field::Argument;
                        self.format_at += 1;
                        parse.field = ParseField::Kind;
                    }
                    ParseField::Precision if byte.is_some_and(|b| b.is_ascii_digit()) => {
                        let n = parse.spec.precision().unwrap_or(0);
                        parse.spec.precision = Field::Count(
                            n.saturating_mul(10)
                                .saturating_add((byte.expect("precision") - b'0') as u64),
                        );
                        self.format_at += 1;
                    }
                    ParseField::Precision => parse.field = ParseField::Kind,
                    ParseField::Kind => {
                        if let Some(b) = byte.filter(|b| b"sdiouxXeEfFgGaAcbq%".contains(b)) {
                            self.format_at += 1;
                            parse.spec.kind = b;
                            if b == b'%' {
                                self.output(Segment::bytes(b"%".to_vec()));
                                return Work::Format;
                            }
                            return Work::Evaluate(parse.spec);
                        }
                        self.format_at = parse.start + 1;
                        self.output(Segment::bytes(b"%".to_vec()));
                        return Work::Format;
                    }
                }
                Work::Parse(parse)
            }
            Work::Evaluate(spec) => self.evaluate(spec),
            Work::Number {
                spec,
                target,
                raw,
                mut scan,
            } => {
                if let Some(value) = scan.step(&raw) {
                    self.number_done(spec, target, Some(raw), value)
                } else {
                    Work::Number {
                        spec,
                        target,
                        raw,
                        scan,
                    }
                }
            }
            Work::Text {
                spec,
                raw,
                mut at,
                mut expanded_len,
                mut ansi,
                mut plain_len,
                mut ansi_len,
            } => {
                if at == raw.len {
                    if spec.kind == b'q' {
                        let length = if raw.len == 0 {
                            2
                        } else if ansi {
                            ansi_len + 3
                        } else {
                            plain_len
                        };
                        let pad = spec.width().saturating_sub(length);
                        if !spec.flag(b'-') {
                            self.output(Segment::Repeat {
                                byte: b' ',
                                left: pad,
                            });
                        }
                        if raw.len == 0 {
                            self.output(Segment::bytes(b"''".to_vec()));
                        } else {
                            if ansi {
                                self.output(Segment::bytes(b"$'".to_vec()));
                            }
                            self.output(Segment::Quote {
                                input: raw,
                                at: 0,
                                style: if ansi {
                                    QuoteStyle::Ansi
                                } else {
                                    QuoteStyle::Shell
                                },
                            });
                            if ansi {
                                self.output(Segment::bytes(b"'".to_vec()));
                            }
                        }
                        if spec.flag(b'-') {
                            self.output(Segment::Repeat {
                                byte: b' ',
                                left: pad,
                            });
                        }
                        return Work::Format;
                    }
                    return self.escaped_output(&spec, raw, at, expanded_len, false);
                }
                if spec.kind == b'q' {
                    let b = raw.get(at).expect("text");
                    ansi |= !(0x20..0x7f).contains(&b);
                    let mut bytes = Vec::new();
                    quote_byte(b, at, QuoteStyle::Shell, &mut bytes);
                    plain_len += bytes.len() as u64;
                    bytes.clear();
                    quote_byte(b, at, QuoteStyle::Ansi, &mut bytes);
                    ansi_len += bytes.len() as u64;
                    at += 1;
                } else if raw.get(at) == Some(b'\\') {
                    let (bytes, next, stop, warning) = escape(&raw, at, true);
                    at = next;
                    if let Some(warning) = warning {
                        self.warning(warning);
                    }
                    expanded_len = expanded_len
                        .saturating_add(bytes.len() as u64)
                        .min(spec.precision().unwrap_or(u64::MAX));
                    if stop {
                        return self.escaped_output(&spec, raw, at, expanded_len, true);
                    }
                } else {
                    expanded_len = expanded_len
                        .saturating_add(1)
                        .min(spec.precision().unwrap_or(u64::MAX));
                    at += 1;
                }
                Work::Text {
                    spec,
                    raw,
                    at,
                    expanded_len,
                    ansi,
                    plain_len,
                    ansi_len,
                }
            }
            other => other,
        }
    }
}

impl Stream for Printf {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(self.inputs.len(), input, out)
    }
    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        _: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if !matches!(self.work, Work::Loading)
            || index != self.inputs.len()
            || index > self.config.argument_count
            || input.len() > STEP
        {
            return Err(StreamError::new("bad printf input"));
        }
        self.loading.push(input);
        Ok(())
    }
    fn end_input(&mut self, index: usize, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.work, Work::Loading)
            || index != self.inputs.len()
            || index > self.config.argument_count
        {
            return Err(StreamError::new("bad printf input"));
        }
        self.inputs
            .insert(index, Arc::new(std::mem::take(&mut self.loading)));
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if matches!(self.work, Work::Loading) {
            if self.inputs.len() != self.config.argument_count.saturating_add(1) {
                return Err(StreamError::new("incomplete printf input"));
            }
            self.work = Work::Format;
        }
        self.drain(out)
    }
    fn busy(&self) -> bool {
        !matches!(self.work, Work::Loading | Work::End(_)) || !self.pending.is_empty()
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut work = 0;
        let mut channel = None;
        while work < STEP {
            if let Some(event) = self.pending.front_mut() {
                if channel.is_some_and(|stderr| stderr != event.stderr) {
                    break;
                }
                channel = Some(event.stderr);
                let buffer = if event.stderr {
                    &mut self.stderr
                } else {
                    &mut *out
                };
                let (done, used) = event.segment.emit(buffer, STEP - work);
                work += used;
                if done {
                    self.pending.pop_front();
                }
            } else {
                if matches!(self.work, Work::Loading | Work::End(_)) {
                    break;
                }
                let state = std::mem::replace(&mut self.work, Work::End(End::Refusal));
                self.work = self.step(state);
                work += 1;
            }
        }
        Ok(())
    }
    fn done(&self) -> bool {
        matches!(
            self.work,
            Work::End(End::FormatEscape | End::ArgumentEscape | End::Refusal)
        )
    }
    fn status(&self) -> i32 {
        i32::from(self.failed)
    }
    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}

fn character(raw: &Input, at: usize, utf8: bool) -> (u32, usize) {
    let Some(first) = raw.get(at) else {
        return (0, at);
    };
    if !utf8 || first < 0x80 {
        return (first as u32, at + 1);
    }
    let n = if first < 0xe0 {
        2
    } else if first < 0xf0 {
        3
    } else {
        4
    };
    let bytes: Vec<u8> = (at..at + n).filter_map(|i| raw.get(i)).collect();
    if let Ok(text) = std::str::from_utf8(&bytes) {
        if let Some(ch) = text.chars().next() {
            return (ch as u32, at + ch.len_utf8());
        }
    }
    (first as u32, at + 1)
}

fn quote_byte(byte: u8, at: usize, style: QuoteStyle, out: &mut Vec<u8>) {
    if style != QuoteStyle::Shell {
        let escaped = match byte {
            7 => Some(b'a'),
            8 => Some(b'b'),
            9 => Some(b't'),
            10 => Some(b'n'),
            11 => Some(b'v'),
            12 => Some(b'f'),
            13 => Some(b'r'),
            27 if style == QuoteStyle::Ansi => Some(b'E'),
            b'\\' => Some(b'\\'),
            b'\'' => Some(b'\''),
            _ => None,
        };
        if let Some(b) = escaped {
            out.extend_from_slice(&[b'\\', b]);
        } else if !(0x20..0x7f).contains(&byte) {
            out.extend_from_slice(&[
                b'\\',
                b'0' + (byte >> 6),
                b'0' + ((byte >> 3) & 7),
                b'0' + (byte & 7),
            ]);
        } else {
            out.push(byte);
        }
    } else {
        if !(byte.is_ascii_alphanumeric()
            || b"%+-./:=@_".contains(&byte)
            || (at != 0 && b"#~".contains(&byte)))
        {
            out.push(b'\\');
        }
        out.push(byte);
    }
}

fn hex(byte: u8) -> Option<u32> {
    (byte as char).to_digit(16)
}

fn escape(raw: &Input, at: usize, argument: bool) -> (Vec<u8>, usize, bool, Option<Vec<u8>>) {
    let Some(byte) = raw.get(at + 1) else {
        return (vec![b'\\'], at + 1, false, None);
    };
    let simple = match byte {
        b'c' => return (Vec::new(), at + 2, true, None),
        b'\\' => Some(b'\\'),
        b'n' => Some(10),
        b't' => Some(9),
        b'r' => Some(13),
        b'a' => Some(7),
        b'b' => Some(8),
        b'f' => Some(12),
        b'v' => Some(11),
        _ => None,
    };
    if let Some(byte) = simple {
        return (vec![byte], at + 2, false, None);
    }
    if b"xuU".contains(&byte) {
        let limit = match byte {
            b'x' => 2,
            b'u' => 4,
            _ => 8,
        };
        let mut end = at + 2;
        let mut value = 0;
        while end < at + 2 + limit {
            let Some(n) = raw.get(end).and_then(hex) else {
                break;
            };
            value = value * 16 + n;
            end += 1;
        }
        if end == at + 2 {
            let kind = if byte == b'x' { "hex" } else { "unicode" };
            return (
                vec![b'\\', byte],
                end,
                false,
                Some(format!("printf: missing {kind} digit for \\{}\n", byte as char).into_bytes()),
            );
        }
        let bytes = if byte == b'x' {
            vec![value as u8]
        } else {
            code_point(value)
        };
        return (bytes, end, false, None);
    }
    if (b'0'..=b'7').contains(&byte) {
        let limit = if argument && byte == b'0' { 4 } else { 3 };
        let mut end = at + 1;
        let mut value = 0u32;
        while end < at + 1 + limit {
            let Some(b @ b'0'..=b'7') = raw.get(end) else {
                break;
            };
            value = value * 8 + (b - b'0') as u32;
            end += 1;
        }
        return (vec![value as u8], end, false, None);
    }
    (vec![b'\\', byte], at + 2, false, None)
}

fn code_point(value: u32) -> Vec<u8> {
    let n = match value {
        0..=0x7f => 1,
        0x80..=0x7ff => 2,
        0x800..=0xffff => 3,
        0x10000..=0x1fffff => 4,
        0x200000..=0x3ffffff => 5,
        0x4000000..=0x7fffffff => 6,
        _ => return Vec::new(),
    };
    if n == 1 {
        return vec![value as u8];
    }
    let mut out = vec![0; n];
    let mut v = value;
    for at in (1..n).rev() {
        out[at] = 0x80 | (v as u8 & 0x3f);
        v >>= 6;
    }
    out[0] = (0xffu8 << (8 - n)) | v as u8;
    out
}
