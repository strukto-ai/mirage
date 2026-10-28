// Adapted from jq 1.8.2 (MIT), src/compile.c, src/parser.y, src/builtin.c and src/linker.c. See licenses/third_party/jq.txt.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::OnceLock;

use super::builtin::{self, Cfunc, Fault};
use super::check;
use super::syntax::{self, Ast, BinOp, Def, Parsed, Pattern, PatternKey, Update};
use super::value::{Object, Value};
use super::vm::{Bytecode, ClosureRef, Limits, Op, Program, Target, Var};

const PRELUDE: &str = include_str!("builtin.jq");

type Library = HashMap<(String, usize), Def>;

fn library() -> &'static Library {
    static LIBRARY: OnceLock<Library> = OnceLock::new();
    LIBRARY.get_or_init(|| {
        let _unmetered = super::meter::suspend();
        syntax::parse_defs(PRELUDE)
            .unwrap_or_else(|report| panic!("builtin.jq is jq's library: {report}"))
            .into_iter()
            .map(|def| ((def.name.clone(), def.params.len()), def))
            .collect()
    })
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

impl Drop for Scope {
    fn drop(&mut self) {
        let mut next = self.next.take();
        while let Some(scope) = next {
            match Rc::try_unwrap(scope) {
                Ok(mut scope) => next = scope.next.take(),
                Err(_) => break,
            }
        }
    }
}

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

#[derive(Clone)]
enum Node<'a> {
    Ast(&'a Ast),
    Identity,
    Const(Value),
    /// The local `index` of bytecode `owner`.
    Local(usize, usize),
    /// `. op $local`, the update `_modify` applies for `lhs op= rhs`.
    Binop(BinOp, usize, usize),
    /// `. // $local`, the update `_modify` applies for `lhs //= rhs`.
    Default(usize, usize),
}

type Slots = Vec<(String, usize)>;

