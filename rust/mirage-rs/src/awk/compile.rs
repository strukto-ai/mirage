use std::collections::HashMap;

use super::parser::{Cmp, Expr, GetlineKind, Program, RedirKind, RuleKind, Stmt};

/// A scalar: a global, a function's parameter, or a counter the record
/// keeps.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Var {
    Global(u32),
    Local(u32),
    Nf,
    Nr,
    Fnr,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Arr {
    Global(u32),
    Local(u32),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Math {
    Sin,
    Cos,
    Exp,
    Sqrt,
    Log,
    Int,
}

/// One instruction. Operands come off the value stack, the last pushed on
/// top; an lvalue's address (a field index, or an element's key) sits
/// below the value a store takes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Op {
    Num(f64),
    Str(u32),
    Uninit,
    /// Whether the expression matches `$0`.
    MatchRecord(u32),
    Load(Var),
    Store(Var),
    IncDec(Var, f64, bool),
    LoadField,
    StoreField,
    IncDecField(f64, bool),
    /// Join this many subscripts with SUBSEP into one key.
    Key(u32),
    LoadElem(Arr),
    StoreElem(Arr),
    IncDecElem(Arr, f64, bool),
    In(Arr),
    Delete(Arr),
    DeleteAll(Arr),
    Pop,
    Dup,
    Swap,
    Arith(u8),
    /// `op=`, whose division by zero is worded apart.
    ArithAssign(u8),
    Neg,
    ToNum,
    Not,
    Truth,
    Concat,
    Compare(Cmp),
    /// `~`, or `!~` when true: the subject, then the expression's text.
    Match(bool),
    Jump(u32),
    JumpIfFalse(u32),
    /// Jump when the top is unset (a getline that read nothing), leaving it.
    JumpIfUninit(u32),
    /// A bare name passed to a function: its array when it holds one or
    /// was never assigned, else its value.
    Arg(Var),
    Call(u32, u32),
    Return,
    Fatal(u32),
    /// print (or printf when true): the arguments, then a redirection's
    /// target.
    Print(bool, u32, Option<RedirKind>),
    /// Plain, file and command getline; when true, push the record after
    /// the status instead of setting `$0`.
    Getline(GetlineKind, bool),
    ForIn(Arr),
    ForInNext(Var, u32),
    ForInEnd,
    Next,
    NextFile,
    Exit(bool),
    /// Jump unless range rule `n` is active.
    RangeOff(u32, u32),
    RangeEnd(u32),
    RangeStart(u32),
    Math(Math),
    Atan2,
    Rand,
    Srand(bool),
    Index,
    Substr(bool),
    /// toupper when true, tolower otherwise.
    Case(bool),
    Sprintf(u32),
    Length,
    LengthRecord,
    LengthVar(Var),
    MatchFn,
    SubVar(Var, bool),
    SubField(bool),
    SubElem(Arr, bool),
    SubValue(bool),
    Split(Arr, bool),
    Close,
    Fflush(bool),
    System,
    EnterMain,
    NextMain,
    RecordDone,
    Finish,
}

pub(super) struct Function {
    pub(super) entry: usize,
    pub(super) params: usize,
    pub(super) name: Vec<u8>,
}

pub(super) struct Code {
    pub(super) ops: Vec<Op>,
    pub(super) strings: Vec<Vec<u8>>,
    pub(super) functions: Vec<Function>,
    pub(super) globals: HashMap<Vec<u8>, u32>,
    pub(super) global_count: usize,
    pub(super) ranges: usize,
    /// Whether any rule but BEGIN needs the input.
    pub(super) reads_input: bool,
    pub(super) main_pc: usize,
    pub(super) record_done_pc: usize,
    pub(super) end_pc: usize,
    pub(super) finish_pc: usize,
}

