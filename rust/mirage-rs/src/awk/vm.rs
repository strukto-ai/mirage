use std::borrow::Cow;
use std::ops::Range;

use super::buffer::Buffer;
use super::compile::{
    ARGC, ARGV, Arr, CONVFMT, Code, ENVIRON, FILENAME, FS, Math, OFMT, OFS, ORS, Op, RLENGTH, RS,
    RSTART, SUBSEP, Var,
};
use super::format::{Formatter, NumberText, Output, Print};
use super::io::{
    Io, LIMIT, Next, Ordered, OutFile, OutPipe, Reader, Retired, STDERR_NAME, STDOUT_NAMES,
};
use super::parser::{Cmp, GetlineKind, RedirKind};
use super::text::{
    IndexSearch, Regexes, SplitScan, StringWork, Substitution, View, split_assignment, substr,
};
use super::value::{
    MAX_LEN, NumberScan, Text, Value, compare_numbers, default_number, string, strnum, to_int,
};
use crate::regex::Step as SearchStep;
use crate::request::{Opening, Request, WriteMode};

const MAX_CALL_DEPTH: usize = 100;

/// The most fields a record may be given; mawk 1.3.4 crashes well past
/// this rather than refusing.
const MAX_FIELDS: usize = 1 << 22;

pub(super) fn no_memory() -> Vec<u8> {
    b"awk: out of memory".to_vec()
}

#[derive(Default)]
struct Slot {
    scalar: Option<Value>,
    array: Option<usize>,
}

struct Frame {
    ret: usize,
    stack: usize,
    locals: usize,
    iters: usize,
    arrays: Vec<usize>,
}

struct Iter {
    keys: Vec<Text>,
    at: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Begin,
    Main,
    End,
}

#[derive(Default)]
struct RecordJoin {
    planned: usize,
    length: usize,
    body: Option<Vec<u8>>,
    field: usize,
    separator: bool,
    offset: usize,
}

/// The current record: `$0` as read or rebuilt, and its fields, split
/// with the FS and RS in force when it arrived.
#[derive(Default)]
struct Record {
    text: Text,
    ranges: Buffer<Range<usize>>,
    fields: Buffer<Text>,
    selected: Option<(usize, Text)>,
    view: Option<View>,
    empty: Text,
    owned: bool,
    split: bool,
    split_started: bool,
    scan: SplitScan,
    owning: Option<usize>,
    stale: bool,
    joining: Option<RecordJoin>,
    fs: Text,
    paragraph: bool,
}

impl Record {
    fn set(&mut self, text: Text, fs: Text, paragraph: bool) {
        self.text = text;
        self.selected = None;
        self.view = None;
        self.fs = fs;
        self.paragraph = paragraph;
        self.split = false;
        self.split_started = false;
        self.owning = None;
        self.owned = false;
        self.stale = false;
        self.joining = None;
    }

    fn prepare_split(&mut self, regexes: &mut Regexes, work: &mut u64) -> Result<bool, Vec<u8>> {
        if self.split {
            return Ok(true);
        }
        if !self.split_started {
            while !self.ranges.is_empty() {
                if *work == 0 {
                    return Ok(false);
                }
                self.ranges.pop();
                *work = work.saturating_sub(16);
            }
            self.scan = SplitScan::default();
            self.split_started = true;
        }
        loop {
            if !self.ranges.reserve(1, work) || *work == 0 {
                return Ok(false);
            }
            match self
                .scan
                .next(&self.text, &self.fs, self.paragraph, regexes, work)?
            {
                SearchStep::Paused => return Ok(false),
                SearchStep::Done(Some(range)) => {
                    self.ranges.values.push(range.0..range.1);
                    *work = work.saturating_sub(8);
                }
                SearchStep::Done(None) => {
                    self.split = true;
                    return Ok(true);
                }
            }
        }
    }

    fn nf(&self) -> usize {
        debug_assert!(self.split);
        if self.owned {
            self.fields.len()
        } else {
            self.ranges.len()
        }
    }

    fn prepare_field(&mut self, index: usize, work: &mut u64) -> bool {
        if self.owned
            || self
                .selected
                .as_ref()
                .is_some_and(|(selected, _)| *selected == index)
        {
            return true;
        }
        let view = self
            .view
            .get_or_insert_with(|| View::new(self.text.clone(), self.ranges[index - 1].clone()));
        match view.step(work) {
            SearchStep::Paused => false,
            SearchStep::Done(text) => {
                self.selected = Some((index, text));
                self.view = None;
                true
            }
        }
    }

    /// Field `index`, from 1, after preparation.
    fn field(&self, index: usize) -> Text {
        if self.owned {
            self.fields[index - 1].clone()
        } else {
            let (selected, text) = self.selected.as_ref().expect("field prepared");
            assert_eq!(*selected, index);
            text.clone()
        }
    }

    fn prepare_owned(&mut self, regexes: &mut Regexes, work: &mut u64) -> Result<bool, Vec<u8>> {
        if !self.prepare_split(regexes, work)? {
            return Ok(false);
        }
        if self.owned {
            return Ok(true);
        }
        if self.owning.is_none() {
            while !self.fields.is_empty() {
                if *work == 0 {
                    return Ok(false);
                }
                self.fields.pop();
                *work = work.saturating_sub(16);
            }
            if !self.fields.reserve(self.ranges.len(), work) {
                return Ok(false);
            }
            self.owning = Some(0);
        }
        let index = self.owning.as_mut().unwrap();
        while *index < self.ranges.len() {
            if *work == 0 {
                return Ok(false);
            }
            let text = if let Some((selected, text)) = &self.selected
                && *selected == *index + 1
            {
                text.clone()
            } else {
                let view = self.view.get_or_insert_with(|| {
                    View::new(self.text.clone(), self.ranges[*index].clone())
                });
                match view.step(work) {
                    SearchStep::Paused => return Ok(false),
                    SearchStep::Done(text) => {
                        self.view = None;
                        text
                    }
                }
            };
            self.fields.values.push(text);
            *index += 1;
            *work = work.saturating_sub(16);
        }
        self.owning = None;
        self.owned = true;
        Ok(true)
    }

    fn prepare_text(&mut self, ofs: &[u8], work: &mut u64) -> Result<bool, Vec<u8>> {
        if !self.stale {
            return Ok(true);
        }
        let join = self.joining.get_or_insert_with(RecordJoin::default);
        if join.body.is_none() {
            while join.planned < self.fields.len() {
                if *work == 0 {
                    return Ok(false);
                }
                let len = self.fields[join.planned].len();
                join.length = join.length.saturating_add(len);
                if join.planned > 0 {
                    join.length = join.length.saturating_add(ofs.len());
                }
                if join.length > MAX_LEN {
                    return Err(no_memory());
                }
                join.planned += 1;
                *work = work.saturating_sub(8);
            }
            join.body = Some(Vec::with_capacity(join.length));
        }
        let body = join.body.as_mut().unwrap();
        while join.field < self.fields.len() {
            if *work == 0 {
                return Ok(false);
            }
            let piece = if join.separator {
                ofs
            } else {
                &self.fields[join.field]
            };
            let count =
                (piece.len() - join.offset).min(usize::try_from(*work).unwrap_or(usize::MAX));
            body.extend_from_slice(&piece[join.offset..join.offset + count]);
            join.offset += count;
            *work -= count as u64;
            if join.offset == piece.len() {
                join.offset = 0;
                if join.separator {
                    join.separator = false;
                } else {
                    join.field += 1;
                    join.separator = join.field < self.fields.len();
                }
                *work = work.saturating_sub(1);
            }
        }
        self.text = self.joining.take().unwrap().body.unwrap().into();
        self.stale = false;
        Ok(true)
    }

    fn text(&self) -> &Text {
        debug_assert!(!self.stale);
        &self.text
    }
}

#[derive(Default)]
struct Arrays {
    items: Vec<Ordered<Value>>,
    free: Vec<usize>,
}

impl Arrays {
    fn alloc(&mut self) -> usize {
        self.free.pop().unwrap_or_else(|| {
            self.items.push(Ordered::default());
            self.items.len() - 1
        })
    }

    fn release(&mut self, id: usize) -> Retired<Value> {
        self.free.push(id);
        self.items[id].retire()
    }
}

fn special(globals: &[Slot], index: u32) -> Cow<'_, [u8]> {
    match &globals[index as usize].scalar {
        Some(value) => value.default_text(),
        None => Cow::Borrowed(&[]),
    }
}

fn num(truth: bool) -> Value {
    Value::Num(if truth { 1.0 } else { 0.0 })
}

type Step = Result<(), Vec<u8>>;

enum MatchTarget {
    Test(bool),
    Function,
}

enum WriteTarget {
    Nf(usize),
    Field(usize, Text),
}

struct FieldSplit {
    subject: Text,
    separator: Text,
    scan: SplitScan,
    array: usize,
    retired: Retired<Value>,
    count: usize,
    view: Option<View>,
}

enum SubTarget {
    Var(Var),
    Field(i128),
    Element(usize, Text),
    Invalid,
}

