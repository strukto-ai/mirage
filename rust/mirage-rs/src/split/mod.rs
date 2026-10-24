//! split and csplit as GNU coreutils 9.7 runs them, as mirage models
//! them: each reads its input and writes its pieces through requests the
//! host serves, a bounded step per `drain`, holding no more than a chunk
//! of input and one piece's pending write (csplit also a line it tests,
//! and the lines a negative offset looks back over).

pub(crate) mod csplit;
mod pieces;

#[cfg(test)]
mod tests;

use serde::Deserialize;
use serde_json::Value as Json;

use crate::request::{Io, Opening, Reply, Request, WriteMode, bytes};
use crate::{Stream, StreamError, parse_config, quoted};

use self::pieces::{Input, Piece, Refused, STEPS, read_failure, write_failure};

const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const DECIMAL: &[u8] = b"0123456789";
const HEX: &[u8] = b"0123456789abcdef";

/// The size letters split takes after a byte count (coreutils 9.7): every
/// power letter in upper case, `k` and `m` in lower case, and `b`.
const SIZE_LETTERS: &[u8] = b"bkKmMEGPQRTYZ";
const POWERS: &[u8] = b"KMGTPEZYRQ";

const HINT: &[u8] = b"\nTry 'split --help' for more information.";

/// The pieces r/N writes in one pass over the spool.
const GROUP: u64 = 16;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    lines: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    bytes: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    number: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    suffix_length: Option<Vec<u8>>,
    /// -d, or `--numeric-suffixes=START`: `true`, or the start as typed.
    #[serde(default)]
    numeric_suffixes: Option<Json>,
    #[serde(default)]
    hex_suffixes: Option<Json>,
    #[serde(default, deserialize_with = "crate::latin1")]
    additional_suffix: Vec<u8>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    separator: Option<Vec<u8>>,
    /// INPUT and PREFIX as typed, and any extra operand.
    #[serde(default, deserialize_with = "crate::latin1_list")]
    operands: Vec<Vec<u8>>,
}

