//! hexdump as util-linux 2.41.5 runs it in the C locale, as mirage models
//! it: the display options and format strings read in the order typed,
//! each a list of units a block runs through, the operands read through
//! the host as one input, and the dump written a bounded window per
//! `drain`, holding the chunk in hand, a block and the one before it.

mod format;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;

use serde::Deserialize;
use serde_json::Value as Json;

use crate::request::{Io, Opening, Refused, Reply, Request, bytes, read_failure};
use crate::{Stream, StreamError, parse_config};

use self::format::{Format, Kind, Unit};

/// The input one `drain` dumps.
const WINDOW: usize = 16 * 1024;
/// The least skip a file opens past rather than reads through.
const SEEK: u64 = 1 << 20;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// Every option as typed, in order: its name and its value, `true`
    /// for one typed without.
    options: Vec<(String, Json)>,
    #[serde(deserialize_with = "crate::latin1_list")]
    operands: Vec<Vec<u8>>,
}

/// A format the options name: read now, or a file of them still to read.
enum Source {
    Read(Vec<Format>),
    File(Vec<u8>),
}

/// A size as util-linux reads one: blanks, at most one `+`, digits in C's
/// base 0, a decimal fraction, then a power of 1024 (`K`, `KiB`) or of
/// 1000 (`KB`), up to `Y`.
fn size(raw: &[u8], what: &str) -> Result<u64, String> {
    let fail = |why: &str| {
        format!(
            "hexdump: failed to parse {what}: '{}': {why}",
            crate::byte_text(raw)
        )
    };
    let invalid = || fail("Invalid argument");
    let range = || fail("Numerical result out of range");
    let mut text = raw.trim_ascii_start();
    if let Some(rest) = text.strip_prefix(b"+") {
        text = rest;
    }
    let (base, body) = match text {
        [b'0', b'x' | b'X', next, ..] if next.is_ascii_hexdigit() => (16, &text[2..]),
        [b'0', ..] => (8, text),
        _ => (10, text),
    };
    let count = body
        .iter()
        .take_while(|b| char::from(**b).is_digit(base))
        .count();
    if count == 0 {
        return Err(invalid());
    }
    let mut value: u128 = 0;
    for &b in &body[..count] {
        let digit = char::from(b).to_digit(base).unwrap_or(0);
        value = value
            .checked_mul(u128::from(base))
            .and_then(|v| v.checked_add(u128::from(digit)))
            .filter(|v| *v <= u128::from(u64::MAX))
            .ok_or_else(range)?;
    }
    let mut rest = &body[count..];
    let mut fraction: Option<&[u8]> = None;
    if let Some(after) = rest.strip_prefix(b".") {
        let digits = after.iter().take_while(|b| b.is_ascii_digit()).count();
        fraction = Some(&after[..digits]);
        rest = &after[digits..];
    }
    let Some((&letter, tail)) = rest.split_first() else {
        return match fraction {
            Some(_) => Err(invalid()),
            None => Ok(value as u64),
        };
    };
    let power = b"KMGTPEZY"
        .iter()
        .position(|&unit| unit == letter.to_ascii_uppercase())
        .ok_or_else(invalid)? as u32
        + 1;
    let step: u128 = match tail {
        [] => 1024,
        [b'i' | b'I', b'B' | b'b'] => 1024,
        [b'B' | b'b'] => 1000,
        _ => return Err(invalid()),
    };
    let multiplier = step.checked_pow(power).ok_or_else(range)?;
    let mut total = value.checked_mul(multiplier).ok_or_else(range)?;
    if let Some(digits) = fraction.filter(|digits| !digits.is_empty()) {
        let mut numerator: u128 = 0;
        let mut scale: u128 = 1;
        for &b in digits.iter().take(20) {
            numerator = numerator * 10 + u128::from(b - b'0');
            scale *= 10;
        }
        let part = numerator
            .checked_mul(multiplier)
            .map(|n| n / scale)
            .ok_or_else(range)?;
        total = total.checked_add(part).ok_or_else(range)?;
    }
    u64::try_from(total).map_err(|_| range())
}

/// What the options set, read in the order typed.
#[derive(Default)]
struct Settings {
    sources: Vec<Source>,
    length: Option<u64>,
    skip: u64,
    verbose: bool,
}

