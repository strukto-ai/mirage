//! `-c`: the members the host's walk planned, each header then its data read
//! through the host, written to the archive or standard output as they
//! come, through the compressor when one is named, ending in two zero
//! blocks and the rest of the record.

use super::header::{self, BLOCK, Kind, RECORD, padding};
use super::{
    Config, Entry, FAILED, Planned, READ, TRAILER, WINDOW, escaped, lines, open_failure, read,
};
use crate::Stream;
use crate::request::{Opening, Reply, Request, WriteMode, failed, failure_text};
use crate::task::Host;

/// The spool a member of unknown size is read into first.
const SPOOL: u32 = 2;
/// The most a codec stream takes a feed.
const FEED: usize = 16 * 1024;

/// The archive on its way out: through the compressor, gathered to a window,
/// then to the host's file or the output.
struct Output<'h> {
    host: &'h Host,
    path: Option<Vec<u8>>,
    codec: Option<Box<dyn Stream>>,
    held: Vec<u8>,
    /// The tar bytes written, which the record pads.
    written: u64,
    failure: Option<Reply>,
}

impl Output<'_> {
    async fn put(&mut self, mut data: &[u8]) {
        self.written += data.len() as u64;
        match self.codec.as_mut() {
            None => self.held.extend_from_slice(data),
            Some(codec) => {
                while !data.is_empty() {
                    let take = data.len().min(FEED);
                    codec
                        .feed(&data[..take], &mut self.held)
                        .expect("a codec takes a bounded feed");
                    while codec.busy() {
                        codec.drain(&mut self.held).expect("a codec drains");
                    }
                    data = &data[take..];
                }
            }
        }
        if self.held.len() >= WINDOW {
            self.send().await;
        }
    }

    async fn send(&mut self) {
        let data = std::mem::take(&mut self.held);
        if self.failure.is_some() || data.is_empty() {
            return;
        }
        match &self.path {
            None => {
                self.host.print(&data);
                self.host.pause().await;
            }
            Some(path) => {
                let (path, mode) = (path.clone(), WriteMode::Append);
                let (reply, _) = self.host.ask(Request::Write { path, mode, data }).await;
                if failed(&reply) {
                    self.failure = Some(reply);
                }
            }
        }
    }

    /// The archive's end: two zero blocks and the rest of the record, the
    /// compressor flushed, the file committed.
    async fn finish(&mut self) {
        let record = RECORD as u64;
        let end = 2 * BLOCK as u64;
        let end = end + (record - (self.written + end) % record) % record;
        self.put(&vec![0; end as usize]).await;
        if let Some(codec) = self.codec.as_mut() {
            codec.finish(&mut self.held).expect("a codec finishes");
            while codec.busy() {
                codec.drain(&mut self.held).expect("a codec drains");
            }
        }
        self.send().await;
        if let (Some(path), None) = (&self.path, &self.failure) {
            let path = Some(path.clone());
            let (reply, _) = self.host.ask(Request::Flush { path }).await;
            if failed(&reply) {
                self.failure = Some(reply);
            }
        }
    }
}

/// What went wrong with a member, as GNU says it, and the status it comes
/// to; `Left` when the member was left out of the archive.
enum Trouble {
    Left(Vec<u8>),
    Said(Vec<u8>, i32),
}

