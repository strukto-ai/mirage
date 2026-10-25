//! zip as Info-ZIP Zip 3.0 runs it, as mirage models it: the host walks
//! the operands, and this names what it found, refuses a name two paths
//! share, deflates each member into a host spool and writes the archive
//! whole, an existing one's untouched records copied from its spool.

use std::collections::{BTreeMap, HashMap};

use flate2::{Compress, Compression, Crc, FlushCompress, Status};
use serde::Deserialize;

use super::{
    ARCHIVE, CENTRAL, END, END64, GATHER, LOCAL, LOCATOR64, Spool, WINDOW, ZIP32, central,
    end_record, failed, failure_text, say, u16_at, u32_at, wildcard,
};
use crate::request::{Opening, Reply, Request, WriteMode};
use crate::task::Host;

const INVALID: &str = "\nzip error: Zip file structure invalid ({})\n";
const CREATE: &str = "zip I/O error: {}\nzip error: Could not create output file ({})\n";
const REPEATED: &str = "\tzip warning:   first full name: {}
                      second full name: {}
                     name in zip file repeated: {}";
const INVALID_EXIT: i32 = 3;
const NOTHING_EXIT: i32 = 12;
const CREATE_EXIT: i32 = 15;
const REPEATED_EXIT: i32 = 16;
/// The spool new members' data goes to.
const ADDED: u32 = 2;
/// Unix modes in the high half of the external attributes, where a link
/// is told from a file.
const DIR_MODE: u64 = (0o40755 << 16) | 0x10;
const FILE_MODE: u64 = 0o100644 << 16;
const LINK_MODE: u64 = 0o120777 << 16;
/// The stamp every member carries: 1980-01-01 00:00, the DOS epoch.
const EPOCH: u64 = (1 << 5) | 1;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
enum Kind {
    #[default]
    File,
    Dir,
    Link,
}

/// One thing the host's walk found under an operand: its path as the
/// operand spelled it, where its bytes are read (a path and the host
/// operand it is), and a link's target, which is its content.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Found {
    #[serde(deserialize_with = "crate::latin1")]
    spelled: Vec<u8>,
    kind: Kind,
    #[serde(deserialize_with = "crate::latin1_opt")]
    path: Option<Vec<u8>>,
    operand: usize,
    #[serde(deserialize_with = "crate::latin1")]
    target: Vec<u8>,
}

/// The archive as typed and where it is written, what the walk found and
/// warned of (unprefixed), and the flags.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Config {
    #[serde(deserialize_with = "crate::latin1")]
    archive: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1")]
    output: Vec<u8>,
    found: Vec<Found>,
    #[serde(deserialize_with = "crate::latin1_list")]
    warnings: Vec<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1_list")]
    exclude: Vec<Vec<u8>>,
    junk: bool,
    quiet: bool,
}

/// Little-endian fields, each a value and its width in bytes.
fn fields(parts: &[(u64, usize)]) -> Vec<u8> {
    parts
        .iter()
        .flat_map(|&(value, width)| value.to_le_bytes().into_iter().take(width))
        .collect()
}

/// A path without its leading slashes and the run of `./` after them, so
/// `.//x` keeps `/x`.
fn relative(name: &[u8]) -> &[u8] {
    let mut name = &name[name.iter().position(|&b| b != b'/').unwrap_or(name.len())..];
    while let Some(rest) = name.strip_prefix(b"./") {
        name = rest;
    }
    name
}

/// The name Info-ZIP forms for a path: a directory carries the slash zip
/// appends before descending.
fn full_name(found: &Found) -> Vec<u8> {
    let mut full = found.spelled.clone();
    if found.kind == Kind::Dir && !full.ends_with(b"/") {
        full.push(b'/');
    }
    full
}

