//! zip and unzip as Info-ZIP Zip 3.0 and UnZip 6.00 run them, as mirage
//! models them (wording and exit codes from Info-ZIP, Info-ZIP license;
//! see licenses/third_party/info-zip.txt). Each run is one async task over
//! its host: an archive is spooled by the host and read a window at a
//! time (its end record from the tail, then its central directory, then
//! each member's bytes), and every file it writes goes through the host,
//! so no run holds more than a window of the archive.

mod create;
mod listing;
#[cfg(test)]
mod tests;
mod unzip;

use flate2::{Crc, Decompress, FlushDecompress, Status};

use crate::request::{Opening, Reply, Request, bytes};
use crate::task::Host;
use crate::{Stream, StreamError, parse_config, task};

const LOCAL: u32 = 0x0403_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const END: u32 = 0x0605_4b50;
const END64: u32 = 0x0606_4b50;
const LOCATOR64: u32 = 0x0706_4b50;
/// The end record is looked for in the last 65557 bytes: 22 of record
/// behind a comment of at most 65535.
const END_SEARCH: u64 = 65557;
const ZIP32: u64 = 0xFFFF_FFFF;
/// How much of a member is read, or written, a request at a time.
const WINDOW: usize = 64 * 1024;
/// How much of the directory, or of the archive's tail, one request reads.
const READ: u64 = 1024 * 1024;
/// How much of a member zip reads a request at a time.
const GATHER: u64 = 64 * 1024;
/// The spool the archive is read into.
const ARCHIVE: u32 = 1;

pub(crate) fn open_zip(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: create::Config = parse_config(config)?;
    Ok(task::spawn(|host| create::run(host, config)))
}

pub(crate) fn open_unzip(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: unzip::Config = parse_config(config)?;
    Ok(task::spawn(|host| unzip::run(host, config)))
}

fn u16_at(data: &[u8], at: usize) -> u16 {
    data.get(at..at + 2)
        .map_or(0, |b| u16::from_le_bytes([b[0], b[1]]))
}

fn u32_at(data: &[u8], at: usize) -> u32 {
    data.get(at..at + 4)
        .map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    data.get(at..at + 8).map_or(0, |b| {
        u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
    })
}

/// IBM code page 437's upper half.
const CP437: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐\
└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";

/// A stored name as text: UTF-8 when flagged so or already valid (as
/// Info-ZIP's Zip 3.0 stores Unix names unflagged), else code page 437,
/// as APPNOTE reads an unflagged name. Divergence: Info-ZIP on Unix keeps
/// such a name's bytes, Latin-1 for a FAT host's, which no path holds.
fn text_name(stored: &[u8], flags: u16) -> Vec<u8> {
    if flags & 0x800 != 0 || std::str::from_utf8(stored).is_ok() {
        return stored.to_vec();
    }
    let high: Vec<char> = CP437.chars().collect();
    let text: String = stored
        .iter()
        .map(|&b| {
            high.get(usize::from(b).wrapping_sub(0x80))
                .copied()
                .unwrap_or(char::from(b))
        })
        .collect();
    text.into_bytes()
}

/// One central-directory record.
#[derive(Clone, Default)]
pub(super) struct Entry {
    pub(super) name: Vec<u8>,
    pub(super) made_by: u16,
    pub(super) flags: u16,
    pub(super) method: u16,
    pub(super) time: u16,
    pub(super) date: u16,
    pub(super) crc: u32,
    pub(super) csize: u64,
    pub(super) size: u64,
    pub(super) internal: u16,
    pub(super) external: u32,
    /// Where its local record starts, the archive's slack applied.
    pub(super) local: u64,
    pub(super) has_extra: bool,
    pub(super) comment: Vec<u8>,
    /// The record as stored, which an update copies.
    pub(super) record: Vec<u8>,
}

impl Entry {
    pub(super) fn host(&self) -> u8 {
        (self.made_by >> 8) as u8
    }

    /// The name as the archive stores it, before any decoding.
    pub(super) fn stored(&self) -> &[u8] {
        &self.record[46..46 + usize::from(u16_at(&self.record, 28))]
    }

