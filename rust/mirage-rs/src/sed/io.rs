use std::collections::VecDeque;
use std::task::Poll;

use crate::request::{Opening, Reply, Request, bytes};

/// How much output, or what one file holds, waits before it goes to the
/// host.
pub(super) const LIMIT: usize = 64 * 1024;

/// The longest line, pattern space or hold space sed holds: past it the
/// run ends as GNU's does once memory runs out.
#[cfg(not(test))]
pub(super) const MAX_LEN: usize = 1 << 30;
#[cfg(test)]
pub(super) const MAX_LEN: usize = 1 << 18;

/// The failures of opening an input, which sed reports and reads on past;
/// any other is a read error that stops it.
const OPEN_FAILURES: [&str; 6] = ["ENOENT", "EACCES", "EPERM", "EROFS", "ENOTDIR", "ELOOP"];

/// A read the host could not serve, as its reply words it.
pub(super) struct Failure {
    pub(super) text: Vec<u8>,
    reply: Reply,
}

impl Failure {
    pub(super) fn from(reply: Reply) -> Failure {
        Failure {
            text: bytes(reply.error.as_deref().unwrap_or_default()),
            reply,
        }
    }

    /// Whether the input never opened, which sed reads past.
    pub(super) fn unopened(&self) -> bool {
        self.reply.names(&OPEN_FAILURES)
    }

    pub(super) fn names(&self, conditions: &[&str]) -> bool {
        self.reply.names(conditions)
    }
}

pub(super) fn read_error(name: &[u8], failure: &Failure) -> Vec<u8> {
    [
        b"sed: read error on ".as_slice(),
        name,
        b": ",
        &failure.text,
        b"\n",
    ]
    .concat()
}

/// The requests a run waits on, in the order it asks.
#[derive(Default)]
pub(super) struct Io {
    pub(super) requests: VecDeque<Request>,
    pub(super) in_flight: Option<Request>,
    next_fd: u32,
}

impl Io {
    pub(super) fn idle(&self) -> bool {
        self.requests.is_empty() && self.in_flight.is_none()
    }

    pub(super) fn fd(&mut self) -> u32 {
        self.next_fd += 1;
        self.next_fd
    }

    pub(super) fn push(&mut self, request: Request) {
        self.requests.push_back(request);
    }

    pub(super) fn take(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let mut request = self.requests.pop_front()?;
        let header = request.encode(data);
        self.in_flight = Some(request);
        Some(header)
    }
}

/// A line and whether a newline ended it.
pub(super) type Line = (Vec<u8>, bool);

/// The next line and the input it came from, or the read error that ends
/// the run.
type Taken = Result<Option<(Line, usize)>, Vec<u8>>;

/// The lines of one input, read through one growing buffer and pulled
/// from the host only as far as the next line needs: a line's pieces are
/// searched once each, however many chunks it arrives in.
pub(super) struct LineReader {
    pub(super) fd: u32,
    open: Option<(Vec<u8>, Opening)>,
    buf: Vec<u8>,
    start: usize,
    scanned: usize,
    ended: bool,
    /// Whether any chunk arrived.
    pub(super) started: bool,
    waiting: bool,
    failed: Option<Failure>,
}

impl LineReader {
    pub(super) fn new(io: &mut Io, name: Vec<u8>, opening: Opening) -> LineReader {
        LineReader {
            fd: io.fd(),
            open: Some((name, opening)),
            buf: Vec::new(),
            start: 0,
            scanned: 0,
            ended: false,
            started: false,
            waiting: false,
            failed: None,
        }
    }

    fn pull(&mut self, io: &mut Io) {
        if !std::mem::replace(&mut self.waiting, true) {
            let open = self.open.take();
            io.push(Request::Read { fd: self.fd, open });
        }
    }

    /// Whether another byte follows, pulling no more than it takes to see
    /// one.
    pub(super) fn peek(&mut self, io: &mut Io) -> Poll<Result<bool, Failure>> {
        if self.start < self.buf.len() {
            return Poll::Ready(Ok(true));
        }
        if self.ended {
            return Poll::Ready(Ok(false));
        }
        if let Some(failure) = self.failed.take() {
            return Poll::Ready(Err(failure));
        }
        self.pull(io);
        Poll::Pending
    }

    /// The next line, None at the end.
    pub(super) fn line(&mut self, io: &mut Io) -> Poll<Result<Option<Line>, Failure>> {
        let from = self.scanned.max(self.start);
        let cut = memchr::memchr(b'\n', &self.buf[from..]).map(|at| from + at);
        // A line longer than sed holds is a read it cannot make.
        if cut.unwrap_or(self.buf.len()) - self.start > MAX_LEN {
            return Poll::Ready(Err(Failure::from(Reply {
                error: Some("Cannot allocate memory".into()),
                errno: Some("ENOMEM".into()),
                ..Reply::default()
            })));
        }
        if let Some(cut) = cut {
            let line = self.buf[self.start..cut].to_vec();
            self.start = cut + 1;
            self.scanned = self.start;
            return Poll::Ready(Ok(Some((line, true))));
        }
        self.scanned = self.buf.len();
        if self.ended {
            if self.start >= self.buf.len() {
                return Poll::Ready(Ok(None));
            }
            let line = self.buf[self.start..].to_vec();
            self.start = self.buf.len();
            return Poll::Ready(Ok(Some((line, false))));
        }
        if let Some(failure) = self.failed.take() {
            return Poll::Ready(Err(failure));
        }
        self.pull(io);
        Poll::Pending
    }

