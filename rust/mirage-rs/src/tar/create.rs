//! `-c`: the members the host's walk planned, each header then its data read
//! through the host, written to the archive or standard output as they
//! come, through the compressor when one is named, ending in two zero
//! blocks and the rest of the record.

use std::collections::HashMap;

use super::header::{self, BLOCK, Kind, RECORD, Stamp, padding};
use super::read::{FEED, trimmed};
use super::transform::Scope;
use super::{
    Config, Entry, FAILED, Planned, READ, TRAILER, WINDOW, escaped, lines, open_failure, read,
};
use crate::Stream;
use crate::request::{Opening, Reply, Request, WriteMode, failed, failure_text};
use crate::task::Host;

/// The spool a member of unknown size is read into first.
const SPOOL: u32 = 2;

/// The archive on its way out: through the compressor, gathered to a window,
/// then to the host's file or the output.
pub(super) struct Output<'h> {
    host: &'h Host,
    path: Option<Vec<u8>>,
    codec: Option<Box<dyn Stream>>,
    held: Vec<u8>,
    /// The tar bytes written, which the record pads.
    written: u64,
    pub(super) failure: Option<Reply>,
}

impl<'h> Output<'h> {
    pub(super) fn new(
        host: &'h Host,
        path: Option<Vec<u8>>,
        codec: Option<Box<dyn Stream>>,
    ) -> Output<'h> {
        Output {
            host,
            path,
            codec,
            held: Vec::new(),
            written: 0,
            failure: None,
        }
    }

    /// Pad the record from here on, what came before it left as it was.
    pub(super) fn reset_record(&mut self) {
        self.written = 0;
    }

    pub(super) async fn put(&mut self, mut data: &[u8]) {
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
    pub(super) async fn finish(&mut self) {
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
async fn file(
    out: &mut Output<'_>,
    entry: &Entry,
    fd: u32,
    name: &[u8],
    stamp: &Stamp,
) -> Option<Trouble> {
    let host = out.host;
    let shown = if entry.spelled.is_empty() {
        &entry.name
    } else {
        &entry.spelled
    };
    let cannot = |verb: &[u8], reply: &Reply| {
        [
            b"tar: ",
            &shown[..],
            b": Cannot ",
            verb,
            b": ",
            &failure_text(reply),
        ]
        .concat()
    };
    let open = (
        entry.path.clone().unwrap_or_default(),
        Opening::Operand(entry.operand),
    );
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
    let (mut data, mut end) = match read(host, fd, open.take()).await {
        Ok(read) => read,
        Err(reply) => return Some(Trouble::Left(cannot(b"open", &reply))),
    };
    out.put(&header::encode(name, Kind::File, size, b"", stamp))
        .await;
    let mut seen = 0u64;
    let mut trouble = None;
    loop {
        let keep = (size - seen.min(size)).min(data.len() as u64) as usize;
        out.put(&data[..keep]).await;
        seen += data.len() as u64;
        if end {
            break;
        }
        (data, end) = match read(host, fd, None).await {
            Ok(read) => read,
            Err(reply) => {
                trouble = Some(Trouble::Said(cannot(b"read", &reply), FAILED));
                break;
            }
        };
    }
    if entry.size.is_none() {
        host.ask(Request::Close { fd: SPOOL }).await;
    }
    if seen < size {
        let zeros = vec![0; (size - seen).min(READ) as usize];
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

/// What a header records for `entry`, the options laid over what the walk
/// read.
fn stamp(config: &Config, entry: &Entry) -> Stamp {
    let id = |who: &Option<super::Owner>| who.as_ref().map_or(0, |who| who.id);
    let name = |who: &Option<super::Owner>| match who {
        Some(who) if !config.numeric => who.name.clone(),
        _ => Vec::new(),
    };
    Stamp {
        mode: entry.mode,
        mtime: config.mtime.or(entry.mtime).unwrap_or(0),
        uid: id(&config.owner),
        gid: id(&config.group),
        uname: name(&config.owner),
        gname: name(&config.group),
    }
}

/// What writing the planned members came to.
pub(super) struct Written {
    pub(super) names: Vec<Vec<u8>>,
    pub(super) notices: Vec<Vec<u8>>,
    pub(super) status: i32,
}

/// Every planned member, a header then its data; with `latest`, `-u`'s
/// record of what the archive holds, only those newer than their copy.
pub(super) async fn members(
    out: &mut Output<'_>,
    config: &Config,
    latest: Option<&HashMap<Vec<u8>, i64>>,
) -> Written {
    let (mut notices, mut status) = (config.notices.clone(), config.status);
    let mut names = Vec::new();
    for (index, entry) in config.members.iter().enumerate() {
        let stored = config.transformed(&entry.name, Scope::Regular);
        let current = latest.and_then(|latest| latest.get(trimmed(&stored)));
        if current.is_some_and(|&held| held >= entry.mtime.unwrap_or(0)) {
            continue;
        }
        let stamp = stamp(config, entry);
        match entry.kind {
            Planned::Dir => {
                out.put(&header::encode(&stored, Kind::Dir, 0, b"", &stamp))
                    .await
            }
            Planned::Link => {
                let target = config.transformed(&entry.target, Scope::Symlink);
                let head = header::encode(&stored, Kind::Link, 0, &target, &stamp);
                out.put(&head).await;
            }
            Planned::File => {
                let fd = 1000 + index as u32;
                match file(out, entry, fd, &stored, &stamp).await {
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
                }
            }
        }
        if out.failure.is_some() {
            break;
        }
        names.push(escaped(&entry.name));
    }
    Written {
        names,
        notices,
        status,
    }
}

/// The run's end, once the archive is written: its failure if it could not
/// be, the names `-v` lists and what the walk and the members said.
pub(super) fn report(
    host: &Host,
    config: &Config,
    out: &Output<'_>,
    written: Written,
    stdout: bool,
) -> i32 {
    if let Some(reply) = &out.failure {
        host.warn(&open_failure(config, reply, false));
        return FAILED;
    }
    let Written {
        names,
        mut notices,
        status,
    } = written;
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

pub(super) async fn run(host: &Host, config: &Config) -> i32 {
    let stdout = config.archive == b"-";
    let mut out = Output::new(
        host,
        (!stdout).then(|| config.output.clone()),
        config.codec.map(|codec| codec.open("encode")),
    );
    if let Some(path) = out.path.clone() {
        let (mode, data) = (WriteMode::Create, Vec::new());
        let reply = match &config.unopened {
            Some(text) => Reply {
                error: Some(crate::byte_text(text)),
                ..Reply::default()
            },
            None => host.ask(Request::Write { path, mode, data }).await.0,
        };
        if failed(&reply) {
            host.warn(&open_failure(config, &reply, false));
            return FAILED;
        }
    }
    if let Some(program) = &config.unavailable {
        let flush = out.path.clone();
        host.ask(Request::Flush { path: flush }).await;
        host.warn(
            format!(
                "/bin/sh: 1: {program}: not found\ntar: Child returned status 127\n{}\n",
                super::FATAL
            )
            .as_bytes(),
        );
        return FAILED;
    }
    if config.abandon {
        let flush = out.path.clone();
        host.ask(Request::Flush { path: flush }).await;
        host.warn(&lines(&config.notices));
        return config.status;
    }
    let written = members(&mut out, config, None).await;
    out.finish().await;
    report(host, config, &out, written, stdout)
}
