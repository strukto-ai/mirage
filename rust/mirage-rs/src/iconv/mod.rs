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

use self::table::{Grammar, High, Multibyte, Single, Spec, Step};
use crate::{Stream, StreamError, parse_config};

/// The most output one step writes before it yields.
const WINDOW: usize = 64 * 1024;
const HINT: &str = "Try `iconv --help' or `iconv --usage' for more information.";
const INCOMPLETE: &[u8] = b"iconv: incomplete character or shift sequence at end of buffer\n";

/// Each name glibc lists for a charset mirage converts, but those with a
/// slash inside: a charset a line, the name `charset` knows it by first.
const NAMES: &str = "\
UTF-8 UTF8 ISO-IR-193 OSF05010001
UTF-16 UTF16
UTF-16LE UTF16LE
UTF-16BE UTF16BE
UCS-2 UCS2 UCS-2LE OSF00010100 OSF00010101 OSF00010102 UNICODELITTLE
UCS-2BE UNICODEBIG
UTF-32 UTF32
UTF-32LE UTF32LE
UTF-32BE UTF32BE
UCS-4LE
UCS-4 UCS4 UCS-4BE ISO-10646 10646-1:1993 CSUCS4 OSF00010104 OSF00010105 OSF00010106
ISO-8859-1 ISO8859-1 ISO88591 ISO_8859-1 ISO_8859-1:1987 ISO-IR-100 LATIN1 L1 CP819 IBM819 CSISOLATIN1 8859_1 OSF00010001
ANSI_X3.4-1968 ANSI_X3.4-1986 ANSI_X3.4 ASCII US-ASCII ISO646-US ISO_646.IRV:1991 ISO-IR-6 US CP367 IBM367 CSASCII CP891 CP903 CSIBM891 CSIBM903 IBM891 IBM903 OSF00010020 OSF1002037B OSF10020387
GBK GB13000 CP936 MS936 WINDOWS-936
EUC-CN EUCCN GB2312 CSGB2312 CN-GB
GB18030
EUC-KR EUCKR CSEUCKR OSF0004000A
SJIS SHIFT-JIS SHIFT_JIS MS_KANJI CSSHIFTJIS
EUC-JP EUCJP UJIS CSEUCPKDFMTJAPANESE OSF00030010
ISO-8859-2 ISO8859-2 ISO88592 ISO_8859-2 ISO_8859-2:1987 ISO-IR-101 LATIN2 L2 CSISOLATIN2 8859_2 CP912 IBM912 OSF00010002
ISO-8859-3 ISO8859-3 ISO88593 ISO_8859-3 ISO_8859-3:1988 ISO-IR-109 LATIN3 L3 CSISOLATIN3 8859_3 OSF00010003
ISO-8859-4 ISO8859-4 ISO88594 ISO_8859-4 ISO_8859-4:1988 ISO-IR-110 LATIN4 L4 CSISOLATIN4 8859_4 OSF00010004
ISO-8859-5 ISO8859-5 ISO88595 ISO_8859-5 ISO_8859-5:1988 ISO-IR-144 CYRILLIC CSISOLATINCYRILLIC 8859_5 CP915 IBM915 OSF00010005
ISO-8859-6 ISO8859-6 ISO88596 ISO_8859-6 ISO_8859-6:1987 ISO-IR-127 ARABIC ASMO-708 ECMA-114 CSISOLATINARABIC 8859_6 CP1089 IBM1089 OSF00010006
ISO-8859-7 ISO8859-7 ISO88597 ISO_8859-7 ISO_8859-7:1987 ISO_8859-7:2003 ISO-IR-126 GREEK GREEK8 ECMA-118 ELOT_928 CSISOLATINGREEK 8859_7 CP813 IBM813 OSF00010007
ISO-8859-8 ISO8859-8 ISO88598 ISO_8859-8 ISO_8859-8:1988 ISO-IR-138 HEBREW CSISOLATINHEBREW 8859_8 CP916 IBM916 OSF00010008
ISO-8859-9 ISO8859-9 ISO88599 ISO_8859-9 ISO_8859-9:1989 ISO-IR-148 LATIN5 L5 CSISOLATIN5 ECMA-128 TS-5881 8859_9 CP920 IBM920 OSF00010009
ISO-8859-10 ISO8859-10 ISO885910 ISO_8859-10 ISO_8859-10:1992 ISO-IR-157 LATIN6 L6 CSISOLATIN6 OSF0001000A
ISO-8859-11 ISO8859-11 ISO885911 THAI8 HP-THAI8 HPTHAI8
ISO-8859-13 ISO8859-13 ISO885913 ISO-IR-179 LATIN7 L7 BALTIC CP921 IBM921 IBM-921 CSIBM921
ISO-8859-14 ISO8859-14 ISO885914 ISO_8859-14 ISO_8859-14:1998 ISO-IR-199 LATIN8 L8 ISO-CELTIC
ISO-8859-15 ISO8859-15 ISO885915 ISO_8859-15 ISO_8859-15:1998 ISO-IR-203 LATIN-9 LATIN9
ISO-8859-16 ISO8859-16 ISO885916 ISO_8859-16 ISO_8859-16:2001 ISO-IR-226 LATIN10 L10
TIS-620 TIS620 TIS620-0 TIS620.2529-1 TIS620.2533-0 ISO-IR-166
KOI8-R KOI8R CSKOI8R
KOI8-U KOI8U
IBM866 CP866 866 CSIBM866
CP874 WINDOWS-874 IBM874 874
CP1250 WINDOWS-1250 MS-EE
CP1251 WINDOWS-1251 MS-CYRL
CP1252 WINDOWS-1252 MS-ANSI
CP1253 WINDOWS-1253 MS-GREEK
CP1254 WINDOWS-1254 MS-TURK
CP1256 WINDOWS-1256 MS-ARAB
CP1257 WINDOWS-1257 WINBALTRIM";