/// How the input is cut into pieces.
#[derive(Clone, Copy)]
enum Mode {
    /// -l and -b: `limit` lines, or bytes, a piece.
    Cut { limit: u64, lines: bool },
    /// -n: `count` pieces of the whole input, by bytes, by lines or round
    /// robin; `only` writes the one, from 1, to the output and no file.
    Chunks {
        kind: Kind,
        count: u64,
        only: Option<u64>,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Bytes,
    Lines,
    RoundRobin,
}

/// The output names' suffixes in GNU's order: with no width and no start
/// given they widen as they run out, the alphabet's last character a
/// reserved prefix (aa..yz, zaaa..zyzz, zzaaaa..); a width or a start
/// pins the width, and running past it is the suffixes' exhaustion.
struct Suffixes {
    alphabet: &'static [u8],
    digits: Vec<u8>,
    widen: bool,
    band: usize,
    exhausted: bool,
}

impl Suffixes {
    fn next(&mut self) -> Option<Vec<u8>> {
        if self.exhausted {
            return None;
        }
        let last = self.alphabet[self.alphabet.len() - 1];
        let mut name = vec![last; self.band];
        name.extend(self.digits.iter().map(|&d| self.alphabet[usize::from(d)]));
        let top = u8::try_from(self.alphabet.len() - 1).unwrap_or(u8::MAX);
        let mut carry = true;
        for digit in self.digits.iter_mut().rev() {
            if *digit == top {
                *digit = 0;
            } else {
                *digit += 1;
                carry = false;
                break;
            }
        }
        if self.widen && self.digits.first() == Some(&top) {
            self.band += 1;
            self.digits = vec![0; self.band + 2];
        } else if carry {
            self.exhausted = true;
        }
        Some(name)
    }
}

struct Plan {
    mode: Mode,
    separator: u8,
    suffixes: Suffixes,
    input: Vec<u8>,
    prefix: Vec<u8>,
    additional: Vec<u8>,
}

/// A count as split and od read one: C blanks, at most one `+`, and
/// decimal digits; a value past u128 saturates.
fn count(raw: &[u8]) -> Option<u128> {
    let start = raw
        .iter()
        .position(|b| !b" \t\n\x0b\x0c\r".contains(b))
        .unwrap_or(raw.len());
    let digits = raw[start..].strip_prefix(b"+").unwrap_or(&raw[start..]);
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(digits.iter().fold(0u128, |n, d| {
        n.saturating_mul(10).saturating_add(u128::from(d - b'0'))
    }))
}

fn saturate(value: u128) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn refusal(what: &str, value: &[u8]) -> Vec<u8> {
    format!("split: invalid {what}: '{}'", quoted(value)).into_bytes()
}

/// A positive count, or split's refusal of it.
fn positive(value: &[u8], what: &str) -> Result<u64, Vec<u8>> {
    count(value)
        .filter(|&n| n > 0)
        .map(saturate)
        .ok_or_else(|| refusal(what, value))
}

/// The multiplier a byte count's suffix stands for.
fn unit(suffix: &[u8]) -> Option<u64> {
    let (&letter, tail) = suffix.split_first()?;
    if !SIZE_LETTERS.contains(&letter) {
        return None;
    }
    if letter == b'b' {
        return tail.is_empty().then_some(512);
    }
    let power = POWERS
        .iter()
        .position(|&p| p == letter.to_ascii_uppercase())?
        + 1;
    let base: u64 = match tail {
        b"" | b"iB" => 1024,
        b"B" => 1000,
        _ => return None,
    };
    Some((0..power).fold(1u64, |n, _| n.saturating_mul(base)))
}

fn byte_count(value: &[u8]) -> Result<u64, Vec<u8>> {
    let (digits, multiplier) = (1..=3.min(value.len()))
        .rev()
        .find_map(|len| {
            Some((
                &value[..value.len() - len],
                unit(&value[value.len() - len..])?,
            ))
        })
        .unwrap_or((value, 1));
    let digits =
        positive(digits, "number of bytes").map_err(|_| refusal("number of bytes", value))?;
    Ok(digits.saturating_mul(multiplier))
}

/// -n as GNU reads it: one leading `l/` or `r/`, then K/N cut at the
/// first slash. A K that does not parse names the rest whole; every
/// other refusal names N, however many slashes it holds; a K of 0 or
/// past N is refused after N.
fn chunks(value: &[u8]) -> Result<Mode, Vec<u8>> {
    let (kind, spec) = match value {
        [b'l', b'/', rest @ ..] => (Kind::Lines, rest),
        [b'r', b'/', rest @ ..] => (Kind::RoundRobin, rest),
        _ => (Kind::Bytes, value),
    };
    let slash = spec.iter().position(|&b| b == b'/');
    let (head, count_raw) = match slash {
        Some(at) => (Some(&spec[..at]), &spec[at + 1..]),
        None => (None, spec),
    };
    let only = match head {
        Some(head) => Some(saturate(
            count(head).ok_or_else(|| refusal("number of chunks", spec))?,
        )),
        None => None,
    };
    let count = positive(count_raw, "number of chunks")?;
    if let (Some(head), Some(k)) = (head, only) {
        if k == 0 || k > count {
            return Err(format!("split: invalid chunk number: '{}'", quoted(head)).into_bytes());
        }
    }
    Ok(Mode::Chunks { kind, count, only })
}

/// -a: past 2**64 - 1 GNU refuses the width as it reads the option,
/// where a count saturates, since a width that size would be built into
/// a name.
fn suffix_length(value: &[u8]) -> Result<usize, Vec<u8>> {
    let length = count(value).ok_or_else(|| refusal("suffix length", value))?;
    if length > u128::from(u64::MAX) {
        let mut refused = refusal("suffix length", value);
        refused.extend_from_slice(b": Value too large for defined data type");
        return Err(refused);
    }
    Ok(usize::try_from(length).unwrap_or(usize::MAX))
}

/// The digits of `digits` (in `from`) in base `to`, most significant first.
fn rebase(digits: &[u8], from: u32, to: u32) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    for &digit in digits {
        let mut carry = u32::from(digit);
        for place in out.iter_mut() {
            let value = u32::from(*place) * from + carry;
            *place = (value % to) as u8;
            carry = value / to;
        }
        while carry > 0 {
            out.push((carry % to) as u8);
            carry /= to;
        }
    }
    out.reverse();
    out
}

