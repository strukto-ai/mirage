use std::cmp::Ordering;

use serde::Deserialize;

use super::number::{general_order, human_order, leading_number};
use super::version::version_cmp;

/// One key's ordering options.
#[derive(Deserialize, Clone, Copy, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct Mods {
    pub numeric: bool,
    pub general_numeric: bool,
    pub human: bool,
    pub version: bool,
    pub month: bool,
    pub fold: bool,
    pub reverse: bool,
    pub dictionary: bool,
    pub ignore_nonprinting: bool,
    /// `-R`: sent by the hosts, which check it against the other
    /// orderings; nothing shuffles here.
    #[serde(rename = "random")]
    pub _random: bool,
}

/// A `-k` KEYDEF as the host parsed it: fields count from 1, the start
/// character from 1, and an end character of `None` or 0 is the field's end.
#[derive(Deserialize, Clone)]
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
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct Compare {
    pub keys: Vec<Key>,
    /// `-t`'s byte; GNU takes one byte, whatever the locale.
    pub field_sep: Option<u8>,
    pub reverse: bool,
    pub unique: bool,
    pub stable: bool,
}

/// The bytes GNU sort skips as blanks in the C locale: space, tab and the
/// newline a `-z` record can hold.
pub(crate) fn is_blank(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n')
}

const MONTHS: [&[u8; 3]; 12] = [
    b"JAN", b"FEB", b"MAR", b"APR", b"MAY", b"JUN", b"JUL", b"AUG", b"SEP", b"OCT", b"NOV", b"DEC",
];

impl Compare {
    pub(crate) fn records(&self, a: &[u8], b: &[u8]) -> Ordering {
        for key in &self.keys {
            let ka = self.extract(a, key);
            let kb = self.extract(b, key);
            let mut order = compare_keys(ka, kb, &key.mods);
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

/// The bytes `-d` keeps (alphanumerics and blanks) and `-i` keeps
/// (printable ASCII) in the C locale.
fn kept(byte: u8, mods: &Mods) -> bool {
    if mods.dictionary {
        byte.is_ascii_alphanumeric() || is_blank(byte)
    } else if mods.ignore_nonprinting {
        (0x20..0x7F).contains(&byte)
    } else {
        true
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

fn compare_keys(a: &[u8], b: &[u8], mods: &Mods) -> Ordering {
    let translates = mods.fold || mods.dictionary || mods.ignore_nonprinting;
    // -V reads the key as -d, -i and -f leave it.
    if mods.version && translates {
        let a: Vec<u8> = translated(a, mods).collect();
        let b: Vec<u8> = translated(b, mods).collect();
        return version_cmp(&a, &b);
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
