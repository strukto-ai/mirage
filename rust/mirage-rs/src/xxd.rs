// The reverse (-r) reader follows xxd 2024-12-07 from vim, under its
// X11-MIT option (see licenses/third_party/xxd.txt).

use std::collections::VecDeque;

use serde::Deserialize;

use serde_json::{Value as Json, json};

use crate::number;
use crate::scan::{Typed, Values, last, unknown};
use crate::{Stream, StreamError, parse_config};

const BACKWARDS: &str = "xxd: Sorry, cannot seek backwards.";
// The most bytes one call emits while a dump's offset skips ahead.
const WINDOW: usize = 64 * 1024;
const LOWER: &[u8; 16] = b"0123456789abcdef";
const UPPER: &[u8; 16] = b"0123456789ABCDEF";
const CONFLICT: &str = "xxd: only one of -b, -e, -u, -p, -i can be used";
const GROUP_POWER: &str = "xxd: number of octets per group must be a power of 2 with -e.";

/// The character `-E` shows for each EBCDIC byte, `.` for one with no
/// printable ASCII match, as xxd 2024-12-07 shows them.
const EBCDIC: [&[u8; 64]; 4] = [
    b"................................................................",
    b" ...........<(+|&.........!$*);~-/.........,%_>?.........`:#@'=\"",
    b".abcdefghi.......jklmnopqr^.......stuvwxyz...[...............]..",
    b"{ABCDEFGHI......}JKLMNOPQR......\\.STUVWXYZ......0123456789......",
];

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum Config {
    Dump {
        cols: usize,
        group: usize,
        uppercase: bool,
        #[serde(deserialize_with = "crate::saturating_u64")]
        base: u64,
        /// `-b`: each octet in binary.
        #[serde(default)]
        bits: bool,
        /// `-e`: each group's octets in reverse order.
        #[serde(default)]
        little: bool,
        /// `-d`: offsets in decimal.
        #[serde(default)]
        decimal: bool,
        /// `-E`: the text column read as EBCDIC.
        #[serde(default)]
        ebcdic: bool,
        /// `-a`: a run of all-zero lines shown as `*`.
        #[serde(default)]
        autoskip: bool,
        /// `-o`, added to `base`, as decimal text: a host's JSON number
        /// past 2^53 loses digits.
        #[serde(default)]
        displacement: String,
    },
    Plain {
        uppercase: bool,
        cols: usize,
    },
    /// `-i`: a C array, named for `name` (no declaration without one).
    Include {
        cols: usize,
        uppercase: bool,
        capitalize: bool,
        #[serde(default, deserialize_with = "crate::latin1_opt")]
        name: Option<Vec<u8>>,
    },
    Reverse {
        plain: bool,
        segments: bool,
        /// The most octets a line gives outside -p (`-c`).
        cols: usize,
        /// `-s`, added to every offset.
        #[serde(default)]
        base: i64,
    },
}

/// The most octets vim's xxd puts on a line outside -p.
const COLS_MAX: i64 = 256;

