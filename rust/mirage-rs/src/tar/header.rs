//! tar's 512-byte header blocks: read as GNU tar 1.35 reads ustar, GNU and
//! pax headers, and written as it writes one in its default GNU format,
//! with mirage's fixed owner, stamp and modes.

use super::escaped;

pub(super) const BLOCK: usize = 512;
/// GNU's default record: 20 blocks, to which an archive is padded.
pub(super) const RECORD: usize = 20 * BLOCK;
/// The longest name or link target a header holds itself.
const FIELD: usize = 100;
const LONG_LINK: &[u8] = b"././@LongLink";
const GNU_MAGIC: &[u8] = b"ustar  \0";
const POSIX_MAGIC: &[u8] = b"ustar\0";
/// The largest size an 11-digit octal field holds; past it, base-256.
const OCTAL_SIZE: u64 = 1 << 33;

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub(super) enum Kind {
    #[default]
    File,
    Hard,
    Link,
    Char,
    Block,
    Dir,
    Fifo,
    /// A typeflag GNU does not know, extracted as a regular file.
    Other(u8),
}

impl Kind {
    fn of(flag: u8) -> Kind {
        match flag {
            b'0' | b'\0' | b'7' | b'S' => Kind::File,
            b'1' => Kind::Hard,
            b'2' => Kind::Link,
            b'3' => Kind::Char,
            b'4' => Kind::Block,
            b'5' => Kind::Dir,
            b'6' => Kind::Fifo,
            other => Kind::Other(other),
        }
    }
}

/// One member as its headers describe it.
#[derive(Default)]
pub(super) struct Member {
    pub(super) name: Vec<u8>,
    pub(super) target: Vec<u8>,
    pub(super) kind: Kind,
    pub(super) mode: u32,
    pub(super) uid: u64,
    pub(super) gid: u64,
    pub(super) uname: Vec<u8>,
    pub(super) gname: Vec<u8>,
    pub(super) size: u64,
    pub(super) mtime: i64,
    pub(super) major: u64,
    pub(super) minor: u64,
    pub(super) sparse: Option<Sparse>,
}

/// A sparse member's layout: the offset and length of each run of data its
/// archived bytes hold, in order, and the whole file's size; `inline` when
/// the runs are the decimal lines its data starts with (pax format 1.0).
#[derive(Clone, Default)]
pub(super) struct Sparse {
    pub(super) runs: Vec<u64>,
    pub(super) real: u64,
    pub(super) inline: bool,
}

/// The runs a GNU sparse header's 24-byte entries hold, up to the first
/// that is no offset and length.
pub(super) fn runs(entries: &[u8]) -> Vec<u64> {
    let field = |field: &[u8]| u64::try_from(number(field)??).ok();
    entries
        .chunks_exact(24)
        .map_while(|entry| Some([field(&entry[..12])?, field(&entry[12..])?]))
        .flatten()
        .collect()
}

/// What one block holds.
pub(super) enum Block {
    Zero,
    /// No header: the lines GNU says about a field it could not read.
    Bad(Vec<Vec<u8>>),
    /// A header, its typeflag, and the lines GNU says about its fields.
    Head(Member, u8, Vec<Vec<u8>>),
}

/// A numeric field as GNU reads one: base-256 two's complement when the
/// first byte's high bit is set, else octal digits after any blanks, ended
/// by a NUL, a blank or the field's end. None when it is neither; `Some(None)`
/// when it holds no digits at all.
fn number(field: &[u8]) -> Option<Option<i128>> {
    if let Some(&lead) = field.first().filter(|&&b| b & 0x80 != 0) {
        let mut value = i128::from(lead & 0x7f) - if lead & 0x40 != 0 { 0x80 } else { 0 };
        for &byte in &field[1..] {
            value = value.checked_mul(256)?.checked_add(i128::from(byte))?;
        }
        return Some(Some(value));
    }
    let blank = |b: u8| matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r');
    let start = field.iter().position(|&b| !blank(b)).unwrap_or(field.len());
    let digits = field[start..]
        .iter()
        .take_while(|b| (b'0'..=b'7').contains(b))
        .count();
    let end = start + digits;
    if field.get(end).is_some_and(|&b| b != 0 && !blank(b)) {
        return None;
    }
    if digits == 0 {
        return Some(None);
    }
    let mut value: i128 = 0;
    for &byte in &field[start..end] {
        value = value.checked_mul(8)?.checked_add(i128::from(byte - b'0'))?;
    }
    Some(Some(value))
}