/// One step of the code generator, run from an explicit stack so a
/// program nested as deep as Bison's stack let it compiles on a shallow
/// native stack. A sequence is pushed in order and runs in order; a
/// node's steps run before the steps that follow the node.
enum Step<'a> {
    Emit(Op),
    Mark(Op),
    Patch(usize),
    Code(Node<'a>, Env),
    Subexp(Node<'a>, Env),
    Call(&'a str, Vec<Node<'a>>, Env),
    Bind(&'a [Pattern], Env),
    Body(Node<'a>),
    Unbind,
    Match(&'a Pattern, Option<Rc<Slots>>),
    MatchVar(&'a str, Option<Rc<Slots>>),
    Key(&'a Ast),
    /// Set the bytecode whose STOREVs become STOREVNs until Restore;
    /// None keeps a stretch out of the rewrite, as jq's closures are.
    Storevn(Option<usize>),
    Restore,
    Library(bool),
}

struct Compiler<'a> {
    bcs: Vec<Builder>,
    globals: &'a HashMap<String, Value>,
    library: &'static Library,
    linked: HashMap<(String, usize), usize>,
    referenced: HashSet<usize>,
    /// The bytecode whose STOREVs become STOREVNs, while a `?//`
    /// alternative other than the last is compiled into it.
    storevn: Option<usize>,
    tasks: Vec<(usize, Step<'a>)>,
    marks: Vec<(usize, usize)>,
    envs: Vec<Env>,
    saved: Vec<Option<usize>>,
    in_library: usize,
    unsupported: Option<String>,
    unavailable_config: bool,
}

#[derive(Debug)]
pub(crate) enum Refusal {
    Invalid(String),
    Unsupported(String),
}

/// The variables jq's main binds before the command line's: `$ENV`,
/// `$ARGS`, and `$JQ_BUILD_CONFIGURATION`, which names a configure line
/// this engine never had.
fn builtin_globals() -> [(&'static str, Value); 3] {
    let mut args = Object::default();
    args.insert("positional".into(), Value::array(Vec::new()));
    args.insert("named".into(), Value::object(Object::default()));
    [
        ("ENV", Value::object(Object::default())),
        ("ARGS", Value::object(args)),
        ("JQ_BUILD_CONFIGURATION", Value::string("")),
    ]
}

/// jq's linker reads a program's imports last first and stops at the
/// first it cannot load. mirage's jq has no `-L` and reads no files, so
/// no module is ever found: an import refuses the program with jq's
/// report unless its metadata marks it optional, which lets jq go on
/// without the module.
/// Compile `source` against jq's builtin library. `globals` are the
/// `$name` bindings jq's command line makes (`--arg`, `--argjson`,
/// `$ARGS`, `$ENV`); the ones jq's main binds by itself default. A
/// program jq refuses is refused with jq's report. Work requiring the
/// host evaluator is refused before execution.
pub(crate) fn compile(source: &str, globals: &HashMap<String, Value>) -> Result<Program, Refusal> {
    let (ast, imports) = match syntax::parse(source) {
        Parsed::Program(ast, imports) => (ast, imports),
        Parsed::Invalid(messages) => return Err(Refusal::Invalid(syntax::report(&messages))),
        Parsed::Unsupported(why) => return Err(Refusal::Unsupported(why.into())),
    };
    if let Some(import) = imports.iter().rev().find(|import| !import.optional) {
        let message = builtin::module_error(&import.path);
        return Err(Refusal::Invalid(syntax::report(&[format!(
            "jq: error: {message}\n"
        )])));
    }
    let unavailable_config = !globals.contains_key("JQ_BUILD_CONFIGURATION");
    let mut globals = globals.clone();
    for (name, value) in builtin_globals() {
        globals.entry(name.to_string()).or_insert(value);
    }
    let referenced = check::check(&ast, &globals, source)
        .map_err(|errors| Refusal::Invalid(syntax::report(&errors)))?;
    let mut compiler = Compiler {
        bcs: vec![Builder::default()],
        globals: &globals,
        library: library(),
        linked: HashMap::new(),
        referenced,
        storevn: None,
        tasks: Vec::new(),
        marks: Vec::new(),
        envs: Vec::new(),
        saved: Vec::new(),
        in_library: 0,
        unsupported: None,
        unavailable_config,
    };
    compiler.seq(0, vec![Step::Code(Node::Ast(&ast), None)]);
    compiler.run();
    if let Some(why) = compiler.unsupported.take() {
        return Err(Refusal::Unsupported(why));
    }
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
                object.insert(key.clone().into(), value.clone());
            }
            Some(Value::object(object))
        }
        _ => None,
    }
}

fn constant_node(node: &Node) -> Option<Value> {
    match node {
        Node::Ast(ast) => constant(ast),
        Node::Const(v) => Some(v.clone()),
        _ => None,
    }
}

/// gen_condbranch: JUMP_F over the true branch, which jumps over the
/// false one.
fn condbranch<'a>(iftrue: Vec<Step<'a>>, iffalse: Vec<Step<'a>>) -> Vec<Step<'a>> {
    let mut steps = vec![Step::Mark(Op::JumpF(0))];
    steps.extend(iftrue);
    steps.push(Step::Mark(Op::Jump(0)));
    steps.push(Step::Patch(1));
    steps.extend(iffalse);
    steps.push(Step::Patch(0));
    steps
}

fn boolean<'a>() -> Vec<Step<'a>> {
    condbranch(
        vec![Step::Emit(Op::LoadK(Value::True))],
        vec![Step::Emit(Op::LoadK(Value::False))],
    )
}

/// Steps jq keeps in a closure, out of reach of the STOREV to STOREVN
/// rewrite: a C function's arguments, which jq inlines only after
/// parsing, and the bodies of `path`, `last` and `range`.
fn closed(inner: Vec<Step<'_>>) -> Vec<Step<'_>> {
    let mut steps = vec![Step::Storevn(None)];
    steps.extend(inner);
    steps.push(Step::Restore);
    steps
}

fn index_op(opt: bool) -> Op {
    if opt { Op::IndexOpt } else { Op::Index }
}

impl<'a> Compiler<'a> {
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

    fn seq(&mut self, bc: usize, steps: Vec<Step<'a>>) {
        self.tasks
            .extend(steps.into_iter().rev().map(|step| (bc, step)));
    }

    fn scope(&self) -> Env {
        self.envs.last().cloned().expect("a Bind left its scope")
    }

    fn run(&mut self) {
        while let Some((bc, step)) = self.tasks.pop() {
            if self.unsupported.is_some() {
                break;
            }
            match step {
                Step::Library(enter) => {
                    if enter {
                        self.in_library += 1;
                    } else {
                        self.in_library -= 1;
                    }
                }
                Step::Emit(op) => {
                    self.emit(bc, op);
                }
                Step::Mark(op) => {
                    let at = self.emit(bc, op);
                    self.marks.push((bc, at));
                }
                Step::Patch(k) => {
                    let (mbc, at) = self.marks.remove(self.marks.len() - 1 - k);
                    self.patch(mbc, at);
                }
                Step::Code(node, env) => self.code(bc, node, &env),
                Step::Subexp(node, env) => self.subexp(bc, node, &env),
                Step::Call(name, args, env) => self.call(bc, name, &args, &env),
                Step::Bind(patterns, env) => self.bind(bc, patterns, env),
                Step::Body(node) => {
                    let env = self.scope();
                    self.code(bc, node, &env);
                }
                Step::Unbind => {
                    self.envs.pop();
                }
                Step::Match(pattern, slots) => self.matcher(bc, pattern, slots),
                Step::MatchVar(name, slots) => self.match_var(bc, name, slots),
                Step::Key(e) => {
                    let env = self.scope();
                    self.subexp(bc, Node::Ast(e), &env);
                }
                Step::Storevn(to) => {
                    self.saved.push(self.storevn);
                    self.storevn = to;
                }
                Step::Restore => {
                    self.storevn = self.saved.pop().expect("a Storevn to restore");
                }
            }
        }
    }

    fn subexp(&mut self, bc: usize, node: Node<'a>, env: &Env) {
        match node {
            Node::Identity | Node::Ast(Ast::Identity) => {
                self.emit(bc, Op::Dup);
            }
            Node::Const(v) => {
                self.emit(bc, Op::PushKUnder(v));
            }
            Node::Ast(Ast::Literal(v)) => {
                self.emit(bc, Op::PushKUnder(v.clone()));
            }
            node => self.seq(
                bc,
                vec![
                    Step::Emit(Op::SubexpBegin),
                    Step::Code(node, env.clone()),
                    Step::Emit(Op::SubexpEnd),
                ],
            ),
        }
    }

    /// gen_try: the body, then the handler the TRY_BEGIN jumps to on an
    /// error raised from inside it.
    fn try_catch(&mut self, bc: usize, body: Node<'a>, handler: Vec<Step<'a>>, env: &Env) {
        let mut steps = vec![
            Step::Mark(Op::TryBegin(0)),
            Step::Code(body, env.clone()),
            Step::Emit(Op::TryEnd),
            Step::Mark(Op::Jump(0)),
            Step::Patch(1),
        ];
        steps.extend(handler);
        steps.push(Step::Patch(0));
        self.seq(bc, steps);
    }

    fn code(&mut self, bc: usize, node: Node<'a>, env: &Env) {
        let ast = match node {
            Node::Identity => return,
            Node::Const(v) => {
                self.emit(bc, Op::LoadK(v));
                return;
            }
            Node::Local(owner, index) => {
                let var = self.var(bc, owner, index);
                self.emit(bc, Op::LoadV(var));
                return;
            }
            Node::Binop(op, owner, index) => {
                return self.binop(bc, op, Node::Identity, Node::Local(owner, index), env);
            }
            Node::Default(owner, index) => {
                return self.definedor(bc, Node::Identity, Node::Local(owner, index), env);
            }
            Node::Ast(ast) => ast,
        };
        let steps = match ast {
            Ast::Identity => return,
            Ast::Recurse => return self.call(bc, "recurse", &[], env),
            Ast::Literal(v) => vec![Step::Emit(Op::LoadK(v.clone()))],
            Ast::Format(name) => {
                let name = Node::Const(Value::string(name.as_str()));
                return self.call(bc, "format", &[name], env);
            }
            Ast::Index(term, key, opt) => vec![
                Step::Subexp(Node::Ast(key), env.clone()),
                Step::Code(Node::Ast(term), env.clone()),
                Step::Emit(index_op(*opt)),
            ],
            Ast::Slice(term, from, to, opt) => {
                let mut steps = vec![Step::Emit(Op::PushKUnder(Value::object(Object::default())))];
                for (name, bound) in [("start", from), ("end", to)] {
                    steps.push(Step::Emit(Op::PushKUnder(Value::string(name))));
                    steps.push(match bound {
                        Some(e) => Step::Subexp(Node::Ast(e), env.clone()),
                        None => Step::Emit(Op::PushKUnder(Value::Null)),
                    });
                    steps.push(Step::Emit(Op::Insert));
                }
                steps.push(Step::Code(Node::Ast(term), env.clone()));
                steps.push(Step::Emit(index_op(*opt)));
                steps
            }
            Ast::Each(term, opt) => vec![
                Step::Code(Node::Ast(term), env.clone()),
                Step::Emit(if *opt { Op::EachOpt } else { Op::Each }),
            ],
            Ast::Try(body, handler) => {
                let handler = match handler {
                    Some(h) => vec![Step::Code(Node::Ast(h), env.clone())],
                    None => vec![Step::Emit(Op::Backtrack)],
                };
                return self.try_catch(bc, Node::Ast(body), handler, env);
            }
            Ast::Neg(e) => vec![
                Step::Code(Node::Ast(e), env.clone()),
                Step::Emit(Op::CallBuiltin(Cfunc::Negate, 1)),
            ],
            Ast::Pipe(a, b) => vec![
                Step::Code(Node::Ast(a), env.clone()),
                Step::Code(Node::Ast(b), env.clone()),
            ],
            Ast::Comma(a, b) => vec![
                Step::Mark(Op::Fork(0)),
                Step::Code(Node::Ast(a), env.clone()),
                Step::Mark(Op::Jump(0)),
                Step::Patch(1),
                Step::Code(Node::Ast(b), env.clone()),
                Step::Patch(0),
            ],
            Ast::Binop(op, a, b) => {
                return self.binop(bc, *op, Node::Ast(a), Node::Ast(b), env);
            }
            Ast::And(a, b) => {
                let mut steps = vec![Step::Emit(Op::Dup), Step::Code(Node::Ast(a), env.clone())];
                let mut iftrue = vec![Step::Emit(Op::Pop), Step::Code(Node::Ast(b), env.clone())];
                iftrue.extend(boolean());
                let iffalse = vec![Step::Emit(Op::Pop), Step::Emit(Op::LoadK(Value::False))];
                steps.extend(condbranch(iftrue, iffalse));
                steps
            }
            Ast::Or(a, b) => {
                let mut steps = vec![Step::Emit(Op::Dup), Step::Code(Node::Ast(a), env.clone())];
                let iftrue = vec![Step::Emit(Op::Pop), Step::Emit(Op::LoadK(Value::True))];
                let mut iffalse = vec![Step::Emit(Op::Pop), Step::Code(Node::Ast(b), env.clone())];
                iffalse.extend(boolean());
                steps.extend(condbranch(iftrue, iffalse));
                steps
            }
            Ast::Alternative(a, b) => {
                return self.definedor(bc, Node::Ast(a), Node::Ast(b), env);
            }
            Ast::Update(kind, lhs, rhs) => match kind {
                Update::Assign => {
                    return self.call(bc, "_assign", &[Node::Ast(lhs), Node::Ast(rhs)], env);
                }
                Update::Modify => {
                    return self.call(bc, "_modify", &[Node::Ast(lhs), Node::Ast(rhs)], env);
                }
                Update::Arith(_) | Update::Alternative => {
                    let tmp = self.local(bc);
                    let update = match kind {
                        Update::Arith(op) => Node::Binop(*op, bc, tmp),
                        _ => Node::Default(bc, tmp),
                    };
                    vec![
                        Step::Emit(Op::Dup),
                        Step::Code(Node::Ast(rhs), env.clone()),
                        Step::Emit(Op::StoreV(Var {
                            level: 0,
                            index: tmp,
                        })),
                        Step::Call("_modify", vec![Node::Ast(lhs), update], env.clone()),
                    ]
                }
            },
            Ast::If(cond, then, otherwise) => {
                let mut steps = vec![
                    Step::Emit(Op::Dup),
                    Step::Subexp(Node::Ast(cond), env.clone()),
                    Step::Emit(Op::Pop),
                ];
                let iftrue = vec![
                    Step::Emit(Op::Pop),
                    Step::Code(Node::Ast(then), env.clone()),
                ];
                let mut iffalse = vec![Step::Emit(Op::Pop)];
                iffalse.extend(
                    otherwise
                        .iter()
                        .map(|e| Step::Code(Node::Ast(e), env.clone())),
                );
                steps.extend(condbranch(iftrue, iffalse));
                steps
            }
            Ast::Reduce(source, patterns, init, body) => {
                let res = Var {
                    level: 0,
                    index: self.local(bc),
                };
                vec![
                    Step::Emit(Op::Dup),
                    Step::Code(Node::Ast(init), env.clone()),
                    Step::Emit(Op::StoreV(res)),
                    Step::Mark(Op::Fork(0)),
                    Step::Emit(Op::DupN),
                    Step::Code(Node::Ast(source), env.clone()),
                    Step::Bind(patterns, env.clone()),
                    Step::Emit(Op::LoadVN(res)),
                    Step::Body(Node::Ast(body)),
                    Step::Unbind,
                    Step::Emit(Op::StoreV(res)),
                    Step::Emit(Op::Backtrack),
                    Step::Patch(0),
                    Step::Emit(Op::LoadVN(res)),
                ]
            }
            Ast::Foreach(source, patterns, init, update, extract) => {
                let state = Var {
                    level: 0,
                    index: self.local(bc),
                };
                let mut steps = vec![
                    Step::Emit(Op::Dup),
                    Step::Code(Node::Ast(init), env.clone()),
                    Step::Emit(Op::StoreV(state)),
                    Step::Emit(Op::Dup),
                    Step::Code(Node::Ast(source), env.clone()),
                    Step::Bind(patterns, env.clone()),
                    Step::Emit(Op::LoadVN(state)),
                    Step::Body(Node::Ast(update)),
                    Step::Emit(Op::Dup),
                    Step::Emit(Op::StoreV(state)),
                ];
                steps.extend(extract.iter().map(|e| Step::Body(Node::Ast(e))));
                steps.push(Step::Unbind);
                steps
            }
            Ast::Bind(source, patterns, body) => {
                let mut steps = if patterns.len() > 1 {
                    vec![
                        Step::Emit(Op::SubexpBegin),
                        Step::Code(Node::Ast(source), env.clone()),
                        Step::Emit(Op::Dup),
                        Step::Emit(Op::SubexpEnd),
                    ]
                } else {
                    vec![
                        Step::Emit(Op::Dup),
                        Step::Subexp(Node::Ast(source), env.clone()),
                    ]
                };
                steps.extend([
                    Step::Emit(Op::Pop),
                    Step::Bind(patterns, env.clone()),
                    Step::Body(Node::Ast(body)),
                    Step::Unbind,
                ]);
                steps
            }
            Ast::Label(name, body) => {
                self.emit(bc, Op::Dup);
                self.emit(bc, Op::GenLabel);
                let index = self.local(bc);
                self.emit(bc, Op::StoreV(Var { level: 0, index }));
                let inner = with(
                    env,
                    Bind::Var {
                        name: format!("*label-{name}"),
                        bc,
                        index,
                    },
                );
                self.emit(bc, Op::Pop);
                let handler = self.label_handler(bc, index, &inner);
                return self.try_catch(bc, Node::Ast(body), handler, &inner);
            }
            Ast::Break(name, _) => {
                let (owner, index) = find_var(env, &format!("*label-{name}"))
                    .expect("checked: the label is in scope");
                let var = self.var(bc, owner, index);
                vec![
                    Step::Emit(Op::LoadV(var)),
                    Step::Emit(Op::CallBuiltin(Cfunc::Error, 1)),
                ]
            }
            Ast::Def(def, rest) => {
                if !self
                    .referenced
                    .contains(&(def.as_ref() as *const Def as usize))
                {
                    return self.seq(bc, vec![Step::Code(Node::Ast(rest), env.clone())]);
                }
                let outer = self.define(bc, def, env);
                vec![Step::Code(Node::Ast(rest), outer)]
            }
            Ast::Call(name, args, _) => {
                let args: Vec<Node> = args.iter().map(Node::Ast).collect();
                return self.call(bc, name, &args, env);
            }
            Ast::Var(name, _)
                if self.unavailable_config
                    && name == "JQ_BUILD_CONFIGURATION"
                    && find_var(env, name).is_none() =>
            {
                self.unsupported = Some("build configuration requires the host evaluator".into());
                Vec::new()
            }
            Ast::Var(name, _) => match find_var(env, name) {
                Some((owner, index)) => {
                    let var = self.var(bc, owner, index);
                    vec![Step::Emit(Op::LoadV(var))]
                }
                None => {
                    let value = self
                        .globals
                        .get(name)
                        .expect("checked: the variable is bound")
                        .clone();
                    vec![Step::Emit(Op::LoadK(value))]
                }
            },
            Ast::LoadVn(name, _) => {
                let (owner, index) = find_var(env, name).expect("checked: the variable is bound");
                let var = self.var(bc, owner, index);
                vec![Step::Emit(Op::LoadVN(var))]
            }
            Ast::Collect(inner) => match constant(ast) {
                Some(value) => vec![Step::Emit(Op::LoadK(value))],
                None => {
                    let Some(inner) = inner else { unreachable!() };
                    let array = Var {
                        level: 0,
                        index: self.local(bc),
                    };
                    vec![
                        Step::Emit(Op::Dup),
                        Step::Emit(Op::LoadK(Value::array(Vec::new()))),
                        Step::Emit(Op::StoreV(array)),
                        Step::Mark(Op::Fork(0)),
                        Step::Code(Node::Ast(inner), env.clone()),
                        Step::Emit(Op::Append(array)),
                        Step::Emit(Op::Backtrack),
                        Step::Patch(0),
                        Step::Emit(Op::LoadVN(array)),
                    ]
                }
            },
            Ast::Object(pairs) => match constant(ast) {
                Some(value) => vec![Step::Emit(Op::LoadK(value))],
                None => {
                    let mut steps =
                        vec![Step::Emit(Op::PushKUnder(Value::object(Object::default())))];
                    for (k, v) in pairs {
                        steps.push(Step::Subexp(Node::Ast(k), env.clone()));
                        steps.push(Step::Subexp(Node::Ast(v), env.clone()));
                        steps.push(Step::Emit(Op::Insert));
                    }
                    steps.push(Step::Emit(Op::Pop));
                    steps
                }
            },
            Ast::AtKey => vec![
                Step::Emit(Op::Pop),
                Step::Emit(Op::Dup2),
                Step::Emit(Op::Dup2),
                Step::Emit(Op::Index),
            ],
        };
        self.seq(bc, steps);
    }

    /// The handler gen_label gives a `label`'s try: an error equal to the
    /// label's value is the break and backtracks, any other is raised on.
    fn label_handler(&self, bc: usize, index: usize, env: &Env) -> Vec<Step<'a>> {
        let mut steps = vec![
            Step::Emit(Op::Dup),
            Step::Subexp(Node::Binop(BinOp::Equal, bc, index), env.clone()),
            Step::Emit(Op::Pop),
        ];
        let iftrue = vec![Step::Emit(Op::Pop), Step::Emit(Op::Backtrack)];
        let iffalse = vec![
            Step::Emit(Op::Pop),
            Step::Call("error", Vec::new(), env.clone()),
        ];
        steps.extend(condbranch(iftrue, iffalse));
        steps
    }

    fn binop(&mut self, bc: usize, op: BinOp, a: Node<'a>, b: Node<'a>, env: &Env) {
        let f = builtin::lookup(op.function(), 2).expect("binop builtin");
        let folds = |x: &Value, y: &Value| {
            !(op == BinOp::Multiply
                && (matches!(x, Value::String(_)) || matches!(y, Value::String(_)))
                || op == BinOp::Minus
                    && matches!(x, Value::Array(_))
                    && matches!(y, Value::Array(_)))
        };
        let constants = match (constant_node(&a), constant_node(&b)) {
            (Some(x), Some(y)) if folds(&x, &y) => Some((x, y)),
            _ => None,
        };
        if let Some((x, y)) = constants {
            let limits = Limits {
                blocks: usize::MAX,
                items: usize::MAX,
                bytes: usize::MAX,
                memory: usize::MAX,
            };
            match builtin::call(f, &[Value::Null, x, y], limits) {
                Ok(v) => {
                    self.emit(bc, Op::LoadK(v));
                }
                Err(Fault::Error(message)) => {
                    self.emit(bc, Op::ErrorK(message));
                }
                Err(_) => unreachable!("binops neither halt nor backtrack"),
            }
            return;
        }
        let mut steps = closed(vec![
            Step::Subexp(b, env.clone()),
            Step::Subexp(a, env.clone()),
        ]);
        steps.push(Step::Emit(Op::CallBuiltin(f, 3)));
        self.seq(bc, steps);
    }

    /// gen_definedor: the outputs of `a` that are neither null nor false,
    /// or `b`'s when there are none.
    fn definedor(&mut self, bc: usize, a: Node<'a>, b: Node<'a>, env: &Env) {
        let found = Var {
            level: 0,
            index: self.local(bc),
        };
        self.seq(
            bc,
            vec![
                Step::Emit(Op::Dup),
                Step::Emit(Op::LoadK(Value::False)),
                Step::Emit(Op::StoreV(found)),
                Step::Mark(Op::Fork(0)),
                Step::Code(a, env.clone()),
                Step::Mark(Op::JumpF(0)),
                Step::Emit(Op::Dup),
                Step::Emit(Op::LoadK(Value::True)),
                Step::Emit(Op::StoreV(found)),
                Step::Mark(Op::Jump(0)),
                Step::Patch(1),
                Step::Emit(Op::Backtrack),
                Step::Patch(1),
                Step::Emit(Op::Dup),
                Step::Emit(Op::LoadV(found)),
                Step::Mark(Op::JumpF(0)),
                Step::Emit(Op::Backtrack),
                Step::Patch(0),
                Step::Emit(Op::Pop),
                Step::Code(b, env.clone()),
                Step::Patch(0),
            ],
        );
    }

    /// bind_alternation_matchers: destructure the value on top of the
    /// stack by the first of `patterns` that neither fails nor leads to an
    /// error, popping it, and leave the scope that sees their variables
    /// on the env stack. Every variable an alternative names starts out
    /// null, and each alternative but the last sits behind a
    /// DESTRUCTURE_ALT that tries the next one on an error.
    fn bind(&mut self, bc: usize, patterns: &'a [Pattern], env: Env) {
        let Some((last, alternatives)) = patterns.split_last() else {
            unreachable!("a binding has a pattern");
        };
        if alternatives.is_empty() {
            self.envs.push(env);
            self.seq(bc, vec![Step::Match(last, None)]);
            return;
        }
        let mut slots = Vec::new();
        let mut inner = env;
        for name in check::pattern_names(patterns) {
            if slots.iter().any(|(slot, _)| *slot == name) {
                continue;
            }
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
        self.envs.push(inner);
        let slots = Rc::new(slots);
        let mut steps = Vec::new();
        for pattern in alternatives {
            steps.extend([
                Step::Mark(Op::DestructureAlt(0)),
                Step::Storevn(Some(bc)),
                Step::Match(pattern, Some(Rc::clone(&slots))),
                Step::Restore,
                Step::Mark(Op::Jump(0)),
                Step::Patch(1),
            ]);
        }
        steps.push(Step::Match(last, Some(slots)));
        steps.extend(alternatives.iter().map(|_| Step::Patch(0)));
        self.seq(bc, steps);
    }

    /// Destructure the value on top of the stack into the pattern's
    /// variables, popping it, extending the scope on the env stack. With
    /// `slots`, each variable is stored into the local named there.
    fn matcher(&mut self, bc: usize, pattern: &'a Pattern, slots: Option<Rc<Slots>>) {
        match pattern {
            Pattern::Var(name) => self.match_var(bc, name, slots),
            Pattern::Array(items) => {
                let mut steps = Vec::new();
                for (i, item) in items.iter().enumerate().rev() {
                    steps.extend([
                        Step::Emit(Op::Dup),
                        Step::Emit(Op::PushKUnder(Value::number(i as f64))),
                        Step::Emit(Op::Index),
                        Step::Match(item, slots.clone()),
                    ]);
                }
                steps.push(Step::Emit(Op::Pop));
                self.seq(bc, steps);
            }
            Pattern::Object(fields) => {
                let mut steps = Vec::new();
                for (key, sub) in fields {
                    steps.push(Step::Emit(Op::Dup));
                    match key {
                        PatternKey::Var(name) => {
                            steps.push(Step::Emit(Op::PushKUnder(Value::string(name.as_str()))));
                            steps.push(Step::Emit(Op::Index));
                            if sub.is_some() {
                                steps.push(Step::Emit(Op::Dup));
                            }
                            steps.push(Step::MatchVar(name, slots.clone()));
                        }
                        PatternKey::Expr(e) => {
                            steps.push(Step::Key(e));
                            steps.push(Step::Emit(Op::Index));
                        }
                    }
                    if let Some(sub) = sub {
                        steps.push(Step::Match(sub, slots.clone()));
                    }
                }
                steps.push(Step::Emit(Op::Pop));
                self.seq(bc, steps);
            }
        }
    }

    fn match_var(&mut self, bc: usize, name: &str, slots: Option<Rc<Slots>>) {
        let index = match slots {
            Some(slots) => slots
                .iter()
                .find(|(slot, _)| slot == name)
                .map(|(_, index)| *index)
                .expect("every pattern variable has a slot"),
            None => self.local(bc),
        };
        self.emit(bc, Op::StoreV(Var { level: 0, index }));
        let top = self.envs.last_mut().expect("a Bind left its scope");
        *top = with(
            top,
            Bind::Var {
                name: name.to_string(),
                bc,
                index,
            },
        );
    }

    /// Schedule a definition's body into `fbc`: its `$param` parameters
    /// are bound first, as gen_function wraps the body in a binding of
    /// each, in order, then the body in their scope.
    fn body(&mut self, fbc: usize, def: &'a Def, env: &Env) {
        let mut inner = env.clone();
        for (i, (name, _)) in def.params.iter().enumerate() {
            inner = with(
                &inner,
                Bind::Func {
                    name: name.clone(),
                    arity: 0,
                    bc: fbc,
                    target: Target::Param(i),
                },
            );
        }
        for (i, (name, is_var)) in def.params.iter().enumerate() {
            if !is_var {
                continue;
            }
            let callee = ClosureRef {
                level: 0,
                target: Target::Param(i),
            };
            self.emit(fbc, Op::Dup);
            self.emit(fbc, Op::SubexpBegin);
            self.emit(fbc, Op::CallJq(callee, Vec::new()));
            self.emit(fbc, Op::SubexpEnd);
            self.emit(fbc, Op::Pop);
            let index = self.local(fbc);
            self.emit(fbc, Op::StoreV(Var { level: 0, index }));
            inner = with(
                &inner,
                Bind::Var {
                    name: name.clone(),
                    bc: fbc,
                    index,
                },
            );
        }
        self.seq(
            fbc,
            vec![Step::Code(Node::Ast(&def.body), inner), Step::Emit(Op::Ret)],
        );
    }

    fn define(&mut self, bc: usize, def: &'a Def, env: &Env) -> Env {
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
        self.body(fbc, def, &outer);
        outer
    }

    /// A builtin.jq definition, compiled the first time it is called as a
    /// subfunction of the top level, in a scope of its parameters alone.
    fn link(&mut self, name: &str, arity: usize) -> Option<usize> {
        let key = (name.to_string(), arity);
        if let Some(index) = self.linked.get(&key) {
            return Some(*index);
        }
        let def = self.library.get(&key)?;
        self.referenced.extend(check::references(&def.body));
        let (fbc, index) = self.function(0);
        self.linked.insert(key, index);
        self.tasks.push((fbc, Step::Library(false)));
        self.body(fbc, def, &None);
        self.tasks.push((fbc, Step::Library(true)));
        Some(index)
    }

    /// What a regex call's pattern or modifiers are at compile time: a
    /// literal, or a `--arg`-style global nothing in scope shadows. None
    /// when only the run knows.
    fn known<'v>(&'v self, node: &'v Node, env: &Env) -> Option<&'v Value> {
        match node {
            Node::Const(value) | Node::Ast(Ast::Literal(value)) => Some(value),
            Node::Ast(Ast::Var(name, _)) if find_var(env, name).is_none() => self.globals.get(name),
            _ => None,
        }
    }

    /// Why one of builtin.jq's regex functions, called from the program,
    /// cannot run on this matcher (see regex::unsupported): its pattern
    /// needs syntax the matcher lacks, or is only known at run time, when
    /// a pattern the matcher lacks could no longer go to libjq. The
    /// compiler then refuses the program, which the host runs on libjq.
    fn unsupported_regex(&self, name: &str, args: &[Node], env: &Env) -> Option<String> {
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
            Some(Some(Value::String(m))) => Some(m.as_str()),
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

    fn closure(&mut self, bc: usize, arg: Node<'a>, env: &Env) -> ClosureRef {
        if let Node::Ast(Ast::Call(name, args, _)) = &arg {
            if args.is_empty() {
                if let Some((owner, target @ Target::Param(_))) = find_func(env, name, 0) {
                    return ClosureRef {
                        level: self.level(bc, owner),
                        target,
                    };
                }
            }
        }
        let (fbc, index) = self.function(bc);
        self.seq(fbc, vec![Step::Code(arg, env.clone()), Step::Emit(Op::Ret)]);
        ClosureRef {
            level: 0,
            target: Target::New(index),
        }
    }

    fn call_jq(&mut self, bc: usize, callee: ClosureRef, args: &[Node<'a>], env: &Env) {
        let refs: Vec<ClosureRef> = args
            .iter()
            .map(|arg| self.closure(bc, arg.clone(), env))
            .collect();
        self.emit(bc, Op::CallJq(callee, refs));
    }

    fn call(&mut self, bc: usize, name: &str, args: &[Node<'a>], env: &Env) {
        let arity = args.len();
        if let Some((owner, target)) = find_func(env, name, arity) {
            let callee = ClosureRef {
                level: self.level(bc, owner),
                target,
            };
            return self.call_jq(bc, callee, args, env);
        }
        if matches!(
            name,
            "erf"
                | "erfc"
                | "gamma"
                | "lgamma"
                | "lgamma_r"
                | "tgamma"
                | "j0"
                | "j1"
                | "jn"
                | "y0"
                | "y1"
                | "yn"
                | "remainder"
                | "drem"
        ) {
            self.unsupported = Some("this math builtin requires the host evaluator".into());
            return;
        }
        if matches!((name, arity), ("get_jq_origin" | "get_prog_origin", 0)) {
            self.unsupported =
                Some("program and evaluator paths require the host evaluator".into());
            return;
        }
        match (name, arity) {
            ("empty", 0) => {
                self.emit(bc, Op::Backtrack);
                return;
            }
            ("not", 0) => {
                let steps = condbranch(
                    vec![Step::Emit(Op::LoadK(Value::False))],
                    vec![Step::Emit(Op::LoadK(Value::True))],
                );
                return self.seq(bc, steps);
            }
            ("path", 1) => {
                let steps = closed(vec![
                    Step::Emit(Op::PathBegin),
                    Step::Code(args[0].clone(), env.clone()),
                    Step::Emit(Op::PathEnd),
                ]);
                return self.seq(bc, steps);
            }
            ("last", 1) => return self.last(bc, args[0].clone(), env),
            ("range", 2) => return self.range(bc, args[0].clone(), args[1].clone(), env),
            _ => {}
        }
        if let Some(reason) = self.unsupported_regex(name, args, env) {
            self.unsupported = Some(format!("unsupported regex: {reason}"));
            return;
        }
        if let Some(index) = self.link(name, arity) {
            let callee = ClosureRef {
                level: self.level(bc, 0),
                target: Target::New(index),
            };
            return self.call_jq(bc, callee, args, env);
        }
        let f = builtin::lookup(name, arity)
            .unwrap_or_else(|| unreachable!("checked: {name}/{arity} is a builtin"));
        let mut steps = closed(
            args.iter()
                .rev()
                .map(|arg| Step::Subexp(arg.clone(), env.clone()))
                .collect(),
        );
        steps.push(Step::Emit(Op::CallBuiltin(f, arity + 1)));
        self.seq(bc, steps);
    }

    fn last(&mut self, bc: usize, f: Node<'a>, env: &Env) {
        let last = Var {
            level: 0,
            index: self.local(bc),
        };
        let empty = Var {
            level: 0,
            index: self.local(bc),
        };
        let mut steps = Vec::new();
        for (var, init) in [(last, Value::Null), (empty, Value::True)] {
            steps.push(Step::Emit(Op::Dup));
            steps.push(Step::Emit(Op::LoadK(init)));
            steps.push(Step::Emit(Op::StoreV(var)));
        }
        steps.extend([
            Step::Mark(Op::Fork(0)),
            Step::Code(f, env.clone()),
            Step::Emit(Op::Dup),
            Step::Emit(Op::StoreV(last)),
            Step::Emit(Op::LoadK(Value::False)),
            Step::Emit(Op::StoreV(empty)),
            Step::Emit(Op::Backtrack),
            Step::Patch(0),
            Step::Emit(Op::LoadVN(empty)),
            Step::Mark(Op::JumpF(0)),
            Step::Emit(Op::Backtrack),
            Step::Patch(0),
            Step::Emit(Op::LoadVN(last)),
        ]);
        self.seq(bc, closed(steps));
    }

    fn range(&mut self, bc: usize, from: Node<'a>, upto: Node<'a>, env: &Env) {
        let start = Var {
            level: 0,
            index: self.local(bc),
        };
        let var = Var {
            level: 0,
            index: self.local(bc),
        };
        let steps = closed(vec![
            Step::Emit(Op::Dup),
            Step::Code(from, env.clone()),
            Step::Emit(Op::StoreV(start)),
            Step::Code(upto, env.clone()),
            Step::Emit(Op::Dup),
            Step::Emit(Op::LoadV(start)),
            Step::Emit(Op::StoreV(var)),
            Step::Emit(Op::Range(var)),
        ]);
        self.seq(bc, steps);
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