/// The globals the run reads by index, in this order.
pub(super) const SPECIALS: [&[u8]; 13] = [
    b"FS",
    b"OFS",
    b"ORS",
    b"RS",
    b"SUBSEP",
    b"CONVFMT",
    b"OFMT",
    b"FILENAME",
    b"RSTART",
    b"RLENGTH",
    b"ARGC",
    b"ARGV",
    b"ENVIRON",
];
pub(super) const FS: u32 = 0;
pub(super) const OFS: u32 = 1;
pub(super) const ORS: u32 = 2;
pub(super) const RS: u32 = 3;
pub(super) const SUBSEP: u32 = 4;
pub(super) const CONVFMT: u32 = 5;
pub(super) const OFMT: u32 = 6;
pub(super) const FILENAME: u32 = 7;
pub(super) const RSTART: u32 = 8;
pub(super) const RLENGTH: u32 = 9;
pub(super) const ARGC: u32 = 10;
pub(super) const ARGV: u32 = 11;
pub(super) const ENVIRON: u32 = 12;

#[derive(Default)]
struct Loop {
    breaks: Vec<usize>,
    continues: Vec<usize>,
}

struct Compiler<'a> {
    ops: Vec<Op>,
    strings: Vec<Vec<u8>>,
    string_index: HashMap<Vec<u8>, u32>,
    globals: HashMap<Vec<u8>, u32>,
    functions: HashMap<&'a [u8], (u32, usize)>,
    params: &'a [Vec<u8>],
    loops: Vec<Loop>,
    ranges: u32,
}

impl<'a> Compiler<'a> {
    fn emit(&mut self, op: Op) -> usize {
        self.ops.push(op);
        self.ops.len() - 1
    }

    fn here(&self) -> u32 {
        self.ops.len() as u32
    }

    /// Point the jump at `at` here.
    fn patch(&mut self, at: usize) {
        let target = self.here();
        match &mut self.ops[at] {
            Op::Jump(to) | Op::JumpIfFalse(to) | Op::JumpIfUninit(to) | Op::RangeOff(_, to) => {
                *to = target;
            }
            Op::ForInNext(_, to) => *to = target,
            _ => unreachable!("only jumps are patched"),
        }
    }

    fn string(&mut self, text: &[u8]) -> u32 {
        if let Some(&index) = self.string_index.get(text) {
            return index;
        }
        let index = self.strings.len() as u32;
        self.strings.push(text.to_vec());
        self.string_index.insert(text.to_vec(), index);
        index
    }

    fn global(&mut self, name: &[u8]) -> u32 {
        let next = self.globals.len() as u32;
        *self.globals.entry(name.to_vec()).or_insert(next)
    }

    fn local(&self, name: &[u8]) -> Option<u32> {
        self.params
            .iter()
            .position(|param| param == name)
            .map(|at| at as u32)
    }

    fn var(&mut self, name: &[u8]) -> Var {
        if let Some(at) = self.local(name) {
            return Var::Local(at);
        }
        match name {
            b"NF" => Var::Nf,
            b"NR" => Var::Nr,
            b"FNR" => Var::Fnr,
            _ => Var::Global(self.global(name)),
        }
    }

    fn arr(&mut self, name: &[u8]) -> Arr {
        match self.local(name) {
            Some(at) => Arr::Local(at),
            None => Arr::Global(self.global(name)),
        }
    }

    fn fatal(&mut self, message: &[u8]) {
        let at = self.string(message);
        self.emit(Op::Fatal(at));
    }

    fn block(&mut self, body: &'a [Stmt]) {
        for stmt in body {
            self.stmt(stmt);
        }
    }