enum OutputTarget {
    Value(Vec<u8>),
    Print(Option<(RedirKind, Text)>),
}

struct FormatTask {
    formatter: Formatter,
    target: OutputTarget,
}

struct OutputTask {
    output: Output,
    target: OutputTarget,
}

struct Scope {
    stack: usize,
    locals: usize,
    iters: usize,
    frames: usize,
    array: Option<Retired<Value>>,
    returned: Option<Value>,
}

struct Snapshot {
    array: usize,
    next: u64,
    keys: Vec<Text>,
}

enum CoerceTarget {
    Stack(usize),
    Push,
    Length,
    Field {
        index: i128,
        returned: Value,
    },
    Sub {
        pattern: Text,
        template: Text,
        global: bool,
        target: SubTarget,
    },
    Operand,
}

struct Coercion {
    text: NumberText,
    target: CoerceTarget,
}

enum Pending {
    Coerce(Box<Coercion>),
    Store {
        var: Var,
        value: Value,
        scan: Option<NumberScan>,
    },
    Compare {
        left: Text,
        right: Text,
        at: usize,
        cmp: Cmp,
    },
    Scope(Scope),
    Retire(Retired<Value>),
    Snapshot(Snapshot),
    Format(Box<FormatTask>),
    Print {
        print: Print,
        target: OutputTarget,
    },
    Output(OutputTask),
    Index(IndexSearch),
    String(StringWork),
    Sub {
        pattern: Text,
        substitution: Substitution,
        target: SubTarget,
    },
    Split(Box<FieldSplit>),
    Write(WriteTarget),
    MatchRecord(usize),
    Match {
        pattern: Text,
        subject: Text,
        target: MatchTarget,
    },
}

struct Retirement {
    globals: std::collections::hash_map::IntoIter<Vec<u8>, u32>,
    array: Option<Retired<Value>>,
    io: super::io::Retirement,
}

pub(super) struct Machine {
    code: Code,
    pending: Option<Pending>,
    retirement: Option<Retirement>,
    number: Option<NumberScan>,
    pc: usize,
    stage: u8,
    stack: Vec<Value>,
    frames: Vec<Frame>,
    locals: Vec<Slot>,
    iters: Vec<Iter>,
    globals: Vec<Slot>,
    arrays: Arrays,
    phase: Phase,
    record: Record,
    nr: f64,
    fnr: f64,
    ranges: Vec<bool>,
    regexes: Regexes,
    rand_state: u32,
    seed: i128,
    exit_code: i128,
    arg_index: usize,
    read_operand: bool,
    main_name: Vec<u8>,
    operand: Option<Text>,
    scratch: f64,
    pub(super) status: i32,
    pub(super) done: bool,
    pub(super) io: Io,
}

pub(super) struct Setup {
    pub(super) operands: Vec<Vec<u8>>,
    pub(super) assignments: Vec<(Vec<u8>, Vec<u8>)>,
    pub(super) fs: Option<Vec<u8>>,
    pub(super) environ: Vec<(Vec<u8>, Vec<u8>)>,
}

impl Machine {
    pub(super) fn new(code: Code, setup: Setup) -> Machine {
        let mut machine = Machine {
            globals: (0..code.global_count).map(|_| Slot::default()).collect(),
            ranges: vec![false; code.ranges],
            code,
            pending: None,
            retirement: None,
            number: None,
            pc: 0,
            stage: 0,
            stack: Vec::new(),
            frames: Vec::new(),
            locals: Vec::new(),
            iters: Vec::new(),
            arrays: Arrays::default(),
            phase: Phase::Begin,
            record: Record::default(),
            nr: 0.0,
            fnr: 0.0,
            regexes: Regexes::default(),
            rand_state: 0,
            seed: 0,
            exit_code: 0,
            arg_index: 0,
            read_operand: false,
            main_name: Vec::new(),
            operand: None,
            scratch: 0.0,
            status: 0,
            done: false,
            io: Io::default(),
        };
        let defaults: [&[u8]; 10] = [
            b" ", b" ", b"\n", b"\n", b"\x1c", b"%.6g", b"%.6g", b"", b"0", b"-1",
        ];
        for (index, value) in defaults.iter().enumerate() {
            machine.globals[index].scalar = Some(string(value.to_vec()));
        }
        for (name, value) in setup.assignments {
            if let Some(&index) = machine.code.globals.get(&name) {
                machine.globals[index as usize].scalar = Some(strnum(value));
            }
        }
        let argv = machine.array(Arr::Global(ARGV));
        machine.arrays.items[argv].insert(b"0".to_vec(), string(b"awk".to_vec()));
        for (position, operand) in setup.operands.iter().enumerate() {
            let key = (position + 1).to_string().into_bytes();
            machine.arrays.items[argv].insert(key, strnum(operand.clone()));
        }
        machine.globals[ARGC as usize].scalar = Some(Value::Num(setup.operands.len() as f64 + 1.0));
        let environ = machine.array(Arr::Global(ENVIRON));
        for (name, value) in setup.environ {
            machine.arrays.items[environ].insert(name, strnum(value));
        }
        if let Some(fs) = setup.fs {
            machine.globals[FS as usize].scalar = Some(string(fs));
        }
        machine
    }

    pub(super) fn retire(&mut self, budget: usize) -> bool {
        let mut work = budget as u64;
        let retirement = self.retirement.get_or_insert_with(|| Retirement {
            globals: std::mem::take(&mut self.code.globals).into_iter(),
            array: None,
            io: self.io.retire(),
        });
        if let Some(pending) = &mut self.pending {
            let done = match pending {
                Pending::Format(task) => task.formatter.retire(&mut work),
                Pending::Print { print, .. } => print.retire(&mut work),
                Pending::Output(task) => task.output.retire(&mut work),
                Pending::Split(split) => split.retired.step(&mut work),
                Pending::Retire(array) => array.step(&mut work),
                Pending::Scope(scope) => scope
                    .array
                    .as_mut()
                    .is_none_or(|array| array.step(&mut work)),
                Pending::Snapshot(snapshot) => {
                    while work > 0 && snapshot.keys.pop().is_some() {
                        work = work.saturating_sub(16);
                    }
                    snapshot.keys.is_empty()
                }
                _ => true,
            };
            if !done {
                return false;
            }
            self.pending = None;
        }
        while work > 0 {
            work = work.saturating_sub(16);
            if self.stack.pop().is_some()
                || self.locals.pop().is_some()
                || self.globals.pop().is_some()
                || self.record.fields.pop().is_some()
                || self.record.ranges.pop().is_some()
                || self.code.strings.pop().is_some()
                || self.code.functions.pop().is_some()
                || retirement.globals.next().is_some()
                || self.frames.pop().is_some()
                || self.io.requests.pop_front().is_some()
            {
                continue;
            }
            if let Some(iter) = self.iters.last_mut() {
                if iter.keys.pop().is_none() {
                    self.iters.pop();
                }
                continue;
            }
            if let Some(array) = &mut retirement.array {
                if !array.step(&mut work) {
                    return false;
                }
                retirement.array = None;
            }
            if let Some(mut array) = self.arrays.items.pop() {
                retirement.array = Some(array.retire());
                continue;
            }
            return retirement.io.step(&mut work);
        }
        false
    }

    pub(super) fn reporting(&self) -> bool {
        self.io.reporting()
            || match &self.pending {
                Some(Pending::Format(task)) => task.formatter.failed(),
                Some(Pending::Print { print, .. }) => print.failed(),
                _ => false,
            }
    }

    /// Run up to `budget` steps, stopping early to wait on the host, once
    /// a window of output is ready, or at the end.
    pub(super) fn run(&mut self, budget: usize) {
        if let Some(message) = self.io.fatal.take() {
            self.salvage(message);
        }
        let mut work = budget as u64;
        self.io.report(&mut work);
        while !self.done
            && self.io.idle()
            && work > 0
            && self.io.out.len() < LIMIT
            && self.io.err.len() < LIMIT
        {
            let result = if self.pending.is_some() {
                self.resume(&mut work)
            } else {
                match self.prepare(&mut work) {
                    Ok(false) => break,
                    Err(message) => Err(message),
                    Ok(true) => {
                        if work == 0 {
                            break;
                        }
                        work -= 1;
                        self.step(&mut work)
                    }
                }
            };
            if let Err(message) = result {
                self.salvage(message);
                return;
            }
        }
    }