/// xxd's options as vim's xxd (2024-12-07) reads them, the last of each:
/// `-c`, `-g`, `-s`, `-l` and `-o` through `strtol` at base 0, so a word with
/// no number is 0 and only its leading number counts. `-b`, `-e`, `-p` and
/// `-i` each pick a dump, of which a line names one. `-c` is the one value
/// refused, past 256 outside `-p` and `-i`;
/// `-g` under 1 or past the line is the whole line, and must be a power of 2
/// under `-e`; a negative `-l` is no limit. What comes back is the dump's
/// configuration (`render`), `-o` within it, for the host to add the base
/// offset and `-i`'s name to.
pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    const NAMES: [&str; 15] = [
        "p", "c", "g", "s", "args_l", "b", "e", "i", "u", "a", "d", "E", "C", "n", "o",
    ];
    if let Some((name, _)) = options
        .iter()
        .find(|(name, _)| !NAMES.contains(&name.as_str()))
    {
        return Err(unknown("xxd", name));
    }
    let mut kind: Option<&str> = None;
    let mut uppercase = false;
    for (name, _) in options {
        match name.as_str() {
            name @ ("b" | "e" | "p" | "i") => {
                if kind.is_some_and(|picked| picked != name) {
                    return Err(StreamError::refusal(CONFLICT.as_bytes(), 1));
                }
                kind = Some(name);
            }
            "u" => uppercase = true,
            _ => {}
        }
    }
    let plain = kind == Some("p");
    let include = kind == Some("i");
    let bits = kind == Some("b");
    let little = kind == Some("e");
    let typed = last(options, "c").map(octets);
    if typed.is_some_and(|cols| cols < 0 || (!plain && !include && cols > COLS_MAX)) {
        let refused = format!("xxd: invalid number of columns (max. {COLS_MAX}).");
        return Err(StreamError::refusal(refused.as_bytes(), 1));
    }
    let cols = match typed {
        Some(cols) if plain || cols > 0 => cols,
        _ if plain => 30,
        _ if include => 12,
        _ if bits => 6,
        _ => 16,
    };
    let group = last(options, "g").map_or(-1, octets);
    if little && group >= 1 && group.count_ones() != 1 {
        return Err(StreamError::refusal(GROUP_POWER.as_bytes(), 1));
    }
    let group = if group >= 0 {
        group
    } else if bits {
        1
    } else if little {
        4
    } else {
        2
    };
    let group = if group < 1 || group > cols {
        cols
    } else {
        group
    };
    let seek = last(options, "s").unwrap_or_default();
    let relative = seek.first() == Some(&b'+');
    let rest = if relative { &seek[1..] } else { seek };
    let back = rest.first() == Some(&b'-');
    let offset = number::strtol(if back { &rest[1..] } else { rest }).0;
    let limit = last(options, "args_l")
        .map(|raw| number::strtol(raw).0)
        .filter(|&limit| limit >= 0);
    let displacement = last(options, "o").map_or(0, |raw| number::strtol(raw).0 as u64);
    let render = if plain {
        json!({"mode": "plain", "uppercase": uppercase, "cols": cols})
    } else if include {
        json!({
            "mode": "include",
            "cols": cols,
            "uppercase": uppercase,
            "capitalize": last(options, "C").is_some(),
        })
    } else {
        json!({
            "mode": "dump",
            "cols": cols,
            "group": group,
            "uppercase": uppercase,
            "bits": bits,
            "little": little,
            "decimal": last(options, "d").is_some(),
            "ebcdic": last(options, "E").is_some(),
            "autoskip": last(options, "a").is_some(),
            "displacement": displacement.to_string(),
        })
    };
    let mut values = Values::new();
    values.insert("cols".to_owned(), Json::from(cols));
    values.insert("group".to_owned(), Json::from(group));
    values.insert(
        "seek".to_owned(),
        json!({"offset": offset, "relative": relative, "back": back}),
    );
    values.insert("limit".to_owned(), limit.map_or(Json::Null, Json::from));
    values.insert("render".to_owned(), render);
    Ok(values)
}

/// A `-c` or `-g` count: `(int)strtol(text, NULL, 0)`.
fn octets(raw: &[u8]) -> i64 {
    i64::from(number::strtol(raw).0 as i32)
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(match parse_config(config)? {
        Config::Dump {
            cols,
            group,
            uppercase,
            base,
            bits,
            little,
            decimal,
            ebcdic,
            autoskip,
            displacement,
        } => {
            if cols == 0 || group == 0 {
                return Err(StreamError::new("xxd: a dump needs octets per line"));
            }
            let displacement = match displacement.as_str() {
                "" => 0,
                text => text
                    .parse::<u64>()
                    .map_err(|_| StreamError::new("xxd: a displacement is a decimal count"))?,
            };
            Box::new(Dump {
                cols,
                group,
                uppercase,
                bits,
                little,
                decimal,
                ebcdic,
                autoskip,
                offset: base.wrapping_add(displacement),
                held: Vec::new(),
                waiting: None,
                zeros: 0,
                kept: None,
            })
        }
        Config::Include {
            cols,
            uppercase,
            capitalize,
            name,
        } => Box::new(Include {
            cols: cols.max(1),
            uppercase,
            name: name.map(|name| c_name(&name, capitalize)),
            capitalize,
            count: 0,
            started: false,
        }),
        Config::Plain { uppercase, cols } => Box::new(Plain {
            digits: if uppercase { UPPER } else { LOWER },
            cols,
            column: 0,
        }),
        Config::Reverse {
            plain,
            segments,
            cols,
            base,
        } => Box::new(Reverse::new(plain, segments, cols, base)),
    })
}

