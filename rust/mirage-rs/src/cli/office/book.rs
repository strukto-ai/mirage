//! A workbook as its package: read from the host's spool a part at a time,
//! and written back with every part no command changed copied from the
//! spool as it stands, so only the changed parts are rewritten.

use std::collections::{HashMap, HashSet};

use flate2::{Compress, Compression, Crc, FlushCompress};

use super::xml::{Kind, tags};
use crate::request::{Opening, Reply, Request, failed};
use crate::task::Host;
use crate::zip::{
    ARCHIVE, Decoder, Directory, Entry, Piece, Spool, ending, fields, keep, placed, write_out,
};

/// Why a workbook could not be opened.
pub(super) enum Refusal {
    /// Nothing stands at the name.
    Missing,
    /// The name holds no package mirage reads.
    Unreadable,
    /// The host failed in these words.
    Host(Vec<u8>),
}

pub(super) struct Book<'h> {
    spool: Spool<'h>,
    entries: Vec<Entry>,
    comment: Vec<u8>,
    changed: HashMap<String, Vec<u8>>,
    dropped: HashSet<String>,
    /// Where the central directory starts, so the last member's bytes are
    /// known.
    directory_at: u64,
}

/// A book's changes at one point.
pub(super) struct Mark {
    changed: HashMap<String, Vec<u8>>,
    dropped: HashSet<String>,
}

fn key(name: &str) -> String {
    name.trim_start_matches('/').to_ascii_lowercase()
}

impl<'h> Book<'h> {
    /// The package the command's operand names, as typed, spooled whole
    /// by the host.
    pub(super) async fn open(host: &'h Host, typed: &[u8]) -> Result<Book<'h>, Refusal> {
        let open = (typed.to_vec(), Opening::Operand(1));
        let (reply, _) = host
            .ask(Request::Fill {
                spool: ARCHIVE,
                open,
            })
            .await;
        if failed(&reply) {
            if reply.names(&["ENOENT", "ENOTDIR"]) {
                return Err(Refusal::Missing);
            }
            return Err(Refusal::Host(crate::request::failure_text(&reply)));
        }
        let mut spool = Spool::new(host, ARCHIVE, reply.size);
        let Directory {
            entries,
            comment,
            slack,
            ..
        } = spool
            .directory(true)
            .await
            .map_err(|_| Refusal::Unreadable)?;
        if slack != 0 || entries.iter().any(|e| e.method != 0 && e.method != 8) {
            return Err(Refusal::Unreadable);
        }
        let mut book = Book {
            spool,
            entries,
            comment,
            changed: HashMap::new(),
            dropped: HashSet::new(),
            directory_at: 0,
        };
        book.directory_at = book
            .directory_start()
            .await
            .map_err(|_| Refusal::Unreadable)?;
        Ok(book)
    }

    /// Where the members' bytes end: past the last one's data and the
    /// descriptor a streaming writer puts after it.
    async fn directory_start(&mut self) -> Result<u64, Vec<u8>> {
        let mut last = 0;
        for entry in self.entries.clone() {
            let start = self.spool.data_start(&entry).await?.ok_or_else(Vec::new)?;
            let mut end = start + entry.csize;
            if entry.flags & 0x8 != 0 {
                let sig = self.spool.read(end, 4).await?;
                end += if sig == [0x50, 0x4b, 0x07, 0x08] {
                    16
                } else {
                    12
                };
            }
            last = last.max(end);
        }
        Ok(last)
    }

    fn entry(&self, name: &str) -> Option<&Entry> {
        let want = key(name);
        self.entries
            .iter()
            .find(|e| key(&String::from_utf8_lossy(&e.name)) == want)
    }

    /// A part's bytes, as last changed or as the package holds them.
    pub(super) async fn part(&mut self, name: &str) -> Option<Vec<u8>> {
        if self.dropped.contains(&key(name)) {
            return None;
        }
        if let Some(data) = self.changed.get(&key(name)) {
            return Some(data.clone());
        }
        let entry = self.entry(name)?.clone();
        let start = self.spool.data_start(&entry).await.ok()??;
        let packed = self.spool.read(start, entry.csize).await.ok()?;
        let mut decoder = Decoder::new(&entry)?;
        let mut out = Vec::with_capacity(entry.size as usize);
        let mut window = Vec::new();
        let mut at = 0;
        while at < packed.len() || decoder.pending() {
            let used = decoder.step(&packed[at..], &mut window);
            out.extend_from_slice(&window);
            if used == 0 && window.is_empty() {
                break;
            }
            at += used;
        }
        Some(out)
    }

    pub(super) fn put(&mut self, name: &str, data: Vec<u8>) {
        self.changed.insert(key(name), data);
    }

    /// Every member's name, as the archive stores them.
    pub(super) fn names(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|e| !e.is_dir())
            .map(|e| String::from_utf8_lossy(&e.name).into_owned())
            .filter(|n| !self.dropped.contains(&key(n)))
            .collect()
    }

    /// A member's uncompressed size, as last changed or as the package holds it.
    pub(super) fn size(&self, name: &str) -> Option<u64> {
        if self.dropped.contains(&key(name)) {
            return None;
        }
        if let Some(data) = self.changed.get(&key(name)) {
            return Some(data.len() as u64);
        }
        self.entry(name).map(|e| e.size)
    }

    pub(super) fn drop_part(&mut self, name: &str) {
        self.dropped.insert(key(name));
    }

    pub(super) fn changed(&self) -> bool {
        !self.changed.is_empty() || !self.dropped.is_empty()
    }

    /// The changes so far, to go back to when what follows fails.
    pub(super) fn mark(&self) -> Mark {
        Mark {
            changed: self.changed.clone(),
            dropped: self.dropped.clone(),
        }
    }