    fn prepare(&mut self, work: &mut u64) -> Result<bool, Vec<u8>> {
        let op = self.code.ops[self.pc];
        let count = match op {
            Op::Arith(_) | Op::ArithAssign(_) | Op::Atan2 | Op::Compare(_) | Op::Substr(true) => 2,
            Op::LoadField
            | Op::StoreField
            | Op::IncDecField(..)
            | Op::SubField(_)
            | Op::Neg
            | Op::ToNum
            | Op::Not
            | Op::Truth
            | Op::JumpIfFalse(_)
            | Op::RangeEnd(..)
            | Op::RangeStart(..)
            | Op::Math(_)
            | Op::Exit(true)
            | Op::Srand(true)
            | Op::Substr(false)
            | Op::Store(Var::Nf | Var::Nr | Var::Fnr) => 1,
            _ => 0,
        };
        for value in self
            .stack
            .iter()
            .rev()
            .skip(usize::from(matches!(op, Op::StoreField)))
            .take(count)
        {
            if matches!(value, Value::Str(_))
                && matches!(
                    op,
                    Op::Not
                        | Op::Truth
                        | Op::JumpIfFalse(_)
                        | Op::RangeEnd(..)
                        | Op::RangeStart(..)
                        | Op::Compare(_)
                )
            {
                continue;
            }
            if !value.prepare_number(&mut self.number, work) {
                return Ok(false);
            }
        }
        let split = match self.code.ops[self.pc] {
            Op::Load(Var::Nf)
            | Op::IncDec(Var::Nf, ..)
            | Op::LengthVar(Var::Nf)
            | Op::Arg(Var::Nf)
            | Op::SubVar(Var::Nf, _) => true,
            Op::LoadField | Op::IncDecField(..) | Op::SubField(_) => self
                .stack
                .last()
                .is_some_and(|value| to_int(value.num()) > 0),
            _ => false,
        };
        if split && !self.record.prepare_split(&mut self.regexes, work)? {
            return Ok(false);
        }
        let text = match self.code.ops[self.pc] {
            Op::MatchRecord(_) | Op::LengthRecord => true,
            Op::LoadField | Op::IncDecField(..) | Op::SubField(_) => self
                .stack
                .last()
                .is_some_and(|value| to_int(value.num()) == 0),
            _ => false,
        };
        if text
            && !self
                .record
                .prepare_text(&special(&self.globals, OFS), work)?
        {
            return Ok(false);
        }
        if matches!(op, Op::LoadField | Op::IncDecField(..) | Op::SubField(_)) {
            let index = self.stack.last().map_or(0, |value| to_int(value.num()));
            if index > 0
                && index <= self.record.nf() as i128
                && !self.record.prepare_field(index as usize, work)
            {
                return Ok(false);
            }
        }
        let at = |offset| self.stack.len().checked_sub(offset + 1);
        let positions = match op {
            Op::LoadElem(_)
            | Op::IncDecElem(..)
            | Op::In(_)
            | Op::Delete(_)
            | Op::Case(_)
            | Op::Length
            | Op::Close
            | Op::Fflush(true)
            | Op::System
            | Op::Getline(GetlineKind::File | GetlineKind::Command, _) => [at(0), None, None],
            Op::StoreElem(_) => [at(1), None, None],
            Op::Concat
            | Op::Match(_)
            | Op::MatchFn
            | Op::Index
            | Op::Split(_, true)
            | Op::SubVar(..) => [at(0), at(1), None],
            Op::SubField(_) | Op::SubValue(_) => [at(1), at(2), None],
            Op::SubElem(..) => [at(0), at(1), at(2)],
            Op::Split(_, false) => [at(0), None, None],
            Op::Substr(length) => [at(1 + usize::from(length)), None, None],
            Op::Sprintf(count) => [self.stack.len().checked_sub(count as usize), None, None],
            Op::Print(formatted, count, redirect) => [
                redirect.and_then(|_| at(0)),
                if formatted {
                    self.stack
                        .len()
                        .checked_sub(count as usize + usize::from(redirect.is_some()))
                } else {
                    None
                },
                None,
            ],
            Op::Compare(_) if !self.stack.iter().rev().take(2).all(Value::numeric) => {
                [at(0), at(1), None]
            }
            _ => [None; 3],
        };
        for index in positions.into_iter().flatten() {
            if matches!(self.stack.get(index), Some(Value::Num(_))) {
                let value = std::mem::replace(&mut self.stack[index], Value::Uninit);
                self.coerce(value, CoerceTarget::Stack(index), work)?;
                if self.pending.is_some() || *work == 0 {
                    return Ok(false);
                }
            }
        }
        let value = match op {
            Op::IncDec(var, ..) => Some(self.load(var)?),
            Op::IncDecField(..) => {
                let index = self.stack.last().map_or(0, |value| to_int(value.num()));
                Some(self.get_field(index)?)
            }
            Op::IncDecElem(arr, ..) => {
                let key = self.top_text();
                let id = self.array(arr);
                self.arrays.items[id].get(&key).cloned()
            }
            Op::NextMain | Op::EnterMain | Op::Getline(GetlineKind::Plain, _) => {
                Some(self.load(Var::Global(ARGC))?)
            }
            _ => None,
        };
        Ok(value.is_none_or(|value| value.prepare_number(&mut self.number, work)))
    }

    fn resume(&mut self, work: &mut u64) -> Step {
        let pending = self.pending.take().unwrap();
        match pending {
            Pending::Coerce(mut task) => match task.text.step(work)? {
                SearchStep::Paused => self.pending = Some(Pending::Coerce(task)),
                SearchStep::Done(text) => self.finish_text(text, task.target)?,
            },
            Pending::Store {
                var,
                value,
                mut scan,
            } => {
                if value.prepare_number(&mut scan, work) {
                    self.store(var, value)?;
                } else {
                    self.pending = Some(Pending::Store { var, value, scan });
                }
            }
            Pending::Compare {
                left,
                right,
                mut at,
                cmp,
            } => {
                let end = left.len().min(right.len());
                let count = (end - at).min(*work as usize);
                let order = left[at..at + count].cmp(&right[at..at + count]);
                at += count;
                *work = work.saturating_sub(count as u64);
                if !order.is_eq() {
                    self.stack.push(num(comparison(cmp, order)));
                } else if at == end {
                    self.stack
                        .push(num(comparison(cmp, left.len().cmp(&right.len()))));
                } else {
                    self.pending = Some(Pending::Compare {
                        left,
                        right,
                        at,
                        cmp,
                    });
                }
            }
            Pending::Retire(mut array) => {
                if !array.step(work) {
                    self.pending = Some(Pending::Retire(array));
                }
            }
            Pending::Scope(mut scope) => {
                if self.retire_scope(&mut scope, work) {
                    if let Some(value) = scope.returned {
                        self.stack.push(value);
                    }
                } else {
                    self.pending = Some(Pending::Scope(scope));
                }
            }
            Pending::Snapshot(mut snapshot) => {
                while *work > 0 {
                    *work = work.saturating_sub(16);
                    let Some(key) = self.arrays.items[snapshot.array].next_key(&mut snapshot.next)
                    else {
                        self.iters.push(Iter {
                            keys: snapshot.keys,
                            at: 0,
                        });
                        return Ok(());
                    };
                    snapshot.keys.push(key);
                }
                self.pending = Some(Pending::Snapshot(snapshot));
            }
            Pending::Format(mut task) => match task.formatter.step(work)? {
                SearchStep::Paused => self.pending = Some(Pending::Format(task)),
                SearchStep::Done(output) => {
                    if let OutputTarget::Value(bytes) = &mut task.target {
                        *bytes = Vec::with_capacity(output.len());
                    }
                    self.pending = Some(Pending::Output(OutputTask {
                        output,
                        target: task.target,
                    }));
                }
            },
            Pending::Print {
                mut print,
                mut target,
            } => match print.step(work)? {
                SearchStep::Paused => self.pending = Some(Pending::Print { print, target }),
                SearchStep::Done(output) => {
                    if let OutputTarget::Value(bytes) = &mut target {
                        *bytes = Vec::with_capacity(output.len());
                    }
                    self.pending = Some(Pending::Output(OutputTask { output, target }));
                }
            },
            Pending::Output(mut task) => {
                let done = match &mut task.target {
                    OutputTarget::Value(bytes) => task.output.copy(bytes, work),
                    OutputTarget::Print(target) => {
                        let mut bytes = Vec::with_capacity(task.output.len().min(*work as usize));
                        let done = task.output.copy(&mut bytes, work);
                        self.emit(&bytes, target.as_ref());
                        done
                    }
                };
                if done {
                    if let OutputTarget::Value(bytes) = task.target {
                        self.stack.push(string(bytes));
                    }
                } else {
                    self.pending = Some(Pending::Output(task));
                }
            }
            Pending::Index(mut search) => match search.step(work) {
                SearchStep::Paused => self.pending = Some(Pending::Index(search)),
                SearchStep::Done(index) => self.stack.push(Value::Num(index as f64)),
            },
            Pending::String(mut text) => match text.step(work) {
                SearchStep::Paused => self.pending = Some(Pending::String(text)),
                SearchStep::Done(text) => self.stack.push(string(text)),
            },
            Pending::Sub {
                pattern,
                mut substitution,
                target,
            } => {
                match substitution
                    .step(self.regexes.get(&pattern)?, work)
                    .map_err(|()| no_memory())?
                {
                    SearchStep::Paused => {
                        self.pending = Some(Pending::Sub {
                            pattern,
                            substitution,
                            target,
                        })
                    }
                    SearchStep::Done((count, result)) => {
                        self.stack.push(Value::Num(count as f64));
                        if count > 0 {
                            match target {
                                SubTarget::Var(var) => self.store(var, string(result))?,
                                SubTarget::Field(index) => self.set_field(index, result.into())?,
                                SubTarget::Element(id, key) => {
                                    self.arrays.items[id].insert(key, string(result))
                                }
                                SubTarget::Invalid => {
                                    return Err(b"awk: assignment to a non-lvalue".to_vec());
                                }
                            }
                        }
                    }
                }
            }
            Pending::Split(mut split) => {
                if !split.retired.step(work) {
                    self.pending = Some(Pending::Split(split));
                    return Ok(());
                }
                loop {
                    if let Some(view) = &mut split.view {
                        match view.step(work) {
                            SearchStep::Paused => {
                                self.pending = Some(Pending::Split(split));
                                return Ok(());
                            }
                            SearchStep::Done(text) => {
                                split.count += 1;
                                self.arrays.items[split.array]
                                    .insert(split.count.to_string().into_bytes(), strnum(text));
                                split.view = None;
                                *work = work.saturating_sub(16);
                            }
                        }
                    }
                    match split.scan.next(
                        &split.subject,
                        &split.separator,
                        false,
                        &mut self.regexes,
                        work,
                    )? {
                        SearchStep::Paused => {
                            self.pending = Some(Pending::Split(split));
                            return Ok(());
                        }
                        SearchStep::Done(None) => {
                            self.stack.push(Value::Num(split.count as f64));
                            break;
                        }
                        SearchStep::Done(Some((start, end))) => {
                            split.view = Some(View::new(split.subject.clone(), start..end));
                        }
                    }
                }
            }
            Pending::Write(target) => {
                let count = match &target {
                    WriteTarget::Nf(count) | WriteTarget::Field(count, _) => *count,
                };
                if !self.record.prepare_owned(&mut self.regexes, work)? {
                    self.pending = Some(Pending::Write(target));
                    return Ok(());
                }
                if !self
                    .record
                    .fields
                    .reserve(count.saturating_sub(self.record.fields.len()), work)
                {
                    self.pending = Some(Pending::Write(target));
                    return Ok(());
                }
                while self.record.fields.len() < count {
                    if *work == 0 {
                        self.pending = Some(Pending::Write(target));
                        return Ok(());
                    }
                    self.record.fields.values.push(Text::default());
                    *work = work.saturating_sub(16);
                }
                match target {
                    WriteTarget::Nf(count) => {
                        while self.record.fields.len() > count {
                            if *work == 0 {
                                self.pending = Some(Pending::Write(WriteTarget::Nf(count)));
                                return Ok(());
                            }
                            self.record.fields.pop();
                            *work = work.saturating_sub(16);
                        }
                    }
                    WriteTarget::Field(index, text) => self.record.fields[index - 1] = text,
                }
                self.record.stale = true;
            }
            Pending::MatchRecord(at) => {
                let regex = self.regexes.get(&self.code.strings[at])?;
                match regex.find(&self.record.text, 0, work) {
                    SearchStep::Paused => self.pending = Some(Pending::MatchRecord(at)),
                    SearchStep::Done(found) => self.stack.push(num(found.is_some())),
                }
            }
            Pending::Match {
                pattern,
                subject,
                target,
            } => {
                let regex = self.regexes.get(&pattern)?;
                match regex.find(&subject, 0, work) {
                    SearchStep::Paused => {
                        self.pending = Some(Pending::Match {
                            pattern,
                            subject,
                            target,
                        })
                    }
                    SearchStep::Done(found) => match target {
                        MatchTarget::Test(negated) => {
                            self.stack.push(num(found.is_some() != negated))
                        }
                        MatchTarget::Function => {
                            let (start, length) = found.map_or((0.0, -1.0), |(from, to)| {
                                (from as f64 + 1.0, (to - from) as f64)
                            });
                            self.globals[RSTART as usize].scalar = Some(Value::Num(start));
                            self.globals[RLENGTH as usize].scalar = Some(Value::Num(length));
                            self.stack.push(Value::Num(start));
                        }
                    },
                }
            }
        }
        Ok(())
    }

