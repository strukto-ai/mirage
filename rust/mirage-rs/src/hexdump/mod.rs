//! hexdump as util-linux 2.41.5 runs it in the C locale, as mirage models
//! it: the display options and format strings read in the order typed,
//! each a list of units a block runs through, the operands read through
//! the host as one input, and the dump written a bounded step per
//! `drain`, holding the chunk in hand, a block and the one before it.

mod format;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;

use serde::Deserialize;
use serde_json::Value as Json;

use crate::request::{Io, Opening, Refused, Reply, Request, bytes, read_failure};
use crate::{Stream, StreamError, parse_config};

use self::format::{Format, Kind, Piece, Print, Sink};

/// The input one `drain` dumps.
const WINDOW: usize = 16 * 1024;
/// The output one `drain` writes before it stops, but for a small last
/// piece.
const OUTPUT: usize = 64 * 1024;
/// The prints one `drain` runs, so a format that writes little a print
/// still hands back.
const PRINTS: usize = 64 * 1024;
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
    if let Some(digits) = fraction {
        total = total
            .checked_add(fraction_of(digits, multiplier).ok_or_else(range)?)
            .ok_or_else(range)?;
    }
    u64::try_from(total).map_err(|_| range())
}

/// A size's fraction as util-linux counts it: the digits read as one
/// whole number, over the least power of ten not below it, one place more
/// for each leading zero; then each digit `d` from the last adds the
/// multiplier over `divisor / d`, the divisor a place less each digit.
/// So 0.9K is 1024, 0.25K is 255 and 0.10K is 1024. None when the digits
/// outrun 64 bits.
fn fraction_of(digits: &[u8], multiplier: u128) -> Option<u128> {
    let zeros = digits.iter().take_while(|&&b| b == b'0').count();
    let mut whole: u128 = 0;
    for &b in &digits[zeros..] {
        whole = whole
            .checked_mul(10)?
            .checked_add(u128::from(b - b'0'))
            .filter(|whole| *whole <= u128::from(u64::MAX))?;
    }
    // A divisor past u128 leaves every share zero.
    let mut divisor: Option<u128> = Some(10);
    while let Some(d) = divisor
        && d < whole
    {
        divisor = d.checked_mul(10);
    }
    for _ in 0..zeros {
        divisor = divisor.and_then(|d| d.checked_mul(10));
    }
    let mut sum: u128 = 0;
    while whole > 0 {
        let Some(d) = divisor.filter(|&d| d > 0) else {
            break;
        };
        if let Some(share) = d.checked_div(whole % 10) {
            sum += multiplier / share;
        }
        whole /= 10;
        divisor = Some(d / 10);
    }
    Some(sum)
}

/// What the options set, read in the order typed.
#[derive(Default)]
struct Settings {
    /// The formats added so far; with none, the default display shows.
    formats: Vec<Format>,
    length: Option<u64>,
    skip: u64,
    verbose: bool,
}

impl Settings {
    /// Take one option; a format file comes back, to read before the
    /// options after it.
    fn take(&mut self, name: &str, value: &Json) -> Result<Option<Vec<u8>>, String> {
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
            self.formats.extend(presets(preset));
            return Ok(None);
        }
        match name {
            "format" => self.formats.push(format::parse(&raw)?),
            "format_file" => return Ok(Some(raw)),
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
        Ok(None)
    }

