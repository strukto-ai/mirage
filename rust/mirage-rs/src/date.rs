use std::collections::HashMap;

use serde::Deserialize;

use crate::calendar::{DAY, days, fields};
use crate::request::Request;
use crate::task::{self, Host};
use crate::{Stream, StreamError, parse_config};

const FIRST: i128 = -62135596800;
const LAST: i128 = 253402300799;
const NANOS: i128 = 1_000_000_000;
const BLANKS: &[u8] = b" \t\n\x0b\x0c\r";
type Answer<T> = Result<T, ()>;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Kind {
    Number,
    Word,
    Char,
    Meridian,
    Month,
    Weekday,
    Dst,
    Months,
    Days,
    Seconds,
    Today,
    Ordinal,
    Suffix,
    Zone,
    Daylight,
    Local,
    Named,
}

struct Meter {
    host: Host,
    work: usize,
}

impl Meter {
    fn new(host: Host) -> Self {
        Self { host, work: 16384 }
    }
    async fn step(&mut self) {
        self.work -= 1;
        if self.work == 0 {
            self.host.pause().await;
            self.work = 16384;
        }
    }
}

#[derive(Clone)]
struct Token {
    kind: Kind,
    text: String,
    sign: u8,
    value: i128,
    nanos: Option<i128>,
}

async fn lex_number(text: &[u8], at: &mut usize, sign: u8, meter: &mut Meter) -> Answer<Token> {
    let start = *at;
    let mut value = 0i128;
    while let Some(byte) = text.get(*at).filter(|b| b.is_ascii_digit()) {
        value = (value * 10 + i128::from(*byte - b'0')).min(1i128 << 63);
        *at += 1;
        meter.step().await;
    }
    let digits = String::from_utf8(text[start..*at].to_vec()).map_err(|_| ())?;
    let mut nanos = None;
    if text.get(*at).is_some_and(|b| b".,".contains(b))
        && text.get(*at + 1).is_some_and(u8::is_ascii_digit)
    {
        *at += 1;
        let mut fraction = 0;
        let (mut count, mut extra) = (0, false);
        while let Some(byte) = text.get(*at).filter(|b| b.is_ascii_digit()) {
            if count < 9 {
                fraction = fraction * 10 + i128::from(*byte - b'0');
            } else {
                extra |= *byte != b'0';
            }
            count += 1;
            *at += 1;
            meter.step().await;
        }
        for _ in count..9 {
            fraction *= 10;
        }
        nanos = Some(fraction + i128::from(sign == b'-' && extra));
    }
    if value >= 1i128 << 63 {
        return Err(());
    }
    Ok(Token {
        kind: Kind::Number,
        text: digits,
        sign,
        value: if sign == b'-' { -value } else { value },
        nanos,
    })
}

async fn lex(text: &str, host: Host) -> Answer<Vec<Token>> {
    let mut meter = Meter::new(host);
    let bytes = text.as_bytes();
    let (mut tokens, mut at) = (Vec::new(), 0);
    while let Some(&byte) = bytes.get(at) {
        meter.step().await;
        if BLANKS.contains(&byte) {
            at += 1;
        } else if byte == b'(' {
            let mut depth = 0;
            while let Some(&byte) = bytes.get(at) {
                if byte == b'(' {
                    depth += 1;
                } else if byte == b')' {
                    depth -= 1;
                }
                at += 1;
                meter.step().await;
                if depth == 0 {
                    break;
                }
            }
        } else if b"+-".contains(&byte) {
            let mut sign = byte;
            at += 1;
            while let Some(&byte) = bytes
                .get(at)
                .filter(|b| b"+-".contains(b) || BLANKS.contains(b))
            {
                if b"+-".contains(&byte) {
                    sign = byte;
                }
                at += 1;
                meter.step().await;
            }
            if bytes.get(at).is_some_and(u8::is_ascii_digit) {
                tokens.push(lex_number(bytes, &mut at, sign, &mut meter).await?);
            }
        } else if byte.is_ascii_digit() {
            tokens.push(lex_number(bytes, &mut at, 0, &mut meter).await?);
        } else if byte.is_ascii_alphabetic() {
            let start = at;
            while bytes
                .get(at)
                .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'.')
            {
                at += 1;
                meter.step().await;
            }
            tokens.push(Token {
                kind: Kind::Word,
                text: text[start..at].to_ascii_uppercase(),
                sign: 0,
                value: 0,
                nanos: None,
            });
        } else if byte.is_ascii() {
            tokens.push(Token {
                kind: Kind::Char,
                text: char::from(byte).to_string(),
                sign: 0,
                value: 0,
                nanos: None,
            });
            at += 1;
        } else {
            return Err(());
        }
    }
    Ok(tokens)
}

fn year_of(token: &Token) -> i128 {
    let year = token.value.abs();
    year + if token.text.len() == 2 {
        if year < 69 { 2000 } else { 1900 }
    } else {
        0
    }
}

#[derive(Default)]
struct Reading {
    date: Option<(Option<i128>, i128, i128)>,
    clock: Option<(i128, i128, i128, i128)>,
    zone: Option<i128>,
    zoned: bool,
    named: bool,
    dst: Option<bool>,
    weekday: Option<(i128, i128)>,
    months: i128,
    days: i128,
    seconds: i128,
    nanos: i128,
    counts: HashMap<(Kind, i128), i128>,
    relative: bool,
    epoch: Option<(i128, i128)>,
}