    /// End the run on a fatal error: what was printed stays, and files
    /// are written out, but no pipe's command runs (mawk's exit flushes
    /// its buffers and nothing else).
    fn salvage(&mut self, message: Vec<u8>) {
        self.io.requests.clear();
        self.io.diagnose(message);
        self.status = 2;
        self.io.salvaging = true;
        self.io.send_files();
        if !self.io.files_out.is_empty() {
            self.io.push(Request::Flush { path: None });
        }
        self.io.release();
        self.done = true;
    }

    fn wait(&mut self, stage: u8) -> Step {
        self.stage = stage;
        self.pc -= 1;
        Ok(())
    }

    fn coerce(&mut self, value: Value, target: CoerceTarget, work: &mut u64) -> Step {
        if let Value::Num(value) = value {
            let mut text = NumberText::new(value, self.special_text(CONVFMT));
            match text.step(work)? {
                SearchStep::Paused => {
                    self.pending = Some(Pending::Coerce(Box::new(Coercion { text, target })))
                }
                SearchStep::Done(text) => self.finish_text(text, target)?,
            }
        } else {
            self.finish_text(value.into_text(), target)?;
        }
        Ok(())
    }

    fn finish_text(&mut self, text: Text, target: CoerceTarget) -> Step {
        match target {
            CoerceTarget::Stack(index) => self.stack[index] = string(text),
            CoerceTarget::Push => self.stack.push(string(text)),
            CoerceTarget::Length => self.stack.push(Value::Num(text.len() as f64)),
            CoerceTarget::Field { index, returned } => {
                self.set_field(index, text)?;
                self.stack.push(returned);
            }
            CoerceTarget::Sub {
                pattern,
                template,
                global,
                target,
            } => {
                self.regexes.get(&pattern)?;
                self.pending = Some(Pending::Sub {
                    pattern,
                    substitution: Substitution::new(text, template, global),
                    target,
                });
            }
            CoerceTarget::Operand => self.operand = Some(text),
        }
        Ok(())
    }

    fn special_text(&self, index: u32) -> Text {
        match self.globals[index as usize]
            .scalar
            .clone()
            .unwrap_or(Value::Uninit)
        {
            Value::Num(value) => default_number(value).into(),
            other => other.into_text(),
        }
    }

    fn pop(&mut self) -> Value {
        self.stack.pop().unwrap_or(Value::Uninit)
    }

    fn pop_text(&mut self) -> Text {
        let value = self.pop();
        value.into_text()
    }

    fn top_text(&self) -> Text {
        self.stack
            .last()
            .cloned()
            .unwrap_or(Value::Uninit)
            .into_text()
    }

    fn slot(&mut self, var: Var) -> Option<&mut Slot> {
        match var {
            Var::Global(index) => Some(&mut self.globals[index as usize]),
            Var::Local(index) => {
                let base = self.frames.last().map_or(0, |frame| frame.locals);
                Some(&mut self.locals[base + index as usize])
            }
            _ => None,
        }
    }

    fn load(&mut self, var: Var) -> Result<Value, Vec<u8>> {
        Ok(match var {
            Var::Nf => Value::Num(self.record.nf() as f64),
            Var::Nr => Value::Num(self.nr),
            Var::Fnr => Value::Num(self.fnr),
            _ => self
                .slot(var)
                .and_then(|slot| slot.scalar.clone())
                .unwrap_or(Value::Uninit),
        })
    }

    fn store(&mut self, var: Var, value: Value) -> Step {
        if matches!(var, Var::Nf | Var::Nr | Var::Fnr) {
            let mut scan = None;
            if !value.prepare_number(&mut scan, &mut 0) {
                self.pending = Some(Pending::Store { var, value, scan });
                return Ok(());
            }
        }
        match var {
            Var::Nf => {
                let count = usize::try_from(to_int(value.num()).max(0)).unwrap_or(usize::MAX);
                if count > MAX_FIELDS {
                    return Err(no_memory());
                }
                self.pending = Some(Pending::Write(WriteTarget::Nf(count)));
            }
            Var::Nr => self.nr = to_int(value.num()) as f64,
            Var::Fnr => self.fnr = to_int(value.num()) as f64,
            _ => {
                if let Some(slot) = self.slot(var) {
                    slot.scalar = Some(value);
                }
            }
        }
        Ok(())
    }

    fn array(&mut self, arr: Arr) -> usize {
        let arrays = &mut self.arrays;
        match arr {
            Arr::Global(index) => *self.globals[index as usize]
                .array
                .get_or_insert_with(|| arrays.alloc()),
            Arr::Local(index) => {
                let frame = self.frames.last_mut();
                let base = frame.as_ref().map_or(0, |frame| frame.locals);
                let slot = &mut self.locals[base + index as usize];
                *slot.array.get_or_insert_with(|| {
                    let id = arrays.alloc();
                    if let Some(frame) = frame {
                        frame.arrays.push(id);
                    }
                    id
                })
            }
        }
    }

    fn set_record(&mut self, text: Text) {
        let fs = self.special_text(FS);
        let paragraph = special(&self.globals, RS).is_empty();
        self.record.set(text, fs, paragraph);
    }

