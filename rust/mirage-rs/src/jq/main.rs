// Adapted from jq 1.8.2 (MIT), src/main.c and src/util.c. See licenses/third_party/jq.txt.

use std::collections::VecDeque;

use serde::Deserialize;

use crate::{Stream, StreamError};

use super::eval::{self, DEBUG, ERROR, Formatting, HALT, PRINT, STDERR};
use super::format;
use super::parse;
use super::unicode::{Bytes, DecodeCursor, WORK};

/// The most bytes one read of jq's input reader takes (util.c): fgets
/// into a 4096-byte buffer, less the four bytes it keeps for UTF-8 and
/// the NUL. A read stops after a newline, and one that ends inside a
/// character reads on to the end of it.
const READ_CHUNK: usize = 4091;

/// The bytes one `drain` moves through the reader before it hands
/// control back; a scanner step counts as a whole chunk of its input.
const SLICE: usize = 4 * WORK;

/// The share of a slice one run costs, so a stream of small documents
/// still hands control back every thousand or so.
const RUN: usize = 64;

/// What jq's process() answers for one run (main.c): the last output was
/// not false or null, it was, there was none, and an error no `try`
/// caught ended the run.
const OK: f64 = 0.0;
const OK_NULL_KIND: f64 = -1.0;
const OK_NO_OUTPUT: f64 = -4.0;
const ERROR_UNKNOWN: f64 = 5.0;

/// jq's exit status when it could not read one of its inputs, whatever
/// the runs answered.
const ERROR_SYSTEM: i32 = 2;

/// What the stream fails with once what jq holds outgrows the memory it
/// was given, which the host reports as the workspace's own refusal.
pub(crate) const EXHAUSTED: &str = "memory exhausted";

const WHITESPACE: &[u8] = b" \t\r\n";

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    program: String,
    /// The `--arg`, `--argjson`, `--rawfile` and `--slurpfile` bindings
    /// as name and JSON text, in the order they were bound, which
    /// `$ARGS.named` lists them in.
    named: Vec<(String, String)>,
    /// The JSON text of each `$ARGS.positional` value.
    positional: Vec<String>,
    env: Option<String>,
    zone: Option<String>,
    prog_origin: Option<String>,
    /// The bytes jq may hold, the workspace's room; None for jq_eval's
    /// own limit, which a run reports as its error instead.
    memory: Option<usize>,
    steps: Option<u64>,
    /// The inputs' names as jq's reports and `input_filename` give them,
    /// in the order they are read.
    inputs: Vec<String>,
    null_input: bool,
    raw_input: bool,
    slurp: bool,
    stream: bool,
    seq: bool,
    exit_status: bool,
    raw_output: bool,
    join_output: bool,
    nul_output: bool,
    ascii_output: bool,
    sort_keys: bool,
    compact: bool,
    tab: bool,
    indent: u8,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            program: ".".to_string(),
            named: Vec::new(),
            positional: Vec::new(),
            env: None,
            zone: None,
            prog_origin: None,
            memory: None,
            steps: None,
            inputs: Vec::new(),
            null_input: false,
            raw_input: false,
            slurp: false,
            stream: false,
            seq: false,
            exit_status: false,
            raw_output: false,
            join_output: false,
            nul_output: false,
            ascii_output: false,
            sort_keys: false,
            compact: false,
            tab: false,
            indent: 2,
        }
    }
}

/// The host's answer to a read: the input's next bytes, its end, or why
/// it could not be opened or read, as strerror words it, and whether the
/// failure came from reading rather than opening.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadReply {
    kind: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    read: bool,
}

/// One input of the invocation, as jq's reader reads it.
#[derive(Default)]
struct Input {
    pending: Vec<u8>,
    start: usize,
    drained: bool,
    feof: bool,
    fresh: bool,
    failed: bool,
}

impl Input {
    fn rest(&self) -> &[u8] {
        &self.pending[self.start..]
    }

    fn take(&mut self, size: usize) -> Vec<u8> {
        let piece = self.pending[self.start..self.start + size].to_vec();
        self.start += size;
        if self.start * 2 > self.pending.len() {
            self.pending.drain(..self.start);
            self.start = 0;
        }
        piece
    }
}

/// jq's scanner over the pieces the reader reads, a document's text or
/// its parse error at a time.
struct Parser {
    scanner: Box<dyn Stream>,
    wire: Vec<u8>,
    at: usize,
    parts: Vec<u8>,
    input: Vec<u8>,
    fed: usize,
    last: bool,
    finished: bool,
}

enum Parsed {
    Text(Vec<u8>),
    Error(String),
    /// It did this much work and may have more.
    Worked(usize),
    /// It needs the next piece, or has read the last.
    Empty,
}

impl Parser {
    fn new(seq: bool, streaming: bool) -> Result<Self, StreamError> {
        let config = serde_json::json!({ "seq": seq, "streaming": streaming });
        Ok(Self {
            scanner: parse::open(config.to_string().as_bytes())?,
            wire: Vec::new(),
            at: 0,
            parts: Vec::new(),
            input: Vec::new(),
            fed: 0,
            last: false,
            finished: false,
        })
    }

    fn feed(&mut self, piece: Vec<u8>, partial: bool) {
        self.input = piece;
        self.fed = 0;
        self.last = !partial;
    }

    fn next(&mut self) -> Result<Parsed, StreamError> {
        while self.at + 5 <= self.wire.len() {
            let size = u32::from_le_bytes(
                self.wire[self.at + 1..self.at + 5]
                    .try_into()
                    .expect("4 bytes"),
            ) as usize;
            if self.at + 5 + size > self.wire.len() {
                break;
            }
            let tag = self.wire[self.at];
            let payload = self.at + 5..self.at + 5 + size;
            self.at += 5 + size;
            match tag {
                1 => self.parts.extend_from_slice(&self.wire[payload]),
                2 => return Ok(Parsed::Text(std::mem::take(&mut self.parts))),
                3 => {
                    return Ok(Parsed::Error(
                        String::from_utf8_lossy(&self.wire[payload]).into_owned(),
                    ));
                }
                _ => return Err(StreamError::new("jq: unknown scanner frame")),
            }
        }
        self.wire.drain(..self.at);
        self.at = 0;
        if self.scanner.busy() {
            self.scanner.drain(&mut self.wire)?;
            return Ok(Parsed::Worked(WORK));
        }
        if self.fed < self.input.len() {
            let stop = (self.fed + WORK).min(self.input.len());
            self.scanner
                .feed(&self.input[self.fed..stop], &mut self.wire)?;
            let size = stop - self.fed;
            self.fed = stop;
            return Ok(Parsed::Worked(size));
        }
        if self.last && !self.finished {
            self.finished = true;
            self.scanner.finish(&mut self.wire)?;
            return Ok(Parsed::Worked(WORK));
        }
        Ok(Parsed::Empty)
    }

