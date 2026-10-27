// Adapted from jq 1.8.2 (MIT), src/compile.c, src/parser.y and src/builtin.c. See licenses/third_party/jq.txt.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::OnceLock;

use super::builtin::{self, Cfunc, Fault};
use super::check;
use super::syntax::{self, Ast, BinOp, Def, Loc, Parsed, Pattern, PatternKey, Update};
use super::value::{Object, Value};
use super::vm::{Bytecode, ClosureRef, Limits, Op, Program, Target, Var};

const PRELUDE: &str = include_str!("builtin.jq");

const FORMATS: &[&str] = &[
    "text", "json", "csv", "tsv", "html", "uri", "sh", "base64", "base64d",
];

type Library = HashMap<(String, usize), Def>;

fn library() -> Result<&'static Library, String> {
    static LIBRARY: OnceLock<Result<Library, String>> = OnceLock::new();
    LIBRARY
        .get_or_init(|| {
            let defs = syntax::parse_defs(PRELUDE)?;
            Ok(defs
                .into_iter()
                .map(|def| ((def.name.clone(), def.params.len()), def))
                .collect())
        })
        .as_ref()
        .map_err(Clone::clone)
}

enum Bind {
    Var {
        name: String,
        bc: usize,
        index: usize,
    },
    Func {
        name: String,
        arity: usize,
        bc: usize,
        target: Target,
    },
}

struct Scope {
    bind: Bind,
    next: Env,
}

type Env = Option<Rc<Scope>>;

fn with(env: &Env, bind: Bind) -> Env {
    Some(Rc::new(Scope {
        bind,
        next: env.clone(),
    }))
}

fn find_var(env: &Env, wanted: &str) -> Option<(usize, usize)> {
    let mut at = env.as_deref();
    while let Some(scope) = at {
        if let Bind::Var { name, bc, index } = &scope.bind {
            if name == wanted {
                return Some((*bc, *index));
            }
        }
        at = scope.next.as_deref();
    }
    None
}

fn find_func(env: &Env, wanted: &str, want_arity: usize) -> Option<(usize, Target)> {
    let mut at = env.as_deref();
    while let Some(scope) = at {
        if let Bind::Func {
            name,
            arity,
            bc,
            target,
        } = &scope.bind
        {
            if name == wanted && *arity == want_arity {
                return Some((*bc, *target));
            }
        }
        at = scope.next.as_deref();
    }
    None
}

#[derive(Default)]
struct Builder {
    ops: Vec<Op>,
    nlocals: usize,
    subfunctions: Vec<usize>,
    parent: Option<usize>,
}

struct Compiler<'a> {
    bcs: Vec<Builder>,
    globals: &'a HashMap<String, Value>,
    library: &'static Library,
    linked: HashMap<(String, usize), usize>,
    /// The bytecode whose STOREVs become STOREVNs, while a `?//`
    /// alternative other than the last is compiled into it.
    storevn: Option<usize>,
    /// How deep the compiler is in builtin.jq's definitions, whose regex
    /// calls pass their callers' patterns on.
    in_library: usize,
}

/// Why a program does not compile here.
#[derive(Debug)]
pub(crate) enum Refusal {
    /// jq refuses it too: its report, as jq prints it.
    Invalid(String),
    /// jq runs it, but this engine cannot yet: what it lacks.
    Unsupported(String),
}

/// Compile `source` against jq's builtin library. `globals` are the
/// `$name` bindings jq's command line makes (`--arg`, `--argjson`,
/// `$ARGS`). A program jq refuses is reported in jq's words, before
/// anything this engine lacks is.
pub(crate) fn compile(source: &str, globals: &HashMap<String, Value>) -> Result<Program, Refusal> {
    let ast = match syntax::parse(source) {
        Parsed::Program(ast) => ast,
        Parsed::Invalid(messages) => return Err(Refusal::Invalid(syntax::report(&messages))),
        Parsed::Unsupported(why) => return Err(Refusal::Unsupported(why.into())),
    };
    let errors = check::check(&ast, globals, source);
    if !errors.is_empty() {
        return Err(Refusal::Invalid(syntax::report(&errors)));
    }
    let mut compiler = Compiler {
        bcs: vec![Builder::default()],
        globals,
        library: library().map_err(Refusal::Unsupported)?,
        linked: HashMap::new(),
        storevn: None,
        in_library: 0,
    };
    compiler
        .code(0, &ast, &None)
        .map_err(Refusal::Unsupported)?;
    compiler.emit(0, Op::Ret);
    Ok(compiler.finish())
}

