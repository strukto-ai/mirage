use std::collections::{BTreeMap, HashMap, VecDeque};

use super::buffer::Buffer;
use super::text::{RecordSearch, Regexes, take_record};
use super::value::{MAX_LEN, Text};
use super::vm::no_memory;
use crate::request::{Opening, Reply, Request, WriteMode, bytes};

/// How much output, or what one file or pipe holds, waits before it goes
/// to the host.
pub(super) const LIMIT: usize = 64 * 1024;

/// Values keyed by byte strings, in the order the keys were first inserted.
pub(super) struct Ordered<T> {
    index: HashMap<Text, u64>,
    slots: BTreeMap<u64, (Text, T)>,
    next: u64,
}

impl<T> Default for Ordered<T> {
    fn default() -> Self {
        Ordered {
            index: HashMap::new(),
            slots: BTreeMap::new(),
            next: 0,
        }
    }
}

pub(super) struct Retired<T> {
    keys: std::collections::hash_map::IntoIter<Text, u64>,
    slots: std::collections::btree_map::IntoIter<u64, (Text, T)>,
}

impl<T> Retired<T> {
    pub(super) fn step(&mut self, work: &mut u64) -> bool {
        while *work > 0 {
            if self.keys.next().is_some() || self.slots.next().is_some() {
                *work = work.saturating_sub(16);
            } else {
                return true;
            }
        }
        false
    }
}

impl<T> Ordered<T> {
    pub(super) fn retire(&mut self) -> Retired<T> {
        self.next = 0;
        Retired {
            keys: std::mem::take(&mut self.index).into_iter(),
            slots: std::mem::take(&mut self.slots).into_iter(),
        }
    }

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
        self.slots.get(self.index.get(key)?).map(|(_, value)| value)
    }

    pub(super) fn get_mut(&mut self, key: &[u8]) -> Option<&mut T> {
        self.slots
            .get_mut(self.index.get(key)?)
            .map(|(_, value)| value)
    }

    pub(super) fn entry(&mut self, key: &Text, make: impl FnOnce() -> T) -> &mut T {
        let at = match self.index.get(key) {
            Some(&at) => at,
            None => {
                let at = self.next;
                self.next = self
                    .next
                    .checked_add(1)
                    .expect("insertion sequence fits u64");
                self.index.insert(key.clone(), at);
                self.slots.insert(at, (key.clone(), make()));
                at
            }
        };
        &mut self.slots.get_mut(&at).expect("indexed slots are live").1
    }

    pub(super) fn insert(&mut self, key: impl Into<Text>, value: T) {
        let key = key.into();
        if let Some(&at) = self.index.get(&key) {
            self.slots.get_mut(&at).expect("indexed slots are live").1 = value;
        } else {
            self.entry(&key, || value);
        }
    }

    pub(super) fn remove(&mut self, key: &[u8]) -> Option<T> {
        let at = self.index.remove(key)?;
        self.slots.remove(&at).map(|(_, value)| value)
    }

    pub(super) fn next_key(&self, at: &mut u64) -> Option<Text> {
        let (&id, (key, _)) = self.slots.range(*at..).next()?;
        *at = id + 1;
        Some(key.clone())
    }

    pub(super) fn iter_mut(&mut self) -> impl Iterator<Item = (&[u8], &mut T)> {
        self.slots
            .values_mut()
            .map(|(key, value)| (key.as_slice(), value))
    }

    pub(super) fn pop_last(&mut self) -> Option<(Text, T)> {
        let (_, (key, value)) = self.slots.pop_last()?;
        self.index.remove(&key);
        Some((key, value))
    }
}

pub(super) enum Next {
    Record(Text),
    End,
    Failed(Vec<u8>),
    Pending,
    Busy,
}

/// One input cut into records with the RS in force at each read, pulled
/// from the host only as far as the next record needs.
struct RecordCopy {
    start: usize,
    end: usize,
    out: Vec<u8>,
}

