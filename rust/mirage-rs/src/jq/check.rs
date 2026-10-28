// Adapted from jq 1.8.2 (MIT), src/compile.c and src/builtin.c. See licenses/third_party/jq.txt.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use super::builtin::{BUILTINS, Kind};
use super::syntax::{Ast, Def, Loc, Pattern, PatternKey, Update, locate};
use super::value::Value;

enum Bind {
    Var(String),
    Func {
        name: String,
        arity: usize,
        def: Option<usize>,
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

fn id(def: &Def) -> usize {
    def as *const Def as usize
}

enum Callee {
    Defined(Option<usize>),
    Builtin(Kind),
    Unbound,
}

/// A body jq compiles as a subfunction: a definition's, or a closure
/// argument's.
type Lambda<'a> = (&'a Ast, Env);

enum Step<'a> {
    Visit(&'a Ast, Env),
    Lambda(&'a Ast, Env),
    Open,
    Merge(usize),
}

struct Checker<'a> {
    source: &'a str,
    globals: &'a HashMap<String, Value>,
    referenced: HashSet<usize>,
    errors: Vec<String>,
}

/// jq's reports of the names a parsed program uses without binding them,
/// in the order its compiler reaches them: a body's own instructions
/// first, and the subfunctions it creates (definitions, closure
/// arguments) only when the body had no error. A definition nothing
/// calls is dropped unchecked, as block_bind_referenced drops it. Every
/// walk runs from an explicit stack: a program nests as deep as Bison's
/// stack let it.
pub(crate) fn check(
    ast: &Ast,
    globals: &HashMap<String, Value>,
    source: &str,
) -> Result<HashSet<usize>, Vec<String>> {
    let mut checker = Checker {
        source,
        globals,
        referenced: HashSet::new(),
        errors: Vec::new(),
    };
    checker.mark(ast);
    let mut pending: Vec<Vec<Lambda>> = vec![vec![(ast, None)]];
    while let Some(bodies) = pending.last_mut() {
        let Some((body, env)) = bodies.pop() else {
            pending.pop();
            continue;
        };
        let before = checker.errors.len();
        let mut lambdas = checker.walk(body, &env);
        if checker.errors.len() == before {
            lambdas.reverse();
            pending.push(lambdas);
        }
    }
    if checker.errors.is_empty() {
        Ok(checker.referenced)
    } else {
        Err(checker.errors)
    }
}

pub(crate) fn references(ast: &Ast) -> HashSet<usize> {
    let globals = HashMap::new();
    let mut checker = Checker {
        source: "",
        globals: &globals,
        referenced: HashSet::new(),
        errors: Vec::new(),
    };
    checker.mark(ast);
    checker.referenced
}

fn define(env: &Env, def: &Def) -> Env {
    with(
        env,
        Bind::Func {
            name: def.name.clone(),
            arity: def.params.len(),
            def: Some(id(def)),
        },
    )
}

fn body_env(env: &Env, def: &Def) -> Env {
    let mut inner = env.clone();
    for (name, var) in &def.params {
        inner = with(
            &inner,
            Bind::Func {
                name: name.clone(),
                arity: 0,
                def: None,
            },
        );
        if *var {
            inner = with(&inner, Bind::Var(name.clone()));
        }
    }
    inner
}

pub(crate) fn pattern_names(patterns: &[Pattern]) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack: Vec<&Pattern> = patterns.iter().rev().collect();
    while let Some(pattern) = stack.pop() {
        match pattern {
            Pattern::Var(name) => out.push(name.clone()),
            Pattern::Array(items) => stack.extend(items.iter().rev()),
            Pattern::Object(fields) => {
                for (key, sub) in fields.iter().rev() {
                    stack.extend(sub.iter());
                    if let PatternKey::Var(name) = key {
                        out.push(name.clone());
                    }
                }
            }
        }
    }
    out
}

fn pattern_vars(patterns: &[Pattern], env: &Env) -> Env {
    pattern_names(patterns)
        .into_iter()
        .fold(env.clone(), |env, name| with(&env, Bind::Var(name)))
}