/// How many charsets `NAMES` holds.
const COUNT: usize = {
    let (bytes, mut at, mut lines) = (NAMES.as_bytes(), 0, 1);
    while at < bytes.len() {
        lines += (bytes[at] == b'\n') as usize;
        at += 1;
    }
    lines
};

/// A charset: a UTF form's byte order (None for the one a BOM names,
/// little-endian without one) and whether it is full UTF-16 or UTF-32
/// (UCS-2 has no surrogate pairs; UCS-4 any value up to 0x7FFFFFFF, as
/// glibc's internal form), or the tables it converts with.
#[derive(Clone, Copy)]
enum Charset {
    Utf8,
    Utf16(Option<bool>, bool),
    Utf32(Option<bool>, bool),
    Latin1,
    Ascii,
    Single(&'static Encoding, High),
    Multi(&'static Spec),
}

/// The charset each `NAMES` line stands for, by its first name.
fn charset(name: &str) -> Charset {
    use self::table::{EUC_CN, EUC_JP, EUC_KR, GB18030, GBK, SJIS};
    use Charset::{Multi, Single, Utf16, Utf32};
    use High::{Controls, Holes, Koi8u, Tis, Whatwg};
    use encoding_rs as e;
    match name {
        "UTF-8" => Charset::Utf8,
        "UTF-16" => Utf16(None, true),
        "UTF-16LE" => Utf16(Some(true), true),
        "UTF-16BE" => Utf16(Some(false), true),
        "UCS-2" => Utf16(Some(true), false),
        "UCS-2BE" => Utf16(Some(false), false),
        "UTF-32" => Utf32(None, true),
        "UTF-32LE" => Utf32(Some(true), true),
        "UTF-32BE" => Utf32(Some(false), true),
        "UCS-4LE" => Utf32(Some(true), false),
        "UCS-4" => Utf32(Some(false), false),
        "ISO-8859-1" => Charset::Latin1,
        "GBK" => Multi(&GBK),
        "EUC-CN" => Multi(&EUC_CN),
        "GB18030" => Multi(&GB18030),
        "EUC-KR" => Multi(&EUC_KR),
        "SJIS" => Multi(&SJIS),
        "EUC-JP" => Multi(&EUC_JP),
        "ISO-8859-2" => Single(e::ISO_8859_2, Whatwg),
        "ISO-8859-3" => Single(e::ISO_8859_3, Whatwg),
        "ISO-8859-4" => Single(e::ISO_8859_4, Whatwg),
        "ISO-8859-5" => Single(e::ISO_8859_5, Whatwg),
        "ISO-8859-6" => Single(e::ISO_8859_6, Whatwg),
        "ISO-8859-7" => Single(e::ISO_8859_7, Whatwg),
        "ISO-8859-8" => Single(e::ISO_8859_8, Whatwg),
        "ISO-8859-9" => Single(e::WINDOWS_1254, Controls),
        "ISO-8859-10" => Single(e::ISO_8859_10, Whatwg),
        "ISO-8859-11" => Single(e::WINDOWS_874, Controls),
        "ISO-8859-13" => Single(e::ISO_8859_13, Whatwg),
        "ISO-8859-14" => Single(e::ISO_8859_14, Whatwg),
        "ISO-8859-15" => Single(e::ISO_8859_15, Whatwg),
        "ISO-8859-16" => Single(e::ISO_8859_16, Whatwg),
        "TIS-620" => Single(e::WINDOWS_874, Tis),
        "KOI8-R" => Single(e::KOI8_R, Whatwg),
        "KOI8-U" => Single(e::KOI8_U, Koi8u),
        "IBM866" => Single(e::IBM866, Whatwg),
        "CP874" => Single(e::WINDOWS_874, Holes),
        "CP1250" => Single(e::WINDOWS_1250, Holes),
        "CP1251" => Single(e::WINDOWS_1251, Holes),
        "CP1252" => Single(e::WINDOWS_1252, Holes),
        "CP1253" => Single(e::WINDOWS_1253, Holes),
        "CP1254" => Single(e::WINDOWS_1254, Holes),
        "CP1256" => Single(e::WINDOWS_1256, Holes),
        "CP1257" => Single(e::WINDOWS_1257, Holes),
        _ => Charset::Ascii,
    }
}

fn charset_at(index: usize) -> Charset {
    charset(
        NAMES
            .lines()
            .nth(index)
            .and_then(|names| names.split(' ').next())
            .unwrap_or(""),
    )
}

/// Each charset's tables, built on first use and kept for the process.
enum Tables {
    Single(Single),
    Multi(Multibyte),
}

static TABLES: [OnceLock<Tables>; COUNT] = [const { OnceLock::new() }; COUNT];

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
    match key.as_slice() {
        [] => Some(b"UTF-8".to_vec()),
        _ if key.contains(&b'/') => None,
        _ => Some(key),
    }
}

/// The `NAMES` line a typed charset names.
fn lookup(name: &[u8]) -> Option<usize> {
    let key = charset_key(name)?;
    NAMES
        .lines()
        .position(|names| names.split(' ').any(|known| known.as_bytes() == key))
}

/// glibc's `strverscmp`: text compares byte by byte, but where the first
/// difference falls in a run of digits the whole runs compare as numbers,
/// and a run that starts with `0` is a fraction sorting before every whole
/// number (`000 < 00 < 01 < 010 < 09 < 0 < 1 < 9 < 10`).
fn strverscmp(a: &[u8], b: &[u8]) -> Ordering {
    let split = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (left, right) = (a.get(split), b.get(split));
    let head = a[..split]
        .iter()
        .rposition(|c| !c.is_ascii_digit())
        .map_or(0, |at| at + 1);
    let run = |s: &[u8]| s[head..].iter().take_while(|c| c.is_ascii_digit()).count();
    let (run_a, run_b) = (run(a), run(b));
    if run_a == 0 || run_b == 0 {
        return left.cmp(&right);
    }
    let (fraction_a, fraction_b) = (run_a > 1 && a[head] == b'0', run_b > 1 && b[head] == b'0');
    let digit = |c: Option<&u8>| c.is_some_and(u8::is_ascii_digit);
    if fraction_a != fraction_b {
        fraction_b.cmp(&fraction_a)
    } else if !fraction_a && run_a != run_b {
        run_a.cmp(&run_b)
    } else if fraction_a && a[head..split].iter().all(|&c| c == b'0') && digit(left) != digit(right)
    {
        digit(right).cmp(&digit(left))
    } else {
        left.cmp(&right)
    }
}

/// What `iconv -l` prints: one name per line with the `//` that ends an
/// empty suffix, the lines in `strverscmp` order (`US-ASCII//` before
/// `US//`), as glibc lists to a pipe.
fn list_text() -> Vec<u8> {
    let mut names: Vec<String> = NAMES
        .split_whitespace()
        .map(|name| format!("{name}//\n"))
        .collect();
    names.sort_by(|a, b| strverscmp(a.as_bytes(), b.as_bytes()));
    names.concat().into_bytes()
}

/// glibc's refusal of a charset it does not know, in a byte string of one
/// character per byte, which the hosts turn back into the bytes.
fn unsupported(from: &[u8], to: &[u8], from_ok: bool, to_ok: bool) -> StreamError {
    let name = |name: &[u8]| name.iter().map(|&b| char::from(b)).collect::<String>();
    let line = match (from_ok, to_ok) {
        (false, false) => format!(
            "conversions from `{}' and to `{}' are not supported",
            name(from),
            name(to)
        ),
        (false, true) => format!("conversion from `{}' is not supported", name(from)),
        _ => format!("conversion to `{}' is not supported", name(to)),
    };
    StreamError::new(format!("iconv: {line}\n{HINT}"))
}

/// A charset's reading or writing side: UTF-16 or UCS-2 (no pairs),
/// UTF-32 or UCS-4 (not strict), or a table.
enum Codec {
    Utf8,
    Utf16(bool),
    Utf32(bool),
    Latin1,
    Ascii,
    Single(&'static Single),
    Multi(&'static Multibyte),
}

const SURROGATES: std::ops::RangeInclusive<u32> = 0xD800..=0xDFFF;

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

fn put_unit(unit: u32, width: usize, little: bool, out: &mut Vec<u8>) {
    let bytes = unit.to_be_bytes();
    let bytes = &bytes[4 - width..];
    if little {
        out.extend(bytes.iter().rev());
    } else {
        out.extend_from_slice(bytes);
    }
}

impl Codec {
    /// One character at `at`; UTF-16 and UTF-32 read in `little` order.
    fn step(&self, raw: &[u8], at: usize, little: bool) -> Step {
        match self {
            Codec::Utf8 => utf8_char(raw, at),
            Codec::Utf16(pairs) => match unit(raw, at, 2, little) {
                None => Step::Cut,
                Some(first @ 0xD800..=0xDBFF) if *pairs => match unit(raw, at + 2, 2, little) {
                    None => Step::Cut,
                    Some(second @ 0xDC00..=0xDFFF) => {
                        Step::Char(0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00), 4)
                    }
                    Some(_) => Step::Illegal(2),
                },
                Some(0xD800..=0xDFFF) => Step::Illegal(2),
                Some(cp) => Step::Char(cp, 2),
            },
            Codec::Utf32(strict) => match unit(raw, at, 4, little) {
                None => Step::Cut,
                Some(cp) if *strict && (cp > 0x10FFFF || SURROGATES.contains(&cp)) => {
                    Step::Illegal(4)
                }
                Some(0x8000_0000..) => Step::Illegal(4),
                Some(cp) => Step::Char(cp, 4),
            },
            Codec::Latin1 => Step::Char(u32::from(raw[at]), 1),
            Codec::Ascii if raw[at] < 0x80 => Step::Char(u32::from(raw[at]), 1),
            Codec::Ascii => Step::Illegal(1),
            Codec::Single(table) => match table.decode[usize::from(raw[at])] {
                u32::MAX => Step::Illegal(1),
                cp => Step::Char(cp, 1),
            },
            Codec::Multi(table) => table.step(raw, at),
        }
    }

    /// Write one character in `little` order, false when the charset
    /// cannot hold it.
    fn put(&self, cp: u32, little: bool, out: &mut Vec<u8>) -> bool {
        match self {
            Codec::Utf8 if SURROGATES.contains(&cp) => return false,
            Codec::Utf8 if cp < 0x80 => out.push(cp as u8),
            Codec::Utf8 => {
                let length = match cp {
                    ..0x800 => 2,
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
            Codec::Utf16(_) if cp > 0x10FFFF || SURROGATES.contains(&cp) => return false,
            Codec::Utf16(false) if cp > 0xFFFF => return false,
            Codec::Utf16(_) if cp > 0xFFFF => {
                let cp = cp - 0x10000;
                put_unit(0xD800 | cp >> 10, 2, little, out);
                put_unit(0xDC00 | cp & 0x3FF, 2, little, out);
            }
            Codec::Utf16(_) => put_unit(cp, 2, little, out),
            Codec::Utf32(true) if cp > 0x10FFFF || SURROGATES.contains(&cp) => return false,
            Codec::Utf32(_) => put_unit(cp, 4, little, out),
            Codec::Latin1 if cp < 0x100 => out.push(cp as u8),
            Codec::Ascii if cp < 0x80 => out.push(cp as u8),
            Codec::Single(table) if table.reverse.get(cp).is_some() => {
                out.extend(table.reverse.get(cp).map(|byte| byte as u8));
            }
            Codec::Multi(table) => match table.reverse.get(cp) {
                Some(seq) => table::put_sequence(seq, out),
                None if table.grammar == Grammar::Gb18030 && (0x10000..=0x10FFFF).contains(&cp) => {
                    table::put_sequence(Multibyte::supplementary(cp), out);
                }
                None => return false,
            },
            _ => return false,
        }
        true
    }

    /// Whether every ASCII byte reads as itself.
    fn reads_ascii(&self) -> bool {
        match self {
            Codec::Utf16(_) | Codec::Utf32(_) => false,
            Codec::Multi(table) => table.grammar != Grammar::Sjis,
            _ => true,
        }
    }

    /// The bytes an ASCII character writes as, each its own value.
    fn ascii_width(&self) -> usize {
        match self {
            Codec::Utf16(_) => 2,
            Codec::Utf32(_) => 4,
            _ => 1,
        }
    }

    /// For a UTF-16 or UTF-32 input with no order set: the bytes its BOM
    /// takes and the order it names, None while fewer than a unit came.
    fn bom(&self, raw: &[u8]) -> Option<(usize, bool)> {
        let (width, little, big): (usize, &[u8], &[u8]) = match self {
            Codec::Utf16(_) => (2, b"\xff\xfe", b"\xfe\xff"),
            _ => (4, b"\xff\xfe\0\0", b"\0\0\xfe\xff"),
        };
        let head = raw.get(..width)?;
        Some(match head {
            _ if head == little => (width, true),
            _ if head == big => (width, false),
            _ => (0, true),
        })
    }
}

/// A charset's codec and the byte order it takes, None for a BOM's.
fn codec(index: usize) -> (Codec, Option<bool>) {
    let tables = |charset| {
        TABLES[index].get_or_init(|| match charset {
            Charset::Single(encoding, high) => Tables::Single(table::single(encoding, high)),
            Charset::Multi(spec) => Tables::Multi(spec.build()),
            _ => unreachable!("only table charsets have tables"),
        })
    };
    match charset_at(index) {
        Charset::Utf8 => (Codec::Utf8, Some(true)),
        Charset::Utf16(little, pairs) => (Codec::Utf16(pairs), little),
        Charset::Utf32(little, strict) => (Codec::Utf32(strict), little),
        Charset::Latin1 => (Codec::Latin1, Some(true)),
        Charset::Ascii => (Codec::Ascii, Some(true)),
        charset => match tables(charset) {
            Tables::Single(table) => (Codec::Single(table), Some(true)),
            Tables::Multi(table) => (Codec::Multi(table), Some(true)),
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
    let (from, to) = (lookup(&config.from), lookup(&config.to));
    let (Some(from), Some(to)) = (from, to) else {
        return Err(unsupported(
            &config.from,
            &config.to,
            from.is_some(),
            to.is_some(),
        ));
    };
    let (source, little) = codec(from);
    let (target, order) = codec(to);
    let bom: &[u8] = match (&target, order) {
        (Codec::Utf16(_), None) => b"\xff\xfe",
        (Codec::Utf32(_), None) => b"\xff\xfe\0\0",
        _ => b"",
    };
    Ok(Box::new(Iconv {
        ascii: source.reads_ascii().then(|| target.ascii_width()),
        utf8: matches!(source, Codec::Utf8),
        quiet: matches!(
            charset_at(from),
            Charset::Utf32(_, false) | Charset::Utf16(Some(false), false)
        ),
        source,
        target,
        little,
        order: order.unwrap_or(true),
        bom,
        omit: config.omit,
        inputs: config.inputs,
        input: Input::default(),
        current: 0,
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

/// The input being read: its bytes from `start` not yet converted, at
/// position `base` in it.
#[derive(Default)]
struct Input {
    held: Vec<u8>,
    start: usize,
    base: u64,
    ended: bool,
}

/// One conversion over the run's inputs, read one after another. Each
/// input's positions count from its first byte; an illegal sequence ends
/// the run unless `-c` drops it, an incomplete one at an input's end is
/// reported and the next input read. The byte order a BOM names is set
/// once, by the first input with a whole unit, as glibc keeps it for the
/// whole run, and a UTF-16 or UTF-32 output gets its BOM once, as the
/// first character reaches it, whether or not that character converts.
struct Iconv {
    source: Codec,
    target: Codec,
    /// The order the source reads in, None until a BOM sets it.
    little: Option<bool>,
    /// The order the target writes in.
    order: bool,
    /// The BOM the target has still to write.
    bom: &'static [u8],
    /// The source is UCS-4 or UCS-2BE, whose refused sequences glibc drops
    /// under `-c` without counting them, so they leave the status 0
    /// (measured; UCS-2's little-endian reader counts them).
    quiet: bool,
    /// The width ASCII bytes write as, when they read as themselves.
    ascii: Option<usize>,
    /// The source is UTF-8.
    utf8: bool,
    omit: bool,
    inputs: usize,
    input: Input,
    current: usize,
    /// The last step stopped at a full window.
    more: bool,
    stopped: bool,
    status: i32,
    stderr: Vec<u8>,
}

/// ASCII bytes as `width`-byte units in `little` order.
fn widen(ascii: &[u8], width: usize, little: bool, out: &mut Vec<u8>) {
    if width == 1 {
        return out.extend_from_slice(ascii);
    }
    let start = out.len();
    out.resize(start + ascii.len() * width, 0);
    let at = if little { 0 } else { width - 1 };
    for (unit, &byte) in out[start..].chunks_exact_mut(width).zip(ascii) {
        unit[at] = byte;
    }
}

fn ascii_run(raw: &[u8]) -> usize {
    let mut at = 0;
    while let Some(word) = raw.get(at..at + 8) {
        if u64::from_ne_bytes(word.try_into().unwrap_or_default()) & 0x8080_8080_8080_8080 != 0 {
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
        let little = match self
            .little
            .or_else(|| self.source.bom(raw).map(|(_, little)| little))
        {
            Some(little) => little,
            None => return Ok(0),
        };
        if self.little.is_none() {
            at = self.source.bom(raw).map_or(0, |(skip, _)| skip);
            self.little = Some(little);
        }
        self.more = false;
        while at < raw.len() {
            if out.len() >= limit {
                self.more = true;
                break;
            }
            let room = limit - out.len();
            if let Some(width) = self.ascii.filter(|_| raw[at].is_ascii()) {
                let run = ascii_run(&raw[at..]).min(room.div_ceil(width));
                if run > 0 {
                    self.write_bom(out);
                    widen(&raw[at..at + run], width, self.order, out);
                    at += run;
                    continue;
                }
            }
            if self.utf8 {
                let end = raw.len().min(at + room.div_ceil(4));
                let valid = raw[at..end]
                    .utf8_chunks()
                    .next()
                    .map_or("", |chunk| chunk.valid());
                if matches!(self.target, Codec::Utf8) {
                    out.extend_from_slice(valid.as_bytes());
                } else {
                    for (offset, c) in valid.char_indices() {
                        self.write_bom(out);
                        if !self.target.put(u32::from(c), self.order, out) {
                            self.refuse(at + offset, false)?;
                        }
                    }
                }
                if !valid.is_empty() {
                    at += valid.len();
                    continue;
                }
            }
            match self.source.step(raw, at, little) {
                Step::Cut => break,
                Step::Char(cp, taken) => {
                    self.write_bom(out);
                    if !self.target.put(cp, self.order, out) {
                        self.refuse(at, false)?;
                    }
                    at += taken;
                }
                Step::Illegal(taken) => {
                    self.refuse(at, true)?;
                    at += taken;
                }
            }
        }
        Ok(at)
    }

    /// The target's BOM, before the first character reaches it.
    fn write_bom(&mut self, out: &mut Vec<u8>) {
        if !self.bom.is_empty() {
            out.extend_from_slice(std::mem::take(&mut self.bom));
        }
    }

    /// A sequence at `at` that reads (`illegal`) or writes as nothing: the
    /// end of the run, or under `-c` a drop.
    fn refuse(&mut self, at: usize, illegal: bool) -> Result<(), StreamError> {
        if !self.omit {
            self.stopped = true;
            let position = self.input.base + at as u64;
            return Err(StreamError::new(format!(
                "iconv: illegal input sequence at position {position}"
            )));
        }
        if !(self.quiet && illegal) {
            self.status = 1;
        }
        Ok(())
    }

    /// Take `bytes` into the current input and convert what a window holds.
    fn step(&mut self, bytes: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.input.start == self.input.held.len() {
            self.input.held.clear();
            self.input.start = 0;
            let used = self.run(bytes, out)?;
            self.input.base += used as u64;
            self.input.held.extend_from_slice(&bytes[used..]);
            return Ok(());
        }
        if self.input.start > 0 && !bytes.is_empty() {
            self.input.held.drain(..self.input.start);
            self.input.start = 0;
        }
        self.input.held.extend_from_slice(bytes);
        let held = std::mem::take(&mut self.input.held);
        let used = self.run(&held[self.input.start..], out)?;
        self.input.held = held;
        self.input.start += used;
        self.input.base += used as u64;
        Ok(())
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
        let idle = !self.stopped && !self.more && !self.input.ended;
        (idle && self.current < self.inputs).then_some(self.current)
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
        self.input.ended = true;
        self.drain(out)
    }

    fn busy(&self) -> bool {
        self.more
    }

    /// Convert the next window; once an ended input is converted, report
    /// a character it ends inside of and go on to the next input.
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(&[], out)?;
        if self.input.ended && !self.more {
            if self.input.start < self.input.held.len() {
                self.stderr.extend_from_slice(INCOMPLETE);
                self.status = 1;
            }
            self.input = Input::default();
            self.current += 1;
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