    fn discard(&mut self) {
        self.wire = Vec::new();
        self.parts = Vec::new();
        self.input = Vec::new();
        let _ = self.scanner.begin(br#"{"discard":true}"#);
    }
}

enum Slurp {
    Json(Vec<Vec<u8>>),
    Raw(String),
}

/// What the reader has next: a document's JSON text, the parse error
/// that stops it, the end of the stream, a wait on the host for the
/// next bytes of an input, or a slice of work spent.
enum Read {
    Text(Vec<u8>),
    Error(String),
    End,
    Wait(usize),
    Working,
}

/// The next piece of jq's read_more, or a wait on the host for an
/// input's bytes.
enum Piece {
    Got(Vec<u8>, bool),
    Wait(usize),
}

/// jq's input reader (util.c) over every input of an invocation.
///
/// One scanner reads all of them, one after another, so a value can run
/// on from one input into the next the way it does in jq (`1` then `2`
/// read as `12`), and a parse error counts its lines across the inputs.
/// The scanner is fed the pieces jq's fgets reads, so the position a run
/// reports, the input's name and the lines read of it, is jq's. Under -R
/// the pieces make up the lines, which also run on from one input into
/// the next when one lacks its final newline.
///
/// An input is opened when the reader reaches it, and one that cannot be
/// opened or read is reported in the words of jq's reader, counted, and
/// the reader moves on to the next.
struct Reader {
    names: Vec<String>,
    opened: usize,
    input: Option<Input>,
    name: Option<String>,
    line: u64,
    failures: usize,
    parser: Option<Parser>,
    json_eof: bool,
    slurp: Option<Slurp>,
    /// The bytes read into memory: a raw line the pieces read of it, a
    /// raw slurp the whole input, and a JSON value what was read of it
    /// from its first byte; and the values a slurp keeps.
    held: usize,
    kept: usize,
    memory: Option<usize>,
    raw_line: Option<String>,
}

impl Reader {
    fn new(config: &Config) -> Result<Self, StreamError> {
        let parser = if config.raw_input {
            None
        } else {
            Some(Parser::new(config.seq, config.stream)?)
        };
        let slurp = config.slurp.then(|| {
            if config.raw_input {
                Slurp::Raw(String::new())
            } else {
                Slurp::Json(Vec::new())
            }
        });
        Ok(Self {
            names: config.inputs.clone(),
            opened: 0,
            input: None,
            name: None,
            line: 0,
            failures: 0,
            parser,
            json_eof: false,
            slurp,
            held: 0,
            kept: 0,
            memory: config.memory,
            raw_line: None,
        })
    }

    /// Where the reader stands as jq's error reports word it.
    fn position(&self) -> String {
        match &self.name {
            None => "<unknown>".to_string(),
            Some(name) => format!("{name}:{}", self.line),
        }
    }

    /// Where the reader stands as jq_eval takes it: the input it reads
    /// and the lines read of it.
    fn place(&self) -> serde_json::Value {
        serde_json::json!({ "filename": self.name, "line": self.line })
    }

    fn check(&self, size: usize) -> Result<(), StreamError> {
        match self.memory {
            Some(memory) if size > memory => Err(StreamError::new(EXHAUSTED)),
            _ => Ok(()),
        }
    }

    fn count(&mut self, size: usize) -> Result<(), StreamError> {
        self.held += size;
        self.check(self.kept + self.held)
    }

    /// The next value of the stream (jq_util_input_next_input). Under -s
    /// the one value is the whole stream; a parse error comes back
    /// instead of it.
    fn next(&mut self, budget: &mut usize) -> Result<Read, StreamError> {
        if self.parser.is_none() {
            return self.next_line(budget);
        }
        loop {
            if *budget == 0 {
                return Ok(Read::Working);
            }
            match self.parser.as_mut().expect("a JSON reader").next()? {
                Parsed::Error(message) => {
                    self.held = 0;
                    return Ok(Read::Error(message));
                }
                Parsed::Text(text) => {
                    self.held = 0;
                    let Some(Slurp::Json(texts)) = &mut self.slurp else {
                        return Ok(Read::Text(text));
                    };
                    self.kept += text.len() + 1;
                    texts.push(text);
                    self.check(self.kept)?;
                    continue;
                }
                Parsed::Worked(work) => {
                    *budget = budget.saturating_sub(work);
                    continue;
                }
                Parsed::Empty => {}
            }
            if self.json_eof {
                break;
            }
            let (piece, last) = match self.read_more() {
                Piece::Wait(index) => return Ok(Read::Wait(index)),
                Piece::Got(piece, last) => (piece, last),
            };
            self.json_eof = last;
            let size = if self.held > 0 {
                piece.len()
            } else {
                piece.len() - piece.iter().take_while(|b| WHITESPACE.contains(b)).count()
            };
            self.count(size)?;
            *budget = budget.saturating_sub(piece.len());
            self.parser
                .as_mut()
                .expect("a JSON reader")
                .feed(piece, !last);
        }
        self.take_slurped()
    }

    fn next_line(&mut self, budget: &mut usize) -> Result<Read, StreamError> {
        loop {
            if *budget == 0 {
                return Ok(Read::Working);
            }
            let (piece, last) = match self.read_more() {
                Piece::Wait(index) => return Ok(Read::Wait(index)),
                Piece::Got(piece, last) => (piece, last),
            };
            *budget = budget.saturating_sub(piece.len().max(1));
            if !piece.is_empty() {
                self.count(piece.len())?;
                if let Some(Slurp::Raw(text)) = &mut self.slurp {
                    text.push_str(&decode(&piece));
                } else if piece.ends_with(b"\n") {
                    self.held = 0;
                    let mut line = self.raw_line.take().unwrap_or_default();
                    line.push_str(&decode(&piece[..piece.len() - 1]));
                    return Ok(Read::Text(string_text(&line)));
                } else {
                    self.raw_line
                        .get_or_insert_with(String::new)
                        .push_str(&decode(&piece));
                }
            }
            if last {
                break;
            }
        }
        if self.slurp.is_some() {
            return self.take_slurped();
        }
        Ok(match self.raw_line.take() {
            None => Read::End,
            Some(line) => Read::Text(string_text(&line)),
        })
    }

    fn take_slurped(&mut self) -> Result<Read, StreamError> {
        Ok(match self.slurp.take() {
            None => Read::End,
            Some(Slurp::Raw(text)) => Read::Text(string_text(&text)),
            Some(Slurp::Json(texts)) => {
                self.check(self.kept + 1)?;
                let mut text = Vec::with_capacity(self.kept + 1);
                text.push(b'[');
                for (i, each) in texts.into_iter().enumerate() {
                    if i > 0 {
                        text.push(b',');
                    }
                    text.extend_from_slice(&each);
                }
                text.push(b']');
                Read::Text(text)
            }
        })
    }

