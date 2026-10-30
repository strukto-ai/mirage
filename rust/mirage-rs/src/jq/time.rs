// Adapted from jq 1.8.2 (MIT), src/builtin.c: tm2jv, jv2tm, f_mktime, f_gmtime, f_localtime, f_strptime, f_strftime, f_strflocaltime, set_tm_wday and set_tm_yday. See licenses/third_party/jq.txt.

use std::sync::{Arc, OnceLock};

use super::builtin::{Cfunc, Fault};
use super::meter::Charge;
use super::value::{Text, Value};

type Answer = Result<Value, Fault>;

const DAY: i64 = 86400;
const YEAR_MIN: i64 = i32::MIN as i64 + 1900;
const YEAR_MAX: i64 = i32::MAX as i64 + 1900;
const CONVERT: &str = "error converting number of seconds since epoch to datetime";
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const UTC_NAMES: [(&str, &str); 12] = [
    ("UTC", "UTC"),
    ("Etc/UTC", "UTC"),
    ("UCT", "UTC"),
    ("Etc/UCT", "UTC"),
    ("Zulu", "UTC"),
    ("Etc/Zulu", "UTC"),
    ("Universal", "UTC"),
    ("Etc/Universal", "UTC"),
    ("GMT", "GMT"),
    ("Etc/GMT", "GMT"),
    ("Greenwich", "GMT"),
    ("Etc/Greenwich", "GMT"),
];

fn fail(message: impl Into<String>) -> Fault {
    Fault::Error(Value::string(message.into()))
}

/// What the host gives a run: the local time zone, which `localtime`,
/// `strflocaltime` and `strptime`'s `%s` consult. `now` asks the host.
#[derive(Clone, Debug)]
pub(crate) struct Clock {
    pub(crate) zone: Arc<Zone>,
}

impl Default for Clock {
    /// UTC, parsed once and shared: every run starts on it before the
    /// host's zone replaces it.
    fn default() -> Self {
        static UTC: OnceLock<Arc<Zone>> = OnceLock::new();
        Self {
            zone: Arc::clone(UTC.get_or_init(|| Arc::new(Zone::parse("UTC")))),
        }
    }
}

/// The local time zone a `TZ` value names: a file of the tz database, or
/// a POSIX rule.
#[derive(Debug, PartialEq)]
pub(crate) enum Zone {
    File(Tzif),
    Posix(Posix),
}

/// A POSIX `TZ` rule: a standard offset and name, and optionally a daylight
/// offset and name with the rules that switch between them.
#[derive(Debug, PartialEq)]
pub(crate) struct Posix {
    std: Offset,
    dst: Option<Daylight>,
}

/// A zone file of the tz database (TZif, RFC 8536): the instants its local
/// time changes, the type of local time each starts, and the POSIX rule
/// that goes on past the last.
#[derive(Debug, PartialEq)]
pub(crate) struct Tzif {
    times: Vec<i64>,
    starts: Vec<usize>,
    types: Vec<Fix>,
    after: Option<Posix>,
}

#[derive(Debug, PartialEq)]
struct Offset {
    name: Arc<Text>,
    east: i64,
}