struct Parser {
    tokens: Vec<Token>,
    names: HashMap<String, Option<bool>>,
    at: usize,
    reading: Reading,
    iso_end: Option<usize>,
    meter: Meter,
}

impl Parser {
    fn peek(&self, ahead: usize) -> Option<&Token> {
        self.tokens.get(self.at + ahead)
    }
    fn take(&mut self) -> Answer<Token> {
        let token = self.peek(0).cloned().ok_or(())?;
        self.at += 1;
        Ok(token)
    }
    fn mean(&self, token: &Token) -> Option<(Kind, i128)> {
        let found = meaning(&token.text);
        if found
            .is_some_and(|(kind, _)| matches!(kind, Kind::Meridian | Kind::Month | Kind::Weekday))
        {
            return found;
        }
        let bare = token.text.replace('.', "");
        if let Some(dst) = self
            .names
            .get(&bare)
            .filter(|_| !["GMT", "UT", "UTC"].contains(&bare.as_str()))
        {
            return Some((Kind::Named, dst.map_or(-1, i128::from)));
        }
        found
    }
    fn kind(&self, ahead: usize) -> Option<Kind> {
        self.peek(ahead).and_then(|token| {
            if token.kind == Kind::Word {
                self.mean(token).map(|(kind, _)| kind)
            } else {
                Some(token.kind)
            }
        })
    }
    fn value(&self, token: &Token) -> Answer<i128> {
        self.mean(token).map(|(_, value)| value).ok_or(())
    }
    fn word_value(&mut self) -> Answer<i128> {
        let token = self.take()?;
        self.value(&token)
    }
    fn char(&self, value: &str, ahead: usize) -> bool {
        self.peek(ahead)
            .is_some_and(|token| token.kind == Kind::Char && token.text == value)
    }
    fn plain(&self, ahead: usize) -> bool {
        self.peek(ahead).is_some_and(|token| {
            token.kind == Kind::Number && token.sign == 0 && token.nanos.is_none()
        })
    }
    fn minus(&self, ahead: usize) -> bool {
        self.peek(ahead).is_some_and(|token| {
            token.kind == Kind::Number && token.sign == b'-' && token.nanos.is_none()
        })
    }
    fn signed(&self, ahead: usize) -> bool {
        self.peek(ahead).is_some_and(|token| {
            token.kind == Kind::Number && token.sign != 0 && token.nanos.is_none()
        })
    }
    fn unit(&self, ahead: usize) -> bool {
        self.kind(ahead)
            .is_some_and(|kind| matches!(kind, Kind::Months | Kind::Days | Kind::Seconds))
    }
    fn whole(&mut self) -> Answer<Token> {
        if !self.plain(0) {
            return Err(());
        }
        self.take()
    }

    async fn parse(mut self) -> Answer<Reading> {
        if self.char("@", 0) {
            self.take()?;
            let stamp = self.take()?;
            if stamp.kind != Kind::Number || self.peek(0).is_some() {
                return Err(());
            }
            let nanos = stamp.value.abs() * NANOS + stamp.nanos.unwrap_or(0);
            let nanos = if stamp.sign == b'-' { -nanos } else { nanos };
            self.reading.epoch = Some((nanos.div_euclid(NANOS), nanos.rem_euclid(NANOS)));
        } else {
            while self.peek(0).is_some() {
                self.item()?;
                self.meter.step().await;
            }
        }
        Ok(self.reading)
    }

    fn item(&mut self) -> Answer<()> {
        let token = self.take()?;
        if token.kind == Kind::Number {
            return self.number(token);
        }
        let (kind, mut value) = if token.kind == Kind::Word {
            self.mean(&token)
        } else {
            None
        }
        .ok_or(())?;
        match kind {
            Kind::Month => self.month(value)?,
            Kind::Weekday => {
                self.set_weekday(0, value)?;
                if self.char(",", 0) {
                    self.take()?;
                }
            }
            Kind::Ordinal => {
                if self.kind(0) == Some(Kind::Weekday) {
                    let day = self.word_value()?;
                    self.set_weekday(value, day)?;
                } else if self.unit(0) {
                    self.relative(value)?;
                } else {
                    return Err(());
                }
            }
            Kind::Months | Kind::Days | Kind::Seconds => self.add(kind, value, 1, true)?,
            Kind::Today => self.tally(Kind::Days, 1, value)?,
            Kind::Zone if token.text == "T" && self.iso_end == Some(self.at - 1) => {
                if self.plain(0) && self.char(":", 1) {
                    let hour = self.take()?;
                    self.clock(hour, false)?;
                } else if self.plain(0) && self.signed(1) {
                    let hour = self.take()?.value;
                    self.set_clock(hour, 0, 0, 0)?;
                    let token = self.take()?;
                    let zone = self.zone_number(token)?;
                    self.set_zone(Some(zone))?;
                } else {
                    return Err(());
                }
            }
            Kind::Zone => {
                let mut offset = value * 60;
                if self.kind(0) == Some(Kind::Dst) {
                    self.take()?;
                    offset += 3600;
                } else if self.signed_zone() {
                    let token = self.take()?;
                    offset += self.zone_number(token)?;
                } else if self.signed(0) && self.unit(1) {
                    self.set_zone(Some(offset))?;
                    let count = self.take()?.value;
                    let unit = self.take()?;
                    let (kind, size) = meaning(&unit.text).ok_or(())?;
                    return self.add(kind, size, count, false);
                }
                self.set_zone(Some(offset))?;
            }
            Kind::Daylight => self.set_zone(Some(value * 60))?,
            Kind::Local => self.set_zone(None)?,
            Kind::Named => {
                if self.kind(0) == Some(Kind::Dst) {
                    self.take()?;
                    value = 1;
                }
                self.set_zone(None)?;
                self.reading.named = true;
                self.reading.dst = if value < 0 { None } else { Some(value != 0) };
            }
            _ => return Err(()),
        }
        Ok(())
    }

