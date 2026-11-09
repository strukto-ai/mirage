//! zip as Info-ZIP Zip 3.0 runs it, as mirage models it: the host walks
//! the operands, and this names what it found, refuses a name two paths
//! share, deflates each member into a host spool and writes the archive
//! whole, an existing one's untouched records copied from its spool.

use std::collections::{BTreeMap, HashMap};

use flate2::{Compress, Compression, Crc, FlushCompress, Status};
use serde::Deserialize;

use super::{
    ARCHIVE, CENTRAL, END, END64, GATHER, LOCAL, LOCATOR64, Spool, WINDOW, ZIP32, central,
    end_record, say, u16_at, u32_at, unzip, wildcard,
};
use crate::request::{Opening, Reply, Request, WriteMode, failed, failure_text};
use crate::task::Host;

const INVALID: &str = "\nzip error: Zip file structure invalid ({})\n";
const CREATE: &str = "zip I/O error: {}\nzip error: Could not create output file ({})\n";
const REPEATED: &str = "\tzip warning:   first full name: {}
                      second full name: {}
                     name in zip file repeated: {}";
const INVALID_EXIT: i32 = 3;
const NOTHING_EXIT: i32 = 12;
const CREATE_EXIT: i32 = 15;
const TEMP_EXIT: i32 = 10;
const TEST_EXIT: i32 = 8;
const TEST_FAILED: &str = "\nzip error: Zip file invalid, could not spawn unzip, or wrong unzip (original files unmodified)\n";
/// The most a comment's two-byte length can say.
const MAX_COMMENT: usize = 0xFFFF;
const REPEATED_EXIT: i32 = 16;
/// The spool new members' data goes to.
const ADDED: u32 = 2;
/// Unix modes in the high half of the external attributes, where a link
/// is told from a file.
const DIR_MODE: u64 = (0o40755 << 16) | 0x10;
const FILE_MODE: u64 = 0o100644 << 16;
const LINK_MODE: u64 = 0o120777 << 16;
/// The stamp a member with no time carries: 1980-01-01 00:00, the DOS epoch.
const EPOCH: u64 = (1 << 5) | 1;
/// The stamp a file with this time records, in the DOS date's high half.
fn dos_stamp(time: Option<i64>) -> u64 {
    let Some(time) = time.filter(|time| *time >= DOS_EPOCH) else {
        return EPOCH << 16;
    };
    let (year, month, day, hour, minute, second) = crate::calendar::fields(i128::from(time));
    let date = ((year as u64 - 1980) << 9) | ((month as u64) << 5) | day as u64;
    let clock = ((hour as u64) << 11) | ((minute as u64) << 5) | (second as u64 / 2);
    (date << 16) | clock
}
/// 1980-01-01 00:00 UTC.
const DOS_EPOCH: i64 = 315_532_800;

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
    /// Its modification time, when the walk read one.
    mtime: Option<i64>,
    /// The path it was found at, which `-m` removes; a link's own, not
    /// its target's.
    #[serde(deserialize_with = "crate::latin1_opt")]
    source: Option<Vec<u8>>,
}

