// The plain (-p) reader follows xxd 2024-12-07 from vim, under its
// X11-MIT option (see licenses/third_party/xxd.txt).

use std::collections::VecDeque;

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

const BACKWARDS: &str = "xxd: Sorry, cannot seek backwards.";
// The most bytes one call emits while a dump's offset skips ahead.
const WINDOW: usize = 64 * 1024;
const LOWER: &[u8; 16] = b"0123456789abcdef";
const UPPER: &[u8; 16] = b"0123456789ABCDEF";

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum Config {
    Dump {
        cols: usize,
        group: usize,
        uppercase: bool,
        #[serde(deserialize_with = "crate::saturating_u64")]
        base: u64,
    },
    Plain {
        uppercase: bool,
    },
    Reverse {
        plain: bool,
        segments: bool,
    },
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(match parse_config(config)? {
        Config::Dump {
            cols,
            group,
            uppercase,
            base,
        } => {
            if cols == 0 || group == 0 {
                return Err(StreamError::new("xxd: a dump needs octets per line"));
            }
            Box::new(Dump {
                cols,
                group,
                uppercase,
                offset: base,
                held: Vec::new(),
            })
        }
        Config::Plain { uppercase } => Box::new(Plain(if uppercase { UPPER } else { LOWER })),
        Config::Reverse { plain, segments } => Box::new(Reverse {
            decoder: if plain {
                Decoder::Plain(Pairs::default())
            } else {
                Decoder::Lines(Lines::default())
            },
            segments,
            position: 0,
            pending: VecDeque::new(),
            failed: false,
        }),
    })
}

fn hex(out: &mut Vec<u8>, byte: u8, digits: &[u8; 16]) {
    out.push(digits[usize::from(byte >> 4)]);
    out.push(digits[usize::from(byte & 15)]);
}

/// The default dump: an offset, the octets in hex groups padded to a full
/// line's width, and their printable ASCII.
struct Dump {
    cols: usize,
    group: usize,
    uppercase: bool,
    offset: u64,
    held: Vec<u8>,
}

impl Dump {
    fn row(&mut self, row: &[u8], out: &mut Vec<u8>) {
        let address = if self.uppercase {
            format!("{:08X}: ", self.offset)
        } else {
            format!("{:08x}: ", self.offset)
        };
        out.extend_from_slice(address.as_bytes());
        let width = self.cols * 2 + self.cols.div_ceil(self.group) - 1;
        let start = out.len();
        for (index, group) in row.chunks(self.group).enumerate() {
            if index > 0 {
                out.push(b' ');
            }
            for &byte in group {
                hex(out, byte, if self.uppercase { UPPER } else { LOWER });
            }
        }
        let used = out.len() - start;
        out.resize(out.len() + width.saturating_sub(used) + 2, b' ');
        out.extend(row.iter().map(|&byte| {
            if (32..127).contains(&byte) {
                byte
            } else {
                b'.'
            }
        }));
        out.push(b'\n');
        self.offset += row.len() as u64;
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
        if !self.held.is_empty() {
            let row = std::mem::take(&mut self.held);
            self.row(&row, out);
        }
        Ok(())
    }
}

