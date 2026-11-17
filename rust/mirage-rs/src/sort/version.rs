// Adapted from uutils coreutils, uucore 0.12.0,
// src/uucore/src/lib/features/version_cmp.rs
// (https://github.com/uutils/coreutils).
// Copyright (c) uutils developers. MIT License; the full text is in
// licenses/third_party/uutils-coreutils.txt.
//
// Changed here: when the parts without their file extensions tie, they
// are compared again with the extensions, as GNU sort 9.7 does (`01`
// before `1.a`).
//
// `-V`: the order GNU sort documents for version numbers inside text.

use super::modifiers::{Mods, kept};
use std::cmp::Ordering;

/// Compares the non-digit parts of a version.
/// Special cases: ~ are before everything else, even ends ("a~" < "a")
/// Letters are before non-letters
fn version_non_digit_cmp(a: &[u8], b: &[u8]) -> Ordering {
    let mut a_chars = a.iter();
    let mut b_chars = b.iter();
    loop {
        match (a_chars.next(), b_chars.next()) {
            (Some(c1), Some(c2)) if c1 == c2 => {}
            (None, None) => return Ordering::Equal,
            (_, Some(b'~')) => return Ordering::Greater,
            (Some(b'~'), _) | (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c1), Some(c2)) if c1.is_ascii_alphabetic() && !c2.is_ascii_alphabetic() => {
                return Ordering::Less;
            }
            (Some(c1), Some(c2)) if !c1.is_ascii_alphabetic() && c2.is_ascii_alphabetic() => {
                return Ordering::Greater;
            }
            (Some(c1), Some(c2)) => return c1.cmp(c2),
        }
    }
}

/// Remove file endings matching the regex `(\.[A-Za-z~][A-Za-z0-9~]*)*$`
fn remove_file_ending(a: &[u8]) -> &[u8] {
    let mut ending_start = None;
    let mut prev_was_dot = false;
    for (idx, &char) in a.iter().enumerate() {
        if char == b'.' {
            if ending_start.is_none() || prev_was_dot {
                ending_start = Some(idx);
            }
            prev_was_dot = true;
        } else if prev_was_dot {
            prev_was_dot = false;
            if !char.is_ascii_alphabetic() && char != b'~' {
                ending_start = None;
            }
        } else if !char.is_ascii_alphanumeric() && char != b'~' {
            ending_start = None;
        }
    }
    if prev_was_dot {
        ending_start = None;
    }
    if let Some(ending_start) = ending_start {
        &a[..ending_start]
    } else {
        a
    }
}

/// Compare two version strings.
pub(crate) fn version_cmp(mut a: &[u8], mut b: &[u8]) -> Ordering {
    let str_cmp = a.cmp(b);
    if str_cmp == Ordering::Equal {
        return str_cmp;
    }

    // Special cases:
    // 1. Empty strings
    match (a.is_empty(), b.is_empty()) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        (true, true) => unreachable!(),
        (false, false) => {}
    }
    // 2. Dots
    match (a == b".", b == b".") {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        (true, true) => unreachable!(),
        (false, false) => {}
    }
    // 3. Two Dots
    match (a == b"..", b == b"..") {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        (true, true) => unreachable!(),
        (false, false) => {}
    }
    // 4. Strings starting with a dot
    match (a.starts_with(b"."), b.starts_with(b".")) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        (true, true) => {
            // Strip the leading dot for later comparisons
            a = &a[1..];
            b = &b[1..];
        }
        _ => {}
    }

    // Compare without the file extensions, then, on a tie, with them.
    match compare_parts(remove_file_ending(a), remove_file_ending(b)) {
        Ordering::Equal => compare_parts(a, b),
        ord => ord,
    }
}