fn hex(out: &mut Vec<u8>, byte: u8, digits: &[u8; 16]) {
    out.push(digits[usize::from(byte >> 4)]);
    out.push(digits[usize::from(byte & 15)]);
}

/// The default dump: an offset, the octets in hex groups padded to a full
/// line's width, and their printable ASCII. `-b` writes each octet in
/// binary, `-e` each group's octets in reverse with a short group pushed to
/// its right, `-d` the offset in decimal, `-E` the text as EBCDIC, and `-a`
/// a run of three or more all-zero lines as its first line and `*`. Under
/// `-a` a whole line waits for the next, since the last line is always
/// written.
struct Dump {
    cols: usize,
    group: usize,
    uppercase: bool,
    bits: bool,
    little: bool,
    decimal: bool,
    ebcdic: bool,
    autoskip: bool,
    offset: u64,
    held: Vec<u8>,
    /// `-a`'s last whole line, written once the next one shows it is not
    /// the last.
    waiting: Option<(u64, Vec<u8>)>,
    /// How many all-zero lines in a row `-a` has met.
    zeros: usize,
    /// The second of them, written only if the run ends there.
    kept: Option<(u64, Vec<u8>)>,
}

impl Dump {
    fn render(&self, offset: u64, row: &[u8], out: &mut Vec<u8>) {
        let start = out.len();
        if self.decimal {
            let text = offset.to_string();
            out.resize(out.len() + 8usize.saturating_sub(text.len()), b'0');
            out.extend_from_slice(text.as_bytes());
        } else {
            let count = (u64::BITS - offset.leading_zeros()).div_ceil(4).max(8) as usize;
            crate::integer::digits(offset, 16, count, out);
            if self.uppercase {
                out[start..].make_ascii_uppercase();
            }
        }
        out.extend_from_slice(b": ");
        let digits = if self.uppercase { UPPER } else { LOWER };
        let groups = self.cols.div_ceil(self.group);
        let width = if self.little {
            groups * self.group * 2
        } else if self.bits {
            self.cols * 8
        } else {
            self.cols * 2
        } + groups
            - 1;
        let start = out.len();
        for (index, group) in row.chunks(self.group).enumerate() {
            if index > 0 {
                out.push(b' ');
            }
            if self.little {
                out.resize(out.len() + (self.group - group.len()) * 2, b' ');
                for &byte in group.iter().rev() {
                    hex(out, byte, digits);
                }
            } else if self.bits {
                for &byte in group {
                    out.extend((0..8).rev().map(|bit| b'0' + (byte >> bit & 1)));
                }
            } else {
                for &byte in group {
                    hex(out, byte, digits);
                }
            }
        }
        let used = out.len() - start;
        out.resize(out.len() + width.saturating_sub(used) + 2, b' ');
        out.extend(row.iter().map(|&byte| {
            if self.ebcdic {
                EBCDIC[usize::from(byte >> 6)][usize::from(byte & 63)]
            } else if (32..127).contains(&byte) {
                byte
            } else {
                b'.'
            }
        }));
        out.push(b'\n');
    }

    fn row(&mut self, row: &[u8], out: &mut Vec<u8>) {
        let offset = self.offset;
        self.offset = self.offset.wrapping_add(row.len() as u64);
        if !self.autoskip {
            self.render(offset, row, out);
            return;
        }
        if let Some((at, line)) = self.waiting.replace((offset, row.to_vec())) {
            self.settle(at, &line, out);
        }
    }

