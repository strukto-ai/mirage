//! The operations a stream that reaches files and commands asks its host
//! for, and the host's answers, which awk, sed, split, csplit and od
//! share.

#[cfg(feature = "gh")]
use std::collections::BTreeMap;
use std::collections::VecDeque;

use serde::Deserialize;
use serde_json::{Map, Value as Json};

use crate::{Stream, StreamError};

/// How a write lands in its file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteMode {
    /// Empty the file first.
    Truncate,
    Append,
    /// Write the file whole as one streamed write, its bytes landing as
    /// this write and the appends after it carry them.
    Create,
    /// Write the file whole from this write's bytes alone, now.
    Whole,
    /// Replace the file whole, once flushed, with what this write and the
    /// appends after it carry; never flushed, it changes nothing.
    Replace,
    /// Append what a spool holds past its first `skip` bytes, and drop
    /// the spool.
    Spool {
        fd: u32,
        skip: u64,
    },
    /// Write the file whole from `size` bytes of a spool past its first
    /// `skip`, keeping the spool.
    Window {
        fd: u32,
        skip: u64,
        size: u64,
    },
    /// Append `size` bytes of a spool past its first `skip`, keeping the
    /// spool.
    Slice {
        fd: u32,
        skip: u64,
        size: u64,
    },
}

/// What a read opens: an operand still as typed, a name standing in for
/// one (unzip's `X.zip` for `X`), read as that operand is, a name a
/// program reads (where `-` and `/dev/stdin` are standard input), a file
/// a script names, which no spelling of standard input stands for, or a
/// spool the run filled, past its first `skip` bytes; a window, `size`
/// bytes of a spool, comes whole in one reply and leaves nothing open. A
/// range, `Range(operand, skip, size)`, opens an operand past its first
/// `skip` bytes, at most `size` of them, where the host knows the file's
/// length, which its first reply says (`skipped`, `size`); otherwise the
/// host reads the operand from its start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Opening {
    Operand(usize),
    AsOperand,
    Name,
    File,
    Spool { fd: u32, skip: u64 },
    Window { fd: u32, skip: u64, size: u64 },
    Range(usize, u64, Option<u64>),
}

/// What the host is asked to do, in the order the run asks.
#[derive(Debug)]
pub(crate) enum Request {
    /// Time-zone facts; a wall lookup preserves host-local date operands.
    Date {
        zone: Option<String>,
        instant: Option<i64>,
        year: Option<i64>,
        wall: Option<[i64; 6]>,
    },
    /// The time now, as whole seconds and nanoseconds.
    Clock,
    /// The next chunk of input `fd`; the first read of a named input says
    /// which file, and which operand when it is one still as typed. A file
    /// read whole asks for `least` bytes a reply, the host gathering chunks
    /// until it has them or the input ends, when the last of them come with
    /// `end`.
    Read {
        fd: u32,
        open: Option<(Vec<u8>, Opening)>,
        least: u64,
    },
    /// Let go of input `fd`, or of spool `fd` unsent.
    Close {
        fd: u32,
    },
    /// Read an input whole into spool `spool`, the host's own, and answer
    /// its length.
    Fill {
        spool: u32,
        open: (Vec<u8>, Opening),
    },
    Unlink {
        path: Vec<u8>,
    },
    /// What stands at a path: a directory, a file, a link that leads to
    /// nothing found, or nothing.
    Stat {
        path: Vec<u8>,
    },
    /// Make one directory, its parent standing.
    Mkdir {
        path: Vec<u8>,
    },
    /// What a link holds, or that the name is no link; the name itself is
    /// never followed.
    Readlink {
        path: Vec<u8>,
    },
    /// Make `to` a copy of file `from`, its bytes and permission bits,
    /// in place of whatever stood there.
    Copy {
        from: Vec<u8>,
        to: Vec<u8>,
    },
    /// Move a name, a link moving as itself.
    Rename {
        from: Vec<u8>,
        to: Vec<u8>,
    },
    /// Hand standard input back what was read of it and not used, for the
    /// next command to read, where the host's input can take it back.
    Unread {
        data: Vec<u8>,
    },
    /// Remove one directory, which must be empty.
    Rmdir {
        path: Vec<u8>,
    },
    /// Set a file's permission bits.
    Chmod {
        path: Vec<u8>,
        mode: u32,
    },
    Write {
        path: Vec<u8>,
        mode: WriteMode,
        data: Vec<u8>,
    },
    /// Commit one file's writes, or every file's.
    Flush {
        path: Option<Vec<u8>>,
    },
    Spool {
        fd: u32,
        data: Vec<u8>,
    },
    /// Send a spool to the output and drop it; a window, `(skip, size)`,
    /// sends those bytes and keeps it.
    Emit {
        fd: u32,
        window: Option<(u64, u64)>,
    },
    /// Run a command line: its input a spool or the run's own, its output
    /// input `stdout` or the run's own.
    Run {
        command: Vec<u8>,
        stdin: Option<u32>,
        stdout: Option<u32>,
    },
    /// One call to the service an account CLI drives, which the host
    /// signs and sends: the JSON body, when there is one, as the payload.
    #[cfg(feature = "gh")]
    Http {
        method: String,
        path: String,
        params: Vec<(String, String)>,
        headers: Vec<(String, String)>,
        body: Option<Vec<u8>>,
        /// `body` goes as it is rather than read as JSON by the host.
        raw_body: bool,
    },
    /// A file a command's option names, or standard input as `-`.
    #[cfg(feature = "gh")]
    ReadFile {
        flag: Option<String>,
        path: Option<String>,
        option: String,
    },
    /// The time, for a command that reads the clock.
    #[cfg(feature = "gh")]
    Now,
    /// Whether an object grown to `size` bytes still fits the workspace's
    /// memory, the host refusing it if not.
    #[cfg(feature = "gh")]
    Memory {
        size: u64,
    },
    /// Run a jq program over one value; the reply's bytes are its outputs,
    /// a compact dump to a line, and the reply says what stopped it.
    #[cfg(feature = "gh")]
    Jq {
        program: String,
        doc: Vec<u8>,
    },
    /// End the run the way the host ends a command that failed.
    #[cfg(feature = "gh")]
    Fail {
        kind: &'static str,
        message: String,
        code: i32,
    },
}