pub(super) struct Reader {
    pub(super) fd: u32,
    open: Option<(Vec<u8>, Opening)>,
    buf: Buffer<u8>,
    incoming: Option<(Vec<u8>, usize)>,
    copying: Option<RecordCopy>,
    start: usize,
    search: RecordSearch,
    pub(super) ended: bool,
    failed: Option<Vec<u8>>,
    waiting: bool,
}

impl Reader {
    pub(super) fn new(fd: u32, open: Option<(Vec<u8>, Opening)>) -> Reader {
        Reader {
            fd,
            open,
            buf: Buffer::default(),
            incoming: None,
            copying: None,
            start: 0,
            search: RecordSearch::default(),
            ended: false,
            failed: None,
            waiting: false,
        }
    }

    pub(super) fn next(
        &mut self,
        rs: &[u8],
        regexes: &mut Regexes,
        budget: &mut u64,
    ) -> Result<Next, Vec<u8>> {
        if self.copying.is_some() {
            return Ok(self.copy_record(budget));
        }
        if !self.buf.reserve(0, budget) {
            return Ok(Next::Busy);
        }
        if self.start > self.buf.len() / 2 || (self.start > 0 && self.incoming.is_some()) {
            self.search.shift(self.start);
            let additional = self
                .incoming
                .as_ref()
                .map_or(0, |(bytes, at)| bytes.len() - at);
            self.buf.compact(self.start, additional);
            self.start = 0;
            if !self.buf.reserve(0, budget) {
                return Ok(Next::Busy);
            }
        }
        if let Some((bytes, at)) = &mut self.incoming {
            if !self.buf.reserve(bytes.len() - *at, budget) {
                return Ok(Next::Busy);
            }
            let count = (bytes.len() - *at).min(*budget as usize);
            self.buf.values.extend_from_slice(&bytes[*at..*at + count]);
            *at += count;
            *budget -= count as u64;
            if *at < bytes.len() {
                return Ok(Next::Busy);
            }
            self.incoming = None;
        }

        match take_record(
            &self.buf,
            self.start,
            rs,
            self.ended,
            regexes,
            &mut self.search,
            budget,
        )? {
            crate::regex::Step::Paused => return Ok(Next::Busy),
            crate::regex::Step::Done(Some((start, end, next))) => {
                self.start = next;
                self.search.reset(next);
                self.copying = Some(RecordCopy {
                    start,
                    end,
                    out: Vec::with_capacity(end - start),
                });
                return Ok(self.copy_record(budget));
            }
            crate::regex::Step::Done(None) => {}
        }
        Ok(match (&self.failed, self.ended) {
            (_, true) => Next::End,
            (Some(detail), _) => Next::Failed(detail.clone()),
            // A record past the longest string awk keeps ends the run.
            _ if self.buf.len() - self.start > MAX_LEN => return Err(no_memory()),
            _ => Next::Pending,
        })
    }

