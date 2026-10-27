// Adapted from jq 1.8.2 (MIT), src/execute.c and src/exec_stack.h. See licenses/third_party/jq.txt.

use std::sync::Arc;

use super::builtin::{self, Cfunc, Fault};
use super::host::{self, Answer, Host};
use super::time::{self, Clock};
use super::value::{Object, Value, shed};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Target {
    Param(usize),
    New(usize),
}

/// A closure operand: the frame `level` hops up the static chain, and
/// either one of its parameter closures or one of its subfunctions.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ClosureRef {
    pub(crate) level: usize,
    pub(crate) target: Target,
}

/// A variable operand: the frame `level` hops up, and its local slot.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Var {
    pub(crate) level: usize,
    pub(crate) index: usize,
}

#[derive(Debug)]
pub(crate) enum Op {
    LoadK(Value),
    PushKUnder(Value),
    ErrorK(Value),
    Dup,
    DupN,
    Pop,
    SubexpBegin,
    SubexpEnd,
    LoadV(Var),
    LoadVN(Var),
    StoreV(Var),
    StoreVN(Var),
    Append(Var),
    Index,
    IndexOpt,
    Each,
    EachOpt,
    Fork(usize),
    DestructureAlt(usize),
    TryBegin(usize),
    TryEnd,
    Jump(usize),
    JumpF(usize),
    Backtrack,
    Insert,
    Range(Var),
    PathBegin,
    PathEnd,
    GenLabel,
    CallBuiltin(Cfunc, usize),
    CallJq(ClosureRef, Vec<ClosureRef>),
    TailCallJq(ClosureRef, Vec<ClosureRef>),
    Ret,
}

#[derive(Debug, Default)]
pub(crate) struct Bytecode {
    pub(crate) ops: Vec<Op>,
    pub(crate) nlocals: usize,
    pub(crate) subfunctions: Vec<usize>,
}

/// Bytecode 0 is the top-level program.
#[derive(Debug, Default)]
pub(crate) struct Program {
    pub(crate) bytecodes: Vec<Bytecode>,
}

/// An error in flight: jq's invalid-with-message, which `try` wraps when
/// the error came from past its body.
#[derive(Clone, Debug)]
pub(crate) enum Raise {
    Error(Value),
    Wrapped(Box<Raise>),
}

type Ptr = usize;

#[derive(Clone, Copy)]
struct Closure {
    bc: usize,
    env: Ptr,
}

struct Frame {
    bc: usize,
    env: Ptr,
    retdata: Ptr,
    retaddr: Option<usize>,
    closures: Vec<Closure>,
    locals: Vec<Value>,
}

struct Fork {
    saved_data: Ptr,
    saved_frame: Ptr,
    path_len: usize,
    value_at_path: Value,
    subexp_nest: usize,
    ret: usize,
}

enum Block {
    Value(Value),
    Frame(Frame),
    Fork(Fork),
}

struct Entry {
    next: Ptr,
    block: Block,
}

/// jq's stack: a forest of blocks in one arena. A block is freed only when
/// it is the newest, so a fork point keeps everything below it alive and
/// popping beneath one copies instead of freeing. Pointer 0 is "none";
/// block `p` lives at `entries[p - 1]`.
#[derive(Default)]
struct Arena {
    entries: Vec<Entry>,
}

impl Arena {
    fn will_free(&self, p: Ptr) -> bool {
        p == self.entries.len()
    }

    fn push(&mut self, next: Ptr, block: Block) -> Ptr {
        self.entries.push(Entry { next, block });
        self.entries.len()
    }

    fn next(&self, p: Ptr) -> Ptr {
        self.entries[p - 1].next
    }

    fn take(&mut self, p: Ptr) -> Option<Block> {
        if self.will_free(p) {
            self.entries.pop().map(|entry| entry.block)
        } else {
            None
        }
    }