/// Hand a payload on without copying it when nothing came before it.
fn take_payload(data: &mut Vec<u8>, payload: &mut Vec<u8>) {
    if data.is_empty() {
        std::mem::swap(data, payload);
    } else {
        data.append(payload);
    }
}

#[cfg(feature = "gh")]
fn pairs(items: &[(String, String)]) -> Json {
    Json::Array(
        items
            .iter()
            .map(|(key, value)| Json::Array(vec![key.as_str().into(), value.as_str().into()]))
            .collect(),
    )
}

fn latin1(bytes: &[u8]) -> Json {
    Json::String(bytes.iter().map(|&b| char::from(b)).collect())
}

fn opening(put: &mut impl FnMut(&str, Json), path: &[u8], opening: Opening) {
    match opening {
        Opening::Spool { fd, skip } => {
            put("spool", fd.into());
            if skip > 0 {
                put("skip", skip.into());
            }
        }
        Opening::Window { fd, skip, size } => {
            put("spool", fd.into());
            put("skip", skip.into());
            put("size", size.into());
        }
        Opening::Operand(operand) => {
            put("path", latin1(path));
            put("operand", operand.into());
        }
        Opening::Range(operand, skip, size) => {
            put("path", latin1(path));
            put("operand", operand.into());
            put("skip", skip.into());
            if let Some(size) = size {
                put("size", size.into());
            }
        }
        Opening::AsOperand => {
            put("path", latin1(path));
            put("as_operand", true.into());
        }
        Opening::File => {
            put("path", latin1(path));
            put("file", true.into());
        }
        Opening::Name => put("path", latin1(path)),
    }
}

