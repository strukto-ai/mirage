use std::collections::VecDeque;

use serde::Deserialize;

use crate::calendar::{MONTHS, WEEKDAYS};
use crate::{
    Stream, StreamError,
    constants::{OUTPUT, WORK},
    parse_config,
};

/// The widest field: date reads a wider width as this one.
const MAX_WIDTH: usize = i32::MAX as usize;

const MONTH_STARTS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    year: i64,
    month: usize,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    nanosecond: u32,
    epoch: i64,
    offset: i64,
    zone: String,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(Box::new(Strftime::new(config)?))
}

impl Strftime {
    fn new(config: Config) -> Result<Self, StreamError> {
        let leap = leap(config.year);
        let days = match config.month {
            2 => 28 + i64::from(leap),
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if !(1..=12).contains(&config.month)
            || !(1..=days).contains(&config.day)
            || !(0..=23).contains(&config.hour)
            || !(0..=59).contains(&config.minute)
            || !(0..=60).contains(&config.second)
            || config.nanosecond >= 1_000_000_000
            || config.year.unsigned_abs() > i32::MAX as u64 + 1900
            || config.offset.unsigned_abs() >= 86400
        {
            return Err(StreamError::new("strftime: invalid time fields"));
        }
        let ordinal =
            MONTH_STARTS[config.month - 1] + config.day + i64::from(leap && config.month > 2);
        let before = config.year - 1;
        let first =
            (before + before.div_euclid(4) - before.div_euclid(100) + before.div_euclid(400) + 1)
                .rem_euclid(7);
        let weekday = (first + ordinal - 1) % 7;
        let week = (ordinal + 9 - (weekday + 6) % 7) / 7;
        let (iso_year, iso_week) = if week == 0 {
            (config.year - 1, weeks(config.year - 1))
        } else if week > weeks(config.year) {
            (config.year + 1, 1)
        } else {
            (config.year, week)
        };
        Ok(Strftime {
            config,
            ordinal,
            weekday,
            iso_year,
            iso_week,
            format: Vec::new(),
            finished: false,
            layout: Layout::default(),
            rendered: Rendered::default(),
        })
    }

    pub(crate) fn utc(epoch: i64, nanosecond: u32) -> Result<Self, StreamError> {
        Self::zoned(epoch, nanosecond, 0, "UTC".into())
    }

    /// One moment as a zone shows it, by that zone's offset and name.
    pub(crate) fn zoned(
        epoch: i64,
        nanosecond: u32,
        offset: i64,
        zone: String,
    ) -> Result<Self, StreamError> {
        let (year, month, day, hour, minute, second) =
            crate::calendar::fields(i128::from(epoch) + i128::from(offset));
        Self::new(Config {
            year: year as i64,
            month: month as usize,
            day: day as i64,
            hour: hour as i64,
            minute: minute as i64,
            second: second as i64,
            nanosecond,
            epoch,
            offset,
            zone,
        })
    }
}

fn leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn weeks(year: i64) -> i64 {
    let before = year - 1;
    let first =
        (before + before.div_euclid(4) - before.div_euclid(100) + before.div_euclid(400) + 1)
            .rem_euclid(7);
    if first == 4 || first == 3 && leap(year) {
        53
    } else {
        52
    }
}

pub(crate) struct Strftime {
    config: Config,
    ordinal: i64,
    weekday: i64,
    iso_year: i64,
    iso_week: i64,
    format: Vec<u8>,
    finished: bool,
    layout: Layout,
    rendered: Rendered,
}

impl Stream for Strftime {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.finished {
            self.format.extend_from_slice(input);
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.finished = true;
        self.drain(out)
    }

