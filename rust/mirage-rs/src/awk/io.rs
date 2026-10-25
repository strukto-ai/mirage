use std::collections::{HashMap, VecDeque};

use super::text::{Regexes, take_record};
use super::value::MAX_LEN;
use super::vm::no_memory;
use crate::request::{Opening, Reply, Request, WriteMode, bytes};

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
    open: Option<(Vec<u8>, Opening)>,
    pub(super) buf: Vec<u8>,
    start: usize,
    pub(super) ended: bool,
    failed: Option<Vec<u8>>,
    waiting: bool,
}

impl Reader {
    pub(super) fn new(fd: u32, open: Option<(Vec<u8>, Opening)>) -> Reader {
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
            // A record past the longest string awk keeps ends the run.
            _ if self.buf.len() - self.start > MAX_LEN => return Err(no_memory()),
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
        Some((
            Request::Read {
                fd: self.fd,
                open,
                least: 0,
            },
            opens,
        ))
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
                self.commit();
            }
            self.push(request);
        }
    }

    /// Commit what every file was sent, as a file opened for reading and
    /// a command about to run must see it.
    fn commit(&mut self) {
        if !self.files_out.is_empty() {
            self.push(Request::Flush { path: None });
        }
    }

    /// Run a command once the files hold what was sent to them.
    pub(super) fn run(&mut self, request: Request) {
        self.commit();
        self.push(request);
    }

    pub(super) fn send_settled(&mut self) {
        let mut writes = Vec::new();
        for (path, file) in self.files_out.iter_mut() {
            if file.settled > 0 {
                let data = file.buf.drain(..file.settled).collect();
                file.settled = 0;
                writes.push(Request::Write {
                    path: path.to_vec(),
                    mode: WriteMode::Append,
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
                    mode: WriteMode::Append,
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
                    mode: WriteMode::Append,
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
        self.push(Request::Emit { fd, window: None });
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
        let reply = Reply::decode(reply)?;
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
            Request::Write { path, .. } | Request::Flush { path: Some(path) } => {
                if let Some(error) = &reply.error {
                    let path = reply.path.as_deref().map_or(path, bytes);
                    self.fail(output_error(&path, &bytes(error)));
                }
            }
            Request::Flush { path: None } => {
                if let (Some(error), Some(path)) = (&reply.error, &reply.path) {
                    self.fail(output_error(&bytes(path), &bytes(error)));
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