fn compare_parts(mut a: &[u8], mut b: &[u8]) -> Ordering {
    // 1. Compare leading non-numerical part
    // 2. Compare leading numerical part
    // 3. Repeat
    while !a.is_empty() || !b.is_empty() {
        let a_numerical_start = a.iter().position(u8::is_ascii_digit).unwrap_or(a.len());
        let b_numerical_start = b.iter().position(u8::is_ascii_digit).unwrap_or(b.len());

        let a_str = &a[..a_numerical_start];
        let b_str = &b[..b_numerical_start];

        match version_non_digit_cmp(a_str, b_str) {
            Ordering::Equal => {}
            ord => return ord,
        }

        a = &a[a_numerical_start..];
        b = &b[b_numerical_start..];

        let a_numerical_end = a
            .iter()
            .position(|c| !c.is_ascii_digit())
            .unwrap_or(a.len());
        let b_numerical_end = b
            .iter()
            .position(|c| !c.is_ascii_digit())
            .unwrap_or(b.len());

        let a_str = &a[a.iter().position(|&c| c != b'0').unwrap_or(a.len())..a_numerical_end];
        let b_str = &b[b.iter().position(|&c| c != b'0').unwrap_or(b.len())..b_numerical_end];

        match a_str.len().cmp(&b_str.len()) {
            Ordering::Equal => {}
            ord => return ord,
        }

        match a_str.cmp(b_str) {
            Ordering::Equal => {}
            ord => return ord,
        }

        a = &a[a_numerical_end..];
        b = &b[b_numerical_end..];
    }

    Ordering::Equal
}

fn non_digit_order(x: Option<u8>, y: Option<u8>) -> Ordering {
    let rank = |byte: Option<u8>| match byte {
        Some(b'~') => 0,
        None => 1,
        Some(byte) if byte.is_ascii_alphabetic() => 2,
        Some(_) => 3,
    };
    rank(x).cmp(&rank(y)).then_with(|| x.cmp(&y))
}

#[derive(Default)]
struct Cursor {
    at: usize,
    next: Option<u8>,
    ready: bool,
}

impl Cursor {
    #[inline(always)]
    fn peek(&mut self, source: &[u8], mods: &Mods, bytes: &mut usize) -> Option<Option<u8>> {
        if !self.ready {
            let end = source.len().min(self.at.saturating_add(*bytes));
            let next = source[self.at..end]
                .iter()
                .position(|&byte| kept(byte, mods));
            let count = next.map_or(end - self.at, |offset| offset + 1);
            self.at += count;
            *bytes -= count;
            if next.is_some() {
                let byte = source[self.at - 1];
                self.next = Some(if mods.fold {
                    byte.to_ascii_uppercase()
                } else {
                    byte
                });
                self.ready = true;
            } else if self.at == source.len() {
                self.ready = true;
            } else {
                return None;
            }
        }
        Some(self.next)
    }

    fn advance(&mut self) {
        self.ready = false;
        self.next = None;
    }
}

#[derive(Default)]
struct Ending {
    length: usize,
    dots: usize,
    start: usize,
    suffix: Option<usize>,
    dot: bool,
    leading_dot: bool,
}

impl Ending {
    fn scan(
        &mut self,
        cursor: &mut Cursor,
        source: &[u8],
        mods: &Mods,
        bytes: &mut usize,
    ) -> Option<()> {
        let start = cursor.at;
        let end = source.len().min(start.saturating_add(*bytes));
        *bytes -= end - start;
        let window = &source[start..end];
        let first = if self.length == 0 {
            window
                .iter()
                .position(|&byte| kept(byte, mods))
                .unwrap_or(window.len())
        } else {
            0
        };
        for (offset, &byte) in window[first..].iter().enumerate() {
            let offset = first + offset;
            if !kept(byte, mods) {
                continue;
            }
            self.length += 1;
            if byte == b'.' && self.dots + 1 == self.length {
                self.dots += 1;
            }
            if self.length == 1 {
                self.leading_dot = byte == b'.';
                self.start = start + offset + usize::from(self.leading_dot);
                if self.leading_dot {
                    continue;
                }
            }
            if byte == b'.' {
                if self.suffix.is_none() || self.dot {
                    self.suffix = Some(start + offset);
                }
                self.dot = true;
            } else if self.dot {
                self.dot = false;
                if !byte.is_ascii_alphabetic() && byte != b'~' {
                    self.suffix = None;
                }
            } else if !byte.is_ascii_alphanumeric() && byte != b'~' {
                self.suffix = None;
            }
        }
        cursor.at = end;
        if end < source.len() {
            return None;
        }
        if self.dot {
            self.suffix = None;
        }
        Some(())
    }