    fn number(&mut self, token: Token) -> Answer<()> {
        if token.nanos.is_some() {
            self.fraction(token)
        } else if token.sign != 0 {
            if !self.unit(0) {
                return Err(());
            }
            self.relative(token.value)
        } else if self.char(":", 0) {
            self.clock(token, true)
        } else if self.char("/", 0) {
            self.slashed(token)
        } else if self.minus(0) && self.minus(1) {
            self.iso(token)
        } else if self.kind(0) == Some(Kind::Month) {
            self.day_month(token)
        } else if self.unit(0) {
            self.relative(token.value)
        } else if self.kind(0) == Some(Kind::Weekday) {
            let day = self.word_value()?;
            self.set_weekday(token.value, day)
        } else if self.kind(0) == Some(Kind::Meridian) {
            let add = self.word_value()?;
            let hour = meridian(token.value, add)?;
            self.set_clock(hour, 0, 0, 0)
        } else {
            self.pure(token)
        }
    }

    fn pure(&mut self, token: Token) -> Answer<()> {
        let digits = token.text.len();
        let value = token.value;
        if self.signed_zone() {
            let colon = self.char(":", 1) && self.plain(2);
            self.set_clock(value, 0, 0, 0)?;
            let zone = self.take()?;
            let zone = self.zone_number(zone)?;
            self.set_zone(Some(zone))?;
            if !colon && self.signed(0) {
                return Err(());
            }
        } else if let Some((None, month, day)) = self
            .reading
            .date
            .filter(|_| !self.reading.relative && (self.reading.clock.is_some() || digits > 2))
        {
            self.reading.date = Some((Some(year_of(&token)), month, day));
        } else if digits > 4 {
            let mut year = value / 10000;
            if digits == 6 {
                year += if year < 69 { 2000 } else { 1900 };
            }
            self.set_date(Some(year), value / 100 % 100, value % 100)?;
        } else if digits <= 2 {
            self.set_clock(value, 0, 0, 0)?;
        } else {
            self.set_clock(value / 100, value % 100, 0, 0)?;
        }
        Ok(())
    }

    fn clock(&mut self, hour: Token, meridians: bool) -> Answer<()> {
        self.take()?;
        let minute = self.whole()?.value;
        let (mut second, mut nanos) = (0, 0);
        if self.char(":", 0) {
            self.take()?;
            let token = self.take()?;
            if token.kind != Kind::Number || token.sign != 0 {
                return Err(());
            }
            second = token.value;
            nanos = token.nanos.unwrap_or(0);
        }
        let mut value = hour.value;
        if meridians && self.kind(0) == Some(Kind::Meridian) {
            let add = self.word_value()?;
            value = meridian(value, add)?;
            return self.set_clock(value, minute, second, nanos);
        }
        self.set_clock(value, minute, second, nanos)?;
        if self.signed(0) {
            let token = self.take()?;
            let zone = self.zone_number(token)?;
            self.set_zone(Some(zone))?;
        }
        Ok(())
    }