    fn get_field(&mut self, index: i128) -> Result<Value, Vec<u8>> {
        if index == 0 {
            return Ok(strnum(self.record.text().clone()));
        }
        if index < 0 {
            return Err(format!("awk: trying to access field {index}").into_bytes());
        }
        let nf = self.record.nf();
        let index = usize::try_from(index).unwrap_or(usize::MAX);
        Ok(if index > nf {
            string(self.record.empty.clone())
        } else {
            strnum(self.record.field(index))
        })
    }

    fn set_field(&mut self, index: i128, text: Text) -> Step {
        if index == 0 {
            self.set_record(text);
            return Ok(());
        }
        if index < 0 {
            return Err(format!("awk: trying to access field {index}").into_bytes());
        }
        let index = usize::try_from(index).unwrap_or(usize::MAX);
        if index > MAX_FIELDS {
            return Err(no_memory());
        }
        self.pending = Some(Pending::Write(WriteTarget::Field(index, text)));
        Ok(())
    }

    fn record_text(&mut self) -> Result<&[u8], Vec<u8>> {
        Ok(self.record.text())
    }

    fn retire_scope(&mut self, scope: &mut Scope, work: &mut u64) -> bool {
        while *work > 0 {
            if let Some(array) = &mut scope.array {
                if !array.step(work) {
                    return false;
                }
                scope.array = None;
                continue;
            }
            *work = work.saturating_sub(16);
            if self.stack.len() > scope.stack {
                self.stack.pop();
            } else if self.locals.len() > scope.locals {
                self.locals.pop();
            } else if self.iters.len() > scope.iters {
                if self.iters.last_mut().unwrap().keys.pop().is_none() {
                    self.iters.pop();
                }
            } else if self.frames.len() > scope.frames {
                if let Some(id) = self.frames.last_mut().unwrap().arrays.pop() {
                    scope.array = Some(self.arrays.release(id));
                } else {
                    self.frames.pop();
                }
            } else {
                return true;
            }
        }
        false
    }

    /// Unwind every call and loop, as `next` and `exit` do.
    fn unwind(&mut self) {
        self.pending = Some(Pending::Scope(Scope {
            stack: 0,
            locals: 0,
            iters: 0,
            frames: 0,
            array: None,
            returned: None,
        }));
        self.stage = 0;
    }

