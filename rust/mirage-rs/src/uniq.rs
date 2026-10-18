use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};

use regex_syntax::hir::{Class, ClassUnicode, HirKind};
use serde::Deserialize;

use crate::{Stream, StreamError, parse_config, saturating_u64, saturating_u64_opt};

const WORK: usize = 16 * 1024;
const SEGMENT: usize = 1024;
const RAW: u32 = 0x11_0000;

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    count: bool,
    duplicates_only: bool,
    unique_only: bool,
    #[serde(deserialize_with = "saturating_u64")]
    skip_fields: u64,
    #[serde(deserialize_with = "saturating_u64")]
    skip_chars: u64,
    #[serde(deserialize_with = "saturating_u64_opt")]
    check_chars: Option<u64>,
    ignore_case: bool,
    all_repeated: Option<AllMethod>,
    group: Option<GroupMethod>,
    zero_terminated: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AllMethod {
    None,
    Prepend,
    Separate,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum GroupMethod {
    Prepend,
    Append,
    Separate,
    Both,
}

#[derive(Clone, Copy)]
enum OutputMode {
    First {
        repeated: bool,
    },
    Completed {
        count: bool,
        repeated: bool,
        unique: bool,
    },
    All(AllMethod),
    Group(GroupMethod),
}

struct Plan {
    output: OutputMode,
    skip_fields: u64,
    skip_chars: u64,
    check_chars: Option<u64>,
    separator: u8,
    lowercase: Option<Lowercase>,
}

struct Lowercase {
    cased: ClassUnicode,
    ignorable: ClassUnicode,
}

impl Lowercase {
    fn new() -> Self {
        Self {
            cased: unicode_class(r"\p{Cased}"),
            ignorable: unicode_class(r"\p{Case_Ignorable}"),
        }
    }

    fn contains(class: &ClassUnicode, unit: u32) -> bool {
        class
            .ranges()
            .binary_search_by(|range| {
                if u32::from(range.end()) < unit {
                    std::cmp::Ordering::Less
                } else if u32::from(range.start()) > unit {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }
}

fn unicode_class(pattern: &str) -> ClassUnicode {
    let hir = regex_syntax::Parser::new()
        .parse(pattern)
        .expect("Unicode property");
    match hir.kind() {
        HirKind::Class(Class::Unicode(class)) => class.clone(),
        _ => unreachable!("Unicode property is a class"),
    }
}

struct Segment<T> {
    values: Vec<T>,
    next: OnceLock<Arc<Segment<T>>>,
}

struct Chain<T> {
    head: Option<Arc<Segment<T>>>,
    tail: Option<Arc<Segment<T>>>,
    len: usize,
}

impl<T> Default for Chain<T> {
    fn default() -> Self {
        Self {
            head: None,
            tail: None,
            len: 0,
        }
    }
}

impl<T> Chain<T> {
    fn append(&mut self, values: Vec<T>) {
        if values.is_empty() {
            return;
        }
        self.len += values.len();
        let node = Arc::new(Segment {
            values,
            next: OnceLock::new(),
        });
        if let Some(tail) = self.tail.take() {
            assert!(tail.next.set(Arc::clone(&node)).is_ok());
        } else {
            self.head = Some(Arc::clone(&node));
        }
        self.tail = Some(node);
    }

    fn cursor(&self) -> Cursor<T> {
        Cursor {
            node: self.head.clone(),
            offset: 0,
        }
    }

    fn into_head(mut self) -> Option<Arc<Segment<T>>> {
        self.tail = None;
        self.head.take()
    }
}

fn release<T>(head: &mut Option<Arc<Segment<T>>>) -> usize {
    let Some(node) = head.take() else { return 0 };
    match Arc::try_unwrap(node) {
        Ok(node) => {
            *head = node.next.into_inner();
            node.values.len()
        }
        Err(_) => 0,
    }
}

impl<T> Drop for Chain<T> {
    fn drop(&mut self) {
        self.tail = None;
        while self.head.is_some() {
            release(&mut self.head);
        }
    }
}

struct Builder<T> {
    chain: Chain<T>,
    pending: Vec<T>,
}

impl<T> Default for Builder<T> {
    fn default() -> Self {
        Self {
            chain: Chain::default(),
            pending: Vec::with_capacity(SEGMENT),
        }
    }
}

impl<T> Builder<T> {
    fn push(&mut self, value: T) {
        self.pending.push(value);
        if self.pending.len() == SEGMENT {
            self.chain.append(std::mem::replace(
                &mut self.pending,
                Vec::with_capacity(SEGMENT),
            ));
        }
    }

    fn finish(mut self) -> Chain<T> {
        self.chain.append(self.pending);
        self.chain
    }

    fn is_empty(&self) -> bool {
        self.chain.len == 0 && self.pending.is_empty()
    }
}

struct Cursor<T> {
    node: Option<Arc<Segment<T>>>,
    offset: usize,
}

impl<T> Clone for Cursor<T> {
    fn clone(&self) -> Self {
        Self {
            node: self.node.clone(),
            offset: self.offset,
        }
    }
}

impl<T: Copy> Cursor<T> {
    fn next(&mut self) -> Option<T> {
        let node = self.node.as_ref()?;
        let value = node.values[self.offset];
        self.offset += 1;
        if self.offset == node.values.len() {
            self.node = node.next.get().cloned();
            self.offset = 0;
        }
        Some(value)
    }
}

enum Retired {
    Bytes(Option<Arc<Segment<u8>>>),
    Key(Option<Arc<Segment<u32>>>),
}

impl Retired {
    fn step(&mut self) -> usize {
        match self {
            Self::Bytes(head) => release(head),
            Self::Key(head) => release(head) * 4,
        }
    }

    fn empty(&self) -> bool {
        match self {
            Self::Bytes(head) => head.is_none(),
            Self::Key(head) => head.is_none(),
        }
    }
}

impl Drop for Retired {
    fn drop(&mut self) {
        while !self.empty() {
            self.step();
        }
    }
}

struct Group {
    first: Chain<u8>,
    key: Chain<u32>,
    count: u64,
}

struct KeyScan {
    cursor: Cursor<u8>,
    key: Builder<u32>,
    fields: u64,
    field_body: bool,
    skip: u64,
    width: Option<u64>,
}

fn decode(cursor: &mut Cursor<u8>) -> Option<u32> {
    let mut trial = cursor.clone();
    let first = trial.next()?;
    let len = match first {
        0..=0x7f => 1,
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 0,
    };
    let mut bytes = [first, 0, 0, 0];
    for byte in bytes.iter_mut().take(len).skip(1) {
        *byte = trial.next().unwrap_or(0);
    }
    if len > 0 {
        if let Ok(text) = std::str::from_utf8(&bytes[..len]) {
            *cursor = trial;
            return text.chars().next().map(u32::from);
        }
    }
    cursor.next();
    Some(RAW + u32::from(first))
}

impl KeyScan {
    fn step(&mut self) -> bool {
        if self.width == Some(0) {
            return true;
        }
        let Some(unit) = decode(&mut self.cursor) else {
            return true;
        };
        let blank = matches!(unit, 0x20 | 0x09);
        if self.fields > 0 {
            if self.field_body && blank {
                self.fields -= 1;
                self.field_body = false;
            } else if !blank {
                self.field_body = true;
            }
            if self.fields > 0 {
                return false;
            }
        }
        if self.skip > 0 {
            self.skip -= 1;
        } else {
            self.key.push(unit);
            if let Some(width) = &mut self.width {
                *width -= 1;
            }
        }
        false
    }
}

struct Lower {
    cursor: Cursor<u32>,
    sigma: Option<Cursor<u32>>,
    source: Chain<u32>,
    key: Builder<u32>,
    previous_cased: bool,
}

impl Lower {
    fn step(&mut self, tables: &Lowercase) -> bool {
        if let Some(lookahead) = &mut self.sigma {
            let next = lookahead.next();
            if next.is_some_and(|unit| Lowercase::contains(&tables.ignorable, unit)) {
                return false;
            }
            let followed = next.is_some_and(|unit| Lowercase::contains(&tables.cased, unit));
            self.key.push(if followed { 0x3c3 } else { 0x3c2 });
            self.previous_cased = true;
            self.sigma = None;
            return false;
        }
        let Some(unit) = self.cursor.next() else {
            return true;
        };
        if unit == 0x3a3 && self.previous_cased {
            self.sigma = Some(self.cursor.clone());
            return false;
        }
        if let Some(character) = char::from_u32(unit) {
            for lower in character.to_lowercase() {
                self.key.push(u32::from(lower));
            }
        } else {
            self.key.push(unit);
        }
        if !Lowercase::contains(&tables.ignorable, unit) {
            self.previous_cased = Lowercase::contains(&tables.cased, unit);
        }
        false
    }
}

#[derive(Clone, Copy)]
enum Target {
    First { count: bool },
    Current,
    Separator,
}

#[derive(Clone, Copy)]
enum After {
    Replace,
    Discard,
    Finish,
}

struct Emission {
    cursor: Cursor<u8>,
    prefix: Vec<u8>,
    offset: usize,
}

enum Work {
    Receiving,
    Key(KeyScan),
    Lower(Lower),
    Compare(Cursor<u32>, Cursor<u32>),
    Emit(Emission),
    Finished,
}

struct Uniq {
    work: Work,
    plan: Plan,
    input: Vec<u8>,
    input_offset: usize,
    ended: bool,
    record: Builder<u8>,
    current: Chain<u8>,
    key: Chain<u32>,
    group: Option<Group>,
    groups: u64,
    repeated_groups: u64,
    emissions: VecDeque<Target>,
    after: After,
    retired: VecDeque<Retired>,
}

impl Drop for Uniq {
    fn drop(&mut self) {
        self.work = Work::Finished;
    }
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    if config.group.is_some()
        && (config.count
            || config.duplicates_only
            || config.unique_only
            || config.all_repeated.is_some())
    {
        return Err(StreamError::new(
            "uniq: --group is mutually exclusive with -c/-d/-D/-u",
        ));
    }
    if config.count && config.all_repeated.is_some() {
        return Err(StreamError::new(
            "uniq: printing all duplicated lines and repeat counts is meaningless",
        ));
    }
    let output = if let Some(method) = config.group {
        OutputMode::Group(method)
    } else if let Some(method) = config.all_repeated {
        OutputMode::All(method)
    } else if config.count || config.unique_only {
        OutputMode::Completed {
            count: config.count,
            repeated: config.duplicates_only,
            unique: config.unique_only,
        }
    } else {
        OutputMode::First {
            repeated: config.duplicates_only,
        }
    };
    Ok(Box::new(Uniq {
        work: Work::Receiving,
        plan: Plan {
            output,
            skip_fields: config.skip_fields,
            skip_chars: config.skip_chars,
            check_chars: config.check_chars,
            separator: if config.zero_terminated { 0 } else { b'\n' },
            lowercase: config.ignore_case.then(Lowercase::new),
        },
        input: Vec::new(),
        input_offset: 0,
        ended: false,
        record: Builder::default(),
        current: Chain::default(),
        key: Chain::default(),
        group: None,
        groups: 0,
        repeated_groups: 0,
        emissions: VecDeque::new(),
        after: After::Discard,
        retired: VecDeque::new(),
    }))
}

impl Uniq {
    fn scan_record(&mut self) {
        self.current = std::mem::take(&mut self.record).finish();
        self.work = Work::Key(KeyScan {
            cursor: self.current.cursor(),
            key: Builder::default(),
            fields: self.plan.skip_fields,
            field_body: false,
            skip: self.plan.skip_chars,
            width: self.plan.check_chars,
        });
    }

    fn compare(&mut self) {
        if let Some(group) = &self.group {
            if group.key.len == self.key.len {
                self.work = Work::Compare(group.key.cursor(), self.key.cursor());
                return;
            }
        }
        self.accept(false);
    }

    fn completed(&mut self) {
        let Some(group) = &self.group else { return };
        if let OutputMode::Completed {
            count,
            repeated,
            unique,
        } = self.plan.output
        {
            if !(repeated && group.count == 1 || unique && group.count > 1) {
                self.emissions.push_back(Target::First { count });
            }
        }
    }

    fn accept(&mut self, same: bool) {
        if !same {
            self.completed();
            self.after = After::Replace;
            self.advance_output();
            return;
        }
        let group = self.group.as_mut().expect("a matching group");
        group.count = group.count.saturating_add(1);
        match self.plan.output {
            OutputMode::Group(_) => self.emissions.push_back(Target::Current),
            OutputMode::All(method) => {
                if group.count == 2 {
                    if matches!(method, AllMethod::Prepend)
                        || matches!(method, AllMethod::Separate) && self.repeated_groups > 0
                    {
                        self.emissions.push_back(Target::Separator);
                    }
                    self.emissions.push_back(Target::First { count: false });
                    self.repeated_groups = self.repeated_groups.saturating_add(1);
                }
                self.emissions.push_back(Target::Current);
            }
            OutputMode::First { repeated: true } if group.count == 2 => {
                self.emissions.push_back(Target::First { count: false });
            }
            _ => {}
        }
        self.after = After::Discard;
        self.advance_output();
    }

    fn discard(&mut self) {
        self.retired.push_back(Retired::Bytes(
            std::mem::take(&mut self.current).into_head(),
        ));
        self.retired
            .push_back(Retired::Key(std::mem::take(&mut self.key).into_head()));
    }

    fn replace(&mut self) {
        if let Some(group) = self.group.take() {
            self.retired
                .push_back(Retired::Bytes(group.first.into_head()));
            self.retired.push_back(Retired::Key(group.key.into_head()));
        }
        self.group = Some(Group {
            first: std::mem::take(&mut self.current),
            key: std::mem::take(&mut self.key),
            count: 1,
        });
        self.groups = self.groups.saturating_add(1);
        match self.plan.output {
            OutputMode::Group(method) => {
                if matches!(method, GroupMethod::Prepend | GroupMethod::Both) || self.groups > 1 {
                    self.emissions.push_back(Target::Separator);
                }
                self.emissions.push_back(Target::First { count: false });
            }
            OutputMode::First { repeated: false } => {
                self.emissions.push_back(Target::First { count: false })
            }
            _ => {}
        }
        self.after = After::Discard;
        self.advance_output();
    }

    fn advance_output(&mut self) {
        if let Some(target) = self.emissions.pop_front() {
            let mut prefix = Vec::new();
            let cursor = match target {
                Target::First { count } => {
                    let group = self.group.as_ref().expect("output has a group");
                    if count {
                        prefix = format!("{:>7} ", group.count).into_bytes();
                    }
                    group.first.cursor()
                }
                Target::Current => self.current.cursor(),
                Target::Separator => Cursor {
                    node: None,
                    offset: 0,
                },
            };
            self.work = Work::Emit(Emission {
                cursor,
                prefix,
                offset: 0,
            });
        } else {
            match self.after {
                After::Replace => self.replace(),
                After::Discard => {
                    self.discard();
                    self.work = Work::Receiving;
                }
                After::Finish => {
                    if let Some(group) = self.group.take() {
                        self.retired
                            .push_back(Retired::Bytes(group.first.into_head()));
                        self.retired.push_back(Retired::Key(group.key.into_head()));
                    }
                    self.work = Work::Finished;
                }
            }
        }
    }

    fn step(&mut self, out: &mut Vec<u8>) {
        let mut budget = WORK;
        while budget > 0 {
            if let Some(retired) = self.retired.front_mut() {
                budget = budget.saturating_sub(retired.step().max(1));
                if retired.empty() {
                    self.retired.pop_front();
                }
                continue;
            }
            match std::mem::replace(&mut self.work, Work::Receiving) {
                Work::Receiving => {
                    if let Some(&byte) = self.input.get(self.input_offset) {
                        self.input_offset += 1;
                        budget -= 1;
                        if byte == self.plan.separator {
                            self.scan_record();
                        } else {
                            self.record.push(byte);
                        }
                    } else if self.ended {
                        if !self.record.is_empty() {
                            self.scan_record();
                        } else {
                            self.completed();
                            if self.group.is_some()
                                && matches!(
                                    self.plan.output,
                                    OutputMode::Group(GroupMethod::Append | GroupMethod::Both)
                                )
                            {
                                self.emissions.push_back(Target::Separator);
                            }
                            self.after = After::Finish;
                            self.advance_output();
                        }
                    } else {
                        return;
                    }
                }
                Work::Key(mut scan) => {
                    budget = budget.saturating_sub(16);
                    if scan.step() {
                        let key = scan.key.finish();
                        if self.plan.lowercase.is_some() {
                            self.work = Work::Lower(Lower {
                                cursor: key.cursor(),
                                sigma: None,
                                source: key,
                                key: Builder::default(),
                                previous_cased: false,
                            });
                        } else {
                            self.key = key;
                            self.compare();
                        }
                    } else {
                        self.work = Work::Key(scan);
                    }
                }
                Work::Lower(mut lower) => {
                    budget = budget.saturating_sub(16);
                    if lower.step(self.plan.lowercase.as_ref().expect("lowercase enabled")) {
                        self.key = lower.key.finish();
                        self.retired
                            .push_back(Retired::Key(lower.source.into_head()));
                        self.compare();
                    } else {
                        self.work = Work::Lower(lower);
                    }
                }
                Work::Compare(mut left, mut right) => {
                    budget = budget.saturating_sub(8);
                    match (left.next(), right.next()) {
                        (None, None) => self.accept(true),
                        (Some(left_unit), Some(right_unit)) if left_unit == right_unit => {
                            self.work = Work::Compare(left, right);
                        }
                        _ => self.accept(false),
                    }
                }
                Work::Emit(mut emission) => {
                    while budget > 0 {
                        budget -= 1;
                        if let Some(&byte) = emission.prefix.get(emission.offset) {
                            emission.offset += 1;
                            out.push(byte);
                        } else if let Some(byte) = emission.cursor.next() {
                            out.push(byte);
                        } else {
                            out.push(self.plan.separator);
                            self.advance_output();
                            return;
                        }
                    }
                    self.work = Work::Emit(emission);
                }
                Work::Finished => {
                    self.work = Work::Finished;
                    return;
                }
            }
        }
    }
}

impl Stream for Uniq {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !input.is_empty() {
            if self.busy() || self.ended {
                return Err(StreamError::new(
                    "uniq: drain pending work before feeding input",
                ));
            }
            self.input.clear();
            self.input.extend_from_slice(input);
            self.input_offset = 0;
        }
        self.step(out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.ended = true;
        self.step(out);
        Ok(())
    }

    fn busy(&self) -> bool {
        !self.retired.is_empty()
            || match self.work {
                Work::Receiving => self.input_offset < self.input.len() || self.ended,
                Work::Finished => false,
                _ => true,
            }
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }

    fn cancel(&mut self) -> bool {
        if self.ended && matches!(self.work, Work::Finished) {
            return true;
        }
        match std::mem::replace(&mut self.work, Work::Finished) {
            Work::Key(scan) => {
                drop(scan.cursor);
                self.retired
                    .push_back(Retired::Key(scan.key.finish().into_head()));
            }
            Work::Lower(lower) => {
                drop(lower.cursor);
                drop(lower.sigma);
                self.retired
                    .push_back(Retired::Key(lower.source.into_head()));
                self.retired
                    .push_back(Retired::Key(lower.key.finish().into_head()));
            }
            Work::Compare(left, right) => {
                drop(left);
                drop(right);
            }
            Work::Emit(emission) => drop(emission),
            Work::Receiving | Work::Finished => {}
        }
        self.emissions.clear();
        self.retired.push_back(Retired::Bytes(
            std::mem::take(&mut self.record).finish().into_head(),
        ));
        self.discard();
        if let Some(group) = self.group.take() {
            self.retired
                .push_back(Retired::Bytes(group.first.into_head()));
            self.retired.push_back(Retired::Key(group.key.into_head()));
        }
        self.input.clear();
        self.input_offset = 0;
        self.ended = true;
        true
    }

    fn done(&self) -> bool {
        matches!(self.work, Work::Finished)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run;

    fn splits(config: &str, input: &[u8], expected: &[u8]) {
        assert_eq!(run("uniq", config, &[input]), (expected.to_vec(), None));
        for split in 0..=input.len() {
            assert_eq!(
                run("uniq", config, &[&input[..split], &input[split..]]),
                (expected.to_vec(), None),
                "split {split}"
            );
        }
        let chunks: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(run("uniq", config, &chunks), (expected.to_vec(), None));
    }

    #[test]
    fn adjacent_groups_and_counts() {
        let data = b"a\na\nb\nc\nc";
        splits("{}", data, b"a\nb\nc\n");
        splits(
            r#"{"count":true}"#,
            data,
            b"      2 a\n      1 b\n      2 c\n",
        );
        splits(r#"{"duplicates_only":true}"#, data, b"a\nc\n");
        splits(r#"{"unique_only":true}"#, data, b"b\n");
        splits(
            r#"{"count":true,"duplicates_only":true}"#,
            data,
            b"      2 a\n      2 c\n",
        );
        splits(r#"{"count":true,"unique_only":true}"#, data, b"      1 b\n");
        splits(r#"{"duplicates_only":true,"unique_only":true}"#, data, b"");
        splits("{}", b"\n\na\na\n\n", b"\na\n\n");
        splits("{}", b"", b"");
    }

    #[test]
    fn every_group_and_repeated_separator_mode() {
        let data = b"a\na\nb\nc\nc\nc\n";
        for (method, expected) in [
            ("none", b"a\na\nc\nc\nc\n".as_slice()),
            ("prepend", b"\na\na\n\nc\nc\nc\n".as_slice()),
            ("separate", b"a\na\n\nc\nc\nc\n".as_slice()),
        ] {
            splits(&format!(r#"{{"all_repeated":"{method}"}}"#), data, expected);
        }
        for (method, expected) in [
            ("prepend", b"\na\na\n\nb\n\nc\nc\nc\n".as_slice()),
            ("append", b"a\na\n\nb\n\nc\nc\nc\n\n".as_slice()),
            ("both", b"\na\na\n\nb\n\nc\nc\nc\n\n".as_slice()),
            ("separate", b"a\na\n\nb\n\nc\nc\nc\n".as_slice()),
        ] {
            splits(&format!(r#"{{"group":"{method}"}}"#), data, expected);
        }
        splits(
            r#"{"zero_terminated":true,"group":"both"}"#,
            b"a\0a\0b",
            b"\0a\0a\0\0b\0\0",
        );
        splits(r#"{"group":"both"}"#, b"", b"");
    }

    #[test]
    fn keys_preserve_raw_bytes_and_count_unicode_scalars() {
        splits("{}", b"\xff\n\xfe\n\xff\n", b"\xff\n\xfe\n\xff\n");
        splits(r#"{"skip_chars":1}"#, b"\xffA\n\xfeA\nB\n", b"\xffA\nB\n");
        splits(
            r#"{"skip_chars":1,"check_chars":1}"#,
            "😀aX\néaY\nzb\n".as_bytes(),
            "😀aX\nzb\n".as_bytes(),
        );
        splits(
            r#"{"skip_fields":1}"#,
            "😀 one\né one\nx\ny\n".as_bytes(),
            "😀 one\nx\n".as_bytes(),
        );
        splits(
            r#"{"skip_fields":2,"skip_chars":1}"#,
            b"a b X\nc d X\na b Y\n",
            b"a b X\na b Y\n",
        );
        splits(r#"{"check_chars":0}"#, b"\xff\n\xfe\n", b"\xff\n");
        splits(
            "{}",
            b"\xe2\x82\n\xe2\x82\n\xe2\x81\n",
            b"\xe2\x82\n\xe2\x81\n",
        );
        splits(
            "{}",
            b"\xed\xa0\x80\n\xef\xbf\xbd\n",
            b"\xed\xa0\x80\n\xef\xbf\xbd\n",
        );
    }

    #[test]
    fn lowercase_uses_selected_key_context() {
        splits(
            r#"{"ignore_case":true}"#,
            "ΟΣ\nΟς\nΟΣΑ\nοσα\n".as_bytes(),
            "ΟΣ\nΟΣΑ\n".as_bytes(),
        );
        splits(
            r#"{"ignore_case":true}"#,
            "AΣ\u{301}\nAς\u{301}\nAΣ\u{301}B\nAσ\u{301}b\nΣ\nσ\n".as_bytes(),
            "AΣ\u{301}\nAΣ\u{301}B\nΣ\n".as_bytes(),
        );
        splits(
            r#"{"ignore_case":true,"skip_chars":1}"#,
            "AΣ\nBσ\n".as_bytes(),
            "AΣ\n".as_bytes(),
        );
        splits(
            r#"{"ignore_case":true,"check_chars":2}"#,
            "AΣX\naςY\n".as_bytes(),
            "AΣX\n".as_bytes(),
        );
        splits(
            r#"{"ignore_case":true}"#,
            "İ\ni\u{307}\n".as_bytes(),
            "İ\n".as_bytes(),
        );
        splits(
            r#"{"ignore_case":true}"#,
            b"A\xff\nA\xfe\n",
            b"A\xff\nA\xfe\n",
        );
    }

    #[test]
    fn output_is_available_before_later_input() {
        for (config, data, expected) in [
            ("{}", b"a\n".as_slice(), b"a\n".as_slice()),
            (
                r#"{"count":true}"#,
                b"a\na\nb\n".as_slice(),
                b"      2 a\n".as_slice(),
            ),
            (
                r#"{"duplicates_only":true}"#,
                b"a\na\n".as_slice(),
                b"a\n".as_slice(),
            ),
            (
                r#"{"unique_only":true}"#,
                b"a\nb\n".as_slice(),
                b"a\n".as_slice(),
            ),
            (
                r#"{"all_repeated":"none"}"#,
                b"a\na\n".as_slice(),
                b"a\n".as_slice(),
            ),
            (
                r#"{"group":"prepend"}"#,
                b"a\n".as_slice(),
                b"\n".as_slice(),
            ),
            (
                r#"{"all_repeated":"prepend"}"#,
                b"a\na\n".as_slice(),
                b"\n".as_slice(),
            ),
        ] {
            let mut stream = open(config.as_bytes()).unwrap();
            let mut output = Vec::new();
            stream.feed(data, &mut output).unwrap();
            while output.is_empty() && stream.busy() {
                stream.drain(&mut output).unwrap();
            }
            assert_eq!(output, expected);
        }
    }

    #[test]
    fn giant_records_are_scanned_compared_and_rendered_in_steps() {
        let size = 256 * 1024;
        let mut data = vec![b'A'; size];
        data.push(b'\n');
        data.extend(std::iter::repeat_n(b'a', size));
        data.push(b'\n');
        let mut stream = open(br#"{"count":true,"ignore_case":true}"#).unwrap();
        let mut output = Vec::new();
        let mut calls = 0;
        for input in data.chunks(WORK) {
            let mut piece = Vec::new();
            stream.feed(input, &mut piece).unwrap();
            assert!(piece.len() <= WORK);
            output.extend(piece);
            while stream.busy() {
                let mut piece = Vec::new();
                stream.drain(&mut piece).unwrap();
                assert!(piece.len() <= WORK);
                output.extend(piece);
                calls += 1;
            }
        }
        assert!(output.is_empty());
        stream.finish(&mut output).unwrap();
        while stream.busy() {
            let mut piece = Vec::new();
            stream.drain(&mut piece).unwrap();
            assert!(piece.len() <= WORK);
            output.extend(piece);
            calls += 1;
        }
        assert!(calls > size / WORK * 16);
        let mut expected = b"      2 ".to_vec();
        expected.extend(std::iter::repeat_n(b'A', size));
        expected.push(b'\n');
        assert_eq!(output, expected);
    }

    fn retire_cancelled(stream: &mut dyn Stream) {
        assert!(stream.cancel());
        assert!(stream.cancel());
        assert!(stream.busy());
        let mut calls = 0;
        while stream.busy() {
            let mut output = Vec::new();
            stream.drain(&mut output).unwrap();
            assert!(output.is_empty());
            calls += 1;
            assert!(calls < 1024, "cancellation retirement made no progress");
        }
        assert!(calls > 4);
        let mut output = Vec::new();
        stream.finish(&mut output).unwrap();
        assert!(output.is_empty());
        assert!(!stream.busy());
        assert!(stream.done());
    }

    #[test]
    fn cancellation_retires_partial_records_and_key_builders_in_steps() {
        let size = 256 * 1024;
        let record = vec![b'A'; size];
        for (config, terminate, drains) in [
            (r#"{}"#, false, 0),
            (r#"{}"#, true, 0),
            (r#"{"ignore_case":true}"#, true, size / SEGMENT + 10),
        ] {
            let mut stream = open(config.as_bytes()).unwrap();
            let mut output = Vec::new();
            for chunk in record.chunks(WORK) {
                stream.feed(chunk, &mut output).unwrap();
                assert!(output.is_empty());
                assert!(!stream.busy());
            }
            if terminate {
                stream.feed(b"\n", &mut output).unwrap();
                assert!(stream.busy());
            }
            for _ in 0..drains {
                stream.drain(&mut output).unwrap();
                assert!(output.is_empty());
                assert!(stream.busy());
            }
            retire_cancelled(stream.as_mut());
        }
    }

    #[test]
    fn cancellation_discards_pending_record_output_and_retires_its_group() {
        let record = vec![b'A'; 256 * 1024];
        for (config, copies) in [(r#"{}"#, 1), (r#"{"all_repeated":"prepend"}"#, 2)] {
            let mut stream = open(config.as_bytes()).unwrap();
            let mut output = Vec::new();
            for copy in 0..copies {
                for chunk in record.chunks(WORK) {
                    stream.feed(chunk, &mut output).unwrap();
                }
                stream.feed(b"\n", &mut output).unwrap();
                if copy + 1 < copies {
                    while stream.busy() {
                        stream.drain(&mut output).unwrap();
                    }
                    assert!(output.is_empty());
                }
            }
            while output.is_empty() {
                assert!(stream.busy());
                stream.drain(&mut output).unwrap();
            }
            if copies == 1 {
                assert!(output.len() <= WORK);
                assert!(output.iter().all(|&byte| byte == b'A'));
            } else {
                assert_eq!(output, b"\n");
            }
            retire_cancelled(stream.as_mut());
        }
    }

    #[test]
    fn cancellation_retires_the_group_and_current_key_during_comparison() {
        let size = 256 * 1024;
        let record = vec![b'A'; size];
        let mut stream = open(br#"{"count":true}"#).unwrap();
        let mut output = Vec::new();
        for copy in 0..2 {
            for chunk in record.chunks(WORK) {
                stream.feed(chunk, &mut output).unwrap();
            }
            stream.feed(b"\n", &mut output).unwrap();
            if copy == 0 {
                while stream.busy() {
                    stream.drain(&mut output).unwrap();
                }
            }
        }
        for _ in 0..(size / SEGMENT + 10) {
            stream.drain(&mut output).unwrap();
            assert!(stream.busy());
        }
        assert!(output.is_empty());
        retire_cancelled(stream.as_mut());
    }
}
