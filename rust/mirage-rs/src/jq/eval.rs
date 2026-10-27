use std::collections::HashMap;
use std::sync::Arc;

use crate::{Stream, StreamError};

use super::builtin::Cfunc;
use super::compile;
use super::host::{Host, Message, Reply};
use super::time::{Clock, Zone};
use super::value::{Object, Value, parse_json};
use super::vm::{Halt, Limits, Next, Op, Program, Raise, Vm};

const STEPS: u64 = 1 << 16;
const BLOCKS: usize = 1 << 20;
const ITEMS: usize = 1 << 24;
const BYTES: usize = 1 << 28;
const RETIRE: usize = 1 << 14;

pub(crate) const OUTPUT: u8 = 1;
pub(crate) const ERROR: u8 = 2;
pub(crate) const HALT: u8 = 3;
pub(crate) const DEBUG: u8 = 4;
pub(crate) const STDERR: u8 = 5;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    program: String,
    #[serde(default)]
    named: HashMap<String, String>,
    #[serde(default)]
    args: Option<String>,
    #[serde(default)]
    env: Option<String>,
    #[serde(default = "steps")]
    steps: u64,
    #[serde(default = "blocks")]
    blocks: usize,
    #[serde(default = "items")]
    items: usize,
    #[serde(default = "bytes")]
    bytes: usize,
    #[serde(default)]
    now: Option<f64>,
    #[serde(default)]
    zone: Option<String>,
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

/// Where the run's `input` stands with the host: no call waiting, a call
/// the host has not taken with `request`, or one it took and has not
/// answered.
#[derive(Clone, Copy, PartialEq)]
enum Asking {
    No,
    Pending,
    Taken,
}

/// Where jq's input reader stands: the input it reads (null before it
/// opens one) and the lines read of it, which `input_filename` and
/// `input_line_number` answer. `begin` carries it for the main loop's
/// document, with the clock for its run, and each reply for the document
/// `input` took.
#[derive(Default, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Position {
    filename: Option<String>,
    line: f64,
    now: Option<f64>,
}

/// The host's answer to `input`: `value` with the document's JSON text,
/// `end`, or `error` with the reader's message.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct InputReply {
    kind: String,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    line: f64,
}

/// One jq program run over documents one at a time, on the host's own
/// thread: `open` compiles it, each document is fed, `finish` starts the
/// run, and every `drain` executes a bounded number of VM steps, so a
/// program that never ends still hands control back.
///
/// `drain` writes frames: an output's compact dump, an error that ended
/// the run (a string flag, then its text), a halt (JSON), what `debug`
/// prints (the compact dump of `["DEBUG:", value]`), and what `stderr`
/// writes (the bytes). `begin` readies the stream for the next document,
/// with the reader's position; `cancel` retires the run's stack a bounded
/// slice per `drain`.
///
/// `input` pauses the run: `busy` turns false, `request` asks the host
/// for `{"op": "input"}`, and `respond` takes the next document, the end
/// of the stream, or the reader's parse error, as jq's input callback
/// answers it, and the reader's position after it.
struct Eval {
    program: Arc<Program>,
    limits: Limits,
    steps: u64,
    env: Value,
    position: Position,
    asking: Asking,
    clock: Clock,
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
    let env = match &config.env {
        Some(text) => json(text)?,
        None => Value::object(Object::default()),
    };
    // jq binds `$ENV` to the environment over an `--arg ENV` (compile.c).
    globals.insert("ENV".to_string(), env.clone());
    let program = compile::compile(&config.program, &globals).map_err(StreamError::new)?;
    let clock = Clock {
        now: config.now,
        zone: config.zone.as_deref().and_then(Zone::parse).map(Arc::new),
    };
    needs_host(&program, &clock)?;
    Ok(Box::new(Eval {
        program: Arc::new(program),
        limits: Limits {
            blocks: config.blocks,
            items: config.items,
            bytes: config.bytes,
        },
        steps: config.steps.max(1),
        env,
        position: Position::default(),
        asking: Asking::No,
        clock,
        pending: Vec::new(),
        state: State::Feeding,
    }))
}