    fn rank(&self) -> u8 {
        match (self.length, self.dots, self.leading_dot) {
            (0, _, _) => 0,
            (1, 1, _) => 1,
            (2, 2, _) => 2,
            (_, _, true) => 3,
            _ => 4,
        }
    }
}

#[derive(Default)]
enum Phase {
    #[default]
    Equal,
    LeftEnding,
    RightEnding,
    NonDigit,
    LeftZeros,
    RightZeros,
    Digits,
}

#[derive(Default)]
pub(super) struct VersionScan {
    phase: Phase,
    cursors: [Cursor; 2],
    endings: [Ending; 2],
    ends: [usize; 2],
    full: bool,
    digits: [usize; 2],
    difference: Option<Ordering>,
}

impl VersionScan {
    pub(super) fn step(
        &mut self,
        a: &[u8],
        b: &[u8],
        mods: &Mods,
        bytes: &mut usize,
    ) -> Option<Ordering> {
        loop {
            match self.phase {
                Phase::Equal => {
                    let mut equal = a.len() == b.len();
                    if equal && !self.cursors[0].ready && !self.cursors[1].ready {
                        let at = self.cursors[0].at;
                        let count = (a.len() - at).min(*bytes / 2);
                        equal = a[at..at + count] == b[at..at + count];
                        *bytes -= count * 2;
                        self.cursors[0].at += count;
                        self.cursors[1].at += count;
                    }
                    if equal {
                        let left = self.cursors[0].peek(a, &Mods::default(), bytes)?;
                        let right = self.cursors[1].peek(b, &Mods::default(), bytes)?;
                        equal = left == right;
                        if equal && left.is_none() {
                            return Some(Ordering::Equal);
                        }
                    }
                    if equal {
                        self.cursors[0].advance();
                        self.cursors[1].advance();
                    } else {
                        self.cursors = Default::default();
                        self.phase = Phase::LeftEnding;
                    }
                }
                Phase::LeftEnding | Phase::RightEnding => {
                    let side = usize::from(matches!(self.phase, Phase::RightEnding));
                    self.endings[side].scan(
                        &mut self.cursors[side],
                        if side == 0 { a } else { b },
                        mods,
                        bytes,
                    )?;
                    if side == 0 {
                        self.phase = Phase::RightEnding;
                        continue;
                    }
                    let order = self.endings[0].rank().cmp(&self.endings[1].rank());
                    if order != Ordering::Equal || self.endings[0].rank() < 3 {
                        return Some(order);
                    }
                    self.ends = [
                        self.endings[0].suffix.unwrap_or(a.len()),
                        self.endings[1].suffix.unwrap_or(b.len()),
                    ];
                    self.restart();
                }
                Phase::NonDigit => {
                    if !mods.dictionary
                        && !mods.ignore_nonprinting
                        && !self.cursors[0].ready
                        && !self.cursors[1].ready
                    {
                        let left = &a[self.cursors[0].at..self.ends[0]];
                        let right = &b[self.cursors[1].at..self.ends[1]];
                        let limit = left.len().min(right.len()).min(*bytes / 2);
                        let left = &left[..limit];
                        let right = &right[..limit];
                        let count = left
                            .iter()
                            .zip(right)
                            .position(|(x, y)| x.is_ascii_digit() || y.is_ascii_digit())
                            .unwrap_or(limit);
                        if count != 0 {
                            let equal = if mods.fold {
                                left[..count].eq_ignore_ascii_case(&right[..count])
                            } else {
                                left[..count] == right[..count]
                            };
                            *bytes -= count * 2;
                            if !equal {
                                return left[..count].iter().zip(&right[..count]).find_map(
                                    |(&x, &y)| {
                                        let (x, y) = if mods.fold {
                                            (x.to_ascii_uppercase(), y.to_ascii_uppercase())
                                        } else {
                                            (x, y)
                                        };
                                        (x != y).then(|| non_digit_order(Some(x), Some(y)))
                                    },
                                );
                            }
                            self.cursors[0].at += count;
                            self.cursors[1].at += count;
                            continue;
                        }
                    }
                    let left = self.cursors[0].peek(&a[..self.ends[0]], mods, bytes)?;
                    let right = self.cursors[1].peek(&b[..self.ends[1]], mods, bytes)?;
                    if left.is_none() && right.is_none() {
                        if self.full {
                            return Some(Ordering::Equal);
                        }
                        self.full = true;
                        self.ends = [a.len(), b.len()];
                        self.restart();
                        continue;
                    }
                    let x = left.filter(|byte| !byte.is_ascii_digit());
                    let y = right.filter(|byte| !byte.is_ascii_digit());
                    if x.is_none() && y.is_none() {
                        self.phase = Phase::LeftZeros;
                        continue;
                    }
                    let order = non_digit_order(x, y);
                    if order != Ordering::Equal {
                        return Some(order);
                    }
                    self.cursors[0].advance();
                    self.cursors[1].advance();
                }
                Phase::LeftZeros | Phase::RightZeros => {
                    let side = usize::from(matches!(self.phase, Phase::RightZeros));
                    let source = if side == 0 {
                        &a[..self.ends[0]]
                    } else {
                        &b[..self.ends[1]]
                    };
                    loop {
                        if !mods.dictionary && !mods.ignore_nonprinting && !self.cursors[side].ready
                        {
                            let at = self.cursors[side].at;
                            let end = source.len().min(at.saturating_add(*bytes));
                            let count = source[at..end]
                                .iter()
                                .position(|&byte| byte != b'0')
                                .unwrap_or(end - at);
                            self.cursors[side].at += count;
                            *bytes -= count;
                        }
                        if self.cursors[side].peek(source, mods, bytes)? != Some(b'0') {
                            break;
                        }
                        self.cursors[side].advance();
                    }
                    self.phase = if side == 0 {
                        Phase::RightZeros
                    } else {
                        Phase::Digits
                    };
                }
                Phase::Digits => {
                    if !mods.dictionary
                        && !mods.ignore_nonprinting
                        && !self.cursors[0].ready
                        && !self.cursors[1].ready
                    {
                        let left = &a[self.cursors[0].at..self.ends[0]];
                        let right = &b[self.cursors[1].at..self.ends[1]];
                        let limit = left.len().min(right.len()).min(*bytes / 2);
                        let count = left[..limit]
                            .iter()
                            .zip(&right[..limit])
                            .position(|(x, y)| !x.is_ascii_digit() || !y.is_ascii_digit())
                            .unwrap_or(limit);
                        if count != 0 {
                            let order = left[..count].cmp(&right[..count]);
                            if order != Ordering::Equal && self.difference.is_none() {
                                self.difference = Some(order);
                            }
                            for side in 0..2 {
                                self.cursors[side].at += count;
                                self.digits[side] += count;
                            }
                            *bytes -= count * 2;
                            continue;
                        }
                    }
                    let x = self.cursors[0]
                        .peek(&a[..self.ends[0]], mods, bytes)?
                        .filter(u8::is_ascii_digit);
                    let y = self.cursors[1]
                        .peek(&b[..self.ends[1]], mods, bytes)?
                        .filter(u8::is_ascii_digit);
                    if x.is_none() && y.is_none() {
                        let order = self.digits[0]
                            .cmp(&self.digits[1])
                            .then(self.difference.unwrap_or(Ordering::Equal));
                        if order != Ordering::Equal {
                            return Some(order);
                        }
                        self.digits = [0; 2];
                        self.difference = None;
                        self.phase = Phase::NonDigit;
                        continue;
                    }
                    if let (Some(x), Some(y)) = (x, y) {
                        if x != y && self.difference.is_none() {
                            self.difference = Some(x.cmp(&y));
                        }
                    }
                    for (side, digit) in [x, y].into_iter().enumerate() {
                        if digit.is_some() {
                            self.digits[side] += 1;
                            self.cursors[side].advance();
                        }
                    }
                }
            }
        }
    }

    fn restart(&mut self) {
        self.cursors = std::array::from_fn(|side| Cursor {
            at: self.endings[side].start,
            ..Cursor::default()
        });
        self.phase = Phase::NonDigit;
    }
}
