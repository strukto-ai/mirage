//! iconv as glibc 2.41 converts, a chunk at a time over every input in
//! order. Deliberate divergence: with no `-f` or `-t` the charset is
//! UTF-8, where glibc takes the locale's (ASCII under `LC_ALL=C`); the
//! `//TRANSLIT` and `//IGNORE` suffixes are refused, as glibc's
//! transliteration follows its own locale tables.

pub(crate) mod table;
#[cfg(test)]
mod tests;

use std::cmp::Ordering;
use std::sync::OnceLock;

use encoding_rs::Encoding;
use serde::Deserialize;

use self::table::{High, Multibyte, Single, Spec, Step};
use crate::{Stream, StreamError, parse_config};

/// The most output one step writes before it yields.
const WINDOW: usize = 64 * 1024;
const HINT: &str = "Try `iconv --help' or `iconv --usage' for more information.";
const INCOMPLETE: &[u8] = b"iconv: incomplete character or shift sequence at end of buffer\n";

/// A charset as `-f` and `-t` select it.
#[derive(Clone, Copy)]
enum Charset {
    Utf8,
    /// UTF-16 and UCS-2 (no surrogate pairs): little-endian, big-endian,
    /// or None for the byte order a BOM names, little-endian without one.
    Utf16 {
        little: Option<bool>,
        pairs: bool,
    },
    /// UTF-32 and UCS-4 (not `strict`: any value up to 0x7FFFFFFF, as
    /// glibc's internal form holds it).
    Utf32 {
        little: Option<bool>,
        strict: bool,
    },
    Latin1,
    Ascii,
    Single(&'static Encoding, High),
    Multi(&'static Spec),
}

const fn utf16(little: Option<bool>) -> Charset {
    Charset::Utf16 {
        little,
        pairs: true,
    }
}

const fn ucs2(little: bool) -> Charset {
    Charset::Utf16 {
        little: Some(little),
        pairs: false,
    }
}

const fn utf32(little: Option<bool>, strict: bool) -> Charset {
    Charset::Utf32 { little, strict }
}

const fn single(encoding: &'static Encoding, high: High) -> Charset {
    Charset::Single(encoding, high)
}

/// Every charset mirage converts and each name glibc lists for it, but
/// those with a slash inside.
const CHARSETS: &[(Charset, &str)] = &[
    (Charset::Utf8, "UTF-8 UTF8 ISO-IR-193 OSF05010001"),
    (utf16(None), "UTF-16 UTF16"),
    (utf16(Some(true)), "UTF-16LE UTF16LE"),
    (utf16(Some(false)), "UTF-16BE UTF16BE"),
    (
        ucs2(true),
        "UCS-2 UCS2 UCS-2LE OSF00010100 OSF00010101 OSF00010102 UNICODELITTLE",
    ),
    (ucs2(false), "UCS-2BE UNICODEBIG"),
    (utf32(None, true), "UTF-32 UTF32"),
    (utf32(Some(true), true), "UTF-32LE UTF32LE"),
    (utf32(Some(false), true), "UTF-32BE UTF32BE"),
    (utf32(Some(true), false), "UCS-4LE"),
    (
        utf32(Some(false), false),
        "UCS-4 UCS4 UCS-4BE ISO-10646 10646-1:1993 CSUCS4 OSF00010104 OSF00010105 OSF00010106",
    ),
    (
        Charset::Latin1,
        "ISO-8859-1 ISO8859-1 ISO88591 ISO_8859-1 ISO_8859-1:1987 ISO-IR-100 LATIN1 L1 CP819 \
         IBM819 CSISOLATIN1 8859_1 OSF00010001",
    ),
    (
        Charset::Ascii,
        "ANSI_X3.4-1968 ANSI_X3.4-1986 ANSI_X3.4 ASCII US-ASCII ISO646-US ISO_646.IRV:1991 \
         ISO-IR-6 US CP367 IBM367 CSASCII CP891 CP903 CSIBM891 CSIBM903 IBM891 IBM903 \
         OSF00010020 OSF1002037B OSF10020387",
    ),
    (
        Charset::Multi(&table::GBK),
        "GBK GB13000 CP936 MS936 WINDOWS-936",
    ),
    (
        Charset::Multi(&table::EUC_CN),
        "EUC-CN EUCCN GB2312 CSGB2312 CN-GB",
    ),
    (Charset::Multi(&table::GB18030), "GB18030"),
    (
        Charset::Multi(&table::EUC_KR),
        "EUC-KR EUCKR CSEUCKR OSF0004000A",
    ),
    (
        Charset::Multi(&table::SJIS),
        "SJIS SHIFT-JIS SHIFT_JIS MS_KANJI CSSHIFTJIS",
    ),
    (
        Charset::Multi(&table::EUC_JP),
        "EUC-JP EUCJP UJIS CSEUCPKDFMTJAPANESE OSF00030010",
    ),
    (
        single(encoding_rs::ISO_8859_2, High::Whatwg),
        "ISO-8859-2 ISO8859-2 ISO88592 ISO_8859-2 ISO_8859-2:1987 ISO-IR-101 LATIN2 L2 \
         CSISOLATIN2 8859_2 CP912 IBM912 OSF00010002",
    ),
    (
        single(encoding_rs::ISO_8859_3, High::Whatwg),
        "ISO-8859-3 ISO8859-3 ISO88593 ISO_8859-3 ISO_8859-3:1988 ISO-IR-109 LATIN3 L3 \
         CSISOLATIN3 8859_3 OSF00010003",
    ),
    (
        single(encoding_rs::ISO_8859_4, High::Whatwg),
        "ISO-8859-4 ISO8859-4 ISO88594 ISO_8859-4 ISO_8859-4:1988 ISO-IR-110 LATIN4 L4 \
         CSISOLATIN4 8859_4 OSF00010004",
    ),
    (
        single(encoding_rs::ISO_8859_5, High::Whatwg),
        "ISO-8859-5 ISO8859-5 ISO88595 ISO_8859-5 ISO_8859-5:1988 ISO-IR-144 CYRILLIC \
         CSISOLATINCYRILLIC 8859_5 CP915 IBM915 OSF00010005",
    ),
    (
        single(encoding_rs::ISO_8859_6, High::Whatwg),
        "ISO-8859-6 ISO8859-6 ISO88596 ISO_8859-6 ISO_8859-6:1987 ISO-IR-127 ARABIC ASMO-708 \
         ECMA-114 CSISOLATINARABIC 8859_6 CP1089 IBM1089 OSF00010006",
    ),
    (
        single(encoding_rs::ISO_8859_7, High::Whatwg),
        "ISO-8859-7 ISO8859-7 ISO88597 ISO_8859-7 ISO_8859-7:1987 ISO_8859-7:2003 ISO-IR-126 \
         GREEK GREEK8 ECMA-118 ELOT_928 CSISOLATINGREEK 8859_7 CP813 IBM813 OSF00010007",
    ),
    (
        single(encoding_rs::ISO_8859_8, High::Whatwg),
        "ISO-8859-8 ISO8859-8 ISO88598 ISO_8859-8 ISO_8859-8:1988 ISO-IR-138 HEBREW \
         CSISOLATINHEBREW 8859_8 CP916 IBM916 OSF00010008",
    ),
    (
        single(encoding_rs::WINDOWS_1254, High::Controls),
        "ISO-8859-9 ISO8859-9 ISO88599 ISO_8859-9 ISO_8859-9:1989 ISO-IR-148 LATIN5 L5 \
         CSISOLATIN5 ECMA-128 TS-5881 8859_9 CP920 IBM920 OSF00010009",
    ),
    (
        single(encoding_rs::ISO_8859_10, High::Whatwg),
        "ISO-8859-10 ISO8859-10 ISO885910 ISO_8859-10 ISO_8859-10:1992 ISO-IR-157 LATIN6 L6 \
         CSISOLATIN6 OSF0001000A",
    ),
    (
        single(encoding_rs::WINDOWS_874, High::Controls),
        "ISO-8859-11 ISO8859-11 ISO885911 THAI8 HP-THAI8 HPTHAI8",
    ),
    (
        single(encoding_rs::ISO_8859_13, High::Whatwg),
        "ISO-8859-13 ISO8859-13 ISO885913 ISO-IR-179 LATIN7 L7 BALTIC CP921 IBM921 IBM-921 \
         CSIBM921",
    ),
    (
        single(encoding_rs::ISO_8859_14, High::Whatwg),
        "ISO-8859-14 ISO8859-14 ISO885914 ISO_8859-14 ISO_8859-14:1998 ISO-IR-199 LATIN8 L8 \
         ISO-CELTIC",
    ),
    (
        single(encoding_rs::ISO_8859_15, High::Whatwg),
        "ISO-8859-15 ISO8859-15 ISO885915 ISO_8859-15 ISO_8859-15:1998 ISO-IR-203 LATIN-9 \
         LATIN9",
    ),
    (
        single(encoding_rs::ISO_8859_16, High::Whatwg),
        "ISO-8859-16 ISO8859-16 ISO885916 ISO_8859-16 ISO_8859-16:2001 ISO-IR-226 LATIN10 L10",
    ),
    (
        single(encoding_rs::WINDOWS_874, High::Tis),
        "TIS-620 TIS620 TIS620-0 TIS620.2529-1 TIS620.2533-0 ISO-IR-166",
    ),
    (
        single(encoding_rs::KOI8_R, High::Whatwg),
        "KOI8-R KOI8R CSKOI8R",
    ),
    (single(encoding_rs::KOI8_U, High::Koi8u), "KOI8-U KOI8U"),
    (
        single(encoding_rs::IBM866, High::Whatwg),
        "IBM866 CP866 866 CSIBM866",
    ),
    (
        single(encoding_rs::WINDOWS_874, High::Holes),
        "CP874 WINDOWS-874 IBM874 874",
    ),
    (
        single(encoding_rs::WINDOWS_1250, High::Holes),
        "CP1250 WINDOWS-1250 MS-EE",
    ),
    (
        single(encoding_rs::WINDOWS_1251, High::Holes),
        "CP1251 WINDOWS-1251 MS-CYRL",
    ),
    (
        single(encoding_rs::WINDOWS_1252, High::Holes),
        "CP1252 WINDOWS-1252 MS-ANSI",
    ),
    (
        single(encoding_rs::WINDOWS_1253, High::Holes),
        "CP1253 WINDOWS-1253 MS-GREEK",
    ),
    (
        single(encoding_rs::WINDOWS_1254, High::Holes),
        "CP1254 WINDOWS-1254 MS-TURK",
    ),
    (
        single(encoding_rs::WINDOWS_1256, High::Holes),
        "CP1256 WINDOWS-1256 MS-ARAB",
    ),
    (
        single(encoding_rs::WINDOWS_1257, High::Holes),
        "CP1257 WINDOWS-1257 WINBALTRIM",
    ),
];

/// Each charset's tables, built on first use and kept for the process.
enum Tables {
    Single(Single),
    Multi(Multibyte),
}

static TABLES: [OnceLock<Tables>; CHARSETS.len()] = [const { OnceLock::new() }; CHARSETS.len()];

fn tables(index: usize) -> &'static Tables {
    TABLES[index].get_or_init(|| match CHARSETS[index].0 {
        Charset::Single(encoding, high) => Tables::Single(table::single(encoding, high)),
        Charset::Multi(spec) => Tables::Multi(spec.build()),
        _ => unreachable!("only table charsets have tables"),
    })
}

/// The name glibc looks a typed charset up by, None when it has none.
///
/// glibc drops the blanks, commas and slashes that end a name, then every
/// byte but an ASCII letter, a digit, `_-.,:` and `/`, and reads the rest
/// without regard to case and with a final slash dropped: `s(jis)//` and
/// `SJIS/!` are SJIS, while `S_JIS`, `/SJIS` and `ſjis` are not. A name
/// with nothing left is the default charset. A second slash starts a
/// suffix, which mirage refuses.
fn charset_key(name: &[u8]) -> Option<Vec<u8>> {
    let end = name
        .iter()
        .rposition(|b| !b" \t\n\x0b\x0c\r,/".contains(b))
        .map_or(0, |at| at + 1);
    let code = &name[..end];
    if code.iter().filter(|&&b| b == b'/').count() > 1 {
        return None;
    }
    let mut key: Vec<u8> = code
        .iter()
        .filter(|b| b.is_ascii_alphanumeric() || b"_.,:/-".contains(b))
        .map(u8::to_ascii_uppercase)
        .collect();
    if key.last() == Some(&b'/') {
        key.pop();
    }
    if key.contains(&b'/') {
        return None;
    }
    Some(if key.is_empty() {
        b"UTF-8".to_vec()
    } else {
        key
    })
}

fn lookup(name: &[u8]) -> Option<usize> {
    let key = charset_key(name)?;
    CHARSETS
        .iter()
        .position(|(_, names)| names.split(' ').any(|known| known.as_bytes() == key))
}

/// glibc's `strverscmp`: text compares byte by byte, but where the first
/// difference falls in a run of digits the whole runs compare as numbers,
/// and a run that starts with `0` is a fraction sorting before every whole
/// number (`000 < 00 < 01 < 010 < 09 < 0 < 1 < 9 < 10`).
fn strverscmp(a: &[u8], b: &[u8]) -> Ordering {
    let split = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (left, right) = (a.get(split), b.get(split));
    let head = split
        - a[..split]
            .iter()
            .rev()
            .take_while(|c| c.is_ascii_digit())
            .count();
    let run = |s: &[u8]| s[head..].iter().take_while(|c| c.is_ascii_digit()).count();
    let (run_a, run_b) = (run(a), run(b));
    if run_a == 0 || run_b == 0 {
        return left.cmp(&right);
    }
    let fraction_a = run_a > 1 && a[head] == b'0';
    let fraction_b = run_b > 1 && b[head] == b'0';
    if fraction_a != fraction_b {
        return if fraction_a {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    if !fraction_a && run_a != run_b {
        return run_a.cmp(&run_b);
    }
    let digit = |c: Option<&u8>| c.is_some_and(u8::is_ascii_digit);
    if fraction_a && a[head..split].iter().all(|&c| c == b'0') && digit(left) != digit(right) {
        return if digit(left) {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    left.cmp(&right)
}

/// What `iconv -l` prints: one name per line with the `//` that ends an
/// empty suffix, the lines in `strverscmp` order (`US-ASCII//` before
/// `US//`), as glibc lists to a pipe.
fn list_text() -> Vec<u8> {
    let mut names: Vec<String> = CHARSETS
        .iter()
        .flat_map(|(_, names)| names.split(' '))
        .map(|name| format!("{name}//\n"))
        .collect();
    names.sort_by(|a, b| strverscmp(a.as_bytes(), b.as_bytes()));
    names.concat().into_bytes()
}

/// A refusal's words as a byte string of one character per byte, which
/// the hosts turn back into the bytes.
fn byte_text(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

fn unsupported(from: &[u8], to: &[u8], from_ok: bool, to_ok: bool) -> StreamError {
    let quoted = |name: &[u8]| [b"`", name, b"'"].concat();
    let line = match (from_ok, to_ok) {
        (false, false) => [
            b"iconv: conversions from ".as_slice(),
            &quoted(from),
            b" and to ",
            &quoted(to),
            b" are not supported",
        ]
        .concat(),
        (false, true) => [
            b"iconv: conversion from ".as_slice(),
            &quoted(from),
            b" is not supported",
        ]
        .concat(),
        _ => [
            b"iconv: conversion to ".as_slice(),
            &quoted(to),
            b" is not supported",
        ]
        .concat(),
    };
    StreamError::new(format!("{}\n{HINT}", byte_text(&line)))
}

/// The reading side of a charset.
enum Decoder {
    Utf8,
    Utf16 { pairs: bool },
    Utf32 { strict: bool },
    Latin1,
    Ascii,
    Single(&'static Single),
    Multi(&'static Multibyte),
}

/// The writing side, shared by every input: a UTF-16 or UTF-32 output
/// gets its BOM once, as the first character reaches it, whether or not
/// that character converts.
struct Encoder {
    target: Decoder,
    little: bool,
    bom: &'static [u8],
}

fn utf8_char(raw: &[u8], at: usize) -> Step {
    let lead = raw[at];
    let (length, low, high) = match lead {
        ..0x80 => return Step::Char(u32::from(lead), 1),
        0xC2..=0xDF => (2, 0x80, 0xBF),
        0xE0 => (3, 0xA0, 0xBF),
        0xED => (3, 0x80, 0x9F),
        0xE1..=0xEF => (3, 0x80, 0xBF),
        0xF0 => (4, 0x90, 0xBF),
        0xF1..=0xF7 => (4, 0x80, 0xBF),
        0xF8 => (5, 0x88, 0xBF),
        0xF9..=0xFB => (5, 0x80, 0xBF),
        0xFC => (6, 0x84, 0xBF),
        0xFD => (6, 0x80, 0xBF),
        _ => return Step::Illegal(1),
    };
    let mut cp = u32::from(lead) & (0x7F >> length);
    for i in 1..length {
        let Some(&byte) = raw.get(at + i) else {
            return Step::Cut;
        };
        let (low, high) = if i == 1 { (low, high) } else { (0x80, 0xBF) };
        if !(low..=high).contains(&byte) {
            return Step::Illegal(1);
        }
        cp = cp << 6 | u32::from(byte & 0x3F);
    }
    Step::Char(cp, length)
}

fn unit(raw: &[u8], at: usize, width: usize, little: bool) -> Option<u32> {
    let bytes = raw.get(at..at + width)?;
    let fold = |cp: u32, &b: &u8| cp << 8 | u32::from(b);
    Some(if little {
        bytes.iter().rev().fold(0, fold)
    } else {
        bytes.iter().fold(0, fold)
    })
}

const SURROGATES: std::ops::RangeInclusive<u32> = 0xD800..=0xDFFF;

impl Decoder {
    /// One character at `at`; UTF-16 and UTF-32 read in `little` order.
    fn step(&self, raw: &[u8], at: usize, little: bool) -> Step {
        match self {
            Decoder::Utf8 => utf8_char(raw, at),
            Decoder::Utf16 { pairs } => {
                let Some(first) = unit(raw, at, 2, little) else {
                    return Step::Cut;
                };
                match first {
                    0xD800..=0xDBFF if *pairs => match unit(raw, at + 2, 2, little) {
                        None => Step::Cut,
                        Some(second @ 0xDC00..=0xDFFF) => {
                            Step::Char(0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00), 4)
                        }
                        Some(_) => Step::Illegal(2),
                    },
                    0xD800..=0xDFFF => Step::Illegal(2),
                    _ => Step::Char(first, 2),
                }
            }
            Decoder::Utf32 { strict } => match unit(raw, at, 4, little) {
                None => Step::Cut,
                Some(cp) if *strict && (cp > 0x10FFFF || SURROGATES.contains(&cp)) => {
                    Step::Illegal(4)
                }
                Some(0x8000_0000..) => Step::Illegal(4),
                Some(cp) => Step::Char(cp, 4),
            },
            Decoder::Latin1 => Step::Char(u32::from(raw[at]), 1),
            Decoder::Ascii if raw[at] < 0x80 => Step::Char(u32::from(raw[at]), 1),
            Decoder::Ascii => Step::Illegal(1),
            Decoder::Single(table) => match table.decode[usize::from(raw[at])] {
                u32::MAX => Step::Illegal(1),
                cp => Step::Char(cp, 1),
            },
            Decoder::Multi(table) => table.step(raw, at),
        }
    }

    /// Whether every ASCII byte reads (as a source) or writes (as a
    /// target) as itself, so a run of them is copied whole.
    fn ascii(&self, source: bool) -> bool {
        match self {
            Decoder::Utf16 { .. } | Decoder::Utf32 { .. } => false,
            Decoder::Multi(table) => !source || table.grammar != table::Grammar::Sjis,
            _ => true,
        }
    }

    /// The bytes a BOM takes and the order it names, None while fewer
    /// than a unit have come, for a UTF-16 or UTF-32 input that has none
    /// set.
    fn bom(&self, raw: &[u8]) -> Option<(usize, bool)> {
        let (width, little, big): (usize, &[u8], &[u8]) = match self {
            Decoder::Utf16 { .. } => (2, b"\xff\xfe", b"\xfe\xff"),
            _ => (4, b"\xff\xfe\0\0", b"\0\0\xfe\xff"),
        };
        let head = raw.get(..width)?;
        Some(if head == little {
            (width, true)
        } else if head == big {
            (width, false)
        } else {
            (0, true)
        })
    }
}

impl Encoder {
    /// Write one character, false when the charset cannot hold it.
    fn put(&mut self, cp: u32, out: &mut Vec<u8>) -> bool {
        out.extend_from_slice(std::mem::take(&mut self.bom));
        let units = |out: &mut Vec<u8>, units: &[u32], width: usize, little: bool| {
            for &unit in units {
                let bytes = unit.to_be_bytes();
                let bytes = &bytes[4 - width..];
                if little {
                    out.extend(bytes.iter().rev());
                } else {
                    out.extend_from_slice(bytes);
                }
            }
        };
        match &self.target {
            Decoder::Utf8 => {
                if SURROGATES.contains(&cp) {
                    return false;
                }
                let length = match cp {
                    ..0x80 => {
                        out.push(cp as u8);
                        return true;
                    }
                    0x80..0x800 => 2,
                    0x800..0x10000 => 3,
                    0x10000..0x20_0000 => 4,
                    0x20_0000..0x400_0000 => 5,
                    _ => 6,
                };
                out.push((0xFF00u32 >> length) as u8 | (cp >> (6 * (length - 1))) as u8);
                for i in (0..length - 1).rev() {
                    out.push(0x80 | (cp >> (6 * i)) as u8 & 0x3F);
                }
            }
            Decoder::Utf16 { pairs } => match cp {
                0xD800..=0xDFFF | 0x11_0000.. => return false,
                0x10000.. if !pairs => return false,
                0x10000.. => {
                    let cp = cp - 0x10000;
                    units(
                        out,
                        &[0xD800 | cp >> 10, 0xDC00 | cp & 0x3FF],
                        2,
                        self.little,
                    );
                }
                _ => units(out, &[cp], 2, self.little),
            },
            Decoder::Utf32 { strict } => {
                if *strict && (cp > 0x10FFFF || SURROGATES.contains(&cp)) {
                    return false;
                }
                units(out, &[cp], 4, self.little);
            }
            Decoder::Latin1 | Decoder::Ascii => {
                let limit = if matches!(self.target, Decoder::Ascii) {
                    0x80
                } else {
                    0x100
                };
                if cp >= limit {
                    return false;
                }
                out.push(cp as u8);
            }
            Decoder::Single(table) => match table.reverse.get(cp) {
                Some(byte) => out.push(byte as u8),
                None => return false,
            },
            Decoder::Multi(table) => match table.reverse.get(cp) {
                Some(seq) => table::put_sequence(seq, out),
                None if table.grammar == table::Grammar::Gb18030
                    && (0x10000..=0x10FFFF).contains(&cp) =>
                {
                    table::put_sequence(Multibyte::supplementary(cp), out);
                }
                None => return false,
            },
        }
        true
    }
}

fn sides(index: usize) -> (Decoder, Option<bool>) {
    match CHARSETS[index].0 {
        Charset::Utf8 => (Decoder::Utf8, None),
        Charset::Utf16 { little, pairs } => (Decoder::Utf16 { pairs }, little),
        Charset::Utf32 { little, strict } => (Decoder::Utf32 { strict }, little),
        Charset::Latin1 => (Decoder::Latin1, None),
        Charset::Ascii => (Decoder::Ascii, None),
        Charset::Single(..) | Charset::Multi(_) => match tables(index) {
            Tables::Single(table) => (Decoder::Single(table), None),
            Tables::Multi(table) => (Decoder::Multi(table), None),
        },
    }
}

#[derive(Deserialize)]
struct Config {
    #[serde(default, deserialize_with = "crate::latin1")]
    from: Vec<u8>,
    #[serde(default, deserialize_with = "crate::latin1")]
    to: Vec<u8>,
    /// `-c`.
    #[serde(default)]
    omit: bool,
    /// How many inputs the run reads, one after another.
    #[serde(default)]
    inputs: usize,
    /// `-l`.
    #[serde(default)]
    list: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    if config.list {
        return Ok(Box::new(List));
    }
    let (Some(from), Some(to)) = (lookup(&config.from), lookup(&config.to)) else {
        let (from, to) = (&config.from, &config.to);
        return Err(unsupported(
            from,
            to,
            lookup(from).is_some(),
            lookup(to).is_some(),
        ));
    };
    let (decoder, order) = sides(from);
    let (target, out_order) = sides(to);
    let bom: &[u8] = match CHARSETS[to].0 {
        Charset::Utf16 { little: None, .. } => b"\xff\xfe",
        Charset::Utf32 { little: None, .. } => b"\xff\xfe\0\0",
        _ => b"",
    };
    let ascii = decoder.ascii(true) && target.ascii(false);
    let boms = matches!(
        CHARSETS[from].0,
        Charset::Utf16 { little: None, .. } | Charset::Utf32 { little: None, .. }
    );
    Ok(Box::new(Iconv {
        little: if boms {
            None
        } else {
            Some(order.unwrap_or(true))
        },
        quiet: matches!(
            CHARSETS[from].0,
            Charset::Utf32 { strict: false, .. }
                | Charset::Utf16 {
                    little: Some(false),
                    pairs: false
                }
        ),
        decoder,
        encoder: Encoder {
            target,
            little: out_order.unwrap_or(true),
            bom,
        },
        ascii,
        omit: config.omit,
        inputs: config.inputs,
        current: 0,
        held: Vec::new(),
        start: 0,
        base: 0,
        ended: false,
        more: false,
        stopped: false,
        status: 0,
        stderr: Vec::new(),
    }))
}

/// `iconv -l`.
struct List;

impl Stream for List {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.extend(list_text());
        Ok(())
    }
}

/// One conversion over the run's inputs, read one after another. Each
/// input's positions count from its first byte; an illegal sequence ends
/// the run unless `-c` drops it, an incomplete one at an input's end is
/// reported and the next input read. The byte order a BOM names is set
/// once, by the first input with a whole unit, as glibc keeps it for the
/// whole run.
struct Iconv {
    decoder: Decoder,
    encoder: Encoder,
    /// The order a UTF-16 or UTF-32 input reads in, None until set.
    little: Option<bool>,
    /// The source is UCS-4 or UCS-2BE, whose refused sequences glibc drops
    /// under `-c` without counting them, so they leave the status 0
    /// (measured; UCS-2's little-endian reader counts them).
    quiet: bool,
    /// ASCII bytes read and write as themselves.
    ascii: bool,
    omit: bool,
    inputs: usize,
    current: usize,
    /// The current input's bytes from `start` not yet converted.
    held: Vec<u8>,
    start: usize,
    /// The position of `held[start]` in the input.
    base: u64,
    ended: bool,
    /// The last step stopped at a full window.
    more: bool,
    stopped: bool,
    status: i32,
    stderr: Vec<u8>,
}

fn ascii_run(raw: &[u8]) -> usize {
    let mut at = 0;
    while let Some(word) = raw.get(at..at + 8) {
        let word = u64::from_ne_bytes(word.try_into().unwrap_or_default());
        if word & 0x8080_8080_8080_8080 != 0 {
            break;
        }
        at += 8;
    }
    at + raw[at..].iter().take_while(|b| b.is_ascii()).count()
}

impl Iconv {
    /// Convert from the start of `raw` up to a full window, an incomplete
    /// character or its end; the bytes taken.
    fn run(&mut self, raw: &[u8], out: &mut Vec<u8>) -> Result<usize, StreamError> {
        let limit = out.len() + WINDOW;
        let mut at = 0;
        let little = match self.little {
            Some(little) => little,
            None => match self.decoder.bom(raw) {
                Some((skip, little)) => {
                    self.little = Some(little);
                    at = skip;
                    little
                }
                None => return Ok(0),
            },
        };
        self.more = false;
        while at < raw.len() {
            if out.len() >= limit {
                self.more = true;
                break;
            }
            if self.ascii {
                let run = ascii_run(&raw[at..]).min(limit - out.len());
                out.extend_from_slice(&raw[at..at + run]);
                at += run;
                if at == raw.len() || out.len() >= limit {
                    continue;
                }
            }
            let taken = match self.decoder.step(raw, at, little) {
                Step::Cut => break,
                Step::Char(cp, taken) if self.encoder.put(cp, out) => taken,
                step => {
                    if !self.omit {
                        self.stopped = true;
                        let position = self.base + at as u64;
                        return Err(StreamError::new(format!(
                            "iconv: illegal input sequence at position {position}"
                        )));
                    }
                    if !(self.quiet && matches!(step, Step::Illegal(_))) {
                        self.status = 1;
                    }
                    match step {
                        Step::Char(_, taken) | Step::Illegal(taken) => taken,
                        Step::Cut => unreachable!(),
                    }
                }
            };
            at += taken;
        }
        Ok(at)
    }

    /// Take `input` into the current input and convert what a window holds.
    fn step(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.start == self.held.len() {
            self.held.clear();
            self.start = 0;
            let used = self.run(input, out)?;
            self.base += used as u64;
            self.held.extend_from_slice(&input[used..]);
            return Ok(());
        }
        if self.start > 0 && !input.is_empty() {
            self.held.drain(..self.start);
            self.start = 0;
        }
        self.held.extend_from_slice(input);
        let held = std::mem::take(&mut self.held);
        let used = self.run(&held[self.start..], out)?;
        self.held = held;
        self.start += used;
        self.base += used as u64;
        Ok(())
    }

    /// The current input has ended and been converted: report a character
    /// it ends inside of, and go on to the next.
    fn close_input(&mut self) {
        if self.start < self.held.len() {
            self.stderr.extend_from_slice(INCOMPLETE);
            self.status = 1;
        }
        self.held.clear();
        self.start = 0;
        self.base = 0;
        self.ended = false;
        self.current += 1;
    }
}

impl Stream for Iconv {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(self.current, input, out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        while self.current < self.inputs && !self.stopped {
            self.end_input(self.current, out)?;
            while self.more {
                self.drain(out)?;
            }
        }
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        (!self.stopped && !self.more && !self.ended && self.current < self.inputs)
            .then_some(self.current)
    }

    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if self.stopped {
            return Ok(());
        }
        if index != self.current || self.more {
            return Err(StreamError::new("iconv input out of order"));
        }
        self.step(input, out)
    }

    fn end_input(&mut self, index: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.stopped || index != self.current {
            return Ok(());
        }
        self.ended = true;
        self.drain(out)
    }

    fn busy(&self) -> bool {
        self.more
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(&[], out)?;
        if self.ended && !self.more {
            self.close_input();
        }
        Ok(())
    }

    fn cancel(&mut self) -> bool {
        self.stopped = true;
        false
    }

    fn status(&self) -> i32 {
        self.status
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}