    fn stmt(&mut self, stmt: &'a Stmt) {
        match stmt {
            Stmt::Block(body) => self.block(body),
            Stmt::Expr(expr) => {
                self.expr(expr);
                self.emit(Op::Pop);
            }
            Stmt::Print(formatted, args, redirect) => {
                for arg in args {
                    self.expr(arg);
                }
                if let Some((_, target)) = redirect {
                    self.expr(target);
                }
                self.emit(Op::Print(
                    *formatted,
                    args.len() as u32,
                    redirect.as_ref().map(|(kind, _)| *kind),
                ));
            }
            Stmt::If(cond, then, other) => {
                self.expr(cond);
                let skip = self.emit(Op::JumpIfFalse(0));
                self.stmt(then);
                if let Some(other) = other {
                    let end = self.emit(Op::Jump(0));
                    self.patch(skip);
                    self.stmt(other);
                    self.patch(end);
                } else {
                    self.patch(skip);
                }
            }
            Stmt::While(cond, body) => {
                let top = self.here();
                self.expr(cond);
                let exit = self.emit(Op::JumpIfFalse(0));
                self.loop_body(body, top, |c| {
                    c.emit(Op::Jump(top));
                });
                self.patch(exit);
            }
            Stmt::Do(body, cond) => {
                let top = self.here();
                self.loops.push(Loop::default());
                self.stmt(body);
                let frame = self.loops.pop().unwrap_or_default();
                for at in frame.continues {
                    self.patch(at);
                }
                self.expr(cond);
                let exit = self.emit(Op::JumpIfFalse(0));
                self.emit(Op::Jump(top));
                self.patch(exit);
                for at in frame.breaks {
                    self.patch(at);
                }
            }
            Stmt::For(init, cond, post, body) => {
                if let Some(init) = init {
                    self.stmt(init);
                }
                let top = self.here();
                let exit = cond.as_ref().map(|cond| {
                    self.expr(cond);
                    self.emit(Op::JumpIfFalse(0))
                });
                self.loops.push(Loop::default());
                self.stmt(body);
                let frame = self.loops.pop().unwrap_or_default();
                for at in frame.continues {
                    self.patch(at);
                }
                if let Some(post) = post {
                    self.stmt(post);
                }
                self.emit(Op::Jump(top));
                if let Some(exit) = exit {
                    self.patch(exit);
                }
                for at in frame.breaks {
                    self.patch(at);
                }
            }
            Stmt::ForIn(var, array, body) => {
                let arr = self.arr(array);
                let var = self.var(var);
                self.emit(Op::ForIn(arr));
                let top = self.here();
                let next = self.emit(Op::ForInNext(var, 0));
                self.loop_body(body, top, |c| {
                    c.emit(Op::Jump(top));
                });
                self.patch(next);
                self.emit(Op::ForInEnd);
            }
            Stmt::Next => {
                self.emit(Op::Next);
            }
            Stmt::NextFile => {
                self.emit(Op::NextFile);
            }
            Stmt::Break => {
                let at = self.emit(Op::Jump(0));
                if let Some(frame) = self.loops.last_mut() {
                    frame.breaks.push(at);
                }
            }
            Stmt::Continue => {
                let at = self.emit(Op::Jump(0));
                if let Some(frame) = self.loops.last_mut() {
                    frame.continues.push(at);
                }
            }
            Stmt::Exit(value) => {
                if let Some(value) = value {
                    self.expr(value);
                }
                self.emit(Op::Exit(value.is_some()));
            }
            Stmt::Return(value) => {
                match value {
                    Some(value) => self.expr(value),
                    None => {
                        self.emit(Op::Uninit);
                    }
                }
                self.emit(Op::Return);
            }
            Stmt::Delete(name, subs) => {
                let arr = self.arr(name);
                match subs {
                    Some(subs) => {
                        self.key(subs);
                        self.emit(Op::Delete(arr));
                    }
                    None => {
                        self.emit(Op::DeleteAll(arr));
                    }
                }
            }
        }
    }

    /// A loop's body, `continue` going to `top` and `break` past the
    /// jump `tail` emits.
    fn loop_body(&mut self, body: &'a Stmt, top: u32, tail: impl FnOnce(&mut Self)) {
        self.loops.push(Loop::default());
        self.stmt(body);
        let frame = self.loops.pop().unwrap_or_default();
        for at in frame.continues {
            self.ops[at] = Op::Jump(top);
        }
        tail(self);
        for at in frame.breaks {
            self.patch(at);
        }
    }

    fn key(&mut self, subs: &'a [Expr]) {
        for sub in subs {
            self.expr(sub);
        }
        self.emit(Op::Key(subs.len() as u32));
    }

    /// An expression in a regex's place: a literal's text, or any other
    /// expression's value.
    fn regex_source(&mut self, expr: &'a Expr) {
        match expr {
            Expr::Regex(pattern) => {
                let at = self.string(pattern);
                self.emit(Op::Str(at));
            }
            other => self.expr(other),
        }
    }