    fn step(&mut self, work: &mut u64) -> Step {
        let op = self.code.ops[self.pc];
        self.pc += 1;
        match op {
            Op::Num(value) => self.stack.push(Value::Num(value)),
            Op::Str(at) => {
                let text = self.code.strings[at as usize].clone();
                self.stack.push(string(text));
            }
            Op::Uninit => self.stack.push(Value::Uninit),
            Op::MatchRecord(at) => {
                self.record_text()?;
                self.regexes.get(&self.code.strings[at as usize])?;
                self.pending = Some(Pending::MatchRecord(at as usize));
            }
            Op::Load(var) => {
                let value = self.load(var)?;
                self.stack.push(value);
            }
            Op::Store(var) => {
                let value = self.pop();
                self.store(var, value.clone())?;
                self.stack.push(value);
            }
            Op::IncDec(var, delta, pre) => {
                let current = self.load(var)?.num();
                self.store(var, Value::Num(current + delta))?;
                self.stack
                    .push(Value::Num(if pre { current + delta } else { current }));
            }
            Op::LoadField => {
                let index = to_int(self.pop().num());
                let value = self.get_field(index)?;
                self.stack.push(value);
            }
            Op::StoreField => {
                let value = self.pop();
                let index = to_int(self.pop().num());
                self.coerce(
                    value.clone(),
                    CoerceTarget::Field {
                        index,
                        returned: value,
                    },
                    work,
                )?;
            }
            Op::IncDecField(delta, pre) => {
                let index = to_int(self.pop().num());
                let current = self.get_field(index)?.num();
                self.coerce(
                    Value::Num(current + delta),
                    CoerceTarget::Field {
                        index,
                        returned: Value::Num(if pre { current + delta } else { current }),
                    },
                    work,
                )?;
            }
            Op::Key(count) => {
                let count = count as usize;
                let mut parts = self.stack.split_off(self.stack.len() - count);
                if count == 1 {
                    self.coerce(parts.pop().unwrap(), CoerceTarget::Push, work)?;
                } else {
                    self.pending = Some(Pending::Print {
                        print: Print::new(
                            parts,
                            self.special_text(CONVFMT),
                            self.special_text(SUBSEP),
                            Text::default(),
                        ),
                        target: OutputTarget::Value(Vec::new()),
                    });
                }
            }
            Op::LoadElem(arr) => {
                let key = self.pop_text();
                let id = self.array(arr);
                let value = self.arrays.items[id].entry(&key, || Value::Uninit).clone();
                self.stack.push(value);
            }
            Op::StoreElem(arr) => {
                let value = self.pop();
                let key = self.pop_text();
                let id = self.array(arr);
                self.arrays.items[id].insert(key, value.clone());
                self.stack.push(value);
            }
            Op::IncDecElem(arr, delta, pre) => {
                let key = self.pop_text();
                let id = self.array(arr);
                let slot = self.arrays.items[id].entry(&key, || Value::Uninit);
                let current = slot.num();
                *slot = Value::Num(current + delta);
                self.stack
                    .push(Value::Num(if pre { current + delta } else { current }));
            }
            Op::In(arr) => {
                let key = self.pop_text();
                let id = self.array(arr);
                let found = self.arrays.items[id].contains(&key);
                self.stack.push(num(found));
            }
            Op::Delete(arr) => {
                let key = self.pop_text();
                let id = self.array(arr);
                self.arrays.items[id].remove(&key);
            }
            Op::DeleteAll(arr) => {
                let id = self.array(arr);
                self.pending = Some(Pending::Retire(self.arrays.items[id].retire()));
            }
            Op::Pop => {
                self.stack.pop();
            }
            Op::Dup => {
                let top = self.stack.last().cloned().unwrap_or(Value::Uninit);
                self.stack.push(top);
            }
            Op::Swap => {
                let len = self.stack.len();
                self.stack.swap(len - 1, len - 2);
            }
            Op::Arith(sym) | Op::ArithAssign(sym) => {
                let rhs = self.pop().num();
                let lhs = self.pop().num();
                let value = arith(sym, lhs, rhs, matches!(op, Op::ArithAssign(_)))?;
                self.stack.push(Value::Num(value));
            }
            Op::Neg => {
                let value = self.pop().num();
                self.stack.push(Value::Num(-value));
            }
            Op::ToNum => {
                let value = self.pop().num();
                self.stack.push(Value::Num(value));
            }
            Op::Not => {
                let value = self.pop().truth();
                self.stack.push(num(!value));
            }
            Op::Truth => {
                let value = self.pop().truth();
                self.stack.push(num(value));
            }
            Op::Concat => {
                let right = self.pop_text();
                let left = self.pop_text();
                let len = left.len().saturating_add(right.len());
                if len > MAX_LEN {
                    return Err(no_memory());
                }
                self.pending = Some(Pending::String(StringWork::Join {
                    left,
                    right,
                    at: 0,
                    out: Vec::with_capacity(len),
                }));
            }
            Op::Compare(cmp) => {
                let right = self.pop();
                let left = self.pop();
                if left.numeric() && right.numeric() {
                    self.stack.push(num(comparison(
                        cmp,
                        compare_numbers(left.num(), right.num()),
                    )));
                } else {
                    self.pending = Some(Pending::Compare {
                        left: left.into_text(),
                        right: right.into_text(),
                        at: 0,
                        cmp,
                    });
                }
            }
            Op::Match(negated) => {
                let pattern = self.pop_text();
                let subject = self.pop_text();
                self.regexes.get(&pattern)?;
                self.pending = Some(Pending::Match {
                    pattern,
                    subject,
                    target: MatchTarget::Test(negated),
                });
            }
            Op::Jump(to) => self.pc = to as usize,
            Op::JumpIfFalse(to) => {
                if !self.pop().truth() {
                    self.pc = to as usize;
                }
            }
            Op::JumpIfUninit(to) => {
                if matches!(self.stack.last(), Some(Value::Uninit)) {
                    self.pc = to as usize;
                }
            }
            Op::Arg(var) => self.arg(var)?,
            Op::Call(function, count) => self.call(function, count as usize)?,
            Op::Return => {
                let value = self.pop();
                let frame = self.frames.last().expect("a return runs in a call");
                self.pending = Some(Pending::Scope(Scope {
                    stack: frame.stack,
                    locals: frame.locals,
                    iters: frame.iters,
                    frames: self.frames.len() - 1,
                    array: None,
                    returned: Some(value),
                }));
                self.pc = frame.ret;
            }
            Op::Fatal(at) => return Err(self.code.strings[at as usize].to_vec()),
            Op::Print(formatted, count, redirect) => {
                return self.print(formatted, count as usize, redirect, work);
            }
            Op::Getline(kind, target) => return self.getline(kind, target, work),
            Op::ForIn(arr) => {
                let id = self.array(arr);
                self.pending = Some(Pending::Snapshot(Snapshot {
                    array: id,
                    next: 0,
                    keys: Vec::with_capacity(self.arrays.items[id].len()),
                }));
            }
            Op::ForInNext(var, exit) => {
                let iter = self.iters.last_mut().expect("a loop is open");
                match iter.keys.get(iter.at) {
                    Some(key) => {
                        let key = key.clone();
                        iter.at += 1;
                        self.store(var, strnum(key))?;
                    }
                    None => self.pc = exit as usize,
                }
            }
            Op::ForInEnd => {
                self.pending = Some(Pending::Scope(Scope {
                    stack: self.stack.len(),
                    locals: self.locals.len(),
                    iters: self.iters.len() - 1,
                    frames: self.frames.len(),
                    array: None,
                    returned: None,
                }));
            }
            Op::Next | Op::NextFile => {
                let edge = match self.phase {
                    Phase::Main => None,
                    Phase::Begin => Some("BEGIN"),
                    Phase::End => Some("END"),
                };
                if let Some(edge) = edge {
                    return Err(format!("awk: next used in a {edge} action").into_bytes());
                }
                self.unwind();
                if op == Op::NextFile {
                    self.skip_file();
                }
                self.pc = self.code.record_done_pc;
            }
            Op::Exit(has_value) => {
                if has_value {
                    self.exit_code = to_int(self.pop().num());
                }
                self.status = (self.exit_code & 0xFF) as i32;
                self.unwind();
                match self.phase {
                    Phase::Begin => {
                        self.io.settle();
                        self.phase = Phase::End;
                        self.pc = self.code.end_pc;
                    }
                    Phase::Main => {
                        self.phase = Phase::End;
                        self.pc = self.code.end_pc;
                    }
                    Phase::End => self.pc = self.code.finish_pc,
                }
            }
            Op::RangeOff(index, to) => {
                if !self.ranges[index as usize] {
                    self.pc = to as usize;
                }
            }
            Op::RangeEnd(index) => {
                if self.pop().truth() {
                    self.ranges[index as usize] = false;
                }
            }
            Op::RangeStart(index) => {
                let end = self.pop().truth();
                self.ranges[index as usize] = !end;
            }
            Op::Math(math) => {
                let value = self.pop().num();
                let result = match math {
                    Math::Sin => value.sin(),
                    Math::Cos => value.cos(),
                    Math::Exp => value.exp(),
                    Math::Sqrt => value.sqrt(),
                    Math::Log => value.ln(),
                    Math::Int if value.is_finite() => value.trunc(),
                    Math::Int => value,
                };
                self.stack.push(Value::Num(result));
            }
            Op::Atan2 => {
                let right = self.pop().num();
                let left = self.pop().num();
                self.stack.push(Value::Num(left.atan2(right)));
            }
            Op::Rand => {
                let drawn = self.random();
                self.stack.push(Value::Num(drawn));
            }
            Op::Srand(has_seed) => {
                let previous = self.seed;
                self.seed = if has_seed {
                    to_int(self.pop().num())
                } else {
                    0
                };
                self.rand_state = (self.seed & 0xFFFF_FFFF) as u32;
                self.stack.push(Value::Num(previous as f64));
            }
            Op::Index => {
                let needle = self.pop_text();
                let haystack = self.pop_text();
                self.pending = Some(Pending::Index(IndexSearch::new(haystack, needle)));
            }
            Op::Substr(has_length) => {
                let length = has_length.then(|| self.pop().num());
                let start = self.pop().num();
                let subject = self.pop_text();
                let (at, end) = substr(subject.len(), start, length);
                let out = Vec::with_capacity(end - at);
                self.pending = Some(Pending::String(StringWork::Copy {
                    subject,
                    at,
                    end,
                    out,
                }));
            }
            Op::Case(upper) => {
                let subject = self.pop_text();
                self.pending = Some(Pending::String(StringWork::Case {
                    out: Vec::with_capacity(subject.len()),
                    subject,
                    upper,
                    at: 0,
                }));
            }
            Op::Sprintf(count) => {
                let mut args = self.stack.split_off(self.stack.len() - count as usize);
                let format = args.remove(0).into_text();
                self.pending = Some(Pending::Format(Box::new(FormatTask {
                    formatter: Formatter::new(format, args, self.special_text(CONVFMT)),
                    target: OutputTarget::Value(Vec::new()),
                })));
            }
            Op::Length => {
                let len = self.pop_text().len();
                self.stack.push(Value::Num(len as f64));
            }
            Op::LengthRecord => {
                let len = self.record_text()?.len();
                self.stack.push(Value::Num(len as f64));
            }
            Op::LengthVar(var) => {
                let array = self.slot(var).and_then(|slot| slot.array);
                if let Some(id) = array {
                    self.stack
                        .push(Value::Num(self.arrays.items[id].len() as f64));
                } else {
                    let value = self.load(var)?;
                    self.coerce(value, CoerceTarget::Length, work)?;
                }
            }
            Op::MatchFn => {
                let pattern = self.pop_text();
                let subject = self.pop_text();
                self.regexes.get(&pattern)?;
                self.pending = Some(Pending::Match {
                    pattern,
                    subject,
                    target: MatchTarget::Function,
                });
            }
            Op::SubVar(var, global) => {
                let subject = self.load(var)?;
                self.substitute(subject, global, SubTarget::Var(var), work)?;
            }
            Op::SubField(global) => {
                let index = to_int(self.pop().num());
                let subject = self.get_field(index)?;
                self.substitute(subject, global, SubTarget::Field(index), work)?;
            }
            Op::SubElem(arr, global) => {
                let key = self.pop_text();
                let id = self.array(arr);
                let subject = self.arrays.items[id].entry(&key, || Value::Uninit).clone();
                self.substitute(subject, global, SubTarget::Element(id, key), work)?;
            }
            Op::SubValue(global) => {
                let subject = self.pop();
                self.substitute(subject, global, SubTarget::Invalid, work)?;
            }
            Op::Split(arr, has_separator) => {
                let separator = if has_separator {
                    self.pop_text()
                } else {
                    self.special_text(FS)
                };
                let subject = self.pop_text();
                let id = self.array(arr);
                let retired = self.arrays.items[id].retire();
                self.pending = Some(Pending::Split(Box::new(FieldSplit {
                    subject,
                    separator,
                    scan: SplitScan::default(),
                    array: id,
                    retired,
                    count: 0,
                    view: None,
                })));
            }
            Op::Close => return self.close(),
            Op::Fflush(has_name) => return self.fflush(has_name),
            Op::System => return self.system(),
            Op::EnterMain => {
                self.io.settle();
                if self.code.reads_input {
                    self.phase = Phase::Main;
                } else {
                    self.phase = Phase::End;
                    self.pc = self.code.end_pc;
                }
            }
            Op::NextMain => match self.next_main(work)? {
                Some(true) => {}
                Some(false) => {
                    self.phase = Phase::End;
                    self.pc = self.code.end_pc;
                }
                None => return self.wait(0),
            },
            Op::RecordDone => {
                self.io.settle();
                self.pc = self.code.main_pc;
            }
            Op::Finish => return self.finish(),
        }
        Ok(())
    }

    fn substitute(
        &mut self,
        subject: Value,
        global: bool,
        target: SubTarget,
        work: &mut u64,
    ) -> Step {
        let template = self.pop_text();
        let pattern = self.pop_text();
        self.coerce(
            subject,
            CoerceTarget::Sub {
                pattern,
                template,
                global,
                target,
            },
            work,
        )
    }

    fn random(&mut self) -> f64 {
        self.rand_state = self.rand_state.wrapping_add(0x6D2B_79F5);
        let mut mixed = self.rand_state;
        mixed = (mixed ^ (mixed >> 15)).wrapping_mul(mixed | 1);
        mixed ^= mixed.wrapping_add((mixed ^ (mixed >> 7)).wrapping_mul(mixed | 61));
        f64::from(mixed ^ (mixed >> 14)) / 4_294_967_296.0
    }

    /// A bare name passed to a function: its array when it holds one or
    /// was never assigned (the callee may subscript it), else its value.
    fn arg(&mut self, var: Var) -> Step {
        let array = match self.slot(var) {
            Some(slot) => slot.array.is_some() || slot.scalar.is_none(),
            None => false,
        };
        let value = if array {
            let arr = match var {
                Var::Local(index) => Arr::Local(index),
                Var::Global(index) => Arr::Global(index),
                _ => unreachable!("counters hold no array"),
            };
            Value::Array(self.array(arr))
        } else {
            self.load(var)?
        };
        self.stack.push(value);
        Ok(())
    }