impl Settings {
    fn take(&mut self, name: &str, value: &Json) -> Result<(), String> {
        let raw = value.as_str().map(bytes).unwrap_or_default();
        let preset = match name {
            "one_byte_octal" => Some(format::ONE_BYTE_OCTAL),
            "one_byte_hex" => Some(format::ONE_BYTE_HEX),
            "one_byte_char" => Some(format::ONE_BYTE_CHAR),
            "canonical" => Some(format::CANONICAL),
            "two_bytes_decimal" => Some(format::TWO_BYTES_DECIMAL),
            "two_bytes_octal" => Some(format::TWO_BYTES_OCTAL),
            "two_bytes_hex" => Some(format::TWO_BYTES_HEX),
            _ => None,
        };
        if let Some(preset) = preset {
            self.sources.push(Source::Read(presets(preset)));
            return Ok(());
        }
        match name {
            "format" => self.sources.push(Source::Read(vec![format::parse(&raw)?])),
            "format_file" => self.sources.push(Source::File(raw)),
            "length" => self.length = Some(size(&raw, "length")?),
            "skip" => self.skip = size(&raw, "offset")?,
            "no_squeezing" => self.verbose = true,
            // mirage writes no color, so a mode only has to be one.
            "color" => {
                if value.is_string() && !matches!(&raw[..], b"always" | b"never" | b"auto") {
                    return Err(format!(
                        "hexdump: unsupported color mode: '{}'",
                        crate::byte_text(&raw)
                    ));
                }
            }
            _ => return Err(format!("hexdump: unknown option '{name}'")),
        }
        Ok(())
    }
}

fn presets(preset: &[&[u8]]) -> Vec<Format> {
    preset
        .iter()
        .map(|text| format::parse(text).expect("a display option's format reads"))
        .collect()
}

/// The formats a block runs through, the block's size, and the unit that
/// runs where the input ends.
struct Layout {
    formats: Vec<Format>,
    block: usize,
    end: Option<(usize, usize)>,
}

impl Layout {
    /// Size the block to the largest format and let each shorter one's
    /// last unit, uncounted, repeat to fill it; the last `%_A` unit is the
    /// one that runs at the end.
    fn new(mut formats: Vec<Format>) -> Layout {
        let total = |format: &Format| {
            format
                .iter()
                .fold(0usize, |sum, unit| sum.saturating_add(unit.total()))
        };
        let block = formats.iter().map(total).max().unwrap_or(0);
        for format in &mut formats {
            let used = total(format);
            if let Some(last) = format.last_mut()
                && used < block
                && !last.counted
                && last.step() > 0
            {
                last.reps += (block - used) / last.step();
            }
        }
        let end = formats
            .iter()
            .enumerate()
            .rev()
            .find_map(|(f, format)| format.iter().rposition(|unit| unit.end).map(|u| (f, u)));
        Layout {
            formats,
            block,
            end,
        }
    }

    /// One block at `address`; past `ends`, where the input ends, each
    /// conversion shows blanks.
    fn show(&self, data: &[u8], address: u64, ends: Option<u64>, out: &mut Vec<u8>) {
        for format in &self.formats {
            let mut at = 0usize;
            for unit in format {
                if unit.end {
                    at = at.saturating_add(unit.total());
                    continue;
                }
                at = self.unit(unit, data, at, address, ends, out);
            }
        }
    }

    fn unit(
        &self,
        unit: &Unit,
        data: &[u8],
        mut at: usize,
        address: u64,
        ends: Option<u64>,
        out: &mut Vec<u8>,
    ) -> usize {
        for rep in 0..unit.reps {
            // A repeated unit's last iteration writes no trailing blanks.
            let last = unit.reps > 1 && rep + 1 == unit.reps;
            for (index, print) in unit.prints.iter().enumerate() {
                let trim = last && index + 1 == unit.prints.len();
                if trim && print.kind == Kind::Text {
                    out.extend_from_slice(print.before.trim_ascii_end());
                } else {
                    out.extend_from_slice(&print.before);
                }
                if print.kind != Kind::Text {
                    let here = address.saturating_add(at as u64);
                    if ends.is_some_and(|end| here >= end) {
                        format::blank(print, out);
                    } else {
                        let from = at.min(data.len());
                        format::render(print, &data[from..], here, unit.reps, out);
                    }
                }
                if trim {
                    out.extend_from_slice(print.after.trim_ascii_end());
                } else {
                    out.extend_from_slice(&print.after);
                }
                at = at.saturating_add(print.size);
            }
        }
        at
    }

    /// The `%_A` unit, at the address the input ended: its offsets and its
    /// text, nothing it would read.
    fn ending(&self, address: u64, out: &mut Vec<u8>) {
        let Some((f, u)) = self.end else {
            return;
        };
        for print in &self.formats[f][u].prints {
            match print.kind {
                Kind::Text => out.extend_from_slice(&print.before),
                Kind::Address { .. } => {
                    out.extend_from_slice(&print.before);
                    format::render(print, &[], address, 1, out);
                    out.extend_from_slice(&print.after);
                }
                _ => {}
            }
        }
    }
}