/// A `--numeric-suffixes=`/`--hex-suffixes=` start, as digit values of
/// its own base. The refused value comes first in its clause; hex digits
/// are lower case only, as GNU's own suffixes are; an empty value is a
/// start of 0 that still pins the width.
fn suffix_start(value: &[u8], hex: bool, width: usize) -> Result<Vec<u8>, Vec<u8>> {
    let digit = |b: &u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' if hex => Some(b - b'a' + 10),
        _ => None,
    };
    let digits: Option<Vec<u8>> = value.iter().map(digit).collect();
    let digits = match digits {
        Some(digits) if !value.is_empty() => digits,
        _ if value.is_empty() => return Ok(Vec::new()),
        _ => {
            let kind = if hex { "hexadecimal" } else { "numerical" };
            let mut refused = format!(
                "split: '{}': invalid start value for {kind} suffix",
                quoted(value)
            )
            .into_bytes();
            refused.extend_from_slice(HINT);
            return Err(refused);
        }
    };
    let significant = digits.iter().skip_while(|&&d| d == 0).count().max(1);
    if significant > width {
        let mut refused =
            b"split: numerical suffix start value is too large for the suffix length".to_vec();
        refused.extend_from_slice(HINT);
        return Err(refused);
    }
    Ok(digits)
}

fn start_text(value: &Json) -> Option<Vec<u8>> {
    value.as_str().map(bytes)
}

fn plan(config: Config) -> Result<Plan, Vec<u8>> {
    // GNU reads an explicit `-a 0` as the default width that still widens.
    let length = config
        .suffix_length
        .as_deref()
        .map(suffix_length)
        .transpose()?;
    let width = length.filter(|&n| n > 0).unwrap_or(2);
    let numeric = config.numeric_suffixes.as_ref();
    let hex = config.hex_suffixes.as_ref();
    let start = match (numeric.and_then(start_text), hex.and_then(start_text)) {
        (Some(start), _) => Some((suffix_start(&start, false, width)?, 10)),
        (None, Some(start)) => Some((suffix_start(&start, true, width)?, 16)),
        (None, None) => None,
    };
    let lines = config
        .lines
        .as_deref()
        .map(|v| positive(v, "number of lines"))
        .transpose()?;
    let byte_limit = config.bytes.as_deref().map(byte_count).transpose()?;
    let number = config.number.as_deref().map(chunks).transpose()?;
    let separator = match config.separator.as_deref() {
        None => b'\n',
        Some(b"\\0") => 0,
        Some([]) => return Err(b"split: empty record separator".to_vec()),
        Some([byte]) => *byte,
        Some(value) => {
            return Err(
                format!("split: multi-character separator '{}'", quoted(value)).into_bytes(),
            );
        }
    };
    if let Some(extra) = config.operands.get(2) {
        let mut refused = b"split: extra operand '".to_vec();
        refused.extend_from_slice(extra);
        refused.push(b'\'');
        refused.extend_from_slice(HINT);
        return Err(refused);
    }
    let mode = match (number, byte_limit, lines) {
        (Some(mode), ..) => mode,
        (None, Some(limit), _) => Mode::Cut {
            limit,
            lines: false,
        },
        (None, None, lines) => Mode::Cut {
            limit: lines.unwrap_or(1000),
            lines: true,
        },
    };
    let alphabet = match (hex.is_some(), numeric.is_some()) {
        (true, _) => HEX,
        (false, true) => DECIMAL,
        _ => ALPHA,
    };
    let widen = length.unwrap_or(0) == 0 && start.is_none();
    let base = u32::try_from(alphabet.len()).unwrap_or(26);
    let mut digits = match start {
        Some((digits, from)) => rebase(&digits, from, base),
        None => Vec::new(),
    };
    let exhausted = digits.len() > width;
    if !exhausted {
        digits.splice(0..0, std::iter::repeat_n(0, width - digits.len()));
    }
    let mut operands = config.operands.into_iter();
    Ok(Plan {
        mode,
        separator,
        suffixes: Suffixes {
            alphabet,
            digits,
            widen,
            band: 0,
            exhausted,
        },
        input: operands.next().unwrap_or_else(|| b"-".to_vec()),
        prefix: operands.next().unwrap_or_else(|| b"x".to_vec()),
        additional: config.additional_suffix,
    })
}