impl Request {
    /// The request as the host reads it: its JSON header, its payload
    /// moved to `data`.
    pub(crate) fn encode(&mut self, data: &mut Vec<u8>) -> Vec<u8> {
        let mut header = Map::new();
        let mut put = |key: &str, value: Json| {
            header.insert(key.to_owned(), value);
        };
        match self {
            Request::Date {
                zone,
                instant,
                year,
                wall,
            } => {
                put("op", "date".into());
                put("zone", zone.clone().map_or(Json::Null, Json::String));
                if let Some(instant) = instant {
                    put("instant", (*instant).into());
                }
                if let Some(year) = year {
                    put("year", (*year).into());
                }
                if let Some(wall) = wall {
                    put("wall", serde_json::to_value(wall).unwrap());
                }
            }
            Request::Clock => put("op", "clock".into()),
            Request::Read { fd, open, least } => {
                put("op", "read".into());
                put("fd", (*fd).into());
                if *least > 0 {
                    put("least", (*least).into());
                }
                if let Some((path, how)) = open {
                    opening(&mut put, path, *how);
                }
            }
            Request::Close { fd } => {
                put("op", "close".into());
                put("fd", (*fd).into());
            }
            Request::Fill {
                spool,
                open: (path, how),
            } => {
                put("op", "fill".into());
                opening(&mut put, path, *how);
                put("into", (*spool).into());
            }
            Request::Unlink { path } => {
                put("op", "unlink".into());
                put("path", latin1(path));
            }
            Request::Stat { path } => {
                put("op", "stat".into());
                put("path", latin1(path));
            }
            Request::Mkdir { path } => {
                put("op", "mkdir".into());
                put("path", latin1(path));
            }
            Request::Readlink { path } => {
                put("op", "readlink".into());
                put("path", latin1(path));
            }
            Request::Copy { from, to } => {
                put("op", "copy".into());
                put("path", latin1(from));
                put("to", latin1(to));
            }
            Request::Rename { from, to } => {
                put("op", "rename".into());
                put("path", latin1(from));
                put("to", latin1(to));
            }
            Request::Unread { data: payload } => {
                put("op", "unread".into());
                take_payload(data, payload);
            }
            Request::Rmdir { path } => {
                put("op", "rmdir".into());
                put("path", latin1(path));
            }
            Request::Chmod { path, mode } => {
                put("op", "chmod".into());
                put("path", latin1(path));
                put("mode", (*mode).into());
            }
            Request::Write {
                path,
                mode,
                data: payload,
            } => {
                put("op", "write".into());
                put("path", latin1(path));
                match mode {
                    WriteMode::Truncate => put("append", false.into()),
                    WriteMode::Append => put("append", true.into()),
                    WriteMode::Create => put("create", true.into()),
                    WriteMode::Whole => put("whole", true.into()),
                    WriteMode::Replace => put("atomic", true.into()),
                    WriteMode::Spool { fd, skip } => {
                        put("append", true.into());
                        put("spool", (*fd).into());
                        if *skip > 0 {
                            put("skip", (*skip).into());
                        }
                    }
                    WriteMode::Window { fd, skip, size } => {
                        put("create", true.into());
                        put("spool", (*fd).into());
                        put("skip", (*skip).into());
                        put("size", (*size).into());
                    }
                    WriteMode::Slice { fd, skip, size } => {
                        put("append", true.into());
                        put("spool", (*fd).into());
                        put("skip", (*skip).into());
                        put("size", (*size).into());
                    }
                }
                take_payload(data, payload);
            }
            Request::Flush { path } => {
                put("op", "flush".into());
                if let Some(path) = path {
                    put("path", latin1(path));
                }
            }
            Request::Spool { fd, data: payload } => {
                put("op", "spool".into());
                put("fd", (*fd).into());
                take_payload(data, payload);
            }
            Request::Emit { fd, window } => {
                put("op", "emit".into());
                put("fd", (*fd).into());
                if let Some((skip, size)) = window {
                    put("skip", (*skip).into());
                    put("size", (*size).into());
                }
            }
            Request::Run {
                command,
                stdin,
                stdout,
            } => {
                put("op", "run".into());
                put("command", latin1(command));
                if let Some(stdin) = stdin {
                    put("stdin", (*stdin).into());
                }
                if let Some(stdout) = stdout {
                    put("stdout", (*stdout).into());
                }
            }
            #[cfg(feature = "gh")]
            Request::Http {
                method,
                path,
                params,
                headers,
                body,
                raw_body,
            } => {
                put("op", "http".into());
                put("method", method.as_str().into());
                put("path", path.as_str().into());
                put("params", pairs(params));
                put("headers", pairs(headers));
                if let Some(payload) = body {
                    put("has_body", true.into());
                    if *raw_body {
                        put("raw_body", true.into());
                    }
                    take_payload(data, payload);
                }
            }
            #[cfg(feature = "gh")]
            Request::ReadFile { flag, path, option } => {
                put("op", "read_file".into());
                if let Some(flag) = flag {
                    put("flag", flag.as_str().into());
                }
                if let Some(path) = path {
                    put("path", path.as_str().into());
                }
                put("option", option.as_str().into());
            }
            #[cfg(feature = "gh")]
            Request::Now => put("op", "now".into()),
            #[cfg(feature = "gh")]
            Request::Memory { size } => {
                put("op", "memory".into());
                put("size", (*size).into());
            }
            #[cfg(feature = "gh")]
            Request::Jq { program, doc } => {
                put("op", "jq".into());
                put("program", program.as_str().into());
                take_payload(data, doc);
            }
            #[cfg(feature = "gh")]
            Request::Fail {
                kind,
                message,
                code,
            } => {
                put("op", "fail".into());
                put("kind", (*kind).into());
                put("message", message.as_str().into());
                put("code", (*code).into());
            }
        }
        serde_json::to_vec(&Json::Object(header)).unwrap_or_default()
    }

    /// Whether the host writes to the output while doing it.
    pub(crate) fn emits(&self) -> bool {
        matches!(
            self,
            Request::Emit { .. } | Request::Run { stdout: None, .. }
        )
    }
}