    pub(super) fn is_dir(&self) -> bool {
        self.name.ends_with(b"/")
    }

    /// The DOS stamp as (year, month, day, hour, minute, second).
    pub(super) fn stamp(&self) -> (u16, u16, u16, u16, u16, u16) {
        (
            1980 + (self.date >> 9),
            (self.date >> 5) & 0xF,
            self.date & 0x1F,
            self.time >> 11,
            (self.time >> 5) & 0x3F,
            (self.time & 0x1F) * 2,
        )
    }
}

/// An end record and what it says of the central directory.
pub(super) struct End {
    /// Where the record (or a ZIP64 one before it) starts: the directory
    /// ends there.
    pub(super) at: u64,
    pub(super) count: u64,
    pub(super) size: u64,
    pub(super) offset: u64,
    pub(super) comment: Vec<u8>,
}

/// The last end record in `tail`, the archive's last bytes from `base`;
/// `exact` takes only one whose comment reaches the archive's end.
fn end_record(tail: &[u8], base: u64, exact: bool) -> Option<End> {
    let at = (0..=tail.len().checked_sub(22)?).rev().find(|&at| {
        u32_at(tail, at) == END
            && (!exact || at + 22 + usize::from(u16_at(tail, at + 20)) == tail.len())
    })?;
    let comment_end = (at + 22 + usize::from(u16_at(tail, at + 20))).min(tail.len());
    Some(End {
        at: base + at as u64,
        count: u64::from(u16_at(tail, at + 10)),
        size: u64::from(u32_at(tail, at + 12)),
        offset: u64::from(u32_at(tail, at + 16)),
        comment: tail[at + 22..comment_end].to_vec(),
    })
}

/// The values a ZIP64 extra field holds for the fields `wide` marks as
/// saturated, in their order: size, compressed size, offset.
fn zip64_fields(extra: &[u8], wide: [bool; 3]) -> [Option<u64>; 3] {
    let mut fields = [None; 3];
    let mut at = 0;
    while at + 4 <= extra.len() {
        let (tag, len) = (u16_at(extra, at), usize::from(u16_at(extra, at + 2)));
        let body = &extra[at + 4..(at + 4 + len).min(extra.len())];
        if tag == 1 {
            let mut pos = 0;
            for (slot, &saturated) in fields.iter_mut().zip(&wide) {
                if saturated && pos + 8 <= body.len() {
                    *slot = Some(u64_at(body, pos));
                    pos += 8;
                }
            }
            break;
        }
        at += 4 + len;
    }
    fields
}

/// The records a directory of `count` entries holds, each moved by
/// `slack`; None when the records do not tile `directory` exactly.
fn central(directory: &[u8], count: u64, slack: i128) -> Option<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut at = 0;
    for _ in 0..count {
        if at + 46 > directory.len() || u32_at(directory, at) != CENTRAL {
            return None;
        }
        let head = &directory[at..at + 46];
        let name_len = usize::from(u16_at(head, 28));
        let extra_len = usize::from(u16_at(head, 30));
        let comment_len = usize::from(u16_at(head, 32));
        let next = at + 46 + name_len + extra_len + comment_len;
        if next > directory.len() {
            return None;
        }
        let name = text_name(&directory[at + 46..at + 46 + name_len], u16_at(head, 8));
        let extra = &directory[at + 46 + name_len..at + 46 + name_len + extra_len];
        let narrow = [u32_at(head, 24), u32_at(head, 20), u32_at(head, 42)];
        let wide = zip64_fields(extra, narrow.map(|v| u64::from(v) == ZIP32));
        let [size, csize, local] = [0, 1, 2].map(|i| wide[i].unwrap_or(u64::from(narrow[i])));
        entries.push(Entry {
            name,
            made_by: u16_at(head, 4),
            flags: u16_at(head, 8),
            method: u16_at(head, 10),
            time: u16_at(head, 12),
            date: u16_at(head, 14),
            crc: u32_at(head, 16),
            csize,
            size,
            internal: u16_at(head, 36),
            external: u32_at(head, 38),
            local: u64::try_from(i128::from(local) + slack).unwrap_or(u64::MAX),
            has_extra: extra_len > 0,
            comment: directory[next - comment_len..next].to_vec(),
            record: directory[at..next].to_vec(),
        });
        at = next;
    }
    (at == directory.len()).then_some(entries)
}