    fn call(&mut self, function: u32, count: usize) -> Step {
        let entry = &self.code.functions[function as usize];
        if self.frames.len() >= MAX_CALL_DEPTH {
            let name = String::from_utf8_lossy(&entry.name);
            return Err(
                format!("awk: function {name} nested deeper than {MAX_CALL_DEPTH} calls")
                    .into_bytes(),
            );
        }
        let (target, params) = (entry.entry, entry.params);
        let args = self.stack.split_off(self.stack.len() - count);
        let locals = self.locals.len();
        for arg in args {
            self.locals.push(match arg {
                Value::Array(id) => Slot {
                    scalar: None,
                    array: Some(id),
                },
                value => Slot {
                    scalar: Some(value),
                    array: None,
                },
            });
        }
        self.locals
            .resize_with(locals + params.max(count), Slot::default);
        self.frames.push(Frame {
            ret: self.pc,
            stack: self.stack.len(),
            locals,
            iters: self.iters.len(),
            arrays: Vec::new(),
        });
        self.pc = target;
        Ok(())
    }

    fn skip_file(&mut self) {
        if let Some(main) = self.io.main.take() {
            if main.live() {
                self.io.push(Request::Close { fd: main.fd });
            }
        }
    }

    fn start_file(&mut self, name: Vec<u8>) {
        self.globals[FILENAME as usize].scalar = Some(string(name.clone()));
        self.main_name = name;
        self.fnr = 0.0;
    }

    /// Advance the main input to the next operand that names a file,
    /// reading ARGV as it stands when each is reached: an emptied or
    /// deleted slot is skipped, a `var=value` one assigned there. With no
    /// file operand the input is stdin, `-` in FILENAME (mawk 1.3.4).
    fn open_operand(&mut self, work: &mut u64) -> Result<bool, Vec<u8>> {
        let argv = self.array(Arr::Global(ARGV));
        loop {
            if *work == 0 {
                return Ok(true);
            }
            let argc = self.load(Var::Global(ARGC))?;
            if !argc.prepare_number(&mut self.number, work) {
                return Ok(true);
            }
            *work = work.saturating_sub(1);
            let argc = to_int(argc.num());
            if (self.arg_index as i128) + 1 >= argc {
                break;
            }
            let next = self.arg_index + 1;
            let key = next.to_string().into_bytes();
            let operand = if let Some(operand) = self.operand.take() {
                operand
            } else {
                let Some(slot) = self.arrays.items[argv].get(&key).cloned() else {
                    self.arg_index = next;
                    continue;
                };
                self.coerce(slot, CoerceTarget::Operand, work)?;
                if self.pending.is_some() {
                    return Ok(true);
                }
                self.operand.take().expect("operand conversion finished")
            };
            self.arg_index = next;
            if operand.is_empty() {
                continue;
            }
            if let Some((name, value)) = split_assignment(&operand) {
                let var = match name.as_slice() {
                    b"NF" => Some(Var::Nf),
                    b"NR" => Some(Var::Nr),
                    b"FNR" => Some(Var::Fnr),
                    _ => self
                        .code
                        .globals
                        .get(&name)
                        .map(|&index| Var::Global(index)),
                };
                if let Some(var) = var {
                    self.store(var, strnum(value))?;
                    if self.pending.is_some() {
                        return Ok(true);
                    }
                }
                continue;
            }
            self.read_operand = true;
            self.start_file(operand.to_vec());
            let fd = self.io.fd();
            self.io.main = Some(Reader::new(
                fd,
                Some((operand.to_vec(), Opening::Operand(self.arg_index))),
            ));
            return Ok(true);
        }
        if self.read_operand {
            return Ok(false);
        }
        self.read_operand = true;
        self.start_file(b"-".to_vec());
        let fd = self.io.fd();
        self.io.main = Some(Reader::new(fd, Some((b"-".to_vec(), Opening::Name))));
        Ok(true)
    }

    /// Read the next main-input record into `$0`, counting it in NR and
    /// FNR: Some(false) once the input is exhausted, None while it waits
    /// on the host. What the main loop and a plain getline both read.
    fn next_main(&mut self, work: &mut u64) -> Result<Option<bool>, Vec<u8>> {
        Ok(self.next_main_record(work)?.map(|record| match record {
            Some(text) => {
                self.set_record(text);
                true
            }
            None => false,
        }))
    }

    fn next_main_record(&mut self, work: &mut u64) -> Result<Option<Option<Text>>, Vec<u8>> {
        loop {
            if *work == 0 {
                return Ok(None);
            }
            if let Some(main) = &mut self.io.main {
                let rs = special(&self.globals, RS);
                match main.next(&rs, &mut self.regexes, work)? {
                    Next::Record(text) => {
                        self.nr += 1.0;
                        self.fnr += 1.0;
                        return Ok(Some(Some(text)));
                    }
                    Next::End => self.io.main = None,
                    Next::Failed(detail) => {
                        return Err([
                            b"awk: cannot open \"".as_slice(),
                            &self.main_name,
                            b"\" (",
                            &detail,
                            b")",
                        ]
                        .concat());
                    }
                    Next::Busy => return Ok(None),
                    Next::Pending => {
                        let request = main.read();
                        self.io.read(request);
                        return Ok(None);
                    }
                }
            }
            if !self.open_operand(work)? {
                return Ok(Some(None));
            }
            if self.pending.is_some() {
                return Ok(None);
            }
        }
    }

    /// Push a getline's result: its status, then the record when it has a
    /// target, else the record becomes `$0`.
    fn getline_result(&mut self, record: Option<Text>, failed: bool, target: bool) {
        let status = match (&record, failed) {
            (_, true) => -1.0,
            (Some(_), _) => 1.0,
            (None, _) => 0.0,
        };
        self.stack.push(Value::Num(status));
        match (record, target) {
            (Some(record), true) => self.stack.push(strnum(record)),
            (Some(record), false) => self.set_record(record),
            (None, true) => self.stack.push(Value::Uninit),
            (None, false) => {}
        }
    }

    /// A plain getline reads the main input and counts NR and FNR; a file
    /// or a command does not, as in mawk 1.3.4. A file that cannot be read
    /// answers -1 without a message.
    fn getline(&mut self, kind: GetlineKind, target: bool, work: &mut u64) -> Step {
        match kind {
            GetlineKind::Plain => match self.next_main_record(work)? {
                None => self.wait(0),
                Some(found) => {
                    self.getline_result(found, false, target);
                    Ok(())
                }
            },
            GetlineKind::File => {
                let name = self.top_text();
                let rs = self.special_text(RS);
                if !self.io.files_in.contains(&name) {
                    let fd = self.io.fd();
                    let reader = Reader::new(fd, Some((name.to_vec(), Opening::Name)));
                    self.io.files_in.insert(name.clone(), reader);
                }
                let reader = self.io.files_in.get_mut(&name).expect("just opened");
                match reader.next(&rs, &mut self.regexes, work)? {
                    Next::Busy => self.wait(0),
                    Next::Pending => {
                        let request = reader.read();
                        self.io.read(request);
                        self.wait(0)
                    }
                    next => {
                        let failed = matches!(next, Next::Failed(_));
                        let record = match next {
                            Next::Record(text) => Some(text),
                            _ => None,
                        };
                        if failed {
                            self.io.files_in.remove(&name);
                        }
                        self.stack.pop();
                        self.getline_result(record, failed, target);
                        Ok(())
                    }
                }
            }
            GetlineKind::Command => {
                let command = self.top_text();
                if self.stage == 1 {
                    let status = self.io.run_status.take().unwrap_or(0.0);
                    if let Some((_, pipe_status)) = self.io.pipes_in.get_mut(&command) {
                        *pipe_status = status;
                    }
                    self.stage = 0;
                }
                if !self.io.pipes_in.contains(&command) {
                    self.io.before_command();
                    let fd = self.io.fd();
                    self.io
                        .pipes_in
                        .insert(command.clone(), (Reader::new(fd, None), 0.0));
                    self.io.run(Request::Run {
                        command: command.to_vec(),
                        stdin: None,
                        stdout: Some(fd),
                    });
                    return self.wait(1);
                }
                let rs = self.special_text(RS);
                let (reader, _) = self.io.pipes_in.get_mut(&command).expect("just checked");
                match reader.next(&rs, &mut self.regexes, work)? {
                    Next::Busy => self.wait(0),
                    Next::Pending => {
                        let request = reader.read();
                        self.io.read(request);
                        self.wait(0)
                    }
                    next => {
                        let record = match next {
                            Next::Record(text) => Some(text),
                            _ => None,
                        };
                        self.stack.pop();
                        self.getline_result(record, false, target);
                        Ok(())
                    }
                }
            }
        }
    }