/// One file member: its header, then its data as it is read, held to the
/// size the walk saw (a read of unknown size spooled first to learn it).
async fn file(out: &mut Output<'_>, entry: &Entry, fd: u32) -> Option<Trouble> {
    let host = out.host;
    let shown = if entry.spelled.is_empty() {
        &entry.name
    } else {
        &entry.spelled
    };
    let cannot = |verb: &[u8], reply: &Reply| {
        [b"tar: ", &shown[..], b": Cannot ", verb, b": ", &failure_text(reply)].concat()
    };
    let open = (entry.path.clone().unwrap_or_default(), Opening::Operand(entry.operand));
    let (size, mut open, fd) = match entry.size {
        Some(size) => (size, Some(open), fd),
        None => {
            let (reply, _) = host.ask(Request::Fill { spool: SPOOL, open }).await;
            if failed(&reply) {
                return Some(Trouble::Left(cannot(b"open", &reply)));
            }
            let spool = (Vec::new(), Opening::Spool { fd: SPOOL, skip: 0 });
            (reply.size, Some(spool), SPOOL)
        }
    };
    // The first read opens the file, and a file that does not open is left
    // out whole.
    let mut next = match read(host, fd, open.take()).await {
        Ok(data) => data,
        Err(reply) => return Some(Trouble::Left(cannot(b"open", &reply))),
    };
    out.put(&header::encode(&entry.name, Kind::File, size, b"")).await;
    let mut seen = 0u64;
    let mut trouble = None;
    while let Some(data) = next {
        let keep = data.len().min((size - seen.min(size)) as usize);
        out.put(&data[..keep]).await;
        seen += data.len() as u64;
        next = match read(host, fd, None).await {
            Ok(data) => data,
            Err(reply) => {
                trouble = Some(Trouble::Said(cannot(b"read", &reply), FAILED));
                None
            }
        };
    }
    if entry.size.is_none() {
        host.ask(Request::Close { fd: SPOOL }).await;
    }
    if seen < size {
        let zeros = vec![0; ((size - seen) as usize).min(READ as usize)];
        let mut left = size - seen;
        while left > 0 {
            let take = left.min(zeros.len() as u64);
            out.put(&zeros[..take as usize]).await;
            left -= take;
        }
    }
    out.put(&vec![0; padding(size)]).await;
    if trouble.is_some() {
        return trouble;
    }
    let warning = if seen < size {
        format!("File shrank by {} bytes; padding with zeros", size - seen)
    } else if seen > size {
        "file changed as we read it".to_owned()
    } else {
        return None;
    };
    let line = [b"tar: ", &shown[..], b": ", warning.as_bytes()].concat();
    Some(Trouble::Said(line, 1))
}

pub(super) async fn run(host: &Host, config: &Config) -> i32 {
    let stdout = config.archive == b"-";
    let mut out = Output {
        host,
        path: (!stdout).then(|| config.output.clone()),
        codec: config.codec.map(|codec| codec.open("encode")),
        held: Vec::new(),
        written: 0,
        failure: None,
    };
    if let Some(path) = out.path.clone() {
        let (mode, data) = (WriteMode::Create, Vec::new());
        let reply = match &config.unopened {
            Some(text) => Reply {
                error: Some(text.iter().map(|&b| char::from(b)).collect()),
                ..Reply::default()
            },
            None => host.ask(Request::Write { path, mode, data }).await.0,
        };
        if failed(&reply) {
            host.warn(&open_failure(config, &reply, false));
            return FAILED;
        }
    }
    let (mut notices, mut status) = (config.notices.clone(), config.status);
    let mut names = Vec::new();
    for (index, entry) in config.members.iter().enumerate() {
        match entry.kind {
            Planned::Dir => out.put(&header::encode(&entry.name, Kind::Dir, 0, b"")).await,
            Planned::Link => {
                let head = header::encode(&entry.name, Kind::Link, 0, &entry.target);
                out.put(&head).await;
            }
            Planned::File => match file(&mut out, entry, 1000 + index as u32).await {
                Some(Trouble::Left(line)) => {
                    notices.push(line);
                    status = FAILED;
                    continue;
                }
                Some(Trouble::Said(line, code)) => {
                    notices.push(line);
                    status = status.max(code);
                }
                None => {}
            },
        }
        if out.failure.is_some() {
            break;
        }
        names.push(escaped(&entry.name));
    }
    out.finish().await;
    if let Some(reply) = &out.failure {
        host.warn(&open_failure(config, reply, false));
        return FAILED;
    }
    if status >= FAILED {
        notices.push(TRAILER.into());
    }
    if config.verbose && stdout {
        notices.extend(names.iter().cloned());
    } else if config.verbose {
        host.print(&lines(&names));
    }
    host.warn(&lines(&notices));
    status
}