/// A field's value, -1 when GNU refuses it, with what it says if so; `kind`
/// is the field's C type, as GNU's diagnostics name it.
fn read(field: &[u8], kind: &str, lines: &mut Vec<Vec<u8>>) -> i128 {
    let shown = &field[..field.iter().position(|&b| b == 0).unwrap_or(field.len())];
    let value = match number(field) {
        Some(value) => value.unwrap_or(0),
        None => {
            let shown = crate::quoted(shown);
            let line =
                format!("tar: Archive contains '{shown}' where numeric {kind} value expected");
            lines.push(line.into_bytes());
            return -1;
        }
    };
    let (low, high) = match kind {
        "off_t" => (0, i128::from(i64::MAX)),
        "time_t" => (i128::from(i64::MIN), i128::from(i64::MAX)),
        _ => (0, i128::from(u32::MAX)),
    };
    if !(low..=high).contains(&value) {
        let line = format!("tar: Archive value {value} is out of {kind} range {low}..{high}");
        lines.push(line.into_bytes());
        return -1;
    }
    value
}

/// A value of an unsigned field GNU refused, as it shows one: all ones.
fn unsigned(value: i128) -> u64 {
    if value < 0 {
        u64::from(u32::MAX)
    } else {
        value as u64
    }
}

/// A NUL-ended text field.
fn text(field: &[u8]) -> Vec<u8> {
    field[..field.iter().position(|&b| b == 0).unwrap_or(field.len())].to_vec()
}

/// Whether the block's checksum field holds its sum, counted with the field
/// as blanks, of bytes as unsigned or, as old archivers did, signed.
fn summed(block: &[u8]) -> bool {
    let Some(Some(stored)) = number(&block[148..156]).filter(|_| block[148] & 0x80 == 0) else {
        return false;
    };
    let (mut plain, mut signed) = (0i128, 0i128);
    for (at, &byte) in block.iter().enumerate() {
        let byte = if (148..156).contains(&at) { b' ' } else { byte };
        plain += i128::from(byte);
        signed += i128::from(byte as i8);
    }
    stored == plain || stored == signed
}

pub(super) fn decode(block: &[u8]) -> Block {
    if block.iter().all(|&b| b == 0) {
        return Block::Zero;
    }
    if !summed(block) {
        return Block::Bad(Vec::new());
    }
    let mut lines = Vec::new();
    let size = read(&block[124..136], "off_t", &mut lines);
    if size < 0 {
        return Block::Bad(lines);
    }
    let mut name = text(&block[..FIELD]);
    let prefix = text(&block[345..500]);
    if &block[257..263] == POSIX_MAGIC && !prefix.is_empty() {
        name = [&prefix[..], b"/", &name].concat();
    }
    let flag = block[156];
    let sparse = (flag == b'S').then(|| Sparse {
        runs: runs(&block[386..482]),
        real: number(&block[483..495])
            .flatten()
            .and_then(|real| u64::try_from(real).ok())
            .unwrap_or(size as u64),
        inline: false,
    });
    let mode = read(&block[100..108], "mode_t", &mut lines);
    let member = Member {
        name,
        target: text(&block[157..257]),
        kind: Kind::of(flag),
        mode: (mode & 0o7777) as u32,
        uid: unsigned(read(&block[108..116], "uid_t", &mut lines)),
        gid: unsigned(read(&block[116..124], "gid_t", &mut lines)),
        uname: text(&block[265..297]),
        gname: text(&block[297..329]),
        size: size as u64,
        mtime: read(&block[136..148], "time_t", &mut lines) as i64,
        major: unsigned(read(&block[329..337], "major_t", &mut lines)),
        minor: unsigned(read(&block[337..345], "minor_t", &mut lines)),
        sparse,
    };
    Block::Head(member, flag, lines)
}

/// What pax records say of the member they precede.
#[derive(Clone, Default)]
pub(super) struct Pax {
    path: Option<Vec<u8>>,
    linkpath: Option<Vec<u8>>,
    size: Option<u64>,
    uid: Option<u64>,
    gid: Option<u64>,
    uname: Option<Vec<u8>>,
    gname: Option<Vec<u8>>,
    mtime: Option<i64>,
    /// GNU's sparse records: the file's name and size, its runs (formats
    /// 0.0 and 0.1), and whether its data starts with them (1.0).
    sparse_name: Option<Vec<u8>>,
    real: Option<u64>,
    runs: Vec<u64>,
    inline: bool,
}