    fn frame(&self, p: Ptr) -> &Frame {
        match &self.entries[p - 1].block {
            Block::Frame(frame) => frame,
            _ => unreachable!("not a frame"),
        }
    }

    fn frame_mut(&mut self, p: Ptr) -> &mut Frame {
        match &mut self.entries[p - 1].block {
            Block::Frame(frame) => frame,
            _ => unreachable!("not a frame"),
        }
    }

    fn value_mut(&mut self, p: Ptr) -> &mut Value {
        match &mut self.entries[p - 1].block {
            Block::Value(value) => value,
            _ => unreachable!("not a value"),
        }
    }
}

/// What `halt` and `halt_error` leave: the message to print, if any, and
/// the exit code.
#[derive(Debug)]
pub(crate) struct Halt {
    pub(crate) message: Option<Value>,
    pub(crate) code: Option<f64>,
}

pub(crate) enum Next {
    Output(Value),
    Error(Raise),
    Halt(Halt),
    Done,
    Paused,
    /// `input` waits on the host's reply.
    Input,
}

enum Flow {
    Go,
    Backtrack,
    Raise(Raise),
    Yield(Value),
    Input,
}

/// Limits one run is held to.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// Stack blocks (values, frames, fork points) alive at once.
    pub(crate) blocks: usize,
    /// Elements one array may hold.
    pub(crate) items: usize,
    /// Bytes one string may hold.
    pub(crate) bytes: usize,
}

/// One run of a program over one input. Every piece of state jq keeps in
/// `jq_state` or in `jq_next`'s locals is a field here, so `next` can
/// stop between any two instructions and pick up where it stopped.
pub(crate) struct Vm {
    program: Arc<Program>,
    arena: Arena,
    stk_top: Ptr,
    curr_frame: Ptr,
    fork_top: Ptr,
    subexp_nest: usize,
    path: Value,
    value_at_path: Value,
    error: Option<Raise>,
    halted: Option<Halt>,
    next_label: u64,
    pc: usize,
    backtracking: bool,
    restore: bool,
    initial: bool,
    limits: Limits,
    teardown: Vec<Vec<Value>>,
    clock: Clock,
    pub(crate) steps: u64,
    pub(crate) host: Host,
}

impl Vm {
    pub(crate) fn start(program: Arc<Program>, input: Value, limits: Limits) -> Self {
        let nlocals = program.bytecodes[0].nlocals;
        let mut vm = Self {
            program,
            arena: Arena::default(),
            stk_top: 0,
            curr_frame: 0,
            fork_top: 0,
            subexp_nest: 0,
            path: Value::Null,
            value_at_path: Value::Null,
            error: None,
            halted: None,
            next_label: 0,
            pc: 0,
            backtracking: false,
            restore: true,
            initial: true,
            limits,
            teardown: Vec::new(),
            clock: Clock::default(),
            steps: 0,
            host: Host::default(),
        };
        vm.curr_frame = vm.arena.push(
            0,
            Block::Frame(Frame {
                bc: 0,
                env: 0,
                retdata: 0,
                retaddr: None,
                closures: Vec::new(),
                locals: vec![Value::Null; nlocals],
            }),
        );
        vm.push(input);
        vm.save(0, (vm.stk_top, vm.curr_frame));
        vm
    }

    /// Hand the run the host's clock and time zone.
    pub(crate) fn set_clock(&mut self, clock: Clock) {
        self.clock = clock;
    }

    #[cfg(test)]
    pub(crate) fn blocks(&self) -> usize {
        self.arena.entries.len()
    }