/// What the dump has written and holds back.
struct Dump {
    layout: Layout,
    verbose: bool,
    address: u64,
    block: Vec<u8>,
    previous: Vec<u8>,
    shown: bool,
    starred: bool,
}

impl Dump {
    fn consume(&mut self, mut data: &[u8], out: &mut Vec<u8>) {
        let width = self.layout.block;
        if !self.block.is_empty() {
            let take = (width - self.block.len()).min(data.len());
            self.block.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.block.len() < width {
                return;
            }
            let block = std::mem::take(&mut self.block);
            self.full(&block, out);
            self.block = block;
            self.block.clear();
        }
        while data.len() >= width {
            let (block, rest) = data.split_at(width);
            self.full(block, out);
            data = rest;
        }
        self.block.extend_from_slice(data);
    }

    /// A full block, or a `*` for the run of blocks repeating the last.
    fn full(&mut self, block: &[u8], out: &mut Vec<u8>) {
        if !self.verbose && self.shown && self.previous == block {
            if !self.starred {
                out.extend_from_slice(b"*\n");
                self.starred = true;
            }
        } else {
            self.layout.show(block, self.address, None, out);
            self.starred = false;
        }
        self.previous.clear();
        self.previous.extend_from_slice(block);
        self.shown = true;
        self.address += block.len() as u64;
    }

    /// The last, short block, zero-filled, and the `%_A` unit, where some
    /// input was read or skipped.
    fn finish(&mut self, out: &mut Vec<u8>) {
        if !self.block.is_empty() {
            let mut block = std::mem::take(&mut self.block);
            let ends = self.address + block.len() as u64;
            block.resize(self.layout.block, 0);
            self.layout.show(&block, self.address, Some(ends), out);
            self.address = ends;
        }
        if self.address > 0 {
            self.layout.ending(self.address, out);
        }
    }
}

/// Where the run stands: reading format files, opening the first input
/// and skipping, dumping, past the input's end with the tail still to
/// write, or done.
#[derive(PartialEq, Eq)]
enum Stage {
    Load,
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

struct Hexdump {
    io: Io,
    stage: Stage,
    sources: VecDeque<Source>,
    formats: Vec<Format>,
    /// The format file being read: its input, its name, and what it has
    /// sent.
    loading: Option<(u32, Vec<u8>, Vec<u8>)>,
    files: VecDeque<(Vec<u8>, Opening)>,
    named: bool,
    input: Option<Input>,
    chunk: Vec<u8>,
    at: usize,
    skip: u64,
    left: Option<u64>,
    opened: bool,
    verbose: bool,
    dump: Option<Dump>,
    stderr: Vec<u8>,
    status: i32,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(match plan(config) {
        Ok(hexdump) => Box::new(hexdump),
        Err(stderr) => Box::new(Refused::new(StreamError::refusal(&bytes(&stderr), 1))),
    })
}

fn plan(config: Config) -> Result<Hexdump, String> {
    let mut settings = Settings::default();
    for (name, value) in &config.options {
        settings.take(name, value)?;
    }
    if settings.sources.is_empty() {
        settings
            .sources
            .push(Source::Read(presets(format::DEFAULT)));
    }
    let mut files: VecDeque<_> = config
        .operands
        .iter()
        .enumerate()
        .map(|(index, name)| (name.clone(), Opening::Operand(index + 1)))
        .collect();
    let named = !files.is_empty();
    if files.is_empty() {
        files.push_back((b"-".to_vec(), Opening::Name));
    }
    let mut hexdump = Hexdump {
        io: Io::default(),
        stage: Stage::Load,
        sources: settings.sources.into(),
        formats: Vec::new(),
        loading: None,
        files,
        named,
        input: None,
        chunk: Vec::new(),
        at: 0,
        skip: settings.skip,
        left: settings.length,
        opened: false,
        verbose: settings.verbose,
        dump: None,
        stderr: Vec::new(),
        status: 0,
    };
    hexdump.load()?;
    Ok(hexdump)
}

impl Hexdump {
    /// Take in the formats read so far, up to the next file of them; once
    /// all are in, size the block and start on the input.
    fn load(&mut self) -> Result<(), String> {
        while let Some(source) = self.sources.pop_front() {
            match source {
                Source::Read(formats) => self.formats.extend(formats),
                Source::File(name) => {
                    let fd = self.io.fd();
                    self.io.push(Request::Read {
                        fd,
                        open: Some((name.clone(), Opening::File)),
                        least: u64::MAX,
                    });
                    self.loading = Some((fd, name, Vec::new()));
                    return Ok(());
                }
            }
        }
        let mut formats = std::mem::take(&mut self.formats);
        format::prepare(&mut formats)?;
        let layout = Layout::new(formats);
        // A block of no bytes, or a length of none, shows nothing.
        if layout.block == 0 || self.left == Some(0) {
            self.stage = Stage::Done;
            return Ok(());
        }
        self.dump = Some(Dump {
            layout,
            verbose: self.verbose,
            address: self.skip,
            block: Vec::new(),
            previous: Vec::new(),
            shown: false,
            starred: false,
        });
        self.stage = Stage::Skip;
        Ok(())
    }

