use std::collections::HashMap;
use std::sync::Arc;

use crate::{Stream, StreamError};

use super::compile;
use super::value::{Value, parse_json};
use super::vm::{Halt, Limits, Next, Program, Raise, Vm};

const STEPS: u64 = 1 << 16;
const BLOCKS: usize = 1 << 20;
const ITEMS: usize = 1 << 24;
const BYTES: usize = 1 << 28;
const RETIRE: usize = 1 << 14;

pub(crate) const OUTPUT: u8 = 1;
pub(crate) const ERROR: u8 = 2;
pub(crate) const HALT: u8 = 3;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    program: String,
    #[serde(default)]
    named: HashMap<String, String>,
    #[serde(default)]
    args: Option<String>,
    #[serde(default = "steps")]
    steps: u64,
    #[serde(default = "blocks")]
    blocks: usize,
    #[serde(default = "items")]
    items: usize,
    #[serde(default = "bytes")]
    bytes: usize,
}

fn steps() -> u64 {
    STEPS
}

fn blocks() -> usize {
    BLOCKS
}

fn items() -> usize {
    ITEMS
}

fn bytes() -> usize {
    BYTES
}

enum State {
    Feeding,
    Running(Box<Vm>),
    Retiring(Box<Vm>),
    Ended,
}

/// One jq program run over documents one at a time, on the host's own
/// thread: `open` compiles it, each document is fed, `finish` starts the
/// run, and every `drain` executes a bounded number of VM steps, so a
/// program that never ends still hands control back.
///
/// `drain` writes frames: an output's compact dump, an error that ended
/// the run (a string flag, then its text), or a halt (JSON). `begin`
/// readies the stream for the next document; `cancel` retires the run's
/// stack a bounded slice per `drain`.
struct Eval {
    program: Arc<Program>,
    limits: Limits,
    steps: u64,
    pending: Vec<u8>,
    state: State,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = serde_json::from_slice(config)
        .map_err(|e| StreamError::new(format!("bad jq_eval config: {e}")))?;
    let mut globals = HashMap::new();
    for (name, text) in &config.named {
        if is_ident(name) {
            globals.insert(name.clone(), json(text)?);
        }
    }
    if let Some(args) = &config.args {
        globals.insert("ARGS".to_string(), json(args)?);
    }
    let program = compile::compile(&config.program, &globals).map_err(StreamError::new)?;
    Ok(Box::new(Eval {
        program: Arc::new(program),
        limits: Limits {
            blocks: config.blocks,
            items: config.items,
            bytes: config.bytes,
        },
        steps: config.steps.max(1),
        pending: Vec::new(),
        state: State::Feeding,
    }))
}

fn json(text: &str) -> Result<Value, StreamError> {
    parse_json(text).map_err(StreamError::new)
}

fn is_ident(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn frame(tag: u8, payload: &[u8], out: &mut Vec<u8>) {
    out.push(tag);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

fn message(value: &Value) -> (bool, String) {
    match value {
        Value::String(s) => (true, s.to_string()),
        other => (false, other.dump()),
    }
}

fn error_frame(raise: Raise, out: &mut Vec<u8>) {
    let mut raise = raise;
    let value = loop {
        match raise {
            Raise::Error(value) => break value,
            Raise::Wrapped(inner) => raise = *inner,
        }
    };
    let (string, text) = message(&value);
    let mut payload = vec![u8::from(string)];
    payload.extend_from_slice(text.as_bytes());
    frame(ERROR, &payload, out);
}

fn halt_frame(halt: Halt, out: &mut Vec<u8>) {
    let (string, text) = match &halt.message {
        None | Some(Value::Null) => (false, None),
        Some(value) => {
            let (string, text) = message(value);
            (string, Some(text))
        }
    };
    let payload = serde_json::json!({
        "message": text,
        "string": string,
        "code": halt.code,
    });
    frame(HALT, payload.to_string().as_bytes(), out);
}

impl Stream for Eval {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.state, State::Feeding) {
            return Err(StreamError::new("jq_eval: begin the next document first"));
        }
        self.pending.extend_from_slice(input);
        Ok(())
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.state, State::Feeding) {
            return Err(StreamError::new("jq_eval: begin the next document first"));
        }
        let text = std::str::from_utf8(&self.pending)
            .map_err(|_| StreamError::new("jq_eval: document is not UTF-8"))?;
        let input = parse_json(text).map_err(StreamError::new)?;
        self.pending.clear();
        let vm = Vm::start(Arc::clone(&self.program), input, self.limits);
        self.state = State::Running(Box::new(vm));
        Ok(())
    }

    fn busy(&self) -> bool {
        matches!(self.state, State::Running(_) | State::Retiring(_))
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        match &mut self.state {
            State::Running(vm) => {
                let mut budget = self.steps;
                loop {
                    match vm.next(&mut budget) {
                        Next::Output(value) => {
                            frame(OUTPUT, value.dump().as_bytes(), out);
                            if budget == 0 {
                                return Ok(());
                            }
                        }
                        Next::Paused => return Ok(()),
                        Next::Done => break,
                        Next::Error(raise) => {
                            error_frame(raise, out);
                            break;
                        }
                        Next::Halt(halt) => {
                            halt_frame(halt, out);
                            break;
                        }
                    }
                }
                let State::Running(vm) = std::mem::replace(&mut self.state, State::Ended) else {
                    unreachable!()
                };
                self.state = State::Retiring(vm);
                self.retire();
            }
            State::Retiring(_) => self.retire(),
            State::Feeding | State::Ended => {}
        }
        Ok(())
    }

    fn cancel(&mut self) -> bool {
        if let State::Running(_) = self.state {
            let State::Running(vm) = std::mem::replace(&mut self.state, State::Ended) else {
                unreachable!()
            };
            self.state = State::Retiring(vm);
        }
        self.pending.clear();
        true
    }

    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let _ = config;
        if self.busy() {
            return Err(StreamError::new("jq_eval: the run has not ended"));
        }
        self.pending.clear();
        self.state = State::Feeding;
        Ok(())
    }
}

impl Eval {
    fn retire(&mut self) {
        if let State::Retiring(vm) = &mut self.state {
            if vm.retire(RETIRE) {
                self.state = State::Ended;
            }
        }
    }
}