/// An archive's directory: its records, its comment, and the bytes found
/// before it beyond what its end record accounts for (negative when bytes
/// are missing).
pub(super) struct Directory {
    pub(super) entries: Vec<Entry>,
    pub(super) comment: Vec<u8>,
    pub(super) slack: i128,
}

/// Why an archive could not be read.
pub(super) enum Fault {
    /// No end record: not an archive at all.
    NoEnd,
    /// An end record whose directory is not where it says.
    Corrupt,
    /// The host failed a read of its spool, in these words.
    Read(Vec<u8>),
}

/// The archive spooled into `fd`, `size` bytes, read through the host a
/// window at a time; a short read takes a whole window and keeps it, so
/// the headers and small members laid out after it cost no request.
pub(super) struct Spool<'h> {
    pub(super) host: &'h Host,
    pub(super) fd: u32,
    pub(super) size: u64,
    kept: (u64, Vec<u8>),
}

impl<'h> Spool<'h> {
    pub(super) fn new(host: &'h Host, fd: u32, size: u64) -> Self {
        Spool {
            host,
            fd,
            size,
            kept: (0, Vec::new()),
        }
    }

    /// Up to `size` bytes from `skip`, in one reply; empty past the end.
    pub(super) async fn window(&mut self, skip: u64, size: u64) -> Result<Vec<u8>, Vec<u8>> {
        let size = size.min(self.size.saturating_sub(skip));
        let (start, kept) = &self.kept;
        if skip >= *start && skip + size <= start + kept.len() as u64 {
            let at = (skip - start) as usize;
            return Ok(kept[at..at + size as usize].to_vec());
        }
        let short = size < WINDOW as u64;
        let opening = Opening::Window {
            fd: self.fd,
            skip,
            size: if short { WINDOW as u64 } else { size },
        };
        let request = Request::Read {
            fd: 0,
            open: Some((Vec::new(), opening)),
            least: 0,
        };
        let (reply, data) = self.host.ask(request).await;
        if failed(&reply) {
            return Err(failure_text(&reply));
        }
        if !short {
            return Ok(data);
        }
        let out = data[..data.len().min(size as usize)].to_vec();
        self.kept = (skip, data);
        Ok(out)
    }

    /// `size` bytes from `skip`, or as many as the spool holds.
    pub(super) async fn read(&mut self, skip: u64, size: u64) -> Result<Vec<u8>, Vec<u8>> {
        let mut out = self.window(skip, size.min(READ)).await?;
        while (out.len() as u64) < size {
            let at = skip + out.len() as u64;
            let more = self.window(at, (size - out.len() as u64).min(READ)).await?;
            if more.is_empty() {
                break;
            }
            out.extend_from_slice(&more);
        }
        Ok(out)
    }

    /// The archive's directory; `exact` is zip's stricter search for the
    /// end record.
    pub(super) async fn directory(&mut self, exact: bool) -> Result<Directory, Fault> {
        let base = self.size.saturating_sub(END_SEARCH);
        let tail = self
            .read(base, self.size - base)
            .await
            .map_err(Fault::Read)?;
        let mut end = end_record(&tail, base, exact).ok_or(Fault::NoEnd)?;
        let saturated = end.count == 0xFFFF || end.size == ZIP32 || end.offset == ZIP32;
        // The ZIP64 record ends where its locator starts, which a long
        // comment can push before the tail.
        let at = end.at.checked_sub(20).filter(|_| saturated);
        if let Some((at, record)) = at.and_then(|at| Some((at, at.checked_sub(56)?))) {
            let locator = self.read(at, 20).await.map_err(Fault::Read)?;
            if u32_at(&locator, 0) == LOCATOR64 {
                let wide = self.read(record, 56).await.map_err(Fault::Read)?;
                if u32_at(&wide, 0) == END64 {
                    end.at = record;
                    end.count = u64_at(&wide, 32);
                    end.size = u64_at(&wide, 40);
                    end.offset = u64_at(&wide, 48);
                }
            }
        }
        let start = end.at.checked_sub(end.size).ok_or(Fault::Corrupt)?;
        let slack = i128::from(start) - i128::from(end.offset);
        let directory = self.read(start, end.size).await.map_err(Fault::Read)?;
        let entries = central(&directory, end.count, slack).ok_or(Fault::Corrupt)?;
        Ok(Directory {
            entries,
            comment: end.comment,
            slack,
        })
    }