/// Name what the walk found: leading slashes and `./` go in silence, so
/// `.` names nothing; `-j` keeps what follows the last slash, which for a
/// directory is nothing; `-x` matches the stored name whole, wildcards
/// crossing slashes. One path named twice is stored once, and the first
/// name two paths share is worded as Info-ZIP's check_dup does.
fn plan(config: &Config) -> (Vec<(Vec<u8>, &Found)>, Vec<u8>) {
    let mut members = Vec::new();
    let mut formed: BTreeMap<Vec<u8>, Vec<Vec<u8>>> = BTreeMap::new();
    for found in &config.found {
        let full = full_name(found);
        let name = relative(&full);
        let start = name
            .iter()
            .rposition(|&b| b == b'/')
            .filter(|_| config.junk);
        let name = name[start.map_or(0, |at| at + 1)..].to_vec();
        let excluded = config
            .exclude
            .iter()
            .any(|p| wildcard(relative(p), &name, true));
        if name.is_empty() || excluded {
            continue;
        }
        let fulls = formed.entry(name.clone()).or_default();
        if !fulls.contains(&full) {
            fulls.push(full);
            if fulls.len() == 1 {
                members.push((name, found));
            }
        }
    }
    let mut repeated = Vec::new();
    if let Some((name, fulls)) = formed.iter().find(|(_, fulls)| fulls.len() > 1) {
        let mut fulls = fulls.clone();
        fulls.sort();
        repeated = say(REPEATED, &[&fulls[0], &fulls[1], name]);
        if config.junk {
            repeated.extend_from_slice(b"\n                     this may be a result of using -j");
        }
        repeated.push(b'\n');
    }
    (members, repeated)
}

/// A member's stored bytes in a spool: a new member's after its header,
/// an old one's whole record.
#[derive(Clone)]
struct Record {
    name: Vec<u8>,
    head: Vec<u8>,
    spool: u32,
    skip: u64,
    size: u64,
    central: Vec<u8>,
}

/// An existing archive's records, its leading bytes and its comment.
struct Original {
    records: Vec<Record>,
    prefix: u64,
    comment: Vec<u8>,
}

/// Whether an extra field is whole and holds no ZIP64 field.
fn plain_extra(extra: &[u8]) -> bool {
    let mut at = 0;
    while at < extra.len() {
        if at + 4 > extra.len() || u16_at(extra, at) == 1 {
            return false;
        }
        at += 4 + usize::from(u16_at(extra, at + 2));
    }
    at == extra.len()
}

/// An archive as Zip 3.0 reads one it updates: refused when split, ZIP64,
/// or any record disagrees with itself.
async fn original(spool: &mut Spool<'_>) -> Option<Original> {
    let base = spool.size.saturating_sub(super::END_SEARCH);
    let tail = spool.read(base, spool.size - base).await.ok()?;
    let mut end = end_record(&tail, base, true)?;
    let at = (end.at - base) as usize;
    let split = u16_at(&tail, at + 4) != 0 || u16_at(&tail, at + 6) != 0;
    let wide = end.count == 0xFFFF || end.size == ZIP32 || end.offset == ZIP32;
    if split || wide || u64::from(u16_at(&tail, at + 8)) != end.count {
        return None;
    }
    // Zip 3.0 takes a locator that points at no record for a split
    // archive's and asks for the missing part; mirage reads the ordinary
    // record, as UnZip does.
    spool.zip64(&mut end, &tail, base).await.ok()?;
    let start = end.at.checked_sub(end.size)?;
    let slack = i128::from(start) - i128::from(end.offset);
    if slack < 0 {
        return None;
    }
    let directory = spool.read(start, end.size).await.ok()?;
    let entries = central(&directory, end.count, slack)?;
    let mut offsets: Vec<u64> = entries.iter().map(|e| e.local).collect();
    offsets.sort_unstable();
    if offsets.windows(2).any(|pair| pair[0] == pair[1]) {
        return None;
    }
    let mut records = Vec::new();
    for entry in &entries {
        let record = &entry.record;
        let name_len = usize::from(u16_at(record, 28));
        let extra = &record[46 + name_len..46 + name_len + usize::from(u16_at(record, 30))];
        let wide = [20, 24, 42]
            .iter()
            .any(|&at| u64::from(u32_at(record, at)) == ZIP32);
        let limit = offsets[offsets.partition_point(|&o| o <= entry.local)..]
            .first()
            .copied()
            .unwrap_or(start);
        let flagged = entry.flags & 0x800 != 0;
        let unreadable = flagged && std::str::from_utf8(&entry.name).is_err();
        if u16_at(record, 34) != 0
            || wide
            || unreadable
            || !plain_extra(extra)
            || entry.local + 30 > limit
        {
            return None;
        }
        let head = spool.read(entry.local, 30).await.ok()?;
        let (local_name, local_extra) = (
            usize::from(u16_at(&head, 26)),
            usize::from(u16_at(&head, 28)),
        );
        let more = spool
            .read(entry.local + 30, (local_name + local_extra) as u64)
            .await
            .ok()?;
        let consistent = u32_at(&head, 0) == LOCAL
            && more.len() == local_name + local_extra
            && entry.local + 30 + more.len() as u64 + entry.csize <= limit
            && more[..local_name] == record[46..46 + name_len]
            && head[6..10] == record[8..12]
            && u64::from(u32_at(&head, 18)) != ZIP32
            && u64::from(u32_at(&head, 22)) != ZIP32
            && (entry.flags & 8 != 0 || head[14..26] == record[16..28])
            && plain_extra(&more[local_name..]);
        if !consistent {
            return None;
        }
        records.push(Record {
            // Matched as stored: two names read alike as text stay two.
            name: entry.stored().to_vec(),
            head: Vec::new(),
            spool: ARCHIVE,
            skip: entry.local,
            size: limit - entry.local,
            central: record.clone(),
        });
    }
    Some(Original {
        records,
        prefix: offsets.first().copied().unwrap_or(start),
        comment: end.comment,
    })
}