/// What `-l` and `-ll` do to a text file's line ends.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
enum LineEnds {
    #[default]
    Keep,
    ToCrlf,
    ToLf,
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
    #[serde(deserialize_with = "crate::latin1_list")]
    include: Vec<Vec<u8>>,
    junk: bool,
    quiet: bool,
    /// -u: only what is new or newer. -f: only what the archive holds and
    /// is newer.
    update: bool,
    freshen: bool,
    /// `-u` or `-f` with no file named: what the archive holds is refreshed.
    refresh_all: bool,
    /// -d: the operands are patterns of members to remove.
    delete: bool,
    #[serde(deserialize_with = "crate::latin1_list")]
    patterns: Vec<Vec<u8>>,
    /// -m: what went in is removed once the archive is written.
    move_files: bool,
    /// -0 to -9.
    level: Option<u32>,
    /// -T: the archive is tested once written.
    test: bool,
    verbose: bool,
    line_ends: LineEnds,
    /// -D: no entries for directories.
    no_directories: bool,
    /// -b's directory, which must be there.
    #[serde(deserialize_with = "crate::latin1_opt")]
    temp: Option<Vec<u8>>,
    /// -c and -z: each is prompted for, its text from `stdin_lines`.
    comment_members: bool,
    comment_archive: bool,
    #[serde(deserialize_with = "crate::latin1_list")]
    stdin_lines: Vec<Vec<u8>>,
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
fn plan<'a>(config: &'a Config, stored: &'a [Found]) -> (Vec<(Vec<u8>, &'a Found)>, Vec<u8>) {
    let mut members = Vec::new();
    let mut formed: BTreeMap<Vec<u8>, Vec<Vec<u8>>> = BTreeMap::new();
    for found in config.found.iter().chain(stored) {
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
        let included = config.include.is_empty()
            || config
                .include
                .iter()
                .any(|p| wildcard(relative(p), &name, true));
        if name.is_empty()
            || excluded
            || !included
            || (config.no_directories && found.kind == Kind::Dir)
        {
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

/// What a new member's two headers record besides its name.
struct Facts<'a> {
    method: u64,
    crc: u32,
    packed: u64,
    size: u64,
    mode: u64,
    stamp: u64,
    comment: &'a [u8],
    level: u32,
    text: bool,
}

/// A new member's local header and central record, its offset left for
/// `placed`; sizes past ZIP32 go in a ZIP64 field.
fn encode(name: &[u8], member: &Facts<'_>) -> (Vec<u8>, Vec<u8>) {
    let Facts {
        method,
        crc,
        packed,
        size,
        mode,
        stamp,
        comment,
        level,
        text,
    } = *member;
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
    // Bits 1 and 2 of the flags say how hard a deflate tried.
    let effort = match level {
        8 | 9 if method == 8 => 2,
        1 | 2 if method == 8 => 4,
        _ => 0,
    };
    let shared = fields(&[
        (0x800 | effort, 2),
        (method, 2),
        (stamp & 0xFFFF, 2),
        (stamp >> 16, 2),
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
        fields(&[
            (comment.len() as u64, 2),
            (0, 2),
            (u64::from(text), 2),
            (mode, 4),
            (0, 4),
        ]),
        name.to_vec(),
        extra,
        comment.to_vec(),
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
    /// Bytes held back for line-end translation, none past a text check.
    ends: Option<EndsState>,
    /// Whether the first bytes read like text, which the record says.
    text: bool,
}

/// A file on its way through `-l` or `-ll`: judged text from its first
/// block, and the carriage return a window ended on.
struct EndsState {
    want: LineEnds,
    judged: bool,
    text: bool,
    pending_cr: bool,
}

impl EndsState {
    fn translate(&mut self, data: &[u8], end: bool) -> Vec<u8> {
        if !self.judged {
            self.judged = true;
            self.text = !data.contains(&0);
        }
        if !self.text {
            return data.to_vec();
        }
        let mut out = Vec::with_capacity(data.len() + data.len() / 8);
        for &byte in data {
            match self.want {
                LineEnds::ToCrlf => {
                    if byte == b'\n' && !self.pending_cr {
                        out.push(b'\r');
                    }
                    self.pending_cr = byte == b'\r';
                    out.push(byte);
                }
                LineEnds::ToLf => {
                    if std::mem::take(&mut self.pending_cr) && byte != b'\n' {
                        out.push(b'\r');
                    }
                    if byte == b'\r' {
                        self.pending_cr = true;
                    } else {
                        out.push(byte);
                    }
                }
                LineEnds::Keep => out.push(byte),
            }
        }
        if end && self.want == LineEnds::ToLf && std::mem::take(&mut self.pending_cr) {
            out.push(b'\r');
        }
        out
    }
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
        if self.held.len() >= WINDOW {
            self.send(host).await;
        }
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
    config: &Config,
    comment: &[u8],
) -> Result<Record, Vec<u8>> {
    let level = config.level.unwrap_or(6);
    let stored = found.kind == Kind::Dir || level == 0;
    let mut packer = Packer {
        crc: Crc::new(),
        size: 0,
        deflater: (!stored).then(|| Compress::new(Compression::new(level), false)),
        held: Vec::new(),
        sent: 0,
        ends: (config.line_ends != LineEnds::Keep && found.kind == Kind::File).then_some(
            EndsState {
                want: config.line_ends,
                judged: false,
                text: false,
                pending_cr: false,
            },
        ),
        text: found.kind == Kind::File,
    };
    // A short member is kept whole too, for when deflating it saves nothing.
    let mut whole = Vec::new();
    let mut open = found.path.clone().map(|path| match found.operand {
        0 => (path, Opening::Name),
        operand => (path, Opening::Operand(operand)),
    });
    let mut next = (found.kind == Kind::Link).then(|| found.target.clone());
    let mut ended = false;
    loop {
        let data = match next.take() {
            Some(target) => target,
            None if found.kind != Kind::File || ended => break,
            None => {
                let (open, least) = (open.take(), GATHER);
                let (reply, data) = host.ask(Request::Read { fd, open, least }).await;
                if failed(&reply) {
                    return Err(failure_text(&reply));
                }
                ended = reply.end;
                data
            }
        };
        if data.contains(&0) {
            packer.text = false;
        }
        let translated = match packer.ends.as_mut() {
            Some(ends) => ends.translate(&data, ended || next.is_some()),
            None => data,
        };
        if !stored && packer.size + translated.len() as u64 <= WINDOW as u64 {
            whole.extend_from_slice(&translated);
        }
        packer.size += translated.len() as u64;
        packer.crc.update(&translated);
        packer.pack(host, &translated, false).await;
    }
    packer.pack(host, b"", true).await;
    let plain = !stored
        && packer.sent == 0
        && packer.size <= WINDOW as u64
        && packer.held.len() as u64 >= packer.size;
    if plain {
        packer.held = whole;
    }
    if !packer.held.is_empty() {
        packer.send(host).await;
    }
    let (method, mode) = match found.kind {
        Kind::Dir => (0, DIR_MODE),
        Kind::Link => (8, LINK_MODE),
        Kind::File => (8, FILE_MODE),
    };
    let method = if stored || plain { 0 } else { method };
    let (head, central) = encode(
        name,
        &Facts {
            method,
            crc: packer.crc.sum(),
            packed: packer.sent,
            size: packer.size,
            mode,
            stamp: dos_stamp(found.mtime),
            comment,
            level,
            text: packer.text,
        },
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
    if let Some(temp) = &config.temp {
        if host.stat(temp).await.as_deref() != Some("dir") {
            let name = [&temp[..], b"/ziXXXXXX"].concat();
            return fail(
                &say(
                    "zip I/O error: No such file or directory\nzip error: Temporary file failure ({})\n",
                    &[&name],
                ),
                false,
                TEMP_EXIT,
            );
        }
    }
    // `-T` looks at what the archive holds before anything replaces it;
    // what this run adds is sound as it is written.
    if config.test && host.stat(archive).await.is_some() {
        let status = unzip::run(host.clone(), unzip::Config::testing(archive)).await;
        host.ask(Request::Close { fd: ARCHIVE }).await;
        if status != 0 {
            host.print(&say("test of {} FAILED\n", &[archive]));
            return fail(TEST_FAILED.as_bytes(), false, TEST_EXIT);
        }
    }
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
        if (config.update || config.freshen || config.delete) && !config.quiet {
            host.warn(&say("\tzip warning: {} not found or empty\n", &[archive]));
        }
        None
    } else if reply.names(&["EISDIR"]) {
        return fail(&say(INVALID, &[archive]), false, INVALID_EXIT);
    } else {
        // Only absence means create; a refused or broken read must not
        // overwrite.
        return create_error(&reply, false);
    };
    let stored = if config.refresh_all {
        stored_files(&host, old.as_ref()).await
    } else {
        Vec::new()
    };
    let (mut members, repeated) = plan(&config, &stored);
    if !repeated.is_empty() {
        let repeated = if config.quiet { Vec::new() } else { repeated };
        let error = "\nzip error: Invalid command arguments (cannot repeat names in zip file)\n";
        return fail(
            &[repeated, error.as_bytes().to_vec()].concat(),
            true,
            REPEATED_EXIT,
        );
    }
    if config.delete {
        return delete(&host, &config, archive, old, &warnings).await;
    }
    let held: HashMap<Vec<u8>, u64> = old.as_ref().map_or_else(HashMap::new, |old| {
        old.records
            .iter()
            .map(|r| {
                let stamp =
                    (u64::from(u16_at(&r.central, 14)) << 16) | u64::from(u16_at(&r.central, 12));
                (r.name.clone(), stamp)
            })
            .collect()
    });
    if config.update || config.freshen {
        members.retain(|(name, found)| match held.get(name.as_slice()) {
            Some(&stamp) => dos_stamp(found.mtime) > stamp,
            None => config.update,
        });
    }
    if members.is_empty() && !config.comment_archive {
        if config.test && old.is_some() {
            if !config.quiet {
                host.print(&say("test of {} OK\n", &[archive]));
            }
            return 0;
        }
        if config.update || config.freshen {
            return NOTHING_EXIT;
        }
        if !config.include.is_empty() {
            if !config.quiet {
                host.warn(b"\tzip warning: zip file empty\n");
            }
            return 0;
        }
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
    let (mut replies, mut total_in, mut total_out) =
        (config.stdin_lines.clone().into_iter(), 0u64, 0u64);
    let mut prompts = Vec::new();
    for (index, (name, found)) in members.iter().enumerate() {
        if name.len() > 0xFFFF {
            return fail(&say(INVALID, &[archive]), false, INVALID_EXIT);
        }
        let comment = if config.comment_members {
            prompts.extend(say("Enter comment for {}:\n", &[name]));
            let mut comment = replies.next().unwrap_or_default();
            comment.truncate(MAX_COMMENT);
            comment
        } else {
            Vec::new()
        };
        let fd = 2000 + index as u32;
        let record = match add(&host, name, found, skip, fd, &config, &comment).await {
            Ok(record) => record,
            // A member the session may not read aborts the run and writes no
            // archive; Info-ZIP writes the rest and exits 18.
            Err(text) => {
                let path = found.path.clone().unwrap_or_default();
                return fail(&say("zip: {}: {}\n", &[&path, &text]), false, 1);
            }
        };
        skip += record.size;
        let verb: &[u8] = if config.freshen {
            b"freshening"
        } else if order.contains_key(name.as_slice()) {
            b"updating"
        } else {
            b"  adding"
        };
        if config.verbose {
            let (size, packed) = (u64::from(u32_at(&record.central, 24)), record.size);
            (total_in, total_out) = (total_in + size, total_out + packed);
            let ratio = (packed * 100)
                .checked_div(size)
                .map_or(0, |part| 100u64.saturating_sub(part));
            let how = if u16_at(&record.central, 10) == 0 {
                "stored".to_owned()
            } else {
                "deflated".to_owned()
            };
            let tail = format!("\t(in={size}) (out={packed}) ({how} {ratio}%)");
            lines.extend([verb, b": ", name, tail.as_bytes(), b"\n"].concat());
        } else {
            lines.extend(say("{}: {}\n", &[verb, name]));
        }
        added.push(record);
    }
    let new_comment = config.comment_archive.then(|| {
        let mut text = Vec::new();
        for line in replies.by_ref() {
            if line == b"." {
                break;
            }
            if !text.is_empty() {
                text.push(b'\n');
            }
            text.extend_from_slice(&line);
        }
        text.truncate(MAX_COMMENT);
        text
    });
    let (prefix, comment, old_records) = match old {
        Some(old) => (old.prefix, old.comment, old.records),
        None => (0, Vec::new(), Vec::new()),
    };
    let comment = new_comment.unwrap_or(comment);
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
    if let Some(reply) = write_out(&host, &config.output, pieces).await {
        return create_error(&reply, true);
    }
    let unremoved = if config.move_files {
        remove_sources(&host, &members).await
    } else {
        Vec::new()
    };
    if !config.quiet {
        host.print(&lines);
        host.print(&prompts);
        if config.comment_archive {
            host.print(b"enter new zip file comment (end with .):\n");
        }
        if config.verbose {
            let saved = (total_out * 100)
                .checked_div(total_in)
                .map_or(0, |part| 100u64.saturating_sub(part));
            host.print(
                format!("total bytes={total_in}, compressed={total_out} -> {saved}% savings\n")
                    .as_bytes(),
            );
        }
        if config.test {
            host.print(&say("test of {} OK\n", &[archive]));
        }
        host.warn(&warnings);
        host.warn(&unremoved);
    }
    0
}

/// What `-u` or `-f` with no file named looks at: each file the archive
/// holds that still stands under its stored name.
async fn stored_files(host: &Host, old: Option<&Original>) -> Vec<Found> {
    let mut stored = Vec::new();
    for record in old.map_or(&[][..], |old| &old.records[..]) {
        if record.name.ends_with(b"/") {
            continue;
        }
        if let Some((kind, mtime)) = host.stat_time(&record.name).await {
            if kind == "file" {
                stored.push(Found {
                    spelled: record.name.clone(),
                    path: Some(record.name.clone()),
                    mtime,
                    ..Found::default()
                });
            }
        }
    }
    stored
}

/// Remove what went into the archive: each file, then each directory,
/// deepest first; the warnings for what could not be removed.
async fn remove_sources(host: &Host, members: &[(Vec<u8>, &Found)]) -> Vec<u8> {
    let mut warnings = Vec::new();
    let mut note = |reply: &Reply, found: &Found| {
        if failed(reply) {
            warnings.extend(say("\tzip warning: error deleting {}\n", &[&found.spelled]));
        }
    };
    let mut dirs = Vec::new();
    for (_, found) in members {
        let path = found
            .source
            .clone()
            .or_else(|| found.path.clone())
            .unwrap_or_else(|| found.spelled.clone());
        if found.kind == Kind::Dir {
            dirs.push((path, *found));
        } else {
            note(&host.ask(Request::Unlink { path }).await.0, found);
        }
    }
    dirs.sort_by_key(|(dir, _)| std::cmp::Reverse(dir.len()));
    for (path, found) in dirs {
        note(&host.ask(Request::Rmdir { path }).await.0, found);
    }
    warnings
}

/// `-d`: the archive written again without the members the patterns name.
async fn delete(
    host: &Host,
    config: &Config,
    archive: &[u8],
    old: Option<Original>,
    warnings: &[u8],
) -> i32 {
    let (records, prefix, comment) = match old {
        Some(old) => (old.records, old.prefix, old.comment),
        None => (Vec::new(), 0, Vec::new()),
    };
    let mut matched = vec![false; config.patterns.len()];
    let mut kept = Vec::new();
    let mut lines = Vec::new();
    for record in records {
        let selected = |patterns: &[Vec<u8>]| {
            patterns
                .iter()
                .any(|pattern| wildcard(relative(pattern), &record.name, true))
        };
        let spared =
            selected(&config.exclude) || (!config.include.is_empty() && !selected(&config.include));
        let hit = config
            .patterns
            .iter()
            .position(|pattern| !spared && wildcard(relative(pattern), &record.name, true));
        match hit {
            Some(_) => {
                for (index, pattern) in config.patterns.iter().enumerate() {
                    matched[index] |= wildcard(relative(pattern), &record.name, true);
                }
                lines.extend(say("deleting: {}\n", &[&record.name]));
            }
            None => kept.push(record),
        }
    }
    let mut notices = warnings.to_vec();
    if !config.quiet {
        for (pattern, found) in config.patterns.iter().zip(&matched) {
            if !found {
                notices.extend(say("\tzip warning: name not matched: {}\n", &[pattern]));
            }
        }
    }
    if lines.is_empty() {
        notices.extend(say("\nzip error: Nothing to do! ({})\n", &[archive]));
        host.warn(&notices);
        return NOTHING_EXIT;
    }
    if kept.is_empty() && !config.quiet {
        notices.extend_from_slice(b"\tzip warning: zip file empty\n");
    }
    let mut pieces = Vec::new();
    keep(&mut pieces, ARCHIVE, 0, prefix);
    let mut offset = prefix;
    let mut directory = Vec::new();
    for record in &kept {
        directory.extend(placed(&record.central, offset));
        offset += record.size;
        keep(&mut pieces, record.spool, record.skip, record.size);
    }
    let size = directory.len() as u64;
    directory.extend(ending(kept.len() as u64, size, offset, &comment));
    pieces.push(Piece::Made(directory));
    if let Some(reply) = write_out(host, &config.output, pieces).await {
        let text = say(CREATE, &[&failure_text(&reply), archive]);
        host.warn(&text);
        return CREATE_EXIT;
    }
    if !config.quiet {
        host.print(&lines);
    }
    host.warn(&notices);
    0
}

/// The pieces as the file at `path`, whole; the host's failure if any.
async fn write_out(host: &Host, path: &[u8], pieces: Vec<Piece>) -> Option<Reply> {
    let path = path.to_vec();
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
            return Some(reply);
        }
    }
    None
}
