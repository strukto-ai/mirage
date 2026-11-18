use std::cmp::Ordering;

use blake2::Blake2b;
use blake2::digest::Digest;
use blake2::digest::consts::U16;
use serde::{Deserialize, Serialize};

use super::cost::{COST_BYTES, cost};
use super::modifiers::{Mods, Translated, kept};
use super::number::{NumberScan, general_order, human_order, leading_number};
use super::random::RandomScan;
use super::version::{VersionScan, version_cmp};
use crate::number::is_blank;

/// A `-k` KEYDEF as `options` read it: fields count from 1, the start
/// character from 1, and an end character of `None` or 0 is the field's end.
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct Key {
    #[serde(deserialize_with = "crate::saturating_usize")]
    pub start_field: usize,
    #[serde(deserialize_with = "crate::saturating_usize")]
    pub start_char: usize,
    pub start_skip: bool,
    #[serde(deserialize_with = "crate::saturating_usize_opt")]
    pub end_field: Option<usize>,
    #[serde(deserialize_with = "crate::saturating_usize_opt")]
    pub end_char: Option<usize>,
    pub end_skip: bool,
    pub mods: Mods,
}

/// The comparison: each key in turn, then the whole record unless
/// `-s` or `-u` stops at the keys.
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct Compare {
    pub keys: Vec<Key>,
    /// `-t`'s byte; GNU takes one byte, whatever the locale.
    pub field_sep: Option<u8>,
    pub reverse: bool,
    pub unique: bool,
    pub stable: bool,
    /// The bytes `-R` salts each key's hash with, which the host draws.
    #[serde(default)]
    pub salt: Vec<u8>,
}

const MONTHS: [&[u8; 3]; 12] = [
    b"JAN", b"FEB", b"MAR", b"APR", b"MAY", b"JUN", b"JUL", b"AUG", b"SEP", b"OCT", b"NOV", b"DEC",
];

impl Compare {
    pub(crate) fn records(&self, a: &[u8], b: &[u8]) -> Ordering {
        for key in &self.keys {
            let ka = self.extract(a, key);
            let kb = self.extract(b, key);
            let mut order = if key.mods.random {
                self.random(ka, kb, &key.mods)
            } else {
                compare_keys(ka, kb, &key.mods)
            };
            if key.mods.reverse {
                order = order.reverse();
            }
            if order != Ordering::Equal {
                return order;
            }
        }
        if self.stable || self.unique {
            return Ordering::Equal;
        }
        let order = a.cmp(b);
        if self.reverse { order.reverse() } else { order }
    }

    /// `-R`: two keys by their hashes salted with `salt`, after `-f`, `-d`
    /// and `-i` have changed them, then by their bytes when the hashes tie.
    fn random(&self, a: &[u8], b: &[u8], mods: &Mods) -> Ordering {
        if a.len() > COST_BYTES || b.len() > COST_BYTES || self.salt.len() > COST_BYTES {
            let mut bytes = usize::MAX;
            let order = RandomScan::default()
                .step(a, b, &self.salt, mods, &mut bytes)
                .unwrap();
            return order.then_with(|| {
                Comparison::default()
                    .transformed(a, b, mods, &mut bytes)
                    .unwrap()
            });
        }
        if mods.fold || mods.dictionary || mods.ignore_nonprinting {
            return translated_pair(a, b, mods, |a, b| {
                self.hashed(a).cmp(&self.hashed(b)).then_with(|| a.cmp(b))
            });
        }
        self.hashed(a).cmp(&self.hashed(b)).then_with(|| a.cmp(b))
    }

    fn hashed(&self, key: &[u8]) -> [u8; 16] {
        let mut hasher = Blake2b::<U16>::new();
        hasher.update(&self.salt);
        hasher.update(key);
        hasher.finalize().into()
    }

