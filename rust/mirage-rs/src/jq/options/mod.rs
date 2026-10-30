// Adapted from jq 1.8.2 (MIT), src/main.c. See licenses/third_party/jq.txt.

//! jq's option loop: the words of one invocation read one at a time, in
//! the order typed, before jq compiles its program or opens an input.
//!
//! The host sends every option as `[name, text]` and every operand as
//! `["", word]` where it was typed, each text one character per byte. A
//! `--rawfile` or `--slurpfile` the loop reaches asks the host for that
//! file's bytes, so a file that cannot be read, or holds bad JSON, is
//! reported before any refusal typed after it, as jq reads it in place.
//! The stream fails with the first refusal, in jq's words and with exit
//! status 2, and otherwise `finish` writes `{"answer": "help"}`,
//! `{"answer": "version"}` or `{"config": {...}, "program_file": at}`: the
//! run config the options decide, and the tape index of the `-f` that
//! names the program file the host reads, or null.

use serde::Deserialize;
use serde_json::{Value as Json, json};

use super::main::Config as RunConfig;
use super::unicode::WORK;
use crate::{Stream, StreamError, latin1_bytes, parse_config};

/// The tape name of an operand, and of an option the parser refused.
const OPERAND: &str = "";
const REFUSED: &str = "?";

/// jq's exit status for an option it refuses and a binding it cannot
/// read.
const ERROR_SYSTEM: i32 = 2;

const DEFAULT_INDENT: u8 = 2;

const USAGE_HINT: &str = "Use jq --help for help with command-line options,\n\
or see the jq manpage, or online docs at https://jqlang.org";

/// jq's usage(2, 1): `-f` is a switch that makes the program operand a
/// file, so an `-f` the line ends at leaves jq no program.
const SHORT_USAGE: &str = "jq - commandline JSON processor [version 1.8.2]\n\n\
Usage:\tjq [options] <jq filter> [file...]\n\
\tjq [options] --args <jq filter> [strings...]\n\
\tjq [options] --jsonargs <jq filter> [JSON_TEXTS...]\n\n\
jq is a tool for processing JSON inputs, applying the given filter to\n\
its JSON text inputs and producing the filter's results as JSON on\n\
standard output.\n\n\
The simplest filter is ., which copies jq's input to its output\n\
unmodified except for formatting. For more advanced filters see\n\
the jq(1) manpage (\"man jq\") and/or https://jqlang.org/.\n\n\
Example:\n\n\
\t$ echo '{\"foo\": 0}' | jq .\n\
\t{\n\
\t  \"foo\": 0\n\
\t}\n\n\
For listing the command options, use jq --help.";

/// What jq says for an option the line ends before the values of.
const TAKES: [(&str, &str); 5] = [
    (
        "--arg",
        "--arg takes two parameters (e.g. --arg varname value)",
    ),
    (
        "--argjson",
        "--argjson takes two parameters (e.g. --argjson varname text)",
    ),
    (
        "--rawfile",
        "--rawfile takes two parameters (e.g. --rawfile varname filename)",
    ),
    (
        "--slurpfile",
        "--slurpfile takes two parameters (e.g. --slurpfile varname filename)",
    ),
    ("--indent", "--indent takes one parameter"),
];