    /// jq's read_more: the next piece of the input, and whether the stream
    /// is used up, which a piece comes back empty for.
    fn read_more(&mut self) -> Piece {
        if self.input.as_ref().is_none_or(|input| input.feof) {
            self.input = None;
            if self.opened < self.names.len() {
                self.name = Some(self.names[self.opened].clone());
                self.opened += 1;
                self.line = 0;
                self.input = Some(Input {
                    fresh: true,
                    ..Input::default()
                });
            }
        }
        let piece = match &mut self.input {
            None => Vec::new(),
            Some(input) => match read_piece(input, &mut self.line) {
                Some(piece) => piece,
                None => return Piece::Wait(self.opened - 1),
            },
        };
        let last = self.opened == self.names.len() && self.input.is_none();
        Piece::Got(piece, last)
    }

    /// Take the host's answer to a read of the current input: its next
    /// bytes, its end, or a failure, which is reported in the words of
    /// jq's reader (fopen's names the input, a failed read is the bare
    /// strerror). The input ends there, and the line fgets was reading
    /// when it failed is lost with it.
    fn supply(
        &mut self,
        reply: ReadReply,
        data: &[u8],
        stderr: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| StreamError::new("jq: no input is being read"))?;
        match reply.kind.as_str() {
            "data" => {
                input.pending.extend_from_slice(data);
                input.fresh = input.fresh && data.is_empty();
            }
            "end" => input.drained = true,
            "error" => {
                let name = self.name.as_deref().unwrap_or_default();
                let line = if input.fresh && !reply.read {
                    format!("jq: error: Could not open file {name}: {}\n", reply.message)
                } else {
                    format!("jq: error: {}\n", reply.message)
                };
                stderr.extend_from_slice(line.as_bytes());
                self.failures += 1;
                input.failed = true;
                input.drained = true;
            }
            other => return Err(StreamError::new(format!("jq: unknown read reply {other}"))),
        }
        Ok(())
    }

    fn discard(&mut self) {
        self.input = None;
        self.slurp = None;
        self.raw_line = None;
        if let Some(parser) = &mut self.parser {
            parser.discard();
        }
    }

    fn retiring(&self) -> bool {
        self.parser
            .as_ref()
            .is_some_and(|parser| parser.scanner.busy())
    }

    fn retire(&mut self) {
        if let Some(parser) = &mut self.parser {
            let _ = parser.scanner.drain(&mut Vec::new());
        }
    }
}

/// One fgets of jq's reader: up to and including a newline, or
/// READ_CHUNK bytes read on to the end of a character, or what is left
/// once the input has ended; None while it waits on more bytes.
fn read_piece(input: &mut Input, line: &mut u64) -> Option<Vec<u8>> {
    let rest = input.rest();
    let window = &rest[..rest.len().min(READ_CHUNK)];
    if let Some(newline) = memchr::memchr(b'\n', window) {
        *line += 1;
        return Some(input.take(newline + 1));
    }
    if rest.len() >= READ_CHUNK {
        let missing = utf8_missing(&rest[..READ_CHUNK]);
        let more = rest.len() - READ_CHUNK;
        if missing > more && !input.drained {
            return None;
        }
        return Some(input.take(READ_CHUNK + missing.min(more)));
    }
    if input.drained {
        let size = rest.len();
        let piece = input.take(size);
        input.feof = true;
        return Some(if input.failed { Vec::new() } else { piece });
    }
    None
}

/// The bytes needed to finish a reader piece's last UTF-8 character.
fn utf8_missing(piece: &[u8]) -> usize {
    let mut at = piece.len() - 1;
    if at == 0 {
        return 0;
    }
    let mut seen = 1;
    while (0x80..0xC0).contains(&piece[at]) {
        if at == 0 {
            break;
        }
        at -= 1;
        seen += 1;
    }
    let length: usize = match piece[at] {
        0x00..0x80 => 1,
        0xC2..0xE0 => 2,
        0xE0..0xF0 => 3,
        0xF0..=0xF4 => 4,
        _ => 0,
    };
    length.saturating_sub(seen)
}

/// Raw bytes as text, by jq's rules for malformed sequences.
fn decode(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let mut held = Bytes::default();
    held.extend(bytes);
    let mut out = Vec::with_capacity(bytes.len() + 2);
    let mut budget = usize::MAX;
    DecodeCursor::default().write(&mut held, &mut out, usize::MAX, &mut budget);
    String::from_utf8(out).expect("the decoder writes UTF-8")
}

fn string_text(text: &str) -> Vec<u8> {
    serde_json::to_vec(text).expect("a string encodes")
}

/// How a run ended early: an error no `try` caught (its text, whether it
/// is a string), or a halt (its message, whether that is a string, and
/// its exit code).
enum Stop {
    Error(String, bool),
    Halt(Option<String>, bool, Option<f64>),
}

#[derive(Deserialize)]
struct HaltFrame {
    message: Option<String>,
    string: bool,
    code: Option<f64>,
}

/// A line `debug` or `stderr` wrote, in order: `debug`'s goes through
/// jq's dumper first.
enum Message {
    Debug(Box<Formatting>),
    Text(Vec<u8>),
}

#[derive(Clone, Copy, PartialEq)]
enum Task {
    /// The main loop reads its next document.
    Next,
    /// A run is going.
    Run,
    /// A run's `input` waits on the reader.
    Input,
    /// The loop has ended.
    Done,
}

#[derive(Clone, Copy, PartialEq)]
enum Ask {
    Read(usize),
    Now,
}

/// jq's main loop (main.c) over an invocation's input stream.
///
/// Each document runs as soon as the reader parses it, and its outputs
/// print as the run makes them. A run's error is reported and the next
/// document runs; a halt ends the loop; a parse error is reported with
/// status 5 and ends it, except under --seq, which reports it and reads
/// on. Under -n the program runs once, on null. Its `input` and `inputs`
/// take each document from the reader when they ask for it, as jq's
/// input callback does, so the next run starts after the documents the
/// program consumed, and `debug` and `stderr` lines go to stderr in the
/// order they were written, before the run's own report.
///
/// An input that cannot be opened or read is reported when the reader
/// reaches it, and the reader goes on to the next. The loop checks for
/// such a failure before each document it reads, so it stops after the
/// run of the document the failing read went on to, and the exit status
/// is 2 whatever the runs answered.
///
/// `drain` writes what the runs print. The stream asks the host for
/// `{"op": "read", "input": i}`, answered with `{"kind": "data"}` and the
/// input's next bytes, `{"kind": "end"}`, or `{"kind": "error",
/// "message": strerror, "read": bool}`, and for `{"op": "now"}`, answered
/// as jq_eval takes it. Once it is done, `status` is jq's exit status and
/// `take_stderr` what it wrote to stderr.
struct Main {
    eval: Box<dyn Stream>,
    reader: Reader,
    debug: format::Config,
    null_input: bool,
    seq: bool,
    exit_status: bool,
    memory: Option<usize>,
    task: Task,
    asking: Option<Ask>,
    taken: bool,
    wire: Vec<u8>,
    messages: VecDeque<Message>,
    stop: Option<Stop>,
    printed: bool,
    falsy: bool,
    ran: bool,
    /// Whether the loop is in the middle of reading a document, which a
    /// failed input stops only once it is read.
    reading: bool,
    ret: f64,
    last_result: i8,
    stderr: Vec<u8>,
    status: i32,
    cancelled: bool,
}