    /// The bytes one key covers, as GNU sort reads a KEYDEF: offsets count
    /// bytes, a start past the record is empty, and an end before the start
    /// is the start.
    fn extract<'a>(&self, record: &'a [u8], key: &Key) -> &'a [u8] {
        let n = record.len();
        let Some((lead, content)) = self.field_start(record, key.start_field) else {
            return &[];
        };
        let base = if key.start_skip { content } else { lead };
        let start = base.saturating_add(key.start_char.saturating_sub(1)).min(n);
        let end = match (key.end_field, key.end_char) {
            (None, _) => n,
            (Some(field), None | Some(0)) => self.field(record, field).map_or(n, |(_, _, end)| end),
            (Some(field), Some(chars)) => {
                self.field_start(record, field)
                    .map_or(n, |(lead, content)| {
                        (if key.end_skip { content } else { lead })
                            .saturating_add(chars)
                            .min(n)
                    })
            }
        };
        &record[start..end.max(start)]
    }

    /// Where field `number` (from 1) starts, as (lead, content), reading no
    /// further than its leading blanks, so a key never scans a long field it
    /// does not end in.
    fn field_start(&self, record: &[u8], number: usize) -> Option<(usize, usize)> {
        let previous = number.checked_sub(1)?;
        if previous == 0 {
            return self.first_field_start(record);
        }
        let (_, _, end) = self.field(record, previous)?;
        match self.field_sep {
            Some(_) => (end < record.len()).then_some((end + 1, end + 1)),
            None if end < record.len() => {
                let content = end
                    + record[end..]
                        .iter()
                        .position(|&byte| !is_blank(byte))
                        .unwrap_or(record.len() - end);
                Some((end, content))
            }
            None => None,
        }
    }

    fn first_field_start(&self, record: &[u8]) -> Option<(usize, usize)> {
        match self.field_sep {
            Some(_) => Some((0, 0)),
            None if record.is_empty() => None,
            None => Some((
                0,
                record
                    .iter()
                    .position(|&byte| !is_blank(byte))
                    .unwrap_or(record.len()),
            )),
        }
    }

    /// Field `number` (from 1) as (lead, content, end): with `-t` every
    /// separator ends a field; without it a field is leading blanks then
    /// non-blanks.
    fn field(&self, record: &[u8], number: usize) -> Option<(usize, usize, usize)> {
        let mut seen = 0;
        match self.field_sep {
            Some(sep) => {
                let mut pos = 0;
                loop {
                    let next = memchr::memchr(sep, &record[pos..]).map(|at| pos + at);
                    seen += 1;
                    let end = next.unwrap_or(record.len());
                    if seen == number {
                        return Some((pos, pos, end));
                    }
                    pos = next? + 1;
                }
            }
            None => {
                let mut i = 0;
                while i < record.len() {
                    let lead = i;
                    while i < record.len() && is_blank(record[i]) {
                        i += 1;
                    }
                    let content = i;
                    while i < record.len() && !is_blank(record[i]) {
                        i += 1;
                    }
                    seen += 1;
                    if seen == number {
                        return Some((lead, content, i));
                    }
                }
                None
            }
        }
    }
}

/// The key as `-d`, `-i` and `-f` leave it.
fn translated<'a>(field: &'a [u8], mods: &'a Mods) -> impl Iterator<Item = u8> + 'a {
    field
        .iter()
        .copied()
        .filter(move |&byte| kept(byte, mods))
        .map(move |byte| {
            if mods.fold {
                byte.to_ascii_uppercase()
            } else {
                byte
            }
        })
}

/// `f` over two keys as `translated` leaves them, held on the stack while
/// they are short, so a comparison allocates nothing.
fn translated_pair<R>(a: &[u8], b: &[u8], mods: &Mods, f: impl FnOnce(&[u8], &[u8]) -> R) -> R {
    let (mut x, mut y) = ([0u8; COST_BYTES], [0u8; COST_BYTES]);
    let fill = |key: &[u8], into: &mut [u8; COST_BYTES]| {
        let mut len = 0;
        for byte in translated(key, mods) {
            into[len] = byte;
            len += 1;
        }
        len
    };
    let (n, m) = (fill(a, &mut x), fill(b, &mut y));
    f(&x[..n], &y[..m])
}

fn compare_keys(a: &[u8], b: &[u8], mods: &Mods) -> Ordering {
    let translates = mods.fold || mods.dictionary || mods.ignore_nonprinting;
    // -V reads the key as -d, -i and -f leave it.
    if mods.version
        && (translates || !mods.month && !mods.human)
        && (a.len() > super::COST_BYTES || b.len() > super::COST_BYTES)
    {
        let mut bytes = usize::MAX;
        return VersionScan::default().step(a, b, mods, &mut bytes).unwrap();
    }
    if mods.version && translates {
        return translated_pair(a, b, mods, version_cmp);
    }
    if mods.month {
        return month(a).cmp(&month(b));
    }
    if mods.human {
        let (oa, na) = human_order(a);
        let (ob, nb) = human_order(b);
        return oa.cmp(&ob).then_with(|| na.cmp(&nb));
    }
    if mods.version {
        return version_cmp(a, b);
    }
    if mods.numeric {
        return leading_number(a).cmp(&leading_number(b));
    }
    if mods.general_numeric {
        return general_order(a, b);
    }
    if translates {
        return translated(a, mods).cmp(translated(b, mods));
    }
    a.cmp(b)
}