    /// Free up to `count` nodes: stack blocks newest first, then the
    /// values they held, one container level at a time, so a deep or wide
    /// value is freed across calls too. True once nothing is left.
    /// Cancellation retires a run this way, a bounded slice at a time.
    pub(crate) fn retire(&mut self, count: usize) -> bool {
        for _ in 0..count {
            if let Some(chunk) = self.teardown.last_mut() {
                match chunk.pop() {
                    Some(value) => {
                        let children = shed(value);
                        if !children.is_empty() {
                            self.teardown.push(children);
                        }
                    }
                    None => {
                        self.teardown.pop();
                    }
                }
                continue;
            }
            let values = match self.arena.entries.pop() {
                Some(entry) => match entry.block {
                    Block::Value(value) => vec![value],
                    Block::Frame(frame) => frame.locals,
                    Block::Fork(fork) => vec![fork.value_at_path],
                },
                None => vec![
                    std::mem::replace(&mut self.path, Value::Null),
                    std::mem::replace(&mut self.value_at_path, Value::Null),
                ],
            };
            if values.iter().all(|v| matches!(v, Value::Null)) && self.arena.entries.is_empty() {
                break;
            }
            self.teardown.push(values);
        }
        self.arena.entries.is_empty() && self.teardown.is_empty()
    }

    fn push(&mut self, value: Value) {
        self.stk_top = self.arena.push(self.stk_top, Block::Value(value));
    }

    fn pop(&mut self) -> Value {
        let p = self.stk_top;
        let next = self.arena.next(p);
        let value = match self.arena.take(p) {
            Some(Block::Value(value)) => value,
            Some(_) => unreachable!("not a value"),
            None => self.arena.value_mut(p).clone(),
        };
        self.stk_top = next;
        value
    }

    fn popn(&mut self) -> Value {
        let p = self.stk_top;
        let next = self.arena.next(p);
        let value = match self.arena.take(p) {
            Some(Block::Value(value)) => value,
            Some(_) => unreachable!("not a value"),
            None => std::mem::replace(self.arena.value_mut(p), Value::Null),
        };
        self.stk_top = next;
        value
    }

    fn path_len(&self) -> usize {
        match &self.path {
            Value::Array(items) => items.len(),
            _ => 0,
        }
    }

    fn save(&mut self, ret: usize, (data, frame): (Ptr, Ptr)) {
        let fork = Fork {
            saved_data: self.stk_top,
            saved_frame: self.curr_frame,
            path_len: self.path_len(),
            value_at_path: self.value_at_path.clone(),
            subexp_nest: self.subexp_nest,
            ret,
        };
        self.fork_top = self.arena.push(self.fork_top, Block::Fork(fork));
        self.stk_top = data;
        self.curr_frame = frame;
    }

    fn here(&self) -> (Ptr, Ptr) {
        (self.stk_top, self.curr_frame)
    }

    fn frame_pop(&mut self) {
        let p = self.curr_frame;
        let next = self.arena.next(p);
        self.arena.take(p);
        self.curr_frame = next;
    }

    fn unwind(&mut self) -> Option<usize> {
        while !self.arena.will_free(self.fork_top) {
            if self.arena.will_free(self.stk_top) {
                self.pop();
            } else if self.arena.will_free(self.curr_frame) {
                self.frame_pop();
            } else {
                unreachable!("orphaned stack block");
            }
        }
        if self.fork_top == 0 {
            return None;
        }
        let next = self.arena.next(self.fork_top);
        let Some(Block::Fork(fork)) = self.arena.take(self.fork_top) else {
            unreachable!("not a fork point");
        };
        self.stk_top = fork.saved_data;
        self.curr_frame = fork.saved_frame;
        if let Value::Array(items) = &mut self.path {
            Arc::make_mut(items).truncate(fork.path_len);
        }
        self.value_at_path = fork.value_at_path;
        self.subexp_nest = fork.subexp_nest;
        self.fork_top = next;
        Some(fork.ret)
    }

    fn tracking(&self) -> bool {
        self.subexp_nest == 0 && matches!(self.path, Value::Array(_))
    }

    fn path_intact(&self, curr: &Value) -> bool {
        !self.tracking() || curr.identical(&self.value_at_path)
    }