/// Compile the configured program. A program jq itself refuses is
/// refused with jq's report, whose last line is its `jq: N compile
/// error(s)` count.
pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = crate::parse_config(config)?;
    let mut named = serde_json::Map::new();
    let mut args_named = Vec::with_capacity(config.named.len());
    for (name, text) in &config.named {
        named.insert(name.clone(), serde_json::Value::String(text.clone()));
        args_named.push(format!(
            "{}:{text}",
            serde_json::to_string(name).expect("a name encodes")
        ));
    }
    let args = format!(
        r#"{{"positional":[{}],"named":{{{}}}}}"#,
        config.positional.join(","),
        args_named.join(",")
    );
    let print = serde_json::json!({
        "raw_output": config.raw_output || config.join_output || config.nul_output,
        "join_output": config.join_output,
        "nul_output": config.nul_output,
        "compact": config.compact,
        "ascii_output": config.ascii_output,
        "sort_keys": config.sort_keys,
        "tab": config.tab,
        "indent": config.indent,
        "seq": config.seq,
    });
    // jq's debug callback prints compactly, with -S and -a but none of
    // the layout or raw options (main.c's dumpopts less pretty).
    let debug = serde_json::json!({
        "compact": true,
        "ascii_output": config.ascii_output,
        "sort_keys": config.sort_keys,
        "indent": config.indent,
    });
    let mut eval_config = serde_json::json!({
        "program": config.program,
        "named": named,
        "args": args,
        "env": config.env,
        "zone": config.zone,
        "prog_origin": config.prog_origin,
        "print": print,
    });
    if let Some(memory) = config.memory {
        eval_config["memory"] = memory.into();
    }
    if let Some(steps) = config.steps {
        eval_config["steps"] = steps.into();
    }
    let eval = eval::open(eval_config.to_string().as_bytes())?;
    Ok(Box::new(Main {
        eval,
        reader: Reader::new(&config)?,
        debug: serde_json::from_value(debug)
            .map_err(|e| StreamError::new(format!("bad jq debug options: {e}")))?,
        null_input: config.null_input,
        seq: config.seq,
        exit_status: config.exit_status,
        memory: config.memory,
        task: Task::Next,
        asking: None,
        taken: false,
        wire: Vec::new(),
        messages: VecDeque::new(),
        stop: None,
        printed: false,
        falsy: false,
        ran: false,
        reading: false,
        ret: OK_NO_OUTPUT,
        last_result: -1,
        stderr: Vec::new(),
        status: 0,
        cancelled: false,
    }))
}

impl Main {
    /// Start a run on one document, from where the reader stands.
    fn start(&mut self, text: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.eval
            .begin(self.reader.place().to_string().as_bytes())?;
        self.eval.feed(text, &mut self.wire)?;
        self.eval.finish(&mut self.wire)?;
        self.task = Task::Run;
        self.frames(out)
    }

    /// Fold what jq_eval wrote into the invocation: printed bytes to
    /// stdout, `debug` and `stderr` lines queued in order, and how the run
    /// stopped.
    fn frames(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let wire = std::mem::take(&mut self.wire);
        let mut at = 0;
        while at < wire.len() {
            let tag = wire[at];
            let size =
                u32::from_le_bytes(wire[at + 1..at + 5].try_into().expect("4 bytes")) as usize;
            let payload = &wire[at + 5..at + 5 + size];
            at += 5 + size;
            match tag {
                PRINT => {
                    out.extend_from_slice(&payload[1..]);
                    self.printed = true;
                    self.falsy = payload[0] == 1;
                }
                DEBUG => {
                    let text = String::from_utf8_lossy(payload).into_owned();
                    self.messages
                        .push_back(Message::Debug(Box::new(Formatting::begin(
                            &self.debug,
                            text,
                        ))));
                }
                STDERR => self.messages.push_back(Message::Text(payload.to_vec())),
                ERROR => {
                    let text = String::from_utf8_lossy(&payload[1..]).into_owned();
                    if self
                        .memory
                        .is_some_and(|memory| text == eval::memory_report(memory))
                    {
                        return Err(StreamError::new(EXHAUSTED));
                    }
                    self.stop = Some(Stop::Error(text, payload[0] & 1 != 0));
                }
                HALT => {
                    let halt: HaltFrame = serde_json::from_slice(payload)
                        .map_err(|e| StreamError::new(format!("bad jq halt: {e}")))?;
                    self.stop = Some(Stop::Halt(halt.message, halt.string, halt.code));
                }
                other => return Err(StreamError::new(format!("unknown jq_eval frame {other}"))),
            }
        }
        self.wire = wire;
        self.wire.clear();
        Ok(())
    }

    /// Print the next queued message a bounded slice at a time: None when
    /// none waits, else whether it was printed whole.
    fn message(&mut self) -> Result<Option<bool>, StreamError> {
        let Some(message) = self.messages.front_mut() else {
            return Ok(None);
        };
        match message {
            Message::Text(text) => self.stderr.append(text),
            Message::Debug(formatting) => {
                let mut budget = eval::STEPS;
                let printed = formatting.run(&mut budget);
                formatting.take(&mut self.stderr);
                match printed {
                    None => return Ok(Some(false)),
                    Some(result) => result?,
                }
            }
        }
        self.messages.pop_front();
        Ok(Some(true))
    }