/// Where the bytes of the piece being cut go: a file, or the output for
/// the one r/K/N keeps.
enum Sink {
    File(Piece),
    Out,
}

/// What a run does now: -l and -b read the input; -n has the host spool
/// it, then cuts the spool a piece at a time, reading it only where l/N
/// looks for a piece's end.
#[derive(PartialEq, Eq)]
enum Phase {
    Read,
    Fill,
    Pass,
    Done,
}

struct Split {
    io: Io,
    plan: Plan,
    input: Input,
    sink: Option<Sink>,
    /// The pieces r/N writes this pass, from piece `index`.
    group: Vec<Sink>,
    phase: Phase,
    /// The lines or bytes in the piece being cut.
    filled: u64,
    spool: u32,
    /// The input's length, once spooled.
    size: u64,
    /// The bytes the pieces cut so far hold; under l/N, the bytes scanned
    /// for the piece's end.
    pos: u64,
    scanned: u64,
    /// The piece being cut, from 0; under r/N, this pass's.
    index: u64,
    /// Under r/N, the lines this pass has read.
    line: u64,
    status: i32,
    stderr: Vec<u8>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let plan = match plan(config) {
        Ok(plan) => plan,
        Err(refused) => return Ok(Box::new(Refused::new(refused))),
    };
    let mut io = Io::default();
    let input = Input::new(&mut io, plan.input.clone(), Opening::Operand(1));
    let phase = match plan.mode {
        Mode::Chunks { .. } => Phase::Fill,
        _ => Phase::Read,
    };
    let spool = io.fd();
    Ok(Box::new(Split {
        io,
        plan,
        input,
        sink: None,
        group: Vec::new(),
        phase,
        filled: 0,
        spool,
        size: 0,
        pos: 0,
        scanned: 0,
        index: 0,
        line: 0,
        status: 0,
        stderr: Vec::new(),
    }))
}

/// Where chunk `index` (from 1) of `count` ends in `size` bytes: `size /
/// count` each, the remainder spread a byte at a time over the first.
fn chunk_end(index: u64, size: u64, count: u64) -> u64 {
    let (base, rem) = (size / count, size % count);
    let index = u128::from(index);
    let end = u128::from(base) * index + index.min(u128::from(rem));
    u64::try_from(end).unwrap_or(u64::MAX)
}

impl Split {
    fn fail(&mut self, message: &[u8]) {
        self.stderr.extend_from_slice(message);
        self.status = 1;
        self.phase = Phase::Done;
        self.io.requests.clear();
        self.sink = None;
    }

    /// The next piece's file, named by the next suffix.
    fn name(&mut self) -> Option<Vec<u8>> {
        let Some(suffix) = self.plan.suffixes.next() else {
            self.fail(b"split: output file suffixes exhausted\n");
            return None;
        };
        Some([self.plan.prefix.as_slice(), &suffix, &self.plan.additional].concat())
    }

    /// Start the next piece's file.
    fn start(&mut self) -> bool {
        let Some(name) = self.name() else {
            return false;
        };
        self.sink = Some(Sink::File(Piece::new(name)));
        true
    }

    fn put(&mut self, from: usize, to: usize, out: &mut Vec<u8>) {
        let data = &self.input.buf[self.input.at + from..self.input.at + to];
        match &mut self.sink {
            Some(Sink::File(piece)) => piece.put(data, &mut self.io),
            Some(Sink::Out) => out.extend_from_slice(data),
            None => {}
        }
    }

    fn close(&mut self) {
        if let Some(Sink::File(piece)) = self.sink.take() {
            piece.close(&mut self.io);
        }
        self.filled = 0;
    }

    /// Whether the input has bytes to read now; asks for more when it has
    /// none and has not ended.
    fn ready(&mut self) -> bool {
        if self.input.rest().is_empty() && !self.input.ended {
            self.input.pull(&mut self.io);
            return false;
        }
        true
    }

