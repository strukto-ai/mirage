use std::collections::HashMap;
use std::sync::Arc;

use crate::{Stream, StreamError};

use super::builtin::Cfunc;
use super::compile::{self, Refusal};
use super::host::{Host, Message, Reply, Request};
use super::meter::{self, Charge, Meter};
use super::time::{Clock, Zone};
use super::value::{Dumping, Object, Parsing, Value, parse_json};
use super::vm::{Halt, Limits, Next, Op, Program, Raise, Vm};

const STEPS: u64 = 1 << 16;
const BLOCKS: usize = 1 << 20;
const ITEMS: usize = 1 << 24;
const BYTES: usize = 1 << 28;
const MEMORY: usize = 1 << 30;
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
    #[serde(default = "memory")]
    memory: usize,
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

fn memory() -> usize {
    MEMORY
}

enum State {
    Feeding,
    Reading(Box<Parsing>),
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
/// document, and each reply for the document `input` took.
#[derive(Default, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Position {
    filename: Option<String>,
    line: f64,
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
    #[serde(default)]
    now: f64,
}

enum PrintKind {
    Output,
    Error(bool),
    HaltMessage(bool, Option<f64>),
    HaltPayload,
}

struct Printing {
    dumping: Dumping,
    kind: PrintKind,
}

impl Printing {
    fn output(value: Value) -> Self {
        Self {
            dumping: Dumping::begin(value),
            kind: PrintKind::Output,
        }
    }

    fn error(mut raise: Raise) -> Self {
        let value = loop {
            match raise {
                Raise::Error(value) => break value,
                Raise::Wrapped(inner) => raise = *inner,
            }
        };
        let string = matches!(value, Value::String(_));
        let dumping = if let Value::String(text) = value {
            Dumping::raw(text)
        } else {
            Dumping::begin(value)
        };
        Self {
            dumping,
            kind: PrintKind::Error(string),
        }
    }

    fn halt(halt: Halt) -> Self {
        match halt.message {
            None | Some(Value::Null) => Self {
                dumping: Dumping::halt(None, false, halt.code),
                kind: PrintKind::HaltPayload,
            },
            Some(value) => {
                let string = matches!(value, Value::String(_));
                let dumping = if let Value::String(text) = value {
                    Dumping::raw(text)
                } else {
                    Dumping::begin(value)
                };
                Self {
                    dumping,
                    kind: PrintKind::HaltMessage(string, halt.code),
                }
            }
        }
    }
}

/// One jq program run over documents one at a time, on the host's own
/// thread: `open` compiles it, each document is fed, `finish` starts the
/// run, and every `drain` executes a bounded number of VM steps, so a
/// program that never ends still hands control back.
///
/// `drain` writes frames: an output's compact dump, an error that ended
/// the run (a string flag, then its text), a halt (JSON), what `debug`
/// prints (the compact dump of `["DEBUG:", value]`), and what `stderr`
/// writes (the bytes). An output is dumped on the same step budget, so
/// a large one takes several drains and its frame goes out whole once
/// it is written. `begin` readies the stream for the next document,
/// with the reader's position; `cancel` retires the run's stack a bounded
/// slice per `drain`.
///
/// `input` pauses the run: `busy` turns false, `request` asks the host
/// for `{"op": "input"}`, and `respond` takes the next document, the end
/// of the stream, or the reader's parse error, as jq's input callback
/// answers it, and the reader's position after it.
struct Eval {
    program: Option<Arc<Program>>,
    limits: Limits,
    meter: Arc<Meter>,
    steps: u64,
    env: Value,
    position: Position,
    asking: Asking,
    clock: Clock,
    pending: Vec<u8>,
    pending_charge: Charge,
    input_limited: bool,
    compile_limited: bool,
    receiving: Option<Box<Parsing>>,
    printing: Option<Printing>,
    state: State,
}

