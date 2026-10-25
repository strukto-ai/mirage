//! od as GNU coreutils 9.7 runs it in the C locale, as mirage models it:
//! the options read in the order typed, the operands read through the
//! host as one input, and the dump written a bounded window per `drain`,
//! holding the chunk in hand, a line and the one before it, or the
//! string `-S` has not seen the end of.

mod format;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;

use serde::Deserialize;
use serde_json::Value as Json;

use crate::request::{Io, Opening, Refused, Reply, Request, bytes, read_failure};
use crate::split::unit;
use crate::{Stream, StreamError, parse_config, quoted};

use self::format::{Format, Kind, Layout};

const HINT: &str = "Try 'od --help' for more information.";
/// The input one `drain` dumps.
const WINDOW: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// Every option as typed, in order: its name and its value, `true`
    /// for one typed without.
    options: Vec<(String, Json)>,
    #[serde(deserialize_with = "crate::latin1_list")]
    operands: Vec<Vec<u8>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Radix {
    #[default]
    Octal,
    Decimal,
    Hex,
    None,
}

/// A count as GNU od reads one: blanks, at most one `+`, digits in C's
/// base 0 (decimal for `-w`), then for `-j`, `-N` and `-S` one size
/// letter, alone, with `B` (powers of 1000) or with `iB` (of 1024).
fn count(raw: &[u8], label: &str, suffixes: bool) -> Result<u64, String> {
    let text = latin1(raw);
    let invalid = || format!("od: invalid {label} argument '{text}'");
    let mut at = raw
        .iter()
        .take_while(|b| b" \t\n\x0b\x0c\r".contains(b))
        .count();
    match raw.get(at) {
        Some(b'+') => at += 1,
        Some(b'-') => return Err(invalid()),
        _ => {}
    }
    let rest = &raw[at..];
    let (base, start) = match rest {
        [b'0', b'x' | b'X', next, ..] if suffixes && next.is_ascii_hexdigit() => (16, 2),
        [b'0', ..] if suffixes => (8, 0),
        _ => (10, 0),
    };
    let digits = rest[start..]
        .iter()
        .take_while(|&&b| char::from(b).is_digit(base))
        .count();
    if digits == 0 {
        return Err(invalid());
    }
    let value = rest[start..start + digits].iter().try_fold(0u128, |n, &b| {
        let digit = char::from(b).to_digit(base).unwrap_or(0);
        n.checked_mul(u128::from(base))?
            .checked_add(u128::from(digit))
    });
    let suffix = &rest[start + digits..];
    let multiplier = match suffix {
        [] => 1,
        _ if suffixes => unit(suffix)
            .map(u128::from)
            .ok_or_else(|| suffixed(label, raw))?,
        _ => return Err(suffixed(label, raw)),
    };
    value
        .and_then(|value| value.checked_mul(multiplier))
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| format!("od: {label} argument '{text}' too large"))
}

fn suffixed(label: &str, raw: &[u8]) -> String {
    format!("od: invalid suffix in {label} argument '{}'", latin1(raw))
}

/// Bytes as the text `bytes` turns back into them.
fn latin1(raw: &[u8]) -> String {
    raw.iter().map(|&b| char::from(b)).collect()
}

/// A traditional offset or label: `[+]` then octal digits, or `0x` and
/// hex digits, the octal ones times 512 for a `b` after them and 1024
/// for a `B`. GNU 9.7 reads no `.` suffix, which its help still names.
fn offset(word: &[u8]) -> Option<u64> {
    let digits = word.strip_prefix(b"+").unwrap_or(word);
    let (base, body, scale) = match digits {
        [b'0', b'x' | b'X', hex @ ..] => (16, hex, 1),
        [body @ .., b'b'] => (8, body, 512),
        [body @ .., b'B'] => (8, body, 1024),
        _ => (8, digits, 1),
    };
    if body.is_empty() {
        return None;
    }
    body.iter()
        .try_fold(0u64, |n, &b| {
            let digit = char::from(b).to_digit(base)?;
            n.checked_mul(u64::from(base))?
                .checked_add(u64::from(digit))
        })?
        .checked_mul(scale)
}

/// How many operands are files, and the offset and the label read from
/// the ones after them.
struct Operands {
    files: usize,
    skip: Option<u64>,
    label: Option<u64>,
}