/// A new member's local header and central record, its offset left for
/// `placed`; sizes past ZIP32 go in a ZIP64 field.
fn encode(
    name: &[u8],
    method: u64,
    crc: u32,
    packed: u64,
    size: u64,
    mode: u64,
) -> (Vec<u8>, Vec<u8>) {
    let large = size.max(packed) >= ZIP32;
    let version = if large { 45 } else { 20 };
    let extra = if large {
        fields(&[(1, 2), (16, 2), (size, 8), (packed, 8)])
    } else {
        Vec::new()
    };
    let (packed, size) = if large {
        (ZIP32, ZIP32)
    } else {
        (packed, size)
    };
    let shared = fields(&[
        (0x800, 2),
        (method, 2),
        (0, 2),
        (EPOCH, 2),
        (u64::from(crc), 4),
        (packed, 4),
        (size, 4),
        (name.len() as u64, 2),
        (extra.len() as u64, 2),
    ]);
    let local = [
        fields(&[(u64::from(LOCAL), 4), (version, 2)]),
        shared.clone(),
        name.to_vec(),
        extra.clone(),
    ];
    let central = [
        fields(&[
            (u64::from(CENTRAL), 4),
            ((3 << 8) | version, 2),
            (version, 2),
        ]),
        shared,
        fields(&[(0, 6), (mode, 4), (0, 4)]),
        name.to_vec(),
        extra,
    ];
    (local.concat(), central.concat())
}

/// `central` pointing at its local record, through a ZIP64 field when the
/// offset is past ZIP32 (after the sizes one already holds).
fn placed(central: &[u8], offset: u64) -> Vec<u8> {
    let mut record = central.to_vec();
    record[42..46].copy_from_slice(&fields(&[(offset.min(ZIP32), 4)]));
    if offset < ZIP32 {
        return record;
    }
    record[6..8].copy_from_slice(&fields(&[(45, 2)]));
    let start = 46 + usize::from(u16_at(&record, 28));
    let extra_len = usize::from(u16_at(&record, 30));
    let extra = &record[start..start + extra_len];
    let merged = if extra.starts_with(&[1, 0]) {
        let size = usize::from(u16_at(extra, 2));
        let grown = fields(&[(1, 2), (size as u64 + 8, 2)]);
        [
            &grown,
            &extra[4..4 + size],
            &offset.to_le_bytes(),
            &extra[4 + size..],
        ]
        .concat()
    } else {
        [&fields(&[(1, 2), (8, 2), (offset, 8)]), extra].concat()
    };
    record[30..32].copy_from_slice(&fields(&[(merged.len() as u64, 2)]));
    [&record[..start], &merged, &record[start + extra_len..]].concat()
}

/// The end of an archive of `count` records whose directory, `size` bytes,
/// starts at `offset`: in ZIP64 form where it outgrows ZIP32.
fn ending(count: u64, size: u64, offset: u64, comment: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if count >= 0xFFFF || offset.max(size) >= ZIP32 {
        out = fields(&[
            (u64::from(END64), 4),
            (44, 8),
            (45, 2),
            (45, 2),
            (0, 8),
            (count, 8),
            (count, 8),
            (size, 8),
            (offset, 8),
            (u64::from(LOCATOR64), 4),
            (0, 4),
            (offset + size, 8),
            (1, 4),
        ]);
    }
    let short = count.min(0xFFFF);
    let (size, offset) = (size.min(ZIP32), offset.min(ZIP32));
    let len = comment.len() as u64;
    out.extend(fields(&[
        (u64::from(END), 4),
        (0, 4),
        (short, 2),
        (short, 2),
        (size, 4),
        (offset, 4),
        (len, 2),
    ]));
    out.extend_from_slice(comment);
    out
}