    /// One line of a format file: a format string, unless blank or a
    /// comment.
    fn line(&mut self, line: &[u8]) -> Result<(), String> {
        let content = line.trim_ascii_start();
        if !content.is_empty() && content[0] != b'#' {
            self.formats.push(format::parse(line)?);
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

/// `text` less one trailing blank, as C's `isspace` reads one.
fn trimmed(text: &[u8]) -> &[u8] {
    match text.split_last() {
        Some((b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r', rest)) => rest,
        _ => text,
    }
}

/// Where a block's output stands: the format, the unit, its iteration and
/// print, and the byte the next conversion reads.
#[derive(Clone, Copy, Default)]
struct Cursor {
    format: usize,
    unit: usize,
    rep: usize,
    print: usize,
    at: usize,
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
                && last.span() > 0
            {
                last.reps += (block - used) / last.span();
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

    /// Show the block at `address` from `cursor` on, as far as the sink
    /// allows; true once it is all written. Past `ends`, where the input
    /// ends, each conversion shows blanks, and each format stops at its
    /// `%_A` unit.
    fn show(
        &self,
        data: &[u8],
        address: u64,
        ends: Option<u64>,
        cursor: &mut Cursor,
        sink: &mut Sink,
    ) -> bool {
        while let Some(format) = self.formats.get(cursor.format) {
            while let Some(unit) = format.get(cursor.unit) {
                if unit.end {
                    break;
                }
                while cursor.rep < unit.reps {
                    // A repeated unit's last iteration drops one trailing
                    // blank.
                    let last = unit.reps > 1 && cursor.rep + 1 == unit.reps;
                    while let Some(print) = unit.prints.get(cursor.print) {
                        if sink.spent() {
                            return false;
                        }
                        sink.prints -= 1;
                        let trim = last && cursor.print + 1 == unit.prints.len();
                        Self::print(
                            print,
                            trim,
                            data,
                            address.saturating_add(cursor.at as u64),
                            ends,
                            cursor.at,
                            sink,
                        );
                        cursor.at = cursor.at.saturating_add(print.size);
                        cursor.print += 1;
                    }
                    cursor.print = 0;
                    cursor.rep += 1;
                }
                cursor.rep = 0;
                cursor.unit += 1;
            }
            *cursor = Cursor {
                format: cursor.format + 1,
                ..Cursor::default()
            };
        }
        true
    }

    fn print(
        print: &Print,
        trim: bool,
        data: &[u8],
        here: u64,
        ends: Option<u64>,
        at: usize,
        sink: &mut Sink,
    ) {
        if print.kind == Kind::Text {
            sink.bytes(if trim {
                trimmed(&print.before)
            } else {
                &print.before
            });
        } else if !print.lost() {
            sink.bytes(&print.before);
            if ends.is_some_and(|end| here >= end) {
                format::blank(print, sink);
            } else {
                format::render(print, data.get(at..).unwrap_or_default(), here, sink);
            }
        }
        sink.bytes(if trim {
            trimmed(&print.after)
        } else {
            &print.after
        });
    }

    /// The `%_A` unit, at the address the input ended, from print `next`
    /// on as far as the sink allows; true once it is all written. Its
    /// offsets and its text show, but a conversion that would read shows
    /// neither itself nor the text before it, only the text after.
    fn ending(&self, address: u64, next: &mut usize, sink: &mut Sink) -> bool {
        let Some((f, u)) = self.end else {
            return true;
        };
        while let Some(print) = self.formats[f][u].prints.get(*next) {
            if sink.spent() {
                return false;
            }
            sink.prints -= 1;
            match print.kind {
                Kind::Text => sink.bytes(&print.before),
                Kind::Address { .. } if !print.lost() => {
                    sink.bytes(&print.before);
                    format::render(print, &[], address, sink);
                }
                _ => {}
            }
            sink.bytes(&print.after);
            *next += 1;
        }
        true
    }
}

/// A block shown in part: its bytes, where it starts, where the input
/// ended, and how far it got.
struct Showing {
    data: Vec<u8>,
    address: u64,
    ends: Option<u64>,
    cursor: Cursor,
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
    showing: Option<Showing>,
    held: VecDeque<Piece>,
    /// The last, short block has been started, the `%_A` unit's next
    /// print, and that unit written.
    closing: bool,
    ending: usize,
    ended: bool,
}

impl Dump {
    fn pending(&self) -> bool {
        self.showing.is_some() || !self.held.is_empty()
    }

    /// Write what is held and the rest of a block shown in part; true when
    /// that is done and the sink has room for more.
    fn resume(&mut self, sink: &mut Sink) -> bool {
        sink.release();
        if !sink.held.is_empty() {
            return false;
        }
        if let Some(mut showing) = self.showing.take()
            && !self.layout.show(
                &showing.data,
                showing.address,
                showing.ends,
                &mut showing.cursor,
                sink,
            )
        {
            self.showing = Some(showing);
            return false;
        }
        !sink.spent()
    }

    /// Dump what of `data` the sink allows, and say how much that was.
    fn consume(&mut self, data: &[u8], sink: &mut Sink) -> usize {
        let width = self.layout.block;
        let mut used = 0;
        while self.resume(sink) && used < data.len() {
            let rest = &data[used..];
            if self.block.is_empty() && rest.len() >= width {
                self.full(&rest[..width], sink);
                used += width;
                continue;
            }
            let take = (width - self.block.len()).min(rest.len());
            self.block.extend_from_slice(&rest[..take]);
            used += take;
            if self.block.len() == width {
                let block = std::mem::take(&mut self.block);
                self.full(&block, sink);
                self.block = block;
                self.block.clear();
            }
        }
        used
    }

    /// A full block, or a `*` for the run of blocks repeating the last.
    fn full(&mut self, block: &[u8], sink: &mut Sink) {
        let address = self.address;
        self.address += block.len() as u64;
        let repeated = !self.verbose && self.shown && self.previous == block;
        self.previous.clear();
        self.previous.extend_from_slice(block);
        self.shown = true;
        if repeated {
            if !self.starred {
                sink.bytes(b"*\n");
                self.starred = true;
            }
            return;
        }
        self.starred = false;
        let mut cursor = Cursor::default();
        if !self.layout.show(block, address, None, &mut cursor, sink) {
            self.showing = Some(Showing {
                data: block.to_vec(),
                address,
                ends: None,
                cursor,
            });
        }
    }

    /// The last, short block, and the `%_A` unit where some input was read
    /// or skipped; true once both are written.
    fn tail(&mut self, sink: &mut Sink) -> bool {
        if !self.resume(sink) {
            return false;
        }
        if !self.closing {
            self.closing = true;
            if !self.block.is_empty() {
                let data = std::mem::take(&mut self.block);
                let address = self.address;
                let ends = address + data.len() as u64;
                self.address = ends;
                let mut cursor = Cursor::default();
                if !self
                    .layout
                    .show(&data, address, Some(ends), &mut cursor, sink)
                {
                    self.showing = Some(Showing {
                        data,
                        address,
                        ends: Some(ends),
                        cursor,
                    });
                    return false;
                }
            }
            if !self.resume(sink) {
                return false;
            }
        }
        if !self.ended {
            if self.address > 0 && !self.layout.ending(self.address, &mut self.ending, sink) {
                return false;
            }
            self.ended = true;
        }
        sink.release();
        sink.held.is_empty() && self.showing.is_none()
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
    /// Standard input, which a stop at `-n` hands back what it left.
    stdin: bool,
    /// A read has answered, so the input opened and a failure now is a
    /// read error.
    begun: bool,
}

/// The format file being read: its input, its name, and the line it has
/// begun.
struct Loading {
    fd: u32,
    name: Vec<u8>,
    line: Vec<u8>,
    /// The line begun is a comment, whose bytes are not kept.
    comment: bool,
    /// How many of the begun line's first bytes are known to be blanks.
    blanks: usize,
}

struct Hexdump {
    io: Io,
    stage: Stage,
    /// The options still to read, after a format file.
    options: VecDeque<(String, Json)>,
    settings: Settings,
    loading: Option<Loading>,
    files: VecDeque<(Vec<u8>, Opening)>,
    named: bool,
    input: Option<Input>,
    chunk: Vec<u8>,
    /// The chunk in hand came from standard input.
    on_stdin: bool,
    at: usize,
    skip: u64,
    left: Option<u64>,
    opened: bool,
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
        options: config.options.into(),
        settings: Settings::default(),
        loading: None,
        files,
        named,
        input: None,
        chunk: Vec::new(),
        on_stdin: false,
        at: 0,
        skip: 0,
        left: None,
        opened: false,
        dump: None,
        stderr: Vec::new(),
        status: 0,
    };
    hexdump.load()?;
    Ok(hexdump)
}

impl Hexdump {
    /// Read the options in order up to the next format file, which is read
    /// where it stands; once all are in, size the block and start on the
    /// input.
    fn load(&mut self) -> Result<(), String> {
        while let Some((name, value)) = self.options.pop_front() {
            if let Some(file) = self.settings.take(&name, &value)? {
                let fd = self.io.fd();
                self.io.push(Request::Read {
                    fd,
                    open: Some((file.clone(), Opening::File)),
                    least: 0,
                });
                self.loading = Some(Loading {
                    fd,
                    name: file,
                    line: Vec::new(),
                    comment: false,
                    blanks: 0,
                });
                return Ok(());
            }
        }
        // A format file of comments alone adds none.
        if self.settings.formats.is_empty() {
            self.settings.formats.extend(presets(format::DEFAULT));
        }
        let mut formats = std::mem::take(&mut self.settings.formats);
        format::prepare(&mut formats)?;
        let layout = Layout::new(formats);
        self.skip = self.settings.skip;
        self.left = self.settings.length;
        // A block of no bytes, or a length of none, shows nothing.
        if layout.block == 0 || self.left == Some(0) {
            self.stage = Stage::Done;
            return Ok(());
        }
        self.dump = Some(Dump {
            layout,
            verbose: self.settings.verbose,
            address: self.skip,
            block: Vec::new(),
            previous: Vec::new(),
            shown: false,
            starred: false,
            showing: None,
            held: VecDeque::new(),
            closing: false,
            ending: 0,
            ended: false,
        });
        self.stage = Stage::Skip;
        Ok(())
    }

    fn refuse(&mut self, message: &str) {
        self.stderr.extend_from_slice(&bytes(message));
        self.stderr.push(b'\n');
        self.status = 1;
        self.stage = Stage::Done;
    }

    /// The input has run out, or `-n` is spent, with nothing left in hand:
    /// what remains is the tail.
    fn ending_due(&self) -> bool {
        matches!(self.stage, Stage::Skip | Stage::Dump)
            && self.io.idle()
            && self.at >= self.chunk.len()
            && ((self.stage == Stage::Dump && self.left == Some(0))
                || (self.input.is_none() && self.files.is_empty()))
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
            // The hosts read these operands from standard input too.
            let stdin = matches!(opening, Opening::Name)
                || matches!(&name[..], b"/dev/stdin" | b"/dev/fd/0");
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
                stdin,
                begun: false,
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

    /// A format file's next bytes: each whole line read as it comes, the
    /// options after the file once it ends.
    fn loaded(&mut self, reply: &Reply, data: &[u8]) -> Result<(), StreamError> {
        let Some(mut loading) = self.loading.take() else {
            return Err(StreamError::new("no format file is open"));
        };
        if let Some(error) = &reply.error {
            let message = format!(
                "hexdump: can't read {}: {}",
                crate::byte_text(&loading.name),
                error
            );
            self.refuse(&message);
            return Ok(());
        }
        // Only the new bytes are searched for line ends.
        let mut search = loading.line.len();
        loading.line.extend_from_slice(data);
        let mut start = 0;
        while let Some(newline) = loading.line[search..].iter().position(|&b| b == b'\n') {
            let end = search + newline;
            if !std::mem::take(&mut loading.comment)
                && let Err(message) = self.settings.line(&loading.line[start..end])
            {
                self.refuse(&message);
                return Ok(());
            }
            start = end + 1;
            search = start;
        }
        loading.line.drain(..start);
        // A new line's blanks are counted afresh; a begun one's only past
        // those already counted.
        if start > 0 {
            loading.blanks = 0;
        }
        while loading
            .line
            .get(loading.blanks)
            .is_some_and(u8::is_ascii_whitespace)
        {
            loading.blanks += 1;
        }
        if loading.line.get(loading.blanks) == Some(&b'#') {
            loading.comment = true;
        }
        if loading.comment {
            loading.line.clear();
            loading.blanks = 0;
        }
        if !reply.end {
            self.io.push(Request::Read {
                fd: loading.fd,
                open: None,
                least: 0,
            });
            self.loading = Some(loading);
            return Ok(());
        }
        if let Err(message) = self.settings.line(&loading.line).and_then(|()| self.load()) {
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
        // One bounded step, as `drain` takes: a host that finishes before
        // the dump is written drains the rest while `busy` says so.
        if matches!(self.stage, Stage::Skip | Stage::Dump | Stage::Ended) {
            return self.drain(out);
        }
        self.stage = Stage::Done;
        Ok(())
    }

    fn busy(&self) -> bool {
        let pending = self.dump.as_ref().is_some_and(Dump::pending);
        match self.stage {
            Stage::Dump => {
                pending || (self.at < self.chunk.len() && self.io.idle()) || self.ending_due()
            }
            Stage::Skip => self.ending_due(),
            Stage::Ended => true,
            Stage::Load | Stage::Done => false,
        }
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.ending_due() {
            if self.stage == Stage::Dump && self.left == Some(0) {
                self.stage = Stage::Ended;
            } else {
                self.end();
            }
        }
        let Some(dump) = self.dump.as_mut() else {
            return Ok(());
        };
        let mut sink = Sink::new(out, OUTPUT, PRINTS, std::mem::take(&mut dump.held));
        if self.stage == Stage::Ended {
            if dump.tail(&mut sink) {
                self.stage = Stage::Done;
            }
            dump.held = sink.held;
            return Ok(());
        }
        let mut take = (self.chunk.len() - self.at).min(WINDOW);
        if let Some(left) = self.left {
            take = take.min(usize::try_from(left).unwrap_or(usize::MAX));
        }
        let used = dump.consume(&self.chunk[self.at..self.at + take], &mut sink);
        dump.held = sink.held;
        self.at += used;
        if let Some(left) = &mut self.left
            && used > 0
        {
            *left -= used as u64;
            if *left == 0 {
                // What `-n` leaves of standard input is the next command's.
                if self.on_stdin {
                    self.io.push(Request::Unread {
                        data: self.chunk[self.at..].to_vec(),
                    });
                }
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
        let Some(mut input) = self.input.take() else {
            return Err(StreamError::new("no input is open"));
        };
        if reply.error.is_some() {
            // An input that opened and then fails to read, as a directory
            // does, reports it and fails nothing; one that cannot open
            // fails the run.
            if input.begun || reply.names(&["EISDIR"]) {
                self.opened = true;
            } else {
                self.status = 1;
            }
            self.stderr
                .extend(read_failure(b"hexdump", &input.name, &reply));
            return Ok(());
        }
        self.opened = true;
        input.begun = true;
        self.skip -= reply.skipped.unwrap_or(0).min(self.skip);
        if !reply.end || !data.is_empty() {
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
            self.on_stdin = input.stdin;
            self.at = 0;
        }
        if !reply.end {
            self.input = Some(input);
        }
        if self.stage == Stage::Skip && self.skip == 0 {
            self.stage = Stage::Dump;
        }
        Ok(())
    }
}