    /// One bounded unit of the loop's work; whether the slice has room for
    /// another: a run that needs more than one drain of jq_eval hands
    /// control back after each, and one that ends lets the next document
    /// start in the same slice.
    fn step(&mut self, out: &mut Vec<u8>, budget: &mut usize) -> Result<bool, StreamError> {
        if let Some(printed) = self.message()? {
            return Ok(printed);
        }
        match self.task {
            Task::Next if self.null_input && !self.ran => {
                self.ran = true;
                self.start(b"null", out)?;
            }
            Task::Next if !self.reading && self.reader.failures > 0 => self.end(),
            Task::Next | Task::Input => self.read(out, budget)?,
            Task::Run if self.eval.busy() => {
                self.eval.drain(&mut self.wire)?;
                self.frames(out)?;
                *budget = budget.saturating_sub(RUN);
                return Ok(!self.eval.busy());
            }
            Task::Run => match self.eval.request(&mut Vec::new()) {
                Some(header) if header == br#"{"op":"now"}"# => {
                    self.asking = Some(Ask::Now);
                    self.taken = false;
                }
                Some(_) => self.task = Task::Input,
                None => self.settle(),
            },
            Task::Done => return Ok(false),
        }
        Ok(true)
    }

    /// Fold the run that ended into the invocation: its answer toward the
    /// exit status, and its report when it stopped early. A halt ends the
    /// invocation.
    fn settle(&mut self) {
        let status = match &self.stop {
            Some(Stop::Halt(_, _, code)) => code.map_or(OK, f64::trunc),
            Some(Stop::Error(..)) => ERROR_UNKNOWN,
            None if !self.printed => OK_NO_OUTPUT,
            None if self.falsy => OK_NULL_KIND,
            None => OK,
        };
        self.record(status);
        let halted = matches!(self.stop, Some(Stop::Halt(..)));
        match self.stop.take() {
            Some(Stop::Error(text, true)) => {
                let text = text.split('\0').next().unwrap_or_default();
                let report = format!("jq: error (at {}): {text}\n", self.reader.position());
                self.stderr.extend_from_slice(report.as_bytes());
            }
            Some(Stop::Error(text, false)) => {
                let report = format!(
                    "jq: error (at {}) (not a string): {text}\n",
                    self.reader.position()
                );
                self.stderr.extend_from_slice(report.as_bytes());
            }
            Some(Stop::Halt(Some(message), string, _)) => {
                self.stderr.extend_from_slice(message.as_bytes());
                if !string {
                    self.stderr.push(b'\n');
                }
            }
            Some(Stop::Halt(None, ..)) | None => {}
        }
        self.printed = false;
        self.falsy = false;
        if halted || self.null_input {
            self.end();
        } else {
            self.task = Task::Next;
        }
    }

    /// Count one run's answer: only the last counts, unless it printed
    /// nothing, when -e looks back to the last value any run printed.
    fn record(&mut self, status: f64) {
        self.ret = status;
        if status <= 0.0 && status != OK_NO_OUTPUT {
            self.last_result = if status == OK_NULL_KIND { 0 } else { 1 };
        }
    }

    /// End the loop and settle the exit status as jq's main does.
    fn end(&mut self) {
        self.task = Task::Done;
        if self.reader.failures > 0 {
            self.status = ERROR_SYSTEM;
            return;
        }
        let code = if !self.exit_status {
            self.ret.max(0.0)
        } else if self.ret != OK_NO_OUTPUT {
            self.ret.abs()
        } else {
            match self.last_result {
                -1 => 4.0,
                0 => 1.0,
                _ => 0.0,
            }
        };
        self.status = code.rem_euclid(256.0) as i32;
    }

    /// Answer the run's `input` with the reader's next document, the end
    /// of the stream, or its parse error, and where the reader stands
    /// after it.
    fn answer(&mut self, kind: &str, data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut reply = self.reader.place();
        reply["kind"] = kind.into();
        self.eval
            .respond(reply.to_string().as_bytes(), data, &mut self.wire)?;
        self.task = Task::Run;
        self.frames(out)
    }

    fn read(&mut self, out: &mut Vec<u8>, budget: &mut usize) -> Result<(), StreamError> {
        let read = self.reader.next(budget)?;
        self.reading = matches!(read, Read::Working | Read::Wait(_));
        match (self.task, read) {
            (_, Read::Working) => {}
            (_, Read::Wait(index)) => {
                self.asking = Some(Ask::Read(index));
                self.taken = false;
            }
            (Task::Input, Read::Text(text)) => self.answer("value", &text, out)?,
            (Task::Input, Read::Error(message)) => self.answer("error", message.as_bytes(), out)?,
            (Task::Input, Read::End) => self.answer("end", b"", out)?,
            (_, Read::Text(text)) => self.start(&text, out)?,
            (_, Read::Error(message)) => {
                let kind = if self.seq {
                    "ignoring parse error"
                } else {
                    "parse error"
                };
                let report = format!("jq: {kind}: {message}\n");
                self.stderr.extend_from_slice(report.as_bytes());
                if !self.seq {
                    self.record(ERROR_UNKNOWN);
                    self.end();
                }
            }
            (_, Read::End) => self.end(),
        }
        Ok(())
    }
}

