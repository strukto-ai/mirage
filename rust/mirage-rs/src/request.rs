//! The operations a stream that reaches files and commands asks its host
//! for, and the host's answers, which awk and sed share.

use serde::Deserialize;
use serde_json::{Map, Value as Json};

/// How a write lands in its file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteMode {
    /// Empty the file first.
    Truncate,
    Append,
    /// Replace the file whole, once flushed, with what this write and the
    /// appends after it carry; never flushed, it changes nothing.
    Replace,
    /// Append what a spool holds, and drop the spool.
    Spool(u32),
}

/// What the host is asked to do, in the order the run asks.
#[derive(Debug)]
pub(crate) enum Request {
    /// The next chunk of input `fd`; the first read of a named input says
    /// which file, and which operand when it is one still as typed.
    Read {
        fd: u32,
        open: Option<(Vec<u8>, Option<usize>)>,
    },
    Close {
        fd: u32,
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
    /// Send a spool to the output and drop it.
    Emit {
        fd: u32,
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
                if let Some((path, operand)) = open {
                    put("path", latin1(path));
                    if let Some(operand) = operand {
                        put("operand", (*operand).into());
                    }
                }
            }
            Request::Close { fd } => {
                put("op", "close".into());
                put("fd", (*fd).into());
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
                    WriteMode::Replace => put("atomic", true.into()),
                    WriteMode::Spool(fd) => {
                        put("append", true.into());
                        put("spool", (*fd).into());
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
            Request::Emit { fd } => {
                put("op", "emit".into());
                put("fd", (*fd).into());
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
    /// The file a flush of every file failed on.
    pub(crate) path: Option<String>,
    /// Why the host refused outright, which ends the run.
    pub(crate) fatal: Option<String>,
    pub(crate) status: Option<f64>,
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

/// A reply's text as the bytes it stands for.
pub(crate) fn bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u8).collect()
}
