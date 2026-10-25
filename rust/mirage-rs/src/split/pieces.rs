//! What split and csplit share: the input, read through the host a chunk
//! at a time, and each piece written through it, held to `LIMIT` bytes
//! before it goes.

use crate::request::{Io, Opening, Reply, Request, WriteMode, bytes};
use crate::{Stream, StreamError};

/// How much of a piece waits before it goes to the host.
pub(super) const LIMIT: usize = 64 * 1024;

/// The longest suffix a piece's name takes: past it the run ends as GNU's
/// does once memory runs out (GNU allocates up to the address space, then
/// fails the open on the name's length).
pub(super) const MAX_SUFFIX: usize = 1 << 16;

/// The steps one `drain` runs before the host may yield.
pub(super) const STEPS: usize = 20_000;

/// One input and the bytes of its last chunk still unread.
pub(super) struct Input {
    pub(super) fd: u32,
    open: Option<(Vec<u8>, Opening)>,
    pub(super) buf: Vec<u8>,
    pub(super) at: usize,
    pub(super) ended: bool,
}

impl Input {
    pub(super) fn new(io: &mut Io, name: Vec<u8>, opening: Opening) -> Input {
        Input {
            fd: io.fd(),
            open: Some((name, opening)),
            buf: Vec::new(),
            at: 0,
            ended: false,
        }
    }

    pub(super) fn rest(&self) -> &[u8] {
        &self.buf[self.at..]
    }

    /// Ask for the next chunk.
    pub(super) fn pull(&mut self, io: &mut Io) {
        let open = self.open.take();
        io.push(Request::Read { fd: self.fd, open });
    }

    /// Take the host's answer to a read; a failure comes back for the run
    /// to report.
    pub(super) fn answer(&mut self, reply: Reply, data: &[u8]) -> Option<Reply> {
        if reply.error.is_some() {
            return Some(reply);
        }
        if reply.end {
            self.ended = true;
        } else {
            self.buf.clear();
            self.buf.extend_from_slice(data);
            self.at = 0;
        }
        None
    }
}

/// A failed read as the run reports it: the host's own line for an
/// operand, else `NAME: TEXT`.
pub(super) fn read_failure(command: &[u8], name: &[u8], reply: &Reply) -> Vec<u8> {
    if let Some(line) = &reply.line {
        return bytes(line);
    }
    let text = bytes(reply.error.as_deref().unwrap_or_default());
    [command, b": ", name, b": ", &text, b"\n"].concat()
}

/// One output file: created by its first write, committed by `close`.
pub(super) struct Piece {
    pub(super) name: Vec<u8>,
    created: bool,
    held: Vec<u8>,
    /// What it holds before it sends it.
    pub(super) limit: usize,
}

impl Piece {
    pub(super) fn new(name: Vec<u8>) -> Piece {
        Piece {
            name,
            created: false,
            held: Vec::new(),
            limit: LIMIT,
        }
    }

    /// Hold `data`, a write going each time `limit` bytes are held; the
    /// buffer is taken once at that size and never grows past it.
    pub(super) fn put(&mut self, mut data: &[u8], io: &mut Io) {
        while !data.is_empty() {
            if self.held.capacity() == 0 {
                self.held.reserve_exact(self.limit);
            }
            let take = (self.limit - self.held.len()).min(data.len());
            self.held.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.held.len() >= self.limit {
                self.send(io);
            }
        }
    }

    fn send(&mut self, io: &mut Io) {
        let mode = if std::mem::replace(&mut self.created, true) {
            WriteMode::Append
        } else {
            WriteMode::Create
        };
        io.push(Request::Write {
            path: self.name.clone(),
            mode,
            data: std::mem::take(&mut self.held),
        });
    }

    /// Create the file now, empty.
    pub(super) fn create(&mut self, io: &mut Io) {
        self.send(io);
    }

    /// Write what is held, the file itself when nothing was, and commit it.
    pub(super) fn close(mut self, io: &mut Io) {
        if !self.created || !self.held.is_empty() {
            self.send(io);
        }
        io.push(Request::Flush {
            path: Some(self.name),
        });
    }
}

/// A failed write or removal as the run reports it: the host's own line
/// for a file it refused, else `NAME: TEXT`.
pub(super) fn write_failure(command: &[u8], request: &Request, reply: &Reply) -> Option<Vec<u8>> {
    reply.error.as_ref()?;
    match request {
        Request::Write { path, .. }
        | Request::Flush { path: Some(path) }
        | Request::Unlink { path } => Some(read_failure(command, path, reply)),
        _ => None,
    }
}

/// A run its options or operands refused before it read anything.
pub(super) struct Refused {
    stderr: Vec<u8>,
}

impl Refused {
    pub(super) fn new(mut stderr: Vec<u8>) -> Refused {
        stderr.push(b'\n');
        Refused { stderr }
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
        1
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}