/// The operands as GNU reads them: with `--traditional` at most one file,
/// then an offset and a label; otherwise only with no option but the
/// traditional ones, a sole `+OFFSET` or a second operand that is one.
fn operands(words: &[Vec<u8>], traditional: bool, modern: bool) -> Result<Operands, String> {
    let at = |index: usize| offset(&words[index]);
    let (files, skip, label) = if traditional {
        match words.iter().map(|word| offset(word)).collect::<Vec<_>>()[..] {
            [] => (0, None, None),
            [skip @ Some(_)] => (0, skip, None),
            [None] => (1, None, None),
            [skip @ Some(_), label @ Some(_)] => (0, skip, label),
            [None, skip @ Some(_)] => (1, skip, None),
            [_, skip @ Some(_), label @ Some(_)] => (1, skip, label),
            _ => {
                return Err(format!(
                    "od: extra operand '{}'\nod: compatibility mode supports at most one file\n{HINT}",
                    quoted(&words[1])
                ));
            }
        }
    } else {
        match words {
            [word] if !modern && word.first() == Some(&b'+') && at(0).is_some() => (0, at(0), None),
            [_, _] if !modern && at(1).is_some() => (1, at(1), None),
            _ => (words.len(), None, None),
        }
    };
    Ok(Operands { files, skip, label })
}

/// `--endian`'s word as argmatch reads it: one of `little` and `big`, or
/// a prefix of just one.
fn endian(raw: &[u8]) -> Result<bool, String> {
    let words: [&[u8]; 2] = [b"little", b"big"];
    if let Some(index) = words.iter().position(|word| *word == raw) {
        return Ok(index == 1);
    }
    let matches: Vec<usize> = (0..2).filter(|&i| words[i].starts_with(raw)).collect();
    if let [index] = matches[..] {
        return Ok(index == 1);
    }
    Err(format!(
        "od: {} argument '{}' for '--endian'\nValid arguments are:\n  - 'little'\n  - 'big'\n{HINT}",
        if matches.is_empty() {
            "invalid"
        } else {
            "ambiguous"
        },
        quoted(raw)
    ))
}

/// How each line starts: the address, its label after it, and the
/// spaces that stand in for them under the first type.
struct Place {
    radix: Radix,
    /// The label less the offset, `--traditional`'s LABEL.
    label: Option<u64>,
}

impl Place {
    fn number(n: u64, radix: Radix, out: &mut Vec<u8>) {
        let (base, width): (u64, usize) = match radix {
            Radix::Decimal => (10, 7),
            Radix::Hex => (16, 6),
            _ => (8, 7),
        };
        let mut text = [b'0'; 24];
        let mut at = text.len();
        let mut rest = n;
        while rest > 0 || at > text.len() - width {
            at -= 1;
            let digit = match radix {
                Radix::Decimal => rest % 10,
                _ => rest & (base - 1),
            };
            text[at] = b"0123456789abcdef"[digit as usize];
            rest = match radix {
                Radix::Decimal => rest / 10,
                _ => rest >> base.trailing_zeros(),
            };
        }
        out.extend_from_slice(&text[at..]);
    }

    /// GNU writes the address in octal and no label for `-A n`.
    fn prefix(&self, at: u64, out: &mut Vec<u8>) {
        match (self.radix, self.label) {
            (Radix::None, None) => {}
            (Radix::None, Some(_)) => {
                out.push(b'(');
                Place::number(at, Radix::Octal, out);
                out.push(b')');
            }
            (radix, label) => {
                Place::number(at, radix, out);
                if let Some(label) = label {
                    out.extend_from_slice(b" (");
                    Place::number(label.wrapping_add(at), radix, out);
                    out.push(b')');
                }
            }
        }
    }

    fn indent(&self) -> usize {
        match (self.radix, self.label) {
            (Radix::Hex, _) => 6,
            (Radix::None, None) => 0,
            _ => 7,
        }
    }
}

/// `-S`: the printable run since the last NUL or unprintable byte, which
/// a NUL ends. GNU 9.7 also prints one the `-N` limit cuts that is longer
/// than the least, at an address a byte early (or -1 wrapped), though it
/// prints none the input's end cuts; the manual's strings end in a NUL,
/// and so do all mirage prints.
struct Strings {
    least: u64,
    start: u64,
    text: Vec<u8>,
}