    /// `-a` over a line that is not the last.
    fn settle(&mut self, at: u64, line: &[u8], out: &mut Vec<u8>) {
        if line.iter().all(|&byte| byte == 0) {
            self.zeros += 1;
            match self.zeros {
                1 => self.render(at, line, out),
                2 => self.kept = Some((at, line.to_vec())),
                3 => {
                    self.kept = None;
                    out.extend_from_slice(b"*\n");
                }
                _ => {}
            }
            return;
        }
        self.release(out);
        self.render(at, line, out);
    }

    fn release(&mut self, out: &mut Vec<u8>) {
        if let Some((at, line)) = self.kept.take() {
            self.render(at, &line, out);
        }
        self.zeros = 0;
    }
}

impl Stream for Dump {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut data = input;
        if !self.held.is_empty() {
            let take = (self.cols - self.held.len()).min(data.len());
            self.held.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.held.len() < self.cols {
                return Ok(());
            }
            let row = std::mem::take(&mut self.held);
            self.row(&row, out);
        }
        let mut rows = data.chunks_exact(self.cols);
        for row in rows.by_ref() {
            self.row(row, out);
        }
        self.held.extend_from_slice(rows.remainder());
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let tail = std::mem::take(&mut self.held);
        let last = if tail.is_empty() {
            self.waiting.take()
        } else {
            if let Some((at, line)) = self.waiting.take() {
                self.settle(at, &line, out);
            }
            let at = self.offset;
            self.offset = self.offset.wrapping_add(tail.len() as u64);
            Some((at, tail))
        };
        if let Some((at, line)) = last {
            self.release(out);
            self.render(at, &line, out);
        }
        Ok(())
    }
}

/// `-i`'s array name: every character but a letter or a digit becomes `_`,
/// a leading digit takes `__` before it, and `-C` capitalizes it.
fn c_name(name: &[u8], capitalize: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(name.len() + 2);
    if name.first().is_some_and(u8::is_ascii_digit) {
        out.extend_from_slice(b"__");
    }
    out.extend(name.iter().map(|&byte| {
        let byte = if byte.is_ascii_alphanumeric() {
            byte
        } else {
            b'_'
        };
        if capitalize {
            byte.to_ascii_uppercase()
        } else {
            byte
        }
    }));
    out
}

/// `-i`: the octets as C hex literals, `cols` a line, inside an array
/// declaration and followed by its length when the input has a name.
struct Include {
    cols: usize,
    uppercase: bool,
    capitalize: bool,
    name: Option<Vec<u8>>,
    count: u64,
    started: bool,
}

impl Stream for Include {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.started {
            self.started = true;
            if let Some(name) = &self.name {
                out.extend_from_slice(b"unsigned char ");
                out.extend_from_slice(name);
                out.extend_from_slice(b"[] = {\n");
            }
        }
        let digits = if self.uppercase { UPPER } else { LOWER };
        for &byte in input {
            if self.count > 0 {
                out.push(b',');
                if self.count % self.cols as u64 == 0 {
                    out.push(b'\n');
                } else {
                    out.push(b' ');
                }
            }
            if self.count % self.cols as u64 == 0 {
                out.extend_from_slice(b"  ");
            }
            out.extend_from_slice(if self.uppercase { b"0X" } else { b"0x" });
            hex(out, byte, digits);
            self.count += 1;
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed(&[], out)?;
        if self.count > 0 {
            out.push(b'\n');
        }
        if let Some(name) = &self.name {
            out.extend_from_slice(b"};\nunsigned int ");
            out.extend_from_slice(name);
            out.extend_from_slice(if self.capitalize { b"_LEN" } else { b"_len" });
            out.extend_from_slice(format!(" = {};\n", self.count).as_bytes());
        }
        Ok(())
    }
}

/// `-p`: the octets in hex, unbroken, and one newline at the end.
/// A plain (`-p`) dump: `cols` octets a line, all of them on one with
/// `cols` 0, and nothing for no input.
struct Plain {
    digits: &'static [u8; 16],
    cols: usize,
    /// The octets on the line being written.
    column: usize,
}

