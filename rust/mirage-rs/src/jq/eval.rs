use std::collections::HashMap;
use std::sync::Arc;

use crate::{Stream, StreamError};

use super::compile;
use super::format::{self, Formatter};
use super::host::{Host, Message, Reply, Request};
use super::meter::{self, Charge, Meter};
use super::time::{Clock, Zone};
use super::value::{Dumping, Key, Object, Parsing, Value, parse_json};
use super::vm::{Halt, Limits, Next, Program, Raise, Vm};

pub(super) const STEPS: u64 = 1 << 16;
pub(super) const BLOCKS: usize = 1 << 20;
pub(super) const ITEMS: usize = 1 << 24;
pub(super) const BYTES: usize = 1 << 28;
pub(super) const MEMORY: usize = 1 << 30;
const RETIRE: usize = 1 << 14;

pub(crate) const OUTPUT: u8 = 1;
pub(crate) const ERROR: u8 = 2;
pub(crate) const HALT: u8 = 3;
pub(crate) const DEBUG: u8 = 4;
pub(crate) const STDERR: u8 = 5;
pub(crate) const PRINT: u8 = 6;

/// The steps one slice of the printer costs, at the rate a dump is
/// charged: a step for every 64 bytes it handles.
const PRINT_SLICE: u64 = (format::LIMIT / 64) as u64;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    program: String,
    /// The `--arg`, `--argjson`, `--rawfile` and `--slurpfile` bindings as
    /// name and JSON text, in the order they were bound; each binds `$name`
    /// when the name is one.
    #[serde(default)]
    named: Vec<(String, String)>,
    /// The JSON text of each `$ARGS.positional` value; given, `$ARGS` is
    /// bound, its `named` sharing the bindings' values.
    #[serde(default)]
    positional: Option<Vec<String>>,
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
    /// The directory of the program's file, else the working directory,
    /// which `get_prog_origin` answers.
    #[serde(default)]
    prog_origin: Option<String>,
    /// The options jq prints its outputs by: each output
    /// then goes out printed, in a print frame, instead of as its dump.
    #[serde(default)]
    print: Option<format::Config>,
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
pub(super) struct Position {
    pub(super) filename: Option<String>,
    pub(super) line: f64,
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
    /// Whether the error is a string, and whether the program raised it
    /// with `error` itself.
    Error(bool, bool),
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
        let (value, own) = loop {
            match raise {
                Raise::Error(value) => break (value, false),
                Raise::Own(value) => break (value, true),
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
            kind: PrintKind::Error(string, own),
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

/// One output going through jq's printer a bounded slice at a time: its
/// compact dump fed to the formatter a piece a slice, and what it printed
/// since it last went out, after a byte that says whether the output was
/// null or false, which `-e` reads.
pub(super) struct Formatting {
    formatter: Formatter,
    text: String,
    fed: usize,
    printed: Vec<u8>,
    finished: bool,
    refused: Option<StreamError>,
}

impl Formatting {
    pub(super) fn begin(options: &format::Config, text: String) -> Self {
        let printed = vec![u8::from(text == "null" || text == "false")];
        Self {
            formatter: Formatter::new(options.clone()),
            text,
            fed: 0,
            printed,
            finished: false,
            refused: None,
        }
    }

    /// Print on while the budget lasts: None until the output is printed,
    /// then the formatter's refusal of it, if it refused it.
    pub(super) fn run(&mut self, budget: &mut u64) -> Option<Result<(), StreamError>> {
        while self.refused.is_none() && (!self.finished || self.formatter.busy()) {
            if *budget == 0 {
                return None;
            }
            let printed = if self.fed < self.text.len() {
                let end = (self.fed + format::LIMIT).min(self.text.len());
                self.formatter
                    .feed(&self.text.as_bytes()[self.fed..end], &mut self.printed)
                    .expect("a formatter takes a value's pieces");
                self.fed = end;
                Ok(())
            } else if self.finished {
                self.formatter.drain(&mut self.printed)
            } else {
                self.finished = true;
                self.text = String::new();
                self.formatter.finish(&mut self.printed)
            };
            self.refused = printed.err();
            *budget = budget.saturating_sub(PRINT_SLICE);
        }
        Some(self.refused.take().map_or(Ok(()), Err))
    }

    /// Send what it printed so far in a print frame.
    fn flush(&mut self, out: &mut Vec<u8>) {
        frame(PRINT, &self.printed, out);
        self.printed.truncate(1);
    }

    /// Hand on what it printed so far.
    pub(super) fn take(&mut self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.printed[1..]);
        self.printed.truncate(1);
    }

    /// Give it up: the formatter frees what it holds through its own
    /// bounded discard, which `discard` runs.
    fn cancel(&mut self) {
        self.text = String::new();
        self.formatter
            .begin(br#"{"discard":true}"#)
            .expect("a formatter discards at any point");
    }

    /// Free one slice of what a cancelled output holds; whether it is all
    /// gone.
    fn discard(&mut self) -> bool {
        self.formatter
            .drain(&mut Vec::new())
            .expect("a discarded output prints nothing");
        !self.formatter.busy()
    }
}

/// One jq program run over documents one at a time, on the host's own
/// thread: `open` compiles it, each document is fed, `finish` starts the
/// run, and every `drain` executes a bounded number of VM steps, so a
/// program that never ends still hands control back.
///
/// `drain` writes frames: an output's compact dump, an error that ended
/// the run (a flag byte, then its text: bit 0 set for a string, bit 1 when
/// the program raised it with `error` itself), a halt (JSON), what `debug`
/// prints (the compact dump of `["DEBUG:", value]`), and what `stderr`
/// writes (the bytes). An output is dumped on the same step budget, so
/// a large one takes several drains and its frame goes out whole once
/// it is written. Given jq's printer options as `print`, the stream prints
/// each output itself, on that budget too, and writes print frames
/// instead: a byte set when the output was null or false, then the bytes
/// printed since the last, at least one frame an output and its last
/// when it is printed whole; an output `--raw-output0` cannot print ends
/// the run with jq's error. `begin` readies the stream for the next document,
/// with the reader's position; `cancel` retires the run's stack a bounded
/// slice per `drain`.
///
/// `input` pauses the run: `busy` turns false, `request` asks the host
/// for `{"op": "input"}`, and `respond` takes the next document, the end
/// of the stream, or the reader's parse error, as jq's input callback
/// answers it, and the reader's position after it.
pub(super) struct Eval {
    program: Arc<Program>,
    limits: Limits,
    meter: Arc<Meter>,
    steps: u64,
    env: Value,
    origin: Value,
    position: Position,
    asking: Asking,
    clock: Clock,
    pending: Vec<u8>,
    pending_charge: Charge,
    input_limited: bool,
    compile_limited: bool,
    receiving: Option<Box<Parsing>>,
    printing: Option<Printing>,
    print: Option<format::Config>,
    formatting: Option<Box<Formatting>>,
    state: State,
}

/// Compile the configured program. A program jq itself refuses is
/// refused with jq's report, whose last line is its `jq: N compile
/// error(s)` count; any other refusal names what jq_eval cannot run yet.
pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(compile(config)?))
}

/// The configured program compiled, as `open` refuses it.
pub(super) fn compile(config: &[u8]) -> Result<Eval, StreamError> {
    let config: Config = serde_json::from_slice(config)
        .map_err(|e| StreamError::new(format!("bad jq_eval config: {e}")))?;
    let meter = Arc::new(Meter::limited(config.memory));
    let _metered = meter::install(&meter);
    let mut globals = HashMap::new();
    let mut named = config.positional.is_some().then(Object::default);
    for (name, text) in &config.named {
        let value = json(text)?;
        if let Some(named) = &mut named {
            named.insert(Key::from(name.as_str()), value.clone());
        }
        if is_ident(name) {
            globals.insert(name.clone(), value);
        }
    }
    if let (Some(positional), Some(named)) = (&config.positional, named) {
        let positional = positional
            .iter()
            .map(|text| json(text))
            .collect::<Result<_, _>>()?;
        let mut args = Object::default();
        args.insert(Key::from("positional"), Value::array(positional));
        args.insert(Key::from("named"), Value::object(named));
        globals.insert("ARGS".to_string(), Value::object(args));
    }
    let env = match &config.env {
        Some(text) => json(text)?,
        None => Value::object(Object::default()),
    };
    // jq binds `$ENV` to the environment over an `--arg ENV` (compile.c).
    globals.insert("ENV".to_string(), env.clone());
    let program = Arc::new(compile::compile(&config.program, &globals).map_err(StreamError::new)?);
    let clock = Clock {
        zone: Arc::new(Zone::parse(config.zone.as_deref().unwrap_or("UTC"))),
    };
    let compile_limited = meter.exceeded();
    Ok(Eval {
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
        origin: config.prog_origin.map_or(Value::Null, Value::string),
        position: Position::default(),
        asking: Asking::No,
        clock,
        pending: Vec::new(),
        pending_charge: Charge::open(0),
        input_limited: compile_limited,
        compile_limited,
        receiving: None,
        printing: None,
        print: config.print,
        formatting: None,
        state: State::Feeding,
    })
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

/// The error a run ends with once it holds more than `memory` bytes.
pub(super) fn memory_report(memory: usize) -> String {
    format!("jq memory limit of {memory} bytes exceeded")
}

/// An error frame: its flag byte (bit 0 for a string, bit 1 when the
/// program raised it with `error` itself), then its text.
fn error_frame(flags: u8, text: &str, out: &mut Vec<u8>) {
    out.push(ERROR);
    out.extend_from_slice(&((text.len() + 1) as u32).to_le_bytes());
    out.push(flags);
    out.extend_from_slice(text.as_bytes());
}

fn memory_error_frame(limits: Limits, out: &mut Vec<u8>) {
    error_frame(1, &memory_report(limits.memory), out);
}

impl Stream for Eval {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.state, State::Feeding) {
            return Err(StreamError::new("jq_eval: begin the next document first"));
        }
        let _metered = meter::install(&self.meter);
        let growth = self
            .pending
            .len()
            .saturating_add(input.len())
            .saturating_sub(self.pending.capacity());
        if self.input_limited || self.meter.live().saturating_add(growth) > self.limits.memory {
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
                    if let Some(formatting) = &mut self.formatting {
                        let Some(printed) = formatting.run(&mut budget) else {
                            if formatting.printed.len() > 1 {
                                formatting.flush(out);
                            }
                            return Ok(());
                        };
                        let mut formatting = self.formatting.take().expect("the printed output");
                        if let Err(refusal) = printed {
                            error_frame(1, &refusal.message, out);
                            break;
                        }
                        formatting.flush(out);
                        if budget == 0 || out.len() - start >= crate::PIECE {
                            return Ok(());
                        }
                    }
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
                            PrintKind::Output => match &self.print {
                                None => frame(OUTPUT, text.as_bytes(), out),
                                Some(options) => {
                                    self.formatting =
                                        Some(Box::new(Formatting::begin(options, text)));
                                    continue;
                                }
                            },
                            PrintKind::Error(string, own) => {
                                error_frame(u8::from(string) | u8::from(own) << 1, &text, out);
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
                self.formatting = None;
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
        if let Some(formatting) = &mut self.formatting {
            formatting.cancel();
        }
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
        Arc::clone(&self.program)
    }

    /// The meter its runs are charged to, which the documents jq's main
    /// loop reads for them are charged to as they are read.
    pub(super) fn meter(&self) -> Arc<Meter> {
        Arc::clone(&self.meter)
    }

    /// Start a run on `input`, read with the reader at `place`. A run
    /// whose input took the memory past its limit ends with jq's error
    /// for it instead, and retires the input.
    pub(super) fn start(
        &mut self,
        position: Position,
        input: Value,
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if matches!(
            self.state,
            State::Running(_) | State::Retiring(_) | State::Reading(_)
        ) {
            return Err(StreamError::new("jq_eval: the run has not ended"));
        }
        let _metered = meter::install(&self.meter);
        self.position = position;
        if self.compile_limited || self.meter.exceeded() {
            memory_error_frame(self.limits, out);
            let mut vm = Box::new(Vm::retiring(
                self.compiled(),
                self.limits,
                Arc::clone(&self.meter),
            ));
            vm.retire_value(input);
            self.state = State::Retiring(vm);
            return Ok(());
        }
        self.state = State::Running(self.start_vm(input));
        Ok(())
    }

    /// Answer the run's `input` with the next document as a value, and
    /// where the reader stands after it.
    pub(super) fn answer(
        &mut self,
        position: Position,
        input: Value,
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let State::Running(vm) = &mut self.state else {
            return Err(StreamError::new("jq_eval: the host answered no request"));
        };
        if self.asking != Asking::Taken || vm.host.asking.take() == Some(Request::Now) {
            return Err(StreamError::new("jq_eval: the host answered no request"));
        }
        let _metered = meter::install(&self.meter);
        self.asking = Asking::No;
        if self.meter.exceeded() {
            memory_error_frame(self.limits, out);
            let State::Running(mut vm) = std::mem::replace(&mut self.state, State::Ended) else {
                unreachable!()
            };
            vm.retire_value(input);
            self.state = State::Retiring(vm);
            return Ok(());
        }
        vm.host.set_reply(Reply::Value(input));
        place(&mut vm.host, position);
        Ok(())
    }

    fn start_vm(&mut self, input: Value) -> Box<Vm> {
        let mut vm = Vm::start(self.compiled(), input, self.limits, Arc::clone(&self.meter));
        vm.host.env = self.env.clone();
        vm.host.origin = self.origin.clone();
        place(&mut vm.host, std::mem::take(&mut self.position));
        vm.set_clock(self.clock.clone());
        Box::new(vm)
    }

    fn retire(&mut self) {
        if let Some(formatting) = &mut self.formatting {
            if formatting.discard() {
                self.formatting = None;
            }
            return;
        }
        if let State::Retiring(vm) = &mut self.state {
            if vm.retire(RETIRE) {
                self.state = State::Ended;
            }
        }
    }
}