/// `-p`: the octets in hex, unbroken, and one newline at the end.
struct Plain(&'static [u8; 16]);

impl Stream for Plain {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.reserve(input.len() * 2);
        for &byte in input {
            hex(out, byte, self.0);
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.push(b'\n');
        Ok(())
    }
}

/// A run of decoded bytes and the offset it goes to; None continues where
/// the last run ended.
type Run = (Option<u64>, Vec<u8>);

/// The bytes the hex digit pairs at the start of `digits` spell: xxd stops at
/// the first character that is not a hex digit and drops a digit left without
/// its pair.
fn unhex(digits: impl Iterator<Item = u8>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut high = None;
    for value in digits.map(|byte| (byte as char).to_digit(16)) {
        let Some(value) = value else { break };
        match high.take() {
            Some(first) => out.push((first << 4 | value) as u8),
            None => high = Some(value),
        }
    }
    out
}

/// One hexdump line as the offset its bytes go to and the bytes. A line whose
/// offset is not hex decodes to nothing, as xxd skips it.
fn reverse_line(line: &[u8]) -> Run {
    let (offset, rest) = match memchr::memchr(b':', line) {
        Some(colon) => {
            let head = line[..colon].trim_ascii();
            let offset = std::str::from_utf8(head)
                .ok()
                .filter(|head| !head.is_empty() && head.bytes().all(|b| b.is_ascii_hexdigit()))
                .and_then(|head| u64::from_str_radix(head, 16).ok());
            match offset {
                Some(offset) => (Some(offset), &line[colon + 1..]),
                None => return (None, Vec::new()),
            }
        }
        None => (None, line),
    };
    let hex_column = memchr::memmem::find(rest, b"  ").map_or(rest, |end| &rest[..end]);
    (
        offset,
        unhex(hex_column.iter().copied().filter(|&byte| byte != b' ')),
    )
}

#[derive(Default)]
enum Mode {
    #[default]
    First,
    Rows,
    Whole,
}

/// The default hexdump, a line at a time. A first line with no offset makes
/// the whole input one run of digits, unless a later line has an offset.
#[derive(Default)]
struct Lines {
    mode: Mode,
    line: Vec<u8>,
    rest: Vec<u8>,
}

impl Lines {
    fn decode(&mut self, input: &[u8], eof: bool, runs: &mut Vec<Run>) {
        let mut data = input;
        if let Mode::Whole = self.mode {
            self.rest.extend_from_slice(data);
            if eof {
                self.whole(runs);
            }
            return;
        }
        loop {
            let (ended, take) = match memchr::memchr(b'\n', data) {
                Some(end) => (true, end),
                None => (false, data.len()),
            };
            self.line.extend_from_slice(&data[..take]);
            if !ended && !eof {
                return;
            }
            data = &data[(take + usize::from(ended)).min(data.len())..];
            let line = std::mem::take(&mut self.line);
            if line.is_empty() && !ended {
                return;
            }
            if let Mode::First = self.mode {
                if !line.is_empty() && memchr::memchr(b':', &line).is_none() {
                    self.mode = Mode::Whole;
                    self.line = line;
                    if ended {
                        self.rest.push(b'\n');
                        self.rest.extend_from_slice(data);
                        if !eof {
                            return;
                        }
                    }
                    self.whole(runs);
                    return;
                }
            }
            if !line.is_empty() {
                self.mode = Mode::Rows;
                runs.push(reverse_line(&line));
            }
        }
    }

    fn whole(&mut self, runs: &mut Vec<Run>) {
        let mut text = std::mem::take(&mut self.line);
        text.append(&mut self.rest);
        let rows: Vec<&[u8]> = text.split(|&byte| byte == b'\n').collect();
        if rows.iter().any(|row| memchr::memchr(b':', row).is_some()) {
            runs.extend(
                rows.iter()
                    .filter(|row| !row.is_empty())
                    .map(|row| reverse_line(row)),
            );
            return;
        }
        let digits = rows.iter().flat_map(|row| {
            row.iter()
                .copied()
                .take_while(|byte| {
                    byte.is_ascii_hexdigit() || byte.is_ascii_whitespace() || *byte == 0x0b
                })
                .filter(|byte| byte.is_ascii_hexdigit())
        });
        runs.push((None, unhex(digits)));
    }
}

/// A plain (`-p`) hexdump as it arrives. Space, tab, CR and LF never count,
/// so two digits make a byte across them and across lines. Any other byte is
/// ignored before the first digit and after a skipped line; past that it
/// drops a digit left without its pair, and a run of them skips the rest of
/// the line.
struct Pairs {
    high: i8,
    low: i8,
    lead: bool,
    skip: bool,
}

impl Default for Pairs {
    fn default() -> Self {
        Self {
            high: 0,
            low: -1,
            lead: true,
            skip: false,
        }
    }
}

impl Pairs {
    fn decode(&mut self, input: &[u8], runs: &mut Vec<Run>) {
        let mut out = Vec::new();
        for &byte in input {
            if self.skip {
                if byte == b'\n' {
                    (self.skip, self.lead) = (false, true);
                }
                continue;
            }
            if matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
                continue;
            }
            let before = self.high;
            self.high = self.low;
            self.low = (byte as char).to_digit(16).map_or(-1, |value| value as i8);
            if self.low < 0 && self.lead {
                continue;
            }
            self.lead = false;
            if self.high >= 0 && self.low >= 0 {
                out.push((self.high << 4 | self.low) as u8);
                self.low = -1;
            } else if self.low < 0 && self.high < 0 && before < 0 {
                self.skip = true;
            }
        }
        if !out.is_empty() {
            runs.push((None, out));
        }
    }
}