    /// Store the value on top of the stack into an lvalue whose address
    /// is not yet computed, leaving the value.
    fn store(&mut self, target: &'a Expr) {
        match target {
            Expr::Var(name) => {
                let var = self.var(name);
                self.emit(Op::Store(var));
            }
            Expr::Field(index) => {
                self.expr(index);
                self.emit(Op::Swap);
                self.emit(Op::StoreField);
            }
            Expr::Index(name, subs) => {
                let arr = self.arr(name);
                self.key(subs);
                self.emit(Op::Swap);
                self.emit(Op::StoreElem(arr));
            }
            _ => self.fatal(b"awk: assignment to a non-lvalue"),
        }
    }

    fn expr(&mut self, expr: &'a Expr) {
        match expr {
            Expr::Num(value) => {
                self.emit(Op::Num(*value));
            }
            Expr::Str(text) => {
                let at = self.string(text);
                self.emit(Op::Str(at));
            }
            Expr::Regex(pattern) => {
                let at = self.string(pattern);
                self.emit(Op::MatchRecord(at));
            }
            Expr::Var(name) => {
                let var = self.var(name);
                self.emit(Op::Load(var));
            }
            Expr::Field(index) => {
                self.expr(index);
                self.emit(Op::LoadField);
            }
            Expr::Index(name, subs) => {
                let arr = self.arr(name);
                self.key(subs);
                self.emit(Op::LoadElem(arr));
            }
            Expr::Assign(target, None, value) => {
                self.expr(value);
                self.store(target);
            }
            Expr::Assign(target, Some(op), value) => match target.as_ref() {
                Expr::Var(name) => {
                    let var = self.var(name);
                    self.emit(Op::Load(var));
                    self.expr(value);
                    self.emit(Op::ArithAssign(*op));
                    self.emit(Op::Store(var));
                }
                Expr::Field(index) => {
                    self.expr(index);
                    self.emit(Op::Dup);
                    self.emit(Op::LoadField);
                    self.expr(value);
                    self.emit(Op::ArithAssign(*op));
                    self.emit(Op::StoreField);
                }
                Expr::Index(name, subs) => {
                    let arr = self.arr(name);
                    self.key(subs);
                    self.emit(Op::Dup);
                    self.emit(Op::LoadElem(arr));
                    self.expr(value);
                    self.emit(Op::ArithAssign(*op));
                    self.emit(Op::StoreElem(arr));
                }
                _ => self.fatal(b"awk: assignment to a non-lvalue"),
            },
            Expr::Binary(op, left, right) => {
                self.expr(left);
                self.expr(right);
                self.emit(Op::Arith(*op));
            }
            Expr::Unary(op, operand) => {
                self.expr(operand);
                self.emit(if *op == b'-' { Op::Neg } else { Op::ToNum });
            }
            Expr::Concat(left, right) => {
                self.expr(left);
                self.expr(right);
                self.emit(Op::Concat);
            }
            Expr::Compare(cmp, left, right) => {
                self.expr(left);
                self.expr(right);
                self.emit(Op::Compare(*cmp));
            }
            Expr::Match(negated, left, right) => {
                self.expr(left);
                self.regex_source(right);
                self.emit(Op::Match(*negated));
            }
            Expr::Logical(and, left, right) => {
                self.expr(left);
                if *and {
                    let short = self.emit(Op::JumpIfFalse(0));
                    self.expr(right);
                    self.emit(Op::Truth);
                    let end = self.emit(Op::Jump(0));
                    self.patch(short);
                    self.emit(Op::Num(0.0));
                    self.patch(end);
                } else {
                    self.emit(Op::Not);
                    let short = self.emit(Op::JumpIfFalse(0));
                    self.expr(right);
                    self.emit(Op::Truth);
                    let end = self.emit(Op::Jump(0));
                    self.patch(short);
                    self.emit(Op::Num(1.0));
                    self.patch(end);
                }
            }
            Expr::Not(operand) => {
                self.expr(operand);
                self.emit(Op::Not);
            }
            Expr::Cond(cond, then, other) => {
                self.expr(cond);
                let skip = self.emit(Op::JumpIfFalse(0));
                self.expr(then);
                let end = self.emit(Op::Jump(0));
                self.patch(skip);
                self.expr(other);
                self.patch(end);
            }
            Expr::IncDec(pre, delta, target) => match target.as_ref() {
                Expr::Var(name) => {
                    let var = self.var(name);
                    self.emit(Op::IncDec(var, *delta, *pre));
                }
                Expr::Field(index) => {
                    self.expr(index);
                    self.emit(Op::IncDecField(*delta, *pre));
                }
                Expr::Index(name, subs) => {
                    let arr = self.arr(name);
                    self.key(subs);
                    self.emit(Op::IncDecElem(arr, *delta, *pre));
                }
                _ => self.fatal(b"awk: assignment to a non-lvalue"),
            },
            Expr::Call(name, args) => self.call(name, args),
            Expr::Builtin(name, args) => self.builtin(name, args),
            Expr::In(subs, name) => {
                let arr = self.arr(name);
                self.key(subs);
                self.emit(Op::In(arr));
            }
            Expr::Getline(kind, target, source) => {
                if let Some(source) = source {
                    self.expr(source);
                }
                self.emit(Op::Getline(*kind, target.is_some()));
                if let Some(target) = target {
                    let skip = self.emit(Op::JumpIfUninit(0));
                    self.store(target);
                    self.patch(skip);
                    self.emit(Op::Pop);
                }
            }
        }
    }