    fn path_append(&mut self, component: Value, value_at_path: Value) {
        if self.tracking() {
            if let Value::Array(items) = &mut self.path {
                Arc::make_mut(items).push(component);
            }
            self.value_at_path = value_at_path;
        }
    }

    fn level(&self, level: usize) -> Ptr {
        let mut frame = self.curr_frame;
        for _ in 0..level {
            frame = self.arena.frame(frame).env;
        }
        frame
    }

    fn local(&mut self, var: Var) -> &mut Value {
        let frame = self.level(var.level);
        &mut self.arena.frame_mut(frame).locals[var.index]
    }

    fn closure(&self, at: ClosureRef) -> Closure {
        let p = self.level(at.level);
        let frame = self.arena.frame(p);
        match at.target {
            Target::New(i) => Closure {
                bc: self.program.bytecodes[frame.bc].subfunctions[i],
                env: p,
            },
            Target::Param(i) => frame.closures[i],
        }
    }

    /// Run until the next output, the end, an error, or `budget` steps.
    pub(crate) fn next(&mut self, budget: &mut u64) -> Next {
        if let Some(halt) = self.halted.take() {
            return Next::Halt(halt);
        }
        if self.restore {
            self.restore = false;
            match self.unwind() {
                Some(pc) => {
                    self.pc = pc;
                    self.backtracking = !self.initial;
                    self.initial = false;
                }
                None => return self.end(),
            }
        }
        let program = Arc::clone(&self.program);
        loop {
            if *budget == 0 {
                return Next::Paused;
            }
            *budget -= 1;
            self.steps += 1;
            if self.arena.entries.len() > self.limits.blocks {
                self.restore = true;
                self.error = None;
                return Next::Error(Raise::Error(Value::string(format!(
                    "jq stack limit of {} blocks exceeded",
                    self.limits.blocks
                ))));
            }
            let bc = self.arena.frame(self.curr_frame).bc;
            let pc = self.pc;
            let op = &program.bytecodes[bc].ops[pc];
            self.pc += 1;
            let backtracking = std::mem::take(&mut self.backtracking);
            let flow = if backtracking {
                let raising = self.error.is_some();
                self.back(op, raising)
            } else {
                self.forward(op, pc, budget)
            };
            match flow {
                Flow::Go => {}
                Flow::Yield(value) => {
                    self.restore = true;
                    return Next::Output(value);
                }
                Flow::Input => return Next::Input,
                Flow::Raise(raise) => {
                    self.error = Some(raise);
                    if let Some(next) = self.backtrack() {
                        return next;
                    }
                }
                Flow::Backtrack => {
                    if let Some(next) = self.backtrack() {
                        return next;
                    }
                }
            }
            if let Some(halt) = self.halted.take() {
                self.restore = true;
                return Next::Halt(halt);
            }
        }
    }

    fn backtrack(&mut self) -> Option<Next> {
        match self.unwind() {
            Some(pc) => {
                self.pc = pc;
                self.backtracking = true;
                None
            }
            None => Some(self.end()),
        }
    }

    fn end(&mut self) -> Next {
        self.restore = true;
        match self.error.take() {
            Some(raise) => Next::Error(raise),
            None => Next::Done,
        }
    }