#[derive(Debug, PartialEq)]
struct Daylight {
    offset: Offset,
    start: Rule,
    end: Rule,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rule {
    day: Day,
    time: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Day {
    Julian(i64),
    Zero(i64),
    Month(i64, i64, i64),
}

#[derive(Clone, Debug, PartialEq)]
struct Fix {
    east: i64,
    dst: bool,
    name: Arc<Text>,
}

impl Zone {
    /// The zone a `TZ` value names, as glibc's tzset reads one: past a
    /// leading `:`, a file of the tz database this engine carries, by its
    /// name or a path ending in `zoneinfo/` and its name, else a POSIX
    /// rule, else UTC under the value's leading letters, or under no name
    /// when there are fewer than three.
    pub(crate) fn parse(text: &str) -> Zone {
        let text = text.strip_prefix(':').unwrap_or(text);
        if text.is_empty() {
            return Zone::Posix(Posix::fixed("UTC"));
        }
        if let Some((_, name)) = UTC_NAMES.iter().find(|(n, _)| *n == text) {
            return Zone::Posix(Posix::fixed(name));
        }
        let name = text.rsplit_once("zoneinfo/").map_or(text, |(_, name)| name);
        let file = jiff_tzdb::get(name).filter(|(found, _)| *found == name);
        if let Some(zone) = file.and_then(|(_, data)| Tzif::parse(data)) {
            return Zone::File(zone);
        }
        if let Some(rule) = Posix::parse(text) {
            return Zone::Posix(rule);
        }
        let letters = text.bytes().take_while(u8::is_ascii_alphabetic).count();
        Zone::Posix(Posix::fixed(if letters < 3 {
            ""
        } else {
            &text[..letters]
        }))
    }

    fn at(&self, t: i64) -> Fix {
        match self {
            Zone::File(file) => file.at(t),
            Zone::Posix(rule) => rule.at(t),
        }
    }

    /// mktime with tm_isdst of -1: the instant a wall-clock reading
    /// (seconds since the epoch as if it were UTC) names, the reading
    /// nearer UTC when it occurs twice, as glibc's mktime answers it first
    /// in a run, and the offset before the change when it is skipped.
    fn instant(&self, wall: i64) -> i64 {
        let before = self.at(wall - DAY);
        let after = self.at(wall + DAY);
        let mut offsets = [&before, &after];
        offsets.sort_by_key(|fix| fix.east.abs());
        for fix in offsets {
            let t = wall - fix.east;
            if self.at(t).east == fix.east {
                return t;
            }
        }
        wall - before.east
    }

    /// mktime with tm_isdst of 0, which strftime's %s calls on the time it
    /// read as UTC: the instant a wall-clock reading names under the
    /// standard offset in force near it.
    fn standard(&self, wall: i64) -> i64 {
        let near = self.instant(wall);
        let east = match self {
            Zone::Posix(rule) => rule.std.east,
            Zone::File(file) => file.standard(near),
        };
        wall - east
    }
}

impl Tzif {
    fn parse(data: &[u8]) -> Option<Tzif> {
        let counts = |at: usize| -> Option<[usize; 6]> {
            if data.get(at..at + 4)? != b"TZif" {
                return None;
            }
            let mut counts = [0; 6];
            for (i, count) in counts.iter_mut().enumerate() {
                let field = data.get(at + 20 + 4 * i..at + 24 + 4 * i)?;
                *count = u32::from_be_bytes(field.try_into().ok()?) as usize;
            }
            Some(counts)
        };
        let [isut, isstd, leaps, times, types, chars] = counts(0)?;
        let (wide, mut at) = if *data.get(4)? >= b'2' {
            (
                8,
                44 + times * 5 + types * 6 + chars + leaps * 8 + isstd + isut,
            )
        } else {
            (4, 0)
        };
        let [isut, isstd, leaps, times, types, chars] = counts(at)?;
        at += 44;
        let mut take = |len: usize| -> Option<&[u8]> {
            let bytes = data.get(at..at + len)?;
            at += len;
            Some(bytes)
        };
        let instants = take(times * wide)?
            .chunks(wide)
            .map(|b| match wide {
                8 => i64::from_be_bytes(b.try_into().expect("8 bytes")),
                _ => i64::from(i32::from_be_bytes(b.try_into().expect("4 bytes"))),
            })
            .collect();
        let starts: Vec<usize> = take(times)?.iter().map(|&i| usize::from(i)).collect();
        let records = take(types * 6)?.to_vec();
        let names = take(chars)?.to_vec();
        take(leaps * (wide + 4) + isstd + isut)?;
        let types: Vec<Fix> = records
            .chunks(6)
            .map(|r| {
                let from = usize::from(r[5]).min(names.len());
                let name = names[from..].split(|&b| b == 0).next().unwrap_or_default();
                Fix {
                    east: i64::from(i32::from_be_bytes([r[0], r[1], r[2], r[3]])),
                    dst: r[4] != 0,
                    name: Arc::new(Text::new(String::from_utf8_lossy(name).into())),
                }
            })
            .collect();
        if types.is_empty() || starts.iter().any(|&i| i >= types.len()) {
            return None;
        }
        let footer = if wide == 8 { data.get(at..) } else { None };
        let after = footer
            .and_then(|rest| rest.strip_prefix(b"\n"))
            .and_then(|rest| rest.split(|&b| b == b'\n').next())
            .and_then(|rule| std::str::from_utf8(rule).ok())
            .filter(|rule| !rule.is_empty())
            .and_then(Posix::parse);
        Some(Tzif {
            times: instants,
            starts,
            types,
            after,
        })
    }

    /// The local time at `t`: before the first change, the first type
    /// that is not daylight time, as glibc takes it; past the last, the
    /// file's POSIX rule, when it has one.
    fn at(&self, t: i64) -> Fix {
        let n = self.times.partition_point(|&change| change <= t);
        if n == 0 {
            let first = self.types.iter().find(|fix| !fix.dst);
            return first.unwrap_or(&self.types[0]).clone();
        }
        if n == self.times.len() {
            if let Some(rule) = &self.after {
                return rule.at(t);
            }
        }
        self.types[self.starts[n - 1]].clone()
    }

    /// The offset of standard time at `t`: of the type in force when it is
    /// not daylight time, else of the last standard type before it, past
    /// the last change the rule's, else the first after it.
    fn standard(&self, t: i64) -> i64 {
        let fix = self.at(t);
        if !fix.dst {
            return fix.east;
        }
        let n = self.times.partition_point(|&change| change <= t);
        if let (true, Some(rule)) = (n == self.times.len(), &self.after) {
            return rule.std.east;
        }
        let earlier = self.starts[..n].iter().rev();
        let mut types = earlier.chain(&self.starts[n..]).map(|&i| &self.types[i]);
        types
            .find(|other| !other.dst)
            .map_or(fix.east, |other| other.east)
    }
}

impl Posix {
    fn parse(text: &str) -> Option<Posix> {
        let mut at = Cursor { text, at: 0 };
        let name = at.name()?;
        let std = Offset {
            name,
            east: -at.offset()?,
        };
        if at.done() {
            return Some(Posix { std, dst: None });
        }
        let name = at.name()?;
        let east = if at.peek().is_some_and(|c| c != b',') {
            -at.offset()?
        } else {
            std.east + 3600
        };
        let (start, end) = if at.eat(b',') {
            let start = at.rule()?;
            if !at.eat(b',') {
                return None;
            }
            (start, at.rule()?)
        } else {
            let rule = |month, week| Rule {
                day: Day::Month(month, week, 0),
                time: 7200,
            };
            (rule(3, 2), rule(11, 1))
        };
        if !at.done() {
            return None;
        }
        Some(Posix {
            std,
            dst: Some(Daylight {
                offset: Offset { name, east },
                start,
                end,
            }),
        })
    }

    fn fixed(name: &str) -> Posix {
        Posix {
            std: Offset {
                name: Arc::new(Text::new(name.into())),
                east: 0,
            },
            dst: None,
        }
    }

    fn at(&self, t: i64) -> Fix {
        let std = Fix {
            east: self.std.east,
            dst: false,
            name: self.std.name.clone(),
        };
        let Some(dst) = &self.dst else {
            return std;
        };
        let (year, ..) = civil(t.saturating_add(self.std.east).div_euclid(DAY));
        let start = dst.start.local(year) - self.std.east;
        let end = dst.end.local(year) - dst.offset.east;
        let summer = if start < end {
            t >= start && t < end
        } else {
            !(t >= end && t < start)
        };
        if summer {
            Fix {
                east: dst.offset.east,
                dst: true,
                name: dst.offset.name.clone(),
            }
        } else {
            std
        }
    }
}

impl Rule {
    fn local(&self, year: i64) -> i64 {
        let leap = is_leap(year);
        let days = match self.day {
            Day::Julian(n) => n - 1 + i64::from(leap && n >= 60),
            Day::Zero(n) => n,
            Day::Month(month, week, weekday) => {
                let first = days_from_civil(year, month, 1);
                let lead = (weekday - (first + 4).rem_euclid(7)).rem_euclid(7);
                let mut day = 1 + lead + (week - 1) * 7;
                if day > month_days(year, month) {
                    day -= 7;
                }
                return (first + day - 1) * DAY + self.time;
            }
        };
        (days_from_civil(year, 1, 1) + days) * DAY + self.time
    }
}

struct Cursor<'a> {
    text: &'a str,
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn done(&self) -> bool {
        self.at >= self.text.len()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        if found {
            self.at += 1;
        }
        found
    }

    fn name(&mut self) -> Option<Arc<Text>> {
        let rest = &self.text[self.at..];
        if let Some(quoted) = rest.strip_prefix('<') {
            let end = quoted.find('>')?;
            let name = &quoted[..end];
            if name.is_empty() {
                return None;
            }
            self.at += end + 2;
            return Some(Arc::new(Text::new(name.into())));
        }
        let len = rest.bytes().take_while(u8::is_ascii_alphabetic).count();
        if len < 3 {
            return None;
        }
        self.at += len;
        Some(Arc::new(Text::new(rest[..len].into())))
    }

    fn number(&mut self) -> Option<i64> {
        let start = self.at;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.at += 1;
        }
        if self.at == start || self.at - start > 6 {
            return None;
        }
        self.text[start..self.at].parse().ok()
    }