    fn slashed(&mut self, first: Token) -> Answer<()> {
        self.take()?;
        let second = self.whole()?;
        let third = if self.char("/", 0) {
            self.take()?;
            Some(self.whole()?)
        } else {
            None
        };
        if first.text.len() >= 4 {
            self.set_date(Some(first.value), second.value, third.ok_or(())?.value)
        } else {
            self.set_date(third.as_ref().map(year_of), first.value, second.value)
        }
    }
    fn iso(&mut self, year: Token) -> Answer<()> {
        let month = self.take()?;
        let day = self.take()?;
        self.set_date(Some(year_of(&year)), -month.value, -day.value)?;
        self.iso_end = Some(self.at);
        Ok(())
    }
    fn day_month(&mut self, day: Token) -> Answer<()> {
        let month = self.word_value()?;
        let year = if self.plain(0) || self.minus(0) {
            Some(year_of(&self.take()?))
        } else {
            None
        };
        self.set_date(year, month, day.value)
    }
    fn month(&mut self, month: i128) -> Answer<()> {
        if self.plain(0) {
            let day = self.take()?.value;
            let year = if self.char(",", 0) {
                self.take()?;
                Some(year_of(&self.whole()?))
            } else {
                None
            };
            self.set_date(year, month, day)
        } else if self.minus(0) && self.minus(1) {
            let day = self.take()?;
            let year = self.take()?;
            self.set_date(Some(year_of(&year)), month, -day.value)
        } else {
            Err(())
        }
    }
    fn fraction(&mut self, token: Token) -> Answer<()> {
        if self.kind(0) != Some(Kind::Seconds) || self.word_value()? != 1 {
            return Err(());
        }
        let mut times = if token.sign == b'-' { -1 } else { 1 };
        if self.kind(0) == Some(Kind::Suffix) {
            times *= self.word_value()?;
        }
        self.tally(Kind::Seconds, 1, times * token.value.abs())?;
        self.reading.nanos += times * token.nanos.unwrap_or(0);
        Ok(())
    }
    fn relative(&mut self, count: i128) -> Answer<()> {
        let token = self.take()?;
        let (kind, size) = meaning(&token.text).ok_or(())?;
        self.add(kind, size, count, true)
    }
    fn add(&mut self, kind: Kind, size: i128, mut count: i128, suffix: bool) -> Answer<()> {
        if suffix && self.kind(0) == Some(Kind::Suffix) {
            count *= self.word_value()?;
        }
        self.tally(kind, size, count)
    }
    fn tally(&mut self, kind: Kind, mut size: i128, mut count: i128) -> Answer<()> {
        if kind == Kind::Days {
            count *= size;
            size = 1;
        }
        let total = self.reading.counts.entry((kind, size)).or_default();
        let next = *total + count;
        if i64::try_from(count).is_err() || i64::try_from(next).is_err() {
            return Err(());
        }
        *total = next;
        let into = match kind {
            Kind::Months => &mut self.reading.months,
            Kind::Days => &mut self.reading.days,
            _ => &mut self.reading.seconds,
        };
        *into += size * count;
        self.reading.relative = true;
        Ok(())
    }
    fn signed_zone(&self) -> bool {
        self.signed(0) && !self.unit(1)
    }
    fn zone_number(&mut self, token: Token) -> Answer<i128> {
        if token.nanos.is_some() {
            return Err(());
        }
        let size = token.value.abs();
        let minutes = if self.char(":", 0) && self.plain(1) {
            self.take()?;
            size * 60 + self.take()?.value
        } else if token.text.len() <= 2 {
            size * 60
        } else {
            size / 100 * 60 + size % 100
        };
        if minutes > 1440 {
            return Err(());
        }
        Ok((if token.sign == b'-' {
            -minutes
        } else {
            minutes
        }) * 60)
    }
    fn set_date(&mut self, year: Option<i128>, month: i128, day: i128) -> Answer<()> {
        if self.reading.date.replace((year, month, day)).is_some() {
            Err(())
        } else {
            Ok(())
        }
    }
    fn set_clock(&mut self, hour: i128, minute: i128, second: i128, nanos: i128) -> Answer<()> {
        if self
            .reading
            .clock
            .replace((hour, minute, second, nanos))
            .is_some()
        {
            Err(())
        } else {
            Ok(())
        }
    }
    fn set_zone(&mut self, offset: Option<i128>) -> Answer<()> {
        if self.reading.zoned {
            return Err(());
        }
        self.reading.zoned = true;
        self.reading.zone = offset;
        Ok(())
    }
    fn set_weekday(&mut self, ordinal: i128, day: i128) -> Answer<()> {
        if self.reading.weekday.replace((ordinal, day)).is_some() {
            Err(())
        } else {
            Ok(())
        }
    }
}

fn meridian(hour: i128, add: i128) -> Answer<i128> {
    if !(1..=12).contains(&hour) {
        Err(())
    } else {
        Ok(hour % 12 + add)
    }
}

#[derive(Clone, Deserialize)]
struct Facts {
    offset: i128,
    name: String,
}

struct Clock {
    host: Host,
    zone: Option<String>,
    facts: HashMap<i64, Facts>,
    rules: HashMap<i64, Vec<i128>>,
}