    fn forward(&mut self, op: &Op, pc: usize, budget: &mut u64) -> Flow {
        match op {
            Op::LoadK(value) => {
                self.pop();
                self.push(value.clone());
            }
            Op::PushKUnder(value) => {
                let top = self.pop();
                self.push(value.clone());
                self.push(top);
            }
            Op::ErrorK(value) => return Flow::Raise(Raise::Error(value.clone())),
            Op::Dup => {
                let value = self.pop();
                self.push(value.clone());
                self.push(value);
            }
            Op::DupN => {
                let value = self.popn();
                self.push(value.clone());
                self.push(value);
            }
            Op::Pop => {
                self.pop();
            }
            Op::SubexpBegin => {
                let value = self.pop();
                self.push(value.clone());
                self.push(value);
                self.subexp_nest += 1;
            }
            Op::SubexpEnd => {
                self.subexp_nest -= 1;
                let a = self.pop();
                let b = self.pop();
                self.push(a);
                self.push(b);
            }
            Op::LoadV(var) => {
                self.pop();
                let value = self.local(*var).clone();
                self.push(value);
            }
            Op::LoadVN(var) => {
                self.popn();
                let value = std::mem::replace(self.local(*var), Value::Null);
                self.push(value);
            }
            Op::StoreVN(var) => {
                self.save(pc, self.here());
                let value = self.pop();
                *self.local(*var) = value;
            }
            Op::StoreV(var) => {
                let value = self.pop();
                *self.local(*var) = value;
            }
            Op::Append(var) => {
                let value = self.pop();
                let items = self.limits.items;
                match self.local(*var) {
                    Value::Array(list) => {
                        if list.len() >= items {
                            return Flow::Raise(Raise::Error(Value::string(format!(
                                "jq array limit of {items} elements exceeded"
                            ))));
                        }
                        Arc::make_mut(list).push(value)
                    }
                    _ => unreachable!("APPEND into a non-array"),
                }
            }
            Op::Insert => {
                let top = self.pop();
                let v = self.pop();
                let k = self.pop();
                let object = self.pop();
                let (Value::Object(mut fields), Value::String(key)) = (object, &k) else {
                    return Flow::Raise(Raise::Error(Value::string(format!(
                        "Cannot use {} ({}) as object key",
                        k.kind(),
                        k.dump_trunc()
                    ))));
                };
                Arc::make_mut(&mut fields).insert(Arc::clone(key), v);
                self.push(Value::Object(fields));
                self.push(top);
            }
            Op::Index | Op::IndexOpt => {
                let t = self.pop();
                let k = self.pop();
                if !self.path_intact(&t) {
                    return Flow::Raise(Raise::Error(Value::string(format!(
                        "Invalid path expression near attempt to access element {} of {}",
                        k.dump_trunc(),
                        t.dump_trunc()
                    ))));
                }
                match builtin::get(&t, &k) {
                    Ok(v) => {
                        self.path_append(k, v.clone());
                        self.push(v);
                    }
                    Err(message) => {
                        if matches!(op, Op::Index) {
                            return Flow::Raise(Raise::Error(message));
                        }
                        return Flow::Backtrack;
                    }
                }
            }
            Op::Each | Op::EachOpt => {
                let container = self.pop();
                if !self.path_intact(&container) {
                    return Flow::Raise(Raise::Error(Value::string(format!(
                        "Invalid path expression near attempt to iterate through {}",
                        container.dump_trunc()
                    ))));
                }
                if !matches!(container, Value::Array(_) | Value::Object(_)) {
                    if matches!(op, Op::Each) {
                        return Flow::Raise(Raise::Error(Value::string(format!(
                            "Cannot iterate over {} ({})",
                            container.kind(),
                            container.dump_trunc()
                        ))));
                    }
                    return Flow::Backtrack;
                }
                return self.each(container, 0, pc);
            }
            Op::Fork(_) | Op::DestructureAlt(_) => self.save(pc, self.here()),
            Op::TryBegin(_) => self.save(pc, self.here()),
            Op::TryEnd => self.save(pc, self.here()),
            Op::Jump(to) => self.pc = *to,
            Op::JumpF(to) => {
                let value = self.pop();
                if !value.truthy() {
                    self.pc = *to;
                }
                self.push(value);
            }
            Op::Backtrack => return Flow::Backtrack,
            Op::Range(var) => return self.range(*var, pc, false),
            Op::PathBegin => {
                let v = self.pop();
                self.push(self.path.clone());
                self.save(pc, self.here());
                self.push(Value::number(self.subexp_nest as f64));
                self.push(self.value_at_path.clone());
                self.push(v.clone());
                self.path = Value::array(Vec::new());
                self.value_at_path = v;
                self.subexp_nest = 0;
            }
            Op::PathEnd => {
                let v = self.pop();
                if !self.path_intact(&v) {
                    return Flow::Raise(Raise::Error(Value::string(format!(
                        "Invalid path expression with result {}",
                        v.dump_trunc()
                    ))));
                }
                let old_value = self.pop();
                let old_nest = self.pop().as_f64().unwrap_or(0.0) as usize;
                let restored = self.pop();
                let path = std::mem::replace(&mut self.path, restored);
                let spos = self.here();
                self.push(path.clone());
                self.save(pc, spos);
                self.push(path);
                self.subexp_nest = old_nest;
                self.value_at_path = old_value;
            }
            Op::GenLabel => {
                let mut label = Object::default();
                label.insert("__jq".into(), Value::number(self.next_label as f64));
                self.next_label += 1;
                self.push(Value::object(label));
            }
            Op::CallBuiltin(f, _) if host::is_host(*f) => {
                let input = self.pop();
                match self.host.call(*f, input) {
                    Answer::Value(value) => self.push(value),
                    Answer::Raise(message) => return Flow::Raise(Raise::Error(message)),
                    Answer::Wait(input) => {
                        self.push(input);
                        self.pc = pc;
                        return Flow::Input;
                    }
                }
            }
            Op::CallBuiltin(f, nargs) => {
                let mut args = Vec::with_capacity(*nargs);
                for _ in 0..*nargs {
                    args.push(self.pop());
                }
                *budget = budget.saturating_sub(builtin::cost(&args));
                let result = match f {
                    Cfunc::GetPath => self.getpath(args),
                    Cfunc::Now
                    | Cfunc::Mktime
                    | Cfunc::Gmtime
                    | Cfunc::Localtime
                    | Cfunc::Strftime
                    | Cfunc::StrfLocaltime
                    | Cfunc::Strptime => time::call(*f, &args, &self.clock),
                    _ => builtin::call(*f, args, self.limits),
                };
                match result {
                    Ok(value) => self.push(value),
                    Err(Fault::Error(message)) => return Flow::Raise(Raise::Error(message)),
                    Err(Fault::Halt(message, code)) => {
                        self.halted = Some(Halt { message, code });
                        self.push(Value::True);
                    }
                }
            }
            Op::CallJq(callee, args) => self.call(*callee, args, false),
            Op::TailCallJq(callee, args) => self.call(*callee, args, true),
            Op::Ret => {
                let value = self.pop();
                let frame = self.arena.frame(self.curr_frame);
                debug_assert_eq!(self.stk_top, frame.retdata);
                match frame.retaddr {
                    Some(ret) => {
                        self.pc = ret;
                        self.frame_pop();
                        self.push(value);
                    }
                    None => {
                        let spos = self.here();
                        self.push(Value::Null);
                        self.save(pc, spos);
                        return Flow::Yield(value);
                    }
                }
            }
        }
        Flow::Go
    }