/// The switches whose order does not matter, by tape name.
const SWITCHES: [&str; 11] = [
    "null_input",
    "raw_input",
    "slurp",
    "stream",
    "seq",
    "exit_status",
    "raw_output",
    "join_output",
    "raw_output0",
    "ascii_output",
    "sort_keys",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    options: Vec<(String, String)>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileReply {
    kind: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    directory: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Binding {
    Arg,
    ArgJson,
    RawFile,
    SlurpFile,
}

impl Binding {
    fn of(name: &str) -> Option<Self> {
        Some(match name {
            "arg" => Self::Arg,
            "argjson" => Self::ArgJson,
            "rawfile" => Self::RawFile,
            "slurpfile" => Self::SlurpFile,
            _ => return None,
        })
    }

    fn option(self) -> &'static str {
        match self {
            Self::Arg => "--arg",
            Self::ArgJson => "--argjson",
            Self::RawFile => "--rawfile",
            Self::SlurpFile => "--slurpfile",
        }
    }
}

#[derive(Clone, Copy)]
enum Mode {
    Args,
    JsonArgs,
}

/// Where the text a reading makes goes.
enum Purpose {
    /// The JSON text `name` binds; `shown` is the word that named the
    /// file, for jq's report of it.
    Bind {
        binding: Binding,
        name: Vec<u8>,
        shown: Vec<u8>,
    },
    Positional,
}

/// Bytes going through jq's scanner or decoder, a bounded step per
/// `drain`.
struct Reading {
    engine: Box<dyn Stream>,
    bytes: Vec<u8>,
    at: usize,
    finished: bool,
    out: Vec<u8>,
    /// What the scanner wrote so far, its frames read as they arrive;
    /// `None` for the decoder, whose output is the text itself.
    documents: Option<Documents>,
    purpose: Purpose,
}

impl Reading {
    fn new(
        engine: Result<Box<dyn Stream>, StreamError>,
        bytes: Vec<u8>,
        documents: Option<Documents>,
        purpose: Purpose,
    ) -> Result<Self, StreamError> {
        Ok(Self {
            engine: engine?,
            bytes,
            at: 0,
            finished: false,
            out: Vec::new(),
            documents,
            purpose,
        })
    }

    /// jq's scanner, writing each document as the text it was typed as.
    fn scan(bytes: Vec<u8>, purpose: Purpose) -> Result<Self, StreamError> {
        Self::new(
            super::parse::open(b"{}"),
            bytes,
            Some(Documents::default()),
            purpose,
        )
    }

    /// jq's decoder, the text a `--rawfile` binds.
    fn decode(bytes: Vec<u8>, purpose: Purpose) -> Result<Self, StreamError> {
        Self::new(super::unicode::open_decode(b"{}"), bytes, None, purpose)
    }

    /// One bounded step; true once every byte is through.
    fn step(&mut self) -> Result<bool, StreamError> {
        if self.engine.busy() {
            self.engine.drain(&mut self.out)?;
        } else if self.at < self.bytes.len() {
            let end = (self.at + WORK).min(self.bytes.len());
            self.engine.feed(&self.bytes[self.at..end], &mut self.out)?;
            self.at = end;
        } else if !self.finished {
            self.finished = true;
            self.engine.finish(&mut self.out)?;
        } else {
            return Ok(true);
        }
        if let Some(documents) = &mut self.documents {
            documents.take(&mut self.out)?;
        }
        Ok(false)
    }
}

/// What jq's scanner wrote: each document's text, then the parse error
/// that stopped it, if one did.
#[derive(Default)]
struct Documents {
    texts: Vec<Vec<u8>>,
    text: Vec<u8>,
    failure: Option<String>,
}

impl Documents {
    /// Read the whole frames at the front of `frames` and drop them,
    /// leaving a frame the scanner has not finished writing.
    fn take(&mut self, frames: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut at = 0;
        while self.failure.is_none() {
            let Some(size) = frames
                .get(at + 1..at + 5)
                .and_then(|size| size.try_into().ok())
                .map(|size: [u8; 4]| u32::from_le_bytes(size) as usize)
            else {
                break;
            };
            let Some(payload) = frames.get(at + 5..at + 5 + size) else {
                break;
            };
            match frames[at] {
                1 => self.text.extend_from_slice(payload),
                2 => self.texts.push(std::mem::take(&mut self.text)),
                3 => self.failure = Some(String::from_utf8_lossy(payload).into_owned()),
                _ => return Err(StreamError::new("jq: unknown scanner frame")),
            }
            at += 5 + size;
        }
        frames.drain(..at);
        Ok(())
    }

    /// The documents once the scanner is done: a frame left unread was
    /// cut short, unless a parse error came before it.
    fn done(mut self, rest: &mut Vec<u8>) -> Result<Self, StreamError> {
        self.take(rest)?;
        if self.failure.is_none() && !rest.is_empty() {
            return Err(StreamError::new("jq: a scanner frame was cut short"));
        }
        Ok(self)
    }
}

/// A host string as JSON text: jq's `jv_string`, which takes bytes that
/// are not UTF-8 as U+FFFD.
fn string_text(bytes: &[u8]) -> String {
    Json::String(String::from_utf8_lossy(bytes).into_owned()).to_string()
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// A refusal with jq's usage hint.
fn usage(line: &[u8]) -> StreamError {
    let mut text = b"jq: ".to_vec();
    text.extend_from_slice(line);
    text.push(b'\n');
    text.extend_from_slice(USAGE_HINT.as_bytes());
    StreamError::refusal(&text, ERROR_SYSTEM)
}

/// jq's refusal of an option its loop cannot take: a word it does not
/// know, or an option the line ends before the values of.
fn option_refusal(word: &[u8]) -> StreamError {
    if word == b"-f" || word == b"--from-file" {
        return StreamError::refusal(SHORT_USAGE.as_bytes(), ERROR_SYSTEM);
    }
    match TAKES.iter().find(|(option, _)| option.as_bytes() == word) {
        Some((_, line)) => usage(line.as_bytes()),
        None => usage(&[b"Unknown option ".as_slice(), word].concat()),
    }
}

/// The width an `--indent` word names, read as jq's strtol reads it: a
/// sign and decimal digits and nothing else, from -1 to 7.
fn indent_width(word: &[u8]) -> Result<i8, StreamError> {
    let (negative, digits) = match word.split_first() {
        Some((b'-', rest)) => (true, rest),
        Some((b'+', rest)) => (false, rest),
        _ => (false, word),
    };
    let width = match digits.split_last() {
        Some((&last, zeros))
            if zeros.iter().all(|&b| b == b'0') && (b'0'..=b'7').contains(&last) =>
        {
            let width = (last - b'0') as i8;
            if negative { -width } else { width }
        }
        _ => i8::MAX,
    };
    if (-1..=7).contains(&width) {
        Ok(width)
    } else {
        Err(usage(b"--indent takes a number between -1 and 7"))
    }
}

/// The one JSON value an `--argjson` or `--jsonargs` word holds, as the
/// text it was typed as, or jq's refusal when it holds none, several, or
/// bad JSON.
fn one_value(documents: Documents, option: &str) -> Result<String, StreamError> {
    match (documents.texts.as_slice(), documents.failure) {
        ([text], None) => Ok(lossy(text).trim_matches([' ', '\t', '\r', '\n']).to_owned()),
        _ => Err(usage(
            format!("invalid JSON text passed to {option}").as_bytes(),
        )),
    }
}

/// The array of documents a `--slurpfile` holds, or jq's report of the
/// parse error that stopped it.
fn slurped(documents: Documents, name: &[u8], shown: &[u8]) -> Result<String, StreamError> {
    if let Some(message) = documents.failure {
        let line = [
            b"jq: Bad JSON in --slurpfile ".as_slice(),
            name,
            b" ",
            shown,
            b": ",
            message.as_bytes(),
        ]
        .concat();
        return Err(StreamError::refusal(&line, ERROR_SYSTEM));
    }
    let texts: Vec<String> = documents.texts.iter().map(|text| lossy(text)).collect();
    Ok(format!("[{}]", texts.join(",")))
}

/// jq's option loop over one invocation's words.
struct Loop {
    words: Vec<(String, Vec<u8>)>,
    at: usize,
    /// Whether the next operand is the program: the first one, unless
    /// `-f` names the program file.
    program_next: bool,
    program: Option<String>,
    /// The tape index of the `-f` that names the program file.
    program_file: Option<usize>,
    mode: Option<Mode>,
    switches: Vec<&'static str>,
    compact: bool,
    tab: bool,
    indent: u8,
    named: Vec<(Vec<u8>, String)>,
    positional: Vec<String>,
    answer: Option<&'static str>,
    reading: Option<Reading>,
    /// The tape index of the file a binding waits on, and whether the
    /// host took the request.
    asking: Option<(usize, Purpose)>,
    taken: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { options } = parse_config(config)?;
    let words = options
        .into_iter()
        .map(|(name, text)| {
            latin1_bytes(&text)
                .map(|bytes| (name, bytes))
                .ok_or_else(|| StreamError::new("jq: an option holds a character past U+00FF"))
        })
        .collect::<Result<Vec<_>, StreamError>>()?;
    let program_next = !words.iter().any(|(name, _)| name == "from_file");
    let mut options = Loop {
        words,
        at: 0,
        program_next,
        program: None,
        program_file: None,
        mode: None,
        switches: Vec::new(),
        compact: false,
        tab: false,
        indent: DEFAULT_INDENT,
        named: Vec::new(),
        positional: Vec::new(),
        answer: None,
        reading: None,
        asking: None,
        taken: false,
    };
    options.walk()?;
    Ok(Box::new(options))
}

impl Loop {
    fn waiting(&self) -> bool {
        self.reading.is_some() || self.asking.is_some()
    }

    fn ended(&self) -> bool {
        self.answer.is_some() || (!self.waiting() && self.at == self.words.len())
    }

    /// Read words until one needs bytes read, or none is left.
    fn walk(&mut self) -> Result<(), StreamError> {
        while !self.waiting() && !self.ended() {
            let (name, text) = std::mem::take(&mut self.words[self.at]);
            self.at += 1;
            if let Some(binding) = Binding::of(&name) {
                let value = self
                    .words
                    .get_mut(self.at)
                    .filter(|(next, _)| *next == name)
                    .map(|(_, value)| std::mem::take(value))
                    .ok_or_else(|| StreamError::new(format!("jq: {name} holds no value")))?;
                self.at += 1;
                self.bind(binding, text, value)?;
                continue;
            }
            match name.as_str() {
                REFUSED => return Err(option_refusal(&text)),
                OPERAND => self.operand(text)?,
                "help" => self.answer = Some("help"),
                "version" => self.answer = Some("version"),
                "args" => self.mode = Some(Mode::Args),
                "jsonargs" => self.mode = Some(Mode::JsonArgs),
                "compact_output" => (self.compact, self.tab) = (true, false),
                "tab" => (self.compact, self.tab) = (false, true),
                "indent" => {
                    let width = indent_width(&text)?;
                    self.compact = false;
                    self.tab = width == -1;
                    self.indent = u8::try_from(width).unwrap_or(DEFAULT_INDENT);
                }
                "from_file" => self.program_file = Some(self.at - 1),
                "monochrome_output" | "unbuffered" => {}
                switch => match SWITCHES.iter().find(|known| **known == switch) {
                    Some(known) => self.switches.push(known),
                    None => return Err(crate::scan::unknown("jq", switch)),
                },
            }
        }
        Ok(())
    }

    /// A name's first binding takes it; a later one is never read, so its
    /// JSON is not parsed and its file is not opened.
    fn bind(&mut self, binding: Binding, name: Vec<u8>, value: Vec<u8>) -> Result<(), StreamError> {
        if self.named.iter().any(|(bound, _)| *bound == name) {
            return Ok(());
        }
        match binding {
            Binding::Arg => self.named.push((name, string_text(&value))),
            Binding::ArgJson => {
                let purpose = Purpose::Bind {
                    binding,
                    name,
                    shown: Vec::new(),
                };
                self.reading = Some(Reading::scan(value, purpose)?);
            }
            Binding::RawFile | Binding::SlurpFile => {
                let purpose = Purpose::Bind {
                    binding,
                    name,
                    shown: value,
                };
                self.asking = Some((self.at - 1, purpose));
            }
        }
        Ok(())
    }

    /// The program, an input file, or a positional value, by where the
    /// operand was typed.
    fn operand(&mut self, word: Vec<u8>) -> Result<(), StreamError> {
        if self.program_next {
            self.program_next = false;
            self.program = Some(lossy(&word));
            return Ok(());
        }
        match self.mode {
            None => {}
            Some(Mode::Args) => self.positional.push(string_text(&word)),
            Some(Mode::JsonArgs) => self.reading = Some(Reading::scan(word, Purpose::Positional)?),
        }
        Ok(())
    }

    /// The text a finished reading makes, or jq's refusal of it.
    fn finished(&mut self, reading: Reading) -> Result<(), StreamError> {
        let Reading {
            mut out,
            documents,
            purpose,
            ..
        } = reading;
        let text = match (documents, &purpose) {
            (None, _) => string_text(&out),
            (Some(documents), purpose) => {
                let documents = documents.done(&mut out)?;
                match purpose {
                    Purpose::Bind {
                        binding: Binding::SlurpFile,
                        name,
                        shown,
                    } => slurped(documents, name, shown)?,
                    Purpose::Bind { binding, .. } => one_value(documents, binding.option())?,
                    Purpose::Positional => one_value(documents, "--jsonargs")?,
                }
            }
        };
        match purpose {
            Purpose::Bind { name, .. } => self.named.push((name, text)),
            Purpose::Positional => self.positional.push(text),
        }
        Ok(())
    }

    fn plan(&self) -> Json {
        if let Some(answer) = self.answer {
            return json!({ "answer": answer });
        }
        let on = |switch: &str| self.switches.contains(&switch);
        let config = RunConfig {
            program: self.program.clone().unwrap_or_else(|| ".".to_owned()),
            named: self
                .named
                .iter()
                .map(|(name, text)| (lossy(name), text.clone()))
                .collect(),
            positional: self.positional.clone(),
            null_input: on("null_input"),
            raw_input: on("raw_input"),
            slurp: on("slurp"),
            stream: on("stream"),
            seq: on("seq"),
            exit_status: on("exit_status"),
            raw_output: on("raw_output") || on("join_output") || on("raw_output0"),
            join_output: on("join_output"),
            nul_output: on("raw_output0"),
            ascii_output: on("ascii_output"),
            sort_keys: on("sort_keys"),
            compact: self.compact,
            tab: self.tab,
            indent: self.indent,
            ..RunConfig::default()
        };
        json!({ "config": config, "program_file": self.program_file })
    }
}

impl Stream for Loop {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("jq: the option loop reads no input"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.ended() {
            return Err(StreamError::new("jq: the option loop has words left"));
        }
        out.extend_from_slice(self.plan().to_string().as_bytes());
        Ok(())
    }

    fn busy(&self) -> bool {
        self.reading.is_some()
    }

    fn drain(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        let Some(reading) = &mut self.reading else {
            return Ok(());
        };
        if reading.step()? {
            let reading = self.reading.take().expect("a reading in progress");
            self.finished(reading)?;
            self.walk()?;
        }
        Ok(())
    }

    fn request(&mut self, _data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let (at, _) = self.asking.as_ref().filter(|_| !self.taken)?;
        self.taken = true;
        Some(json!({ "op": "read", "at": at }).to_string().into_bytes())
    }

    fn respond(
        &mut self,
        reply: &[u8],
        data: &[u8],
        _out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let (_, purpose) = self
            .asking
            .take()
            .filter(|_| self.taken)
            .ok_or_else(|| StreamError::new("jq: the host answered no request"))?;
        self.taken = false;
        let reply: FileReply = parse_config(reply)?;
        let Purpose::Bind {
            binding,
            ref name,
            ref shown,
        } = purpose
        else {
            return Err(StreamError::new("jq: only a binding reads a file"));
        };
        match reply.kind.as_str() {
            "data" if binding == Binding::RawFile => {
                self.reading = Some(Reading::decode(data.to_vec(), purpose)?);
            }
            "data" => self.reading = Some(Reading::scan(data.to_vec(), purpose)?),
            "error" => {
                let reason = if reply.directory {
                    "It's a directory"
                } else {
                    reply.message.as_str()
                };
                let mut line = format!("jq: Bad JSON in {} ", binding.option()).into_bytes();
                line.extend_from_slice(name);
                line.push(b' ');
                line.extend_from_slice(shown);
                line.extend_from_slice(b": Could not open ");
                line.extend_from_slice(shown);
                line.extend_from_slice(b": ");
                line.extend_from_slice(reason.as_bytes());
                return Err(StreamError::refusal(&line, ERROR_SYSTEM));
            }
            kind => return Err(StreamError::new(format!("jq: unknown file reply {kind}"))),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
