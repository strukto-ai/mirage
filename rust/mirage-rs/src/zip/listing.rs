//! The listings unzip prints from the central directory: `-l`, `-v`'s
//! verbose table and zipinfo's (`-Z`) rows, header and totals, as UnZip
//! 6.00's list.c and zipinfo.c lay them out.

use super::Entry;

/// zipinfo's host names, by the host byte of "version made by"; a host past
/// the table reads as its last slot.
const HOSTS: [&str; 32] = [
    "fat", "ami", "vms", "unx", "cms", "atr", "hpf", "mac", "zzz", "cpm", "t20", "ntf", "qds",
    "aco", "vft", "mvs", "be ", "nsk", "ths", "osx", "???", "???", "???", "???", "???", "???",
    "???", "???", "???", "???", "ath", "???",
];
/// Hosts whose external attributes are a DOS attribute byte rather than a
/// Unix mode; VMS, Amiga and Theos render as Unix modes.
const DOS_HOSTS: [u8; 7] = [0, 4, 6, 11, 13, 14, 15];
const UNIX_TIME_HOSTS: [u8; 3] = [3, 6, 11];
const DOS_EXECUTABLE: [&[u8]; 5] = [b"com", b"exe", b"btm", b"cmd", b"bat"];
const DEFLATE_LEVELS: &[u8; 4] = b"NXFS";
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const VERBOSE_HEADER: &str = " Length   Method    Size  Cmpr    Date    Time   CRC-32   Name\n\
--------  ------  ------- ---- ---------- ----- --------  ----\n";
const VERBOSE_RULE: &str = "--------          -------  ---                            -------\n";
const SHORT_HEADER: &str = "  Length      Date    Time    Name\n\
---------  ---------- -----   ----\n";
const SHORT_RULE: &str = "---------                     -------\n";

/// What one zipinfo run prints.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Rows {
    None,
    Names,
    Short,
    Medium,
    Long,
}

/// zipinfo's letters, as the host's flags give them.
#[derive(Clone, Copy, Default)]
pub(super) struct Letters {
    pub(super) names: bool,
    pub(super) names_headers: bool,
    pub(super) long: bool,
    pub(super) medium: bool,
    pub(super) short: bool,
    pub(super) header: bool,
    pub(super) totals: bool,
}

/// zipinfo's -1/-2/-s/-m/-l/-h/-t interplay: -1 prints names alone, -2
/// names plus whichever of the header and totals was asked for; the row
/// formats default both on, except that naming members (or excluding some)
/// turns off the one not asked for; -h or -t alone prints just that unless
/// members are named. Info-ZIP takes the last row letter; the flag bag has
/// no order, so -1 beats -2 beats -l beats -m beats -s.
pub(super) fn layout(letters: Letters, filtered: bool) -> (Rows, bool, bool) {
    if letters.names {
        return (Rows::Names, false, false);
    }
    if letters.names_headers {
        return (Rows::Names, letters.header, letters.totals);
    }
    let rows = if letters.long {
        Rows::Long
    } else if letters.medium {
        Rows::Medium
    } else if letters.short || !(letters.header || letters.totals) || filtered {
        Rows::Short
    } else {
        return (Rows::None, letters.header, letters.totals);
    };
    (
        rows,
        !filtered || letters.header,
        !filtered || letters.totals,
    )
}

fn unix_attribs(mode: u32) -> String {
    let kind = match mode & 0o170000 {
        0o040000 => 'd',
        0o100000 => '-',
        0o120000 => 'l',
        0o060000 => 'b',
        0o020000 => 'c',
        0o010000 => 'p',
        0o140000 => 's',
        _ => '?',
    };
    let mut out = String::from(kind);
    for (shift, special, lower, upper) in [
        (6, 0o4000, 's', 'S'),
        (3, 0o2000, 's', 'S'),
        (0, 0o1000, 't', 'T'),
    ] {
        let bits = mode >> shift;
        out.push(if bits & 4 != 0 { 'r' } else { '-' });
        out.push(if bits & 2 != 0 { 'w' } else { '-' });
        out.push(match (bits & 1 != 0, mode & special != 0) {
            (true, true) => lower,
            (true, false) => 'x',
            (false, true) => upper,
            (false, false) => '-',
        });
    }
    out
}

fn dos_attribs(external: u32, name: &[u8]) -> String {
    let low = external & 0xFF;
    let mut out = *b".r.-...";
    out[2] = if low & 0x01 != 0 { b'-' } else { b'w' };
    out[5] = if low & 0x02 != 0 { b'h' } else { b'-' };
    out[6] = if low & 0x04 != 0 { b's' } else { b'-' };
    out[4] = if low & 0x20 != 0 { b'a' } else { b'-' };
    if low & 0x10 != 0 {
        out[0] = b'd';
        out[3] = b'x';
    } else {
        out[0] = b'-';
    }
    if low & 0x08 != 0 {
        out[0] = b'V';
    } else if let Some(dot) = name.iter().rposition(|&b| b == b'.') {
        let suffix = name[dot + 1..].to_ascii_lowercase();
        if DOS_EXECUTABLE.contains(&&suffix[..suffix.len().min(3)]) {
            out[3] = b'x';
        }
    }
    format!("{:<10}", String::from_utf8_lossy(&out))
}

