use std::borrow::Cow;

use super::compile::{
    ARGC, ARGV, Arr, CONVFMT, Code, ENVIRON, FILENAME, FS, Math, OFMT, OFS, ORS, Op, RLENGTH, RS,
    RSTART, SUBSEP, Var,
};
use super::format::sprintf;
use super::io::{Io, LIMIT, Next, Ordered, OutFile, OutPipe, Reader, STDERR_NAME, STDOUT_NAMES};
use super::parser::{Cmp, GetlineKind, RedirKind};
use super::text::{Regexes, split, split_assignment, substitute, substr};
use super::value::{MAX_LEN, Value, compare, format_num, strnum, to_int};
use crate::regex::unbounded;
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
    keys: Vec<Vec<u8>>,
    at: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Begin,
    Main,
    End,
}

/// The current record: `$0` as read or rebuilt, and its fields, split
/// with the FS and RS in force when it arrived.
#[derive(Default)]
struct Record {
    text: Vec<u8>,
    ranges: Vec<(usize, usize)>,
    fields: Vec<Vec<u8>>,
    owned: bool,
    split: bool,
    stale: bool,
    fs: Vec<u8>,
    paragraph: bool,
}

impl Record {
    fn set(&mut self, text: &[u8], fs: &[u8], paragraph: bool) {
        self.text.clear();
        self.text.extend_from_slice(text);
        self.fs.clear();
        self.fs.extend_from_slice(fs);
        self.paragraph = paragraph;
        self.split = false;
        self.owned = false;
        self.stale = false;
    }

    fn ensure_split(&mut self, regexes: &mut Regexes) -> Result<(), Vec<u8>> {
        if !self.split {
            split(
                &self.text,
                &self.fs,
                self.paragraph,
                regexes,
                &mut self.ranges,
            )?;
            self.split = true;
        }
        Ok(())
    }

    fn nf(&mut self, regexes: &mut Regexes) -> Result<usize, Vec<u8>> {
        self.ensure_split(regexes)?;
        Ok(if self.owned {
            self.fields.len()
        } else {
            self.ranges.len()
        })
    }

    /// Field `index`, from 1, which must not pass NF.
    fn field(&self, index: usize) -> &[u8] {
        if self.owned {
            &self.fields[index - 1]
        } else {
            let (start, end) = self.ranges[index - 1];
            &self.text[start..end]
        }
    }

    fn own(&mut self, regexes: &mut Regexes) -> Result<(), Vec<u8>> {
        self.ensure_split(regexes)?;
        if !self.owned {
            self.fields = self
                .ranges
                .iter()
                .map(|&(start, end)| self.text[start..end].to_vec())
                .collect();
            self.owned = true;
        }
        Ok(())
    }

    fn text(&mut self, ofs: &[u8]) -> Result<&[u8], Vec<u8>> {
        if self.stale {
            let len = self.fields.iter().map(Vec::len).sum::<usize>()
                + ofs
                    .len()
                    .saturating_mul(self.fields.len().saturating_sub(1));
            if len > MAX_LEN {
                return Err(no_memory());
            }
            self.text = self.fields.join(ofs);
            self.stale = false;
        }
        Ok(&self.text)
    }

    /// Give the record `count` fields at least, as assigning past NF
    /// does.
    fn widen(&mut self, count: usize, regexes: &mut Regexes) -> Step {
        if count > MAX_FIELDS {
            return Err(no_memory());
        }
        self.own(regexes)?;
        if self.fields.len() < count {
            self.fields.resize(count, Vec::new());
        }
        self.stale = true;
        Ok(())
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

    fn release(&mut self, id: usize) {
        self.items[id].clear();
        self.free.push(id);
    }
}

fn special(globals: &[Slot], index: u32) -> Cow<'_, [u8]> {
    match &globals[index as usize].scalar {
        Some(value) => value.text(b"%.6g"),
        None => Cow::Borrowed(&[]),
    }
}

fn num(truth: bool) -> Value {
    Value::Num(if truth { 1.0 } else { 0.0 })
}

type Step = Result<(), Vec<u8>>;