    /// Whether the host still holds the input open.
    pub(super) fn live(&self) -> bool {
        self.open.is_none() && !self.ended && self.failed.is_none()
    }

    pub(super) fn answer(&mut self, reply: Reply, data: &[u8]) {
        self.waiting = false;
        if reply.error.is_some() {
            self.failed = Some(Failure::from(reply));
        } else if reply.end {
            self.ended = true;
        } else {
            self.started = true;
            if self.start > self.buf.len() / 2 {
                self.buf.drain(..self.start);
                self.scanned -= self.start;
                self.start = 0;
            }
            self.buf.extend_from_slice(data);
        }
    }
}

/// One input as `F` names it, and the operand it is, from 1.
pub(super) struct Input {
    pub(super) name: Vec<u8>,
    pub(super) opening: Opening,
}

/// What reading an input reported along the way: the inputs that never
/// opened, which sed names and reads past.
#[derive(Default)]
pub(super) struct Notes {
    pub(super) stderr: Vec<u8>,
    pub(super) bad: bool,
}

impl Notes {
    fn unopened(&mut self, name: &[u8], failure: &Failure) {
        self.bad = true;
        self.stderr.extend_from_slice(b"sed: can't read ");
        self.stderr.extend_from_slice(name);
        self.stderr.extend_from_slice(b": ");
        self.stderr.extend_from_slice(&failure.text);
        self.stderr.push(b'\n');
    }
}

/// The input lines, one input after another, with the one-byte look-ahead
/// sed needs for `$`, `n` and `N`: an input that fails as it is looked
/// into ends there without a word, where reading on reports it.
pub(super) struct Feed {
    pub(super) inputs: Vec<Input>,
    /// The inputs it reads: all of them, or under -i one.
    pub(super) range: std::ops::Range<usize>,
    /// The input opened last.
    pub(super) index: Option<usize>,
    pub(super) reader: Option<LineReader>,
    /// The look-ahead's answer, until the next line is taken.
    more: Option<bool>,
}

impl Feed {
    pub(super) fn new(inputs: Vec<Input>) -> Feed {
        Feed {
            range: 0..inputs.len(),
            inputs,
            index: None,
            reader: None,
            more: None,
        }
    }

    /// Read input `index` alone, from `reader`, which opened it.
    pub(super) fn only(&mut self, index: usize, reader: LineReader) {
        self.range = index..index + 1;
        self.index = Some(index);
        self.reader = Some(reader);
        self.more = None;
    }

    pub(super) fn name(&self) -> &[u8] {
        self.index
            .map_or(b"-".as_slice(), |index| &self.inputs[index].name)
    }

    fn advance(&mut self, io: &mut Io) -> bool {
        let next = self.index.map_or(self.range.start, |index| index + 1);
        if next >= self.range.end {
            return false;
        }
        self.index = Some(next);
        let input = &self.inputs[next];
        self.reader = Some(LineReader::new(io, input.name.clone(), input.opening));
        true
    }

    /// The next line and the input it came from, None once every input
    /// has ended; a read error ends the run with its message.
    pub(super) fn read(&mut self, io: &mut Io, notes: &mut Notes) -> Poll<Taken> {
        self.more = None;
        loop {
            if let Some(reader) = &mut self.reader {
                let index = self.index.unwrap_or_default();
                match reader.line(io) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Ok(Some(line))) => return Poll::Ready(Ok(Some((line, index)))),
                    Poll::Ready(Ok(None)) => self.reader = None,
                    Poll::Ready(Err(failure)) => {
                        let started = reader.started;
                        self.reader = None;
                        let name = &self.inputs[index].name;
                        if failure.unopened() && !started {
                            notes.unopened(name, &failure);
                        } else {
                            let shown = if name == b"-" {
                                b"stdin".as_slice()
                            } else {
                                name
                            };
                            return Poll::Ready(Err(read_error(shown, &failure)));
                        }
                    }
                }
            }
            if !self.advance(io) {
                return Poll::Ready(Ok(None));
            }
        }
    }

    /// Whether another line follows, in the current input only when
    /// `within`.
    pub(super) fn more(&mut self, within: bool, io: &mut Io, notes: &mut Notes) -> Poll<bool> {
        if let Some(more) = self.more {
            return Poll::Ready(more);
        }
        loop {
            if let Some(reader) = &mut self.reader {
                match reader.peek(io) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Ok(true)) => {
                        self.more = Some(true);
                        return Poll::Ready(true);
                    }
                    Poll::Ready(Ok(false)) => {}
                    Poll::Ready(Err(failure)) => {
                        if failure.unopened() && !reader.started {
                            let name = &self.inputs[self.index.unwrap_or_default()].name;
                            notes.unopened(name, &failure);
                        }
                    }
                }
                self.reader = None;
            }
            if within || !self.advance(io) {
                self.more = Some(false);
                return Poll::Ready(false);
            }
        }
    }
}