impl Stream for Plain {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.reserve(input.len() * 2 + input.len() / self.cols.max(1));
        for &byte in input {
            hex(out, byte, self.digits);
            self.column += 1;
            if self.column == self.cols {
                out.push(b'\n');
                self.column = 0;
            }
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.column > 0 {
            out.push(b'\n');
        }
        Ok(())
    }
}

enum Piece {
    Gap(u64),
    Data(Vec<u8>),
}

/// `-r`: a hexdump back into bytes, read a character at a time as xxd
/// reads one. A line starts with its offset in hex, which ends at the
/// first other character, a newline too, and up to `cols` octets follow as
/// digit pairs; a line's last octet, or three non-digits in a row past its
/// first digit, skips the rest of the line. With `plain` (-p) there are no
/// offsets and space, tab and newline never count. Every offset is past
/// `base` (-s). Onto a stream, which only moves forward, an offset past
/// the bytes written is reached with NUL bytes and one before them is
/// refused; with `segments`, each run goes out as a little-endian start
/// and length ahead of its bytes, for a host that writes them into a file
/// at their offsets.
struct Reverse {
    plain: bool,
    segments: bool,
    cols: usize,
    base: i64,
    /// The last three characters as hex digits, newest first, -1 for any
    /// other.
    digits: [i8; 3],
    /// Characters before a line's first digit are dropped.
    lead: bool,
    /// The rest of the line is skipped.
    skip: bool,
    /// The octets this line gave, `cols` while its offset is read.
    taken: usize,
    /// The offset the next octet goes to, before `base`.
    want: i64,
    /// The offset the output stands at.
    have: i64,
    /// Where `run` starts.
    start: i64,
    /// The octets decoded since the output last moved.
    run: Vec<u8>,
    pending: VecDeque<Piece>,
    failed: bool,
}

impl Reverse {
    fn new(plain: bool, segments: bool, cols: usize, base: i64) -> Self {
        Self {
            plain,
            segments,
            cols,
            base,
            digits: [-1, 0, 0],
            lead: true,
            skip: false,
            taken: cols,
            want: 0,
            have: 0,
            start: 0,
            run: Vec::new(),
            pending: VecDeque::new(),
            failed: false,
        }
    }

    fn newline(&mut self) {
        if !self.plain {
            self.want = 0;
        }
        self.taken = self.cols;
        self.lead = true;
    }

    /// Hand `run` on, from where it starts.
    fn flush(&mut self, out: &mut Vec<u8>) {
        if !self.run.is_empty() {
            let data = std::mem::take(&mut self.run);
            if self.segments {
                out.extend_from_slice(&(self.start as u64).to_le_bytes());
                out.extend_from_slice(&(data.len() as u64).to_le_bytes());
                out.extend_from_slice(&data);
            } else {
                self.pending.push_back(Piece::Data(data));
            }
        }
        self.start = self.have;
    }

    fn take(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        for &byte in input {
            if self.failed {
                break;
            }
            if self.skip {
                if byte == b'\n' {
                    self.skip = false;
                    self.newline();
                }
                continue;
            }
            if byte == b'\r' || (self.plain && matches!(byte, b' ' | b'\t' | b'\n')) {
                continue;
            }
            let digit = (byte as char).to_digit(16).map_or(-1, |value| value as i8);
            self.digits = [digit, self.digits[0], self.digits[1]];
            if digit < 0 && self.lead {
                continue;
            }
            self.lead = false;
            if !self.plain && self.taken >= self.cols {
                if digit < 0 {
                    self.taken = 0;
                } else {
                    self.want = self.want.wrapping_shl(4) | i64::from(digit);
                }
                continue;
            }
            let target = self.base.wrapping_add(self.want);
            if target != self.have {
                if target < 0 || (!self.segments && target < self.have) {
                    self.failed = true;
                    break;
                }
                self.flush(out);
                if !self.segments {
                    self.pending
                        .push_back(Piece::Gap(target.abs_diff(self.have)));
                }
                (self.have, self.start) = (target, target);
            }
            let [low, high, before] = self.digits;
            if high >= 0 && low >= 0 {
                self.run.push((high as u8) << 4 | low as u8);
                self.have = self.have.wrapping_add(1);
                self.want = self.want.wrapping_add(1);
                self.digits[0] = -1;
                if !self.plain {
                    self.taken += 1;
                    self.skip = self.taken >= self.cols;
                }
                continue;
            }
            if low < 0 && high < 0 && before < 0 {
                self.skip = byte != b'\n';
            }
            if byte == b'\n' {
                self.newline();
            }
        }
        self.flush(out);
        self.emit(out)
    }

