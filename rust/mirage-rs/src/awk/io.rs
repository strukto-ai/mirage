use std::collections::{HashMap, VecDeque};

use serde::Deserialize;
use serde_json::{Map, Value as Json};

use super::text::{Regexes, take_record};

/// How much output, or what one file or pipe holds, waits before it goes
/// to the host.
pub(super) const LIMIT: usize = 64 * 1024;

/// Values keyed by byte strings, in the order the keys were first
/// inserted, as awk's arrays iterate and its outputs flush. Each key is
/// held once, in the index; a value's slot keeps the insertion order.
pub(super) struct Ordered<T> {
    index: HashMap<Vec<u8>, usize>,
    slots: Vec<Option<T>>,
}

impl<T> Default for Ordered<T> {
    fn default() -> Self {
        Ordered {
            index: HashMap::new(),
            slots: Vec::new(),
        }
    }
}

impl<T> Ordered<T> {
    pub(super) fn len(&self) -> usize {
        self.index.len()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    pub(super) fn contains(&self, key: &[u8]) -> bool {
        self.index.contains_key(key)
    }

    pub(super) fn get(&self, key: &[u8]) -> Option<&T> {
        self.slots[*self.index.get(key)?].as_ref()
    }

    pub(super) fn get_mut(&mut self, key: &[u8]) -> Option<&mut T> {
        self.slots[*self.index.get(key)?].as_mut()
    }

    pub(super) fn entry(&mut self, key: &[u8], make: impl FnOnce() -> T) -> &mut T {
        let at = match self.index.get(key) {
            Some(&at) => at,
            None => {
                self.slots.push(Some(make()));
                self.index.insert(key.to_vec(), self.slots.len() - 1);
                self.slots.len() - 1
            }
        };
        self.slots[at].as_mut().expect("indexed slots are live")
    }

    pub(super) fn insert(&mut self, key: Vec<u8>, value: T) {
        match self.index.get(&key) {
            Some(&at) => self.slots[at] = Some(value),
            None => {
                self.index.insert(key, self.slots.len());
                self.slots.push(Some(value));
            }
        }
    }

    pub(super) fn remove(&mut self, key: &[u8]) -> Option<T> {
        let at = self.index.remove(key)?;
        let removed = self.slots[at].take();
        if self.slots.len() > 32 && self.index.len() * 2 < self.slots.len() {
            let mut moved = vec![0; self.slots.len()];
            let mut next = 0;
            for (at, slot) in self.slots.iter().enumerate() {
                if slot.is_some() {
                    moved[at] = next;
                    next += 1;
                }
            }
            self.slots.retain(Option::is_some);
            for at in self.index.values_mut() {
                *at = moved[*at];
            }
        }
        removed
    }

    pub(super) fn clear(&mut self) {
        self.index.clear();
        self.slots.clear();
    }

    pub(super) fn keys(&self) -> Vec<Vec<u8>> {
        slot_keys(&self.index, self.slots.len())
            .into_iter()
            .flatten()
            .map(<[u8]>::to_vec)
            .collect()
    }

    pub(super) fn iter_mut(&mut self) -> impl Iterator<Item = (&[u8], &mut T)> {
        let keys = slot_keys(&self.index, self.slots.len());
        self.slots
            .iter_mut()
            .zip(keys)
            .filter_map(|(slot, key)| Some((key?, slot.as_mut()?)))
    }

    pub(super) fn pop_last(&mut self) -> Option<(Vec<u8>, T)> {
        let at = self.slots.iter().rposition(Option::is_some)?;
        let key = slot_keys(&self.index, self.slots.len())[at]?.to_vec();
        self.remove(&key).map(|value| (key, value))
    }
}

/// Each slot's key, in slot order.
fn slot_keys(index: &HashMap<Vec<u8>, usize>, len: usize) -> Vec<Option<&[u8]>> {
    let mut keys = vec![None; len];
    for (key, &at) in index {
        keys[at] = Some(key.as_slice());
    }
    keys
}

/// What the host is asked to do, in the order the run asks.
#[derive(Debug)]
pub(super) enum Request {
    /// The next chunk of input `fd`; the first read of a named input says
    /// which file, and which operand when it is one still as typed.
    Read {
        fd: u32,
        open: Option<(Vec<u8>, Option<usize>)>,
    },
    Close {
        fd: u32,
    },
    /// Append to a file, emptying it first unless `append`.
    Write {
        path: Vec<u8>,
        append: bool,
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

fn latin1(bytes: &[u8]) -> Json {
    Json::String(bytes.iter().map(|&b| char::from(b)).collect())
}

impl Request {
    /// The request as the host reads it: its JSON header, its payload
    /// moved to `data`.
    pub(super) fn encode(&mut self, data: &mut Vec<u8>) -> Vec<u8> {
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
                append,
                data: payload,
            } => {
                put("op", "write".into());
                put("path", latin1(path));
                put("append", (*append).into());
                data.append(payload);
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
                data.append(payload);
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
    pub(super) fn emits(&self) -> bool {
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
pub(super) struct Reply {
    pub(super) end: bool,
    /// Why an input or a write failed, as strerror words it.
    pub(super) error: Option<String>,
    /// Why the host refused outright, which ends the run.
    pub(super) fatal: Option<String>,
    pub(super) status: Option<f64>,
}

fn bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u8).collect()
}

pub(super) enum Next {
    Record(usize, usize),
    End,
    Failed(Vec<u8>),
    Pending,
}

/// One input cut into records with the RS in force at each read, pulled
/// from the host only as far as the next record needs.
pub(super) struct Reader {
    pub(super) fd: u32,
    open: Option<(Vec<u8>, Option<usize>)>,
    pub(super) buf: Vec<u8>,
    start: usize,
    pub(super) ended: bool,
    failed: Option<Vec<u8>>,
    waiting: bool,
}

impl Reader {
    pub(super) fn new(fd: u32, open: Option<(Vec<u8>, Option<usize>)>) -> Reader {
        Reader {
            fd,
            open,
            buf: Vec::new(),
            start: 0,
            ended: false,
            failed: None,
            waiting: false,
        }
    }

    pub(super) fn next(&mut self, rs: &[u8], regexes: &mut Regexes) -> Result<Next, Vec<u8>> {
        if let Some((start, end, next)) =
            take_record(&self.buf, self.start, rs, self.ended, regexes)?
        {
            self.start = next;
            return Ok(Next::Record(start, end));
        }
        Ok(match (&self.failed, self.ended) {
            (_, true) => Next::End,
            (Some(detail), _) => Next::Failed(detail.clone()),
            _ => Next::Pending,
        })
    }

    /// The read to ask for, unless one is out; and whether it opens a
    /// file.
    pub(super) fn read(&mut self) -> Option<(Request, bool)> {
        if std::mem::replace(&mut self.waiting, true) {
            return None;
        }
        let open = self.open.take();
        let opens = open.is_some();
        Some((Request::Read { fd: self.fd, open }, opens))
    }

    /// Whether the host still holds the input open.
    pub(super) fn live(&self) -> bool {
        !self.ended && self.failed.is_none() && self.open.is_none()
    }

    pub(super) fn answer(&mut self, reply: &Reply, data: &[u8]) {
        self.waiting = false;
        if let Some(error) = &reply.error {
            self.failed = Some(bytes(error));
        } else if reply.end {
            self.ended = true;
        } else {
            self.buf.drain(..self.start);
            self.start = 0;
            self.buf.extend_from_slice(data);
        }
    }
}

/// A file awk prints to: what it holds back, and how much of that is
/// settled (printed before the last record ended), which a reader or a
/// command must see.
#[derive(Default)]
pub(super) struct OutFile {
    pub(super) buf: Vec<u8>,
    pub(super) settled: usize,
}

pub(super) struct OutPipe {
    pub(super) fd: u32,
    pub(super) buf: Vec<u8>,
}

/// Everything the run reaches outside itself, and the requests it waits
/// on.
#[derive(Default)]
pub(super) struct Io {
    pub(super) out: Vec<u8>,
    pub(super) err: Vec<u8>,
    /// Standard output held while an output pipe is open, since the
    /// pipe's command prints ahead of it when it runs.
    pub(super) held: Vec<u8>,
    pub(super) held_spool: Option<u32>,
    pub(super) main: Option<Reader>,
    pub(super) files_in: Ordered<Reader>,
    pub(super) pipes_in: Ordered<(Reader, f64)>,
    pub(super) files_out: Ordered<OutFile>,
    pub(super) pipes_out: Ordered<OutPipe>,
    pub(super) requests: VecDeque<Request>,
    pub(super) in_flight: Option<Request>,
    next_fd: u32,
    pub(super) run_status: Option<f64>,
    /// A failure a reply reported, which ends the run when it resumes.
    pub(super) fatal: Option<Vec<u8>>,
    pub(super) salvaging: bool,
}

pub(super) const STDOUT_NAMES: [&[u8]; 2] = [b"/dev/stdout", b"-"];
pub(super) const STDERR_NAME: &[u8] = b"/dev/stderr";

fn output_error(path: &[u8], detail: &[u8]) -> Vec<u8> {
    [
        b"awk: cannot open \"".as_slice(),
        path,
        b"\" for output (",
        detail,
        b")",
    ]
    .concat()
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

    /// Ask for a reader's next chunk: a file opened for reading sees what
    /// was printed to files before the last record ended.
    pub(super) fn read(&mut self, request: Option<(Request, bool)>) {
        if let Some((request, opens)) = request {
            if opens {
                self.send_settled();
            }
            self.push(request);
        }
    }

    pub(super) fn send_settled(&mut self) {
        let mut writes = Vec::new();
        for (path, file) in self.files_out.iter_mut() {
            if file.settled > 0 {
                let data = file.buf.drain(..file.settled).collect();
                file.settled = 0;
                writes.push(Request::Write {
                    path: path.to_vec(),
                    append: true,
                    data,
                });
            }
        }
        self.requests.extend(writes);
    }

    /// Send what every file holds, as a command about to run must see.
    pub(super) fn send_files(&mut self) {
        let mut writes = Vec::new();
        for (path, file) in self.files_out.iter_mut() {
            if !file.buf.is_empty() {
                file.settled = 0;
                writes.push(Request::Write {
                    path: path.to_vec(),
                    append: true,
                    data: std::mem::take(&mut file.buf),
                });
            }
        }
        self.requests.extend(writes);
    }

    pub(super) fn send_file(&mut self, path: &[u8]) {
        if let Some(file) = self.files_out.get_mut(path) {
            if !file.buf.is_empty() {
                file.settled = 0;
                let data = std::mem::take(&mut file.buf);
                self.push(Request::Write {
                    path: path.to_vec(),
                    append: true,
                    data,
                });
            }
        }
    }

    /// The end of a record: what files hold so far is settled, and held
    /// standard output goes once no output pipe is open.
    pub(super) fn settle(&mut self) {
        for (_, file) in self.files_out.iter_mut() {
            file.settled = file.buf.len();
        }
        if self.pipes_out.is_empty() {
            self.release();
        }
    }

    /// Let held standard output go: through the host when part of it is
    /// spooled there or the host is about to write output of its own.
    pub(super) fn release(&mut self) {
        if self.held_spool.is_none() && !self.requests.iter().any(Request::emits) {
            self.out.append(&mut self.held);
            return;
        }
        if self.held.is_empty() && self.held_spool.is_none() {
            return;
        }
        let fd = match self.held_spool.take() {
            Some(fd) => fd,
            None => self.fd(),
        };
        if !self.held.is_empty() {
            let data = std::mem::take(&mut self.held);
            self.push(Request::Spool { fd, data });
        }
        self.push(Request::Emit { fd });
    }

    pub(super) fn stdout(&mut self, body: &[u8]) {
        if self.pipes_out.is_empty() && self.held.is_empty() && self.held_spool.is_none() {
            self.out.extend_from_slice(body);
            return;
        }
        self.held.extend_from_slice(body);
        if self.held.len() >= LIMIT {
            let fd = match self.held_spool {
                Some(fd) => fd,
                None => {
                    let fd = self.fd();
                    self.held_spool = Some(fd);
                    fd
                }
            };
            let data = std::mem::take(&mut self.held);
            self.push(Request::Spool { fd, data });
        }
    }

    /// What a command about to run must see: every file's output and
    /// standard output, as mawk flushes before it forks.
    pub(super) fn before_command(&mut self) {
        self.send_files();
        self.release();
    }

    pub(super) fn take_request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let mut request = self.requests.pop_front()?;
        let header = request.encode(data);
        self.in_flight = Some(request);
        Some(header)
    }

    /// Take the host's answer to the request in flight.
    pub(super) fn answer(&mut self, reply: &[u8], data: &[u8]) -> Result<(), String> {
        let reply: Reply =
            serde_json::from_slice(reply).map_err(|err| format!("bad stream reply: {err}"))?;
        let Some(request) = self.in_flight.take() else {
            return Err("no request is waiting".into());
        };
        if let Some(fatal) = &reply.fatal {
            self.fail([b"awk: ".as_slice(), &bytes(fatal)].concat());
            return Ok(());
        }
        match request {
            Request::Read { fd, .. } => {
                if let Some(reader) = self.reader(fd) {
                    reader.answer(&reply, data);
                }
            }
            Request::Write { path, .. } => {
                if let Some(error) = &reply.error {
                    self.fail(output_error(&path, &bytes(error)));
                }
            }
            Request::Run { .. } => self.run_status = Some(reply.status.unwrap_or(0.0)),
            _ => {}
        }
        Ok(())
    }

    fn reader(&mut self, fd: u32) -> Option<&mut Reader> {
        if let Some(main) = self.main.as_mut().filter(|main| main.fd == fd) {
            return Some(main);
        }
        if let Some((_, reader)) = self.files_in.iter_mut().find(|(_, r)| r.fd == fd) {
            return Some(reader);
        }
        self.pipes_in
            .iter_mut()
            .find(|(_, (r, _))| r.fd == fd)
            .map(|(_, (reader, _))| reader)
    }

    /// A failure in what the host did: the run ends, or while it is ending
    /// already the failure is reported and the files' writes stop.
    fn fail(&mut self, message: Vec<u8>) {
        if self.salvaging {
            self.err.extend_from_slice(&message);
            self.err.push(b'\n');
            self.requests
                .retain(|r| !matches!(r, Request::Write { .. } | Request::Flush { .. }));
        } else {
            self.requests.clear();
            self.fatal = Some(message);
        }
    }
}