/// What the dump has written and holds back.
struct Dump {
    layout: Layout,
    place: Place,
    width: usize,
    dedupe: bool,
    big: bool,
    address: u64,
    block: Vec<u8>,
    previous: Vec<u8>,
    /// Whether `previous` was written, and whether a `*` stands for it.
    shown: bool,
    starred: bool,
    strings: Option<Strings>,
}

impl Dump {
    fn consume(&mut self, mut data: &[u8], out: &mut Vec<u8>) {
        if let Some(strings) = &mut self.strings {
            for (index, &byte) in data.iter().enumerate() {
                let at = self.address + index as u64;
                match byte {
                    0 => {
                        if strings.text.len() as u64 >= strings.least {
                            let start = if strings.text.is_empty() {
                                at
                            } else {
                                strings.start
                            };
                            let before = out.len();
                            self.place.prefix(start, out);
                            if out.len() > before {
                                out.push(b' ');
                            }
                            out.extend_from_slice(&strings.text);
                            out.push(b'\n');
                        }
                        strings.text.clear();
                    }
                    32..=126 => {
                        if strings.text.is_empty() {
                            strings.start = at;
                        }
                        strings.text.push(byte);
                    }
                    _ => strings.text.clear(),
                }
            }
            self.address += data.len() as u64;
            return;
        }
        if !self.block.is_empty() {
            let take = (self.width - self.block.len()).min(data.len());
            self.block.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.block.len() < self.width {
                return;
            }
            let block = std::mem::take(&mut self.block);
            self.full(&block, out);
            self.block = block;
            self.block.clear();
        }
        while data.len() >= self.width {
            let (line, rest) = data.split_at(self.width);
            self.full(line, out);
            data = rest;
        }
        self.block.extend_from_slice(data);
    }

    /// A full line, or a `*` for the run of lines repeating the last.
    fn full(&mut self, line: &[u8], out: &mut Vec<u8>) {
        if self.dedupe && self.shown && self.previous == line {
            if !self.starred {
                out.extend_from_slice(b"*\n");
                self.starred = true;
            }
        } else {
            self.lines(line, out);
            self.previous.clear();
            self.previous.extend_from_slice(line);
            self.shown = true;
            self.starred = false;
        }
        self.address += line.len() as u64;
    }

    fn lines(&mut self, block: &[u8], out: &mut Vec<u8>) {
        for index in 0..self.layout.count() {
            if index == 0 {
                self.place.prefix(self.address, out);
            } else {
                out.resize(out.len() + self.place.indent(), b' ');
            }
            self.layout.line(index, block, self.big, out);
        }
    }

    /// The last, short line and the address the input ends at.
    fn finish(&mut self, out: &mut Vec<u8>) {
        if self.strings.is_some() {
            return;
        }
        if !self.block.is_empty() {
            let block = std::mem::take(&mut self.block);
            self.lines(&block, out);
            self.address += block.len() as u64;
        }
        let before = out.len();
        self.place.prefix(self.address, out);
        if out.len() > before {
            out.push(b'\n');
        }
    }
}

/// Where the run stands: opening the first input and skipping, dumping,
/// past the input's end with the tail still to write, or done.
#[derive(PartialEq, Eq)]
enum Stage {
    Skip,
    Dump,
    Ended,
    Done,
}

struct Input {
    fd: u32,
    name: Vec<u8>,
    open: Option<(Vec<u8>, Opening)>,
}

struct Od {
    io: Io,
    files: VecDeque<(Vec<u8>, Opening)>,
    input: Option<Input>,
    chunk: Vec<u8>,
    at: usize,
    stage: Stage,
    skip: u64,
    left: Option<u64>,
    opened: bool,
    /// The width's warning, which GNU writes once an input opened and the
    /// skip is spent.
    warning: Vec<u8>,
    dump: Dump,
    stderr: Vec<u8>,
    status: i32,
}

/// What the options set, read in the order typed.
#[derive(Default)]
struct Settings {
    radix: Radix,
    skip: u64,
    limit: Option<u64>,
    strings: Option<u64>,
    width: Option<u64>,
    formats: Vec<Format>,
    duplicates: bool,
    big: bool,
    traditional: bool,
    /// An option the traditional syntax does not have was typed.
    modern: bool,
}