    fn emit(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut room = WINDOW;
        while room > 0 {
            match self.pending.front_mut() {
                Some(Piece::Gap(gap)) => {
                    let count = (*gap).min(room as u64);
                    out.resize(out.len() + count as usize, 0);
                    room -= count as usize;
                    *gap -= count;
                    if *gap == 0 {
                        self.pending.pop_front();
                    }
                }
                Some(Piece::Data(_)) => {
                    let Some(Piece::Data(data)) = self.pending.pop_front() else {
                        unreachable!()
                    };
                    room = room.saturating_sub(data.len());
                    out.extend_from_slice(&data);
                }
                None if self.failed => return Err(StreamError::new(BACKWARDS)),
                None => break,
            }
        }
        Ok(())
    }
}

impl Stream for Reverse {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.take(input, out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.take(&[], out)
    }

    fn busy(&self) -> bool {
        !self.pending.is_empty() || self.failed
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.emit(out)
    }
}

#[cfg(test)]
mod tests {
    use super::BACKWARDS;
    use crate::run;

    fn dump(config: &str, chunks: &[&[u8]]) -> String {
        let (out, err) = run("xxd", config, chunks);
        assert!(err.is_none());
        String::from_utf8(out).unwrap()
    }

    fn reverse(plain: bool, chunks: &[&[u8]]) -> (Vec<u8>, Option<String>) {
        reverse_at(plain, 16, 0, chunks)
    }

    fn reverse_at(
        plain: bool,
        cols: usize,
        base: i64,
        chunks: &[&[u8]],
    ) -> (Vec<u8>, Option<String>) {
        let config = format!(
            r#"{{"mode":"reverse","plain":{plain},"segments":false,"cols":{cols},"base":{base}}}"#
        );
        let (out, err) = run("xxd", &config, chunks);
        (out, err.map(|err| err.message))
    }

    #[test]
    fn a_dump_pads_a_short_last_group_and_line_at_any_split() {
        let config = r#"{"mode":"dump","cols":5,"group":2,"uppercase":true,"base":4294967295}"#;
        let expected = "FFFFFFFF: 6869 2E0A 41  hi..A\n100000004: 42            B\n";
        assert_eq!(dump(config, &[b"hi.\nAB"]), expected);
        assert_eq!(dump(config, &[b"h", b"i.\nA", b"", b"B"]), expected);
        assert_eq!(dump(config, &[]), "");
        let config = r#"{"mode":"dump","cols":5,"group":2,"uppercase":false,"base":3,"displacement":"18446744073709551611"}"#;
        assert_eq!(
            dump(config, &[b"hi.\nAB"]),
            "fffffffffffffffe: 6869 2e0a 41  hi..A\n00000003: 42            B\n"
        );
    }

    #[test]
    fn bits_little_endian_and_decimal_lay_out_the_line() {
        let config = r#"{"mode":"dump","cols":5,"group":4,"uppercase":false,"base":4,"little":true,"decimal":true}"#;
        let expected = "00000004: 64636261       65  abcde\n00000009:       66           f\n";
        assert_eq!(dump(config, &[b"abcdef"]), expected);
        assert_eq!(dump(config, &[b"ab", b"cdef"]), expected);
        let config = r#"{"mode":"dump","cols":3,"group":2,"uppercase":false,"base":0,"bits":true,"ebcdic":true}"#;
        assert_eq!(
            dump(config, &[b"\x81\xc1\x00"]),
            "00000000: 1000000111000001 00000000  aA.\n"
        );
    }