    /// `[+-]hh[:mm[:ss]]` in seconds.
    fn offset(&mut self) -> Option<i64> {
        let sign = if self.eat(b'-') {
            -1
        } else {
            self.eat(b'+');
            1
        };
        let mut seconds = self.number()? * 3600;
        if self.eat(b':') {
            seconds += self.number()? * 60;
            if self.eat(b':') {
                seconds += self.number()?;
            }
        }
        Some(sign * seconds)
    }

    fn rule(&mut self) -> Option<Rule> {
        let day = if self.eat(b'M') {
            let month = self.number()?;
            if !self.eat(b'.') {
                return None;
            }
            let week = self.number()?;
            if !self.eat(b'.') {
                return None;
            }
            let weekday = self.number()?;
            if !(1..=12).contains(&month) || !(1..=5).contains(&week) || weekday > 6 {
                return None;
            }
            Day::Month(month, week, weekday)
        } else if self.eat(b'J') {
            let n = self.number()?;
            if !(1..=365).contains(&n) {
                return None;
            }
            Day::Julian(n)
        } else {
            let n = self.number()?;
            if n > 365 {
                return None;
            }
            Day::Zero(n)
        };
        let time = if self.eat(b'/') { self.offset()? } else { 7200 };
        Some(Rule { day, time })
    }
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn month_days(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date, month 1 to 12.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// The date of a day count: year, month 1 to 12, day.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A broken-down time: struct tm with the year in full.
#[derive(Clone, Debug)]
struct Tm {
    year: i64,
    mon: i64,
    mday: i64,
    hour: i64,
    min: i64,
    sec: i64,
    wday: i64,
    yday: i64,
    east: i64,
    zone: Arc<Text>,
    epoch: i64,
}

impl Tm {
    /// gmtime_r, or localtime_r with a zone; None past the years a struct
    /// tm holds.
    fn at(t: i64, zone: Option<&Zone>) -> Option<Tm> {
        let fix = zone.map_or(
            Fix {
                east: 0,
                dst: false,
                name: Arc::new(Text::new("GMT".into())),
            },
            |z| z.at(t),
        );
        let local = t.checked_add(fix.east)?;
        let days = local.div_euclid(DAY);
        let secs = local.rem_euclid(DAY);
        let (year, month, day) = civil(days);
        if !(YEAR_MIN..=YEAR_MAX).contains(&year) {
            return None;
        }
        Some(Tm {
            year,
            mon: month - 1,
            mday: day,
            hour: secs / 3600,
            min: secs % 3600 / 60,
            sec: secs % 60,
            wday: (days + 4).rem_euclid(7),
            yday: days - days_from_civil(year, 1, 1),
            east: fix.east,
            zone: fix.name,
            epoch: t,
        })
    }

    /// The year as jq prints it, tm_year plus 1900 in an int.
    fn shown_year(&self) -> i64 {
        shown(self.year)
    }

    fn jv(&self, fsecs: f64) -> Value {
        Value::array(vec![
            Value::number(self.shown_year() as f64),
            Value::number(self.mon as f64),
            Value::number(self.mday as f64),
            Value::number(self.hour as f64),
            Value::number(self.min as f64),
            Value::number(self.sec as f64 + (fsecs - fsecs.floor())),
            Value::number(self.wday as f64),
            Value::number(self.yday as f64),
        ])
    }
}

/// The int fields of a struct tm as jv2tm reads them from an array.
#[derive(Clone, Copy, Default)]
struct Fields {
    year: i32,
    mon: i32,
    mday: i32,
    hour: i32,
    min: i32,
    sec: i32,
}

/// jv2tm's reading of an array, None for an element that is not a number.
fn fields(items: &[Value]) -> Option<Fields> {
    let mut raw = [0i32; 8];
    for (index, (slot, item)) in raw.iter_mut().zip(items).enumerate() {
        let d = item.as_f64().filter(|d| !d.is_nan())?;
        *slot = if index == 0 { d - 1900.0 } else { d } as i32;
    }
    Some(Fields {
        year: raw[0],
        mon: raw[1],
        mday: raw[2],
        hour: raw[3],
        min: raw[4],
        sec: raw[5],
    })
}

impl Fields {
    /// Seconds since the epoch of the fields read as UTC, with every field
    /// out of range carried into the next.
    fn wall(&self) -> i64 {
        let months = i64::from(self.year) + 1900;
        let year = months + i64::from(self.mon).div_euclid(12);
        let month = i64::from(self.mon).rem_euclid(12) + 1;
        let days = days_from_civil(year, month, 1) + i64::from(self.mday) - 1;
        days * DAY + i64::from(self.hour) * 3600 + i64::from(self.min) * 60 + i64::from(self.sec)
    }

    /// timegm: the normalised time, None when its year overflows a tm.
    fn utc(&self) -> Option<Tm> {
        Tm::at(self.wall(), None)
    }
}

/// The time the array in `value` names, read as UTC or as local time.
fn read(value: &Value, zone: Option<&Zone>) -> Option<Tm> {
    let Value::Array(items) = value else {
        return None;
    };
    let f = fields(items)?;
    let wall = f.wall();
    match zone {
        None => Tm::at(wall, None),
        Some(z) => Tm::at(z.instant(wall), Some(z)),
    }
}

/// A year as tm_year plus 1900 comes out of an int, wrapping past its
/// largest.
fn shown(year: i64) -> i64 {
    i64::from(((year - 1900) as i32).wrapping_add(1900))
}

/// A double as x86-64 converts it to time_t: NaN and values out of range
/// become the lowest.
fn time_t(secs: f64) -> i64 {
    if (-9.223_372_036_854_776e18..9.223_372_036_854_776e18).contains(&secs) {
        secs as i64
    } else {
        i64::MIN
    }
}

fn gmtime(input: &Value, zone: Option<&Zone>, name: &str) -> Answer {
    let Some(fsecs) = input.as_f64() else {
        return Err(fail(format!("{name}() requires numeric inputs")));
    };
    match Tm::at(time_t(fsecs), zone) {
        Some(tm) => Ok(tm.jv(fsecs)),
        None => Err(fail(CONVERT)),
    }
}

fn mktime(input: &Value) -> Answer {
    let Value::Array(items) = input else {
        return Err(fail("mktime requires array inputs"));
    };
    let Some(f) = fields(items) else {
        return Err(fail("mktime requires parsed datetime inputs"));
    };
    match f.utc().map(|tm| tm.epoch) {
        Some(-2) => Err(fail("mktime not supported on this platform")),
        None | Some(-1) => Err(fail("invalid gmtime representation")),
        Some(t) => Ok(Value::number(t as f64)),
    }
}

fn strftime(
    input: &Value,
    format: &Value,
    local: Option<&Zone>,
    process: &Zone,
    name: &str,
) -> Answer {
    let array = match input {
        Value::Number(_) => gmtime(input, local, name)?,
        Value::Array(_) => input.clone(),
        _ => return Err(fail(format!("{name}/1 requires parsed datetime inputs"))),
    };
    let Value::String(format) = format else {
        return Err(fail(format!("{name}/1 requires a string format")));
    };
    let Some(mut tm) = read(&array, local) else {
        return Err(fail(format!("{name}/1 requires parsed datetime inputs")));
    };
    if local.is_none() {
        tm.epoch = process.standard(tm.epoch);
    }
    let format = until_nul(format);
    let cap = format.len() + 100;
    let mut out = Vec::new();
    let fits = render(format.as_bytes(), &tm, &mut out, cap);
    let mut charge = Charge::open(out.capacity());
    if !fits || (out.is_empty() && !format.is_empty()) {
        return Err(fail(format!("{name}/1: unknown system failure")));
    }
    charge.set(0);
    Ok(Value::string(String::from_utf8_lossy(&out).into_owned()))
}

fn until_nul(text: &str) -> &str {
    text.split('\0').next().unwrap_or("")
}

/// The conversions an `E` modifier makes glibc's strftime print as they
/// are written, and those an `O` does.
const E_REFUSED: &[u8] = b"aAbBdDeFgGhHIjklmMSUVwW";
const O_REFUSED: &[u8] = b"aAcDFxXY";

/// A conversion's flags: the padding asked for (`_`, `-` or `0`), `^`,
/// `#`, and the width.
#[derive(Clone, Copy, Default)]
struct Flags {
    pad: Option<u8>,
    upper: bool,
    swap: bool,
    width: Option<usize>,
}

/// Text right-aligned in the width, padded with zeros under `0` and with
/// spaces otherwise.
fn text(out: &mut Vec<u8>, text: &[u8], flags: Flags) {
    let fill = if flags.pad == Some(b'0') { b'0' } else { b' ' };
    let padding = flags.width.unwrap_or(0).saturating_sub(text.len());
    out.extend(std::iter::repeat_n(fill, padding));
    out.extend_from_slice(text);
}

/// A number at least `natural` characters wide with its sign: zeros after
/// the sign or spaces before it, as the flags or the conversion (`zero`)
/// say, and under `-` spaces up to an explicit width only.
fn number(out: &mut Vec<u8>, value: i64, natural: usize, zero: bool, flags: Flags) {
    let width = flags.width.unwrap_or(0);
    let (fill, width) = match flags.pad {
        Some(b'-') => (b' ', width),
        Some(b'_') => (b' ', width.max(natural)),
        Some(_) => (b'0', width.max(natural)),
        None => (if zero { b'0' } else { b' ' }, width.max(natural)),
    };
    let digits = value.unsigned_abs().to_string();
    let padding = width.saturating_sub(digits.len() + usize::from(value < 0));
    if fill == b' ' {
        out.extend(std::iter::repeat_n(b' ', padding));
    }
    if value < 0 {
        out.push(b'-');
    }
    if fill == b'0' {
        out.extend(std::iter::repeat_n(b'0', padding));
    }
    out.extend_from_slice(digits.as_bytes());
}

fn weeks(year: i64) -> i64 {
    let p = |y: i64| (y + y.div_euclid(4) - y.div_euclid(100) + y.div_euclid(400)).rem_euclid(7);
    if p(year) == 4 || p(year - 1) == 3 {
        53
    } else {
        52
    }
}

/// The ISO 8601 week-based year and week.
fn iso_week(tm: &Tm) -> (i64, i64) {
    let monday = (tm.wday + 6) % 7;
    let week = (tm.yday - monday + 10) / 7;
    if week < 1 {
        (tm.year - 1, weeks(tm.year - 1))
    } else if week > weeks(tm.year) {
        (tm.year + 1, 1)
    } else {
        (tm.year, week)
    }
}

/// Write `format`'s expansion as glibc's strftime does, false once it
/// would not fit in `cap` bytes. A directive glibc does not know, or a
/// modifier on a conversion that refuses it, is written as it stands,
/// padded to its width and uppercased under `^`.
fn render(format: &[u8], tm: &Tm, out: &mut Vec<u8>, cap: usize) -> bool {
    let mut at = 0;
    while at < format.len() {
        if out.len() >= cap {
            return false;
        }
        let start = at;
        at += 1;
        if format[start] != b'%' {
            out.push(format[start]);
            continue;
        }
        let mut flags = Flags::default();
        while let Some(&flag) = format.get(at).filter(|f| b"_-0^#".contains(f)) {
            match flag {
                b'^' => flags.upper = true,
                b'#' => flags.swap = true,
                _ => flags.pad = Some(flag),
            }
            at += 1;
        }
        while let Some(&digit) = format.get(at).filter(|d| d.is_ascii_digit()) {
            let width = flags.width.unwrap_or(0).saturating_mul(10);
            flags.width = Some(width.saturating_add(usize::from(digit - b'0')));
            at += 1;
        }
        if flags.width.is_some_and(|width| width >= cap) {
            return false;
        }
        let modifier = format.get(at).copied().filter(|m| matches!(m, b'E' | b'O'));
        at += usize::from(modifier.is_some());
        let conv = format.get(at).copied();
        at += usize::from(conv.is_some());
        let refused = match (modifier, conv) {
            (_, None) => true,
            (Some(b'E'), Some(c)) => E_REFUSED.contains(&c),
            (Some(_), Some(c)) => O_REFUSED.contains(&c),
            (None, Some(_)) => false,
        };
        if refused || conversion(conv.unwrap_or(0), flags, tm, out).is_none() {
            let mut written = format[start..at].to_vec();
            if flags.upper {
                written.make_ascii_uppercase();
            }
            let fill = Flags {
                pad: flags.pad.filter(|&pad| pad == b'0'),
                ..flags
            };
            text(out, &written, fill);
        }
    }
    out.len() < cap
}

fn composite(format: &[u8], tm: &Tm) -> Vec<u8> {
    let mut out = Vec::new();
    render(format, tm, &mut out, usize::MAX);
    out
}

/// Write one conversion, or None for one glibc does not know.
fn conversion(conv: u8, flags: Flags, tm: &Tm, out: &mut Vec<u8>) -> Option<()> {
    let year = tm.shown_year();
    let hour12 = if tm.hour % 12 == 0 { 12 } else { tm.hour % 12 };
    let (iso_year, iso) = iso_week(tm);
    let iso_year = year + iso_year - tm.year;
    let weekday = tm.wday.rem_euclid(7) as usize;
    let month = tm.mon.rem_euclid(12) as usize;
    let mut words: Vec<u8> = match conv {
        b'a' => WEEKDAYS[weekday][..3].into(),
        b'A' => WEEKDAYS[weekday].into(),
        b'b' | b'h' => MONTHS[month][..3].into(),
        b'B' => MONTHS[month].into(),
        b'c' => composite(b"%a %b %e %H:%M:%S %Y", tm),
        b'D' | b'x' => composite(b"%m/%d/%y", tm),
        b'F' => composite(b"%Y-%m-%d", tm),
        b'n' => b"\n".into(),
        b't' => b"\t".into(),
        b'%' => b"%".into(),
        b'p' => (if tm.hour >= 12 { "PM" } else { "AM" }).into(),
        b'P' => (if tm.hour >= 12 { "pm" } else { "am" }).into(),
        b'r' => composite(b"%I:%M:%S %p", tm),
        b'R' => composite(b"%H:%M", tm),
        b'T' | b'X' => composite(b"%H:%M:%S", tm),
        b's' => tm.epoch.to_string().into(),
        b'Z' => tm.zone.as_bytes().into(),
        b'z' => {
            let minutes = tm.east.abs() / 60;
            text(out, if tm.east < 0 { b"-" } else { b"+" }, flags);
            number(out, minutes / 60 * 100 + minutes % 60, 4, true, flags);
            return Some(());
        }
        _ => {
            let (value, natural, zero) = match conv {
                b'C' => (year.div_euclid(100), 1, true),
                b'd' => (tm.mday, 2, true),
                b'e' => (tm.mday, 2, false),
                b'g' => (iso_year.rem_euclid(100), 2, true),
                b'G' => (iso_year, 1, true),
                b'H' => (tm.hour, 2, true),
                b'I' => (hour12, 2, true),
                b'j' => (tm.yday + 1, 3, true),
                b'k' => (tm.hour, 2, false),
                b'l' => (hour12, 2, false),
                b'm' => (tm.mon + 1, 2, true),
                b'M' => (tm.min, 2, true),
                b'S' => (tm.sec, 2, true),
                b'u' => (if tm.wday == 0 { 7 } else { tm.wday }, 1, true),
                b'U' => ((tm.yday + 7 - tm.wday) / 7, 2, true),
                b'V' => (iso, 2, true),
                b'w' => (tm.wday, 1, true),
                b'W' => ((tm.yday + 7 - (tm.wday + 6) % 7) / 7, 2, true),
                b'y' => (tm.year.rem_euclid(100), 2, true),
                b'Y' => (year, 1, true),
                _ => return None,
            };
            number(out, value, natural, zero, flags);
            return Some(());
        }
    };
    match conv {
        b'p' | b'Z' if flags.swap => words.make_ascii_lowercase(),
        b'a' | b'A' | b'b' | b'B' | b'h' if flags.upper || flags.swap => {
            words.make_ascii_uppercase();
        }
        b'P' => {}
        _ if flags.upper => words.make_ascii_uppercase(),
        _ => {}
    }
    text(out, &words, flags);
    Some(())
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// The days before each month in a common year then in a leap year.
const MONTH_STARTS: [i64; 26] = [
    0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365, 0, 31, 60, 91, 121, 152, 182, 213,
    244, 274, 305, 335, 366,
];

/// The days before month `mon` as glibc's strptime reads them: from the
/// year's row of the month starts and on past its end, through the leap
/// year's row, with the month before January taken as the day before
/// that row starts.
fn month_start(leap: bool, mon: i64) -> i64 {
    match usize::try_from(mon + if leap { 13 } else { 0 }) {
        Ok(at) => MONTH_STARTS.get(at).copied().unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

/// The weekday glibc's strptime works out for a date, counting the leap
/// days before it with division that truncates, which puts January and
/// February of year 0 a day late.
fn weekday(year: i64, mon: i64, mday: i64) -> i64 {
    let leaps = |y: i64| y / 4 - y / 100 + y / 400;
    let before = year - i64::from(mon < 2);
    let days =
        365 * (year - 1970) + leaps(before) - leaps(1969) + month_start(false, mon) + mday - 1;
    (days + 4).rem_euclid(7)
}

#[derive(Clone, Copy)]
enum Week {
    Sunday,
    Monday,
}

/// What a strptime format has read: struct tm's fields, with 8 and 367 in
/// the weekday and the day of the year until something sets them, as jq
/// starts them, and what the input named.
struct Scan {
    year: i64,
    mon: i64,
    mday: i64,
    hour: i64,
    min: i64,
    sec: i64,
    wday: i64,
    yday: i64,
    have_wday: bool,
    have_yday: bool,
    have_mon: bool,
    have_mday: bool,
    dated: bool,
    twelve: bool,
    pm: Option<bool>,
    century: Option<i64>,
    short: Option<i64>,
    week: Option<(Week, i64)>,
}

impl Default for Scan {
    fn default() -> Self {
        Scan {
            year: 1900,
            mon: 0,
            mday: 0,
            hour: 0,
            min: 0,
            sec: 0,
            wday: 8,
            yday: 367,
            have_wday: false,
            have_yday: false,
            have_mon: false,
            have_mday: false,
            dated: false,
            twelve: false,
            pm: None,
            century: None,
            short: None,
            week: None,
        }
    }
}

impl Scan {
    /// The month and the day of the month the day of the year falls in,
    /// for whichever the input did not name.
    fn walk(&mut self) {
        let leap = is_leap(self.year);
        let mut mon = 0;
        while self.yday >= month_start(leap, mon) {
            mon += 1;
        }
        if !self.have_mon {
            self.mon = mon - 1;
        }
        if !self.have_mday {
            self.mday = self.yday - month_start(leap, mon - 1) + 1;
        }
    }

    /// What glibc's strptime works out once the format is read: the hour
    /// `%p` moves, the year `%C` names, then the weekday and the day of the
    /// year a date gives, and the date a week number and a weekday give.
    fn finish(&mut self) {
        if self.twelve && self.pm == Some(true) {
            self.hour += 12;
        }
        if let Some(century) = self.century {
            self.year = century * 100 + self.short.unwrap_or(0);
        }
        if self.dated && !self.have_wday {
            if !(self.have_mon && self.have_mday) && self.have_yday {
                self.walk();
            }
            self.wday = weekday(self.year, self.mon, self.mday);
        }
        if self.dated && !self.have_yday {
            self.yday = month_start(is_leap(self.year), self.mon) + self.mday - 1;
        }
        if let (Some((week, n)), true) = (self.week, self.have_wday) {
            if !self.have_yday {
                let first = weekday(self.year, 0, 1);
                let day = match week {
                    Week::Sunday => (7 - first) % 7 + self.wday,
                    Week::Monday => (8 - first) % 7 + (self.wday + 6) % 7,
                };
                self.yday = (n - 1) * 7 + day;
            }
            self.walk();
        }
    }
}

struct Reader<'a> {
    input: &'a [u8],
    at: usize,
    scan: Scan,
    zone: Option<&'a Zone>,
}

impl Reader<'_> {
    fn rest(&self) -> &[u8] {
        &self.input[self.at..]
    }

    fn skip_space(&mut self) {
        while self.rest().first().is_some_and(|b| is_space(*b)) {
            self.at += 1;
        }
    }

    /// Past white space, one to `width` digits in `low..=high`. A field
    /// takes another digit only while ten times what it has read is still
    /// at most `high`, so `%m%d` reads `"228"` as February 28.
    fn number(&mut self, width: usize, low: i64, high: i64) -> Option<i64> {
        self.skip_space();
        let rest = self.rest();
        let mut value = 0i64;
        let mut len = 0;
        while let Some(digit) = rest.get(len).filter(|b| b.is_ascii_digit()) {
            if len == width || len > 0 && value.saturating_mul(10) > high {
                break;
            }
            value = value
                .saturating_mul(10)
                .saturating_add(i64::from(digit - b'0'));
            len += 1;
        }
        if len == 0 {
            return None;
        }
        self.at += len;
        (low..=high).contains(&value).then_some(value)
    }

    fn name(&mut self, names: &[&str]) -> Option<i64> {
        for long in [true, false] {
            for (index, name) in names.iter().enumerate() {
                let name = if long { name } else { &name[..3] };
                let rest = self.rest();
                if rest.len() >= name.len()
                    && rest[..name.len()].eq_ignore_ascii_case(name.as_bytes())
                {
                    self.at += name.len();
                    return Some(index as i64);
                }
            }
        }
        None
    }

    fn literal(&mut self, byte: u8) -> Option<()> {
        if self.rest().first() != Some(&byte) {
            return None;
        }
        self.at += 1;
        Some(())
    }

    fn run(&mut self, format: &[u8]) -> Option<()> {
        let mut at = 0;
        while at < format.len() {
            let c = format[at];
            at += 1;
            if is_space(c) {
                self.skip_space();
                continue;
            }
            if c != b'%' {
                self.literal(c)?;
                continue;
            }
            while format.get(at).is_some_and(|f| b"_-0^#".contains(f)) {
                at += 1;
            }
            while format.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            let modifier = format.get(at).copied().filter(|m| matches!(m, b'E' | b'O'));
            at += usize::from(modifier.is_some());
            let conv = *format.get(at)?;
            at += 1;
            let allowed = match modifier {
                None => true,
                Some(b'E') => b"cCxXY".contains(&conv),
                Some(_) => b"bBdehHImMSUVwWy".contains(&conv),
            };
            if !allowed {
                return None;
            }
            self.conversion(conv)?;
        }
        Some(())
    }

    fn conversion(&mut self, conv: u8) -> Option<()> {
        match conv {
            b'%' => self.literal(b'%')?,
            b'n' | b't' => self.skip_space(),
            b'a' | b'A' => {
                self.scan.wday = self.name(&WEEKDAYS)?;
                self.scan.have_wday = true;
            }
            b'b' | b'B' | b'h' => {
                self.scan.mon = self.name(&MONTHS)?;
                self.scan.have_mon = true;
                self.scan.dated = true;
            }
            b'c' => self.run(b"%a %b %e %H:%M:%S %Y")?,
            b'C' => {
                self.scan.century = Some(self.number(2, 0, 99)?);
                self.scan.dated = true;
            }
            b'd' | b'e' => {
                self.scan.mday = self.number(2, 1, 31)?;
                self.scan.have_mday = true;
                self.scan.dated = true;
            }
            b'D' | b'x' => self.run(b"%m/%d/%y")?,
            b'F' => self.run(b"%Y-%m-%d")?,
            b'g' => {
                self.number(2, 0, 99)?;
            }
            b'G' => {
                self.number(usize::MAX, 0, i64::MAX)?;
            }
            b'H' | b'k' => {
                self.scan.hour = self.number(2, 0, 23)?;
                self.scan.twelve = false;
            }
            b'I' | b'l' => {
                self.scan.hour = self.number(2, 1, 12)? % 12;
                self.scan.twelve = true;
            }
            b'j' => {
                self.scan.yday = self.number(3, 1, 366)? - 1;
                self.scan.have_yday = true;
            }
            b'm' => {
                self.scan.mon = self.number(2, 1, 12)? - 1;
                self.scan.have_mon = true;
                self.scan.dated = true;
            }
            b'M' => self.scan.min = self.number(2, 0, 59)?,
            b'p' => {
                let half = self.rest().get(..2)?;
                let pm = if half.eq_ignore_ascii_case(b"PM") {
                    true
                } else if half.eq_ignore_ascii_case(b"AM") {
                    false
                } else {
                    return None;
                };
                self.at += 2;
                self.scan.pm = Some(pm);
            }
            b'r' => self.run(b"%I:%M:%S %p")?,
            b'R' => self.run(b"%H:%M")?,
            b's' => self.epoch()?,
            b'S' => self.scan.sec = self.number(2, 0, 61)?,
            b'T' | b'X' => self.run(b"%H:%M:%S")?,
            b'u' => {
                self.scan.wday = self.number(1, 1, 7)? % 7;
                self.scan.have_wday = true;
            }
            b'U' => self.scan.week = Some((Week::Sunday, self.number(2, 0, 53)?)),
            b'V' => {
                self.number(2, 0, 53)?;
            }
            b'w' => {
                self.scan.wday = self.number(1, 0, 6)?;
                self.scan.have_wday = true;
            }
            b'W' => self.scan.week = Some((Week::Monday, self.number(2, 0, 53)?)),
            b'y' => {
                let short = self.number(2, 0, 99)?;
                self.scan.year = short + if short < 69 { 2000 } else { 1900 };
                self.scan.short = Some(short);
                self.scan.dated = true;
            }
            b'Y' => {
                self.scan.year = self.number(4, 0, 9999)?;
                self.scan.short = None;
                self.scan.dated = true;
            }
            b'z' => self.offset()?,
            b'Z' => {
                self.skip_space();
                let len = self.rest().iter().take_while(|b| !is_space(**b)).count();
                self.at += len;
            }
            _ => return None,
        }
        Some(())
    }

    /// `%s`: digits, the seconds since the epoch, read as local time into
    /// every field.
    fn epoch(&mut self) -> Option<()> {
        let rest = self.rest();
        let len = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        let t: i64 = std::str::from_utf8(&rest[..len]).ok()?.parse().ok()?;
        let tm = Tm::at(t, self.zone)?;
        self.at += len;
        let scan = &mut self.scan;
        (scan.year, scan.mon, scan.mday) = (tm.year, tm.mon, tm.mday);
        (scan.hour, scan.min, scan.sec) = (tm.hour, tm.min, tm.sec);
        (scan.wday, scan.yday) = (tm.wday, tm.yday);
        scan.have_mon = true;
        scan.have_mday = true;
        scan.dated = true;
        Some(())
    }

    /// `%z`: `Z`, or a sign, two digits of hours and optionally two of
    /// minutes, after a colon or not. glibc keeps the offset out of the
    /// fields jq reads.
    fn offset(&mut self) -> Option<()> {
        self.skip_space();
        let rest = self.rest();
        if rest.first() == Some(&b'Z') {
            self.at += 1;
            return Some(());
        }
        let digit = |i: usize| rest.get(i).is_some_and(u8::is_ascii_digit);
        if !matches!(rest.first(), Some(b'+' | b'-')) || !(digit(1) && digit(2)) {
            return None;
        }
        let len = match rest.get(3) {
            Some(b':') if digit(4) && digit(5) => 6,
            Some(b':') => return None,
            _ if digit(3) && digit(4) => 5,
            _ if digit(3) => return None,
            _ => 3,
        };
        if len > 3 && (rest[len - 2] - b'0') * 10 + (rest[len - 1] - b'0') > 59 {
            return None;
        }
        self.at += len;
        Some(())
    }
}

fn mismatch(text: &str, format: &str) -> Fault {
    fail(format!(
        "date \"{text}\" does not match format \"{format}\""
    ))
}

fn strptime(input: &Value, format: &Value, zone: Option<&Zone>) -> Answer {
    let (Value::String(text), Value::String(format)) = (input, format) else {
        return Err(fail("strptime/1 requires string inputs and arguments"));
    };
    let (text, format) = (until_nul(text), until_nul(format));
    let mut reader = Reader {
        input: text.as_bytes(),
        at: 0,
        scan: Scan::default(),
        zone,
    };
    let read = reader.run(format.as_bytes()).is_some();
    let rest = text.get(reader.at..).unwrap_or("");
    if !read || rest.bytes().next().is_some_and(|b| !is_space(b)) {
        return Err(mismatch(text, format));
    }
    let mut scan = reader.scan;
    scan.finish();
    let fields = [
        shown(scan.year),
        scan.mon,
        scan.mday,
        scan.hour,
        scan.min,
        scan.sec,
        scan.wday,
        scan.yday,
    ];
    let mut items: Vec<Value> = fields.iter().map(|&f| Value::number(f as f64)).collect();
    if !rest.is_empty() {
        items.push(Value::string(rest));
    }
    Ok(Value::array(items))
}

/// Run one of the time builtins against the host's clock.
pub(crate) fn call(f: Cfunc, args: &[Value], clock: &Clock) -> Answer {
    let input = &args[0];
    let a = args.get(1).unwrap_or(&Value::Null);
    let zone = Some(&*clock.zone);
    match f {
        Cfunc::Mktime => mktime(input),
        Cfunc::Gmtime => gmtime(input, None, "gmtime"),
        Cfunc::Localtime => gmtime(input, zone, "localtime"),
        Cfunc::Strftime => strftime(input, a, None, &clock.zone, "strftime"),
        Cfunc::StrfLocaltime => strftime(input, a, zone, &clock.zone, "strflocaltime"),
        Cfunc::Strptime => strptime(input, a, zone),
        _ => unreachable!("not a time builtin"),
    }
}
