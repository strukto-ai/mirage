// Adapted from jq 1.8.2 (MIT), src/compile.c and src/builtin.c. See licenses/third_party/jq.txt.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use super::syntax::{Ast, Def, Loc, Pattern, PatternKey, Update, locate};
use super::value::Value;

/// How jq binds a builtin: a C function takes its arguments inline, a
/// jq-coded one as closures, which are compiled after the body calling
/// it.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Native,
    Jq,
}

/// Every builtin jq 1.8.2 binds, by name and arity: builtin.c's C
/// functions and bytecoded builtins, and builtin.jq's definitions.
const BUILTINS: &[(&str, usize, Kind)] = &[
    ("IN", 1, Kind::Jq),
    ("IN", 2, Kind::Jq),
    ("INDEX", 1, Kind::Jq),
    ("INDEX", 2, Kind::Jq),
    ("JOIN", 2, Kind::Jq),
    ("JOIN", 3, Kind::Jq),
    ("JOIN", 4, Kind::Jq),
    ("_assign", 2, Kind::Jq),
    ("_divide", 2, Kind::Native),
    ("_equal", 2, Kind::Native),
    ("_flatten", 1, Kind::Jq),
    ("_greater", 2, Kind::Native),
    ("_greatereq", 2, Kind::Native),
    ("_group_by_impl", 1, Kind::Native),
    ("_less", 2, Kind::Native),
    ("_lesseq", 2, Kind::Native),
    ("_match_impl", 3, Kind::Native),
    ("_max_by_impl", 1, Kind::Native),
    ("_min_by_impl", 1, Kind::Native),
    ("_minus", 2, Kind::Native),
    ("_mod", 2, Kind::Native),
    ("_modify", 2, Kind::Jq),
    ("_multiply", 2, Kind::Native),
    ("_negate", 0, Kind::Native),
    ("_notequal", 2, Kind::Native),
    ("_plus", 2, Kind::Native),
    ("_sort_by_impl", 1, Kind::Native),
    ("_strindices", 1, Kind::Native),
    ("_unique_by_impl", 1, Kind::Native),
    ("abs", 0, Kind::Jq),
    ("acos", 0, Kind::Native),
    ("acosh", 0, Kind::Native),
    ("add", 0, Kind::Jq),
    ("add", 1, Kind::Jq),
    ("all", 0, Kind::Jq),
    ("all", 1, Kind::Jq),
    ("all", 2, Kind::Jq),
    ("any", 0, Kind::Jq),
    ("any", 1, Kind::Jq),
    ("any", 2, Kind::Jq),
    ("arrays", 0, Kind::Jq),
    ("ascii_downcase", 0, Kind::Jq),
    ("ascii_upcase", 0, Kind::Jq),
    ("asin", 0, Kind::Native),
    ("asinh", 0, Kind::Native),
    ("atan", 0, Kind::Native),
    ("atan2", 2, Kind::Native),
    ("atanh", 0, Kind::Native),
    ("booleans", 0, Kind::Jq),
    ("bsearch", 1, Kind::Native),
    ("builtins", 0, Kind::Jq),
    ("capture", 1, Kind::Jq),
    ("capture", 2, Kind::Jq),
    ("cbrt", 0, Kind::Native),
    ("ceil", 0, Kind::Native),
    ("combinations", 0, Kind::Jq),
    ("combinations", 1, Kind::Jq),
    ("contains", 1, Kind::Native),
    ("copysign", 2, Kind::Native),
    ("cos", 0, Kind::Native),
    ("cosh", 0, Kind::Native),
    ("debug", 0, Kind::Native),
    ("debug", 1, Kind::Jq),
    ("del", 1, Kind::Jq),
    ("delpaths", 1, Kind::Native),
    ("drem", 2, Kind::Native),
    ("empty", 0, Kind::Jq),
    ("endswith", 1, Kind::Native),
    ("env", 0, Kind::Native),
    ("erf", 0, Kind::Native),
    ("erfc", 0, Kind::Native),
    ("error", 0, Kind::Native),
    ("error", 1, Kind::Jq),
    ("exp", 0, Kind::Native),
    ("exp10", 0, Kind::Native),
    ("exp2", 0, Kind::Native),
    ("explode", 0, Kind::Native),
    ("expm1", 0, Kind::Native),
    ("fabs", 0, Kind::Native),
    ("fdim", 2, Kind::Native),
    ("finites", 0, Kind::Jq),
    ("first", 0, Kind::Jq),
    ("first", 1, Kind::Jq),
    ("flatten", 0, Kind::Jq),
    ("flatten", 1, Kind::Jq),
    ("floor", 0, Kind::Native),
    ("fma", 3, Kind::Native),
    ("fmax", 2, Kind::Native),
    ("fmin", 2, Kind::Native),
    ("fmod", 2, Kind::Native),
    ("format", 1, Kind::Native),
    ("frexp", 0, Kind::Native),
    ("from_entries", 0, Kind::Jq),
    ("fromdate", 0, Kind::Jq),
    ("fromdateiso8601", 0, Kind::Jq),
    ("fromjson", 0, Kind::Native),
    ("fromstream", 1, Kind::Jq),
    ("gamma", 0, Kind::Native),
    ("get_jq_origin", 0, Kind::Native),
    ("get_prog_origin", 0, Kind::Native),
    ("get_search_list", 0, Kind::Native),
    ("getpath", 1, Kind::Native),
    ("gmtime", 0, Kind::Native),
    ("group_by", 1, Kind::Jq),
    ("gsub", 2, Kind::Jq),
    ("gsub", 3, Kind::Jq),
    ("halt", 0, Kind::Native),
    ("halt_error", 0, Kind::Jq),
    ("halt_error", 1, Kind::Native),
    ("has", 1, Kind::Native),
    ("have_decnum", 0, Kind::Native),
    ("have_literal_numbers", 0, Kind::Native),
    ("hypot", 2, Kind::Native),
    ("implode", 0, Kind::Native),
    ("in", 1, Kind::Jq),
    ("index", 1, Kind::Jq),
    ("indices", 1, Kind::Jq),
    ("infinite", 0, Kind::Native),
    ("input", 0, Kind::Native),
    ("input_filename", 0, Kind::Native),
    ("input_line_number", 0, Kind::Native),
    ("inputs", 0, Kind::Jq),
    ("inside", 1, Kind::Jq),
    ("isempty", 1, Kind::Jq),
    ("isfinite", 0, Kind::Jq),
    ("isinfinite", 0, Kind::Native),
    ("isnan", 0, Kind::Native),
    ("isnormal", 0, Kind::Native),
    ("iterables", 0, Kind::Jq),
    ("j0", 0, Kind::Native),
    ("j1", 0, Kind::Native),
    ("jn", 2, Kind::Native),
    ("join", 1, Kind::Jq),
    ("keys", 0, Kind::Native),
    ("keys_unsorted", 0, Kind::Native),
    ("last", 0, Kind::Jq),
    ("last", 1, Kind::Jq),
    ("ldexp", 2, Kind::Native),
    ("length", 0, Kind::Native),
    ("lgamma", 0, Kind::Native),
    ("lgamma_r", 0, Kind::Native),
    ("limit", 2, Kind::Jq),
    ("localtime", 0, Kind::Native),
    ("log", 0, Kind::Native),
    ("log10", 0, Kind::Native),
    ("log1p", 0, Kind::Native),
    ("log2", 0, Kind::Native),
    ("logb", 0, Kind::Native),
    ("ltrim", 0, Kind::Native),
    ("ltrimstr", 1, Kind::Jq),
    ("map", 1, Kind::Jq),
    ("map_values", 1, Kind::Jq),
    ("match", 1, Kind::Jq),
    ("match", 2, Kind::Jq),
    ("max", 0, Kind::Native),
    ("max_by", 1, Kind::Jq),
    ("min", 0, Kind::Native),
    ("min_by", 1, Kind::Jq),
    ("mktime", 0, Kind::Native),
    ("modf", 0, Kind::Native),
    ("modulemeta", 0, Kind::Native),
    ("nan", 0, Kind::Native),
    ("nearbyint", 0, Kind::Native),
    ("nextafter", 2, Kind::Native),
    ("nexttoward", 2, Kind::Native),
    ("normals", 0, Kind::Jq),
    ("not", 0, Kind::Jq),
    ("now", 0, Kind::Native),
    ("nth", 1, Kind::Jq),
    ("nth", 2, Kind::Jq),
    ("nulls", 0, Kind::Jq),
    ("numbers", 0, Kind::Jq),
    ("objects", 0, Kind::Jq),
    ("path", 1, Kind::Jq),
    ("paths", 0, Kind::Jq),
    ("paths", 1, Kind::Jq),
    ("pick", 1, Kind::Jq),
    ("pow", 2, Kind::Native),
    ("range", 1, Kind::Jq),
    ("range", 2, Kind::Jq),
    ("range", 3, Kind::Jq),
    ("recurse", 0, Kind::Jq),
    ("recurse", 1, Kind::Jq),
    ("recurse", 2, Kind::Jq),
    ("remainder", 2, Kind::Native),
    ("repeat", 1, Kind::Jq),
    ("reverse", 0, Kind::Jq),
    ("rindex", 1, Kind::Jq),
    ("rint", 0, Kind::Native),
    ("round", 0, Kind::Native),
    ("rtrim", 0, Kind::Native),
    ("rtrimstr", 1, Kind::Jq),
    ("scalars", 0, Kind::Jq),
    ("scalb", 2, Kind::Native),
    ("scalbln", 2, Kind::Native),
    ("scan", 1, Kind::Jq),
    ("scan", 2, Kind::Jq),
    ("select", 1, Kind::Jq),
    ("setpath", 2, Kind::Native),
    ("significand", 0, Kind::Native),
    ("sin", 0, Kind::Native),
    ("sinh", 0, Kind::Native),
    ("skip", 2, Kind::Jq),
    ("sort", 0, Kind::Native),
    ("sort_by", 1, Kind::Jq),
    ("split", 1, Kind::Native),
    ("split", 2, Kind::Jq),
    ("splits", 1, Kind::Jq),
    ("splits", 2, Kind::Jq),
    ("sqrt", 0, Kind::Native),
    ("startswith", 1, Kind::Native),
    ("stderr", 0, Kind::Native),
    ("strflocaltime", 1, Kind::Native),
    ("strftime", 1, Kind::Native),
    ("strings", 0, Kind::Jq),
    ("strptime", 1, Kind::Native),
    ("sub", 2, Kind::Jq),
    ("sub", 3, Kind::Jq),
    ("tan", 0, Kind::Native),
    ("tanh", 0, Kind::Native),
    ("test", 1, Kind::Jq),
    ("test", 2, Kind::Jq),
    ("tgamma", 0, Kind::Native),
    ("to_entries", 0, Kind::Jq),
    ("toboolean", 0, Kind::Native),
    ("todate", 0, Kind::Jq),
    ("todateiso8601", 0, Kind::Jq),
    ("tojson", 0, Kind::Native),
    ("tonumber", 0, Kind::Native),
    ("tostream", 0, Kind::Jq),
    ("tostring", 0, Kind::Native),
    ("transpose", 0, Kind::Jq),
    ("trim", 0, Kind::Native),
    ("trimstr", 1, Kind::Jq),
    ("trunc", 0, Kind::Native),
    ("truncate_stream", 1, Kind::Jq),
    ("type", 0, Kind::Native),
    ("unique", 0, Kind::Native),
    ("unique_by", 1, Kind::Jq),
    ("until", 2, Kind::Jq),
    ("utf8bytelength", 0, Kind::Native),
    ("values", 0, Kind::Jq),
    ("walk", 1, Kind::Jq),
    ("while", 2, Kind::Jq),
    ("with_entries", 1, Kind::Jq),
    ("y0", 0, Kind::Native),
    ("y1", 0, Kind::Native),
    ("yn", 2, Kind::Native),
];