/// The host's answer to a request; its text is bytes, one character
/// each.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct Reply {
    /// The input ended; a read's bytes, if any, are its last.
    pub(crate) end: bool,
    /// Why an input, a write or a flush failed, as a diagnostic words it.
    pub(crate) error: Option<String>,
    /// The condition that failure names (`ENOENT`, `EISDIR`, ...), when
    /// the host's vocabulary names one.
    pub(crate) errno: Option<String>,
    /// A failed operand's diagnostic as the host words it, whole.
    pub(crate) line: Option<String>,
    /// The file a flush of every file failed on.
    pub(crate) path: Option<String>,
    /// Why the host refused outright, which ends the run.
    pub(crate) fatal: Option<String>,
    pub(crate) status: Option<f64>,
    /// A filled spool's length, or the length of the file a range opened.
    pub(crate) size: u64,
    /// How far into its file a range opened; none when the host read it
    /// from its start.
    pub(crate) skipped: Option<u64>,
    /// What a stat found: `dir` or `file`; none when nothing stands there.
    pub(crate) kind: Option<String>,
    /// The permission bits a stat found, where the host keeps them.
    pub(crate) mode: Option<u32>,
    /// What a link a readlink found holds; none for a name that is no
    /// link.
    pub(crate) target: Option<String>,
    /// A failed call's message, in the service's words where it gave any.
    #[cfg(feature = "gh")]
    pub(crate) message: Option<String>,
    /// A call's response headers, their names lowercased.
    #[cfg(feature = "gh")]
    pub(crate) headers: BTreeMap<String, String>,
    /// The URL a failed call reached.
    #[cfg(feature = "gh")]
    pub(crate) url: Option<String>,
    /// The time, in seconds.
    #[cfg(feature = "gh")]
    pub(crate) now: Option<f64>,
    /// Whether what stopped a jq run was a string.
    #[cfg(feature = "gh")]
    pub(crate) string: bool,
    /// Whether the program raised that stop with `error` itself.
    #[cfg(feature = "gh")]
    pub(crate) own: bool,
}

impl Reply {
    pub(crate) fn decode(reply: &[u8]) -> Result<Reply, String> {
        serde_json::from_slice(reply).map_err(|err| format!("bad stream reply: {err}"))
    }

    /// Whether the failure names a condition: `ENOENT` and the like.
    pub(crate) fn names(&self, conditions: &[&str]) -> bool {
        self.errno
            .as_deref()
            .is_some_and(|errno| conditions.contains(&errno))
    }
}

/// The requests a run waits on, in the order it asks.
#[derive(Default)]
pub(crate) struct Io {
    pub(crate) requests: VecDeque<Request>,
    pub(crate) in_flight: Option<Request>,
    next_fd: u32,
}

impl Io {
    pub(crate) fn idle(&self) -> bool {
        self.requests.is_empty() && self.in_flight.is_none()
    }

    pub(crate) fn fd(&mut self) -> u32 {
        self.next_fd += 1;
        self.next_fd
    }

    pub(crate) fn push(&mut self, request: Request) {
        self.requests.push_back(request);
    }

    pub(crate) fn take(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let mut request = self.requests.pop_front()?;
        let header = request.encode(data);
        self.in_flight = Some(request);
        Some(header)
    }
}

/// A reply's text as the bytes it stands for.
pub(crate) fn bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u8).collect()
}

/// Whether the host failed the request.
pub(crate) fn failed(reply: &Reply) -> bool {
    reply.error.is_some() || reply.fatal.is_some()
}

/// A host reply's failure text as bytes.
pub(crate) fn failure_text(reply: &Reply) -> Vec<u8> {
    bytes(
        reply
            .error
            .as_deref()
            .or(reply.fatal.as_deref())
            .unwrap_or_default(),
    )
}

/// A failed read as the run reports it: the host's own line for an
/// operand, else `NAME: TEXT`.
pub(crate) fn read_failure(command: &[u8], name: &[u8], reply: &Reply) -> Vec<u8> {
    if let Some(line) = &reply.line {
        return bytes(line);
    }
    let text = bytes(reply.error.as_deref().unwrap_or_default());
    [command, b": ", name, b": ", &text, b"\n"].concat()
}

/// A run its options or operands refused before it read anything, which
/// a host reads as it reads any run: its stderr and its status.
pub(crate) struct Refused {
    stderr: Vec<u8>,
    status: i32,
}

impl Refused {
    pub(crate) fn new(refusal: StreamError) -> Refused {
        let mut stderr = refusal.stderr();
        stderr.push(b'\n');
        Refused {
            stderr,
            status: refusal.status,
        }
    }
}

impl Stream for Refused {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("the run was refused"))
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn status(&self) -> i32 {
        self.status
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}