impl Pax {
    /// Lay the records of one extended header over these: `LEN KEY=VALUE\n`
    /// each, LEN counting the whole record.
    pub(super) fn read(&mut self, data: &[u8]) {
        let mut at = 0;
        while let Some(space) = data[at..].iter().position(|&b| b == b' ') {
            let Some(len) = std::str::from_utf8(&data[at..at + space])
                .ok()
                .and_then(|len| len.parse::<usize>().ok())
                .filter(|&len| len > space + 1 && len <= data.len() - at)
            else {
                break;
            };
            let record = &data[at + space + 1..at + len - 1];
            at += len;
            let Some(equals) = record.iter().position(|&b| b == b'=') else {
                continue;
            };
            let (key, value) = (&record[..equals], record[equals + 1..].to_vec());
            let decimal = || std::str::from_utf8(&value).ok()?.parse::<u64>().ok();
            match key {
                b"path" => self.path = Some(value),
                b"linkpath" => self.linkpath = Some(value),
                b"size" => self.size = decimal(),
                b"uid" => self.uid = decimal(),
                b"gid" => self.gid = decimal(),
                b"uname" => self.uname = Some(value),
                b"gname" => self.gname = Some(value),
                b"mtime" => self.mtime = seconds(&value),
                b"GNU.sparse.name" => self.sparse_name = Some(value),
                b"GNU.sparse.size" | b"GNU.sparse.realsize" => self.real = decimal(),
                b"GNU.sparse.offset" | b"GNU.sparse.numbytes" => self.runs.extend(decimal()),
                b"GNU.sparse.map" => {
                    let numbers = value.split(|&b| b == b',');
                    let number = |text: &[u8]| std::str::from_utf8(text).ok()?.parse().ok();
                    self.runs = numbers.map_while(number).collect();
                }
                b"GNU.sparse.major" => self.inline = value == b"1",
                _ => {}
            }
        }
    }

    /// `member` with what these records say laid over its header.
    pub(super) fn apply(&self, member: &mut Member) {
        let pick = |field: &Option<Vec<u8>>, into: &mut Vec<u8>| {
            if let Some(value) = field {
                into.clone_from(value);
            }
        };
        pick(&self.path, &mut member.name);
        pick(&self.sparse_name, &mut member.name);
        pick(&self.linkpath, &mut member.target);
        pick(&self.uname, &mut member.uname);
        pick(&self.gname, &mut member.gname);
        member.size = self.size.unwrap_or(member.size);
        member.uid = self.uid.unwrap_or(member.uid);
        member.gid = self.gid.unwrap_or(member.gid);
        member.mtime = self.mtime.unwrap_or(member.mtime);
        if let Some(real) = self.real {
            let (runs, inline) = (self.runs.clone(), self.inline);
            member.sparse = Some(Sparse { runs, real, inline });
        }
    }
}

/// A pax time's whole seconds, rounded down.
fn seconds(value: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(value).ok()?;
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let seconds: i64 = whole.parse().ok()?;
    let below = whole.starts_with('-') && fraction.bytes().any(|b| b != b'0');
    Some(seconds - i64::from(below))
}