    fn back(&mut self, op: &Op, raising: bool) -> Flow {
        match op {
            Op::Each | Op::EachOpt => {
                let at = self.pop().as_f64().unwrap_or(0.0) as usize;
                let container = self.pop();
                if raising {
                    return Flow::Backtrack;
                }
                self.each(container, at + 1, self.pc - 1)
            }
            Op::Fork(to) => {
                if raising {
                    return Flow::Backtrack;
                }
                self.pc = *to;
                Flow::Go
            }
            Op::DestructureAlt(next) => {
                if !raising {
                    self.pop();
                    return Flow::Backtrack;
                }
                self.error = None;
                self.pc = *next;
                Flow::Go
            }
            Op::StoreVN(var) => {
                *self.local(*var) = Value::Null;
                Flow::Backtrack
            }
            Op::TryBegin(handler) => {
                if !raising {
                    self.pop();
                    return Flow::Backtrack;
                }
                match self.error.take() {
                    Some(Raise::Wrapped(inner)) => {
                        self.error = Some(*inner);
                        Flow::Backtrack
                    }
                    Some(Raise::Error(message)) => {
                        self.pop();
                        self.push(message);
                        self.pc = *handler;
                        Flow::Go
                    }
                    None => Flow::Backtrack,
                }
            }
            Op::TryEnd => {
                if let Some(raise) = self.error.take() {
                    self.error = Some(Raise::Wrapped(Box::new(raise)));
                }
                Flow::Backtrack
            }
            Op::Range(var) => self.range(*var, self.pc - 1, raising),
            Op::PathBegin | Op::PathEnd => {
                self.path = self.pop();
                Flow::Backtrack
            }
            Op::Ret => Flow::Backtrack,
            _ => unreachable!("no backtrack handler for {op:?}"),
        }
    }