impl Clock {
    fn new(host: Host, zone: Option<String>) -> Self {
        Self {
            host,
            zone,
            facts: HashMap::new(),
            rules: HashMap::new(),
        }
    }
    async fn facts(&mut self, instant: i128) -> Answer<Facts> {
        let instant = instant.clamp(FIRST + 2 * DAY, LAST - 2 * DAY) as i64;
        if let Some(facts) = self.facts.get(&instant) {
            return Ok(facts.clone());
        }
        let (reply, data) = self
            .host
            .ask(Request::Date {
                zone: self.zone.clone(),
                instant: Some(instant),
                year: None,
                wall: None,
            })
            .await;
        if reply.error.is_some() {
            return Err(());
        }
        let facts: Facts = serde_json::from_slice(&data).map_err(|_| ())?;
        self.facts.insert(instant, facts.clone());
        Ok(facts)
    }
    async fn offset(&mut self, instant: i128) -> Answer<i128> {
        Ok(self.facts(instant).await?.offset)
    }
    async fn isdst(&mut self, instant: i128) -> Answer<bool> {
        let year = fields(instant.clamp(FIRST, LAST)).0;
        let winter = self.offset(days(year, 1, 1) * DAY).await?;
        let july = days(year, 7, 1) * DAY;
        let summer = self.offset(july).await?;
        let shown = self.offset(instant).await?;
        if shown > winter.min(summer) {
            return Ok(true);
        }
        let (before, after) = if instant < july {
            (winter, summer)
        } else {
            (summer, self.offset(days(year + 1, 1, 1) * DAY).await?)
        };
        Ok(shown < before && shown < after)
    }
    async fn names(&mut self, now: i128) -> Answer<HashMap<String, Option<bool>>> {
        let mut found: HashMap<String, Option<bool>> = HashMap::new();
        for step in 0..4 {
            let instant = (now + step * 90 * DAY).min(LAST);
            let name = self.facts(instant).await?.name.to_ascii_uppercase();
            let dst = self.isdst(instant).await?;
            found
                .entry(name)
                .and_modify(|previous| {
                    if *previous != Some(dst) {
                        *previous = None;
                    }
                })
                .or_insert(Some(dst));
        }
        Ok(found)
    }
    async fn changes(&mut self, wall: i128) -> Answer<Vec<i128>> {
        let year = fields(wall.clamp(FIRST, LAST)).0 as i64;
        if let Some(changes) = self.rules.get(&year) {
            return Ok(changes.clone());
        }
        let (reply, data) = self
            .host
            .ask(Request::Date {
                zone: self.zone.clone(),
                instant: None,
                year: Some(year),
                wall: None,
            })
            .await;
        if reply.error.is_some() {
            return Err(());
        }
        let changes: Vec<i128> = serde_json::from_slice(&data).map_err(|_| ())?;
        self.rules.insert(year, changes.clone());
        Ok(changes)
    }
    async fn readings(&mut self, wall: i128) -> Answer<Vec<i128>> {
        let mut offsets = vec![
            self.offset(wall - DAY).await?,
            self.offset(wall + DAY).await?,
        ];
        for change in self.changes(wall).await? {
            offsets.push(self.offset(change).await?);
        }
        offsets.sort_unstable();
        offsets.dedup();
        let mut shown = Vec::new();
        for offset in offsets {
            if self.offset(wall - offset).await? == offset {
                shown.push(wall - offset);
            }
        }
        shown.sort_unstable();
        Ok(shown)
    }
    async fn place(&mut self, wall: i128, guess: i128) -> Answer<i128> {
        let mut instant = wall - guess;
        for _ in 0..2 {
            let shown = self.offset(instant).await?;
            if self.offset(wall - shown).await? == shown {
                return Ok(wall - shown);
            }
            instant = wall - shown;
        }
        Ok(wall - self.offset(wall - DAY).await?)
    }
    async fn settle(&mut self, wall: i128, guess: i128, dst: Option<bool>) -> Answer<Option<i128>> {
        let mut shown = Vec::new();
        for instant in self.readings(wall).await? {
            if dst.is_none() || Some(self.isdst(instant).await?) == dst {
                shown.push(instant);
            }
        }
        if shown.len() == 2 {
            let placed = self.place(wall, guess).await?;
            Ok(Some(if shown.contains(&placed) {
                placed
            } else {
                shown[1]
            }))
        } else {
            Ok(shown.first().copied())
        }
    }
    async fn keep_state(&mut self, wall: i128, dst: bool, guess: i128) -> Answer<i128> {
        let mut shown = Vec::new();
        for instant in self.readings(wall).await? {
            if self.isdst(instant).await? == dst {
                shown.push(instant);
            }
        }
        if !shown.is_empty() {
            return if shown.len() == 2 {
                self.place(wall, guess).await
            } else {
                Ok(shown[0])
            };
        }
        for change in self.changes(wall).await? {
            if self.isdst(change).await? == dst {
                return Ok(wall - self.offset(change).await?);
            }
        }
        for step in 1..14 {
            for instant in [wall - step * 30 * DAY, wall + step * 30 * DAY] {
                if self.isdst(instant).await? == dst {
                    return Ok(wall - self.offset(instant).await?);
                }
            }
        }
        self.place(wall, guess).await
    }
}

fn weekday_shift(base: i128, ordinal: i128, day: i128) -> i128 {
    let ahead = (day - base).rem_euclid(7);
    if ordinal > 0 {
        (if ahead == 0 { 7 } else { ahead }) + 7 * (ordinal - 1)
    } else if ordinal == 0 {
        ahead
    } else {
        let behind = (base - day).rem_euclid(7);
        -(if behind == 0 { 7 } else { behind }) + 7 * (ordinal + 1)
    }
}

async fn resolve(
    reading: Reading,
    clock: &mut Clock,
    now: i128,
    now_nanos: i128,
    guess: i128,
) -> Answer<(i128, i128)> {
    if let Some(epoch) = reading.epoch {
        return Ok(epoch);
    }
    let here = clock.offset(now).await?;
    let (mut year, mut month, mut day, mut hour, mut minute, mut second) = fields(now + here);
    let mut nanos = now_nanos;
    let from_now = reading.relative
        && reading.date.is_none()
        && reading.clock.is_none()
        && reading.weekday.is_none();
    if let Some((given, m, d)) = reading.date {
        year = given.unwrap_or(year);
        month = m;
        day = d;
    }
    if let Some((h, m, s, n)) = reading.clock {
        hour = h;
        minute = m;
        second = s;
        nanos = n;
    } else if !from_now {
        hour = 0;
        minute = 0;
        second = 0;
        nanos = 0;
    }
    if !(1..=12).contains(&month) {
        return Err(());
    }
    let month_days = days(year, month + 1, 1) - days(year, month, 1);
    if !(1..=month_days).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return Err(());
    }
    let mut date_days = days(year, month, day);
    let within = hour * 3600 + minute * 60 + second;
    let state = if let Some(dst) = reading.dst {
        dst
    } else {
        clock.isdst(now).await?
    };
    let mut instant = if let Some(zone) = reading.zone {
        date_days * DAY + within - zone
    } else if from_now && reading.dst.is_none() {
        now
    } else {
        clock
            .settle(date_days * DAY + within, guess, reading.dst)
            .await?
            .ok_or(())?
    };
    let mut moving = reading.days != 0 || reading.months != 0;
    if let Some((ordinal, weekday)) = reading.weekday.filter(|_| reading.date.is_none()) {
        date_days += weekday_shift((date_days + 4).rem_euclid(7), ordinal, weekday);
        (year, month, day, _, _, _) = fields(date_days * DAY);
        moving = true;
    }
    if moving {
        let wall = (days(year, month + reading.months, day) + reading.days) * DAY + within;
        instant = if reading.dst.is_some() || (from_now && !reading.named) {
            clock.keep_state(wall, state, guess).await?
        } else {
            let offset = clock.offset(instant).await?;
            clock.place(wall, offset).await?
        };
        if let Some(zone) = reading.zone {
            instant += clock.offset(instant).await? - zone;
        }
    }
    let fraction = nanos + reading.nanos;
    Ok((
        instant + reading.seconds + fraction.div_euclid(NANOS),
        fraction.rem_euclid(NANOS),
    ))
}