fn attribs(entry: &Entry) -> String {
    let mode = entry.external >> 16;
    let host = entry.host();
    // A FAT host whose Unix bits merely restate its DOS attribute byte has
    // no mode of its own to show.
    let shadow = 0o400 | (u32::from(entry.external & 1 == 0) << 7) | ((entry.external & 0x10) << 2);
    let perms = if DOS_HOSTS.contains(&host) && (host != 0 || mode & 0o700 != shadow) {
        dos_attribs(entry.external, &entry.name)
    } else {
        unix_attribs(mode)
    };
    let version = entry.made_by & 0xFF;
    format!("{perms}  {}.{}", version / 10, version % 10)
}

fn method_text(entry: &Entry) -> String {
    let text = match entry.method {
        0 => "stor",
        1 => "shrk",
        2 => "re:1",
        3 => "re:2",
        4 => "re:3",
        5 => "re:4",
        6 => {
            let dictionary = if entry.flags & 2 != 0 { '8' } else { '4' };
            let trees = if entry.flags & 4 != 0 { '3' } else { '2' };
            return format!("i{dictionary}:{trees}");
        }
        7 => "tokn",
        8 | 9 => {
            let level = char::from(DEFLATE_LEVELS[usize::from(entry.flags >> 1) & 3]);
            return format!("{}{level}", if entry.method == 8 { "def" } else { "d64" });
        }
        10 => "dcli",
        12 => "bzp2",
        14 => "lzma",
        18 => "ters",
        19 => "lz77",
        97 => "wavp",
        98 => "ppmd",
        method => return format!("u{method:03}"),
    };
    text.to_owned()
}

fn list_method(entry: &Entry) -> String {
    let text = match entry.method {
        0 => "Stored",
        1 => "Shrunk",
        2 => "Reduce1",
        3 => "Reduce2",
        4 => "Reduce3",
        5 => "Reduce4",
        6 => "Implode",
        7 => "Token",
        8 | 9 => {
            let level = char::from(DEFLATE_LEVELS[usize::from(entry.flags >> 1) & 3]);
            return format!(
                "{}{level}",
                if entry.method == 8 { "Defl:" } else { "Def64" }
            );
        }
        10 => "ImplDCL",
        12 => "BZip2",
        14 => "LZMA",
        18 => "Terse",
        19 => "IBMLZ77",
        97 => "WavPack",
        98 => "PPMd",
        method => return format!("Unk:{method:03}"),
    };
    text.to_owned()
}

fn kind_flags(entry: &Entry) -> String {
    let text = entry.internal & 1 != 0;
    let first = match (entry.flags & 1 != 0, text) {
        (true, true) => 'T',
        (true, false) => 'B',
        (false, true) => 't',
        (false, false) => 'b',
    };
    let extra = entry.has_extra
        || (entry.external & 0x8000 != 0 && UNIX_TIME_HOSTS.contains(&entry.host()));
    let second = match (entry.flags & 8 != 0, extra) {
        (true, true) => 'X',
        (true, false) => 'l',
        (false, true) => 'x',
        (false, false) => '-',
    };
    format!("{first}{second}")
}

/// Compressed bytes as the listings count them: an encryption header is
/// not compressed data.
fn compressed(entry: &Entry) -> i128 {
    i128::from(entry.csize) - if entry.flags & 1 != 0 { 12 } else { 0 }
}

/// Info-ZIP's `ratio()`: tenths of a percent saved, rounded, signed.
pub(super) fn ratio(uncompressed: i128, compressed: i128) -> i128 {
    if uncompressed == 0 {
        return 0;
    }
    let (saved, sign) = if uncompressed >= compressed {
        (uncompressed - compressed, 1)
    } else {
        (compressed - uncompressed, -1)
    };
    let tenths = if uncompressed > 2_000_000 {
        let denom = uncompressed / 1000;
        (saved + (denom >> 1)) / denom
    } else {
        (1000 * saved + (uncompressed >> 1)) / uncompressed
    };
    sign * tenths
}