/// `-M`: the first three bytes after the blanks, folded,
/// against the month names; anything else is month 0.
fn month(field: &[u8]) -> usize {
    let start = field
        .iter()
        .position(|&byte| !is_blank(byte))
        .unwrap_or(field.len());
    let name = &field[start..];
    if name.len() < 3 {
        return 0;
    }
    let upper = [
        name[0].to_ascii_uppercase(),
        name[1].to_ascii_uppercase(),
        name[2].to_ascii_uppercase(),
    ];
    MONTHS
        .iter()
        .position(|month| **month == upper)
        .map_or(0, |index| index + 1)
}

#[derive(Default)]
struct FieldScan {
    at: usize,
    number: usize,
    lead: usize,
    content: Option<usize>,
}

impl FieldScan {
    fn seek(
        &mut self,
        record: &[u8],
        separator: Option<u8>,
        target: usize,
        start_only: bool,
        bytes: &mut usize,
    ) -> Option<(usize, usize, usize)> {
        let n = record.len();
        if target == 0 {
            return Some((n, n, n));
        }
        self.number = self.number.max(1);
        loop {
            if let Some(sep) = separator {
                if start_only && self.number == target {
                    return Some((self.at, self.at, self.at));
                }
                if *bytes == 0 {
                    return None;
                }
                let end = n.min(self.at.saturating_add(*bytes));
                let next = memchr::memchr(sep, &record[self.at..end]);
                let stop = next.map_or(end, |gap| self.at + gap);
                *bytes -= stop - self.at + usize::from(next.is_some());
                self.at = stop;
                if next.is_none() && end < n {
                    continue;
                }
                if self.number == target {
                    return Some((self.lead, self.lead, stop));
                }
                if next.is_none() {
                    return Some((n, n, n));
                }
                self.at += 1;
                self.lead = self.at;
                self.number += 1;
            } else {
                if self.at == n && self.content.is_none() {
                    return Some((n, n, n));
                }
                if *bytes == 0 {
                    return None;
                }
                let end = n.min(self.at.saturating_add(*bytes));
                let next = record[self.at..end]
                    .iter()
                    .position(|&byte| is_blank(byte) == self.content.is_some());
                let stop = next.map_or(end, |gap| self.at + gap);
                *bytes -= stop - self.at;
                self.at = stop;
                if next.is_none() && end < n {
                    continue;
                }
                if self.content.is_none() {
                    self.content = Some(stop);
                    if start_only && self.number == target {
                        return Some((self.lead, stop, stop));
                    }
                } else if self.number == target {
                    return Some((self.lead, self.content.unwrap(), stop));
                } else if stop == n {
                    return Some((n, n, n));
                } else {
                    self.number += 1;
                    self.lead = stop;
                    self.content = None;
                }
            }
        }
    }
}

#[derive(Default)]
struct KeyScan {
    start: Option<usize>,
    field: FieldScan,
}

impl KeyScan {
    fn step(
        &mut self,
        record: &[u8],
        key: &Key,
        separator: Option<u8>,
        bytes: &mut usize,
    ) -> Option<(usize, usize)> {
        let n = record.len();
        if self.start.is_none() && key.start_field == 1 && !key.start_skip {
            self.start = Some(key.start_char.saturating_sub(1).min(n));
        }
        if self.start.is_none() {
            let (lead, content, _) =
                self.field
                    .seek(record, separator, key.start_field, true, bytes)?;
            let base = if key.start_skip { content } else { lead };
            self.start = Some(base.saturating_add(key.start_char.saturating_sub(1)).min(n));
            self.field = FieldScan::default();
        }
        let start = self.start.unwrap();
        let end = if let Some(number) = key.end_field {
            let chars = key.end_char.unwrap_or(0);
            let (lead, content, end) =
                self.field
                    .seek(record, separator, number, chars != 0, bytes)?;
            if chars == 0 {
                end
            } else {
                (if key.end_skip { content } else { lead })
                    .saturating_add(chars)
                    .min(n)
            }
        } else {
            n
        };
        Some((start, end.max(start)))
    }
}