/// The variables jq binds besides the command line's named arguments:
/// `$ENV`, `$ARGS` and the build configuration main.c adds.
const GLOBALS: &[&str] = &["ENV", "ARGS", "JQ_BUILD_CONFIGURATION"];

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
/// calls is dropped unchecked, as block_bind_referenced drops it.
pub(crate) fn check(ast: &Ast, globals: &HashMap<String, Value>, source: &str) -> Vec<String> {
    let mut checker = Checker {
        source,
        globals,
        referenced: HashSet::new(),
        errors: Vec::new(),
    };
    checker.mark(ast, &None);
    checker.function(ast, &None);
    checker.errors
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

fn pattern_names(pattern: &Pattern, out: &mut Vec<String>) {
    match pattern {
        Pattern::Var(name) => out.push(name.clone()),
        Pattern::Array(items) => items.iter().for_each(|p| pattern_names(p, out)),
        Pattern::Object(fields) => {
            for (key, sub) in fields {
                if let PatternKey::Var(name) = key {
                    out.push(name.clone());
                }
                if let Some(sub) = sub {
                    pattern_names(sub, out);
                }
            }
        }
    }
}

fn pattern_vars(patterns: &[Pattern], env: &Env) -> Env {
    let mut all = Vec::new();
    patterns.iter().for_each(|p| pattern_names(p, &mut all));
    all.into_iter()
        .fold(env.clone(), |env, name| with(&env, Bind::Var(name)))
}

fn pattern_keys<'p>(pattern: &'p Pattern, out: &mut Vec<&'p Ast>) {
    match pattern {
        Pattern::Var(_) => {}
        Pattern::Array(items) => items.iter().for_each(|p| pattern_keys(p, out)),
        Pattern::Object(fields) => {
            for (key, sub) in fields {
                if let PatternKey::Expr(e) = key {
                    out.push(e);
                }
                if let Some(sub) = sub {
                    pattern_keys(sub, out);
                }
            }
        }
    }
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
        let mut at = env.as_deref();
        while let Some(scope) = at {
            if let Bind::Var(name) = &scope.bind {
                if name == wanted {
                    return true;
                }
            }
            at = scope.next.as_deref();
        }
        self.globals.contains_key(wanted) || GLOBALS.contains(&wanted)
    }

    fn error(&mut self, loc: Loc, message: String) {
        let text = locate(self.source, loc, &message);
        self.errors.push(text);
    }

    /// Mark the definitions a program calls, innermost first: a call from
    /// a definition counts only when that definition is called itself.
    fn mark(&mut self, ast: &Ast, env: &Env) {
        match ast {
            Ast::Def(def, rest) => {
                let inner = define(env, def);
                self.mark(rest, &inner);
                if self.referenced.contains(&id(def)) {
                    self.mark(&def.body, &body_env(&inner, def));
                }
            }
            Ast::Call(name, args, _) => {
                if let Callee::Defined(Some(def)) = self.callee(env, name, args.len()) {
                    self.referenced.insert(def);
                }
                for arg in args {
                    self.mark(arg, env);
                }
            }
            other => {
                for child in children(other) {
                    self.mark(child, env);
                }
            }
        }
    }

    fn function(&mut self, body: &'a Ast, env: &Env) {
        let before = self.errors.len();
        let mut lambdas = Vec::new();
        self.walk(body, env, &mut lambdas);
        if self.errors.len() == before {
            for (ast, env) in lambdas {
                self.function(ast, &env);
            }
        }
    }

    /// A C function's arguments, expanded in order, whose subfunctions
    /// land in the body last argument first.
    fn inline(&mut self, args: &[&'a Ast], env: &Env, lambdas: &mut Vec<Lambda<'a>>) {
        let mut parts = Vec::with_capacity(args.len());
        for arg in args {
            let mut part = Vec::new();
            self.walk(arg, env, &mut part);
            parts.push(part);
        }
        for part in parts.into_iter().rev() {
            lambdas.extend(part);
        }
    }

    fn walk(&mut self, ast: &'a Ast, env: &Env, lambdas: &mut Vec<Lambda<'a>>) {
        match ast {
            Ast::Identity
            | Ast::Recurse
            | Ast::Literal(_)
            | Ast::Format(_)
            | Ast::Collect(None) => {}
            Ast::Index(term, key, _) => {
                self.walk(key, env, lambdas);
                self.walk(term, env, lambdas);
            }
            Ast::Slice(term, from, to, _) => {
                for bound in [from, to].into_iter().flatten() {
                    self.walk(bound, env, lambdas);
                }
                self.walk(term, env, lambdas);
            }
            Ast::Each(e, _) | Ast::Neg(e) | Ast::Collect(Some(e)) => self.walk(e, env, lambdas),
            Ast::Try(body, handler) => {
                self.walk(body, env, lambdas);
                if let Some(h) = handler {
                    self.walk(h, env, lambdas);
                }
            }
            Ast::Pipe(a, b)
            | Ast::Comma(a, b)
            | Ast::And(a, b)
            | Ast::Or(a, b)
            | Ast::Alternative(a, b) => {
                self.walk(a, env, lambdas);
                self.walk(b, env, lambdas);
            }
            Ast::Binop(_, a, b) => self.inline(&[a, b], env, lambdas),
            Ast::Update(kind, lhs, rhs) => match kind {
                Update::Assign | Update::Modify => {
                    lambdas.push((lhs, env.clone()));
                    lambdas.push((rhs, env.clone()));
                }
                Update::Arith(_) | Update::Alternative => {
                    self.walk(rhs, env, lambdas);
                    lambdas.push((lhs, env.clone()));
                }
            },
            Ast::If(cond, then, otherwise) => {
                self.walk(cond, env, lambdas);
                self.walk(then, env, lambdas);
                if let Some(e) = otherwise {
                    self.walk(e, env, lambdas);
                }
            }
            Ast::Reduce(source, patterns, init, body) => {
                self.walk(init, env, lambdas);
                self.walk(source, env, lambdas);
                self.keys(patterns, env, lambdas);
                self.walk(body, &pattern_vars(patterns, env), lambdas);
            }
            Ast::Foreach(source, patterns, init, update, extract) => {
                self.walk(init, env, lambdas);
                self.walk(source, env, lambdas);
                self.keys(patterns, env, lambdas);
                let inner = pattern_vars(patterns, env);
                self.walk(update, &inner, lambdas);
                if let Some(e) = extract {
                    self.walk(e, &inner, lambdas);
                }
            }
            Ast::Bind(source, patterns, body) => {
                self.walk(source, env, lambdas);
                self.keys(patterns, env, lambdas);
                self.walk(body, &pattern_vars(patterns, env), lambdas);
            }
            Ast::Label(name, body) => {
                let inner = with(env, Bind::Var(format!("*label-{name}")));
                self.walk(body, &inner, lambdas);
            }
            Ast::Break(name, loc) => {
                let label = format!("*label-{name}");
                if !self.bound(env, &label) {
                    self.error(*loc, format!("${label} is not defined"));
                }
            }
            Ast::Def(def, rest) => {
                let inner = define(env, def);
                if self.referenced.contains(&id(def)) {
                    lambdas.push((&def.body, body_env(&inner, def)));
                }
                self.walk(rest, &inner, lambdas);
            }
            Ast::Call(name, args, loc) => match self.callee(env, name, args.len()) {
                Callee::Defined(_) | Callee::Builtin(Kind::Jq) => {
                    lambdas.extend(args.iter().map(|a| (a, env.clone())));
                }
                Callee::Builtin(Kind::Native) => {
                    let args: Vec<&Ast> = args.iter().collect();
                    self.inline(&args, env, lambdas);
                }
                Callee::Unbound => {
                    self.error(*loc, format!("{name}/{} is not defined", args.len()));
                }
            },
            Ast::Var(name, loc) => {
                if !self.bound(env, name) {
                    self.error(*loc, format!("${name} is not defined"));
                }
            }
            Ast::Object(pairs) => {
                for (k, v) in pairs {
                    self.walk(k, env, lambdas);
                    self.walk(v, env, lambdas);
                }
            }
        }
    }

    fn keys(&mut self, patterns: &'a [Pattern], env: &Env, lambdas: &mut Vec<Lambda<'a>>) {
        let mut keys = Vec::new();
        for pattern in patterns {
            pattern_keys(pattern, &mut keys);
        }
        for key in keys {
            self.walk(key, env, lambdas);
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
        | Ast::Var(..) => {}
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
            patterns.iter().for_each(|p| pattern_keys(p, &mut out));
        }
        Ast::Foreach(source, patterns, init, update, extract) => {
            out.extend([&**source, &**init, &**update]);
            out.extend(extract.iter().map(|e| &**e));
            patterns.iter().for_each(|p| pattern_keys(p, &mut out));
        }
        Ast::Bind(source, patterns, body) => {
            out.extend([&**source, &**body]);
            patterns.iter().for_each(|p| pattern_keys(p, &mut out));
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