/// A member's bytes on their way to the added spool: deflated (a
/// directory stored), counted and checksummed, sent a window at a time.
struct Packer {
    crc: Crc,
    size: u64,
    deflater: Option<Compress>,
    held: Vec<u8>,
    sent: u64,
}

impl Packer {
    async fn send(&mut self, host: &Host) {
        self.sent += self.held.len() as u64;
        let data = std::mem::take(&mut self.held);
        host.ask(Request::Spool { fd: ADDED, data }).await;
    }

    async fn pack(&mut self, host: &Host, mut data: &[u8], end: bool) {
        let flush = if end {
            FlushCompress::Finish
        } else {
            FlushCompress::None
        };
        while let Some(deflater) = self.deflater.as_mut() {
            self.held.reserve(WINDOW - self.held.len());
            let before = deflater.total_in();
            let Ok(status) = deflater.compress_vec(data, &mut self.held, flush) else {
                return;
            };
            data = &data[(deflater.total_in() - before) as usize..];
            if self.held.len() >= WINDOW {
                self.send(host).await;
            }
            if (end && status == Status::StreamEnd) || (!end && data.is_empty()) {
                return;
            }
        }
        self.held.extend_from_slice(data);
    }
}

/// Deflate (or store) one member into the added spool from byte `skip`;
/// its record, or the host's failure to read it.
async fn add(
    host: &Host,
    name: &[u8],
    found: &Found,
    skip: u64,
    fd: u32,
) -> Result<Record, Vec<u8>> {
    let mut packer = Packer {
        crc: Crc::new(),
        size: 0,
        deflater: (found.kind != Kind::Dir).then(|| Compress::new(Compression::new(6), false)),
        held: Vec::new(),
        sent: 0,
    };
    let mut open = found
        .path
        .clone()
        .map(|path| (path, Opening::Operand(found.operand)));
    let mut next = (found.kind == Kind::Link).then(|| found.target.clone());
    loop {
        let data = match next.take() {
            Some(target) => target,
            None if found.kind != Kind::File => break,
            None => {
                let (open, least) = (open.take(), GATHER);
                let (reply, data) = host.ask(Request::Read { fd, open, least }).await;
                if failed(&reply) {
                    return Err(failure_text(&reply));
                }
                if reply.end {
                    break;
                }
                data
            }
        };
        packer.size += data.len() as u64;
        packer.crc.update(&data);
        packer.pack(host, &data, false).await;
    }
    packer.pack(host, b"", true).await;
    if !packer.held.is_empty() {
        packer.send(host).await;
    }
    let (method, mode) = match found.kind {
        Kind::Dir => (0, DIR_MODE),
        Kind::Link => (8, LINK_MODE),
        Kind::File => (8, FILE_MODE),
    };
    let (head, central) = encode(
        name,
        method,
        packer.crc.sum(),
        packer.sent,
        packer.size,
        mode,
    );
    let (spool, size) = (ADDED, packer.sent);
    let name = name.to_vec();
    Ok(Record {
        name,
        head,
        spool,
        skip,
        size,
        central,
    })
}

/// What the archive is written from: bytes this run made, and windows of
/// the spools, a window that carries on where the one before stops joined
/// to it, so untouched records go as one write.
enum Piece {
    Made(Vec<u8>),
    Kept(u32, u64, u64),
}

fn keep(pieces: &mut Vec<Piece>, fd: u32, skip: u64, size: u64) {
    if let Some(Piece::Kept(last, from, held)) = pieces.last_mut() {
        if *last == fd && *from + *held == skip {
            *held += size;
            return;
        }
    }
    if size > 0 {
        pieces.push(Piece::Kept(fd, skip, size));
    }
}