    #[test]
    fn autoskip_stars_a_run_of_three_zero_lines_and_keeps_the_last() {
        let config =
            r#"{"mode":"dump","cols":2,"group":2,"uppercase":false,"base":0,"autoskip":true}"#;
        let zeros = |lines: usize| vec![0u8; lines * 2];
        let line = |at: u32| format!("{at:08x}: 0000  ..\n");
        assert_eq!(
            dump(config, &[&zeros(3)]),
            [line(0), line(2), line(4)].concat()
        );
        assert_eq!(
            dump(config, &[&zeros(4)]),
            [line(0), "*\n".into(), line(6)].concat()
        );
        let mut data = zeros(4);
        data.extend_from_slice(b"ab");
        let pieces: Vec<&[u8]> = data.chunks(1).collect();
        let expected = [line(0), "*\n".into(), "00000008: 6162  ab\n".into()].concat();
        assert_eq!(dump(config, &pieces), expected);
    }

    #[test]
    fn include_names_the_array_and_counts_its_octets() {
        let config =
            r#"{"mode":"include","cols":2,"uppercase":false,"capitalize":false,"name":"9a-b"}"#;
        assert_eq!(
            dump(config, &[b"ab", b"c"]),
            "unsigned char __9a_b[] = {\n  0x61, 0x62,\n  0x63\n};\nunsigned int __9a_b_len = 3;\n"
        );
        let config =
            r#"{"mode":"include","cols":12,"uppercase":true,"capitalize":true,"name":"e"}"#;
        assert_eq!(
            dump(config, &[]),
            "unsigned char E[] = {\n};\nunsigned int E_LEN = 0;\n"
        );
        let config = r#"{"mode":"include","cols":12,"uppercase":true,"capitalize":false}"#;
        assert_eq!(dump(config, &[b"\xab"]), "  0XAB\n");
        assert_eq!(dump(config, &[]), "");
    }

    #[test]
    fn a_plain_dump_wraps_at_its_columns() {
        let config = r#"{"mode":"plain","uppercase":false,"cols":2}"#;
        assert_eq!(dump(config, &[b"\x00\xff", b"A"]), "00ff\n41\n");
        assert_eq!(dump(config, &[b"\x00", b"\xff"]), "00ff\n");
        assert_eq!(dump(config, &[]), "");
        let config = r#"{"mode":"plain","uppercase":true,"cols":0}"#;
        assert_eq!(dump(config, &[b"\xab\xcd", b"\xef"]), "ABCDEF\n");
    }

    #[test]
    fn a_reverse_fills_forward_and_refuses_backward_after_its_bytes() {
        let lines: &[&[u8]] = &[
            b"00000002: 6869  hi\n000",
            b"00006: 41  A\n00000000: 4142\n",
        ];
        assert_eq!(
            reverse(false, lines),
            (
                b"\0\0hi\0\0A".to_vec(),
                Some("xxd: Sorry, cannot seek backwards.".into())
            )
        );
        let gap: &[&[u8]] = &[b"00030000: 41\n"];
        let (out, err) = reverse(false, gap);
        assert_eq!((out.len(), out.last(), err), (0x30001, Some(&b'A'), None));
    }