    /// Where an entry's data starts, past its local header; None when no
    /// local header stands where the directory says.
    pub(super) async fn data_start(&mut self, entry: &Entry) -> Result<Option<u64>, Vec<u8>> {
        let head = self.read(entry.local, 30).await?;
        if head.len() < 30 || u32_at(&head, 0) != LOCAL {
            return Ok(None);
        }
        Ok(Some(
            entry.local + 30 + u64::from(u16_at(&head, 26)) + u64::from(u16_at(&head, 28)),
        ))
    }
}

/// `template` with each `{}` filled by the next of `args`, which are any
/// bytes, as Info-ZIP's messages hold names verbatim.
pub(super) fn say(template: &str, args: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for (i, piece) in template.split("{}").enumerate() {
        if i > 0 {
            out.extend_from_slice(args.get(i - 1).copied().unwrap_or_default());
        }
        out.extend_from_slice(piece.as_bytes());
    }
    out
}

/// A name left-justified to `width` characters, counted as Python counts
/// them: code points of UTF-8, else bytes.
pub(super) fn padded(name: &[u8], width: usize) -> Vec<u8> {
    let count = std::str::from_utf8(name).map_or(name.len(), |text| text.chars().count());
    let mut out = name.to_vec();
    out.resize(name.len() + width.saturating_sub(count), b' ');
    out
}

/// One bracket class at the start of `pattern` (after its `[`): whether it
/// holds `byte`, and where the pattern goes on; None when unterminated.
fn class(pattern: &[u8], byte: u8) -> Option<(bool, usize)> {
    let negated = matches!(pattern.first(), Some(b'!' | b'^'));
    let mut at = usize::from(negated);
    let mut held = false;
    let mut first = true;
    while let Some(&low) = pattern.get(at) {
        if low == b']' && !first {
            return Some((held != negated, at + 1));
        }
        first = false;
        match (pattern.get(at + 1), pattern.get(at + 2)) {
            (Some(b'-'), Some(&high)) if high != b']' => {
                held |= (low..=high).contains(&byte);
                at += 3;
            }
            _ => {
                held |= low == byte;
                at += 1;
            }
        }
    }
    None
}

/// Whether `name` matches a filespec, a byte at a time: `*` any run,
/// slashes too, `?` one byte, `[...]` a class (`!` or `^` negates, `a-z`
/// a range, a leading `]` itself), an unterminated `[` itself; with
/// `escapes`, `\` makes the next byte itself.
pub(super) fn wildcard(pattern: &[u8], name: &[u8], escapes: bool) -> bool {
    let (mut p, mut n) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    loop {
        let step = match pattern.get(p) {
            Some(b'*') => {
                star = Some((p + 1, n));
                p += 1;
                continue;
            }
            Some(_) if n == name.len() => None,
            Some(b'?') => Some(p + 1),
            Some(b'[') => match class(&pattern[p + 1..], name[n]) {
                Some((true, len)) => Some(p + 1 + len),
                Some((false, _)) => None,
                None => (name[n] == b'[').then_some(p + 1),
            },
            Some(b'\\') if escapes && p + 1 < pattern.len() => {
                (pattern[p + 1] == name[n]).then_some(p + 2)
            }
            Some(&byte) => (byte == name[n]).then_some(p + 1),
            None if n == name.len() => return true,
            None => None,
        };
        match (step, star) {
            (Some(next), _) => {
                p = next;
                n += 1;
            }
            (None, Some((resume, from))) if from < name.len() => {
                star = Some((resume, from + 1));
                p = resume;
                n = from + 1;
            }
            (None, _) => return false,
        }
    }
}