impl Stream for Main {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("jq reads its inputs through requests"))
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn busy(&self) -> bool {
        if self.cancelled {
            return self.eval.busy() || self.reader.retiring();
        }
        (self.task != Task::Done || !self.messages.is_empty()) && self.asking.is_none()
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.cancelled {
            if self.eval.busy() {
                self.eval.drain(&mut Vec::new())?;
            } else {
                self.reader.retire();
            }
            return Ok(());
        }
        let start = out.len();
        let mut budget = SLICE;
        while self.busy() && budget > 0 && out.len() - start < crate::PIECE {
            if !self.step(out, &mut budget)? {
                break;
            }
        }
        Ok(())
    }

    fn cancel(&mut self) -> bool {
        self.eval.cancel();
        self.reader.discard();
        self.messages.clear();
        self.asking = None;
        self.task = Task::Done;
        self.cancelled = true;
        true
    }

    fn status(&self) -> i32 {
        self.status
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }

    fn request(&mut self, _data: &mut Vec<u8>) -> Option<Vec<u8>> {
        if self.taken {
            return None;
        }
        let header = match self.asking? {
            Ask::Read(input) => serde_json::json!({ "op": "read", "input": input }),
            Ask::Now => serde_json::json!({ "op": "now" }),
        };
        self.taken = true;
        Some(header.to_string().into_bytes())
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let asked = self
            .asking
            .filter(|_| self.taken)
            .ok_or_else(|| StreamError::new("jq: the host answered no request"))?;
        self.asking = None;
        self.taken = false;
        match asked {
            Ask::Read(_) => {
                let reply: ReadReply = crate::parse_config(reply)?;
                self.reader.supply(reply, data, &mut self.stderr)
            }
            Ask::Now => {
                self.eval.respond(reply, data, &mut self.wire)?;
                self.frames(out)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One input as the host serves it: its bytes, a file that cannot be
    /// opened, or one whose bytes fail to read after `.0`.
    enum Source {
        Bytes(&'static [u8]),
        Missing,
        Fails(&'static [u8], &'static str),
    }

    struct Ran {
        out: String,
        err: String,
        status: i32,
        reads: usize,
    }

    fn config(program: &str, inputs: usize, options: serde_json::Value) -> serde_json::Value {
        let mut config = serde_json::json!({
            "program": program,
            "compact": true,
            "inputs": (0..inputs).map(|i| format!("f{i}.json")).collect::<Vec<_>>(),
        });
        for (key, value) in options.as_object().expect("options") {
            config[key] = value.clone();
        }
        config
    }

    fn run_with(config: serde_json::Value, sources: &[Source], size: usize) -> Ran {
        let mut stream = open(config.to_string().as_bytes()).expect("compiles");
        let mut out = Vec::new();
        let mut offsets = vec![0; sources.len()];
        let mut reads = 0;
        loop {
            while stream.busy() {
                stream.drain(&mut out).expect("runs");
            }
            let Some(header) = stream.request(&mut Vec::new()) else {
                break;
            };
            let header: serde_json::Value = serde_json::from_slice(&header).unwrap();
            if header["op"] == "now" {
                stream
                    .respond(br#"{"kind":"now","now":0}"#, b"", &mut out)
                    .unwrap();
                continue;
            }
            reads += 1;
            let index = header["input"].as_u64().unwrap() as usize;
            let (data, failure) = match &sources[index] {
                Source::Bytes(data) => (*data, None),
                Source::Missing => (
                    &b""[..],
                    Some(r#"{"kind":"error","message":"No such file or directory"}"#),
                ),
                Source::Fails(data, reply) => (*data, Some(*reply)),
            };
            let at = offsets[index];
            if at < data.len() {
                let stop = (at + size).min(data.len());
                offsets[index] = stop;
                stream
                    .respond(br#"{"kind":"data"}"#, &data[at..stop], &mut out)
                    .unwrap();
            } else {
                let reply = failure.unwrap_or(r#"{"kind":"end"}"#);
                stream.respond(reply.as_bytes(), b"", &mut out).unwrap();
            }
        }
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        Ran {
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
            status: stream.status(),
            reads,
        }
    }

    fn run(program: &str, sources: &[Source], options: serde_json::Value) -> Ran {
        run_with(config(program, sources.len(), options), sources, 1 << 20)
    }

    fn lines(ran: &Ran) -> Vec<&str> {
        ran.out.lines().collect()
    }

    const PLACED: &str = "[., input_filename, input_line_number]";

    fn none() -> serde_json::Value {
        serde_json::json!({})
    }

    #[test]
    fn the_inputs_are_one_stream_for_one_scanner() {
        for size in [1, 3, 1 << 20] {
            let config = config(".", 2, none());
            let ran = run_with(
                config.clone(),
                &[Source::Bytes(b"1"), Source::Bytes(b"2")],
                size,
            );
            assert_eq!(ran.out, "12\n");
            let ran = run_with(config, &[Source::Bytes(b"[1,"), Source::Bytes(b"2]")], size);
            assert_eq!(ran.out, "[1,2]\n");
        }
    }

    #[test]
    fn a_value_is_placed_where_the_reader_holds_it_whole() {
        let ran = run(
            PLACED,
            &[Source::Bytes(b"1"), Source::Bytes(b" 2\n")],
            none(),
        );
        assert_eq!(lines(&ran), [r#"[1,"f1.json",1]"#, r#"[2,"f1.json",1]"#]);
        let ran = run(
            PLACED,
            &[Source::Bytes(b"1\n2\n"), Source::Bytes(b"[3,\n4]\n5")],
            none(),
        );
        assert_eq!(
            lines(&ran),
            [
                r#"[1,"f0.json",1]"#,
                r#"[2,"f0.json",2]"#,
                r#"[[3,4],"f1.json",2]"#,
                r#"[5,"f1.json",2]"#,
            ]
        );
        for size in [1, 5, 1 << 20] {
            let ran = run_with(
                config(PLACED, 1, none()),
                &[Source::Bytes(
                    b"{\n  \"a\": [\n    1\n  ]\n}\n{\"b\":3}\n\n{\"c\":4}\n",
                )],
                size,
            );
            assert_eq!(
                lines(&ran),
                [
                    r#"[{"a":[1]},"f0.json",5]"#,
                    r#"[{"b":3},"f0.json",6]"#,
                    r#"[{"c":4},"f0.json",8]"#,
                ]
            );
        }
    }

    fn counted(ran: &Ran, skip: usize, take: usize) -> (usize, usize) {
        let numbers: Vec<&str> = ran.out.lines().skip(skip).take(take).collect();
        let ones = numbers.iter().filter(|line| **line == "1").count();
        (numbers.len() - ones, ones)
    }

    #[test]
    fn a_long_line_counts_once_the_reader_holds_its_last_piece() {
        // jq 1.8.2 reads a long line 4091 bytes at a time: of 4095 values
        // on one 8190-byte line, only the last four arrive with its newline.
        let text: &'static [u8] = Box::leak(
            format!("{}\n2\n", "1 ".repeat(4095))
                .into_bytes()
                .into_boxed_slice(),
        );
        let ran = run("input_line_number", &[Source::Bytes(text)], none());
        assert_eq!(counted(&ran, 0, 4095), (4091, 4));
        // A piece that ends inside a character reads on to its end, so every
        // later piece starts a byte on.
        let text = format!("\"a{}\"  {}\n", "é".repeat(2045), "1 ".repeat(2100));
        let text: &'static [u8] = Box::leak(text.into_bytes().into_boxed_slice());
        let ran = run("input_line_number", &[Source::Bytes(text)], none());
        assert_eq!(counted(&ran, 1, 2100), (2044, 56));
    }

    #[test]
    fn a_document_is_handed_over_before_its_input_ends() {
        for (data, want) in [
            (&b"{\n  \"a\": [\n    1\n  ]\n}\n"[..], "{\"a\":[1]}\n"),
            (b"[\n  1,\n  2\n]\n{\n", "[1,2]\n"),
            (b"{\n\"a\": 1}\n", "{\"a\":1}\n"),
        ] {
            let mut stream = open(config(".", 1, none()).to_string().as_bytes()).unwrap();
            let mut out = Vec::new();
            let mut fed = false;
            loop {
                while stream.busy() {
                    stream.drain(&mut out).unwrap();
                }
                stream.request(&mut Vec::new()).expect("a read");
                if fed {
                    break;
                }
                stream
                    .respond(br#"{"kind":"data"}"#, data, &mut out)
                    .unwrap();
                fed = true;
            }
            assert_eq!(String::from_utf8(out).unwrap(), want);
            assert!(stream.cancel());
            while stream.busy() {
                stream.drain(&mut Vec::new()).unwrap();
            }
        }
    }

    #[test]
    fn a_value_keeps_the_text_it_was_read_from() {
        let ran = run(
            ".",
            &[Source::Bytes(
                b"{\"b\":1.000,\"1\":2}\n100000000000000000001 [1.10, -0] nan\n",
            )],
            none(),
        );
        assert_eq!(
            lines(&ran),
            [
                r#"{"b":1.000,"1":2}"#,
                "100000000000000000001",
                "[1.10,-0]",
                "null"
            ]
        );
        let ran = run(".", &[Source::Bytes(b"1."), Source::Bytes(b"000")], none());
        assert_eq!(ran.out, "1.000\n");
        let ran = run(
            ".",
            &[Source::Bytes(b"\xef\xbb\xbf[\"\xff\", 1.000]\n")],
            none(),
        );
        assert_eq!(ran.out, "[\"\u{fffd}\",1.000]\n");
    }

    #[test]
    fn a_parse_error_ends_the_loop_after_the_values_before_it() {
        let ran = run(
            ".",
            &[Source::Bytes(b"1\n2\n"), Source::Bytes(b"[")],
            none(),
        );
        assert_eq!(
            (ran.out.as_str(), ran.err.as_str(), ran.status),
            (
                "1\n2\n",
                "jq: parse error: Unfinished JSON term at EOF at line 3, column 1\n",
                5
            )
        );
        let ran = run(".", &[Source::Bytes(b"\xef\xbb1\n")], none());
        assert_eq!(ran.err, "jq: parse error: Malformed BOM\n");
        let ran = run(
            ".",
            &[
                Source::Bytes(b"\xef\xbb\xbf1\n"),
                Source::Bytes(b"\xef\xbb\xbf2\n"),
            ],
            none(),
        );
        assert_eq!(
            (ran.out.as_str(), ran.err.as_str()),
            (
                "1\n",
                "jq: parse error: Invalid numeric literal at line 3, column 0\n"
            )
        );
    }

    #[test]
    fn seq_reports_a_parse_error_and_reads_on() {
        let seq = serde_json::json!({ "seq": true });
        let ran = run(
            PLACED,
            &[Source::Bytes(b"\x1e1\n\x1e[1 2]\n\x1e3\n")],
            seq.clone(),
        );
        assert_eq!(ran.out, "\x1e[1,\"f0.json\",1]\n\x1e[3,\"f0.json\",3]\n");
        assert_eq!(
            ran.err,
            "jq: ignoring parse error: Expected separator between values at line 2, column 6 (need RS to resync)\n"
        );
        assert_eq!(ran.status, 0);
    }

    #[test]
    fn slurp_raw_and_stream_read_the_whole_stream() {
        let slurp = serde_json::json!({ "slurp": true });
        let ran = run(
            ".",
            &[Source::Bytes(b"{\"a\":1}"), Source::Bytes(b" {\"b\":2}")],
            slurp.clone(),
        );
        assert_eq!(ran.out, "[{\"a\":1},{\"b\":2}]\n");
        assert_eq!(run(".", &[], slurp).out, "[]\n");
        let raw = serde_json::json!({ "raw_input": true });
        let ran = run(
            ".",
            &[Source::Bytes(b"x\ny"), Source::Bytes(b"z\n\n")],
            raw.clone(),
        );
        assert_eq!(lines(&ran), ["\"x\"", "\"yz\"", "\"\""]);
        let ran = run(".", &[Source::Bytes(b"a\xffb\n\xf0\x80\x80\x80")], raw);
        assert_eq!(lines(&ran), ["\"a\u{fffd}b\"", "\"\u{fffd}\""]);
        let both = serde_json::json!({ "raw_input": true, "slurp": true });
        assert_eq!(
            run(".", &[Source::Bytes(b"x\n"), Source::Bytes(b"y")], both).out,
            "\"x\\ny\"\n"
        );
        let stream = serde_json::json!({ "stream": true });
        let ran = run(PLACED, &[Source::Bytes(b"[1,\n[2]]\n")], stream);
        assert_eq!(
            lines(&ran),
            [
                r#"[[[0],1],"f0.json",1]"#,
                r#"[[[1,0],2],"f0.json",2]"#,
                r#"[[[1,0]],"f0.json",2]"#,
                r#"[[[1]],"f0.json",2]"#,
            ]
        );
    }

    const MISSING: &str = "jq: error: Could not open file f1.json: No such file or directory\n";

    #[test]
    fn a_failed_input_is_reported_and_read_past() {
        // jq's reader names the input fopen refused and goes on to the
        // next, and a value runs on across it; the exit status is 2.
        for size in [1, 1 << 20] {
            let ran = run_with(
                config(PLACED, 3, none()),
                &[
                    Source::Bytes(b"[1,"),
                    Source::Missing,
                    Source::Bytes(b"2]\n"),
                ],
                size,
            );
            assert_eq!(
                (ran.out.as_str(), ran.err.as_str(), ran.status),
                ("[[1,2],\"f2.json\",1]\n", MISSING, 2)
            );
        }
        // A directory opens and fails at its first read, in bare words.
        let directory = Source::Fails(
            b"",
            r#"{"kind":"error","message":"Is a directory","read":true}"#,
        );
        let ran = run(".", &[directory, Source::Bytes(b"1\n")], none());
        assert_eq!(
            (ran.out.as_str(), ran.err.as_str()),
            ("1\n", "jq: error: Is a directory\n")
        );
        // A read that fails midway loses the line it was reading.
        let failing = Source::Fails(
            b"1\n[\n  2\n]",
            r#"{"kind":"error","message":"Permission denied","read":true}"#,
        );
        let ran = run(".", &[failing, Source::Bytes(b",3]\n")], none());
        assert_eq!(
            (ran.out.as_str(), ran.err.as_str()),
            ("1\n[2,3]\n", "jq: error: Permission denied\n")
        );
        // Under -R the lines run on across a failed input.
        let raw = serde_json::json!({ "raw_input": true });
        let ran = run(
            ".",
            &[Source::Bytes(b"x"), Source::Missing, Source::Bytes(b"y\n")],
            raw,
        );
        assert_eq!((ran.out.as_str(), ran.err.as_str()), ("\"xy\"\n", MISSING));
    }

    #[test]
    fn the_loop_stops_after_the_run_a_failed_read_went_on_to() {
        let ran = run(
            ".",
            &[
                Source::Bytes(b"1 2"),
                Source::Missing,
                Source::Bytes(b"3 4"),
            ],
            none(),
        );
        assert_eq!((ran.out.as_str(), ran.status), ("1\n23\n", 2));
    }

    #[test]
    fn null_input_reads_only_what_the_program_asks_for() {
        let null = serde_json::json!({ "null_input": true });
        let ran = run("1", &[Source::Missing], null.clone());
        assert_eq!(
            (ran.out.as_str(), ran.err.as_str(), ran.status, ran.reads),
            ("1\n", "", 0, 0)
        );
        let ran = run(
            "[input, input_filename]",
            &[Source::Bytes(b"1 2")],
            null.clone(),
        );
        assert_eq!(ran.out, "[1,\"f0.json\"]\n");
        let ran = run("input", &[Source::Missing], null);
        assert_eq!(
            (ran.err.as_str(), ran.status),
            (
                "jq: error: Could not open file f0.json: No such file or directory\njq: error (at f0.json:0): break\n",
                2
            )
        );
    }

    #[test]
    fn errors_halts_and_messages_go_to_stderr_in_order() {
        let ran = run(
            r#"debug, ("a\u0000b" | stderr), error("x\u0000y")"#,
            &[Source::Bytes(b"{\"a\":1}")],
            none(),
        );
        assert_eq!(ran.out, "{\"a\":1}\n\"a\\u0000b\"\n");
        assert_eq!(
            ran.err,
            "[\"DEBUG:\",{\"a\":1}]\na\0bjq: error (at f0.json:0): x\n"
        );
        assert_eq!(ran.status, 5);
        let sorted = serde_json::json!({ "sort_keys": true, "ascii_output": true });
        let ran = run(
            "debug | empty",
            &[Source::Bytes(b"{\"b\":\"\xc3\xa9\",\"a\":1}")],
            sorted,
        );
        assert_eq!(ran.err, "[\"DEBUG:\",{\"a\":1,\"b\":\"\\u00e9\"}]\n");
        let ran = run("error({a:1})", &[Source::Bytes(b"1")], none());
        assert_eq!(
            ran.err,
            "jq: error (at f0.json:0) (not a string): {\"a\":1}\n"
        );
        let ran = run(
            r#"if . == 2 then "bye\n" | halt_error(3) else . end"#,
            &[Source::Bytes(b"1 2 3")],
            none(),
        );
        assert_eq!(
            (ran.out.as_str(), ran.err.as_str(), ran.status),
            ("1\n", "bye\n", 3)
        );
        let ran = run("{a:1} | halt_error", &[Source::Bytes(b"1")], none());
        assert_eq!((ran.err.as_str(), ran.status), ("{\"a\":1}\n", 5));
        let ran = run("halt", &[Source::Bytes(b"1 2")], none());
        assert_eq!((ran.out.as_str(), ran.status), ("", 0));
    }

    #[test]
    fn exit_status_follows_jqs_main_loop() {
        let e = serde_json::json!({ "exit_status": true });
        for (program, input, status) in [
            (".", &b"1"[..], 0),
            (".", b"false", 1),
            (".", b"null", 1),
            ("empty", b"1", 4),
            ("if . == 1 then false else empty end", b"1 2", 1),
            ("error", b"\"x\"", 5),
        ] {
            assert_eq!(
                run(program, &[Source::Bytes(input)], e.clone()).status,
                status,
                "{program}"
            );
        }
        assert_eq!(run("empty", &[Source::Bytes(b"1")], none()).status, 0);
        assert_eq!(run("error", &[Source::Bytes(b"\"x\" 1")], none()).status, 5);
    }

    #[test]
    fn the_exit_status_reads_the_runs_as_jq_does() {
        // Each case: a program, the documents it runs on, -e, the status.
        let cases: &[(&str, &[u8], bool, i32)] = &[
            ("1, false", b"1", true, 1),
            ("false, 1", b"1", true, 0),
            ("null", b"1", true, 1),
            (r#"if . == 1 then "false" else 0.0 end"#, b"1 2", true, 0),
            (".", b"", true, 4),
            (".", b"", false, 0),
            ("null", b"1", false, 0),
            (r#"if . == 1 then error("x") else 1 end"#, b"1 2", false, 0),
            (r#"if . == 1 then 1 else error("x") end"#, b"1 2", false, 5),
            (
                r#"if . == 1 then error("x") else false end"#,
                b"1 2",
                true,
                1,
            ),
            ("if . == 1 then false else empty end", b"1 2", true, 1),
            ("if . == 1 then 1 else empty end", b"1 2", true, 0),
            ("halt", b"1", false, 0),
            ("null | halt_error(2)", b"1", false, 2),
            ("null | halt_error(-1)", b"1", false, 0),
            ("null | halt_error(-1)", b"1", true, 1),
            ("null | halt_error(1.5)", b"1", false, 1),
            ("null | halt_error(300)", b"1", false, 44),
        ];
        for (program, input, exit_status, status) in cases {
            let options = serde_json::json!({ "exit_status": exit_status });
            let ran = run(program, &[Source::Bytes(input)], options);
            assert_eq!(ran.status, *status, "{program} on {input:?}");
        }
    }

    #[test]
    fn a_piece_reads_on_to_finish_its_last_character() {
        for (piece, missing) in [
            (&b"a"[..], 0),
            (b"ab", 0),
            (b"a\xe2", 2),
            (b"a\xe2\x82", 1),
            (b"a\xe2\x82\xac", 0),
            (b"a\xf0\x9f", 2),
            (b"a\x80", 0),
            (b"a\xff", 0),
        ] {
            assert_eq!(utf8_missing(piece), missing, "{piece:?}");
        }
    }

    #[test]
    fn args_bind_in_the_order_given() {
        let options = serde_json::json!({
            "null_input": true,
            "named": [["b", "1"], ["a", "\"x\""]],
            "positional": ["2", "[3]"],
        });
        let ran = run("$ARGS, $a", &[], options);
        assert_eq!(
            ran.out,
            "{\"positional\":[2,[3]],\"named\":{\"b\":1,\"a\":\"x\"}}\n\"x\"\n"
        );
    }

    #[test]
    fn memory_past_the_room_ends_the_stream() {
        // A slurp counts each value it keeps and the commas it joins with.
        let options = serde_json::json!({ "slurp": true, "memory": 4096 });
        let text: &'static [u8] = Box::leak(b"1\n".repeat(3000).into_boxed_slice());
        let mut stream = open(config(".", 1, options).to_string().as_bytes()).unwrap();
        let mut out = Vec::new();
        let mut failed = None;
        let mut fed = false;
        'run: loop {
            while stream.busy() {
                if let Err(error) = stream.drain(&mut out) {
                    failed = Some(error.message);
                    break 'run;
                }
            }
            if stream.request(&mut Vec::new()).is_none() {
                break;
            }
            let reply: &[u8] = if fed {
                br#"{"kind":"end"}"#
            } else {
                br#"{"kind":"data"}"#
            };
            let data: &[u8] = if fed { b"" } else { text };
            fed = true;
            if let Err(error) = stream.respond(reply, data, &mut out) {
                failed = Some(error.message);
                break;
            }
        }
        assert_eq!(failed.as_deref(), Some(EXHAUSTED));
    }

    #[test]
    fn a_run_waiting_on_input_cancels_and_retires() {
        let mut stream = open(config("[., input]", 1, none()).to_string().as_bytes()).unwrap();
        let mut out = Vec::new();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        assert!(stream.request(&mut Vec::new()).is_some());
        stream
            .respond(br#"{"kind":"data"}"#, b"1 ", &mut out)
            .unwrap();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        assert!(stream.request(&mut Vec::new()).is_some());
        assert!(stream.cancel());
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        assert!(stream.request(&mut Vec::new()).is_none());
        assert!(out.is_empty());
    }

    #[test]
    fn a_small_step_budget_gives_the_same_answers() {
        let options = serde_json::json!({ "steps": 1 });
        let ran = run(
            "[., input]",
            &[Source::Bytes(b"{\"a\":[1,2]} 3 4")],
            options,
        );
        assert_eq!(ran.out, "[{\"a\":[1,2]},3]\n");
        assert_eq!(ran.err, "jq: error (at f0.json:0): break\n");
    }
}