/// The block GNU writes for one member, with mirage's owner (none, uid 0),
/// stamp (the epoch) and modes.
fn head(name: &[u8], flag: u8, mode: u32, size: u64, target: &[u8]) -> Vec<u8> {
    let mut block = vec![0u8; BLOCK];
    let mut put = |at: usize, bytes: &[u8]| block[at..at + bytes.len()].copy_from_slice(bytes);
    put(0, &name[..name.len().min(FIELD)]);
    put(100, format!("{mode:07o}\0").as_bytes());
    put(108, b"0000000\0");
    put(116, b"0000000\0");
    if size < OCTAL_SIZE {
        put(124, format!("{size:011o}\0").as_bytes());
    } else {
        put(124, &[0x80, 0, 0, 0]);
        put(128, &size.to_be_bytes());
    }
    put(136, b"00000000000\0");
    put(148, b"        ");
    put(156, &[flag]);
    put(157, &target[..target.len().min(FIELD)]);
    put(257, GNU_MAGIC);
    let sum: u32 = block.iter().map(|&b| u32::from(b)).sum();
    block[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    block
}

/// A GNU long-name record carrying `text`, which the next header's field
/// cannot hold.
fn long(flag: u8, text: &[u8]) -> Vec<u8> {
    let mut out = head(LONG_LINK, flag, 0o644, text.len() as u64 + 1, b"");
    out.extend_from_slice(text);
    out.resize(out.len() + padding(text.len() as u64 + 1) + 1, 0);
    out
}

/// The headers GNU writes for a member: a long link target's record, then a
/// long name's, then its own.
pub(super) fn encode(name: &[u8], kind: Kind, size: u64, target: &[u8]) -> Vec<u8> {
    let (flag, mode) = match kind {
        Kind::Dir => (b'5', 0o755),
        Kind::Link => (b'2', 0o777),
        _ => (b'0', 0o644),
    };
    let mut out = Vec::new();
    if target.len() > FIELD {
        out.extend(long(b'K', target));
    }
    if name.len() > FIELD {
        out.extend(long(b'L', name));
    }
    out.extend(head(name, flag, mode, size, target));
    out
}

/// The zeros that round `size` bytes of data up to whole blocks.
pub(super) fn padding(size: u64) -> usize {
    (size.wrapping_neg() % BLOCK as u64) as usize
}

/// `ls -l`'s ten letters for a member.
fn letters(member: &Member) -> Vec<u8> {
    let kind = match member.kind {
        Kind::File => b'-',
        Kind::Hard => b'h',
        Kind::Link => b'l',
        Kind::Char => b'c',
        Kind::Block => b'b',
        Kind::Dir => b'd',
        Kind::Fifo => b'p',
        Kind::Other(_) => b'?',
    };
    let mode = member.mode;
    let mut out = vec![kind];
    for (shift, special, set, unset) in [(6, 0o4000, b's', b'S'), (3, 0o2000, b's', b'S')] {
        out.push(if mode >> shift & 4 != 0 { b'r' } else { b'-' });
        out.push(if mode >> shift & 2 != 0 { b'w' } else { b'-' });
        out.push(match (mode >> shift & 1 != 0, mode & special != 0) {
            (true, true) => set,
            (false, true) => unset,
            (true, false) => b'x',
            (false, false) => b'-',
        });
    }
    out.push(if mode & 4 != 0 { b'r' } else { b'-' });
    out.push(if mode & 2 != 0 { b'w' } else { b'-' });
    out.push(match (mode & 1 != 0, mode & 0o1000 != 0) {
        (true, true) => b't',
        (false, true) => b'T',
        (true, false) => b'x',
        (false, false) => b'-',
    });
    out
}

/// A Unix time as `YYYY-MM-DD HH:MM` in UTC, by the proleptic Gregorian
/// calendar (days to civil date as Hinnant derives it).
fn stamp(time: i64) -> String {
    let (days, secs) = (time.div_euclid(86_400), time.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}",
        secs / 3600,
        secs % 3600 / 60
    )
}

/// GNU's `-tv` rows: the owner and size column widens to the widest it has
/// shown, and stays that wide for the rest of the run.
pub(super) struct Rows {
    width: usize,
}

impl Default for Rows {
    fn default() -> Rows {
        Rows { width: 19 }
    }
}

impl Rows {
    pub(super) fn row(&mut self, member: &Member) -> Vec<u8> {
        let id = |name: &[u8], id: u64| {
            if name.is_empty() {
                id.to_string().into_bytes()
            } else {
                name.to_vec()
            }
        };
        let owner = [
            &id(&member.uname, member.uid)[..],
            b"/",
            &id(&member.gname, member.gid),
        ]
        .concat();
        let size = match member.kind {
            Kind::Char | Kind::Block => format!("{},{}", member.major, member.minor),
            _ => member
                .sparse
                .as_ref()
                .map_or(member.size, |sparse| sparse.real)
                .to_string(),
        };
        self.width = self.width.max(owner.len() + 1 + size.len());
        let pad = self.width - owner.len() - size.len();
        let mut out = letters(member);
        out.push(b' ');
        out.extend_from_slice(&owner);
        out.resize(out.len() + pad, b' ');
        out.extend_from_slice(size.as_bytes());
        out.push(b' ');
        out.extend_from_slice(stamp(member.mtime).as_bytes());
        out.push(b' ');
        out.extend(escaped(&member.name));
        match member.kind {
            Kind::Link => out.extend([b" -> ", &escaped(&member.target)[..]].concat()),
            Kind::Hard => out.extend([b" link to ", &escaped(&member.target)[..]].concat()),
            Kind::Other(flag) => out.extend([&b" unknown file type '"[..], &[flag], b"'"].concat()),
            _ => {}
        }
        out
    }
}
