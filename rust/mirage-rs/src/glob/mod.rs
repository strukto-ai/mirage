use std::sync::Arc;

use serde::Deserialize;

mod compile;
mod evaluate;
mod reverse;
#[cfg(test)]
mod tests;

use crate::{Stream, StreamError, parse_config};
use compile::{Compiler, Dialect, Program, is};
use evaluate::Evaluator;
use reverse::Reverse;

const WORK: usize = 2048;
type Span = (usize, usize);
type Positions = Arc<Vec<Span>>;
type Key = (usize, usize, usize);
type RunKey = (usize, usize, usize, Vec<usize>);

fn yes() -> bool {
    true
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Operation {
    Matches,
    End {
        #[serde(default)]
        start: usize,
        #[serde(default = "yes")]
        longest: bool,
    },
    Suffix {
        #[serde(default = "yes")]
        longest: bool,
    },
    Replace {
        #[serde(default)]
        all: bool,
        #[serde(default)]
        anchor: Option<String>,
    },
    Shape,
    Parts,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    pattern: Vec<u32>,
    #[serde(default)]
    dialect: Dialect,
    #[serde(default)]
    extglob: bool,
    #[serde(default)]
    period: bool,
    operation: Operation,
}

#[derive(Deserialize)]
struct Request {
    #[serde(flatten)]
    operation: Operation,
    #[serde(default)]
    reuse_subject: bool,
}

struct Glob {
    compiler: Option<Compiler>,
    program: Option<Program>,
    reverse: Option<Reverse>,
    reversed_compiler: Option<Compiler>,
    reversed: Option<Program>,
    subject: Vec<u32>,
    partial: Vec<u8>,
    operation: Operation,
    period: bool,
    forward: Evaluator,
    backward: Evaluator,
    active: bool,
    started: bool,
    query: bool,
    cursor: usize,
    emitted: bool,
    group_end: usize,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    validate_operation(&config.operation)?;
    if config.pattern.iter().any(|&cp| cp > 0x10ffff) {
        return Err(StreamError::new("glob unit is past U+10FFFF"));
    }
    Ok(Box::new(Glob {
        compiler: Some(Compiler::new(
            config.pattern,
            config.dialect,
            config.extglob,
        )),
        program: None,
        reverse: None,
        reversed_compiler: None,
        reversed: None,
        subject: Vec::new(),
        partial: Vec::new(),
        operation: config.operation,
        period: config.period,
        forward: Evaluator::default(),
        backward: Evaluator::default(),
        active: false,
        started: false,
        query: false,
        cursor: 0,
        emitted: false,
        group_end: 0,
    }))
}

fn validate_operation(operation: &Operation) -> Result<(), StreamError> {
    match operation {
        Operation::Replace {
            anchor: Some(anchor),
            ..
        } if anchor != "#" && anchor != "%" => {
            Err(StreamError::new("glob replacement anchor is #, %, or null"))
        }
        _ => Ok(()),
    }
}

fn emit_number(out: &mut Vec<u8>, value: usize) {
    out.extend_from_slice(value.to_string().as_bytes());
}
fn emit_option(out: &mut Vec<u8>, value: Option<usize>) {
    if let Some(value) = value {
        emit_number(out, value);
    } else {
        out.extend_from_slice(b"null");
    }
}

impl Glob {
    fn needs_reverse(&self) -> bool {
        match &self.operation {
            Operation::Suffix { .. } => true,
            Operation::Replace { anchor, .. } => anchor.as_deref() == Some("%"),
            _ => false,
        }
    }
    fn compile_step(&mut self) -> bool {
        if let Some(compiler) = &mut self.compiler {
            compiler.step();
            if compiler.done() {
                self.program = self.compiler.take().map(|compiler| compiler.program);
            }
            return true;
        }
        if self.needs_reverse() && self.reversed.is_none() {
            if let Some(compiler) = &mut self.reversed_compiler {
                compiler.step();
                if compiler.done() {
                    self.reversed = self
                        .reversed_compiler
                        .take()
                        .map(|compiler| compiler.program);
                }
            } else {
                let reverse = self.reverse.get_or_insert_with(Reverse::new);
                let program = self.program.as_ref().expect("compiled pattern");
                if reverse.step(program) {
                    let units = std::mem::take(&mut reverse.units);
                    self.reversed_compiler =
                        Some(Compiler::new(units, program.dialect, program.extglob));
                    self.reverse = None;
                }
            }
            return true;
        }
        false
    }
    fn selected(&mut self, reverse: bool) -> (&Program, &mut Evaluator) {
        if reverse {
            (
                self.reversed.as_ref().expect("reversed pattern"),
                &mut self.backward,
            )
        } else {
            (
                self.program.as_ref().expect("compiled pattern"),
                &mut self.forward,
            )
        }
    }
    fn query_step(&mut self, start: usize, longest: bool, reverse: bool) -> Option<Option<usize>> {
        let period = self.period && self.subject.first() == Some(&u32::from(b'.')) && !reverse;
        if !self.query {
            let retain_runs = !matches!(self.operation, Operation::Matches);
            let (program, evaluator) = self.selected(reverse);
            evaluator.start((0, program.units.len(), start), retain_runs);
            self.query = true;
            return None;
        }
        let subject = &self.subject;
        let (program, evaluator) = if reverse {
            (
                self.reversed.as_ref().expect("reversed pattern"),
                &mut self.backward,
            )
        } else {
            (
                self.program.as_ref().expect("compiled pattern"),
                &mut self.forward,
            )
        };
        if let Some(answer) = evaluator.answer.take() {
            self.query = false;
            return Some(if longest {
                answer.last().map(|&(_, hi)| hi - 1)
            } else {
                answer.first().map(|&(lo, _)| lo)
            });
        }
        evaluator.step(program, subject, reverse, period);
        None
    }
    fn result_step(&mut self, out: &mut Vec<u8>) {
        match self.operation.clone() {
            Operation::Shape => {
                if !self.started {
                    out.push(b'[');
                    self.started = true;
                }
                let program = self.program.as_ref().expect("compiled pattern");
                if self.cursor < program.units.len() {
                    if self.emitted {
                        out.push(b',');
                    }
                    if let Some(group) = program.groups.get(&self.cursor) {
                        emit_number(out, usize::from(b'*'));
                        self.cursor = group.end;
                    } else {
                        emit_number(out, program.units[self.cursor] as usize);
                        self.cursor += 1;
                    }
                    self.emitted = true;
                } else {
                    out.push(b']');
                    self.active = false;
                }
            }
            Operation::Parts => {
                if !self.started {
                    out.extend_from_slice(b"[[");
                    self.started = true;
                }
                let program = self.program.as_ref().expect("compiled pattern");
                if self.cursor < program.units.len() {
                    if let Some(group) = program.groups.get(&self.cursor) {
                        self.group_end = self.group_end.max(group.end);
                    }
                    let cp = program.units[self.cursor];
                    if is(cp, b'/') && self.cursor >= self.group_end {
                        out.extend_from_slice(b"],[");
                        self.emitted = false;
                    } else {
                        if self.emitted {
                            out.push(b',');
                        }
                        emit_number(out, cp as usize);
                        self.emitted = true;
                    }
                    self.cursor += 1;
                } else {
                    out.extend_from_slice(b"]]");
                    self.active = false;
                }
            }
            Operation::Matches => {
                if let Some(end) = self.query_step(0, true, false) {
                    out.extend_from_slice(if end == Some(self.subject.len()) {
                        b"true"
                    } else {
                        b"false"
                    });
                    self.active = false;
                }
            }
            Operation::End { start, longest } => {
                if let Some(end) = self.query_step(start, longest, false) {
                    emit_option(out, end);
                    self.active = false;
                }
            }
            Operation::Suffix { longest } => {
                if let Some(end) = self.query_step(0, longest, true) {
                    emit_option(out, end.map(|end| self.subject.len() - end));
                    self.active = false;
                }
            }
            Operation::Replace { all, anchor } => {
                if !self.started {
                    out.push(b'[');
                    self.started = true;
                }
                if self
                    .program
                    .as_ref()
                    .expect("compiled pattern")
                    .units
                    .is_empty()
                {
                    out.push(b']');
                    self.active = false;
                    return;
                }
                let reverse = anchor.as_deref() == Some("%");
                if let Some(end) = self.query_step(self.cursor, true, reverse) {
                    let found = if reverse {
                        end.map(|end| (self.subject.len() - end, self.subject.len()))
                    } else {
                        end.map(|end| (self.cursor, end))
                    };
                    let anchored = anchor.is_some();
                    if let Some((start, end)) = found
                        .filter(|&(start, end)| anchored || end > start || self.subject.is_empty())
                    {
                        if self.emitted {
                            out.push(b',');
                        }
                        out.push(b'[');
                        emit_number(out, start);
                        out.push(b',');
                        emit_number(out, end);
                        out.push(b']');
                        self.emitted = true;
                        self.cursor = end;
                        if !all || anchored || self.subject.is_empty() {
                            out.push(b']');
                            self.active = false;
                            return;
                        }
                    } else {
                        self.cursor += 1;
                    }
                    if anchored || self.cursor >= self.subject.len() {
                        out.push(b']');
                        self.active = false;
                    }
                }
            }
        }
    }
}

impl Stream for Glob {
    fn feed(&mut self, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.active {
            return Err(StreamError::new("glob operation is still busy"));
        }
        for &byte in input {
            self.partial.push(byte);
            if self.partial.len() == 4 {
                let cp =
                    u32::from_le_bytes(self.partial.as_slice().try_into().expect("four bytes"));
                if cp > 0x10ffff {
                    return Err(StreamError::new("glob unit is past U+10FFFF"));
                }
                self.subject.push(cp);
                self.partial.clear();
            }
        }
        Ok(())
    }
    fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.partial.is_empty() {
            return Err(StreamError::new("glob subject ends inside a u32 unit"));
        }
        self.active = true;
        Ok(())
    }
    fn busy(&self) -> bool {
        self.active
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        for _ in 0..WORK {
            if !self.active {
                break;
            }
            if !self.compile_step() {
                self.result_step(out);
            }
        }
        Ok(())
    }
    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        if self.active {
            return Err(StreamError::new("glob operation is still busy"));
        }
        let request: Request = parse_config(config)?;
        validate_operation(&request.operation)?;
        if !request.reuse_subject {
            self.subject.clear();
            self.forward = Evaluator::default();
            self.backward = Evaluator::default();
        }
        self.partial.clear();
        self.operation = request.operation;
        self.started = false;
        self.query = false;
        self.cursor = 0;
        self.emitted = false;
        self.group_end = 0;
        Ok(())
    }
}