    pub(super) fn restore(&mut self, mark: Mark) {
        self.changed = mark.changed;
        self.dropped = mark.dropped;
    }

    /// The package written whole to `path`: each unchanged member as the
    /// spool holds it, each changed one deflated anew, then a directory
    /// that points at where each now stands.
    pub(super) async fn save(mut self, host: &Host, path: &[u8]) -> Option<Reply> {
        let mut order: Vec<Entry> = self.entries.clone();
        order.sort_by_key(|e| e.local);
        let bounds: Vec<u64> = order
            .iter()
            .skip(1)
            .map(|e| e.local)
            .chain([self.directory_at])
            .collect();
        let mut pieces = Vec::new();
        let mut central = Vec::new();
        let mut offset = 0u64;
        let mut count = 0u64;
        for (entry, bound) in order.iter().zip(bounds) {
            let name = String::from_utf8_lossy(&entry.name).into_owned();
            if self.dropped.contains(&key(&name)) {
                continue;
            }
            count += 1;
            match self.changed.remove(&key(&name)) {
                Some(data) => {
                    let (local, record) = member(entry.stored(), &data, Some(&entry.record));
                    central.extend(placed(&record, offset));
                    offset += local.len() as u64;
                    pieces.push(Piece::Made(local));
                }
                None => {
                    central.extend(placed(&entry.record, offset));
                    keep(&mut pieces, self.spool.fd, entry.local, bound - entry.local);
                    offset += bound - entry.local;
                }
            }
        }
        let size = central.len() as u64;
        let end = ending(count, size, offset, &self.comment);
        pieces.push(Piece::Made([central, end].concat()));
        write_out(host, path, pieces).await
    }
}

/// A member's local record with its data, deflated, and its central
/// record, its offset left for `placed`; a changed member keeps the
/// central record it had but for what its new data changes.
pub(super) fn member(stored: &[u8], data: &[u8], was: Option<&[u8]>) -> (Vec<u8>, Vec<u8>) {
    let mut crc = Crc::new();
    crc.update(data);
    let mut deflater = Compress::new(Compression::default(), false);
    let mut packed = Vec::with_capacity(data.len() / 2 + 64);
    loop {
        if packed.capacity() - packed.len() < 1024 {
            packed.reserve(data.len().max(4096));
        }
        let consumed = deflater.total_in() as usize;
        let status = deflater.compress_vec(&data[consumed..], &mut packed, FlushCompress::Finish);
        if matches!(status, Ok(flate2::Status::StreamEnd)) || status.is_err() {
            break;
        }
    }
    let (time, date) = match was {
        Some(record) => (
            u64::from(u16::from_le_bytes([record[12], record[13]])),
            u64::from(u16::from_le_bytes([record[14], record[15]])),
        ),
        None => (0, 0x21),
    };
    let flags = was.map_or(0x800, |r| {
        u64::from(u16::from_le_bytes([r[8], r[9]]) & !0x8)
    });
    let shared = fields(&[
        (flags, 2),
        (8, 2),
        (time, 2),
        (date, 2),
        (u64::from(crc.sum()), 4),
        (packed.len() as u64, 4),
        (data.len() as u64, 4),
        (stored.len() as u64, 2),
    ]);
    let local = [
        fields(&[(0x0403_4b50, 4), (20, 2)]),
        shared.clone(),
        fields(&[(0, 2)]),
        stored.to_vec(),
        packed,
    ]
    .concat();
    let record = match was {
        Some(record) => {
            let mut r = record.to_vec();
            r[8..10].copy_from_slice(&fields(&[(flags, 2)]));
            r[10..12].copy_from_slice(&fields(&[(8, 2)]));
            r[16..28].copy_from_slice(&shared[8..20]);
            r
        }
        None => [
            fields(&[(0x0201_4b50, 4), (20, 2), (20, 2)]),
            shared,
            fields(&[(0, 2), (0, 2), (0, 2), (0, 2), (0, 4), (0, 4)]),
            stored.to_vec(),
        ]
        .concat(),
    };
    (local, record)
}

/// A package of `parts`, each deflated, written as one archive.
pub(super) fn package(parts: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    let mut central = Vec::new();
    for (name, data) in parts {
        let (local, record) = member(name.as_bytes(), data, None);
        central.extend(placed(&record, body.len() as u64));
        body.extend(local);
    }
    let size = central.len() as u64;
    let offset = body.len() as u64;
    [body, central, ending(parts.len() as u64, size, offset, b"")].concat()
}

/// A relationships part's targets by id, each resolved against `base`,
/// the part the relationships belong to.
pub(super) fn relationships(data: &[u8], base: &str) -> Vec<(String, String, String)> {
    tags(data)
        .filter(|t| t.kind != Kind::End && t.is("Relationship"))
        .map(|t| {
            let target = t.attr("Target").unwrap_or_default();
            (
                t.attr("Id").unwrap_or_default(),
                t.attr("Type").unwrap_or_default(),
                resolve(base, &target),
            )
        })
        .collect()
}

/// `target` as a part name: absolute when it starts with `/`, else beside
/// `base`.
pub(super) fn resolve(base: &str, target: &str) -> String {
    let joined = match target.strip_prefix('/') {
        Some(absolute) => absolute.to_string(),
        None => match base.rfind('/') {
            Some(at) => format!("{}/{target}", &base[..at]),
            None => target.to_string(),
        },
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Where a part's relationships live.
pub(super) fn rels_of(part: &str) -> String {
    match part.rfind('/') {
        Some(at) => format!("{}/_rels/{}.rels", &part[..at], &part[at + 1..]),
        None => format!("_rels/{part}.rels"),
    }
}