    #[test]
    fn a_reverse_reads_each_line_as_xxd_does_at_any_split() {
        // (input, -c, -s, zeros the output starts with, the rest, refused)
        let cases = [
            (
                b"\n68 65\n6czz\n6c".as_slice(),
                16,
                0,
                104,
                b"e\0\0\0".as_slice(),
                false,
            ),
            (b"6869\n00000003: 41  A\n", 16, 0, 26732, b"\x03", false),
            (b"00000000: 68zz 69  h.i\n", 16, 0, 0, b"h", false),
            (b"0: 41 4 2\n", 16, 0, 0, b"A", false),
            (b"0: 41 zz 42\n", 16, 0, 0, b"A", false),
            (b"0: 41z42\n", 16, 0, 0, b"AB", false),
            (b"0:41\r\n1:\r42\n", 16, 0, 0, b"AB", false),
            (b"00000010:\n", 16, 0, 16, b"", false),
            (b"41 42\n", 16, 0, 65, b"B", false),
            (b"0: 41\n2: 42\n1: 43\n", 16, 0, 0, b"A\0B", true),
            (b"  0: 41\n\n\n0002: 42  B\n", 16, 0, 0, b"A\0B", false),
            (
                b"00000000: 4142434445464748494a4b4c4d4e4f505152\n",
                16,
                0,
                0,
                b"ABCDEFGHIJKLMNOP",
                false,
            ),
            (
                b"00000000: 4142434445464748494a4b4c4d4e4f505152\n",
                4,
                0,
                0,
                b"ABCD",
                false,
            ),
            (b"00000000: 4142\n", 16, 3, 3, b"AB", false),
            (b"00000004: 4142\n", 16, -2, 2, b"AB", false),
        ];
        for (input, cols, base, zeros, rest, refused) in cases {
            let expected = [vec![0; zeros], rest.to_vec()].concat();
            let split: Vec<&[u8]> = input.chunks(1).collect();
            for chunks in [&[input][..], &split] {
                let (out, err) = reverse_at(false, cols, base, chunks);
                assert!(out == expected, "{input:?} -c {cols} -s {base}");
                assert_eq!(err.is_some(), refused, "{input:?}");
            }
        }
        let skipped = reverse(false, &[b"00000000: 68zz 69  h.i\nzz: 41\n6a"]).0;
        assert_eq!(skipped, [b"h".as_slice(), &[0; 64], b"j"].concat());
        let (out, err) = reverse_at(false, 16, -2, &[b"00000000: 4142\n"]);
        assert_eq!((out.len(), err), (0, Some(BACKWARDS.into())));
        assert_eq!(reverse_at(true, 30, 2, &[b"41\n"]).0, b"\0\0A");
    }

    #[test]
    fn a_reverse_holds_no_line() {
        let line = vec![b'4'; 1 << 20];
        let mut chunks: Vec<&[u8]> = line.chunks(4096).collect();
        chunks.push(b"\n");
        assert_eq!(reverse(false, &chunks), (Vec::new(), None));
        let data = [b"0: ".as_slice(), &b"41".repeat(300), b"\n"].concat();
        let pieces: Vec<&[u8]> = data.chunks(7).collect();
        assert_eq!(reverse_at(false, 256, 0, &pieces).0, vec![b'A'; 256]);
    }

    #[test]
    fn a_plain_reverse_pairs_digits_as_xxd_does() {
        for (input, expected) in [
            (b"zz41".as_slice(), b"A".as_slice()),
            (b"41g42\n43", b"ABC"),
            (b"41gg42\n43", b"AC"),
            (b"4g\n1", b""),
            (b"41 g 42", b"AB"),
            (b"4\x0b1", b""),
            (b"4 \t\r\n1", b"A"),
        ] {
            assert_eq!(reverse(true, &[input]).0, expected, "{input:?}");
            let split: Vec<&[u8]> = input.chunks(1).collect();
            assert_eq!(reverse(true, &split).0, expected, "{input:?} by byte");
        }
    }

    #[test]
    fn segments_carry_each_runs_offset() {
        let config = r#"{"mode":"reverse","plain":false,"segments":true,"cols":16}"#;
        let (out, err) = run("xxd", config, &[b"00000004: 6869\n00000001: 41\n42\n"]);
        assert!(err.is_none());
        let record = |start: u64, data: &[u8]| {
            [
                &start.to_le_bytes(),
                &(data.len() as u64).to_le_bytes(),
                data,
            ]
            .concat()
        };
        assert_eq!(out, [record(4, b"hi"), record(1, b"A")].concat());
        let config = r#"{"mode":"reverse","plain":false,"segments":true,"cols":16,"base":-6}"#;
        let (out, err) = run("xxd", config, &[b"00000004: 6869\n"]);
        assert_eq!(
            (out.len(), err.map(|err| err.message)),
            (0, Some(BACKWARDS.into()))
        );
    }
}