    /// print and printf. A file opened with `>` is emptied when it is
    /// opened, and what is printed to it waits until a flush, a close or
    /// the end of a record, so reading it back before closing it reads
    /// what was flushed.
    fn print(
        &mut self,
        formatted: bool,
        count: usize,
        redirect: Option<RedirKind>,
        work: &mut u64,
    ) -> Step {
        let name = redirect.map(|_| self.top_text());
        if self.stage == 0 {
            if let (Some(kind), Some(name)) = (redirect, &name) {
                if kind == RedirKind::Pipe {
                    if !self.io.pipes_out.contains(name) {
                        self.io.before_command();
                        let fd = self.io.fd();
                        self.io.pipes_out.insert(
                            name.clone(),
                            OutPipe {
                                fd,
                                buf: Vec::new(),
                            },
                        );
                        if !self.io.idle() {
                            return self.wait(1);
                        }
                    }
                } else if !STDOUT_NAMES.contains(&name.as_slice())
                    && name.as_slice() != STDERR_NAME
                    && !self.io.files_out.contains(name)
                {
                    self.io.files_out.insert(name.clone(), OutFile::default());
                    if kind == RedirKind::File {
                        self.io.push(Request::Write {
                            path: name.to_vec(),
                            mode: WriteMode::Truncate,
                            data: Vec::new(),
                        });
                        return self.wait(1);
                    }
                }
            }
        }
        if !formatted
            && count == 0
            && !self
                .record
                .prepare_text(&special(&self.globals, OFS), work)?
        {
            return self.wait(1);
        }
        self.stage = 0;
        let base = self.stack.len() - count - usize::from(redirect.is_some());
        let mut args = self.stack.split_off(base);
        args.truncate(count);
        let target = redirect.zip(name);
        if formatted {
            if args.is_empty() {
                return Err(b"awk: printf needs a format".to_vec());
            }
            let format = args.remove(0).into_text();
            self.pending = Some(Pending::Format(Box::new(FormatTask {
                formatter: Formatter::new(format, args, self.special_text(CONVFMT)),
                target: OutputTarget::Print(target),
            })));
        } else {
            if args.is_empty() {
                args.push(string(self.record.text().clone()));
            }
            self.pending = Some(Pending::Print {
                print: Print::new(
                    args,
                    self.special_text(OFMT),
                    self.special_text(OFS),
                    self.special_text(ORS),
                ),
                target: OutputTarget::Print(target),
            });
        }
        Ok(())
    }

    fn emit(&mut self, body: &[u8], target: Option<&(RedirKind, Text)>) {
        let Some((kind, name)) = target else {
            self.io.stdout(body);
            return;
        };
        if *kind == RedirKind::Pipe {
            let pipe = self
                .io
                .pipes_out
                .get_mut(name)
                .expect("opened before rendering");
            pipe.buf.extend_from_slice(body);
            if pipe.buf.len() >= LIMIT {
                let (fd, data) = (pipe.fd, std::mem::take(&mut pipe.buf));
                self.io.push(Request::Spool { fd, data });
            }
        } else if STDOUT_NAMES.contains(&name.as_slice()) {
            self.io.stdout(body);
        } else if name.as_slice() == STDERR_NAME {
            self.io.err.extend_from_slice(body);
        } else if let Some(file) = self.io.files_out.get_mut(name) {
            file.buf.extend_from_slice(body);
            if file.buf.len() >= LIMIT {
                self.io.send_file(name);
            }
        }
    }

    /// Run an output pipe's command on everything printed to it.
    fn close_pipe(&mut self, command: Text, pipe: OutPipe) {
        if !pipe.buf.is_empty() {
            self.io.push(Request::Spool {
                fd: pipe.fd,
                data: pipe.buf,
            });
        }
        self.io.send_files();
        self.io.run(Request::Run {
            command: command.to_vec(),
            stdin: Some(pipe.fd),
            stdout: None,
        });
    }

    /// close(): a command answers its exit status, a file 0, and a name
    /// nothing is open under -1.
    fn close(&mut self) -> Step {
        let name = self.top_text();
        if self.stage == 0 {
            if let Some(pipe) = self.io.pipes_out.remove(&name) {
                self.close_pipe(name, pipe);
                return self.wait(1);
            }
            self.stage = 1;
            self.io.run_status = None;
        }
        if self.stage == 1 {
            let mut status = self.io.run_status.take().unwrap_or(-1.0);
            if let Some((reader, pipe_status)) = self.io.pipes_in.remove(&name) {
                if reader.live() {
                    self.io.push(Request::Close { fd: reader.fd });
                }
                status = pipe_status;
            }
            if self.io.files_out.contains(&name) {
                self.io.send_file(&name);
                self.io.files_out.remove(&name);
                self.io.push(Request::Flush {
                    path: Some(name.to_vec()),
                });
                status = 0.0;
            }
            if let Some(reader) = self.io.files_in.remove(&name) {
                if reader.live() {
                    self.io.push(Request::Close { fd: reader.fd });
                }
                status = 0.0;
            }
            self.scratch = status;
            if !self.io.idle() {
                return self.wait(2);
            }
        }
        self.stage = 0;
        self.stack.pop();
        self.stack.push(Value::Num(self.scratch));
        Ok(())
    }

    /// fflush(): standard output and files, or one named stream. An output
    /// pipe runs only when closed, so flushing one flushes nothing.
    fn fflush(&mut self, has_name: bool) -> Step {
        if self.stage == 0 {
            let name = if has_name {
                self.top_text()
            } else {
                Text::default()
            };
            let mut status = 0.0;
            if name.is_empty() {
                self.io.before_command();
                if !self.io.files_out.is_empty() {
                    self.io.push(Request::Flush { path: None });
                }
            } else if STDOUT_NAMES.contains(&name.as_slice()) {
                self.io.release();
            } else if self.io.files_out.contains(&name) {
                self.io.send_file(&name);
                self.io.push(Request::Flush {
                    path: Some(name.to_vec()),
                });
            } else if !self.io.pipes_out.contains(&name) {
                status = -1.0;
            }
            self.scratch = status;
            if !self.io.idle() {
                return self.wait(1);
            }
        }
        self.stage = 0;
        if has_name {
            self.stack.pop();
        }
        self.stack.push(Value::Num(self.scratch));
        Ok(())
    }

    /// system(): the command's output lands after awk's own.
    fn system(&mut self) -> Step {
        if self.stage == 0 {
            let command = self.top_text();
            self.io.before_command();
            self.io.run(Request::Run {
                command: command.to_vec(),
                stdin: None,
                stdout: None,
            });
            return self.wait(1);
        }
        self.stage = 0;
        let status = self.io.run_status.take().unwrap_or(0.0);
        self.stack.pop();
        self.stack.push(Value::Num(status));
        Ok(())
    }

    /// Close everything at exit: the output pipes run newest first, as
    /// mawk 1.3.4 closes them, their output landing ahead of any standard
    /// output still held; then the files are written out.
    fn finish(&mut self) -> Step {
        self.io.run_status = None;
        if let Some((command, pipe)) = self.io.pipes_out.pop_last() {
            self.close_pipe(command, pipe);
            return self.wait(0);
        }
        self.io.send_files();
        if !self.io.files_out.is_empty() {
            self.io.push(Request::Flush { path: None });
        }
        self.io.release();
        self.done = true;
        Ok(())
    }
}

fn comparison(cmp: Cmp, order: std::cmp::Ordering) -> bool {
    match cmp {
        Cmp::Lt => order.is_lt(),
        Cmp::Le => order.is_le(),
        Cmp::Gt => order.is_gt(),
        Cmp::Ge => order.is_ge(),
        Cmp::Eq => order.is_eq(),
        Cmp::Ne => order.is_ne(),
    }
}

fn arith(op: u8, lhs: f64, rhs: f64, assign: bool) -> Result<f64, Vec<u8>> {
    let suffix = if assign { " in /=" } else { "" };
    Ok(match op {
        b'+' => lhs + rhs,
        b'-' => lhs - rhs,
        b'*' => lhs * rhs,
        b'/' => {
            if rhs == 0.0 {
                return Err(format!("awk: division by zero{suffix}").into_bytes());
            }
            lhs / rhs
        }
        b'%' => {
            if rhs == 0.0 {
                let suffix = if assign { " in %=" } else { " in %" };
                return Err(format!("awk: division by zero{suffix}").into_bytes());
            }
            if lhs.is_infinite() {
                f64::NAN
            } else {
                lhs % rhs
            }
        }
        _ => lhs.powf(rhs),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_field_keys_and_values_do_not_pin_original_records() {
        let program = br#"BEGIN { split(source,a); saved=a[1]; delete a; $0=source; key=$1; table[key]=1; source=""; $0="next" }"#;
        let mut input = b"id ".to_vec();
        input.extend(std::iter::repeat_n(b'x', 2 * 1024 * 1024));
        let code = super::super::compile::compile(&super::super::parser::parse(program).unwrap());
        let mut machine = Machine::new(
            code,
            Setup {
                operands: Vec::new(),
                assignments: vec![(b"source".to_vec(), input)],
                fs: None,
                environ: Vec::new(),
            },
        );
        while !machine.done {
            machine.run(4096);
        }
        assert_eq!(machine.status, 0);
        for name in [b"saved".as_slice(), b"key"] {
            let index = machine.code.globals[name];
            let value = machine.load(Var::Global(index)).unwrap().into_text();
            assert_eq!(value.as_slice(), b"id");
            assert_eq!(value.storage_len(), 2);
        }
        let index = machine.code.globals[b"table".as_slice()];
        let id = machine.array(Arr::Global(index));
        let key = machine.arrays.items[id].next_key(&mut 0).unwrap();
        assert_eq!(key.as_slice(), b"id");
        assert_eq!(key.storage_len(), 2);
    }
}