impl Settings {
    /// Apply option `name`, as the hosts name it: `-I`, `-O` and `-l` are
    /// `args_I`, `args_O` and `args_l` there.
    fn apply(&mut self, name: &str, value: &Json) -> Result<(), Vec<u8>> {
        let name = name.strip_prefix("args_").unwrap_or(name);
        self.take(name, value).map_err(|message| bytes(&message))
    }

    fn take(&mut self, name: &str, value: &Json) -> Result<(), String> {
        let raw = value.as_str().map(bytes).unwrap_or_default();
        let bare = !value.is_string();
        // A refusal names the option as typed: `-j` or `--skip-bytes`.
        let label = match name.len() {
            1 => format!("-{name}"),
            _ => format!("--{}", name.replace('_', "-")),
        };
        let letter = Some(name).filter(|name| name.len() == 1);
        let letter = letter.and_then(|name| Format::letter(name.as_bytes()[0]));
        self.modern |= letter.is_none() && !matches!(name, "endian" | "traditional");
        match name {
            "address_radix" => {
                self.radix = match raw.first() {
                    Some(b'd') => Radix::Decimal,
                    Some(b'o') => Radix::Octal,
                    Some(b'x') => Radix::Hex,
                    Some(b'n') => Radix::None,
                    other => {
                        let refused = char::from(other.copied().unwrap_or(0));
                        return Err(format!(
                            "od: invalid output address radix '{refused}'; it must be one character from [doxn]"
                        ));
                    }
                }
            }
            "j" | "skip_bytes" => {
                self.skip = count(&raw, &label, true)?;
            }
            "N" | "read_bytes" => {
                self.limit = Some(count(&raw, &label, true)?);
            }
            "S" | "strings" => {
                self.strings = Some(if bare { 3 } else { count(&raw, &label, true)? });
            }
            // GNU 9.7 aborts on a width of 0 or below; mirage refuses it.
            "w" | "width" => {
                self.width = Some(match bare {
                    true => 32,
                    false => match count(&raw, &label, false)? {
                        0 => return Err(format!("od: invalid {label} argument '0'")),
                        width => width,
                    },
                });
            }
            "format" => format::parse(&raw, &mut self.formats).map_err(|line| latin1(&line))?,
            "output_duplicates" => self.duplicates = true,
            "endian" => self.big = endian(&raw)?,
            "traditional" => self.traditional = true,
            _ => self
                .formats
                .push(letter.ok_or_else(|| format!("od: unknown option '{name}'"))?),
        }
        Ok(())
    }
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(match plan(config) {
        Ok(od) => Box::new(od),
        Err(stderr) => Box::new(Refused::new(stderr)),
    })
}

fn plan(config: Config) -> Result<Od, Vec<u8>> {
    let mut settings = Settings::default();
    // A refused TYPE is reported and the options read on; any other
    // refusal ends the run where it stands.
    let mut stderr = Vec::new();
    let mut refused = false;
    for (name, value) in &config.options {
        if let Err(message) = settings.apply(name, value) {
            stderr.extend_from_slice(&message);
            if name != "format" {
                return Err(stderr);
            }
            stderr.push(b'\n');
            refused = true;
        }
    }
    if refused {
        stderr.pop();
        return Err(stderr);
    }
    let s = settings;
    if s.strings.is_some() && !s.formats.is_empty() {
        return Err(b"od: no type may be specified when dumping strings".to_vec());
    }
    let Operands { files, skip, label } =
        operands(&config.operands, s.traditional, s.modern).map_err(|message| bytes(&message))?;
    let skip = skip.unwrap_or(s.skip);
    let mut formats = s.formats;
    if formats.is_empty() {
        formats.push(Format::new(Kind::Octal, 2));
    }
    // Every size is a power of two, so their least common multiple is the
    // largest.
    let unit = formats.iter().map(|f| f.size).max().unwrap_or(1) as u64;
    let mut width = s.width.unwrap_or(16);
    let mut warning = Vec::new();
    if width % unit != 0 {
        warning =
            format!("od: warning: invalid width {width}; using {unit} instead\n").into_bytes();
        width = unit;
    }
    let width = usize::try_from(width).unwrap_or(usize::MAX);
    let mut files: VecDeque<_> = (0..files)
        .map(|index| (config.operands[index].clone(), Opening::Operand(index + 1)))
        .collect();
    if files.is_empty() {
        files.push_back((b"-".to_vec(), Opening::Name));
    }
    let strings = s.strings.map(|least| Strings {
        least,
        start: 0,
        text: Vec::new(),
    });
    Ok(Od {
        io: Io::default(),
        files,
        input: None,
        chunk: Vec::new(),
        at: 0,
        stage: Stage::Skip,
        skip,
        left: s.limit,
        opened: false,
        warning,
        dump: Dump {
            layout: Layout::new(&formats, width),
            place: Place {
                radix: s.radix,
                label: label.map(|label| label.wrapping_sub(skip)),
            },
            width,
            dedupe: !s.duplicates,
            big: s.big,
            address: skip,
            block: Vec::new(),
            previous: Vec::new(),
            shown: false,
            starred: false,
            strings,
        },
        stderr: Vec::new(),
        status: 0,
    })
}