enum Decoder {
    Lines(Lines),
    Plain(Pairs),
}

enum Piece {
    Gap(u64),
    Data(Vec<u8>),
}

/// `-r`: a hexdump back into bytes. Onto a stream, which only moves
/// forward, an offset past the bytes written is reached with NUL bytes and
/// one before them is refused; with `segments`, each run goes out as a
/// little-endian start and length ahead of its bytes, for a host that
/// writes them into a file at their offsets.
struct Reverse {
    decoder: Decoder,
    segments: bool,
    position: u64,
    pending: VecDeque<Piece>,
    failed: bool,
}

impl Reverse {
    fn take(&mut self, input: &[u8], eof: bool, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut runs = Vec::new();
        if !self.failed {
            match &mut self.decoder {
                Decoder::Lines(lines) => lines.decode(input, eof, &mut runs),
                Decoder::Plain(pairs) => pairs.decode(input, &mut runs),
            }
        }
        for (offset, data) in runs {
            if data.is_empty() {
                continue;
            }
            if self.segments {
                self.position = offset.unwrap_or(self.position);
                out.extend_from_slice(&self.position.to_le_bytes());
                out.extend_from_slice(&(data.len() as u64).to_le_bytes());
                out.extend_from_slice(&data);
                self.position += data.len() as u64;
                continue;
            }
            let target = offset.unwrap_or(self.position);
            if target < self.position {
                self.failed = true;
                break;
            }
            if target > self.position {
                self.pending.push_back(Piece::Gap(target - self.position));
            }
            self.position = target + data.len() as u64;
            self.pending.push_back(Piece::Data(data));
        }
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
        self.take(input, false, out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.take(&[], true, out)
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
    use crate::run;

    fn dump(config: &str, chunks: &[&[u8]]) -> String {
        let (out, err) = run("xxd", config, chunks);
        assert!(err.is_none());
        String::from_utf8(out).unwrap()
    }

    fn reverse(plain: bool, chunks: &[&[u8]]) -> (Vec<u8>, Option<String>) {
        let config = format!(r#"{{"mode":"reverse","plain":{plain},"segments":false}}"#);
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
    }

    #[test]
    fn a_plain_dump_ends_in_one_newline() {
        let config = r#"{"mode":"plain","uppercase":false}"#;
        assert_eq!(dump(config, &[b"\x00\xff", b"A"]), "00ff41\n");
        assert_eq!(dump(config, &[]), "\n");
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
    fn a_reverse_line_without_an_offset_reads_the_whole_input_as_digits() {
        assert_eq!(reverse(false, &[b"\n68 65\n6c", b"zz\n6c"]).0, b"hell");
        assert_eq!(reverse(false, &[b"6869\n00000003: 41  A\n"]).0, b"hi\0A");
        assert_eq!(
            reverse(false, &[b"00000000: 68zz 69  h.i\nzz: 41\n6a"]).0,
            b"hj"
        );
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
        let config = r#"{"mode":"reverse","plain":false,"segments":true}"#;
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
        assert_eq!(
            out,
            [record(4, b"hi"), record(1, b"A"), record(2, b"B")].concat()
        );
    }
}