fn split_zone(text: &str) -> Answer<(Option<String>, &str)> {
    let lead = text.trim_start_matches(|c: char| c.is_ascii() && BLANKS.contains(&(c as u8)));
    if !lead.starts_with("TZ=\"") {
        return Ok((None, text));
    }
    let mut name = Vec::new();
    let mut at = 4;
    while let Some(&byte) = lead.as_bytes().get(at) {
        if byte == b'"' {
            return Ok((
                Some(String::from_utf8(name).map_err(|_| ())?),
                &lead[at + 1..],
            ));
        }
        if byte == b'\\' {
            at += 1;
            let &escaped = lead.as_bytes().get(at).ok_or(())?;
            if !b"\\\"".contains(&escaped) {
                return Err(());
            }
            name.push(escaped);
        } else {
            name.push(byte);
        }
        at += 1;
    }
    Err(())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Expr,
    Posix,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "crate::latin1")]
    text: Vec<u8>,
    mode: Mode,
    now: i64,
    nanos: u32,
    local: bool,
}

#[derive(serde::Serialize)]
struct Placement {
    epoch: i64,
    nanos: u32,
    wall: Option<[i64; 6]>,
}

fn wall_array(wall: i128) -> [i64; 6] {
    let (y, m, d, h, min, s) = fields(wall);
    [y as i64, m as i64, d as i64, h as i64, min as i64, s as i64]
}

async fn parse(config: Config, host: Host) -> Answer<Placement> {
    let text = std::str::from_utf8(&config.text).map_err(|_| ())?;
    let now = i128::from(config.now);
    if !(FIRST..=LAST).contains(&now) || config.nanos >= NANOS as u32 {
        return Err(());
    }
    let mut outer = Clock::new(host.clone(), None);
    let mut local_wall = None;
    let placed = match config.mode {
        Mode::Expr => {
            let (zone, text) = split_zone(text)?;
            let mut clock = Clock::new(host.clone(), zone);
            let names = clock.names(now).await?;
            let tokens = lex(text, host.clone()).await?;
            let reading = Parser {
                tokens,
                names,
                at: 0,
                reading: Reading::default(),
                iso_end: None,
                meter: Meter::new(host.clone()),
            }
            .parse()
            .await?;
            let guess = outer.offset(now).await?;
            resolve(reading, &mut clock, now, i128::from(config.nanos), guess).await?
        }
        Mode::Posix => {
            let (digits, seconds) = text
                .split_once('.')
                .map_or((text, None), |(d, s)| (d, Some(s)));
            if ![8, 10, 12].contains(&digits.len())
                || !digits.bytes().all(|b| b.is_ascii_digit())
                || seconds.is_some_and(|s| s.len() != 2 || !s.bytes().all(|b| b.is_ascii_digit()))
            {
                return Err(());
            }
            let field = |start, end| digits[start..end].parse::<i128>().map_err(|_| ());
            let month = field(0, 2)?;
            let day = field(2, 4)?;
            let hour = field(4, 6)?;
            let minute = field(6, 8)?;
            let year = match digits.len() {
                8 => fields(now + outer.offset(now).await?).0,
                10 => {
                    let year = field(8, 10)?;
                    year + if year <= 68 { 2000 } else { 1900 }
                }
                _ => field(8, 12)?,
            };
            let second = seconds.unwrap_or("0").parse::<i128>().map_err(|_| ())?;
            if !(1..=9999).contains(&year)
                || !(1..=12).contains(&month)
                || !(1..=(days(year, month + 1, 1) - days(year, month, 1))).contains(&day)
                || hour > 23
                || minute > 59
                || second > 60
            {
                return Err(());
            }
            let wall = days(year, month, day) * DAY + hour * 3600 + minute * 60 + second.min(59);
            let leap = i128::from(second == 60);
            if config.local {
                let (reply, data) = host
                    .ask(Request::Date {
                        zone: None,
                        instant: None,
                        year: None,
                        wall: Some(wall_array(wall)),
                    })
                    .await;
                if reply.error.is_some() {
                    return Err(());
                }
                let instant: i64 = serde_json::from_slice(&data).map_err(|_| ())?;
                let shown = wall_array(wall + leap);
                if !(1..=9999).contains(&shown[0]) {
                    return Err(());
                }
                local_wall = Some(shown);
                (i128::from(instant) + leap, 0)
            } else {
                let shown = outer.readings(wall).await?;
                (shown.last().copied().ok_or(())? + leap, 0)
            }
        }
    };
    if !(FIRST..=LAST).contains(&placed.0) {
        return Err(());
    }
    Ok(Placement {
        epoch: placed.0 as i64,
        nanos: placed.1 as u32,
        wall: local_wall,
    })
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(task::spawn(move |host| async move {
        let result = parse(config, host.clone()).await.ok();
        host.print(&serde_json::to_vec(&result).unwrap());
        0
    }))
}