/// One `ls -l`-shaped zipinfo line: `Medium` adds the percent saved (C's
/// truncating `(ratio + 5) / 10`), `Long` the compressed size.
pub(super) fn row(entry: &Entry, rows: Rows, out: &mut Vec<u8>) {
    let host = HOSTS[usize::from(entry.host()).min(HOSTS.len() - 1)];
    let mut line = format!(
        "{} {host} {:>8} {}",
        attribs(entry),
        entry.size,
        kind_flags(entry)
    );
    match rows {
        Rows::Medium => {
            let percent = (ratio(i128::from(entry.size), compressed(entry)) + 5) / 10;
            line += &format!("{percent:>3}%");
        }
        Rows::Long => line += &format!(" {:>8}", entry.csize),
        _ => {}
    }
    let (year, month, day, hour, minute, _) = entry.stamp();
    let month = match month {
        1..=12 => MONTHS[usize::from(month) - 1].to_owned(),
        _ => format!("{month:03}"),
    };
    line += &format!(
        " {} {:02}-{month}-{day:02} {hour:02}:{minute:02} ",
        method_text(entry),
        year % 100
    );
    out.extend_from_slice(line.as_bytes());
    out.extend_from_slice(&entry.name);
    out.push(b'\n');
}

/// The `-h` lines, `between` them what UnZip says while opening the archive.
pub(super) fn header(archive: &[u8], between: &[u8], size: u64, entries: u64, out: &mut Vec<u8>) {
    out.extend_from_slice(b"Archive:  ");
    out.extend_from_slice(archive);
    out.push(b'\n');
    out.extend_from_slice(between);
    out.extend_from_slice(
        format!("Zip file size: {size} bytes, number of entries: {entries}\n").as_bytes(),
    );
}

/// The `-t` line over the listed rows.
pub(super) fn totals(entries: &[&Entry], out: &mut Vec<u8>) {
    let size: i128 = entries.iter().map(|e| i128::from(e.size)).sum();
    let packed: i128 = entries.iter().map(|e| compressed(e)).sum();
    let tenths = ratio(size, packed);
    let sign = if tenths < 0 { "-" } else { "" };
    let tenths = tenths.abs();
    let plural = if entries.len() == 1 { "" } else { "s" };
    out.extend_from_slice(
        format!(
            "{} file{plural}, {size} bytes uncompressed, {packed} bytes compressed:  {sign}{}.{}%\n",
            entries.len(),
            tenths / 10,
            tenths % 10
        )
        .as_bytes(),
    );
}

/// unzip's Cmpr column: the magnitude rounded, the sign printed apart, and
/// a magnitude of 100 bare.
fn saved(uncompressed: i128, compressed: i128) -> String {
    let tenths = ratio(uncompressed, compressed);
    let percent = (tenths.abs() + 5) / 10;
    if percent == 100 {
        return "100%".to_owned();
    }
    format!("{}{percent}%", if tenths < 0 { '-' } else { ' ' })
}

/// A comment as Info-ZIP prints it: up to a NUL, less CR and ^S, ESC as
/// `^[`, and a newline at the end.
pub(super) fn comment(raw: &[u8], out: &mut Vec<u8>) {
    let text = raw.split(|&b| b == 0).next().unwrap_or_default();
    let start = out.len();
    for &byte in text {
        match byte {
            b'\r' | 0x13 => {}
            0x1b => out.extend_from_slice(b"^["),
            _ => out.push(byte),
        }
    }
    if out.len() > start && out.last() != Some(&b'\n') {
        out.push(b'\n');
    }
}

/// `unzip -l`, or with `verbose` the `-v` table: each entry's size, stamp
/// and name, `-v` adding the method, compressed size, percent saved and
/// CRC-32, each with its comment, written as stored, and a totals line;
/// `quiet` once drops the comments, twice the header and totals too.
pub(super) fn list(entries: &[&Entry], quiet: u8, verbose: bool, out: &mut Vec<u8>) {
    let header = if verbose {
        VERBOSE_HEADER
    } else {
        SHORT_HEADER
    };
    if quiet < 2 {
        out.extend_from_slice(header.as_bytes());
    }
    for entry in entries {
        let (year, month, day, hour, minute, _) = entry.stamp();
        let stamp = format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}");
        let packed = compressed(entry);
        let row = if verbose {
            format!(
                "{:>8}  {:<7}{packed:>8} {:>4} {stamp} {:08x}  ",
                entry.size,
                list_method(entry),
                saved(i128::from(entry.size), packed),
                entry.crc
            )
        } else {
            format!("{:>9}  {stamp}   ", entry.size)
        };
        out.extend_from_slice(row.as_bytes());
        out.extend_from_slice(&entry.name);
        out.push(b'\n');
        if quiet == 0 {
            comment(&entry.comment, out);
        }
    }
    if quiet > 1 {
        return;
    }
    let size: i128 = entries.iter().map(|e| i128::from(e.size)).sum();
    let packed: i128 = entries.iter().map(|e| compressed(e)).sum();
    let plural = if entries.len() == 1 { "" } else { "s" };
    let totals = if verbose {
        format!(
            "{VERBOSE_RULE}{size:>8}         {packed:>8} {:>4}{:28}",
            saved(size, packed),
            ""
        )
    } else {
        format!("{SHORT_RULE}{size:>9}{:21}", "")
    };
    out.extend_from_slice(format!("{totals}{} file{plural}\n", entries.len()).as_bytes());
}