/// Compile the configured program. A program jq itself refuses is
/// refused with jq's report, whose last line is its `jq: N compile
/// error(s)` count; any other refusal names what jq_eval cannot run yet.
pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = serde_json::from_slice(config)
        .map_err(|e| StreamError::new(format!("bad jq_eval config: {e}")))?;
    let meter = Arc::new(Meter::limited(config.memory));
    let _metered = meter::install(&meter);
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
    let program = match compile::compile(&config.program, &globals) {
        Ok(program) => Some(Arc::new(program)),
        Err(Refusal::Unsupported(_)) if meter.exceeded() => None,
        Err(Refusal::Invalid(report)) => return Err(StreamError::new(report)),
        Err(Refusal::Unsupported(why)) => {
            return Err(StreamError::new(format!("jq_eval: {why}")));
        }
    };
    let clock = Clock {
        zone: config.zone.as_deref().and_then(Zone::parse).map(Arc::new),
    };
    let compile_limited = meter.exceeded();
    if !compile_limited
        && clock.zone.is_none()
        && program.as_ref().is_some_and(|program| {
            program.bytecodes.iter().flat_map(|bc| &bc.ops).any(|op| {
                matches!(
                    op,
                    Op::CallBuiltin(Cfunc::Localtime | Cfunc::StrfLocaltime | Cfunc::Strptime, _)
                )
            })
        })
    {
        return Err(StreamError::new("jq_eval: no time zone for local time"));
    }
    Ok(Box::new(Eval {
        program,
        limits: Limits {
            blocks: config.blocks,
            items: config.items,
            bytes: config.bytes,
            memory: config.memory,
        },
        meter,
        steps: config.steps.max(1),
        env,
        position: Position::default(),
        asking: Asking::No,
        clock,
        pending: Vec::new(),
        pending_charge: Charge::open(0),
        input_limited: compile_limited,
        compile_limited,
        receiving: None,
        printing: None,
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
            Message::Debug(line) => frame(DEBUG, line.as_bytes(), out),
            Message::Stderr(text) => frame(STDERR, text.as_bytes(), out),
        }
    }
    host.reset_messages();
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

fn memory_error_frame(limits: Limits, out: &mut Vec<u8>) {
    let text = format!("jq memory limit of {} bytes exceeded", limits.memory);
    out.push(ERROR);
    out.extend_from_slice(&((text.len() + 1) as u32).to_le_bytes());
    out.push(1);
    out.extend_from_slice(text.as_bytes());
}

impl Stream for Eval {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.state, State::Feeding) {
            return Err(StreamError::new("jq_eval: begin the next document first"));
        }
        let _metered = meter::install(&self.meter);
        if self.input_limited || self.meter.live().saturating_add(input.len()) > self.limits.memory
        {
            self.input_limited = true;
            return Ok(());
        }
        self.pending.extend_from_slice(input);
        self.pending_charge.set(self.pending.capacity());
        self.input_limited |= self.meter.exceeded();
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.state, State::Feeding) {
            return Err(StreamError::new("jq_eval: begin the next document first"));
        }
        let _metered = meter::install(&self.meter);
        if self.input_limited || self.meter.exceeded() {
            memory_error_frame(self.limits, out);
            self.pending = Vec::new();
            self.pending_charge.set(0);
            self.state = State::Ended;
            return Ok(());
        }
        let text = std::mem::take(&mut self.pending);
        self.pending_charge.set(0);
        self.state = State::Reading(Box::new(Parsing::document(text)));
        Ok(())
    }

    fn busy(&self) -> bool {
        match self.state {
            State::Running(_) => self.asking == Asking::No,
            State::Retiring(_) | State::Reading(_) => true,
            State::Feeding | State::Ended => false,
        }
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let _metered = meter::install(&self.meter);
        let mut budget = self.steps;
        if let State::Reading(parsing) = &mut self.state {
            let result = parsing.run(&mut budget);
            let limit = self.meter.exceeded();
            if result.is_none() && !limit {
                return Ok(());
            }
            if !limit {
                if let Some(Err(message)) = result {
                    return Err(StreamError::new(message));
                }
            }
            let State::Reading(parsing) = std::mem::replace(&mut self.state, State::Ended) else {
                unreachable!()
            };
            let (input, retired) = match result {
                Some(Ok(value)) if !limit => (value, None),
                Some(Ok(value)) => (Value::Null, Some(value)),
                _ => (Value::Null, None),
            };
            let mut vm = if limit {
                Box::new(Vm::retiring(
                    self.compiled(),
                    self.limits,
                    Arc::clone(&self.meter),
                ))
            } else {
                self.start_vm(input)
            };
            vm.retire_reading(parsing);
            if let Some(value) = retired {
                vm.retire_value(value);
            }
            self.state = if limit {
                State::Retiring(vm)
            } else {
                State::Running(vm)
            };
            if limit {
                memory_error_frame(self.limits, out);
                return Ok(());
            }
        }
        match &mut self.state {
            State::Running(_) if self.asking != Asking::No => {}
            State::Running(vm) => {
                let start = out.len();
                if let Some(parsing) = &mut self.receiving {
                    let result = parsing.run(&mut budget);
                    let limit = self.meter.exceeded();
                    if result.is_none() && !limit {
                        return Ok(());
                    }
                    if let Some(Err(message)) = &result {
                        if message == "jq_eval: document is not UTF-8" {
                            return Err(StreamError::new(message));
                        }
                    }
                    vm.retire_reading(self.receiving.take().expect("the host document reader"));
                    if limit {
                        if let Some(Ok(value)) = result {
                            vm.retire_value(value);
                        }
                        memory_error_frame(self.limits, out);
                    } else {
                        vm.host
                            .set_reply(match result.expect("a document or parse error") {
                                Ok(value) => Reply::Value(value),
                                Err(message) => Reply::Error(message),
                            });
                    }
                    if limit {
                        let State::Running(vm) = std::mem::replace(&mut self.state, State::Ended)
                        else {
                            unreachable!()
                        };
                        self.state = State::Retiring(vm);
                        return Ok(());
                    }
                }
                loop {
                    if let Some(printing) = &mut self.printing {
                        let text = printing.dumping.run(&mut budget);
                        if self.meter.exceeded() {
                            memory_error_frame(self.limits, out);
                            break;
                        }
                        let Some(text) = text else { return Ok(()) };
                        let printing = self.printing.take().expect("the completed output renderer");
                        vm.retire_output(printing.dumping);
                        match printing.kind {
                            PrintKind::Output => frame(OUTPUT, text.as_bytes(), out),
                            PrintKind::Error(string) => {
                                out.push(ERROR);
                                out.extend_from_slice(&((text.len() + 1) as u32).to_le_bytes());
                                out.push(u8::from(string));
                                out.extend_from_slice(text.as_bytes());
                                break;
                            }
                            PrintKind::HaltMessage(string, code) => {
                                self.printing = Some(Printing {
                                    dumping: Dumping::halt(Some(text), string, code),
                                    kind: PrintKind::HaltPayload,
                                });
                                continue;
                            }
                            PrintKind::HaltPayload => {
                                frame(HALT, text.as_bytes(), out);
                                break;
                            }
                        }
                        if budget == 0 || out.len() - start >= crate::PIECE {
                            return Ok(());
                        }
                    }
                    let next = vm.next(&mut budget);
                    if self.meter.exceeded() {
                        memory_error_frame(self.limits, out);
                        break;
                    }
                    message_frames(&mut vm.host, out);
                    match next {
                        Next::Output(value) => self.printing = Some(Printing::output(value)),
                        Next::Paused => return Ok(()),
                        Next::Input => {
                            self.asking = Asking::Pending;
                            return Ok(());
                        }
                        Next::Done => break,
                        Next::Error(raise) => self.printing = Some(Printing::error(raise)),
                        Next::Halt(halt) => self.printing = Some(Printing::halt(halt)),
                    }
                }
                let State::Running(mut vm) = std::mem::replace(&mut self.state, State::Ended)
                else {
                    unreachable!()
                };
                if let Some(dumping) = self.printing.take() {
                    vm.retire_output(dumping.dumping);
                }
                self.state = State::Retiring(vm);
                self.retire();
            }
            State::Retiring(_) => self.retire(),
            State::Reading(_) => unreachable!(),
            State::Feeding | State::Ended => {}
        }
        Ok(())
    }

    fn cancel(&mut self) -> bool {
        let _metered = meter::install(&self.meter);
        if matches!(self.state, State::Reading(_)) {
            let State::Reading(parsing) = std::mem::replace(&mut self.state, State::Ended) else {
                unreachable!()
            };
            let mut vm = Box::new(Vm::retiring(
                self.compiled(),
                self.limits,
                Arc::clone(&self.meter),
            ));
            vm.retire_reading(parsing);
            self.state = State::Retiring(vm);
        }
        if let State::Running(_) = self.state {
            let State::Running(vm) = std::mem::replace(&mut self.state, State::Ended) else {
                unreachable!()
            };
            self.state = State::Retiring(vm);
        }
        if let Some(parsing) = self.receiving.take() {
            if let State::Retiring(vm) = &mut self.state {
                vm.retire_reading(parsing);
            }
        }
        self.asking = Asking::No;
        self.pending = Vec::new();
        self.pending_charge.set(0);
        if let Some(dumping) = self.printing.take() {
            if let State::Retiring(vm) = &mut self.state {
                vm.retire_output(dumping.dumping);
            }
        }
        true
    }

    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        if matches!(
            self.state,
            State::Running(_) | State::Retiring(_) | State::Reading(_)
        ) {
            return Err(StreamError::new("jq_eval: the run has not ended"));
        }
        let _metered = meter::install(&self.meter);
        self.position = crate::parse_config(config)?;
        self.pending.clear();
        self.input_limited = self.compile_limited;
        self.meter.reset();
        self.state = State::Feeding;
        Ok(())
    }

    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let _ = data;
        if self.asking != Asking::Pending {
            return None;
        }
        let State::Running(vm) = &mut self.state else {
            return None;
        };
        self.asking = Asking::Taken;
        let request = match vm.host.asking.unwrap_or(Request::Input) {
            Request::Now => serde_json::json!({"op":"now"}),
            Request::Input => serde_json::json!({"op":"input"}),
        };
        Some(request.to_string().into_bytes())
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let State::Running(vm) = &mut self.state else {
            return Err(StreamError::new("jq_eval: the host answered no request"));
        };
        if self.asking != Asking::Taken {
            return Err(StreamError::new("jq_eval: the host answered no request"));
        }
        let _metered = meter::install(&self.meter);
        let reply: InputReply = crate::parse_config(reply)?;
        let asked = vm.host.asking.take().unwrap_or(Request::Input);
        match asked {
            Request::Now if reply.kind == "now" => {
                vm.host.now = Some(reply.now);
                self.asking = Asking::No;
                return Ok(());
            }
            Request::Now => {
                return Err(StreamError::new(format!(
                    "jq_eval: unknown reply {}",
                    reply.kind
                )));
            }
            Request::Input => {}
        }
        vm.host.set_reply(match reply.kind.as_str() {
            "value" => {
                if self.meter.live().saturating_add(data.len()) > self.limits.memory {
                    memory_error_frame(self.limits, out);
                    let State::Running(vm) = std::mem::replace(&mut self.state, State::Ended)
                    else {
                        unreachable!()
                    };
                    self.state = State::Retiring(vm);
                    self.asking = Asking::No;
                    return Ok(());
                }
                self.receiving = Some(Box::new(Parsing::document(data.to_vec())));
                self.asking = Asking::No;
                place(
                    &mut vm.host,
                    Position {
                        filename: reply.filename,
                        line: reply.line,
                    },
                );
                return Ok(());
            }
            "end" => Reply::End,
            "error" => Reply::Error(
                std::str::from_utf8(data)
                    .map_err(|_| StreamError::new("jq_eval: document is not UTF-8"))?
                    .to_string(),
            ),
            other => return Err(StreamError::new(format!("jq_eval: unknown reply {other}"))),
        });
        place(
            &mut vm.host,
            Position {
                filename: reply.filename,
                line: reply.line,
            },
        );
        self.asking = Asking::No;
        Ok(())
    }
}

impl Drop for Eval {
    fn drop(&mut self) {
        let _metered = meter::install(&self.meter);
        self.printing = None;
        drop(std::mem::replace(&mut self.state, State::Ended));
    }
}

impl Eval {
    fn compiled(&self) -> Arc<Program> {
        Arc::clone(
            self.program
                .as_ref()
                .expect("a runnable stream has compiled bytecode"),
        )
    }

    fn start_vm(&mut self, input: Value) -> Box<Vm> {
        let mut vm = Vm::start(self.compiled(), input, self.limits, Arc::clone(&self.meter));
        vm.host.env = self.env.clone();
        place(&mut vm.host, std::mem::take(&mut self.position));
        vm.set_clock(self.clock.clone());
        Box::new(vm)
    }

    fn retire(&mut self) {
        if let State::Retiring(vm) = &mut self.state {
            if vm.retire(RETIRE) {
                self.state = State::Ended;
            }
        }
    }
}