const MONTHS: &[&str] = &[
    "JANUARY",
    "FEBRUARY",
    "MARCH",
    "APRIL",
    "MAY",
    "JUNE",
    "JULY",
    "AUGUST",
    "SEPTEMBER",
    "OCTOBER",
    "NOVEMBER",
    "DECEMBER",
];
const WEEKDAYS: &[&str] = &[
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
];

fn meaning(word: &str) -> Option<(Kind, i128)> {
    let direct = match word {
        "AM" => Some((Kind::Meridian, 0)),
        "A.M." => Some((Kind::Meridian, 0)),
        "PM" => Some((Kind::Meridian, 12)),
        "P.M." => Some((Kind::Meridian, 12)),
        "TOMORROW" => Some((Kind::Today, 1)),
        "YESTERDAY" => Some((Kind::Today, -1)),
        "TODAY" => Some((Kind::Today, 0)),
        "NOW" => Some((Kind::Today, 0)),
        "LAST" => Some((Kind::Ordinal, -1)),
        "THIS" => Some((Kind::Ordinal, 0)),
        "NEXT" => Some((Kind::Ordinal, 1)),
        "FIRST" => Some((Kind::Ordinal, 1)),
        "THIRD" => Some((Kind::Ordinal, 3)),
        "FOURTH" => Some((Kind::Ordinal, 4)),
        "FIFTH" => Some((Kind::Ordinal, 5)),
        "SIXTH" => Some((Kind::Ordinal, 6)),
        "SEVENTH" => Some((Kind::Ordinal, 7)),
        "EIGHTH" => Some((Kind::Ordinal, 8)),
        "NINTH" => Some((Kind::Ordinal, 9)),
        "TENTH" => Some((Kind::Ordinal, 10)),
        "ELEVENTH" => Some((Kind::Ordinal, 11)),
        "TWELFTH" => Some((Kind::Ordinal, 12)),
        "AGO" => Some((Kind::Suffix, -1)),
        "HENCE" => Some((Kind::Suffix, 1)),
        "SEPT" => Some((Kind::Month, 9)),
        "TUES" => Some((Kind::Weekday, 2)),
        "WEDNES" => Some((Kind::Weekday, 3)),
        "THUR" => Some((Kind::Weekday, 4)),
        "THURS" => Some((Kind::Weekday, 4)),
        "DST" => Some((Kind::Dst, 0)),
        _ => None,
    };
    if direct.is_some() {
        return direct;
    }
    for (kind, names) in [(Kind::Month, MONTHS), (Kind::Weekday, WEEKDAYS)] {
        if let Some(at) = names.iter().position(|name| *name == word) {
            return Some((kind, at as i128 + i128::from(kind == Kind::Month)));
        }
        let short = if word.len() == 3 {
            word
        } else if word.len() == 4 && word.ends_with('.') {
            &word[..3]
        } else {
            ""
        };
        if short.bytes().all(|b| b.is_ascii_alphabetic()) && !short.is_empty() {
            if let Some(at) = names.iter().position(|name| name.starts_with(short)) {
                return Some((kind, at as i128 + i128::from(kind == Kind::Month)));
            }
        }
    }
    for unit in [word, word.strip_suffix('S').unwrap_or("")] {
        let found = match unit {
            "YEAR" => Some((Kind::Months, 12)),
            "MONTH" => Some((Kind::Months, 1)),
            "FORTNIGHT" => Some((Kind::Days, 14)),
            "WEEK" => Some((Kind::Days, 7)),
            "DAY" => Some((Kind::Days, 1)),
            "HOUR" => Some((Kind::Seconds, 3600)),
            "MINUTE" => Some((Kind::Seconds, 60)),
            "MIN" => Some((Kind::Seconds, 60)),
            "SECOND" => Some((Kind::Seconds, 1)),
            "SEC" => Some((Kind::Seconds, 1)),
            _ => None,
        };
        if found.is_some() {
            return found;
        }
    }
    let bare = word.replace('.', "");
    let zone = match bare.as_str() {
        "UT" => Some((Kind::Zone, 0)),
        "UTC" => Some((Kind::Zone, 0)),
        "GMT" => Some((Kind::Zone, 0)),
        "WET" => Some((Kind::Zone, 0)),
        "WAT" => Some((Kind::Zone, 60)),
        "CET" => Some((Kind::Zone, 60)),
        "MET" => Some((Kind::Zone, 60)),
        "MEZ" => Some((Kind::Zone, 60)),
        "EET" => Some((Kind::Zone, 120)),
        "CAT" => Some((Kind::Zone, 120)),
        "SAST" => Some((Kind::Zone, 120)),
        "EAT" => Some((Kind::Zone, 180)),
        "MSK" => Some((Kind::Zone, 180)),
        "IST" => Some((Kind::Zone, 330)),
        "SGT" => Some((Kind::Zone, 480)),
        "KST" => Some((Kind::Zone, 540)),
        "JST" => Some((Kind::Zone, 540)),
        "GST" => Some((Kind::Zone, 600)),
        "NZST" => Some((Kind::Zone, 720)),
        "ART" => Some((Kind::Zone, -180)),
        "BRT" => Some((Kind::Zone, -180)),
        "NST" => Some((Kind::Zone, -210)),
        "AST" => Some((Kind::Zone, -240)),
        "CLT" => Some((Kind::Zone, -240)),
        "EST" => Some((Kind::Zone, -300)),
        "CST" => Some((Kind::Zone, -360)),
        "MST" => Some((Kind::Zone, -420)),
        "PST" => Some((Kind::Zone, -480)),
        "AKST" => Some((Kind::Zone, -540)),
        "HST" => Some((Kind::Zone, -600)),
        "HAST" => Some((Kind::Zone, -600)),
        "SST" => Some((Kind::Zone, -720)),
        "WEST" => Some((Kind::Daylight, 60)),
        "BST" => Some((Kind::Daylight, 60)),
        "CEST" => Some((Kind::Daylight, 120)),
        "MEST" => Some((Kind::Daylight, 120)),
        "MESZ" => Some((Kind::Daylight, 120)),
        "EEST" => Some((Kind::Daylight, 180)),
        "MSD" => Some((Kind::Daylight, 240)),
        "NZDT" => Some((Kind::Daylight, 780)),
        "BRST" => Some((Kind::Daylight, -120)),
        "NDT" => Some((Kind::Daylight, -150)),
        "ADT" => Some((Kind::Daylight, -180)),
        "CLST" => Some((Kind::Daylight, -180)),
        "EDT" => Some((Kind::Daylight, -240)),
        "CDT" => Some((Kind::Daylight, -300)),
        "MDT" => Some((Kind::Daylight, -360)),
        "PDT" => Some((Kind::Daylight, -420)),
        "AKDT" => Some((Kind::Daylight, -480)),
        "HADT" => Some((Kind::Daylight, -540)),
        _ => None,
    };
    if zone.is_some() {
        return zone;
    }
    if word.len() == 1 {
        let byte = word.as_bytes()[0];
        let offset = match byte {
            b'Z' => 0,
            b'A'..=b'I' => i128::from(byte - b'A' + 1) * 60,
            b'K'..=b'M' => i128::from(byte - b'A') * 60,
            b'N'..=b'Y' => -i128::from(byte - b'N' + 1) * 60,
            _ => 0,
        };
        return Some((
            if byte == b'J' {
                Kind::Local
            } else {
                Kind::Zone
            },
            offset,
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn run(text: &str, mode: &str, dst: bool) -> (Value, usize) {
        let now = days(2026, 8, 16) * DAY + 13 * 3600 + 45 * 60 + 30;
        let config =
            json!({"text":text,"mode":mode,"now":now as i64,"nanos":123456789,"local":false});
        let mut stream = open(&serde_json::to_vec(&config).unwrap()).unwrap();
        let mut out = Vec::new();
        let mut turns = 0;
        let spring = (days(2026, 3, 29) * DAY + 3600) as i64;
        let fall = (days(2026, 10, 25) * DAY + 3600) as i64;
        loop {
            while stream.busy() {
                stream.drain(&mut out).unwrap();
                turns += 1;
                assert!(turns < 10000);
            }
            let Some(header) = stream.request(&mut Vec::new()) else {
                break;
            };
            let request: Value = serde_json::from_slice(&header).unwrap();
            assert_eq!(request["op"], "date");
            let data = if request.get("year").is_some() {
                json!([])
            } else {
                let instant = request["instant"].as_i64().unwrap();
                let summer = dst && (spring..fall).contains(&instant);
                json!({"offset": if dst {if summer {7200} else {3600}} else {0}, "name":if dst {if summer {"CEST"} else {"CET"}} else {"UTC"}})
            };
            stream
                .respond(b"{}", &serde_json::to_vec(&data).unwrap(), &mut out)
                .unwrap();
        }
        (serde_json::from_slice(&out).unwrap(), turns)
    }

    #[test]
    fn epoch_fractions_calendar_shifts_and_posix_operands_keep_exact_values() {
        assert_eq!(
            run("@-0.0000000001", "expr", false).0,
            json!({"epoch":-1,"nanos":999999999,"wall":null})
        );
        let exact = run(
            "2026-01-15 12:00:01 285426750 years -9007198249190400 seconds",
            "expr",
            false,
        )
        .0;
        assert_eq!(exact, json!({"epoch":1768478401i64,"nanos":0,"wall":null}));
        assert_eq!(
            run("081613452026.30", "posix", false).0["epoch"],
            (days(2026, 8, 16) * DAY + 13 * 3600 + 45 * 60 + 30) as i64
        );
        assert_eq!(run("2026-02-30", "expr", false).0, Value::Null);
        assert_eq!(run("\u{ff}", "expr", false).0, Value::Null);
    }

    #[test]
    fn time_zone_facts_refuse_gaps_and_pick_the_current_side_of_a_fold() {
        assert_eq!(run("2026-03-29 02:30", "expr", true).0, Value::Null);
        assert_eq!(
            run("2026-10-25 02:30", "expr", true).0["epoch"],
            (days(2026, 10, 25) * DAY + 30 * 60) as i64
        );
        assert_eq!(
            run("102502302026", "posix", true).0["epoch"],
            (days(2026, 10, 25) * DAY + 3600 + 30 * 60) as i64
        );
    }

    #[test]
    fn long_lexical_runs_and_relative_item_lists_resume_between_polls() {
        let text = "1 day ".repeat(20000);
        let (result, turns) = run(&text, "expr", false);
        assert_eq!(
            result["epoch"],
            (days(2026, 8, 16) * DAY + 13 * 3600 + 45 * 60 + 30 + 20000 * DAY) as i64
        );
        assert_eq!(result["nanos"], 123456789);
        assert!(turns > 20);
        let (result, turns) = run(
            &format!("({})2026-01-15", "x".repeat(1 << 18)),
            "expr",
            false,
        );
        assert_eq!(result["epoch"], 1768435200i64);
        assert!(turns > 20);
    }
}
