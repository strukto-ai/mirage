// Adapted from jq 1.8.2 (MIT), src/builtin.c: tm2jv, jv2tm, f_mktime, f_gmtime, f_localtime, f_strptime, f_strftime, f_strflocaltime, set_tm_wday and set_tm_yday. See licenses/third_party/jq.txt.

use std::sync::Arc;

use super::builtin::{Cfunc, Fault};
use super::value::Value;

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

/// What the host gives a run: the time `now` answers and the local time
/// zone, which only `localtime` and `strflocaltime` consult.
#[derive(Clone, Debug, Default)]
pub(crate) struct Clock {
    pub(crate) now: Option<f64>,
    pub(crate) zone: Option<Arc<Zone>>,
}

/// A POSIX `TZ` rule: a standard offset and name, and optionally a daylight
/// offset and name with the rules that switch between them.
#[derive(Debug, PartialEq)]
pub(crate) struct Zone {
    std: Offset,
    dst: Option<Daylight>,
}

#[derive(Debug, PartialEq)]
struct Offset {
    name: String,
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

struct Fix {
    east: i64,
    dst: bool,
    name: String,
}

impl Zone {
    /// The zone a `TZ` value names, or None when it needs a time zone
    /// database this engine does not carry.
    pub(crate) fn parse(text: &str) -> Option<Zone> {
        let text = text.strip_prefix(':').unwrap_or(text);
        if text.is_empty() {
            return Some(Zone::fixed("UTC"));
        }
        if let Some((_, name)) = UTC_NAMES.iter().find(|(n, _)| *n == text) {
            return Some(Zone::fixed(name));
        }
        let mut at = Cursor { text, at: 0 };
        let name = at.name()?;
        let std = Offset {
            name,
            east: -at.offset()?,
        };
        if at.done() {
            return Some(Zone { std, dst: None });
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
        Some(Zone {
            std,
            dst: Some(Daylight {
                offset: Offset { name, east },
                start,
                end,
            }),
        })
    }

    fn fixed(name: &str) -> Zone {
        Zone {
            std: Offset {
                name: name.to_string(),
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

    /// mktime with tm_isdst of -1: the instant a wall-clock reading
    /// (seconds since the epoch as if it were UTC) names, the daylight
    /// reading when it occurs twice and the standard offset when it is
    /// skipped.
    fn instant(&self, wall: i64) -> i64 {
        let mut offsets = Vec::with_capacity(2);
        if let Some(dst) = &self.dst {
            offsets.push((dst.offset.east, true));
        }
        offsets.push((self.std.east, false));
        for (east, dst) in offsets {
            let t = wall - east;
            if self.at(t).dst == dst {
                return t;
            }
        }
        wall - self.std.east
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

    fn name(&mut self) -> Option<String> {
        let rest = &self.text[self.at..];
        if let Some(quoted) = rest.strip_prefix('<') {
            let end = quoted.find('>')?;
            let name = &quoted[..end];
            if name.is_empty() {
                return None;
            }
            self.at += end + 2;
            return Some(name.to_string());
        }
        let len = rest.bytes().take_while(u8::is_ascii_alphabetic).count();
        if len < 3 {
            return None;
        }
        self.at += len;
        Some(rest[..len].to_string())
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
    zone: String,
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
                name: "UTC".to_string(),
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

    fn jv(&self, fsecs: f64) -> Value {
        Value::array(vec![
            Value::number(self.year as f64),
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

fn gmtime(input: &Value, zone: Option<&Zone>, name: &str) -> Answer {
    let Some(fsecs) = input.as_f64() else {
        return Err(fail(format!("{name}() requires numeric inputs")));
    };
    match Tm::at(fsecs as i64, zone) {
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

fn strftime(input: &Value, format: &Value, local: Option<&Zone>, name: &str) -> Answer {
    let array = match input {
        Value::Number(_) => gmtime(input, local, name)?,
        Value::Array(_) => input.clone(),
        _ => return Err(fail(format!("{name}/1 requires parsed datetime inputs"))),
    };
    let Value::String(format) = format else {
        return Err(fail(format!("{name}/1 requires a string format")));
    };
    let Some(tm) = read(&array, local) else {
        return Err(fail(format!("{name}/1 requires parsed datetime inputs")));
    };
    let format = until_nul(format);
    let mut out = String::new();
    render(format, &tm, &mut out, format.len() + 100);
    if (out.is_empty() && !format.is_empty()) || out.len() >= format.len() + 100 {
        return Err(fail(format!("{name}/1: unknown system failure")));
    }
    Ok(Value::string(out))
}

fn until_nul(text: &str) -> &str {
    text.split('\0').next().unwrap_or("")
}

#[derive(Clone, Copy, PartialEq)]
enum Pad {
    Zero,
    Space,
    None,
}

fn number(out: &mut String, value: i64, width: usize, fill: Pad, flag: Option<Pad>) {
    let pad = flag.unwrap_or(fill);
    match pad {
        Pad::Zero => out.push_str(&format!("{value:0width$}")),
        Pad::Space => out.push_str(&format!("{value:width$}")),
        Pad::None => out.push_str(&value.to_string()),
    }
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

/// Write `format`'s expansion, stopping once it holds `cap` bytes, which is
/// as long as strftime would be let to write.
fn render(format: &str, tm: &Tm, out: &mut String, cap: usize) {
    let mut chars = format.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut flag = None;
        let mut alternative = false;
        let mut conv = chars.next();
        while let Some(m) = conv {
            if chars.peek().is_none() {
                break;
            }
            match m {
                '-' | '_' | '0' if flag.is_none() => {
                    flag = Some(match m {
                        '-' => Pad::None,
                        '_' => Pad::Space,
                        _ => Pad::Zero,
                    });
                }
                'E' | 'O' if !alternative => alternative = true,
                _ => break,
            }
            conv = chars.next();
        }
        let Some(conv) = conv else {
            out.push('%');
            break;
        };
        conversion(conv, flag, tm, out);
        if out.len() >= cap {
            break;
        }
    }
}

fn conversion(conv: char, flag: Option<Pad>, tm: &Tm, out: &mut String) {
    let hour12 = if tm.hour % 12 == 0 { 12 } else { tm.hour % 12 };
    let (iso_year, iso) = iso_week(tm);
    let weekday = tm.wday.rem_euclid(7) as usize;
    let month = tm.mon.rem_euclid(12) as usize;
    match conv {
        'a' => out.push_str(&WEEKDAYS[weekday][..3]),
        'A' => out.push_str(WEEKDAYS[weekday]),
        'b' | 'h' => out.push_str(&MONTHS[month][..3]),
        'B' => out.push_str(MONTHS[month]),
        'c' => render("%a %b %e %H:%M:%S %Y", tm, out, usize::MAX),
        'C' => {
            let century = tm.year / 100;
            if tm.year < 0 && century == 0 {
                out.push_str("-0");
            } else {
                number(out, century, 2, Pad::Zero, None);
            }
        }
        'd' => number(out, tm.mday, 2, Pad::Zero, flag),
        'D' | 'x' => render("%m/%d/%y", tm, out, usize::MAX),
        'e' => number(out, tm.mday, 2, Pad::Space, flag),
        'F' => render("%Y-%m-%d", tm, out, usize::MAX),
        'g' => number(out, (iso_year % 100).abs(), 2, Pad::Zero, None),
        'G' => number(out, iso_year, 4, Pad::Zero, None),
        'H' => number(out, tm.hour, 2, Pad::Zero, flag),
        'I' => number(out, hour12, 2, Pad::Zero, flag),
        'j' => number(out, tm.yday + 1, 3, Pad::Zero, flag),
        'k' => number(out, tm.hour, 2, Pad::Space, flag),
        'l' => number(out, hour12, 2, Pad::Space, flag),
        'm' => number(out, tm.mon + 1, 2, Pad::Zero, flag),
        'M' => number(out, tm.min, 2, Pad::Zero, flag),
        'n' => out.push('\n'),
        'p' => out.push_str(if tm.hour >= 12 { "PM" } else { "AM" }),
        'r' => render("%I:%M:%S %p", tm, out, usize::MAX),
        'R' => render("%H:%M", tm, out, usize::MAX),
        's' => out.push_str(&tm.epoch.to_string()),
        'S' => number(out, tm.sec, 2, Pad::Zero, flag),
        't' => out.push('\t'),
        'T' | 'X' => render("%H:%M:%S", tm, out, usize::MAX),
        'u' => out.push_str(&(if tm.wday == 0 { 7 } else { tm.wday }).to_string()),
        'U' => number(out, (tm.yday + 7 - tm.wday) / 7, 2, Pad::Zero, flag),
        'v' => render("%e-%b-%Y", tm, out, usize::MAX),
        'V' => number(out, iso, 2, Pad::Zero, flag),
        'w' => out.push_str(&tm.wday.to_string()),
        'W' => number(
            out,
            (tm.yday + 7 - (tm.wday + 6) % 7) / 7,
            2,
            Pad::Zero,
            flag,
        ),
        'y' => number(out, (tm.year % 100).abs(), 2, Pad::Zero, None),
        'Y' => number(out, tm.year, 4, Pad::Zero, None),
        'z' => {
            let minutes = tm.east.abs() / 60;
            let sign = if tm.east < 0 { '-' } else { '+' };
            out.push(sign);
            number(out, minutes / 60 * 100 + minutes % 60, 4, Pad::Zero, flag);
        }
        'Z' => out.push_str(&tm.zone),
        '+' => render("%a %b %e %H:%M:%S %Z %Y", tm, out, usize::MAX),
        other => out.push(other),
    }
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// What a strptime format has read so far.
#[derive(Default)]
struct Scan {
    year: i32,
    mon: i32,
    mday: i32,
    hour: i32,
    min: i32,
    sec: i32,
    yday: Option<i32>,
    week: Option<(Week, i32)>,
    wday: Option<i32>,
    year_read: bool,
    mon_read: bool,
    mday_read: bool,
    century: Option<i32>,
    short_year: bool,
    year_specs: u32,
    two_digit_years: u32,
    offset: Option<i32>,
    normalize: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Week {
    Sunday,
    Monday,
    Iso,
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

    fn ended(&self) -> bool {
        self.rest().first().is_none_or(|b| is_space(*b))
    }

    fn skip_space(&mut self) {
        while self.rest().first().is_some_and(|b| is_space(*b)) {
            self.at += 1;
        }
    }

    /// Up to `width` characters of digits, with a sign counting toward the
    /// width when `signed`.
    fn digits(&mut self, width: usize, signed: bool) -> Option<i32> {
        let rest = self.rest();
        let mut len = 0;
        let negative = signed && rest.first() == Some(&b'-');
        if signed && matches!(rest.first(), Some(b'-' | b'+')) {
            len = 1;
        }
        let start = len;
        while len < width && rest.get(len).is_some_and(u8::is_ascii_digit) {
            len += 1;
        }
        if len == start {
            if start == 0 {
                return None;
            }
            self.at += len;
            return Some(0);
        }
        let mut value: i32 = 0;
        for b in &rest[start..len] {
            value = value * 10 + i32::from(b - b'0');
        }
        self.at += len;
        Some(if negative { -value } else { value })
    }

    fn ranged(&mut self, width: usize, low: i32, high: i32) -> Option<i32> {
        self.digits(width, false)
            .filter(|v| (low..=high).contains(v))
    }

    fn name(&mut self, names: &[&str]) -> Option<usize> {
        for long in [true, false] {
            for (index, name) in names.iter().enumerate() {
                let name = if long { name } else { &name[..3] };
                let rest = self.rest();
                if rest.len() >= name.len()
                    && rest[..name.len()].eq_ignore_ascii_case(name.as_bytes())
                {
                    self.at += name.len();
                    return Some(index);
                }
            }
        }
        None
    }

    fn literal(&mut self, byte: u8) -> Option<()> {
        if self.rest().first() == Some(&byte) {
            self.at += 1;
            Some(())
        } else {
            None
        }
    }

    fn run(&mut self, format: &[u8]) -> Option<()> {
        let mut at = 0;
        while at < format.len() {
            let c = format[at];
            at += 1;
            if c != b'%' {
                if is_space(c) {
                    self.skip_space();
                } else {
                    self.literal(c)?;
                }
                continue;
            }
            let mut conv = *format.get(at)?;
            at += 1;
            if matches!(conv, b'E' | b'O') {
                conv = *format.get(at)?;
                at += 1;
            }
            while conv.is_ascii_digit() {
                conv = *format.get(at)?;
                at += 1;
            }
            self.conversion(conv)?;
        }
        Some(())
    }

    fn conversion(&mut self, conv: u8) -> Option<()> {
        match conv {
            b'%' => self.literal(b'%')?,
            b'Y' => {
                if !self.ended() {
                    self.scan.year = self.digits(4, true)? - 1900;
                    self.scan.short_year = false;
                    self.scan.century = None;
                    self.scan.year_specs += 1;
                    self.scan.year_read = true;
                }
            }
            b'y' => {
                if !self.ended() {
                    let v = self.digits(2, true)?;
                    let year = if v < 69 { v + 100 } else { v };
                    match self.scan.century.take() {
                        Some(century) => self.scan.year = year % 100 + (century - 19) * 100,
                        None => {
                            self.scan.year = year;
                            self.scan.short_year = true;
                        }
                    }
                    self.scan.year_specs += 1;
                    self.scan.two_digit_years += 1;
                    self.scan.year_read = true;
                }
            }
            b'C' => {
                let century = self.digits(2, true)?;
                let base = if self.scan.short_year {
                    self.scan.year % 100
                } else {
                    0
                };
                self.scan.year = base + (century - 19) * 100;
                self.scan.century = (!self.scan.short_year).then_some(century);
                self.scan.short_year = false;
                self.scan.year_read = true;
            }
            b'm' => {
                self.scan.mon = self.ranged(2, 1, 12)? - 1;
                self.scan.mon_read = true;
            }
            b'd' | b'e' => {
                self.skip_space();
                self.scan.mday = self.ranged(2, 0, 31)?;
                self.scan.mday_read = true;
            }
            b'H' | b'k' => self.scan.hour = self.ranged(2, 0, 23)?,
            b'I' | b'l' => self.scan.hour = self.ranged(2, 0, 12)?,
            b'M' => {
                if !self.ended() {
                    self.scan.min = self.ranged(2, 0, 59)?;
                }
            }
            b'S' => {
                if !self.ended() {
                    self.scan.sec = self.ranged(2, 0, 60)?;
                }
            }
            b'j' => self.scan.yday = Some(self.ranged(3, 1, 366)? - 1),
            b'U' | b'W' => {
                let week = if conv == b'U' {
                    Week::Sunday
                } else {
                    Week::Monday
                };
                self.scan.week = Some((week, self.ranged(2, 0, 53)?));
            }
            b'V' => self.scan.week = Some((Week::Iso, self.ranged(2, 1, 53)?)),
            b'w' => self.scan.wday = Some(self.ranged(1, 0, 6)?),
            b'u' => self.scan.wday = Some(self.ranged(1, 1, 7)? % 7),
            b'p' => {
                let rest = self.rest();
                let hour = self.scan.hour;
                if rest.len() >= 2 && rest[..2].eq_ignore_ascii_case(b"am") {
                    if hour > 12 {
                        return None;
                    }
                    if hour == 12 {
                        self.scan.hour = 0;
                    }
                } else if rest.len() >= 2 && rest[..2].eq_ignore_ascii_case(b"pm") {
                    if hour > 12 {
                        return None;
                    }
                    if hour != 12 {
                        self.scan.hour += 12;
                    }
                } else {
                    return None;
                }
                self.at += 2;
            }
            b'a' | b'A' => self.scan.wday = Some(self.name(&WEEKDAYS)? as i32),
            b'b' | b'B' | b'h' => {
                self.scan.mon = self.name(&MONTHS)? as i32;
                self.scan.mon_read = true;
            }
            b's' => self.epoch()?,
            b'z' => self.offset()?,
            b'Z' => {
                let rest = self.rest();
                let len = rest.iter().take_while(|b| b.is_ascii_uppercase()).count();
                let name = std::str::from_utf8(&rest[..len]).ok()?;
                let local = self.zone.is_some_and(|z| {
                    name == z.std.name || z.dst.as_ref().is_some_and(|d| name == d.offset.name)
                });
                if !(matches!(name, "UTC" | "GMT") || local) {
                    return None;
                }
                self.scan.normalize |= name == "GMT";
                self.at += len;
            }
            b'n' | b't' => {
                if !self.rest().first().is_some_and(|b| is_space(*b)) {
                    return None;
                }
                self.skip_space();
            }
            b'c' => self.nested(b"%a %b %e %H:%M:%S %Y")?,
            b'D' | b'x' => self.nested(b"%m/%d/%y")?,
            b'F' => self.nested(b"%Y-%m-%d")?,
            b'R' => self.nested(b"%H:%M")?,
            b'r' => self.nested(b"%I:%M:%S %p")?,
            b'T' | b'X' => self.nested(b"%H:%M:%S")?,
            _ => return None,
        }
        Some(())
    }

    fn nested(&mut self, format: &[u8]) -> Option<()> {
        let century = self.scan.century.take();
        let year_read = self.scan.year_read;
        let specs = self.scan.year_specs;
        let two_digit = self.scan.two_digit_years;
        self.run(format)?;
        if self.scan.year_specs == specs {
            self.scan.century = century;
        }
        if self.scan.two_digit_years != two_digit {
            self.scan.short_year = false;
        }
        self.scan.year_read = year_read;
        Some(())
    }

    fn epoch(&mut self) -> Option<()> {
        let rest = self.rest();
        let space = rest.iter().take_while(|b| is_space(**b)).count();
        let rest = &rest[space..];
        let mut len = usize::from(matches!(rest.first(), Some(b'-' | b'+')));
        let start = len;
        while rest.get(len).is_some_and(u8::is_ascii_digit) {
            len += 1;
        }
        let mut t = 0;
        if len > start {
            t = std::str::from_utf8(&rest[..len]).ok()?.parse().ok()?;
            self.at += space + len;
        }
        let tm = Tm::at(t, self.zone)?;
        self.scan = Scan {
            year: (tm.year - 1900) as i32,
            mon: tm.mon as i32,
            mday: tm.mday as i32,
            hour: tm.hour as i32,
            min: tm.min as i32,
            sec: tm.sec as i32,
            mon_read: true,
            mday_read: true,
            normalize: true,
            ..Scan::default()
        };
        Some(())
    }

    fn offset(&mut self) -> Option<()> {
        let sign = match self.rest().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        self.at += 1;
        let hours = self.digits(2, false)?;
        let minutes = self.digits(2, false)?;
        self.scan.offset = Some(sign * (hours * 3600 + minutes * 60));
        Some(())
    }
}

/// set_tm_wday.
fn weekday(year: i32, mon: i32, mday: i32) -> i32 {
    let full = i64::from(year) + 1900;
    let century = full / 100;
    let mut y = full % 100;
    if mon < 2 {
        y -= 1;
    }
    let mut m = i64::from(mon) - 1;
    if m < 1 {
        m += 12;
    }
    let sum = i64::from(mday)
        + (2.6 * m as f64 - 0.2).floor() as i64
        + y
        + (y as f64 / 4.0).floor() as i64
        + (century as f64 / 4.0).floor() as i64
        - 2 * century;
    let mut wday = sum % 7;
    if wday < 0 {
        wday += 7;
    }
    wday as i32
}

/// The days of the year before month `mon` starts.
fn month_start(year: i32, mon: i32) -> i64 {
    const DAYS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap = mon > 1 && is_leap(i64::from(year) + 1900);
    DAYS[(mon.unsigned_abs() % 12) as usize] + i64::from(leap)
}

/// set_tm_yday.
fn yearday(year: i32, mon: i32, mday: i32) -> i32 {
    month_start(year, mon) as i32 + mday - 1
}

fn mismatch(text: &str, format: &str) -> Fault {
    fail(format!(
        "date \"{text}\" does not match format \"{format}\""
    ))
}

/// The day of the year a week number and day of the week name, where
/// `first` is the weekday of January 1st.
fn week_day(week: Week, n: i64, wday: Option<i32>, first: i64) -> i64 {
    let monday = (first + 6) % 7;
    let from_monday = i64::from(wday.map_or(0, |d| (d + 6) % 7));
    let (lead, offset) = match week {
        Week::Sunday => ((7 - first) % 7, i64::from(wday.unwrap_or(0)) - first),
        Week::Monday => ((7 - monday) % 7, from_monday - monday),
        Week::Iso => {
            let start = if monday <= 3 { -monday } else { 7 - monday };
            return start + (n - 1) * 7 + from_monday;
        }
    };
    if n > 0 {
        let day = i64::from(wday.map_or(0, |d| if week == Week::Sunday { d } else { (d + 6) % 7 }));
        lead + (n - 1) * 7 + day
    } else if offset < lead {
        offset
    } else {
        -1
    }
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
    let matched = reader.run(format.as_bytes()).is_some() && reader.ended();
    if !matched {
        return Err(mismatch(text, format));
    }
    let mut scan = reader.scan;
    let first = days_from_civil(i64::from(scan.year) + 1900, 1, 1);
    let dated = scan.mon_read && scan.mday_read;
    let yday = match (scan.yday, scan.week) {
        _ if dated => None,
        (Some(yday), _) => Some(i64::from(yday)),
        (None, Some((week, n))) if scan.year_read => {
            let yday = week_day(week, i64::from(n), scan.wday, (first + 4).rem_euclid(7));
            if yday < 0 {
                return Err(mismatch(text, format));
            }
            Some(yday)
        }
        _ => None,
    };
    if let Some(yday) = yday {
        if scan.mon_read {
            scan.mday = (yday + 1 - month_start(scan.year, scan.mon)) as i32;
        } else {
            let (year, month, day) = civil(first + yday);
            scan.year = (year - 1900) as i32;
            scan.mon = (month - 1) as i32;
            scan.mday = day as i32;
        }
    }
    let mut fields = Fields {
        year: scan.year,
        mon: scan.mon,
        mday: scan.mday,
        hour: scan.hour,
        min: scan.min,
        sec: scan.sec,
    };
    if scan.offset.is_some() || scan.normalize {
        let offset = i64::from(scan.offset.unwrap_or(0));
        if let Some(tm) = Tm::at(fields.wall() - offset, None) {
            fields = Fields {
                year: (tm.year - 1900) as i32,
                mon: tm.mon as i32,
                mday: tm.mday as i32,
                hour: tm.hour as i32,
                min: tm.min as i32,
                sec: tm.sec as i32,
            };
        }
    }
    let mut items = vec![
        Value::number(f64::from(fields.year) + 1900.0),
        Value::number(f64::from(fields.mon)),
        Value::number(f64::from(fields.mday)),
        Value::number(f64::from(fields.hour)),
        Value::number(f64::from(fields.min)),
        Value::number(f64::from(fields.sec)),
        Value::number(f64::from(weekday(fields.year, fields.mon, fields.mday))),
        Value::number(f64::from(yearday(fields.year, fields.mon, fields.mday))),
    ];
    let rest = text.get(reader.at..).unwrap_or("");
    if !rest.is_empty() {
        items.push(Value::string(rest));
    }
    Ok(Value::array(items))
}

/// Run one of the time builtins against the host's clock.
pub(crate) fn call(f: Cfunc, args: &[Value], clock: &Clock) -> Answer {
    let input = &args[0];
    let a = args.get(1).unwrap_or(&Value::Null);
    let zone = clock.zone.as_deref();
    match f {
        Cfunc::Now => clock
            .now
            .map(Value::number)
            .ok_or_else(|| fail("now is not available")),
        Cfunc::Mktime => mktime(input),
        Cfunc::Gmtime => gmtime(input, None, "gmtime"),
        Cfunc::Localtime => match zone {
            Some(_) => gmtime(input, zone, "localtime"),
            None => Err(fail("localtime is not available")),
        },
        Cfunc::Strftime => strftime(input, a, None, "strftime"),
        Cfunc::StrfLocaltime => match zone {
            Some(_) => strftime(input, a, zone, "strflocaltime"),
            None => Err(fail("strflocaltime is not available")),
        },
        Cfunc::Strptime => strptime(input, a, zone),
        _ => unreachable!("not a time builtin"),
    }
}
