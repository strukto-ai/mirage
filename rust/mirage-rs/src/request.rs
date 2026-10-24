//! The operations a stream that reaches files and commands asks its host
//! for, and the host's answers, which awk, sed, split and csplit share.

use std::collections::VecDeque;

use serde::Deserialize;
use serde_json::{Map, Value as Json};

/// How a write lands in its file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteMode {
    /// Empty the file first.
    Truncate,
    Append,
    /// Write the file whole as one streamed write, its bytes landing as
    /// this write and the appends after it carry them.
    Create,
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
}

/// What a read opens: an operand still as typed, a name a program reads
/// (where `-` and `/dev/stdin` are standard input), a file a script
/// names, which no spelling of standard input stands for, or a spool the
/// run filled, past its first `skip` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Opening {
    Operand(usize),
    Name,
    File,
    Spool { fd: u32, skip: u64 },
}

/// What the host is asked to do, in the order the run asks.
#[derive(Debug)]
pub(crate) enum Request {
    /// The next chunk of input `fd`; the first read of a named input says
    /// which file, and which operand when it is one still as typed.
    Read {
        fd: u32,
        open: Option<(Vec<u8>, Opening)>,
    },
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
}

/// Hand a payload on without copying it when nothing came before it.
fn take_payload(data: &mut Vec<u8>, payload: &mut Vec<u8>) {
    if data.is_empty() {
        std::mem::swap(data, payload);
    } else {
        data.append(payload);
    }
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
        Opening::Operand(operand) => {
            put("path", latin1(path));
            put("operand", operand.into());
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
            Request::Read { fd, open } => {
                put("op", "read".into());
                put("fd", (*fd).into());
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
    /// A filled spool's length.
    pub(crate) size: u64,
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