/// Whether the host failed the request.
pub(super) fn failed(reply: &Reply) -> bool {
    reply.error.is_some() || reply.fatal.is_some()
}

/// A host reply's failure text as bytes.
pub(super) fn failure_text(reply: &Reply) -> Vec<u8> {
    bytes(
        reply
            .error
            .as_deref()
            .or(reply.fatal.as_deref())
            .unwrap_or_default(),
    )
}

/// What decoding a member's data came to.
pub(super) enum Decoded {
    Sound,
    BadCrc(u32),
    /// The data does not decode; the method's verb, as Info-ZIP words it.
    Invalid(&'static str),
}

/// A member's data, decoded as its method says (stored, deflated or
/// bzip2'd), a window of output at a time, its CRC-32 checked at the end.
pub(super) struct Decoder {
    method: Method,
    crc: Crc,
    expected: u32,
    ended: bool,
    failed: Option<&'static str>,
    /// Whether the last step filled its window, so more may come without
    /// more input.
    full: bool,
}

enum Method {
    Stored,
    Deflated(Box<Decompress>),
    Bzip2(Box<bzip2::Decompress>),
}

impl Decoder {
    /// A decoder for `entry`, None for a method mirage does not decode.
    pub(super) fn new(entry: &Entry) -> Option<Decoder> {
        let method = match entry.method {
            0 => Method::Stored,
            8 => Method::Deflated(Box::new(Decompress::new(false))),
            12 => Method::Bzip2(Box::new(bzip2::Decompress::new(false))),
            _ => return None,
        };
        Some(Decoder {
            ended: matches!(method, Method::Stored),
            method,
            crc: Crc::new(),
            expected: entry.crc,
            failed: None,
            full: false,
        })
    }

    /// Decode from `input` until a window of output is made or the input
    /// is used up; the output goes to `out` and the input used is
    /// returned.
    pub(super) fn step(&mut self, input: &[u8], out: &mut Vec<u8>) -> usize {
        out.clear();
        if self.failed.is_some() || (self.ended && !matches!(self.method, Method::Stored)) {
            return input.len();
        }
        out.resize(WINDOW, 0);
        let (used, made) = match &mut self.method {
            Method::Stored => {
                let take = input.len().min(WINDOW);
                out[..take].copy_from_slice(&input[..take]);
                (take as u64, take as u64)
            }
            Method::Deflated(inflater) => {
                let (was_in, was_out) = (inflater.total_in(), inflater.total_out());
                match inflater.decompress(input, out, FlushDecompress::None) {
                    Ok(status) => {
                        self.ended = status == Status::StreamEnd;
                        (inflater.total_in() - was_in, inflater.total_out() - was_out)
                    }
                    Err(_) => {
                        self.failed = Some("inflate");
                        (0, 0)
                    }
                }
            }
            Method::Bzip2(decoder) => {
                let (was_in, was_out) = (decoder.total_in(), decoder.total_out());
                match decoder.decompress(input, out) {
                    Ok(status) => {
                        self.ended = status == bzip2::Status::StreamEnd;
                        (decoder.total_in() - was_in, decoder.total_out() - was_out)
                    }
                    Err(_) => {
                        self.failed = Some("bunzip");
                        (0, 0)
                    }
                }
            }
        };
        let (used, made) = (used as usize, made as usize);
        out.truncate(made);
        self.crc.update(out);
        self.full = made == WINDOW;
        if self.failed.is_some() {
            return input.len();
        }
        used
    }

    /// Whether a step with no more input could still make output.
    pub(super) fn pending(&self) -> bool {
        self.full
            && self.failed.is_none()
            && !(self.ended && !matches!(self.method, Method::Stored))
    }

    /// The verdict once every byte of the data was fed.
    pub(super) fn finish(&self) -> Decoded {
        match self.failed {
            Some(verb) => Decoded::Invalid(verb),
            None if !self.ended => Decoded::Invalid("inflate"),
            None if self.crc.sum() != self.expected => Decoded::BadCrc(self.crc.sum()),
            None => Decoded::Sound,
        }
    }
}