impl Od {
    /// Ask for the input the dump or the skip needs next.
    fn next(&mut self) {
        if !matches!(self.stage, Stage::Skip | Stage::Dump) || self.at < self.chunk.len() {
            return;
        }
        if self.stage == Stage::Dump && self.left == Some(0) {
            self.stage = Stage::Ended;
            return;
        }
        if self.input.is_none() {
            let Some((name, opening)) = self.files.pop_front() else {
                return self.end();
            };
            self.input = Some(Input {
                fd: self.io.fd(),
                open: Some((name.clone(), opening)),
                name,
            });
        }
        if let Some(input) = &mut self.input {
            let open = input.open.take();
            self.io.push(Request::Read { fd: input.fd, open });
        }
    }

    /// Every input has been read.
    fn end(&mut self) {
        if self.stage == Stage::Dump {
            self.stage = Stage::Ended;
            return;
        }
        if self.opened && self.skip > 0 {
            self.stderr
                .extend_from_slice(b"od: cannot skip past end of combined input\n");
            self.status = 1;
        }
        self.stage = Stage::Done;
    }

    fn start(&mut self) {
        self.stage = Stage::Dump;
        self.stderr.append(&mut self.warning);
    }
}

impl Stream for Od {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("od reads its input through requests"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if matches!(self.stage, Stage::Dump | Stage::Ended) {
            self.dump.finish(out);
        }
        self.stage = Stage::Done;
        Ok(())
    }

    fn busy(&self) -> bool {
        self.stage == Stage::Dump && self.at < self.chunk.len()
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut take = (self.chunk.len() - self.at).min(WINDOW);
        if let Some(left) = self.left {
            take = take.min(usize::try_from(left).unwrap_or(usize::MAX));
        }
        self.dump.consume(&self.chunk[self.at..self.at + take], out);
        self.at += take;
        if let Some(left) = &mut self.left {
            *left -= take as u64;
            if *left == 0 {
                self.at = self.chunk.len();
            }
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
        if self.io.idle() {
            self.next();
        }
        self.io.take(data)
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.io.in_flight.take().is_none() {
            return Err(StreamError::new("no request is waiting"));
        }
        let reply = Reply::decode(reply).map_err(StreamError::new)?;
        if let Some(fatal) = reply.fatal {
            return Err(StreamError::new(fatal));
        }
        let Some(input) = self.input.take() else {
            return Err(StreamError::new("no input is open"));
        };
        if reply.error.is_some() {
            self.status = 1;
            // A directory opens and reads as none, so it spends the skip.
            if reply.names(&["EISDIR"]) {
                self.opened = true;
                if self.stage == Stage::Skip {
                    self.skip = 0;
                    self.start();
                }
            }
            self.stderr.extend(read_failure(b"od", &input.name, &reply));
            return Ok(());
        }
        self.opened = true;
        if !reply.end {
            self.input = Some(input);
            let spent = if self.stage == Stage::Skip {
                usize::try_from(self.skip)
                    .unwrap_or(usize::MAX)
                    .min(data.len())
            } else {
                0
            };
            self.skip -= spent as u64;
            self.chunk.clear();
            self.chunk.extend_from_slice(&data[spent..]);
            self.at = 0;
        }
        if self.stage == Stage::Skip && self.skip == 0 {
            self.start();
        }
        Ok(())
    }
}