fn place(host: &mut Host, position: Position) {
    host.filename = position.filename.map_or(Value::Null, Value::string);
    host.line = position.line;
}

fn message_frames(host: &mut Host, out: &mut Vec<u8>) {
    for message in host.messages.drain(..) {
        match message {
            Message::Debug(value) => {
                let line = Value::array(vec![Value::string("DEBUG:"), value]);
                frame(DEBUG, line.dump().as_bytes(), out);
            }
            Message::Stderr(Value::String(text)) => frame(STDERR, text.as_bytes(), out),
            Message::Stderr(value) => frame(STDERR, value.dump().as_bytes(), out),
        }
    }
}

/// A program that asks for the time or the local time zone runs here only
/// when the host gave one; otherwise it is refused, as an unknown builtin
/// is, and the host runs it elsewhere.
fn needs_host(program: &Program, clock: &Clock) -> Result<(), StreamError> {
    let calls = |wanted: &[Cfunc]| {
        program
            .bytecodes
            .iter()
            .flat_map(|bytecode| &bytecode.ops)
            .any(|op| matches!(op, Op::CallBuiltin(f, _) if wanted.contains(f)))
    };
    if clock.now.is_none() && calls(&[Cfunc::Now]) {
        return Err(StreamError::new("jq_eval: no clock for now"));
    }
    if clock.zone.is_none() && calls(&[Cfunc::Localtime, Cfunc::StrfLocaltime]) {
        return Err(StreamError::new("jq_eval: no time zone for local time"));
    }
    Ok(())
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
        let mut vm = Vm::start(Arc::clone(&self.program), input, self.limits);
        vm.host.env = self.env.clone();
        place(&mut vm.host, std::mem::take(&mut self.position));
        vm.set_clock(self.clock.clone());
        self.state = State::Running(Box::new(vm));
        Ok(())
    }

    fn busy(&self) -> bool {
        match self.state {
            State::Running(_) => self.asking == Asking::No,
            State::Retiring(_) => true,
            State::Feeding | State::Ended => false,
        }
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        match &mut self.state {
            State::Running(_) if self.asking != Asking::No => {}
            State::Running(vm) => {
                let mut budget = self.steps;
                loop {
                    let next = vm.next(&mut budget);
                    message_frames(&mut vm.host, out);
                    match next {
                        Next::Output(value) => {
                            frame(OUTPUT, value.dump().as_bytes(), out);
                            if budget == 0 {
                                return Ok(());
                            }
                        }
                        Next::Paused => return Ok(()),
                        Next::Input => {
                            self.asking = Asking::Pending;
                            return Ok(());
                        }
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
        self.asking = Asking::No;
        self.pending.clear();
        true
    }

    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        if matches!(self.state, State::Running(_) | State::Retiring(_)) {
            return Err(StreamError::new("jq_eval: the run has not ended"));
        }
        let position: Position = crate::parse_config(config)?;
        if position.now.is_some() {
            self.clock.now = position.now;
        }
        self.position = position;
        self.pending.clear();
        self.state = State::Feeding;
        Ok(())
    }

    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let _ = data;
        if self.asking != Asking::Pending {
            return None;
        }
        self.asking = Asking::Taken;
        Some(br#"{"op":"input"}"#.to_vec())
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let _ = out;
        let State::Running(vm) = &mut self.state else {
            return Err(StreamError::new("jq_eval: the host answered no request"));
        };
        if self.asking != Asking::Taken {
            return Err(StreamError::new("jq_eval: the host answered no request"));
        }
        let reply: InputReply = crate::parse_config(reply)?;
        let text = std::str::from_utf8(data)
            .map_err(|_| StreamError::new("jq_eval: document is not UTF-8"))?;
        vm.host.reply = Some(match reply.kind.as_str() {
            "value" => parse_json(text).map_or_else(Reply::Error, Reply::Value),
            "end" => Reply::End,
            "error" => Reply::Error(text.to_string()),
            other => return Err(StreamError::new(format!("jq_eval: unknown reply {other}"))),
        });
        place(
            &mut vm.host,
            Position {
                filename: reply.filename,
                line: reply.line,
                now: None,
            },
        );
        self.asking = Asking::No;
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