fn pattern_keys(patterns: &[Pattern]) -> Vec<&Ast> {
    enum Item<'p> {
        Pattern(&'p Pattern),
        Key(&'p Ast),
    }
    let mut out = Vec::new();
    let mut stack: Vec<Item> = patterns.iter().rev().map(Item::Pattern).collect();
    while let Some(item) = stack.pop() {
        match item {
            Item::Key(e) => out.push(e),
            Item::Pattern(Pattern::Var(_)) => {}
            Item::Pattern(Pattern::Array(items)) => {
                stack.extend(items.iter().rev().map(Item::Pattern));
            }
            Item::Pattern(Pattern::Object(fields)) => {
                for (key, sub) in fields.iter().rev() {
                    stack.extend(sub.iter().map(Item::Pattern));
                    if let PatternKey::Expr(e) = key {
                        stack.push(Item::Key(e));
                    }
                }
            }
        }
    }
    out
}

impl<'a> Checker<'a> {
    fn callee(&self, env: &Env, wanted: &str, want_arity: usize) -> Callee {
        let mut at = env.as_deref();
        while let Some(scope) = at {
            if let Bind::Func { name, arity, def } = &scope.bind {
                if name == wanted && *arity == want_arity {
                    return Callee::Defined(*def);
                }
            }
            at = scope.next.as_deref();
        }
        match BUILTINS
            .iter()
            .find(|(name, arity, _)| *name == wanted && *arity == want_arity)
        {
            Some((_, _, kind)) => Callee::Builtin(*kind),
            None => Callee::Unbound,
        }
    }

    fn bound(&self, env: &Env, wanted: &str) -> bool {
        self.local(env, wanted) || self.globals.contains_key(wanted)
    }

    /// Whether `$wanted` is bound by the program itself, which is all
    /// LOADVN can read.
    fn local(&self, env: &Env, wanted: &str) -> bool {
        let mut at = env.as_deref();
        while let Some(scope) = at {
            if let Bind::Var(name) = &scope.bind {
                if name == wanted {
                    return true;
                }
            }
            at = scope.next.as_deref();
        }
        false
    }

    fn error(&mut self, loc: Loc, message: String) {
        let text = locate(self.source, loc, &message);
        self.errors.push(text);
    }

    /// Mark the definitions a program calls, innermost first: a call from
    /// a definition counts only when that definition is called itself.
    fn mark(&mut self, ast: &'a Ast) {
        enum Mark<'a> {
            Visit(&'a Ast, Env),
            Body(&'a Def, Env),
        }
        let mut steps = vec![Mark::Visit(ast, None)];
        while let Some(step) = steps.pop() {
            match step {
                Mark::Body(def, inner) => {
                    if self.referenced.contains(&id(def)) {
                        steps.push(Mark::Visit(&def.body, body_env(&inner, def)));
                    }
                }
                Mark::Visit(Ast::Def(def, rest), env) => {
                    let inner = define(&env, def);
                    steps.push(Mark::Body(def, inner.clone()));
                    steps.push(Mark::Visit(rest, inner));
                }
                Mark::Visit(Ast::Call(name, args, _), env) => {
                    if let Callee::Defined(Some(def)) = self.callee(&env, name, args.len()) {
                        self.referenced.insert(def);
                    }
                    for arg in args.iter().rev() {
                        steps.push(Mark::Visit(arg, env.clone()));
                    }
                }
                Mark::Visit(other, env) => {
                    let implicit = match other {
                        Ast::Recurse => Some(("recurse", 0)),
                        Ast::Format(_) => Some(("format", 1)),
                        Ast::Update(Update::Assign, ..) => Some(("_assign", 2)),
                        Ast::Update(..) => Some(("_modify", 2)),
                        Ast::Label(..) => Some(("error", 0)),
                        _ => None,
                    };
                    if let Some((name, arity)) = implicit {
                        if let Callee::Defined(Some(def)) = self.callee(&env, name, arity) {
                            self.referenced.insert(def);
                        }
                    }
                    for child in children(other).into_iter().rev() {
                        steps.push(Mark::Visit(child, env.clone()));
                    }
                }
            }
        }
    }

    /// Check one body's own instructions: its subfunctions, in the order
    /// jq creates them.
    fn walk(&mut self, body: &'a Ast, env: &Env) -> Vec<Lambda<'a>> {
        let mut sinks: Vec<Vec<Lambda<'a>>> = vec![Vec::new()];
        let mut steps = vec![Step::Visit(body, env.clone())];
        while let Some(step) = steps.pop() {
            match step {
                Step::Open => sinks.push(Vec::new()),
                Step::Merge(n) => {
                    let parts = sinks.split_off(sinks.len() - n);
                    let top = sinks.last_mut().expect("the body's own sink stays");
                    for part in parts.into_iter().rev() {
                        top.extend(part);
                    }
                }
                Step::Lambda(ast, env) => {
                    sinks
                        .last_mut()
                        .expect("the body's own sink stays")
                        .push((ast, env));
                }
                Step::Visit(ast, env) => self.visit(ast, env, &mut steps, &mut sinks),
            }
        }
        sinks.pop().expect("the body's own sink stays")
    }

    /// A C function's arguments, expanded in order, whose subfunctions
    /// land in the body last argument first.
    fn inline(args: &[&'a Ast], env: &Env, steps: &mut Vec<Step<'a>>) {
        steps.push(Step::Merge(args.len()));
        for arg in args.iter().rev() {
            steps.push(Step::Visit(arg, env.clone()));
            steps.push(Step::Open);
        }
    }

    fn visit(
        &mut self,
        ast: &'a Ast,
        env: Env,
        steps: &mut Vec<Step<'a>>,
        sinks: &mut [Vec<Lambda<'a>>],
    ) {
        let visit = |steps: &mut Vec<Step<'a>>, asts: &[&'a Ast], env: &Env| {
            for ast in asts.iter().rev() {
                steps.push(Step::Visit(ast, env.clone()));
            }
        };
        match ast {
            Ast::Identity
            | Ast::Recurse
            | Ast::Literal(_)
            | Ast::Format(_)
            | Ast::Collect(None)
            | Ast::AtKey => {}
            Ast::Index(term, key, _) => visit(steps, &[key, term], &env),
            Ast::Slice(term, from, to, _) => {
                let mut asts: Vec<&Ast> = [from, to].into_iter().flatten().map(|b| &**b).collect();
                asts.push(term);
                visit(steps, &asts, &env);
            }
            Ast::Each(e, _) | Ast::Neg(e) | Ast::Collect(Some(e)) => visit(steps, &[e], &env),
            Ast::Try(body, handler) => {
                let mut asts: Vec<&Ast> = vec![body];
                asts.extend(handler.iter().map(|h| &**h));
                visit(steps, &asts, &env);
            }
            Ast::Pipe(a, b)
            | Ast::Comma(a, b)
            | Ast::And(a, b)
            | Ast::Or(a, b)
            | Ast::Alternative(a, b) => visit(steps, &[a, b], &env),
            Ast::Binop(_, a, b) => Self::inline(&[a, b], &env, steps),
            Ast::Update(kind, lhs, rhs) => match kind {
                Update::Assign | Update::Modify => {
                    let top = sinks.last_mut().expect("the body's own sink stays");
                    top.push((lhs, env.clone()));
                    top.push((rhs, env));
                }
                Update::Arith(_) | Update::Alternative => {
                    steps.push(Step::Lambda(lhs, env.clone()));
                    steps.push(Step::Visit(rhs, env));
                }
            },
            Ast::If(cond, then, otherwise) => {
                let mut asts: Vec<&Ast> = vec![cond, then];
                asts.extend(otherwise.iter().map(|e| &**e));
                visit(steps, &asts, &env);
            }
            Ast::Reduce(source, patterns, init, body) => {
                steps.push(Step::Visit(body, pattern_vars(patterns, &env)));
                let mut asts: Vec<&Ast> = vec![init, source];
                asts.extend(pattern_keys(patterns));
                visit(steps, &asts, &env);
            }
            Ast::Foreach(source, patterns, init, update, extract) => {
                let inner = pattern_vars(patterns, &env);
                if let Some(e) = extract {
                    steps.push(Step::Visit(e, inner.clone()));
                }
                steps.push(Step::Visit(update, inner));
                let mut asts: Vec<&Ast> = vec![init, source];
                asts.extend(pattern_keys(patterns));
                visit(steps, &asts, &env);
            }
            Ast::Bind(source, patterns, body) => {
                steps.push(Step::Visit(body, pattern_vars(patterns, &env)));
                let mut asts: Vec<&Ast> = vec![source];
                asts.extend(pattern_keys(patterns));
                visit(steps, &asts, &env);
            }
            Ast::Label(name, body) => {
                let inner = with(&env, Bind::Var(format!("*label-{name}")));
                steps.push(Step::Visit(body, inner));
            }
            Ast::Break(name, loc) => {
                let label = format!("*label-{name}");
                if !self.bound(&env, &label) {
                    self.error(*loc, format!("${label} is not defined"));
                }
            }
            Ast::Def(def, rest) => {
                let inner = define(&env, def);
                if self.referenced.contains(&id(def)) {
                    sinks
                        .last_mut()
                        .expect("the body's own sink stays")
                        .push((&def.body, body_env(&inner, def)));
                }
                steps.push(Step::Visit(rest, inner));
            }
            Ast::Call(name, args, loc) => match self.callee(&env, name, args.len()) {
                Callee::Defined(_) | Callee::Builtin(Kind::Jq) => {
                    let top = sinks.last_mut().expect("the body's own sink stays");
                    top.extend(args.iter().map(|a| (a, env.clone())));
                }
                Callee::Builtin(Kind::Native) => {
                    let args: Vec<&Ast> = args.iter().collect();
                    Self::inline(&args, &env, steps);
                }
                Callee::Unbound => {
                    self.error(*loc, format!("{name}/{} is not defined", args.len()));
                }
            },
            Ast::Var(name, loc) => {
                if !self.bound(&env, name) {
                    self.error(*loc, format!("${name} is not defined"));
                }
            }
            Ast::LoadVn(name, loc) => {
                if !self.local(&env, name) {
                    self.error(*loc, format!("{name}/-1 is not defined"));
                }
            }
            Ast::Object(pairs) => {
                let asts: Vec<&Ast> = pairs.iter().flat_map(|(k, v)| [k, v]).collect();
                visit(steps, &asts, &env);
            }
        }
    }
}

/// An expression's subexpressions, for walks that bind no names.
fn children(ast: &Ast) -> Vec<&Ast> {
    let mut out: Vec<&Ast> = Vec::new();
    match ast {
        Ast::Identity
        | Ast::Recurse
        | Ast::Literal(_)
        | Ast::Format(_)
        | Ast::Collect(None)
        | Ast::Break(..)
        | Ast::Var(..)
        | Ast::LoadVn(..)
        | Ast::AtKey => {}
        Ast::Index(a, b, _)
        | Ast::Pipe(a, b)
        | Ast::Comma(a, b)
        | Ast::Binop(_, a, b)
        | Ast::And(a, b)
        | Ast::Or(a, b)
        | Ast::Alternative(a, b)
        | Ast::Update(_, a, b) => out.extend([&**a, &**b]),
        Ast::Slice(term, from, to, _) => {
            out.push(term);
            out.extend([from, to].into_iter().flatten().map(|b| &**b));
        }
        Ast::Each(e, _) | Ast::Neg(e) | Ast::Collect(Some(e)) | Ast::Label(_, e) => out.push(e),
        Ast::Try(body, handler) => {
            out.push(body);
            out.extend(handler.iter().map(|h| &**h));
        }
        Ast::If(cond, then, otherwise) => {
            out.extend([&**cond, &**then]);
            out.extend(otherwise.iter().map(|e| &**e));
        }
        Ast::Reduce(source, patterns, init, body) => {
            out.extend([&**source, &**init, &**body]);
            out.extend(pattern_keys(patterns));
        }
        Ast::Foreach(source, patterns, init, update, extract) => {
            out.extend([&**source, &**init, &**update]);
            out.extend(extract.iter().map(|e| &**e));
            out.extend(pattern_keys(patterns));
        }
        Ast::Bind(source, patterns, body) => {
            out.extend([&**source, &**body]);
            out.extend(pattern_keys(patterns));
        }
        Ast::Def(_, rest) => out.push(rest),
        Ast::Call(_, args, _) => out.extend(args.iter()),
        Ast::Object(pairs) => {
            for (k, v) in pairs {
                out.extend([k, v]);
            }
        }
    }
    out
}