    /// One bounded step: at most one chunk read, one piece written.
    fn step(&mut self, out: &mut Vec<u8>) {
        if self.phase == Phase::Fill {
            let open = (self.plan.input.clone(), Opening::Operand(1));
            self.io.push(Request::Fill {
                spool: self.spool,
                open,
            });
            return;
        }
        let (kind, count, only) = match self.plan.mode {
            Mode::Cut { limit, lines } => {
                if self.ready() {
                    self.cut(limit, lines, out);
                }
                return;
            }
            Mode::Chunks { kind, count, only } => (kind, count, only),
        };
        let done = match only {
            Some(k) => self.index >= k,
            None => self.index >= count,
        };
        if done {
            self.phase = Phase::Done;
            if !self.input.ended {
                self.io.push(Request::Close { fd: self.input.fd });
            }
            return;
        }
        match kind {
            Kind::Bytes => {
                let (start, end) = (
                    chunk_end(self.index, self.size, count),
                    chunk_end(self.index + 1, self.size, count),
                );
                self.range(start, end - start, only);
            }
            Kind::Lines => self.line_chunk(count, only),
            Kind::RoundRobin => self.round_robin(count, only, out),
        }
    }

    /// -l and -b: `limit` lines or bytes a piece, each started by the first
    /// byte it holds.
    fn cut(&mut self, limit: u64, lines: bool, out: &mut Vec<u8>) {
        let rest = self.input.rest().len();
        if rest == 0 {
            self.close();
            self.phase = Phase::Done;
            return;
        }
        if self.sink.is_none() && !self.start() {
            return;
        }
        let need = limit - self.filled;
        let (take, full) = if lines {
            let separator = self.plan.separator;
            let mut seen = 0;
            let end = memchr::memchr_iter(separator, self.input.rest()).find(|_| {
                seen += 1;
                seen == need
            });
            match end {
                Some(at) => (at + 1, true),
                None => {
                    self.filled += seen;
                    (rest, false)
                }
            }
        } else {
            let take = usize::try_from(need).unwrap_or(usize::MAX).min(rest);
            self.filled += take as u64;
            (take, self.filled == limit)
        };
        self.put(0, take, out);
        self.input.at += take;
        if full {
            self.close();
        }
    }

    /// Piece `index` of -n: `size` bytes of the spool from `start`, which
    /// the host writes to its file, or to the output under K/N.
    fn range(&mut self, start: u64, size: u64, only: Option<u64>) {
        match only {
            Some(k) if self.index + 1 == k => {
                if size > 0 {
                    self.io.push(Request::Emit {
                        fd: self.spool,
                        window: Some((start, size)),
                    });
                }
            }
            Some(_) => {}
            None => {
                let Some(path) = self.name() else {
                    return;
                };
                let mode = WriteMode::Window {
                    fd: self.spool,
                    skip: start,
                    size,
                };
                self.io.push(Request::Write {
                    path,
                    mode,
                    data: Vec::new(),
                });
            }
        }
        self.index += 1;
    }

    /// -n l/N: a piece ends at the first separator at or past the byte
    /// where its share of `max(size, N)` ends, which it reads the spool
    /// from; a piece whose share ends before the bytes cut is empty, and
    /// past the input's end every piece left is.
    fn line_chunk(&mut self, count: u64, only: Option<u64>) {
        let end = chunk_end(self.index + 1, self.size.max(count), count);
        if self.phase == Phase::Pass {
            if self.pos >= self.size && only.is_some() {
                self.index = u64::MAX;
                return;
            }
            if self.pos >= self.size || (self.pos > 0 && end <= self.pos) {
                return self.range(self.pos, 0, only);
            }
            let threshold = self.pos.max(end - 1);
            if threshold >= self.size {
                let (start, size) = (self.pos, self.size - self.pos);
                self.pos = self.size;
                return self.range(start, size, only);
            }
            self.rewind(threshold);
            self.phase = Phase::Read;
            return;
        }
        if !self.ready() {
            return;
        }
        let rest = self.input.rest();
        let cut = match memchr::memchr(self.plan.separator, rest) {
            Some(at) => self.scanned + at as u64 + 1,
            None if self.input.ended => self.size,
            None => {
                self.scanned += rest.len() as u64;
                self.input.at = self.input.buf.len();
                return;
            }
        };
        if !self.input.ended {
            self.io.push(Request::Close { fd: self.input.fd });
        }
        self.phase = Phase::Pass;
        let start = std::mem::replace(&mut self.pos, cut);
        self.range(start, cut - start, only);
    }