pub(super) async fn run(host: Host, config: Config) -> i32 {
    let warnings: Vec<u8> = if config.quiet {
        Vec::new()
    } else {
        config
            .warnings
            .iter()
            .flat_map(|w| say("\tzip warning: {}\n", &[w]))
            .collect()
    };
    let archive = config.archive.as_slice();
    let fail = |text: &[u8], warned: bool, status: i32| {
        host.warn(&[if warned { &warnings[..] } else { b"" }, text].concat());
        status
    };
    let create_error = |reply: &Reply, warned| {
        fail(
            &say(CREATE, &[&failure_text(reply), archive]),
            warned,
            CREATE_EXIT,
        )
    };
    let open = (config.archive.clone(), Opening::Operand(1));
    let (reply, _) = host
        .ask(Request::Fill {
            spool: ARCHIVE,
            open,
        })
        .await;
    let old = if !failed(&reply) {
        match original(&mut Spool::new(&host, ARCHIVE, reply.size)).await {
            Some(old) => Some(old),
            None => return fail(&say(INVALID, &[archive]), false, INVALID_EXIT),
        }
    } else if reply.names(&["ENOENT"]) {
        None
    } else if reply.names(&["EISDIR"]) {
        return fail(&say(INVALID, &[archive]), false, INVALID_EXIT);
    } else {
        // Only absence means create; a refused or broken read must not
        // overwrite.
        return create_error(&reply, false);
    };
    let (mut members, repeated) = plan(&config);
    if !repeated.is_empty() {
        let repeated = if config.quiet { Vec::new() } else { repeated };
        let error = "\nzip error: Invalid command arguments (cannot repeat names in zip file)\n";
        return fail(
            &[repeated, error.as_bytes().to_vec()].concat(),
            true,
            REPEATED_EXIT,
        );
    }
    if members.is_empty() {
        // Nothing matched: no archive, and an error -q does not silence.
        return fail(
            &say("\nzip error: Nothing to do! ({})\n", &[archive]),
            true,
            NOTHING_EXIT,
        );
    }
    // A member replacing an old one keeps its place; new ones follow.
    let old_records = old.as_ref().map_or(&[][..], |old| &old.records[..]);
    let order: HashMap<Vec<u8>, usize> = old_records
        .iter()
        .enumerate()
        .map(|(i, r)| (r.name.clone(), i))
        .collect();
    members.sort_by_key(|(name, _)| order.get(name.as_slice()).copied().unwrap_or(order.len()));
    let mut added = Vec::new();
    let mut lines = Vec::new();
    let mut skip = 0;
    for (index, (name, found)) in members.iter().enumerate() {
        if name.len() > 0xFFFF {
            return fail(&say(INVALID, &[archive]), false, INVALID_EXIT);
        }
        let record = match add(&host, name, found, skip, 2000 + index as u32).await {
            Ok(record) => record,
            // A member the session may not read aborts the run and writes no
            // archive; Info-ZIP writes the rest and exits 18.
            Err(text) => {
                let path = found.path.clone().unwrap_or_default();
                return fail(&say("zip: {}: {}\n", &[&path, &text]), false, 1);
            }
        };
        skip += record.size;
        let verb: &[u8] = if order.contains_key(name.as_slice()) {
            b"updating"
        } else {
            b"  adding"
        };
        lines.extend(say("{}: {}\n", &[verb, name]));
        added.push(record);
    }
    let (prefix, comment, old_records) = match old {
        Some(old) => (old.prefix, old.comment, old.records),
        None => (0, Vec::new(), Vec::new()),
    };
    // A new member takes the place of every old record of its name, as
    // an archive appended to can repeat one.
    let fresh: HashMap<&[u8], &Record> = added.iter().map(|r| (r.name.as_slice(), r)).collect();
    let mut records: Vec<Record> = old_records
        .into_iter()
        .map(|old| fresh.get(old.name.as_slice()).map_or(old, |&r| r.clone()))
        .collect();
    records.extend(
        added
            .iter()
            .filter(|r| !order.contains_key(r.name.as_slice()))
            .cloned(),
    );
    let mut pieces = Vec::new();
    keep(&mut pieces, ARCHIVE, 0, prefix);
    let mut offset = prefix;
    let mut directory = Vec::new();
    for record in &records {
        directory.extend(placed(&record.central, offset));
        offset += record.head.len() as u64 + record.size;
        if !record.head.is_empty() {
            pieces.push(Piece::Made(record.head.clone()));
        }
        keep(&mut pieces, record.spool, record.skip, record.size);
    }
    let size = directory.len() as u64;
    directory.extend(ending(records.len() as u64, size, offset, &comment));
    pieces.push(Piece::Made(directory));
    let path = config.output.clone();
    let mut writes = vec![Request::Write {
        path: path.clone(),
        mode: WriteMode::Create,
        data: Vec::new(),
    }];
    writes.extend(pieces.into_iter().map(|piece| {
        let (mode, data) = match piece {
            Piece::Made(data) => (WriteMode::Append, data),
            Piece::Kept(fd, skip, size) => (WriteMode::Slice { fd, skip, size }, Vec::new()),
        };
        Request::Write {
            path: path.clone(),
            mode,
            data,
        }
    }));
    writes.push(Request::Flush { path: Some(path) });
    for request in writes {
        let (reply, _) = host.ask(request).await;
        if failed(&reply) {
            return create_error(&reply, true);
        }
    }
    if !config.quiet {
        host.print(&lines);
        host.warn(&warnings);
    }
    0
}