    fn busy(&self) -> bool {
        self.finished && (!self.layout.done(&self.format) || !self.rendered.pieces.is_empty())
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.finished {
            return Ok(());
        }
        if self.rendered.pieces.is_empty() && !self.layout.done(&self.format) {
            let mut layout = std::mem::take(&mut self.layout);
            let mut rendered = std::mem::take(&mut self.rendered);
            self.layout_step(&self.format, &mut layout, &mut rendered, true)?;
            self.layout = layout;
            self.rendered = rendered;
        }
        self.rendered
            .write(out, OUTPUT, &self.format, &self.config.zone);
        if self.layout.done(&self.format) && self.rendered.format_spans == 0 {
            self.format = Vec::new();
            self.layout = Layout::default();
        }
        Ok(())
    }
}

#[derive(Default)]
enum Scan {
    #[default]
    Literal,
    Flags,
    Width,
    Colons,
    Modifier,
    Code,
}

#[derive(Default)]
struct Layout {
    at: usize,
    start: usize,
    scan: Scan,
    flags: Flags,
    colons: usize,
    modifier: Option<u8>,
}

impl Layout {
    fn done(&self, format: &[u8]) -> bool {
        self.at == format.len() && matches!(self.scan, Scan::Literal)
    }
}

enum Source {
    Format,
    Zone,
}

enum Piece {
    Bytes(Vec<u8>),
    Span(Source, std::ops::Range<usize>, Option<bool>),
    Fill(u8, usize),
}

/// Bytes and borrowed spans, with virtual padding and a cursor in the first piece.
#[derive(Default)]
struct Rendered {
    pieces: VecDeque<Piece>,
    len: usize,
    written: usize,
    format_spans: usize,
}

impl Rendered {
    fn push(&mut self, byte: u8) {
        self.extend_from_slice(&[byte]);
    }

    fn extend_from_slice(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.len = self.len.saturating_add(bytes.len());
        match self.pieces.back_mut() {
            Some(Piece::Bytes(last)) => last.extend_from_slice(bytes),
            _ => self.pieces.push_back(Piece::Bytes(bytes.to_vec())),
        }
    }

    fn span(&mut self, source: Source, range: std::ops::Range<usize>) {
        if !range.is_empty() {
            self.len = self.len.saturating_add(range.len());
            self.format_spans += usize::from(matches!(&source, Source::Format));
            self.pieces.push_back(Piece::Span(source, range, None));
        }
    }

    fn fill(&mut self, byte: u8, count: usize) {
        if count > 0 {
            self.len = self.len.saturating_add(count);
            self.pieces.push_back(Piece::Fill(byte, count));
        }
    }

    fn append(&mut self, other: Rendered) {
        self.len = self.len.saturating_add(other.len);
        self.format_spans += other.format_spans;
        self.pieces.extend(other.pieces);
    }

    /// Case-map bytes and defer span mapping until emission; padding is unchanged.
    fn map(&mut self, upper: bool) {
        for piece in &mut self.pieces {
            match piece {
                Piece::Bytes(bytes) => {
                    if upper {
                        bytes.make_ascii_uppercase();
                    } else {
                        bytes.make_ascii_lowercase();
                    }
                }
                Piece::Span(_, _, case) => *case = Some(upper),
                Piece::Fill(_, _) => {}
            }
        }
    }