fn constant(ast: &Ast) -> Option<Value> {
    match ast {
        Ast::Literal(v) => Some(v.clone()),
        Ast::Collect(None) => Some(Value::array(Vec::new())),
        Ast::Collect(Some(inner)) => {
            let mut items = Vec::new();
            let mut stack = vec![&**inner];
            while let Some(node) = stack.pop() {
                match node {
                    Ast::Comma(a, b) => {
                        stack.push(b);
                        stack.push(a);
                    }
                    Ast::Literal(v) => items.push(v.clone()),
                    _ => return None,
                }
            }
            Some(Value::array(items))
        }
        Ast::Object(pairs) => {
            let mut object = Object::default();
            for (k, v) in pairs {
                let (Ast::Literal(Value::String(key)), Ast::Literal(value)) = (k, v) else {
                    return None;
                };
                object.insert(key.clone(), value.clone());
            }
            Some(Value::object(object))
        }
        _ => None,
    }
}

impl Compiler<'_> {
    fn emit(&mut self, bc: usize, op: Op) -> usize {
        let op = match op {
            Op::StoreV(var) if self.storevn == Some(bc) => Op::StoreVN(var),
            op => op,
        };
        let ops = &mut self.bcs[bc].ops;
        ops.push(op);
        ops.len() - 1
    }

    fn here(&self, bc: usize) -> usize {
        self.bcs[bc].ops.len()
    }

    fn patch(&mut self, bc: usize, at: usize) {
        let to = self.here(bc);
        match &mut self.bcs[bc].ops[at] {
            Op::Fork(t) | Op::DestructureAlt(t) | Op::TryBegin(t) | Op::Jump(t) | Op::JumpF(t) => {
                *t = to
            }
            op => unreachable!("not a branch: {op:?}"),
        }
    }

    fn local(&mut self, bc: usize) -> usize {
        let builder = &mut self.bcs[bc];
        builder.nlocals += 1;
        builder.nlocals - 1
    }

    fn function(&mut self, parent: usize) -> (usize, usize) {
        self.bcs.push(Builder {
            parent: Some(parent),
            ..Builder::default()
        });
        let bc = self.bcs.len() - 1;
        let subs = &mut self.bcs[parent].subfunctions;
        subs.push(bc);
        (bc, subs.len() - 1)
    }

    fn level(&self, from: usize, owner: usize) -> usize {
        let mut level = 0;
        let mut at = from;
        while at != owner {
            at = self.bcs[at].parent.expect("owner is an enclosing bytecode");
            level += 1;
        }
        level
    }

    fn var(&self, bc: usize, owner: usize, index: usize) -> Var {
        Var {
            level: self.level(bc, owner),
            index,
        }
    }

    /// Compile code jq keeps in a closure, out of reach of the STOREV to
    /// STOREVN rewrite: a C function's arguments, which jq inlines only
    /// after parsing, and the bodies of `path`, `last` and `range`.
    fn closed(&mut self, f: impl FnOnce(&mut Self) -> Result<(), String>) -> Result<(), String> {
        let storevn = self.storevn.take();
        let result = f(self);
        self.storevn = storevn;
        result
    }

    fn subexp(&mut self, bc: usize, ast: &Ast, env: &Env) -> Result<(), String> {
        match ast {
            Ast::Identity => {
                self.emit(bc, Op::Dup);
            }
            Ast::Literal(v) => {
                self.emit(bc, Op::PushKUnder(v.clone()));
            }
            _ => {
                self.emit(bc, Op::SubexpBegin);
                self.code(bc, ast, env)?;
                self.emit(bc, Op::SubexpEnd);
            }
        }
        Ok(())
    }

    /// gen_condbranch: JUMP_F over the true branch, which jumps over the
    /// false one.
    fn condbranch(
        &mut self,
        bc: usize,
        iftrue: impl FnOnce(&mut Self) -> Result<(), String>,
        iffalse: impl FnOnce(&mut Self) -> Result<(), String>,
    ) -> Result<(), String> {
        let jumpf = self.emit(bc, Op::JumpF(0));
        iftrue(self)?;
        let jump = self.emit(bc, Op::Jump(0));
        self.patch(bc, jumpf);
        iffalse(self)?;
        self.patch(bc, jump);
        Ok(())
    }

    fn code(&mut self, bc: usize, ast: &Ast, env: &Env) -> Result<(), String> {
        match ast {
            Ast::Identity => {}
            Ast::Recurse => self.call(bc, "recurse", &[], env)?,
            Ast::Literal(v) => {
                self.emit(bc, Op::LoadK(v.clone()));
            }
            Ast::Format(name) => self.call(
                bc,
                "format",
                &[Ast::Literal(Value::string(name.as_str()))],
                env,
            )?,
            Ast::Index(term, key, opt) => {
                self.subexp(bc, key, env)?;
                self.code(bc, term, env)?;
                self.emit(bc, if *opt { Op::IndexOpt } else { Op::Index });
            }
            Ast::Slice(term, from, to, opt) => {
                self.emit(bc, Op::PushKUnder(Value::object(Object::default())));
                for (name, bound) in [("start", from), ("end", to)] {
                    self.emit(bc, Op::PushKUnder(Value::string(name)));
                    match bound {
                        Some(e) => self.subexp(bc, e, env)?,
                        None => {
                            self.emit(bc, Op::PushKUnder(Value::Null));
                        }
                    }
                    self.emit(bc, Op::Insert);
                }
                self.code(bc, term, env)?;
                self.emit(bc, if *opt { Op::IndexOpt } else { Op::Index });
            }
            Ast::Each(term, opt) => {
                self.code(bc, term, env)?;
                self.emit(bc, if *opt { Op::EachOpt } else { Op::Each });
            }
            Ast::Try(body, handler) => {
                let begin = self.emit(bc, Op::TryBegin(0));
                self.code(bc, body, env)?;
                self.emit(bc, Op::TryEnd);
                let jump = self.emit(bc, Op::Jump(0));
                self.patch(bc, begin);
                match handler {
                    Some(h) => self.code(bc, h, env)?,
                    None => {
                        self.emit(bc, Op::Backtrack);
                    }
                }
                self.patch(bc, jump);
            }
            Ast::Neg(e) => {
                self.code(bc, e, env)?;
                self.emit(bc, Op::CallBuiltin(Cfunc::Negate, 1));
            }
            Ast::Pipe(a, b) => {
                self.code(bc, a, env)?;
                self.code(bc, b, env)?;
            }
            Ast::Comma(a, b) => {
                let fork = self.emit(bc, Op::Fork(0));
                self.code(bc, a, env)?;
                let jump = self.emit(bc, Op::Jump(0));
                self.patch(bc, fork);
                self.code(bc, b, env)?;
                self.patch(bc, jump);
            }
            Ast::Binop(op, a, b) => self.binop(bc, *op, a, b, env)?,
            Ast::And(a, b) => {
                self.emit(bc, Op::Dup);
                self.code(bc, a, env)?;
                self.condbranch(
                    bc,
                    |c| {
                        c.emit(bc, Op::Pop);
                        c.code(bc, b, env)?;
                        c.boolean(bc)
                    },
                    |c| {
                        c.emit(bc, Op::Pop);
                        c.emit(bc, Op::LoadK(Value::False));
                        Ok(())
                    },
                )?;
            }
            Ast::Or(a, b) => {
                self.emit(bc, Op::Dup);
                self.code(bc, a, env)?;
                self.condbranch(
                    bc,
                    |c| {
                        c.emit(bc, Op::Pop);
                        c.emit(bc, Op::LoadK(Value::True));
                        Ok(())
                    },
                    |c| {
                        c.emit(bc, Op::Pop);
                        c.code(bc, b, env)?;
                        c.boolean(bc)
                    },
                )?;
            }
            Ast::Alternative(a, b) => self.definedor(bc, a, b, env)?,
            Ast::Update(kind, lhs, rhs) => match kind {
                Update::Assign => {
                    self.call(bc, "_assign", &[(**lhs).clone(), (**rhs).clone()], env)?
                }
                Update::Modify => {
                    self.call(bc, "_modify", &[(**lhs).clone(), (**rhs).clone()], env)?
                }
                Update::Arith(_) | Update::Alternative => {
                    self.emit(bc, Op::Dup);
                    self.code(bc, rhs, env)?;
                    let tmp = self.local(bc);
                    self.emit(
                        bc,
                        Op::StoreV(Var {
                            level: 0,
                            index: tmp,
                        }),
                    );
                    let inner = with(
                        env,
                        Bind::Var {
                            name: "*tmp".into(),
                            bc,
                            index: tmp,
                        },
                    );
                    let value = Box::new(Ast::Var("*tmp".into(), Loc::default()));
                    let update = match kind {
                        Update::Arith(op) => Ast::Binop(*op, Box::new(Ast::Identity), value),
                        _ => Ast::Alternative(Box::new(Ast::Identity), value),
                    };
                    self.call(bc, "_modify", &[(**lhs).clone(), update], &inner)?;
                }
            },
            Ast::If(cond, then, otherwise) => {
                self.emit(bc, Op::Dup);
                self.subexp(bc, cond, env)?;
                self.emit(bc, Op::Pop);
                self.condbranch(
                    bc,
                    |c| {
                        c.emit(bc, Op::Pop);
                        c.code(bc, then, env)
                    },
                    |c| {
                        c.emit(bc, Op::Pop);
                        match otherwise {
                            Some(e) => c.code(bc, e, env),
                            None => Ok(()),
                        }
                    },
                )?;
            }
            Ast::Reduce(source, patterns, init, body) => {
                self.emit(bc, Op::Dup);
                self.code(bc, init, env)?;
                let res = Var {
                    level: 0,
                    index: self.local(bc),
                };
                self.emit(bc, Op::StoreV(res));
                let fork = self.emit(bc, Op::Fork(0));
                self.emit(bc, Op::DupN);
                self.code(bc, source, env)?;
                let inner = self.matchers(bc, patterns, env)?;
                self.emit(bc, Op::LoadVN(res));
                self.code(bc, body, &inner)?;
                self.emit(bc, Op::StoreV(res));
                self.emit(bc, Op::Backtrack);
                self.patch(bc, fork);
                self.emit(bc, Op::LoadVN(res));
            }
            Ast::Foreach(source, patterns, init, update, extract) => {
                self.emit(bc, Op::Dup);
                self.code(bc, init, env)?;
                let state = Var {
                    level: 0,
                    index: self.local(bc),
                };
                self.emit(bc, Op::StoreV(state));
                self.emit(bc, Op::Dup);
                self.code(bc, source, env)?;
                let inner = self.matchers(bc, patterns, env)?;
                self.emit(bc, Op::LoadVN(state));
                self.code(bc, update, &inner)?;
                self.emit(bc, Op::Dup);
                self.emit(bc, Op::StoreV(state));
                if let Some(extract) = extract {
                    self.code(bc, extract, &inner)?;
                }
            }
            Ast::Bind(source, patterns, body) => {
                if patterns.len() > 1 {
                    self.emit(bc, Op::SubexpBegin);
                    self.code(bc, source, env)?;
                    self.emit(bc, Op::Dup);
                    self.emit(bc, Op::SubexpEnd);
                } else {
                    self.emit(bc, Op::Dup);
                    self.subexp(bc, source, env)?;
                }
                self.emit(bc, Op::Pop);
                let inner = self.matchers(bc, patterns, env)?;
                self.code(bc, body, &inner)?;
            }
            Ast::Label(name, body) => {
                self.emit(bc, Op::Dup);
                self.emit(bc, Op::GenLabel);
                let index = self.local(bc);
                self.emit(bc, Op::StoreV(Var { level: 0, index }));
                let label = format!("*label-{name}");
                let inner = with(
                    env,
                    Bind::Var {
                        name: label.clone(),
                        bc,
                        index,
                    },
                );
                self.emit(bc, Op::Pop);
                let handler = Ast::If(
                    Box::new(Ast::Binop(
                        BinOp::Equal,
                        Box::new(Ast::Identity),
                        Box::new(Ast::Var(label, Loc::default())),
                    )),
                    Box::new(Ast::Call("empty".into(), Vec::new(), Loc::default())),
                    Some(Box::new(Ast::Call(
                        "error".into(),
                        Vec::new(),
                        Loc::default(),
                    ))),
                );
                self.code(bc, &Ast::Try(body.clone(), Some(Box::new(handler))), &inner)?;
            }
            Ast::Break(name, _) => {
                let Some((owner, index)) = find_var(env, &format!("*label-{name}")) else {
                    return Err(format!("$*label-{name} is not defined"));
                };
                let var = self.var(bc, owner, index);
                self.emit(bc, Op::LoadV(var));
                self.emit(bc, Op::CallBuiltin(Cfunc::Error, 1));
            }
            Ast::Def(def, rest) => {
                let inner = self.define(bc, def, env)?;
                self.code(bc, rest, &inner)?;
            }
            Ast::Call(name, args, _) => self.call(bc, name, args, env)?,
            Ast::Var(name, _) => match find_var(env, name) {
                Some((owner, index)) => {
                    let var = self.var(bc, owner, index);
                    self.emit(bc, Op::LoadV(var));
                }
                None => match self.globals.get(name) {
                    Some(value) => {
                        self.emit(bc, Op::LoadK(value.clone()));
                    }
                    None => return Err(format!("${name} is not defined")),
                },
            },
            Ast::Collect(inner) => match constant(ast) {
                Some(value) => {
                    self.emit(bc, Op::LoadK(value));
                }
                None => {
                    let Some(inner) = inner else { unreachable!() };
                    self.emit(bc, Op::Dup);
                    self.emit(bc, Op::LoadK(Value::array(Vec::new())));
                    let array = Var {
                        level: 0,
                        index: self.local(bc),
                    };
                    self.emit(bc, Op::StoreV(array));
                    let fork = self.emit(bc, Op::Fork(0));
                    self.code(bc, inner, env)?;
                    self.emit(bc, Op::Append(array));
                    self.emit(bc, Op::Backtrack);
                    self.patch(bc, fork);
                    self.emit(bc, Op::LoadVN(array));
                }
            },
            Ast::Object(pairs) => match constant(ast) {
                Some(value) => {
                    self.emit(bc, Op::LoadK(value));
                }
                None => {
                    self.emit(bc, Op::PushKUnder(Value::object(Object::default())));
                    for (k, v) in pairs {
                        self.subexp(bc, k, env)?;
                        self.subexp(bc, v, env)?;
                        self.emit(bc, Op::Insert);
                    }
                    self.emit(bc, Op::Pop);
                }
            },
        }
        Ok(())
    }

    fn boolean(&mut self, bc: usize) -> Result<(), String> {
        self.condbranch(
            bc,
            |c| {
                c.emit(bc, Op::LoadK(Value::True));
                Ok(())
            },
            |c| {
                c.emit(bc, Op::LoadK(Value::False));
                Ok(())
            },
        )
    }

    fn binop(&mut self, bc: usize, op: BinOp, a: &Ast, b: &Ast, env: &Env) -> Result<(), String> {
        let f = builtin::lookup(op.function(), 2).expect("binop builtin");
        let folds = |x: &Value, y: &Value| {
            !(op == BinOp::Multiply
                && (matches!(x, Value::String(_)) || matches!(y, Value::String(_)))
                || op == BinOp::Minus
                    && matches!(x, Value::Array(_))
                    && matches!(y, Value::Array(_)))
        };
        let constants = match (constant(a), constant(b)) {
            (Some(x), Some(y)) if folds(&x, &y) => Some((x, y)),
            _ => None,
        };
        if let Some((x, y)) = constants {
            let limits = Limits {
                blocks: usize::MAX,
                items: usize::MAX,
                bytes: usize::MAX,
            };
            match builtin::call(f, vec![Value::Null, x, y], limits) {
                Ok(v) => {
                    self.emit(bc, Op::LoadK(v));
                }
                Err(Fault::Error(message)) => {
                    self.emit(bc, Op::ErrorK(message));
                }
                Err(_) => unreachable!("binops neither halt nor backtrack"),
            }
            return Ok(());
        }
        self.closed(|c| {
            c.subexp(bc, b, env)?;
            c.subexp(bc, a, env)
        })?;
        self.emit(bc, Op::CallBuiltin(f, 3));
        Ok(())
    }

    /// gen_definedor: the outputs of `a` that are neither null nor false,
    /// or `b`'s when there are none.
    fn definedor(&mut self, bc: usize, a: &Ast, b: &Ast, env: &Env) -> Result<(), String> {
        let found = Var {
            level: 0,
            index: self.local(bc),
        };
        self.emit(bc, Op::Dup);
        self.emit(bc, Op::LoadK(Value::False));
        self.emit(bc, Op::StoreV(found));
        let fork = self.emit(bc, Op::Fork(0));
        self.code(bc, a, env)?;
        let skip_found = self.emit(bc, Op::JumpF(0));
        self.emit(bc, Op::Dup);
        self.emit(bc, Op::LoadK(Value::True));
        self.emit(bc, Op::StoreV(found));
        let to_end = self.emit(bc, Op::Jump(0));
        self.patch(bc, skip_found);
        self.emit(bc, Op::Backtrack);
        self.patch(bc, fork);
        self.emit(bc, Op::Dup);
        self.emit(bc, Op::LoadV(found));
        let skip_backtrack = self.emit(bc, Op::JumpF(0));
        self.emit(bc, Op::Backtrack);
        self.patch(bc, skip_backtrack);
        self.emit(bc, Op::Pop);
        self.code(bc, b, env)?;
        self.patch(bc, to_end);
        Ok(())
    }

    /// bind_alternation_matchers: destructure the value on top of the
    /// stack by the first of `patterns` that neither fails nor leads to an
    /// error, popping it, and answer the scope that sees their variables.
    /// Every variable an alternative names starts out null, and each
    /// alternative but the last sits behind a DESTRUCTURE_ALT that tries
    /// the next one on an error.
    fn matchers(&mut self, bc: usize, patterns: &[Pattern], env: &Env) -> Result<Env, String> {
        let Some((last, alternatives)) = patterns.split_last() else {
            unreachable!("a binding has a pattern");
        };
        if alternatives.is_empty() {
            return self.matcher(bc, last, env, None);
        }
        let mut names = Vec::new();
        for pattern in patterns {
            pattern_names(pattern, &mut names);
        }
        let mut slots = Vec::with_capacity(names.len());
        let mut inner = env.clone();
        for name in names {
            let index = self.local(bc);
            self.emit(bc, Op::Dup);
            self.emit(bc, Op::LoadK(Value::Null));
            self.emit(bc, Op::StoreV(Var { level: 0, index }));
            inner = with(
                &inner,
                Bind::Var {
                    name: name.clone(),
                    bc,
                    index,
                },
            );
            slots.push((name, index));
        }
        let mut jumps = Vec::with_capacity(alternatives.len());
        for pattern in alternatives {
            let alt = self.emit(bc, Op::DestructureAlt(0));
            let storevn = self.storevn.replace(bc);
            let matched = self.matcher(bc, pattern, &inner, Some(&slots));
            self.storevn = storevn;
            matched?;
            jumps.push(self.emit(bc, Op::Jump(0)));
            self.patch(bc, alt);
        }
        self.matcher(bc, last, &inner, Some(&slots))?;
        for jump in jumps {
            self.patch(bc, jump);
        }
        Ok(inner)
    }

    /// Destructure the value on top of the stack into the pattern's
    /// variables, popping it, and answer the scope that sees them. With
    /// `slots`, each variable is stored into the local named there.
    fn matcher(
        &mut self,
        bc: usize,
        pattern: &Pattern,
        env: &Env,
        slots: Option<&[(String, usize)]>,
    ) -> Result<Env, String> {
        match pattern {
            Pattern::Var(name) => {
                let index = match slots {
                    Some(slots) => slots
                        .iter()
                        .find(|(slot, _)| slot == name)
                        .map(|(_, index)| *index)
                        .expect("every pattern variable has a slot"),
                    None => self.local(bc),
                };
                self.emit(bc, Op::StoreV(Var { level: 0, index }));
                Ok(with(
                    env,
                    Bind::Var {
                        name: name.clone(),
                        bc,
                        index,
                    },
                ))
            }
            Pattern::Array(items) => {
                let mut inner = env.clone();
                for (i, item) in items.iter().enumerate().rev() {
                    self.emit(bc, Op::Dup);
                    self.emit(bc, Op::PushKUnder(Value::number(i as f64)));
                    self.emit(bc, Op::Index);
                    inner = self.matcher(bc, item, &inner, slots)?;
                }
                self.emit(bc, Op::Pop);
                Ok(inner)
            }
            Pattern::Object(fields) => {
                let mut inner = env.clone();
                for (key, sub) in fields {
                    self.emit(bc, Op::Dup);
                    match key {
                        PatternKey::Var(name) => {
                            self.emit(bc, Op::PushKUnder(Value::string(name.as_str())));
                            self.emit(bc, Op::Index);
                            if sub.is_some() {
                                self.emit(bc, Op::Dup);
                            }
                            inner = self.matcher(bc, &Pattern::Var(name.clone()), &inner, slots)?;
                        }
                        PatternKey::Expr(e) => {
                            self.subexp(bc, e, &inner)?;
                            self.emit(bc, Op::Index);
                        }
                    }
                    if let Some(sub) = sub {
                        inner = self.matcher(bc, sub, &inner, slots)?;
                    }
                }
                self.emit(bc, Op::Pop);
                Ok(inner)
            }
        }
    }

    fn body(def: &Def) -> Ast {
        let mut body = def.body.clone();
        for (name, is_var) in def.params.iter().rev() {
            if *is_var {
                body = Ast::Bind(
                    Box::new(Ast::Call(name.clone(), Vec::new(), Loc::default())),
                    vec![Pattern::Var(name.clone())],
                    Box::new(body),
                );
            }
        }
        body
    }

    fn params(def: &Def, bc: usize, env: &Env) -> Env {
        let mut inner = env.clone();
        for (i, (name, _)) in def.params.iter().enumerate() {
            inner = with(
                &inner,
                Bind::Func {
                    name: name.clone(),
                    arity: 0,
                    bc,
                    target: Target::Param(i),
                },
            );
        }
        inner
    }

    fn define(&mut self, bc: usize, def: &Def, env: &Env) -> Result<Env, String> {
        let (fbc, index) = self.function(bc);
        let outer = with(
            env,
            Bind::Func {
                name: def.name.clone(),
                arity: def.params.len(),
                bc,
                target: Target::New(index),
            },
        );
        let inner = Self::params(def, fbc, &outer);
        self.code(fbc, &Self::body(def), &inner)?;
        self.emit(fbc, Op::Ret);
        Ok(outer)
    }

    /// A builtin.jq definition, compiled the first time it is called as a
    /// subfunction of the top level, in a scope of its parameters alone.
    fn link(&mut self, name: &str, arity: usize) -> Result<Option<usize>, String> {
        let key = (name.to_string(), arity);
        if let Some(index) = self.linked.get(&key) {
            return Ok(Some(*index));
        }
        let library = self.library;
        let Some(def) = library.get(&key) else {
            return Ok(None);
        };
        let (fbc, index) = self.function(0);
        self.linked.insert(key, index);
        let inner = Self::params(def, fbc, &None);
        self.in_library += 1;
        let compiled = self.code(fbc, &Self::body(def), &inner);
        self.in_library -= 1;
        compiled?;
        self.emit(fbc, Op::Ret);
        Ok(Some(index))
    }

    /// What a regex call's pattern or modifiers are at compile time: a
    /// literal, or a `--arg`-style global nothing in scope shadows. None
    /// when only the run knows.
    fn known<'v>(&'v self, ast: &'v Ast, env: &Env) -> Option<&'v Value> {
        match ast {
            Ast::Literal(value) => Some(value),
            Ast::Var(name, _) if find_var(env, name).is_none() => self.globals.get(name),
            _ => None,
        }
    }

    /// Why one of builtin.jq's regex functions, called from the program,
    /// cannot run on this matcher (see regex::unsupported): its pattern
    /// needs syntax the matcher lacks, or is only known at run time, when
    /// a pattern the matcher lacks could no longer go to libjq. The
    /// compiler then refuses the program, which the host runs on libjq.
    fn unsupported_regex(&self, name: &str, args: &[Ast], env: &Env) -> Option<String> {
        if self.in_library > 0 {
            return None;
        }
        let (pattern, modifiers) = match (name, args.len()) {
            ("test" | "match" | "capture" | "scan" | "splits", 1) => (&args[0], None),
            ("test" | "match" | "capture" | "scan" | "splits" | "split", 2) => {
                (&args[0], Some(&args[1]))
            }
            ("sub" | "gsub", 2) => (&args[0], None),
            ("sub" | "gsub", 3) => (&args[0], Some(&args[2])),
            _ => return None,
        };
        let modifiers = match modifiers.map(|m| self.known(m, env)) {
            None | Some(Some(Value::Null)) => None,
            Some(Some(Value::String(m))) => Some(&**m),
            Some(Some(_)) => return None,
            Some(None) => return Some("modifiers known only at run time".into()),
        };
        match self.known(pattern, env) {
            Some(Value::String(pattern)) => super::regex::unsupported(pattern, modifiers),
            Some(Value::Array(pair)) => match (pair.first(), pair.get(1)) {
                (Some(Value::String(pattern)), Some(Value::String(m))) => {
                    super::regex::unsupported(pattern, Some(m))
                }
                (Some(Value::String(pattern)), _) => super::regex::unsupported(pattern, None),
                _ => None,
            },
            Some(_) => None,
            None => Some("a pattern known only at run time".into()),
        }
    }

    fn closure(&mut self, bc: usize, arg: &Ast, env: &Env) -> Result<ClosureRef, String> {
        if let Ast::Call(name, args, _) = arg {
            if args.is_empty() {
                if let Some((owner, target @ Target::Param(_))) = find_func(env, name, 0) {
                    return Ok(ClosureRef {
                        level: self.level(bc, owner),
                        target,
                    });
                }
            }
        }
        let (fbc, index) = self.function(bc);
        self.code(fbc, arg, env)?;
        self.emit(fbc, Op::Ret);
        Ok(ClosureRef {
            level: 0,
            target: Target::New(index),
        })
    }

    fn call_jq(
        &mut self,
        bc: usize,
        callee: ClosureRef,
        args: &[Ast],
        env: &Env,
    ) -> Result<(), String> {
        let mut refs = Vec::with_capacity(args.len());
        for arg in args {
            refs.push(self.closure(bc, arg, env)?);
        }
        self.emit(bc, Op::CallJq(callee, refs));
        Ok(())
    }

    fn call(&mut self, bc: usize, name: &str, args: &[Ast], env: &Env) -> Result<(), String> {
        let arity = args.len();
        if let Some((owner, target)) = find_func(env, name, arity) {
            let callee = ClosureRef {
                level: self.level(bc, owner),
                target,
            };
            return self.call_jq(bc, callee, args, env);
        }
        match (name, arity) {
            ("empty", 0) => {
                self.emit(bc, Op::Backtrack);
                return Ok(());
            }
            ("not", 0) => {
                return self.condbranch(
                    bc,
                    |c| {
                        c.emit(bc, Op::LoadK(Value::False));
                        Ok(())
                    },
                    |c| {
                        c.emit(bc, Op::LoadK(Value::True));
                        Ok(())
                    },
                );
            }
            ("path", 1) => {
                return self.closed(|c| {
                    c.emit(bc, Op::PathBegin);
                    c.code(bc, &args[0], env)?;
                    c.emit(bc, Op::PathEnd);
                    Ok(())
                });
            }
            ("last", 1) => return self.closed(|c| c.last(bc, &args[0], env)),
            ("range", 2) => return self.closed(|c| c.range(bc, &args[0], &args[1], env)),
            ("format", 1) => match &args[0] {
                Ast::Literal(Value::String(f)) if FORMATS.contains(&&**f) => {}
                Ast::Literal(Value::String(f)) => return Err(format!("unsupported format @{f}")),
                _ => return Err("unsupported: a format named at run time".into()),
            },
            _ => {}
        }
        if let Some(reason) = self.unsupported_regex(name, args, env) {
            return Err(format!("unsupported regex: {reason}"));
        }
        if let Some(index) = self.link(name, arity)? {
            let callee = ClosureRef {
                level: self.level(bc, 0),
                target: Target::New(index),
            };
            return self.call_jq(bc, callee, args, env);
        }
        if let Some(f) = builtin::lookup(name, arity) {
            self.closed(|c| {
                for arg in args.iter().rev() {
                    c.subexp(bc, arg, env)?;
                }
                Ok(())
            })?;
            self.emit(bc, Op::CallBuiltin(f, arity + 1));
            return Ok(());
        }
        Err(format!("{name}/{arity} is not defined"))
    }

    fn last(&mut self, bc: usize, f: &Ast, env: &Env) -> Result<(), String> {
        let last = Var {
            level: 0,
            index: self.local(bc),
        };
        let empty = Var {
            level: 0,
            index: self.local(bc),
        };
        for (var, init) in [(last, Value::Null), (empty, Value::True)] {
            self.emit(bc, Op::Dup);
            self.emit(bc, Op::LoadK(init));
            self.emit(bc, Op::StoreV(var));
        }
        let fork = self.emit(bc, Op::Fork(0));
        self.code(bc, f, env)?;
        self.emit(bc, Op::Dup);
        self.emit(bc, Op::StoreV(last));
        self.emit(bc, Op::LoadK(Value::False));
        self.emit(bc, Op::StoreV(empty));
        self.emit(bc, Op::Backtrack);
        self.patch(bc, fork);
        self.emit(bc, Op::LoadVN(empty));
        let found = self.emit(bc, Op::JumpF(0));
        self.emit(bc, Op::Backtrack);
        self.patch(bc, found);
        self.emit(bc, Op::LoadVN(last));
        Ok(())
    }

    fn range(&mut self, bc: usize, from: &Ast, upto: &Ast, env: &Env) -> Result<(), String> {
        self.emit(bc, Op::Dup);
        self.code(bc, from, env)?;
        let start = Var {
            level: 0,
            index: self.local(bc),
        };
        self.emit(bc, Op::StoreV(start));
        self.code(bc, upto, env)?;
        self.emit(bc, Op::Dup);
        self.emit(bc, Op::LoadV(start));
        let var = Var {
            level: 0,
            index: self.local(bc),
        };
        self.emit(bc, Op::StoreV(var));
        self.emit(bc, Op::Range(var));
        Ok(())
    }

    fn finish(self) -> Program {
        let mut bytecodes: Vec<Bytecode> = self
            .bcs
            .into_iter()
            .map(|b| Bytecode {
                ops: b.ops,
                nlocals: b.nlocals,
                subfunctions: b.subfunctions,
            })
            .collect();
        for bytecode in &mut bytecodes {
            optimize(&mut bytecode.ops);
        }
        Program { bytecodes }
    }
}