    fn copy_record(&mut self, budget: &mut u64) -> Next {
        let record = self.copying.as_mut().unwrap();
        let from = record.start + record.out.len();
        let count = (record.end - from).min(*budget as usize);
        record.out.extend_from_slice(&self.buf[from..from + count]);
        *budget -= count as u64;
        if from + count == record.end {
            Next::Record(self.copying.take().unwrap().out.into())
        } else {
            Next::Busy
        }
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
            assert!(self.incoming.is_none());
            self.incoming = Some((data.to_vec(), 0));
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
    diagnostics: VecDeque<Vec<u8>>,
    diagnostic_at: usize,
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

pub(super) struct Retirement {
    files_in: Retired<Reader>,
    pipes_in: Retired<(Reader, f64)>,
    files_out: Retired<OutFile>,
    pipes_out: Retired<OutPipe>,
}

impl Retirement {
    pub(super) fn step(&mut self, work: &mut u64) -> bool {
        self.files_in.step(work)
            && self.pipes_in.step(work)
            && self.files_out.step(work)
            && self.pipes_out.step(work)
    }
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
    pub(super) fn diagnose(&mut self, message: Vec<u8>) {
        self.diagnostics.push_back(message);
    }

    pub(super) fn reporting(&self) -> bool {
        !self.diagnostics.is_empty()
    }

    pub(super) fn report(&mut self, work: &mut u64) {
        while *work > 0 && self.err.len() < LIMIT {
            let Some(message) = self.diagnostics.front() else {
                break;
            };
            let count = (message.len() - self.diagnostic_at)
                .min(*work as usize)
                .min(LIMIT - self.err.len());
            self.err
                .extend_from_slice(&message[self.diagnostic_at..self.diagnostic_at + count]);
            self.diagnostic_at += count;
            *work -= count as u64;
            if self.diagnostic_at == message.len() && *work > 0 && self.err.len() < LIMIT {
                self.err.push(b'\n');
                self.diagnostics.pop_front();
                self.diagnostic_at = 0;
                *work -= 1;
            }
        }
    }

    pub(super) fn retire(&mut self) -> Retirement {
        Retirement {
            files_in: self.files_in.retire(),
            pipes_in: self.pipes_in.retire(),
            files_out: self.files_out.retire(),
            pipes_out: self.pipes_out.retire(),
        }
    }

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
            self.diagnose(message);
            self.requests
                .retain(|r| !matches!(r, Request::Write { .. } | Request::Flush { .. }));
        } else {
            self.requests.clear();
            self.fatal = Some(message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffered_suffix_compaction_and_later_growth_preserve_records() {
        let prefix = vec![b'a'; 16387];
        let suffix = vec![b'b'; 8193];
        let mut input = prefix.clone();
        input.push(b'\n');
        input.extend_from_slice(&suffix);
        for budget in [1, 17, 20000] {
            let mut reader = Reader::new(1, None);
            reader.answer(&Reply::decode(b"{}").unwrap(), &input);
            let mut regexes = Regexes::default();
            let mut records = Vec::new();
            let mut more = false;
            let mut turns = 0;
            loop {
                turns += 1;
                assert!(turns < 200000);
                match reader.next(b"\n", &mut regexes, &mut { budget }).unwrap() {
                    Next::Record(record) => records.push(record.to_vec()),
                    Next::Busy => {}
                    Next::Pending if !more => {
                        assert_eq!(records, vec![prefix.clone()]);
                        let mut tail = suffix.clone();
                        tail.extend_from_slice(b"\nlast");
                        reader.answer(&Reply::decode(b"{}").unwrap(), &tail);
                        more = true;
                    }
                    Next::Pending => {
                        reader.answer(&Reply::decode(br#"{"end":true}"#).unwrap(), &[])
                    }
                    Next::End => break,
                    Next::Failed(_) => panic!("input should remain readable"),
                }
            }
            assert_eq!(
                records,
                vec![prefix.clone(), suffix.repeat(2), b"last".to_vec()]
            );
        }
    }

    #[test]
    fn record_transfer_resumes_without_reading_or_delivering_twice() {
        let size = 131073;
        let mut reader = Reader::new(1, None);
        let mut input = vec![b'a'; size];
        input.extend_from_slice(b"\nnext\n");
        reader.answer(&Reply::decode(b"{}").unwrap(), &input);
        let mut regexes = Regexes::default();
        let mut turns = 0;
        loop {
            let mut work = 4096;
            turns += 1;
            match reader.next(b"\n", &mut regexes, &mut work).unwrap() {
                Next::Busy => assert!(!reader.waiting),
                Next::Record(record) => {
                    assert_eq!(record.as_slice(), &input[..size]);
                    break;
                }
                _ => panic!("the buffered record must finish before another read"),
            }
            assert!(turns < 1000);
        }
        assert!(turns >= 2 * size / 4096);
        match reader.next(b"\n", &mut regexes, &mut 4096).unwrap() {
            Next::Record(record) => assert_eq!(record.as_slice(), b"next"),
            _ => panic!("the next buffered record remains available"),
        }
    }
}