    fn write(&mut self, out: &mut Vec<u8>, most: usize, format: &[u8], zone: &str) {
        let mut room = most;
        while room > 0 {
            let Some(piece) = self.pieces.front() else {
                break;
            };
            let (len, bytes, upper) = match piece {
                Piece::Bytes(bytes) => (bytes.len(), bytes.as_slice(), None),
                Piece::Span(source, range, upper) => {
                    let source = match source {
                        Source::Format => format,
                        Source::Zone => zone.as_bytes(),
                    };
                    (range.len(), &source[range.clone()], *upper)
                }
                Piece::Fill(_, count) => (*count, &[][..], None),
            };
            let taken = (len - self.written).min(room);
            if let Piece::Fill(byte, _) = piece {
                out.resize(out.len() + taken, *byte);
            } else {
                let start = out.len();
                out.extend_from_slice(&bytes[self.written..self.written + taken]);
                match upper {
                    Some(true) => out[start..].make_ascii_uppercase(),
                    Some(false) => out[start..].make_ascii_lowercase(),
                    None => {}
                }
            }
            room -= taken;
            self.written += taken;
            if self.written == len {
                self.format_spans -= usize::from(matches!(piece, Piece::Span(Source::Format, ..)));
                self.pieces.pop_front();
                self.written = 0;
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Flags {
    pad: Option<u8>,
    width: Option<usize>,
    upper: bool,
    swap: bool,
}

impl Flags {
    fn text(self, text: Rendered, out: &mut Rendered) {
        let padding = if self.pad == Some(b'-') {
            0
        } else {
            self.width.unwrap_or(0).saturating_sub(text.len)
        };
        out.fill(
            if matches!(self.pad, Some(b'0' | b'+')) {
                b'0'
            } else {
                b' '
            },
            padding,
        );
        out.append(text);
    }

    fn number(self, value: i64, natural: usize, space: bool, sign: bool, out: &mut Rendered) {
        let sign = if value < 0 {
            "-"
        } else if sign {
            "+"
        } else {
            ""
        };
        self.signed(sign, value.unsigned_abs(), natural, space, out);
    }

    fn signed(self, sign: &str, value: u64, natural: usize, space: bool, out: &mut Rendered) {
        let digits = value.to_string();
        let padding = if self.pad == Some(b'-') {
            0
        } else {
            self.width
                .unwrap_or(natural)
                .saturating_sub(digits.len() + sign.len())
        };
        let spaces = self.pad == Some(b'_') || self.pad.is_none() && space;
        if spaces {
            out.fill(b' ', padding);
        }
        out.extend_from_slice(sign.as_bytes());
        if !spaces {
            out.fill(b'0', padding);
        }
        out.extend_from_slice(digits.as_bytes());
    }
}

impl Strftime {
    // date's formatter differs from libc's (used by jq): widths replace
    // numeric defaults, '-' suppresses text padding, and '+' signs years.
    pub(crate) fn render(&self, format: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut layout = Layout::default();
        let mut rendered = Rendered::default();
        while !layout.done(format) || !rendered.pieces.is_empty() {
            if rendered.pieces.is_empty() {
                self.layout_step(format, &mut layout, &mut rendered, true)?;
            }
            rendered.write(out, OUTPUT, format, &self.config.zone);
        }
        Ok(())
    }

    fn layout(&self, format: &[u8], out: &mut Rendered) -> Result<(), StreamError> {
        let mut layout = Layout::default();
        while !layout.done(format) {
            self.layout_step(format, &mut layout, out, false)?;
        }
        Ok(())
    }

    fn layout_step(
        &self,
        format: &[u8],
        state: &mut Layout,
        out: &mut Rendered,
        spans: bool,
    ) -> Result<(), StreamError> {
        let spans = spans && format.len() > WORK;
        let mut work = WORK;
        while work > 0 && !state.done(format) {
            let byte = format.get(state.at).copied();
            match state.scan {
                Scan::Literal => {
                    let end = format.len().min(state.at.saturating_add(work));
                    let len =
                        memchr::memchr(b'%', &format[state.at..end]).unwrap_or(end - state.at);
                    if len > 0 {
                        if spans {
                            out.span(Source::Format, state.at..state.at + len);
                        } else {
                            out.extend_from_slice(&format[state.at..state.at + len]);
                        }
                        state.at += len;
                        work -= len;
                    } else {
                        state.start = state.at;
                        state.at += 1;
                        work -= 1;
                        state.flags = Flags::default();
                        state.colons = 0;
                        state.modifier = None;
                        state.scan = Scan::Flags;
                    }
                }
                Scan::Flags => {
                    if byte == Some(b'%') && state.at == state.start + 1 {
                        out.push(b'%');
                        state.at += 1;
                        work -= 1;
                        state.scan = Scan::Literal;
                    } else {
                        let end = format.len().min(state.at.saturating_add(work));
                        let mut taken = 0;
                        for &flag in &format[state.at..end] {
                            match flag {
                                b'^' => state.flags.upper = true,
                                b'#' => state.flags.swap = true,
                                b'-' | b'_' | b'0' | b'+' => state.flags.pad = Some(flag),
                                _ => break,
                            }
                            taken += 1;
                        }
                        state.at += taken;
                        work -= taken;
                        if state.at < end || state.at == format.len() {
                            state.scan = Scan::Width;
                        }
                    }
                }
                Scan::Width => {
                    if let Some(digit) = byte.filter(u8::is_ascii_digit) {
                        let width = state.flags.width.unwrap_or(0).saturating_mul(10);
                        state.flags.width =
                            Some(MAX_WIDTH.min(width.saturating_add(usize::from(digit - b'0'))));
                        state.at += 1;
                        work -= 1;
                    } else {
                        state.scan = Scan::Colons;
                    }
                }
                Scan::Colons => {
                    if byte == Some(b':') {
                        state.colons += 1;
                        state.at += 1;
                        work -= 1;
                    } else {
                        state.scan = Scan::Modifier;
                    }
                }
                Scan::Modifier => {
                    state.modifier = byte.filter(|m| state.colons == 0 && matches!(m, b'E' | b'O'));
                    if state.modifier.is_some() {
                        state.at += 1;
                        work -= 1;
                    }
                    state.scan = Scan::Code;
                }
                Scan::Code => {
                    state.at += usize::from(byte.is_some());
                    let mut flags = state.flags;
                    if &format[state.start..state.at] == b"%-N" {
                        flags.pad = None;
                    }
                    let valid = byte.is_some_and(|c| {
                        if state.colons > 0 {
                            return c == b'z' && state.colons <= 3;
                        }
                        match state.modifier {
                            Some(b'E') => b"cCnpPqrRstTuxXyYzZ".contains(&c),
                            Some(b'O') => b"bBCdeghHIjklmMnNpPrRsStTuUVwWyzZG".contains(&c),
                            _ => true,
                        }
                    });
                    if !valid
                        || !self.conversion(
                            byte.unwrap(),
                            state.modifier,
                            state.colons,
                            flags,
                            out,
                        )?
                    {
                        let end = if byte == Some(b'%') {
                            state.at - 1
                        } else {
                            state.at
                        };
                        let mut literal = Rendered::default();
                        if spans {
                            literal.span(Source::Format, state.start..end);
                        } else {
                            literal.extend_from_slice(&format[state.start..end]);
                        }
                        if flags.upper {
                            literal.map(true);
                        }
                        flags.text(literal, out);
                        if byte == Some(b'%') {
                            state.at -= 1;
                        }
                    }
                    state.scan = Scan::Literal;
                    work = work.saturating_sub(64);
                }
            }
        }
        Ok(())
    }

    fn conversion(
        &self,
        code: u8,
        modifier: Option<u8>,
        colons: usize,
        flags: Flags,
        out: &mut Rendered,
    ) -> Result<bool, StreamError> {
        let c = &self.config;
        let hour12 = if c.hour % 12 == 0 { 12 } else { c.hour % 12 };
        if code == b'z' {
            self.offset(colons, flags, out);
            return Ok(true);
        }
        if code == b'N' {
            let digits = format!("{:09}", c.nanosecond);
            let width = flags.width.unwrap_or(9);
            let digits = &digits[..width.min(9)];
            let trimmed = if matches!(flags.pad, Some(b'-' | b'_')) {
                digits.trim_end_matches('0')
            } else {
                digits
            };
            let kept = trimmed.len().max(usize::from(width > 0));
            let width = if flags.pad == Some(b'-') { kept } else { width };
            out.extend_from_slice(&digits.as_bytes()[..kept]);
            out.fill(
                if flags.pad == Some(b'_') { b' ' } else { b'0' },
                width.saturating_sub(kept),
            );
            return Ok(true);
        }
        let numeric = match code {
            b'C' => Some((
                if modifier == Some(b'E') {
                    c.year.div_euclid(100)
                } else {
                    c.year / 100
                },
                2,
                false,
            )),
            b'd' | b'e' => Some((c.day, 2, code == b'e')),
            b'g' => Some((
                if modifier.is_some() {
                    self.iso_year.rem_euclid(100)
                } else {
                    self.iso_year.abs() % 100
                },
                2,
                false,
            )),
            b'G' => Some((self.iso_year, 4, false)),
            b'H' | b'k' => Some((c.hour, 2, code == b'k')),
            b'I' | b'l' => Some((hour12, 2, code == b'l')),
            b'j' => Some((self.ordinal, 3, false)),
            b'm' => Some((c.month as i64, 2, false)),
            b'M' => Some((c.minute, 2, false)),
            b'q' => Some(((c.month as i64 - 1) / 3 + 1, 1, false)),
            b'S' => Some((c.second, 2, false)),
            b's' => Some((c.epoch, 1, false)),
            b'u' => Some(((self.weekday + 6) % 7 + 1, 1, false)),
            b'U' => Some(((self.ordinal + 6 - self.weekday) / 7, 2, false)),
            b'V' => Some((self.iso_week, 2, false)),
            b'w' => Some((self.weekday, 1, false)),
            b'W' => Some(((self.ordinal + 6 - (self.weekday + 6) % 7) / 7, 2, false)),
            b'y' => Some((
                if modifier.is_some() {
                    c.year.rem_euclid(100)
                } else {
                    c.year.abs() % 100
                },
                2,
                false,
            )),
            b'Y' => Some((c.year, 4, false)),
            _ => None,
        };
        if let Some((value, natural, space)) = numeric {
            let natural =
                if modifier.is_some() && (b"CY".contains(&code) || code == b'G' && value >= 0) {
                    1
                } else {
                    natural
                };
            let plus = flags.pad == Some(b'+')
                && b"CGYyg".contains(&code)
                && (value >= 10i64.pow(natural as u32) || flags.width.is_some_and(|w| w > natural));
            if code == b'C' && c.year < 0 && value == 0 {
                flags.signed("-", 0, natural, space, out);
            } else {
                flags.number(value, natural, space, plus, out);
            }
            return Ok(true);
        }
        let composite = match code {
            b'c' => Some(b"%a %b %e %H:%M:%S %-Y".as_slice()),
            b'x' => Some(b"%m/%d/%Oy".as_slice()),
            b'r' => Some(b"%I:%M:%S %p".as_slice()),
            b'R' => Some(b"%H:%M".as_slice()),
            b'T' | b'X' => Some(b"%H:%M:%S".as_slice()),
            _ => None,
        };
        let mut text = if code == b'D' {
            let mut date = Rendered::default();
            self.layout(b"%m/%d/", &mut date)?;
            Flags {
                width: None,
                ..flags
            }
            .number(c.year.abs() % 100, 2, false, false, &mut date);
            date
        } else if code == b'F' {
            let mut date = Rendered::default();
            let width = flags
                .width
                .map(|w| w.saturating_sub(6))
                .unwrap_or(if flags.pad.is_none() { 4 } else { 0 });
            let year_flags = Flags {
                pad: flags.pad,
                width: Some(if flags.pad == Some(b'_') { 0 } else { width }),
                ..Flags::default()
            };
            let plus = flags.pad == Some(b'+') || flags.pad.is_none() && flags.width.is_none();
            year_flags.number(
                c.year,
                0,
                false,
                plus && (c.year > 9999 || width > 4),
                &mut date,
            );
            self.layout(b"-%m-%d", &mut date)?;
            if flags.pad != Some(b'_') {
                out.append(date);
                return Ok(true);
            }
            date
        } else if let Some(format) = composite {
            let mut text = Rendered::default();
            self.layout(format, &mut text)?;
            text
        } else {
            let mut text = Rendered::default();
            if code == b'Z' {
                text.span(Source::Zone, 0..c.zone.len());
            } else {
                text.extend_from_slice(match code {
                    b'a' => &WEEKDAYS[self.weekday as usize].as_bytes()[..3],
                    b'A' => WEEKDAYS[self.weekday as usize].as_bytes(),
                    b'b' | b'h' => &MONTHS[c.month - 1].as_bytes()[..3],
                    b'B' => MONTHS[c.month - 1].as_bytes(),
                    b'n' => b"\n",
                    b't' => b"\t",
                    b'p' => {
                        if c.hour < 12 {
                            b"AM"
                        } else {
                            b"PM"
                        }
                    }
                    b'P' => {
                        if c.hour < 12 {
                            b"am"
                        } else {
                            b"pm"
                        }
                    }
                    _ => return Ok(false),
                });
            }
            text
        };
        if flags.swap && b"pZ".contains(&code) {
            text.map(false);
        } else if flags.upper && code != b'P' || flags.swap && b"aAbBh".contains(&code) {
            text.map(true);
        }
        flags.text(text, out);
        Ok(true)
    }

    fn offset(&self, colons: usize, flags: Flags, out: &mut Rendered) {
        let total = self.config.offset.unsigned_abs();
        let sign = if self.config.offset < 0 { "-" } else { "+" };
        let hours = total / 3600;
        let minutes = total / 60 % 60;
        let seconds = total % 60;
        if colons == 0 {
            return flags.signed(sign, hours * 100 + minutes, 5, false, out);
        }
        let tail = if colons == 1 || colons == 3 && minutes != 0 && seconds == 0 {
            format!(":{minutes:02}")
        } else if colons == 2 || seconds != 0 {
            format!(":{minutes:02}:{seconds:02}")
        } else {
            String::new()
        };
        let hours_flags = Flags {
            width: flags.width.map(|w| w.saturating_sub(tail.len())),
            ..flags
        };
        hours_flags.signed(sign, hours, 3, false, out);
        out.extend_from_slice(tail.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::{Stream, open};

    fn moment() -> Value {
        json!({"year": 2026, "month": 1, "day": 1, "hour": 0, "minute": 0,
            "second": 1, "nanosecond": 123456000, "epoch": 1767225601,
            "offset": 0, "zone": "UTC"})
    }

    fn render(config: &Value, format: &[u8]) -> Vec<u8> {
        let mut stream = open("strftime", config.to_string().as_bytes()).unwrap();
        let mut out = Vec::new();
        for byte in format.chunks(1) {
            stream.feed(byte, &mut out).unwrap();
        }
        assert!(out.is_empty());
        stream.finish(&mut out).unwrap();
        let expected = out.clone();
        stream.finish(&mut out).unwrap();
        stream.feed(b"ignored", &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        assert_eq!(out, expected);
        out
    }

    #[test]
    fn directives_and_refused_modifiers_match_date_9_7() {
        assert_eq!(render(&moment(), "%^d|%#d|%^C|%#P|%Ea|%EY|%Ob|%OC|%6Q|%06Q|%6%|%06%|%::::z|%:%z|%E|%O|%12|%%N".as_bytes()), "01|01|20|am|%Ea|2026|Jan|20|   %6Q|00%06Q|    %6%|000%06%|%::::z|%:+0000|%E|%O|        %12|%N".as_bytes());
    }

    #[test]
    fn gregorian_years_and_iso_weeks_do_not_depend_on_host_date_libraries() {
        for (year, month, day, hour, minute, second, expected) in [
            (
                1,
                1,
                1,
                0,
                0,
                0,
                "0001|0001|01|01|001|00|01|Mon|0001-01-01|01/01/01|01/01/01|Mon Jan  1 00:00:00 1",
            ),
            (
                0,
                1,
                1,
                0,
                0,
                0,
                "0000|-001|01|52|001|00|00|Sat|0000-01-01|01/01/00|01/01/00|Sat Jan  1 00:00:00 0",
            ),
            (
                -1,
                1,
                1,
                0,
                0,
                0,
                "-001|-002|02|53|001|00|00|Fri|-001-01-01|01/01/01|01/01/99|Fri Jan  1 00:00:00 -1",
            ),
            (
                10026,
                9,
                3,
                5,
                7,
                9,
                "10026|10026|26|36|246|35|35|Thu|+10026-09-03|09/03/26|09/03/26|Thu Sep  3 05:07:09 10026",
            ),
            (
                2017,
                1,
                1,
                0,
                0,
                0,
                "2017|2016|16|52|001|01|00|Sun|2017-01-01|01/01/17|01/01/17|Sun Jan  1 00:00:00 2017",
            ),
            (
                2021,
                1,
                1,
                0,
                0,
                0,
                "2021|2020|20|53|001|00|00|Fri|2021-01-01|01/01/21|01/01/21|Fri Jan  1 00:00:00 2021",
            ),
        ] {
            let mut config = moment();
            for (key, value) in [
                ("year", year),
                ("month", month),
                ("day", day),
                ("hour", hour),
                ("minute", minute),
                ("second", second),
            ] {
                config[key] = json!(value);
            }
            assert_eq!(
                render(&config, "%Y|%G|%g|%V|%j|%U|%W|%a|%F|%D|%x|%c".as_bytes()),
                expected.as_bytes(),
                "{year}-{month}-{day}"
            );
        }
    }

    #[test]
    fn nanosecond_padding_and_bare_dash_follow_date() {
        let format = b"%N|%-N|%--N|%_N|%-12N|%_12N|%3N|%12N";
        assert_eq!(
            render(&moment(), format),
            b"123456000|123456000|123456|123456   |123456|123456      |123|123456000000"
        );
        let mut config = moment();
        config["nanosecond"] = json!(0);
        assert_eq!(
            render(&config, format),
            b"000000000|000000000|0|0        |0|0           |000|000000000000"
        );
    }

    #[test]
    fn numeric_and_composite_padding_have_different_width_rules() {
        assert_eq!(render(&moment(), b"%1d|%3d|%-3d|%_3d|%+6Y|%_+5Y|%+_5Y|%12F|%+12F|%12D|%012D|%^c"),
            b"1|001|1|  1|+02026|+2026| 2026|002026-01-01|+02026-01-01|    01/01/26|000001/01/26|THU JAN  1 00:00:01 2026");
    }

    #[test]
    fn offsets_and_negative_epochs_pad_after_the_sign() {
        let mut config = moment();
        config["offset"] = json!(19800);
        config["epoch"] = json!(-1);
        assert_eq!(
            render(&config, b"%z|%:z|%::z|%:::z|%-z|%_z|%8:z|%_8:z|%3s|%_3s"),
            b"+0530|+05:30|+05:30:00|+05:30|+530| +530|+0005:30|   +5:30|-01| -1"
        );
        config["offset"] = json!(-1800);
        assert_eq!(
            render(&config, b"%z|%-z|%_z|%-:z|%_:::z"),
            b"-0030|-30|  -30|-0:30| -0:30"
        );
        config["offset"] = json!(3661);
        assert_eq!(
            render(&config, b"%z|%:z|%::z|%:::z"),
            b"+0101|+01:01|+01:01:01|+01:01:01"
        );
    }

    #[test]
    fn format_bytes_survive_chunk_boundaries() {
        let format = [b"\xff\xef\xbb\xbf".as_slice(), "😀%Y".as_bytes()].concat();
        let expected = [b"\xff\xef\xbb\xbf".as_slice(), "😀2026".as_bytes()].concat();
        assert_eq!(render(&moment(), &format), expected);
    }

    #[test]
    fn invalid_fields_and_overflowing_widths_fail() {
        for (key, value) in [
            ("month", 0),
            ("day", 32),
            ("hour", 24),
            ("minute", 60),
            ("second", 61),
            ("nanosecond", 1000000000),
            ("offset", 86400),
            ("unknown", 1),
        ] {
            let mut config = moment();
            config[key] = json!(value);
            assert!(
                open("strftime", config.to_string().as_bytes()).is_err(),
                "{key}"
            );
        }
        let mut config = moment();
        config["month"] = json!(2);
        config["day"] = json!(29);
        assert!(open("strftime", config.to_string().as_bytes()).is_err());
    }

    #[test]
    fn wide_fields_are_written_a_window_at_a_time() {
        let mut stream = open("strftime", moment().to_string().as_bytes()).unwrap();
        stream.feed(b"%70000Y|%_5a", &mut Vec::new()).unwrap();
        let mut out = Vec::new();
        stream.finish(&mut out).unwrap();
        assert_eq!(out.len(), super::OUTPUT);
        while stream.busy() {
            let mut window = Vec::new();
            stream.drain(&mut window).unwrap();
            assert!(window.len() <= super::OUTPUT);
            out.extend(window);
        }
        let mut expected = vec![b'0'; 69996];
        expected.extend(b"2026|  Thu");
        assert!(out == expected);
    }

    #[test]
    fn long_literals_and_directives_resume_without_changing_bytes() {
        let n = super::WORK * 5 + 3;
        let mut config = moment();
        config["zone"] = json!("mIx".repeat(n));
        let cases = [
            (vec![b'x'; n], vec![b'x'; n]),
            (
                ["é😀".repeat(n / 6).into_bytes(), b"%Y".to_vec()].concat(),
                ["é😀".repeat(n / 6).into_bytes(), b"2026".to_vec()].concat(),
            ),
            (
                [b"%".as_slice(), &vec![b'^'; n], b"Z"].concat(),
                b"MIX".repeat(n),
            ),
            (
                [b"%".as_slice(), &vec![b':'; n], b"z"].concat(),
                [b"%".as_slice(), &vec![b':'; n], b"z"].concat(),
            ),
            (
                [b"%".as_slice(), &vec![b'^'; n], b"q?"].concat(),
                b"1?".to_vec(),
            ),
            (
                [b"%".as_slice(), &vec![b'^'; n], b"Q"].concat(),
                [b"%".as_slice(), &vec![b'^'; n], b"Q"].concat(),
            ),
            (
                [b"%-".as_slice(), &vec![b'9'; n], b"Y"].concat(),
                b"2026".to_vec(),
            ),
            (
                [b"%".as_slice(), &vec![b'^'; n], b"%Y"].concat(),
                [b"%".as_slice(), &vec![b'^'; n], b"2026"].concat(),
            ),
            (
                [b"%".as_slice(), &vec![b'^'; n]].concat(),
                [b"%".as_slice(), &vec![b'^'; n]].concat(),
            ),
            (
                b"%#Z|%^Z".to_vec(),
                [b"mix".repeat(n), b"|".to_vec(), b"MIX".repeat(n)].concat(),
            ),
        ];
        for (format, expected) in cases {
            let mut stream =
                super::Strftime::new(serde_json::from_value(config.clone()).unwrap()).unwrap();
            let mut out = Vec::new();
            stream.feed(&format, &mut out).unwrap();
            stream.drain(&mut out).unwrap();
            assert!(out.is_empty());
            stream.finish(&mut out).unwrap();
            let mut calls = 1;
            while stream.busy() {
                let at = stream.layout.at;
                let mut chunk = Vec::new();
                stream.drain(&mut chunk).unwrap();
                if !stream.format.is_empty() {
                    assert!(stream.layout.at - at <= super::WORK);
                }
                assert!(chunk.len() <= super::OUTPUT);
                out.extend(chunk);
                calls += 1;
                assert!(calls < n);
            }
            assert_eq!(out, expected);
            stream.finish(&mut out).unwrap();
            assert_eq!(out, expected);
            let mut sync = Vec::new();
            stream.render(&format, &mut sync).unwrap();
            assert_eq!(sync, expected);
        }
    }

    #[test]
    fn host_drain_returns_during_a_long_directive_without_output() {
        let mut stream = open("strftime", moment().to_string().as_bytes()).unwrap();
        let format = [b"%".as_slice(), &vec![b'^'; super::WORK * 20], b"Y"].concat();
        let mut out = Vec::new();
        stream.feed(&format, &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        assert!(out.is_empty());
        crate::drain_steps(stream.as_mut(), &mut out).unwrap();
        assert!(out.is_empty());
        assert!(stream.busy());
        while stream.busy() {
            crate::drain_steps(stream.as_mut(), &mut out).unwrap();
        }
        assert_eq!(out, b"2026");
    }

    #[test]
    fn completed_formats_are_released_while_padding_or_zone_output_remains() {
        let n = super::WORK * 5;
        let mut config = moment();
        config["zone"] = json!("mIx".repeat(n));
        for suffix in [b"2147483647Y".as_slice(), b"Z"] {
            let mut stream =
                super::Strftime::new(serde_json::from_value(config.clone()).unwrap()).unwrap();
            let format = [b"%".as_slice(), &vec![b'^'; n], suffix].concat();
            let mut out = Vec::new();
            stream.feed(&format, &mut out).unwrap();
            stream.finish(&mut out).unwrap();
            while out.is_empty() {
                stream.drain(&mut out).unwrap();
            }
            assert!(stream.busy());
            assert_eq!(stream.format.capacity(), 0);
            if suffix == b"Z" {
                while stream.busy() {
                    stream.drain(&mut out).unwrap();
                }
                assert_eq!(out, b"MIX".repeat(n));
            } else {
                assert!(out.iter().all(|&byte| byte == b'0'));
            }
        }
    }

    #[test]
    fn pending_literal_spans_keep_the_format_until_their_output_is_written() {
        let mut stream = super::Strftime::new(serde_json::from_value(moment()).unwrap()).unwrap();
        let format = [b"%".as_slice(), &vec![b'^'; super::WORK * 5], b"70000Ytail"].concat();
        let mut out = Vec::new();
        stream.feed(&format, &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        while out.is_empty() {
            stream.drain(&mut out).unwrap();
        }
        assert!(stream.layout.done(&stream.format));
        assert!(stream.busy());
        assert!(!stream.format.is_empty());
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        assert_eq!(stream.format.capacity(), 0);
        let expected = [vec![b'0'; 69996], b"2026tail".to_vec()].concat();
        assert_eq!(out, expected);
    }

    #[test]
    fn widths_past_what_date_reads_are_its_widest() {
        let time = super::Strftime::utc(0, 0).unwrap();
        let mut rendered = super::Rendered::default();
        time.layout(b"%1844674407370955161600Y", &mut rendered)
            .unwrap();
        assert_eq!(rendered.len, super::MAX_WIDTH);
        assert!(matches!(
            rendered.pieces.front(),
            Some(super::Piece::Fill(b'0', fill)) if *fill == super::MAX_WIDTH - 4
        ));
    }
}