#[derive(Default)]
enum ComparisonPhase {
    #[default]
    Key,
    ExtractLeft,
    ExtractRight,
    Compare,
    MonthLeft,
    MonthRight,
    Lexical,
    Random,
    ParseLeft,
    ParseRight,
    Integer,
    Fraction,
    Version,
    Fallback,
}

#[derive(Default)]
pub(super) struct Comparison {
    phase: ComparisonPhase,
    key: usize,
    extract: KeyScan,
    ranges: [(usize, usize); 2],
    numbers: [NumberScan; 2],
    version: VersionScan,
    translated: Option<Box<[Translated; 2]>>,
    random: Option<Box<RandomScan>>,
    month: usize,
    offset: usize,
}

impl Comparison {
    pub(super) fn step(
        &mut self,
        compare: &Compare,
        a: &[u8],
        b: &[u8],
        work: &mut usize,
        budget: usize,
    ) -> Option<Ordering> {
        if matches!(self.phase, ComparisonPhase::Key)
            && self.key == 0
            && self.offset == 0
            && a.len() <= COST_BYTES
            && b.len() <= COST_BYTES
            && compare.salt.len() <= COST_BYTES
        {
            *work += cost(a, b);
            return Some(compare.records(a, b));
        }
        let available = (budget - *work) * COST_BYTES;
        let mut bytes = available;
        let whole = match compare.keys.as_slice() {
            [] if !compare.stable && !compare.unique => Some(compare.reverse),
            [key]
                if key.start_field == 1
                    && key.start_char == 1
                    && !key.start_skip
                    && key.end_field.is_none()
                    && (Mods {
                        reverse: false,
                        ..key.mods
                    }) == Mods::default() =>
            {
                Some(key.mods.reverse)
            }
            _ => None,
        };
        let result = if let Some(reverse) = whole {
            self.lexical(a, b, &mut bytes)
                .map(|order| if reverse { order.reverse() } else { order })
        } else {
            self.resume(compare, a, b, &mut bytes)
        };
        *work += 1 + (available - bytes) / COST_BYTES;
        if result.is_some() {
            *self = Self::default();
        }
        result
    }