    fn call(&mut self, name: &[u8], args: &'a [Expr]) {
        let Some(&(index, params)) = self.functions.get(name) else {
            self.fatal(&[b"awk: calling undefined function ", name].concat());
            return;
        };
        // An argument past the parameters is never evaluated.
        let args = &args[..args.len().min(params)];
        for arg in args {
            match arg {
                Expr::Var(name) => {
                    let var = self.var(name);
                    self.emit(Op::Arg(var));
                }
                other => self.expr(other),
            }
        }
        self.emit(Op::Call(index, args.len() as u32));
    }

    fn builtin(&mut self, name: &[u8], args: &'a [Expr]) {
        let op = match name {
            b"length" => match args.first() {
                None => Op::LengthRecord,
                Some(Expr::Var(name)) => {
                    let var = self.var(name);
                    Op::LengthVar(var)
                }
                Some(other) => {
                    self.expr(other);
                    Op::Length
                }
            },
            b"sub" | b"gsub" => return self.sub(name == b"gsub", args),
            b"split" => return self.split(args),
            b"match" => {
                self.expr(&args[0]);
                self.regex_source(&args[1]);
                Op::MatchFn
            }
            _ => {
                for arg in args {
                    self.expr(arg);
                }
                match name {
                    b"sin" => Op::Math(Math::Sin),
                    b"cos" => Op::Math(Math::Cos),
                    b"exp" => Op::Math(Math::Exp),
                    b"sqrt" => Op::Math(Math::Sqrt),
                    b"log" => Op::Math(Math::Log),
                    b"int" => Op::Math(Math::Int),
                    b"atan2" => Op::Atan2,
                    b"rand" => Op::Rand,
                    b"srand" => Op::Srand(!args.is_empty()),
                    b"index" => Op::Index,
                    b"substr" => Op::Substr(args.len() > 2),
                    b"toupper" => Op::Case(true),
                    b"tolower" => Op::Case(false),
                    b"sprintf" => Op::Sprintf(args.len() as u32),
                    b"close" => Op::Close,
                    b"fflush" => Op::Fflush(!args.is_empty()),
                    _ => Op::System,
                }
            }
        };
        self.emit(op);
    }

    fn sub(&mut self, global: bool, args: &'a [Expr]) {
        self.regex_source(&args[0]);
        self.expr(&args[1]);
        match args.get(2) {
            None => {
                self.emit(Op::Num(0.0));
                self.emit(Op::SubField(global));
            }
            Some(Expr::Var(name)) => {
                let var = self.var(name);
                self.emit(Op::SubVar(var, global));
            }
            Some(Expr::Field(index)) => {
                self.expr(index);
                self.emit(Op::SubField(global));
            }
            Some(Expr::Index(name, subs)) => {
                let arr = self.arr(name);
                self.key(subs);
                self.emit(Op::SubElem(arr, global));
            }
            Some(other) => {
                self.expr(other);
                self.emit(Op::SubValue(global));
            }
        }
    }