    fn each(&mut self, container: Value, at: usize, pc: usize) -> Flow {
        let (len, key, item) = match &container {
            Value::Array(items) => (
                items.len(),
                Value::number(at as f64),
                items.get(at).cloned(),
            ),
            Value::Object(fields) => match fields.entry(at) {
                Some((k, v)) => (fields.len(), Value::String(Arc::clone(k)), Some(v.clone())),
                None => (fields.len(), Value::Null, None),
            },
            _ => unreachable!("EACH over a scalar"),
        };
        let Some(item) = item else {
            return Flow::Backtrack;
        };
        if at + 1 < len {
            let spos = self.here();
            self.push(container);
            self.push(Value::number(at as f64));
            self.save(pc, spos);
        }
        self.path_append(key, item.clone());
        self.push(item);
        Flow::Go
    }

    fn range(&mut self, var: Var, pc: usize, raising: bool) -> Flow {
        let max = self.pop();
        if raising {
            return Flow::Backtrack;
        }
        let (Some(curr), Some(limit)) = (self.local(var).as_f64(), max.as_f64()) else {
            return Flow::Raise(Raise::Error(Value::string("Range bounds must be numeric")));
        };
        if curr >= limit {
            return Flow::Backtrack;
        }
        let value = std::mem::replace(self.local(var), Value::number(curr + 1.0));
        let spos = self.here();
        self.push(max);
        self.save(pc, spos);
        self.push(value);
        Flow::Go
    }

    fn getpath(&mut self, mut args: Vec<Value>) -> Result<Value, Fault> {
        let path = args.pop().unwrap_or(Value::Null);
        let input = args.pop().unwrap_or(Value::Null);
        let found = builtin::getpath(&input, &path)?;
        if !self.tracking() || !input.identical(&self.value_at_path) {
            return Ok(found);
        }
        if let Value::Array(items) = &mut self.path {
            match &path {
                Value::Array(more) => Arc::make_mut(items).extend(more.iter().cloned()),
                other => Arc::make_mut(items).push(other.clone()),
            }
        }
        self.value_at_path = found.clone();
        Ok(found)
    }

    fn call(&mut self, callee: ClosureRef, args: &[ClosureRef], tail: bool) {
        let input = self.pop();
        let callee = self.closure(callee);
        let closures: Vec<Closure> = args.iter().map(|at| self.closure(*at)).collect();
        let (mut retaddr, mut retdata) = (Some(self.pc), self.stk_top);
        if tail {
            let frame = self.arena.frame(self.curr_frame);
            (retaddr, retdata) = (frame.retaddr, frame.retdata);
            self.frame_pop();
        }
        let nlocals = self.program.bytecodes[callee.bc].nlocals;
        self.curr_frame = self.arena.push(
            self.curr_frame,
            Block::Frame(Frame {
                bc: callee.bc,
                env: callee.env,
                retdata,
                retaddr,
                closures,
                locals: vec![Value::Null; nlocals],
            }),
        );
        self.pc = 0;
        self.push(input);
    }
}