    fn resume(
        &mut self,
        compare: &Compare,
        a: &[u8],
        b: &[u8],
        bytes: &mut usize,
    ) -> Option<Ordering> {
        loop {
            match self.phase {
                ComparisonPhase::Key => {
                    if self.key == compare.keys.len() {
                        if compare.stable || compare.unique {
                            return Some(Ordering::Equal);
                        }
                        self.phase = ComparisonPhase::Fallback;
                        continue;
                    }
                    self.phase = ComparisonPhase::ExtractLeft;
                }
                ComparisonPhase::Compare => {
                    if *bytes == 0 {
                        return None;
                    }
                    let key = &compare.keys[self.key];
                    let (a0, a1) = self.ranges[0];
                    let (b0, b1) = self.ranges[1];
                    let (ka, kb) = (&a[a0..a1], &b[b0..b1]);
                    let mods = &key.mods;
                    let short = ka.len() <= COST_BYTES
                        && kb.len() <= COST_BYTES
                        && (!mods.random || compare.salt.len() <= COST_BYTES);
                    let version = mods.version
                        && (mods.fold
                            || mods.dictionary
                            || mods.ignore_nonprinting
                            || !mods.month && !mods.human);
                    if !short {
                        self.phase = if mods.random {
                            ComparisonPhase::Random
                        } else if version {
                            ComparisonPhase::Version
                        } else if mods.month {
                            ComparisonPhase::MonthLeft
                        } else if mods.human || mods.numeric {
                            ComparisonPhase::ParseLeft
                        } else if !mods.general_numeric {
                            ComparisonPhase::Lexical
                        } else {
                            ComparisonPhase::Compare
                        };
                        if !matches!(self.phase, ComparisonPhase::Compare) {
                            continue;
                        }
                    }
                    *bytes = bytes.saturating_sub(cost(ka, kb) * COST_BYTES);
                    let order = if key.mods.random {
                        compare.random(ka, kb, &key.mods)
                    } else {
                        compare_keys(ka, kb, &key.mods)
                    };
                    let order = if key.mods.reverse {
                        order.reverse()
                    } else {
                        order
                    };
                    if order != Ordering::Equal {
                        return Some(order);
                    }
                    self.key += 1;
                    self.phase = ComparisonPhase::Key;
                }
                ComparisonPhase::ExtractLeft | ComparisonPhase::ExtractRight => {
                    let side = usize::from(matches!(self.phase, ComparisonPhase::ExtractRight));
                    self.ranges[side] = self.extract.step(
                        if side == 0 { a } else { b },
                        &compare.keys[self.key],
                        compare.field_sep,
                        bytes,
                    )?;
                    self.extract = KeyScan::default();
                    self.phase = if side == 0 {
                        ComparisonPhase::ExtractRight
                    } else {
                        ComparisonPhase::Compare
                    };
                }
                ComparisonPhase::MonthLeft | ComparisonPhase::MonthRight => {
                    let side = usize::from(matches!(self.phase, ComparisonPhase::MonthRight));
                    let (start, end) = self.ranges[side];
                    let field = &(if side == 0 { a } else { b })[start..end];
                    let end = field.len().min(self.offset.saturating_add(*bytes));
                    let next = field[self.offset..end]
                        .iter()
                        .position(|&byte| !is_blank(byte));
                    let stop = next.map_or(end, |gap| self.offset + gap);
                    *bytes -= stop - self.offset;
                    self.offset = stop;
                    if next.is_none() && end < field.len() {
                        return None;
                    }
                    let value = month(&field[stop..]);
                    self.offset = 0;
                    if side == 0 {
                        self.month = value;
                        self.phase = ComparisonPhase::MonthRight;
                    } else {
                        let order = self.month.cmp(&value);
                        let mods = &compare.keys[self.key].mods;
                        if order != Ordering::Equal {
                            return Some(if mods.reverse { order.reverse() } else { order });
                        }
                        self.key += 1;
                        self.phase = ComparisonPhase::Key;
                    }
                }
                ComparisonPhase::Lexical => {
                    let (a0, a1) = self.ranges[0];
                    let (b0, b1) = self.ranges[1];
                    let mods = &compare.keys[self.key].mods;
                    let order = self.transformed(&a[a0..a1], &b[b0..b1], mods, bytes)?;
                    if order != Ordering::Equal {
                        return Some(if mods.reverse { order.reverse() } else { order });
                    }
                    self.translated = None;
                    self.key += 1;
                    self.phase = ComparisonPhase::Key;
                }
                ComparisonPhase::Random => {
                    let (a0, a1) = self.ranges[0];
                    let (b0, b1) = self.ranges[1];
                    let mods = &compare.keys[self.key].mods;
                    let order = self.random.get_or_insert_with(Default::default).step(
                        &a[a0..a1],
                        &b[b0..b1],
                        &compare.salt,
                        mods,
                        bytes,
                    )?;
                    self.random = None;
                    if order != Ordering::Equal {
                        return Some(if mods.reverse { order.reverse() } else { order });
                    }
                    self.phase = ComparisonPhase::Lexical;
                }
                ComparisonPhase::Version => {
                    let (a0, a1) = self.ranges[0];
                    let (b0, b1) = self.ranges[1];
                    let mods = &compare.keys[self.key].mods;
                    let order = self.version.step(&a[a0..a1], &b[b0..b1], mods, bytes)?;
                    if order != Ordering::Equal {
                        return Some(if mods.reverse { order.reverse() } else { order });
                    }
                    self.version = VersionScan::default();
                    self.key += 1;
                    self.phase = ComparisonPhase::Key;
                }
                ComparisonPhase::ParseLeft | ComparisonPhase::ParseRight => {
                    let side = usize::from(matches!(self.phase, ComparisonPhase::ParseRight));
                    let (start, end) = self.ranges[side];
                    let field = &(if side == 0 { a } else { b })[start..end];
                    let human = compare.keys[self.key].mods.human;
                    let ready = if human {
                        self.numbers[side].step_human(field, bytes)
                    } else {
                        self.numbers[side].step(field, bytes)
                    };
                    if !ready {
                        return None;
                    }
                    if side == 1 && human {
                        let order = self.numbers[0]
                            .human_order()
                            .cmp(&self.numbers[1].human_order());
                        if order != Ordering::Equal {
                            return Some(if compare.keys[self.key].mods.reverse {
                                order.reverse()
                            } else {
                                order
                            });
                        }
                    }
                    self.phase = if side == 0 {
                        ComparisonPhase::ParseRight
                    } else {
                        ComparisonPhase::Integer
                    };
                }
                ComparisonPhase::Integer | ComparisonPhase::Fraction => {
                    let (a0, a1) = self.ranges[0];
                    let (b0, b1) = self.ranges[1];
                    let left = self.numbers[0].number(&a[a0..a1]);
                    let right = self.numbers[1].number(&b[b0..b1]);
                    let integer = matches!(self.phase, ComparisonPhase::Integer);
                    let order = if left.negative != right.negative {
                        if left.negative {
                            Ordering::Less
                        } else {
                            Ordering::Greater
                        }
                    } else {
                        let order = if integer {
                            let length = left.integer.len().cmp(&right.integer.len());
                            if length == Ordering::Equal {
                                self.lexical(left.integer, right.integer, bytes)?
                            } else {
                                length
                            }
                        } else {
                            self.lexical(left.fraction, right.fraction, bytes)?
                        };
                        if left.negative {
                            order.reverse()
                        } else {
                            order
                        }
                    };
                    if order != Ordering::Equal {
                        return Some(if compare.keys[self.key].mods.reverse {
                            order.reverse()
                        } else {
                            order
                        });
                    }
                    if integer {
                        self.phase = ComparisonPhase::Fraction;
                    } else {
                        self.key += 1;
                        self.numbers = [NumberScan::default(), NumberScan::default()];
                        self.phase = ComparisonPhase::Key;
                    }
                }
                ComparisonPhase::Fallback => {
                    let order = self.lexical(a, b, bytes)?;
                    return Some(if compare.reverse {
                        order.reverse()
                    } else {
                        order
                    });
                }
            }
        }
    }