    /// Read the spool from byte `skip`.
    fn rewind(&mut self, skip: u64) {
        let opening = Opening::Spool {
            fd: self.spool,
            skip,
        };
        self.input = Input::new(&mut self.io, Vec::new(), opening);
        self.scanned = skip;
        self.line = 0;
    }

    /// -n r/N: line J goes to piece J mod N. A pass over the spool writes
    /// up to GROUP pieces from piece `index`, their files created in order
    /// before it reads; r/K/N writes piece K to the output.
    fn round_robin(&mut self, count: u64, only: Option<u64>, out: &mut Vec<u8>) {
        let want = if only.is_some() {
            1
        } else {
            GROUP.min(count - self.index)
        };
        if (self.group.len() as u64) < want {
            let sink = match only {
                Some(_) => Sink::Out,
                None => {
                    let Some(name) = self.name() else {
                        return;
                    };
                    // The group holds what one piece would.
                    let mut piece = Piece::new(name);
                    piece.limit /= usize::try_from(want).unwrap_or(1);
                    piece.create(&mut self.io);
                    Sink::File(piece)
                }
            };
            self.group.push(sink);
            if self.group.len() as u64 == want {
                self.rewind(0);
            }
            return;
        }
        if !self.ready() {
            return;
        }
        let rest = self.input.rest();
        if rest.is_empty() {
            for sink in std::mem::take(&mut self.group) {
                if let Sink::File(piece) = sink {
                    piece.close(&mut self.io);
                }
            }
            self.index += want;
            return;
        }
        let (end, ended) = match memchr::memchr(self.plan.separator, rest) {
            Some(at) => (at + 1, true),
            None => (rest.len(), false),
        };
        let slot = (self.line % count).checked_sub(self.index);
        if let Some(sink) = slot.and_then(|at| self.group.get_mut(usize::try_from(at).ok()?)) {
            let data = &self.input.buf[self.input.at..self.input.at + end];
            match sink {
                Sink::File(piece) => piece.put(data, &mut self.io),
                Sink::Out => out.extend_from_slice(data),
            }
        }
        self.input.at += end;
        if ended {
            self.line += 1;
        }
    }

    fn answer(&mut self, reply: &[u8], data: &[u8]) -> Result<(), StreamError> {
        let reply = Reply::decode(reply).map_err(StreamError::new)?;
        let Some(request) = self.io.in_flight.take() else {
            return Err(StreamError::new("no request is waiting"));
        };
        if let Some(fatal) = &reply.fatal {
            self.fail(&[b"split: ", bytes(fatal).as_slice(), b"\n"].concat());
            return Ok(());
        }
        match request {
            Request::Read { .. } | Request::Fill { .. } if reply.error.is_some() => {
                let line = read_failure(b"split", &self.plan.input, &reply);
                self.fail(&line);
            }
            Request::Read { .. } => {
                self.input.answer(reply, data);
            }
            Request::Fill { .. } => {
                self.size = reply.size;
                self.phase = Phase::Pass;
                self.index = match self.plan.mode {
                    Mode::Chunks {
                        kind: Kind::Bytes | Kind::RoundRobin,
                        only: Some(k),
                        ..
                    } => k - 1,
                    _ => 0,
                };
            }
            _ => {
                if let Some((name, text)) = write_failure(&request, &reply) {
                    self.fail(&[b"split: ".as_slice(), &name, b": ", &text, b"\n"].concat());
                }
            }
        }
        Ok(())
    }
}

impl Stream for Split {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("split reads its input through requests"))
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn busy(&self) -> bool {
        self.io.idle() && self.phase != Phase::Done
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        for _ in 0..STEPS {
            if !self.busy() {
                break;
            }
            self.step(out);
        }
        Ok(())
    }

    fn status(&self) -> i32 {
        self.status
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }

    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        self.io.take(data)
    }

    fn respond(
        &mut self,
        reply: &[u8],
        data: &[u8],
        _out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        self.answer(reply, data)
    }
}