pub(super) struct Machine {
    code: Code,
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
            scratch: 0.0,
            status: 0,
            done: false,
            io: Io::default(),
        };
        let defaults: [&[u8]; 10] = [
            b" ", b" ", b"\n", b"\n", b"\x1c", b"%.6g", b"%.6g", b"", b"0", b"-1",
        ];
        for (index, value) in defaults.iter().enumerate() {
            machine.globals[index].scalar = Some(Value::Str(value.to_vec()));
        }
        for (name, value) in setup.assignments {
            if let Some(&index) = machine.code.globals.get(&name) {
                machine.globals[index as usize].scalar = Some(strnum(value));
            }
        }
        let argv = machine.array(Arr::Global(ARGV));
        machine.arrays.items[argv].insert(b"0".to_vec(), Value::Str(b"awk".to_vec()));
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
            machine.globals[FS as usize].scalar = Some(Value::Str(fs));
        }
        machine
    }

    /// Run up to `budget` steps, stopping early to wait on the host, once
    /// a window of output is ready, or at the end.
    pub(super) fn run(&mut self, budget: usize) {
        if let Some(message) = self.io.fatal.take() {
            self.salvage(message);
            return;
        }
        let mut steps = 0;
        while !self.done
            && self.io.idle()
            && steps < budget
            && self.io.out.len() < LIMIT
            && self.io.err.len() < LIMIT
        {
            steps += 1;
            if let Err(message) = self.step() {
                self.salvage(message);
                return;
            }
        }
    }

    /// End the run on a fatal error: what was printed stays, and files
    /// are written out, but no pipe's command runs (mawk's exit flushes
    /// its buffers and nothing else).
    fn salvage(&mut self, message: Vec<u8>) {
        self.io.requests.clear();
        self.io.err.extend_from_slice(&message);
        self.io.err.push(b'\n');
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

    fn convfmt(&self) -> Cow<'_, [u8]> {
        special(&self.globals, CONVFMT)
    }

    fn pop(&mut self) -> Value {
        self.stack.pop().unwrap_or(Value::Uninit)
    }

    fn pop_text(&mut self) -> Vec<u8> {
        let value = self.pop();
        value.into_text(&self.convfmt())
    }

    fn top_text(&self) -> Vec<u8> {
        let fmt = self.convfmt();
        self.stack
            .last()
            .map(|value| value.text(&fmt).into_owned())
            .unwrap_or_default()
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
            Var::Nf => Value::Num(self.record.nf(&mut self.regexes)? as f64),
            Var::Nr => Value::Num(self.nr),
            Var::Fnr => Value::Num(self.fnr),
            _ => self
                .slot(var)
                .and_then(|slot| slot.scalar.clone())
                .unwrap_or(Value::Uninit),
        })
    }

    fn store(&mut self, var: Var, value: Value) -> Step {
        match var {
            Var::Nf => {
                let count = usize::try_from(to_int(value.num()).max(0)).unwrap_or(usize::MAX);
                self.record.widen(count, &mut self.regexes)?;
                self.record.fields.truncate(count);
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

    fn set_record(&mut self, text: &[u8]) {
        let fs = special(&self.globals, FS);
        let paragraph = special(&self.globals, RS).is_empty();
        self.record.set(text, &fs, paragraph);
    }

    fn get_field(&mut self, index: i128) -> Result<Value, Vec<u8>> {
        if index == 0 {
            let ofs = special(&self.globals, OFS);
            return Ok(strnum(self.record.text(&ofs)?.to_vec()));
        }
        if index < 0 {
            return Err(format!("awk: trying to access field {index}").into_bytes());
        }
        let nf = self.record.nf(&mut self.regexes)?;
        let index = usize::try_from(index).unwrap_or(usize::MAX);
        Ok(if index > nf {
            Value::Str(Vec::new())
        } else {
            strnum(self.record.field(index).to_vec())
        })
    }

    fn set_field(&mut self, index: i128, text: Vec<u8>) -> Step {
        if index == 0 {
            self.set_record(&text);
            return Ok(());
        }
        if index < 0 {
            return Err(format!("awk: trying to access field {index}").into_bytes());
        }
        let index = usize::try_from(index).unwrap_or(usize::MAX);
        self.record.widen(index, &mut self.regexes)?;
        self.record.fields[index - 1] = text;
        Ok(())
    }

    fn record_text(&mut self) -> Result<&[u8], Vec<u8>> {
        let ofs = special(&self.globals, OFS);
        self.record.text(&ofs)
    }

    /// Unwind every call and loop, as `next` and `exit` do.
    fn unwind(&mut self) {
        while let Some(frame) = self.frames.pop() {
            for id in frame.arrays {
                self.arrays.release(id);
            }
        }
        self.stack.clear();
        self.locals.clear();
        self.iters.clear();
        self.stage = 0;
    }

    fn step(&mut self) -> Step {
        let op = self.code.ops[self.pc];
        self.pc += 1;
        match op {
            Op::Num(value) => self.stack.push(Value::Num(value)),
            Op::Str(at) => {
                let text = self.code.strings[at as usize].clone();
                self.stack.push(Value::Str(text));
            }
            Op::Uninit => self.stack.push(Value::Uninit),
            Op::MatchRecord(at) => {
                let ofs = special(&self.globals, OFS);
                let text = self.record.text(&ofs)?;
                let regex = self.regexes.get(&self.code.strings[at as usize])?;
                let found = unbounded(|budget| regex.find(text, 0, budget)).is_some();
                self.stack.push(num(found));
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
                let text = value.text(&self.convfmt()).into_owned();
                self.set_field(index, text)?;
                self.stack.push(value);
            }
            Op::IncDecField(delta, pre) => {
                let index = to_int(self.pop().num());
                let current = self.get_field(index)?.num();
                let text = format_num(current + delta, &self.convfmt());
                self.set_field(index, text)?;
                self.stack
                    .push(Value::Num(if pre { current + delta } else { current }));
            }
            Op::Key(count) => {
                let count = count as usize;
                let parts = self.stack.split_off(self.stack.len() - count);
                let key = if count == 1 {
                    parts
                        .into_iter()
                        .next()
                        .map(|v| v.into_text(&self.convfmt()))
                        .unwrap_or_default()
                } else {
                    let fmt = self.convfmt();
                    let sep = special(&self.globals, SUBSEP);
                    let texts: Vec<Cow<[u8]>> = parts.iter().map(|v| v.text(&fmt)).collect();
                    let len = texts.iter().map(|text| text.len()).sum::<usize>()
                        + sep.len().saturating_mul(count - 1);
                    if len > MAX_LEN {
                        return Err(no_memory());
                    }
                    texts.join(sep.as_ref())
                };
                self.stack.push(Value::Str(key));
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
                self.arrays.items[id].clear();
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
                let right = self.pop();
                let left = self.pop();
                let fmt = self.convfmt();
                let mut text = left.into_text(&fmt);
                let right = right.text(&fmt);
                if text.len() + right.len() > MAX_LEN {
                    return Err(no_memory());
                }
                text.extend_from_slice(&right);
                drop(right);
                drop(fmt);
                self.stack.push(Value::Str(text));
            }
            Op::Compare(cmp) => {
                let right = self.pop();
                let left = self.pop();
                let order = compare(&left, &right, &self.convfmt());
                let hit = match cmp {
                    Cmp::Lt => order.is_lt(),
                    Cmp::Le => order.is_le(),
                    Cmp::Gt => order.is_gt(),
                    Cmp::Ge => order.is_ge(),
                    Cmp::Eq => order.is_eq(),
                    Cmp::Ne => order.is_ne(),
                };
                self.stack.push(num(hit));
            }
            Op::Match(negated) => {
                let pattern = self.pop_text();
                let subject = self.pop_text();
                let regex = self.regexes.get(&pattern)?;
                let found = unbounded(|budget| regex.find(&subject, 0, budget)).is_some();
                self.stack.push(num(found != negated));
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
                let frame = self.frames.pop().expect("a return runs in a call");
                self.stack.truncate(frame.stack);
                self.locals.truncate(frame.locals);
                self.iters.truncate(frame.iters);
                for id in frame.arrays {
                    self.arrays.release(id);
                }
                self.stack.push(value);
                self.pc = frame.ret;
            }
            Op::Fatal(at) => return Err(self.code.strings[at as usize].clone()),
            Op::Print(formatted, count, redirect) => {
                return self.print(formatted, count as usize, redirect);
            }
            Op::Getline(kind, target) => return self.getline(kind, target),
            Op::ForIn(arr) => {
                let id = self.array(arr);
                let keys = self.arrays.items[id].keys();
                self.iters.push(Iter { keys, at: 0 });
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
                self.iters.pop();
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
                let at = memchr::memmem::find(&haystack, &needle).map_or(0, |at| at + 1);
                self.stack.push(Value::Num(at as f64));
            }
            Op::Substr(has_length) => {
                let length = has_length.then(|| self.pop().num());
                let start = self.pop().num();
                let subject = self.pop_text();
                let part = substr(&subject, start, length).to_vec();
                self.stack.push(Value::Str(part));
            }
            Op::Case(upper) => {
                let mut text = self.pop_text();
                if upper {
                    text.make_ascii_uppercase();
                } else {
                    text.make_ascii_lowercase();
                }
                self.stack.push(Value::Str(text));
            }
            Op::Sprintf(count) => {
                let args = self.stack.split_off(self.stack.len() - count as usize);
                let fmt = self.convfmt();
                let format = args[0].text(&fmt);
                let text = sprintf(&format, &args[1..], &fmt)?;
                drop(fmt);
                self.stack.push(Value::Str(text));
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
                let len = match array {
                    Some(id) => self.arrays.items[id].len(),
                    None => {
                        let value = self.load(var)?;
                        value.text(&self.convfmt()).len()
                    }
                };
                self.stack.push(Value::Num(len as f64));
            }
            Op::MatchFn => {
                let pattern = self.pop_text();
                let subject = self.pop_text();
                let regex = self.regexes.get(&pattern)?;
                let (start, length) = match unbounded(|budget| regex.find(&subject, 0, budget)) {
                    Some((from, to)) => (from as f64 + 1.0, (to - from) as f64),
                    None => (0.0, -1.0),
                };
                self.globals[RSTART as usize].scalar = Some(Value::Num(start));
                self.globals[RLENGTH as usize].scalar = Some(Value::Num(length));
                self.stack.push(Value::Num(start));
            }
            Op::SubVar(var, global) => {
                let subject = self.load(var)?;
                let subject = subject.into_text(&self.convfmt());
                if let Some(result) = self.substitute(&subject, global)? {
                    self.store(var, Value::Str(result))?;
                }
            }
            Op::SubField(global) => {
                let index = to_int(self.pop().num());
                let subject = self.get_field(index)?.into_text(&self.convfmt());
                if let Some(result) = self.substitute(&subject, global)? {
                    self.set_field(index, result)?;
                }
            }
            Op::SubElem(arr, global) => {
                let key = self.pop_text();
                let id = self.array(arr);
                let subject = self.arrays.items[id].entry(&key, || Value::Uninit).clone();
                let subject = subject.into_text(&self.convfmt());
                if let Some(result) = self.substitute(&subject, global)? {
                    self.arrays.items[id].insert(key, Value::Str(result));
                }
            }
            Op::SubValue(global) => {
                let subject = self.pop_text();
                if self.substitute(&subject, global)?.is_some() {
                    return Err(b"awk: assignment to a non-lvalue".to_vec());
                }
            }
            Op::Split(arr, has_separator) => {
                let separator = if has_separator {
                    self.pop_text()
                } else {
                    special(&self.globals, FS).into_owned()
                };
                let subject = self.pop_text();
                let mut parts = Vec::new();
                split(&subject, &separator, false, &mut self.regexes, &mut parts)?;
                let id = self.array(arr);
                let array = &mut self.arrays.items[id];
                array.clear();
                for (position, &(start, end)) in parts.iter().enumerate() {
                    let key = (position + 1).to_string().into_bytes();
                    array.insert(key, strnum(subject[start..end].to_vec()));
                }
                self.stack.push(Value::Num(parts.len() as f64));
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
            Op::NextMain => match self.next_main()? {
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

    /// A sub or gsub over `subject` with the expression and replacement on
    /// the stack: the result when anything was replaced; the count goes on
    /// the stack.
    fn substitute(&mut self, subject: &[u8], global: bool) -> Result<Option<Vec<u8>>, Vec<u8>> {
        let template = self.pop_text();
        let pattern = self.pop_text();
        let regex = self.regexes.get(&pattern)?;
        let (count, result) =
            substitute(regex, &template, subject, global).ok_or_else(no_memory)?;
        self.stack.push(Value::Num(count as f64));
        Ok((count > 0).then_some(result))
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
        self.globals[FILENAME as usize].scalar = Some(Value::Str(name.clone()));
        self.main_name = name;
        self.fnr = 0.0;
    }

    /// Advance the main input to the next operand that names a file,
    /// reading ARGV as it stands when each is reached: an emptied or
    /// deleted slot is skipped, a `var=value` one assigned there. With no
    /// file operand the input is stdin, `-` in FILENAME (mawk 1.3.4).
    fn open_operand(&mut self) -> Result<bool, Vec<u8>> {
        let argv = self.array(Arr::Global(ARGV));
        loop {
            let argc = to_int(self.load(Var::Global(ARGC))?.num());
            if (self.arg_index as i128) + 1 >= argc {
                break;
            }
            self.arg_index += 1;
            let key = self.arg_index.to_string().into_bytes();
            let Some(slot) = self.arrays.items[argv].get(&key) else {
                continue;
            };
            let operand = slot.text(&self.convfmt()).into_owned();
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
                }
                continue;
            }
            self.read_operand = true;
            self.start_file(operand.clone());
            let fd = self.io.fd();
            self.io.main = Some(Reader::new(
                fd,
                Some((operand, Opening::Operand(self.arg_index))),
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
    fn next_main(&mut self) -> Result<Option<bool>, Vec<u8>> {
        Ok(self.next_main_record()?.map(|record| match record {
            Some((start, end)) => {
                let main = self
                    .io
                    .main
                    .take()
                    .expect("a record came from the main input");
                self.set_record(&main.buf[start..end]);
                self.io.main = Some(main);
                true
            }
            None => false,
        }))
    }

    fn next_main_record(&mut self) -> Result<Option<Option<(usize, usize)>>, Vec<u8>> {
        loop {
            if let Some(main) = &mut self.io.main {
                let rs = special(&self.globals, RS);
                match main.next(&rs, &mut self.regexes)? {
                    Next::Record(start, end) => {
                        self.nr += 1.0;
                        self.fnr += 1.0;
                        return Ok(Some(Some((start, end))));
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
                    Next::Pending => {
                        let request = main.read();
                        self.io.read(request);
                        return Ok(None);
                    }
                }
            }
            if !self.open_operand()? {
                return Ok(Some(None));
            }
        }
    }

    /// Push a getline's result: its status, then the record when it has a
    /// target, else the record becomes `$0`.
    fn getline_result(&mut self, record: Option<Vec<u8>>, failed: bool, target: bool) {
        let status = match (&record, failed) {
            (_, true) => -1.0,
            (Some(_), _) => 1.0,
            (None, _) => 0.0,
        };
        self.stack.push(Value::Num(status));
        match (record, target) {
            (Some(record), true) => self.stack.push(strnum(record)),
            (Some(record), false) => self.set_record(&record),
            (None, true) => self.stack.push(Value::Uninit),
            (None, false) => {}
        }
    }

    /// A plain getline reads the main input and counts NR and FNR; a file
    /// or a command does not, as in mawk 1.3.4. A file that cannot be read
    /// answers -1 without a message.
    fn getline(&mut self, kind: GetlineKind, target: bool) -> Step {
        match kind {
            GetlineKind::Plain => match self.next_main_record()? {
                None => self.wait(0),
                Some(found) => {
                    let record = found.and_then(|(start, end)| {
                        self.io
                            .main
                            .as_ref()
                            .map(|main| main.buf[start..end].to_vec())
                    });
                    self.getline_result(record, false, target);
                    Ok(())
                }
            },
            GetlineKind::File => {
                let name = self.top_text();
                let rs = special(&self.globals, RS).into_owned();
                if !self.io.files_in.contains(&name) {
                    let fd = self.io.fd();
                    let reader = Reader::new(fd, Some((name.clone(), Opening::Name)));
                    self.io.files_in.insert(name.clone(), reader);
                }
                let reader = self.io.files_in.get_mut(&name).expect("just opened");
                match reader.next(&rs, &mut self.regexes)? {
                    Next::Pending => {
                        let request = reader.read();
                        self.io.read(request);
                        self.wait(0)
                    }
                    next => {
                        let record = match next {
                            Next::Record(start, end) => Some(reader.buf[start..end].to_vec()),
                            _ => None,
                        };
                        let failed = matches!(next, Next::Failed(_));
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
                        command,
                        stdin: None,
                        stdout: Some(fd),
                    });
                    return self.wait(1);
                }
                let rs = special(&self.globals, RS).into_owned();
                let (reader, _) = self.io.pipes_in.get_mut(&command).expect("just checked");
                match reader.next(&rs, &mut self.regexes)? {
                    Next::Pending => {
                        let request = reader.read();
                        self.io.read(request);
                        self.wait(0)
                    }
                    next => {
                        let record = match next {
                            Next::Record(start, end) => Some(reader.buf[start..end].to_vec()),
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

    /// The text a print or printf statement writes.
    fn render(&mut self, formatted: bool, args: &[Value]) -> Result<Vec<u8>, Vec<u8>> {
        let fmt = self.convfmt();
        if formatted {
            let Some(format) = args.first() else {
                return Err(b"awk: printf needs a format".to_vec());
            };
            return sprintf(&format.text(&fmt), &args[1..], &fmt);
        }
        let mut body = if args.is_empty() {
            drop(fmt);
            self.record_text()?.to_vec()
        } else {
            let ofmt = special(&self.globals, OFMT);
            let ofs = special(&self.globals, OFS);
            let mut body = Vec::new();
            for (at, arg) in args.iter().enumerate() {
                let text = match arg {
                    Value::Num(n) => Cow::Owned(format_num(*n, &ofmt)),
                    other => other.text(&fmt),
                };
                let sep: &[u8] = if at > 0 { &ofs } else { &[] };
                if body.len() + sep.len() + text.len() > MAX_LEN {
                    return Err(no_memory());
                }
                body.extend_from_slice(sep);
                body.extend_from_slice(&text);
            }
            body
        };
        body.extend_from_slice(&special(&self.globals, ORS));
        Ok(body)
    }

    /// print and printf. A file opened with `>` is emptied when it is
    /// opened, and what is printed to it waits until a flush, a close or
    /// the end of a record, so reading it back before closing it reads
    /// what was flushed.
    fn print(&mut self, formatted: bool, count: usize, redirect: Option<RedirKind>) -> Step {
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
                    && name != STDERR_NAME
                    && !self.io.files_out.contains(name)
                {
                    self.io.files_out.insert(name.clone(), OutFile::default());
                    if kind == RedirKind::File {
                        self.io.push(Request::Write {
                            path: name.clone(),
                            mode: WriteMode::Truncate,
                            data: Vec::new(),
                        });
                        return self.wait(1);
                    }
                }
            }
        }
        self.stage = 0;
        let base = self.stack.len() - count - usize::from(redirect.is_some());
        let args = self.stack.split_off(base);
        let body = self.render(formatted, &args[..count])?;
        let Some((kind, name)) = redirect.zip(name) else {
            self.io.stdout(&body);
            return Ok(());
        };
        if kind == RedirKind::Pipe {
            let pipe = self.io.pipes_out.get_mut(&name).expect("opened above");
            pipe.buf.extend_from_slice(&body);
            if pipe.buf.len() >= LIMIT {
                let (fd, data) = (pipe.fd, std::mem::take(&mut pipe.buf));
                self.io.push(Request::Spool { fd, data });
            }
        } else if STDOUT_NAMES.contains(&name.as_slice()) {
            self.io.stdout(&body);
        } else if name == STDERR_NAME {
            self.io.err.extend_from_slice(&body);
        } else if let Some(file) = self.io.files_out.get_mut(&name) {
            file.buf.extend_from_slice(&body);
            if file.buf.len() >= LIMIT {
                self.io.send_file(&name);
            }
        }
        Ok(())
    }

    /// Run an output pipe's command on everything printed to it.
    fn close_pipe(&mut self, command: Vec<u8>, pipe: OutPipe) {
        if !pipe.buf.is_empty() {
            self.io.push(Request::Spool {
                fd: pipe.fd,
                data: pipe.buf,
            });
        }
        self.io.send_files();
        self.io.run(Request::Run {
            command,
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
                    path: Some(name.clone()),
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
                Vec::new()
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
                self.io.push(Request::Flush { path: Some(name) });
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
                command,
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