    fn lexical(&mut self, a: &[u8], b: &[u8], bytes: &mut usize) -> Option<Ordering> {
        let end = a.len().min(b.len()).min(self.offset.saturating_add(*bytes));
        let order = lexical(&a[self.offset..end], &b[self.offset..end]);
        *bytes -= end - self.offset;
        if order != Ordering::Equal || end == a.len().min(b.len()) {
            self.offset = 0;
            Some(order.then_with(|| a.len().cmp(&b.len())))
        } else {
            self.offset = end;
            None
        }
    }

    fn transformed(
        &mut self,
        a: &[u8],
        b: &[u8],
        mods: &Mods,
        bytes: &mut usize,
    ) -> Option<Ordering> {
        if !mods.dictionary && !mods.ignore_nonprinting {
            if !mods.fold {
                return self.lexical(a, b, bytes);
            }
            let end = a.len().min(b.len()).min(self.offset.saturating_add(*bytes));
            let order = a[self.offset..end]
                .iter()
                .map(u8::to_ascii_uppercase)
                .cmp(b[self.offset..end].iter().map(u8::to_ascii_uppercase));
            *bytes -= end - self.offset;
            if order != Ordering::Equal || end == a.len().min(b.len()) {
                self.offset = 0;
                return Some(order.then_with(|| a.len().cmp(&b.len())));
            }
            self.offset = end;
            return None;
        }
        let source_bytes = a.len().saturating_add(b.len());
        if self.translated.is_none() && source_bytes <= *bytes {
            *bytes -= source_bytes;
            return Some(translated(a, mods).cmp(translated(b, mods)));
        }
        let cursors = self
            .translated
            .get_or_insert_with(|| Box::new([Translated::default(), Translated::default()]));
        loop {
            cursors[0].fill(a, mods, bytes)?;
            cursors[1].fill(b, mods, bytes)?;
            let left = cursors[0].remaining();
            let right = cursors[1].remaining();
            let count = left.len().min(right.len());
            let order = lexical(&left[..count], &right[..count]);
            if order != Ordering::Equal || count == 0 {
                return Some(order.then_with(|| left.len().cmp(&right.len())));
            }
            cursors[0].advance(count);
            cursors[1].advance(count);
        }
    }
}

fn lexical(a: &[u8], b: &[u8]) -> Ordering {
    let mut left = a.chunks_exact(8);
    let mut right = b.chunks_exact(8);
    for (a, b) in left.by_ref().zip(right.by_ref()) {
        let a = u64::from_be_bytes(a.try_into().unwrap());
        let b = u64::from_be_bytes(b.try_into().unwrap());
        if a != b {
            return a.cmp(&b);
        }
    }
    left.remainder().cmp(right.remainder())
}