    fn split(&mut self, args: &'a [Expr]) {
        self.expr(&args[0]);
        let arr = match &args[1] {
            Expr::Var(name) | Expr::Index(name, _) => self.arr(name),
            _ => {
                self.fatal(b"awk: split() needs an array");
                return;
            }
        };
        if let Some(separator) = args.get(2) {
            self.regex_source(separator);
        }
        self.emit(Op::Split(arr, args.len() > 2));
    }

    /// A main rule: its pattern decides, then its action runs, or `$0`
    /// prints when it has none.
    fn rule(
        &mut self,
        kind: RuleKind,
        pattern: Option<&'a Expr>,
        end: Option<&'a Expr>,
        action: Option<&'a [Stmt]>,
    ) {
        let mut skip = None;
        match (kind, pattern, end) {
            (RuleKind::Pattern, Some(pattern), _) => {
                self.expr(pattern);
                skip = Some(self.emit(Op::JumpIfFalse(0)));
            }
            (RuleKind::Range, Some(pattern), Some(end)) => {
                let index = self.ranges;
                self.ranges += 1;
                let off = self.emit(Op::RangeOff(index, 0));
                self.expr(end);
                self.emit(Op::RangeEnd(index));
                let fire = self.emit(Op::Jump(0));
                self.patch(off);
                self.expr(pattern);
                skip = Some(self.emit(Op::JumpIfFalse(0)));
                self.expr(end);
                self.emit(Op::RangeStart(index));
                self.patch(fire);
            }
            _ => {}
        }
        match action {
            Some(action) => self.block(action),
            None => {
                self.emit(Op::Print(false, 0, None));
            }
        }
        if let Some(skip) = skip {
            self.patch(skip);
        }
    }
}

/// Compile a parsed program: BEGIN, the record loop, END, then each
/// function's body.
pub(super) fn compile(program: &Program) -> Code {
    let mut compiler = Compiler {
        ops: Vec::new(),
        strings: Vec::new(),
        string_index: HashMap::new(),
        globals: HashMap::new(),
        functions: HashMap::new(),
        params: &[],
        loops: Vec::new(),
        ranges: 0,
    };
    for name in SPECIALS {
        compiler.global(name);
    }
    for (index, function) in program.functions.iter().enumerate() {
        compiler
            .functions
            .insert(&function.name, (index as u32, function.params.len()));
    }
    let edges = |kind| program.rules.iter().filter(move |rule| rule.kind == kind);
    for rule in edges(RuleKind::Begin) {
        compiler.block(rule.action.as_deref().unwrap_or_default());
    }
    compiler.emit(Op::EnterMain);
    let main_pc = compiler.ops.len();
    compiler.emit(Op::NextMain);
    for rule in &program.rules {
        if !matches!(rule.kind, RuleKind::Begin | RuleKind::End) {
            compiler.rule(
                rule.kind,
                rule.pattern.as_ref(),
                rule.end.as_ref(),
                rule.action.as_deref(),
            );
        }
    }
    let record_done_pc = compiler.ops.len();
    compiler.emit(Op::RecordDone);
    let end_pc = compiler.ops.len();
    for rule in edges(RuleKind::End) {
        compiler.block(rule.action.as_deref().unwrap_or_default());
    }
    let finish_pc = compiler.ops.len();
    compiler.emit(Op::Finish);
    let mut functions = Vec::new();
    for function in &program.functions {
        compiler.params = &function.params;
        let entry = compiler.ops.len();
        compiler.block(&function.body);
        compiler.emit(Op::Uninit);
        compiler.emit(Op::Return);
        functions.push(Function {
            entry,
            params: function.params.len(),
            name: function.name.clone(),
        });
    }
    Code {
        ops: compiler.ops,
        strings: compiler.strings,
        functions,
        global_count: compiler.globals.len(),
        globals: compiler.globals,
        ranges: compiler.ranges as usize,
        reads_input: program
            .rules
            .iter()
            .any(|rule| rule.kind != RuleKind::Begin),
        main_pc,
        record_done_pc,
        end_pc,
        finish_pc,
    }
}