    /// A format file's text: each line a format string, but blank ones and
    /// comments.
    fn lines(&mut self, text: &[u8]) -> Result<(), String> {
        for line in text.split(|&b| b == b'\n') {
            let content = line.trim_ascii_start();
            if content.is_empty() || content[0] == b'#' {
                continue;
            }
            self.formats.push(format::parse(line)?);
        }
        Ok(())
    }

    fn refuse(&mut self, message: &str) {
        self.stderr.extend_from_slice(&bytes(message));
        self.stderr.push(b'\n');
        self.status = 1;
        self.stage = Stage::Done;
    }

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
            let opening = match opening {
                Opening::Operand(operand) if self.stage == Stage::Skip && self.skip >= SEEK => {
                    Opening::Range(operand, self.skip, self.left)
                }
                opening => opening,
            };
            self.input = Some(Input {
                fd: self.io.fd(),
                open: Some((name.clone(), opening)),
                name,
            });
        }
        if let Some(input) = &mut self.input {
            let open = input.open.take();
            self.io.push(Request::Read {
                fd: input.fd,
                open,
                least: 0,
            });
        }
    }

    /// Every input has been read.
    fn end(&mut self) {
        if self.named && !self.opened {
            self.stderr
                .extend_from_slice(b"hexdump: all input file arguments failed\n");
            self.status = 1;
        }
        // What the skip spent counts as read, so the end offset shows.
        if let Some(dump) = &mut self.dump
            && self.stage == Stage::Skip
        {
            dump.address -= self.skip;
        }
        self.stage = Stage::Ended;
    }

    fn loaded(&mut self, reply: &Reply, data: &[u8]) -> Result<(), StreamError> {
        let Some((fd, name, mut text)) = self.loading.take() else {
            return Err(StreamError::new("no format file is open"));
        };
        if let Some(error) = &reply.error {
            let message = format!("hexdump: can't read {}: {}", crate::byte_text(&name), error);
            self.refuse(&message);
            return Ok(());
        }
        text.extend_from_slice(data);
        if !reply.end {
            self.loading = Some((fd, name, text));
            self.io.push(Request::Read {
                fd,
                open: None,
                least: u64::MAX,
            });
            return Ok(());
        }
        if let Err(message) = self.lines(&text).and_then(|()| self.load()) {
            self.refuse(&message);
        }
        Ok(())
    }
}

impl Stream for Hexdump {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("hexdump reads its input through requests"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if matches!(self.stage, Stage::Skip | Stage::Dump | Stage::Ended)
            && let Some(dump) = &mut self.dump
        {
            dump.finish(out);
        }
        self.stage = Stage::Done;
        Ok(())
    }

    fn busy(&self) -> bool {
        self.stage == Stage::Dump && self.at < self.chunk.len() && self.io.idle()
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut take = (self.chunk.len() - self.at).min(WINDOW);
        if let Some(left) = self.left {
            take = take.min(usize::try_from(left).unwrap_or(usize::MAX));
        }
        if let Some(dump) = &mut self.dump {
            dump.consume(&self.chunk[self.at..self.at + take], out);
        }
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

    fn respond(
        &mut self,
        reply: &[u8],
        data: &[u8],
        _out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let (request, reply) = self.io.answer(reply).map_err(StreamError::new)?;
        if let Some(fatal) = reply.fatal {
            return Err(StreamError::new(fatal));
        }
        if !matches!(request, Request::Read { .. }) {
            return Ok(());
        }
        if self.stage == Stage::Load {
            return self.loaded(&reply, data);
        }
        let Some(input) = self.input.take() else {
            return Err(StreamError::new("no input is open"));
        };
        if reply.error.is_some() {
            // A directory opens, and reads as an error that fails nothing.
            if reply.names(&["EISDIR"]) {
                self.opened = true;
            } else {
                self.status = 1;
            }
            self.stderr
                .extend(read_failure(b"hexdump", &input.name, &reply));
            return Ok(());
        }
        self.opened = true;
        self.skip -= reply.skipped.unwrap_or(0).min(self.skip);
        if !reply.end || !data.is_empty() {
            if !reply.end {
                self.input = Some(input);
            }
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
            self.stage = Stage::Dump;
        }
        Ok(())
    }
}