fn ret_follows(ops: &[Op], mut pc: usize) -> bool {
    for _ in 0..ops.len() {
        match ops.get(pc) {
            Some(Op::Ret) => return true,
            Some(Op::Jump(to)) => pc = *to,
            _ => return false,
        }
    }
    false
}

/// tail_call_analyze: a call followed by a return, whose closures all
/// live in outer frames, reuses the caller's frame.
fn optimize(ops: &mut [Op]) {
    for pc in 0..ops.len() {
        let tail = match &ops[pc] {
            Op::CallJq(callee, args) => {
                callee.level > 0 && args.iter().all(|a| a.level > 0) && ret_follows(ops, pc + 1)
            }
            _ => false,
        };
        if tail {
            let Op::CallJq(callee, args) = std::mem::replace(&mut ops[pc], Op::Ret) else {
                unreachable!()
            };
            ops[pc] = Op::TailCallJq(callee, args);
        }
    }
}

fn pattern_names(pattern: &Pattern, names: &mut Vec<String>) {
    match pattern {
        Pattern::Var(name) => add_name(name, names),
        Pattern::Array(items) => {
            for item in items {
                pattern_names(item, names);
            }
        }
        Pattern::Object(fields) => {
            for (key, sub) in fields {
                if let PatternKey::Var(name) = key {
                    add_name(name, names);
                }
                if let Some(sub) = sub {
                    pattern_names(sub, names);
                }
            }
        }
    }
}

fn add_name(name: &str, names: &mut Vec<String>) {
    if !names.iter().any(|n| n == name) {
        names.push(name.to_string());
    }
}
