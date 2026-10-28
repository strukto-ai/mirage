// Adapted from jq 1.8.2 (MIT), src/builtin.c, src/jv.c and src/jv_aux.c. See licenses/third_party/jq.txt.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::ops::Deref;
use std::sync::Arc;

use super::meter::{self, Charge};
use super::parse::parse_value;
use super::value::{Comparing, Key, List, MAX_DEPTH, Number, Object, TooDeep, Value, try_compare};
use super::vm::Limits;

const PATH_DEPTH: usize = 10000;
const INDEX_MAX: f64 = (i32::MAX >> 2) as f64;

/// How jq binds a builtin: a C function takes its arguments inline, a
/// jq-coded one as closures, which are compiled after the body calling
/// it.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Native,
    Jq,
}

/// Every builtin jq 1.8.2 binds, by name and arity, in the order
/// builtins_bind leaves them: builtin.c's function_list bound last
/// first, then its bytecoded builtins, then builtin.jq's definitions in
/// order, then `builtins` itself. `builtins` lists them in this order
/// with the underscored ones left out, as block_list_funcs does.
pub(crate) const BUILTINS: &[(&str, usize, Kind)] = &[
    ("have_literal_numbers", 0, Kind::Native),
    ("have_decnum", 0, Kind::Native),
    ("input_line_number", 0, Kind::Native),
    ("input_filename", 0, Kind::Native),
    ("now", 0, Kind::Native),
    ("localtime", 0, Kind::Native),
    ("gmtime", 0, Kind::Native),
    ("mktime", 0, Kind::Native),
    ("strflocaltime", 1, Kind::Native),
    ("strftime", 1, Kind::Native),
    ("strptime", 1, Kind::Native),
    ("stderr", 0, Kind::Native),
    ("debug", 0, Kind::Native),
    ("input", 0, Kind::Native),
    ("modulemeta", 0, Kind::Native),
    ("_match_impl", 3, Kind::Native),
    ("get_jq_origin", 0, Kind::Native),
    ("get_prog_origin", 0, Kind::Native),
    ("get_search_list", 0, Kind::Native),
    ("halt_error", 1, Kind::Native),
    ("halt", 0, Kind::Native),
    ("env", 0, Kind::Native),
    ("format", 1, Kind::Native),
    ("error", 0, Kind::Native),
    ("_max_by_impl", 1, Kind::Native),
    ("_min_by_impl", 1, Kind::Native),
    ("max", 0, Kind::Native),
    ("min", 0, Kind::Native),
    ("bsearch", 1, Kind::Native),
    ("_unique_by_impl", 1, Kind::Native),
    ("unique", 0, Kind::Native),
    ("_group_by_impl", 1, Kind::Native),
    ("_sort_by_impl", 1, Kind::Native),
    ("sort", 0, Kind::Native),
    ("nan", 0, Kind::Native),
    ("infinite", 0, Kind::Native),
    ("isnormal", 0, Kind::Native),
    ("isnan", 0, Kind::Native),
    ("isinfinite", 0, Kind::Native),
    ("type", 0, Kind::Native),
    ("utf8bytelength", 0, Kind::Native),
    ("length", 0, Kind::Native),
    ("contains", 1, Kind::Native),
    ("has", 1, Kind::Native),
    ("delpaths", 1, Kind::Native),
    ("getpath", 1, Kind::Native),
    ("setpath", 2, Kind::Native),
    ("rtrim", 0, Kind::Native),
    ("ltrim", 0, Kind::Native),
    ("trim", 0, Kind::Native),
    ("_strindices", 1, Kind::Native),
    ("implode", 0, Kind::Native),
    ("explode", 0, Kind::Native),
    ("split", 1, Kind::Native),
    ("endswith", 1, Kind::Native),
    ("startswith", 1, Kind::Native),
    ("keys_unsorted", 0, Kind::Native),
    ("keys", 0, Kind::Native),
    ("tostring", 0, Kind::Native),
    ("toboolean", 0, Kind::Native),
    ("tonumber", 0, Kind::Native),
    ("fromjson", 0, Kind::Native),
    ("tojson", 0, Kind::Native),
    ("_negate", 0, Kind::Native),
    ("_greatereq", 2, Kind::Native),
    ("_greater", 2, Kind::Native),
    ("_lesseq", 2, Kind::Native),
    ("_less", 2, Kind::Native),
    ("_notequal", 2, Kind::Native),
    ("_equal", 2, Kind::Native),
    ("_mod", 2, Kind::Native),
    ("_divide", 2, Kind::Native),
    ("_multiply", 2, Kind::Native),
    ("_minus", 2, Kind::Native),
    ("_plus", 2, Kind::Native),
    ("lgamma_r", 0, Kind::Native),
    ("frexp", 0, Kind::Native),
    ("modf", 0, Kind::Native),
    ("ldexp", 2, Kind::Native),
    ("trunc", 0, Kind::Native),
    ("significand", 0, Kind::Native),
    ("scalbln", 2, Kind::Native),
    ("scalb", 2, Kind::Native),
    ("round", 0, Kind::Native),
    ("rint", 0, Kind::Native),
    ("nexttoward", 2, Kind::Native),
    ("nextafter", 2, Kind::Native),
    ("nearbyint", 0, Kind::Native),
    ("logb", 0, Kind::Native),
    ("log1p", 0, Kind::Native),
    ("lgamma", 0, Kind::Native),
    ("gamma", 0, Kind::Native),
    ("fmod", 2, Kind::Native),
    ("fmin", 2, Kind::Native),
    ("fmax", 2, Kind::Native),
    ("fma", 3, Kind::Native),
    ("fdim", 2, Kind::Native),
    ("fabs", 0, Kind::Native),
    ("expm1", 0, Kind::Native),
    ("exp10", 0, Kind::Native),
    ("erfc", 0, Kind::Native),
    ("erf", 0, Kind::Native),
    ("drem", 2, Kind::Native),
    ("copysign", 2, Kind::Native),
    ("ceil", 0, Kind::Native),
    ("yn", 2, Kind::Native),
    ("jn", 2, Kind::Native),
    ("y1", 0, Kind::Native),
    ("y0", 0, Kind::Native),
    ("tgamma", 0, Kind::Native),
    ("tanh", 0, Kind::Native),
    ("tan", 0, Kind::Native),
    ("sqrt", 0, Kind::Native),
    ("sinh", 0, Kind::Native),
    ("sin", 0, Kind::Native),
    ("remainder", 2, Kind::Native),
    ("pow", 2, Kind::Native),
    ("log2", 0, Kind::Native),
    ("log10", 0, Kind::Native),
    ("log", 0, Kind::Native),
    ("j1", 0, Kind::Native),
    ("j0", 0, Kind::Native),
    ("hypot", 2, Kind::Native),
    ("floor", 0, Kind::Native),
    ("exp2", 0, Kind::Native),
    ("exp", 0, Kind::Native),
    ("cosh", 0, Kind::Native),
    ("cos", 0, Kind::Native),
    ("cbrt", 0, Kind::Native),
    ("atanh", 0, Kind::Native),
    ("atan2", 2, Kind::Native),
    ("atan", 0, Kind::Native),
    ("asinh", 0, Kind::Native),
    ("asin", 0, Kind::Native),
    ("acosh", 0, Kind::Native),
    ("acos", 0, Kind::Native),
    ("empty", 0, Kind::Jq),
    ("not", 0, Kind::Jq),
    ("path", 1, Kind::Jq),
    ("last", 1, Kind::Jq),
    ("range", 2, Kind::Jq),
    ("halt_error", 0, Kind::Jq),
    ("error", 1, Kind::Jq),
    ("map", 1, Kind::Jq),
    ("select", 1, Kind::Jq),
    ("sort_by", 1, Kind::Jq),
    ("group_by", 1, Kind::Jq),
    ("unique_by", 1, Kind::Jq),
    ("max_by", 1, Kind::Jq),
    ("min_by", 1, Kind::Jq),
    ("add", 1, Kind::Jq),
    ("add", 0, Kind::Jq),
    ("del", 1, Kind::Jq),
    ("abs", 0, Kind::Jq),
    ("_assign", 2, Kind::Jq),
    ("_modify", 2, Kind::Jq),
    ("map_values", 1, Kind::Jq),
    ("recurse", 1, Kind::Jq),
    ("recurse", 2, Kind::Jq),
    ("recurse", 0, Kind::Jq),
    ("to_entries", 0, Kind::Jq),
    ("from_entries", 0, Kind::Jq),
    ("with_entries", 1, Kind::Jq),
    ("reverse", 0, Kind::Jq),
    ("indices", 1, Kind::Jq),
    ("index", 1, Kind::Jq),
    ("rindex", 1, Kind::Jq),
    ("paths", 0, Kind::Jq),
    ("paths", 1, Kind::Jq),
    ("isfinite", 0, Kind::Jq),
    ("arrays", 0, Kind::Jq),
    ("objects", 0, Kind::Jq),
    ("iterables", 0, Kind::Jq),
    ("booleans", 0, Kind::Jq),
    ("numbers", 0, Kind::Jq),
    ("normals", 0, Kind::Jq),
    ("finites", 0, Kind::Jq),
    ("strings", 0, Kind::Jq),
    ("nulls", 0, Kind::Jq),
    ("values", 0, Kind::Jq),
    ("scalars", 0, Kind::Jq),
    ("join", 1, Kind::Jq),
    ("_flatten", 1, Kind::Jq),
    ("flatten", 1, Kind::Jq),
    ("flatten", 0, Kind::Jq),
    ("range", 1, Kind::Jq),
    ("fromdateiso8601", 0, Kind::Jq),
    ("todateiso8601", 0, Kind::Jq),
    ("fromdate", 0, Kind::Jq),
    ("todate", 0, Kind::Jq),
    ("ltrimstr", 1, Kind::Jq),
    ("rtrimstr", 1, Kind::Jq),
    ("trimstr", 1, Kind::Jq),
    ("match", 2, Kind::Jq),
    ("match", 1, Kind::Jq),
    ("test", 2, Kind::Jq),
    ("test", 1, Kind::Jq),
    ("capture", 2, Kind::Jq),
    ("capture", 1, Kind::Jq),
    ("scan", 2, Kind::Jq),
    ("scan", 1, Kind::Jq),
    ("splits", 2, Kind::Jq),
    ("splits", 1, Kind::Jq),
    ("split", 2, Kind::Jq),
    ("sub", 3, Kind::Jq),
    ("sub", 2, Kind::Jq),
    ("gsub", 3, Kind::Jq),
    ("gsub", 2, Kind::Jq),
    ("while", 2, Kind::Jq),
    ("until", 2, Kind::Jq),
    ("limit", 2, Kind::Jq),
    ("skip", 2, Kind::Jq),
    ("range", 3, Kind::Jq),
    ("first", 1, Kind::Jq),
    ("isempty", 1, Kind::Jq),
    ("all", 2, Kind::Jq),
    ("any", 2, Kind::Jq),
    ("all", 1, Kind::Jq),
    ("any", 1, Kind::Jq),
    ("all", 0, Kind::Jq),
    ("any", 0, Kind::Jq),
    ("nth", 2, Kind::Jq),
    ("first", 0, Kind::Jq),
    ("last", 0, Kind::Jq),
    ("nth", 1, Kind::Jq),
    ("combinations", 0, Kind::Jq),
    ("combinations", 1, Kind::Jq),
    ("transpose", 0, Kind::Jq),
    ("in", 1, Kind::Jq),
    ("inside", 1, Kind::Jq),
    ("repeat", 1, Kind::Jq),
    ("inputs", 0, Kind::Jq),
    ("ascii_downcase", 0, Kind::Jq),
    ("ascii_upcase", 0, Kind::Jq),
    ("truncate_stream", 1, Kind::Jq),
    ("fromstream", 1, Kind::Jq),
    ("tostream", 0, Kind::Jq),
    ("walk", 1, Kind::Jq),
    ("pick", 1, Kind::Jq),
    ("debug", 1, Kind::Jq),
    ("INDEX", 2, Kind::Jq),
    ("INDEX", 1, Kind::Jq),
    ("JOIN", 2, Kind::Jq),
    ("JOIN", 3, Kind::Jq),
    ("JOIN", 4, Kind::Jq),
    ("IN", 1, Kind::Jq),
    ("IN", 2, Kind::Jq),
    ("builtins", 0, Kind::Native),
];

/// Why a native builtin produced no value.
pub(crate) enum Fault {
    Error(Value),
    Halt(Option<Value>, Option<f64>),
}

type Answer = Result<Value, Fault>;

fn deep_compare(_: TooDeep) -> Fault {
    fail("Comparison too deep")
}

fn deep_equal(_: TooDeep) -> Fault {
    fail("Equality check too deep")
}

fn order(a: &Value, b: &Value) -> Result<Ordering, Fault> {
    try_compare(a, b).map_err(deep_compare)
}

#[derive(Clone, Copy)]
enum Pass {
    Sort,
    Group,
    Unique,
    Min,
    Max,
}

/// A sort-family call in progress: a stable bottom-up merge sort over
/// indices, then the pass that builds the answer from the sorted pairs,
/// with every loop variable held here so a slice can stop between any
/// two comparisons. A merge sort of our own: jq's number order is not
/// total (a literal and a computed number compare by different rules),
/// and the standard library's sort may panic on
/// such an order. `min` and `max` skip the sort and walk the input.
pub(crate) struct Sorting {
    pass: Pass,
    keys: Arc<List>,
    values: Arc<List>,
    order: Vec<usize>,
    merged: Vec<usize>,
    width: usize,
    start: usize,
    i: usize,
    j: usize,
    slot: usize,
    at: usize,
    last: Option<usize>,
    best: usize,
    out: Vec<Value>,
    groups: Vec<Value>,
    comparing: Option<Comparing>,
    charge: Charge,
}

/// The sort-family call `f` over `args`, its operands checked as jq
/// checks them.
pub(crate) fn sorting(f: Cfunc, args: &[Value]) -> Result<Sorting, Fault> {
    let input = &args[0];
    let a = args.get(1).unwrap_or(&Value::Null);
    let (pass, values, keys) = match f {
        Cfunc::Sort => (Pass::Sort, input, input),
        Cfunc::Unique => (Pass::Unique, input, input),
        Cfunc::SortByImpl => (Pass::Sort, input, a),
        Cfunc::GroupByImpl => (Pass::Group, input, a),
        Cfunc::UniqueByImpl => (Pass::Unique, input, a),
        Cfunc::Min => (Pass::Min, input, input),
        Cfunc::Max => (Pass::Max, input, input),
        Cfunc::MinByImpl => (Pass::Min, input, a),
        Cfunc::MaxByImpl => (Pass::Max, input, a),
        other => unreachable!("{other:?} is not a sort"),
    };
    let lists = match (values, keys) {
        (Value::Array(v), Value::Array(k)) => Some((Arc::clone(v), k.clone())),
        _ => None,
    };
    let (values, keys) = match (pass, lists) {
        (Pass::Min | Pass::Max, None) => {
            return Err(type_error2(values, keys, "cannot be iterated over"));
        }
        (Pass::Min | Pass::Max, Some((v, k))) if v.len() != k.len() => {
            return Err(type_error2(values, keys, "have wrong length"));
        }
        (_, Some((v, k))) if v.len() == k.len() => (v, k),
        _ if f == Cfunc::Sort || f == Cfunc::Unique => {
            return Err(type_error(input, "cannot be sorted, as it is not an array"));
        }
        _ => {
            return Err(type_error2(
                values,
                keys,
                "cannot be sorted, as they are not both arrays",
            ));
        }
    };
    let n = values.len();
    let width = match pass {
        Pass::Min | Pass::Max => n,
        _ => 1,
    };
    Ok(Sorting {
        pass,
        keys,
        values,
        order: Vec::new(),
        merged: Vec::new(),
        width,
        start: 0,
        i: 0,
        j: width.min(n),
        slot: 0,
        at: 0,
        last: None,
        best: 0,
        out: Vec::new(),
        groups: Vec::new(),
        comparing: None,
        charge: Charge::open(0),
    })
}

impl Sorting {
    pub(crate) fn retire(&mut self) -> Option<Value> {
        if let Some(comparing) = &mut self.comparing {
            if let Some(value) = comparing.retire() {
                return Some(value);
            }
            self.comparing = None;
        }
        if let Some(value) = self.out.pop().or_else(|| self.groups.pop()) {
            return Some(value);
        }
        if !self.values.is_empty() {
            return Some(Value::Array(std::mem::take(&mut self.values)));
        }
        if !self.keys.is_empty() {
            return Some(Value::Array(std::mem::take(&mut self.keys)));
        }
        None
    }

    /// The answer once the pass finishes, or None when its budget runs out.
    pub(crate) fn run(&mut self, budget: &mut u64) -> Option<Result<Value, Fault>> {
        let n = self.values.len();
        while *budget > 0 {
            *budget -= 1;
            let step = if self.order.len() < n {
                self.order.push(self.order.len());
                self.merged.push(0);
                Ok(None)
            } else if self.width < n {
                self.merge(budget).map(|()| None)
            } else {
                self.pass(budget)
            };
            self.recharge();
            if meter::should_pause() {
                if let Ok(Some(value)) = step {
                    self.out.push(value);
                }
                *budget = 0;
                return None;
            }
            match step {
                Ok(None) => {}
                Ok(Some(value)) => return Some(Ok(value)),
                Err(_) => return Some(Err(deep_compare(TooDeep))),
            }
        }
        None
    }

    fn recharge(&mut self) {
        self.charge.set(
            (self.order.capacity() + self.merged.capacity()) * std::mem::size_of::<usize>()
                + (self.out.capacity() + self.groups.capacity()) * std::mem::size_of::<Value>(),
        );
    }

    fn array(&mut self, groups: bool) -> Value {
        let items = if groups {
            std::mem::take(&mut self.groups)
        } else {
            std::mem::take(&mut self.out)
        };
        self.recharge();
        Value::array(items)
    }

    pub(crate) fn finish(mut self) -> Result<Value, Fault> {
        let _recording = meter::record_only();
        let mut budget = u64::MAX;
        self.run(&mut budget)
            .unwrap_or_else(|| unreachable!("an unbounded budget finishes the sort"))
    }

    fn compare(
        &mut self,
        a: usize,
        b: usize,
        budget: &mut u64,
        equality: bool,
    ) -> Result<Option<Ordering>, TooDeep> {
        if *budget == 0 {
            *budget = 1;
        }
        let comparing = self.comparing.get_or_insert_with(|| {
            if equality {
                Comparing::equality(self.keys[a].clone(), self.keys[b].clone())
            } else {
                Comparing::begin(self.keys[a].clone(), self.keys[b].clone())
            }
        });
        match comparing.run(budget) {
            Some(answer) => {
                self.comparing = None;
                answer.map(Some)
            }
            None => Ok(None),
        }
    }

    fn merge(&mut self, budget: &mut u64) -> Result<(), TooDeep> {
        let n = self.order.len();
        let mid = (self.start + self.width).min(n);
        let end = (self.start + 2 * self.width).min(n);
        if self.slot < end {
            let left = if self.i >= mid {
                false
            } else if self.j >= end {
                true
            } else {
                let Some(order) =
                    self.compare(self.order[self.i], self.order[self.j], budget, false)?
                else {
                    return Ok(());
                };
                order != Ordering::Greater
            };
            let from = if left { &mut self.i } else { &mut self.j };
            self.merged[self.slot] = self.order[*from];
            *from += 1;
            self.slot += 1;
            return Ok(());
        }
        self.start = end;
        if self.start >= n {
            std::mem::swap(&mut self.order, &mut self.merged);
            self.width *= 2;
            self.start = 0;
        }
        self.i = self.start;
        self.j = (self.start + self.width).min(n);
        self.slot = self.start;
        Ok(())
    }

    fn pass(&mut self, budget: &mut u64) -> Result<Option<Value>, TooDeep> {
        let n = self.order.len();
        if self.at < n {
            let k = self.order[self.at];
            match self.pass {
                Pass::Sort => self.out.push(self.values[k].clone()),
                Pass::Group => {
                    if let Some(prev) = self.last {
                        let Some(order) = self.compare(prev, k, budget, true)? else {
                            return Ok(None);
                        };
                        if order != Ordering::Equal {
                            let group = self.array(false);
                            self.groups.push(group);
                        }
                    }
                    self.out.push(self.values[k].clone());
                    self.last = Some(k);
                }
                Pass::Unique => {
                    let same = match self.last {
                        Some(prev) => {
                            let Some(order) = self.compare(prev, k, budget, true)? else {
                                return Ok(None);
                            };
                            order == Ordering::Equal
                        }
                        None => false,
                    };
                    if !same {
                        self.out.push(self.values[k].clone());
                        self.last = Some(k);
                    }
                }
                Pass::Min | Pass::Max => {
                    if self.at > 0 {
                        let Some(order) = self.compare(k, self.best, budget, false)? else {
                            return Ok(None);
                        };
                        let less = order == Ordering::Less;
                        if less == matches!(self.pass, Pass::Min) {
                            self.best = k;
                        }
                    }
                }
            }
            self.at += 1;
            return Ok(None);
        }
        Ok(Some(match self.pass {
            Pass::Sort | Pass::Unique => self.array(false),
            Pass::Group => {
                if !self.out.is_empty() {
                    let group = self.array(false);
                    self.groups.push(group);
                }
                self.array(true)
            }
            Pass::Min | Pass::Max if n == 0 => Value::Null,
            Pass::Min | Pass::Max => self.values[self.best].clone(),
        }))
    }
}

pub(super) fn fail(message: impl Into<String>) -> Fault {
    Fault::Error(StringBuffer::from(message.into()).into_value())
}

pub(super) fn type_error(bad: &Value, message: &str) -> Fault {
    fail(format!("{} ({}) {message}", bad.kind(), bad.dump_trunc()))
}

fn type_error2(a: &Value, b: &Value, message: &str) -> Fault {
    fail(format!(
        "{} ({}) and {} ({}) {message}",
        a.kind(),
        a.dump_trunc(),
        b.kind(),
        b.dump_trunc()
    ))
}

macro_rules! cfuncs {
    ($($variant:ident = $name:literal / $arity:literal),* $(,)?) => {
        /// The native builtins: jq's function_list, those this engine has.
        #[derive(Clone, Copy, Debug, PartialEq)]
        pub(crate) enum Cfunc { $($variant),* }

        /// The builtin `name/arity` names, arity counting jq arguments only.
        pub(crate) fn lookup(name: &str, arity: usize) -> Option<Cfunc> {
            match (name, arity) {
                $(($name, $arity) => Some(Cfunc::$variant),)*
                _ => None,
            }
        }
    };
}

cfuncs! {
    Negate = "_negate" / 0,
    Plus = "_plus" / 2,
    Minus = "_minus" / 2,
    Multiply = "_multiply" / 2,
    Divide = "_divide" / 2,
    Mod = "_mod" / 2,
    Equal = "_equal" / 2,
    NotEqual = "_notequal" / 2,
    Less = "_less" / 2,
    LessEq = "_lesseq" / 2,
    Greater = "_greater" / 2,
    GreaterEq = "_greatereq" / 2,
    ToJson = "tojson" / 0,
    FromJson = "fromjson" / 0,
    ToNumber = "tonumber" / 0,
    ToBoolean = "toboolean" / 0,
    ToString = "tostring" / 0,
    Keys = "keys" / 0,
    KeysUnsorted = "keys_unsorted" / 0,
    StartsWith = "startswith" / 1,
    EndsWith = "endswith" / 1,
    Split = "split" / 1,
    Explode = "explode" / 0,
    Implode = "implode" / 0,
    StrIndices = "_strindices" / 1,
    Trim = "trim" / 0,
    LTrim = "ltrim" / 0,
    RTrim = "rtrim" / 0,
    SetPath = "setpath" / 2,
    GetPath = "getpath" / 1,
    DelPaths = "delpaths" / 1,
    Has = "has" / 1,
    Contains = "contains" / 1,
    Length = "length" / 0,
    Utf8ByteLength = "utf8bytelength" / 0,
    Type = "type" / 0,
    IsInfinite = "isinfinite" / 0,
    IsNan = "isnan" / 0,
    IsNormal = "isnormal" / 0,
    Infinite = "infinite" / 0,
    Nan = "nan" / 0,
    Sort = "sort" / 0,
    SortByImpl = "_sort_by_impl" / 1,
    GroupByImpl = "_group_by_impl" / 1,
    Unique = "unique" / 0,
    UniqueByImpl = "_unique_by_impl" / 1,
    Bsearch = "bsearch" / 1,
    Min = "min" / 0,
    Max = "max" / 0,
    MinByImpl = "_min_by_impl" / 1,
    MaxByImpl = "_max_by_impl" / 1,
    Error = "error" / 0,
    Format = "format" / 1,
    Halt = "halt" / 0,
    HaltError = "halt_error" / 1,
    InputFilename = "input_filename" / 0,
    InputLineNumber = "input_line_number" / 0,
    Input = "input" / 0,
    Debug = "debug" / 0,
    Stderr = "stderr" / 0,
    Env = "env" / 0,
    HaveDecnum = "have_decnum" / 0,
    HaveLiteralNumbers = "have_literal_numbers" / 0,
    Floor = "floor" / 0,
    Ceil = "ceil" / 0,
    Round = "round" / 0,
    Trunc = "trunc" / 0,
    Rint = "rint" / 0,
    NearbyInt = "nearbyint" / 0,
    Fabs = "fabs" / 0,
    Sqrt = "sqrt" / 0,
    Cbrt = "cbrt" / 0,
    Exp = "exp" / 0,
    Exp2 = "exp2" / 0,
    Exp10 = "exp10" / 0,
    Expm1 = "expm1" / 0,
    Log = "log" / 0,
    Log2 = "log2" / 0,
    Log10 = "log10" / 0,
    Log1p = "log1p" / 0,
    Sin = "sin" / 0,
    Cos = "cos" / 0,
    Tan = "tan" / 0,
    Asin = "asin" / 0,
    Acos = "acos" / 0,
    Atan = "atan" / 0,
    Sinh = "sinh" / 0,
    Cosh = "cosh" / 0,
    Tanh = "tanh" / 0,
    Asinh = "asinh" / 0,
    Acosh = "acosh" / 0,
    Atanh = "atanh" / 0,
    Significand = "significand" / 0,
    Logb = "logb" / 0,
    Frexp = "frexp" / 0,
    Modf = "modf" / 0,
    Pow = "pow" / 2,
    Atan2 = "atan2" / 2,
    Fmod = "fmod" / 2,
    Fmin = "fmin" / 2,
    Fmax = "fmax" / 2,
    Fdim = "fdim" / 2,
    Hypot = "hypot" / 2,
    Copysign = "copysign" / 2,
    Ldexp = "ldexp" / 2,
    Scalb = "scalb" / 2,
    Scalbln = "scalbln" / 2,
    Fma = "fma" / 3,
    NextAfter = "nextafter" / 2,
    NextToward = "nexttoward" / 2,
    Builtins = "builtins" / 0,
    ModuleMeta = "modulemeta" / 0,
    GetSearchList = "get_search_list" / 0,
    GetJqOrigin = "get_jq_origin" / 0,
    GetProgOrigin = "get_prog_origin" / 0,
    Now = "now" / 0,
    Mktime = "mktime" / 0,
    Gmtime = "gmtime" / 0,
    Localtime = "localtime" / 0,
    Strftime = "strftime" / 1,
    StrfLocaltime = "strflocaltime" / 1,
    Strptime = "strptime" / 1,
    MatchImpl = "_match_impl" / 3,
}

/// Steps a call is charged beyond its dispatch: one per 16 elements or
/// bytes of its operands, so work on a large value pauses sooner.
pub(crate) fn cost(args: &[Value]) -> u64 {
    args.iter()
        .map(|arg| match arg {
            Value::Array(items) => items.len() as u64 / 16,
            Value::Object(fields) => fields.len() as u64 / 16,
            Value::String(text) => text.len() as u64 / 64,
            _ => 0,
        })
        .sum()
}

fn num(v: &Value) -> Result<f64, Fault> {
    v.as_f64().ok_or_else(|| type_error(v, "number required"))
}

fn math1(input: &Value, f: fn(f64) -> f64) -> Answer {
    Ok(Value::number(f(num(input)?)))
}

fn math2(a: &Value, b: &Value, f: fn(f64, f64) -> f64) -> Answer {
    Ok(Value::number(f(num(a)?, num(b)?)))
}

pub(super) fn string_too_long(limits: Limits) -> Fault {
    fail(format!(
        "jq string limit of {} bytes exceeded",
        limits.bytes
    ))
}

pub(super) fn string_limit(text: String, limits: Limits) -> Answer {
    StringBuffer::from(text).finish(limits)
}

pub(super) fn array_limit(items: Vec<Value>, limits: Limits) -> Answer {
    let mut charge = Charge::open(items.capacity() * std::mem::size_of::<Value>());
    if items.len() > limits.items {
        return Err(fail(format!(
            "jq array limit of {} elements exceeded",
            limits.items
        )));
    }
    charge.set(0);
    Ok(Value::array(items))
}

pub(crate) fn call(f: Cfunc, args: &[Value], limits: Limits) -> Answer {
    let input = &args[0];
    let a = args.get(1).unwrap_or(&Value::Null);
    let b = args.get(2).unwrap_or(&Value::Null);
    match f {
        Cfunc::Negate => match input {
            Value::Number(n) => Ok(Value::Number(n.negate())),
            _ => Err(type_error(input, "cannot be negated")),
        },
        Cfunc::Plus => plus(a, b, limits),
        Cfunc::Minus => minus(a, b),
        Cfunc::Multiply => multiply(a, b, limits),
        Cfunc::Divide => divide(a, b, limits),
        Cfunc::Mod => modulo(a, b),
        Cfunc::Equal => Ok(Value::bool(a.try_equals(b).map_err(deep_equal)?)),
        Cfunc::NotEqual => Ok(Value::bool(!a.try_equals(b).map_err(deep_equal)?)),
        Cfunc::Less => Ok(Value::bool(order(a, b)? == Ordering::Less)),
        Cfunc::LessEq => Ok(Value::bool(order(a, b)? != Ordering::Greater)),
        Cfunc::Greater => Ok(Value::bool(order(a, b)? == Ordering::Greater)),
        Cfunc::GreaterEq => Ok(Value::bool(order(a, b)? != Ordering::Less)),
        Cfunc::ToJson => string_limit(input.dump(), limits),
        Cfunc::FromJson => match input {
            Value::String(text) => parse_value(text.as_bytes()).map_err(fail),
            _ => Err(type_error(input, "only strings can be parsed")),
        },
        Cfunc::ToNumber => match input {
            Value::Number(_) => Ok(input.clone()),
            Value::String(text) if is_number(text) => Ok(Value::Number(Number::literal(text))),
            _ => Err(type_error(input, "cannot be parsed as a number")),
        },
        Cfunc::ToBoolean => match input {
            Value::True | Value::False => Ok(input.clone()),
            Value::String(text) if &**text == "true" => Ok(Value::True),
            Value::String(text) if &**text == "false" => Ok(Value::False),
            _ => Err(type_error(input, "cannot be parsed as a boolean")),
        },
        Cfunc::ToString => match input {
            Value::String(_) => Ok(input.clone()),
            _ => string_limit(input.dump(), limits),
        },
        Cfunc::Keys | Cfunc::KeysUnsorted => match input {
            Value::Object(fields) => {
                let keys = if f == Cfunc::Keys {
                    let keys = fields.sorted_keys();
                    let _charge = Charge::open(keys.capacity() * std::mem::size_of::<&Key>());
                    Value::array(keys.iter().map(|&k| Value::String(k.text())).collect())
                } else {
                    Value::array(
                        fields
                            .iter()
                            .map(|(k, _)| Value::String(k.text()))
                            .collect(),
                    )
                };
                Ok(keys)
            }
            Value::Array(items) => Ok(Value::array(
                (0..items.len()).map(|i| Value::number(i as f64)).collect(),
            )),
            _ => Err(type_error(input, "has no keys")),
        },
        Cfunc::StartsWith => match (input, a) {
            (Value::String(s), Value::String(p)) => Ok(Value::bool(s.starts_with(p.as_str()))),
            _ => Err(fail("startswith() requires string inputs")),
        },
        Cfunc::EndsWith => match (input, a) {
            (Value::String(s), Value::String(p)) => Ok(Value::bool(s.ends_with(p.as_str()))),
            _ => Err(fail("endswith() requires string inputs")),
        },
        Cfunc::Split => match (input, a) {
            (Value::String(s), Value::String(sep)) => split(s, sep, limits),
            _ => Err(fail("split input and separator must be strings")),
        },
        Cfunc::Explode => match input {
            Value::String(s) => array_limit(
                s.chars().map(|c| Value::number(c as u32 as f64)).collect(),
                limits,
            ),
            _ => Err(fail("explode input must be a string")),
        },
        Cfunc::Implode => implode(input, limits),
        Cfunc::StrIndices => match (input, a) {
            (Value::String(s), Value::String(needle)) => Ok(Value::array(indices(s, needle))),
            (Value::String(_), _) => Err(type_error(a, "is not a string")),
            _ => Err(type_error(
                input,
                "cannot be searched, as it is not a string",
            )),
        },
        Cfunc::Trim | Cfunc::LTrim | Cfunc::RTrim => match input {
            Value::String(s) => {
                let out = match f {
                    Cfunc::Trim => s.trim(),
                    Cfunc::LTrim => s.trim_start(),
                    _ => s.trim_end(),
                };
                if out.len() == s.len() {
                    Ok(input.clone())
                } else {
                    Ok(Value::string(out))
                }
            }
            _ => Err(fail("trim input must be a string")),
        },
        Cfunc::SetPath => setpath(input.clone(), a, b.clone(), limits),
        Cfunc::GetPath => getpath(input, a),
        Cfunc::DelPaths => delpaths(input.clone(), a, limits),
        Cfunc::Has => has(input, a),
        Cfunc::Contains => {
            if input.kind() == a.kind() && (input.rank_kind() == a.rank_kind()) {
                Ok(Value::bool(contains(input, a)?))
            } else {
                Err(type_error2(
                    input,
                    a,
                    "cannot have their containment checked",
                ))
            }
        }
        Cfunc::Length => match input {
            Value::Array(items) => Ok(Value::number(items.len() as f64)),
            Value::Object(fields) => Ok(Value::number(fields.len() as f64)),
            Value::String(s) => Ok(Value::number(s.chars().count() as f64)),
            Value::Number(n) if n.value() < 0.0 => Ok(Value::Number(n.negate())),
            Value::Number(_) => Ok(input.clone()),
            Value::Null => Ok(Value::number(0.0)),
            _ => Err(type_error(input, "has no length")),
        },
        Cfunc::Utf8ByteLength => match input {
            Value::String(s) => Ok(Value::number(s.len() as f64)),
            _ => Err(type_error(input, "only strings have UTF-8 byte length")),
        },
        Cfunc::Type => Ok(Value::string(input.kind())),
        Cfunc::IsInfinite => Ok(Value::bool(input.as_f64().is_some_and(f64::is_infinite))),
        Cfunc::IsNan => Ok(Value::bool(input.as_f64().is_some_and(f64::is_nan))),
        Cfunc::IsNormal => Ok(Value::bool(input.as_f64().is_some_and(f64::is_normal))),
        Cfunc::Infinite => Ok(Value::number(f64::INFINITY)),
        Cfunc::Nan => Ok(Value::number(f64::NAN)),
        Cfunc::Sort
        | Cfunc::SortByImpl
        | Cfunc::GroupByImpl
        | Cfunc::Unique
        | Cfunc::UniqueByImpl => sorting(f, args)?.finish(),
        Cfunc::Bsearch => bsearch(input, a),
        Cfunc::Min | Cfunc::Max | Cfunc::MinByImpl | Cfunc::MaxByImpl => sorting(f, args)?.finish(),
        Cfunc::Error => Err(Fault::Error(input.clone())),
        Cfunc::Format => format(input, a, limits),
        Cfunc::Halt => Err(Fault::Halt(None, None)),
        Cfunc::HaltError => match a {
            Value::Number(code) => Err(Fault::Halt(Some(input.clone()), Some(code.value()))),
            _ => Err(type_error(input, "halt_error/1: number required")),
        },
        Cfunc::InputFilename
        | Cfunc::InputLineNumber
        | Cfunc::Input
        | Cfunc::Debug
        | Cfunc::Stderr
        | Cfunc::Env => unreachable!("the VM answers its host builtins"),
        Cfunc::HaveDecnum => Ok(Value::True),
        Cfunc::HaveLiteralNumbers => Ok(Value::True),
        Cfunc::Floor => math1(input, f64::floor),
        Cfunc::Ceil => math1(input, f64::ceil),
        Cfunc::Round => math1(input, f64::round),
        Cfunc::Trunc => math1(input, f64::trunc),
        Cfunc::Rint | Cfunc::NearbyInt => math1(input, f64::round_ties_even),
        Cfunc::Fabs => math1(input, f64::abs),
        Cfunc::Sqrt => math1(input, f64::sqrt),
        Cfunc::Cbrt => math1(input, f64::cbrt),
        Cfunc::Exp => math1(input, f64::exp),
        Cfunc::Exp2 => math1(input, f64::exp2),
        Cfunc::Exp10 => math1(input, |x| 10f64.powf(x)),
        Cfunc::Expm1 => math1(input, f64::exp_m1),
        Cfunc::Log => math1(input, f64::ln),
        Cfunc::Log2 => math1(input, f64::log2),
        Cfunc::Log10 => math1(input, f64::log10),
        Cfunc::Log1p => math1(input, f64::ln_1p),
        Cfunc::Sin => math1(input, f64::sin),
        Cfunc::Cos => math1(input, f64::cos),
        Cfunc::Tan => math1(input, f64::tan),
        Cfunc::Asin => math1(input, f64::asin),
        Cfunc::Acos => math1(input, f64::acos),
        Cfunc::Atan => math1(input, f64::atan),
        Cfunc::Sinh => math1(input, f64::sinh),
        Cfunc::Cosh => math1(input, f64::cosh),
        Cfunc::Tanh => math1(input, f64::tanh),
        Cfunc::Asinh => math1(input, f64::asinh),
        Cfunc::Acosh => math1(input, f64::acosh),
        Cfunc::Atanh => math1(input, f64::atanh),
        Cfunc::Significand => math1(input, |x| {
            if x == 0.0 || !x.is_finite() {
                x
            } else {
                2.0 * frexp(x).0
            }
        }),
        Cfunc::Logb => math1(input, |x| {
            if x == 0.0 {
                f64::NEG_INFINITY
            } else if !x.is_finite() {
                x.abs()
            } else {
                (frexp(x).1 - 1) as f64
            }
        }),
        Cfunc::Frexp => {
            let (m, e) = frexp(num(input)?);
            Ok(Value::array(vec![
                Value::number(m),
                Value::number(e as f64),
            ]))
        }
        Cfunc::Modf => {
            let x = num(input)?;
            let int = x.trunc();
            let frac = if x.is_infinite() {
                0.0f64.copysign(x)
            } else {
                x - int
            };
            Ok(Value::array(vec![Value::number(frac), Value::number(int)]))
        }
        Cfunc::Pow => math2(a, b, f64::powf),
        Cfunc::Atan2 => math2(a, b, f64::atan2),
        Cfunc::Fmod => math2(a, b, |x, y| x % y),
        Cfunc::Fmin => math2(a, b, f64::min),
        Cfunc::Fmax => math2(a, b, f64::max),
        Cfunc::Fdim => math2(a, b, |x, y| if x > y { x - y } else { 0.0 }),
        Cfunc::Hypot => math2(a, b, f64::hypot),
        Cfunc::Copysign => math2(a, b, f64::copysign),
        Cfunc::Ldexp | Cfunc::Scalb | Cfunc::Scalbln => math2(a, b, scale),
        Cfunc::Fma => {
            let c = args.get(3).unwrap_or(&Value::Null);
            Ok(Value::number(num(a)?.mul_add(num(b)?, num(c)?)))
        }
        Cfunc::NextAfter | Cfunc::NextToward => math2(a, b, nextafter),
        Cfunc::Builtins => Ok(builtins()),
        Cfunc::ModuleMeta => match input {
            Value::String(name) => Err(fail(module_error(name))),
            _ => Err(fail("modulemeta input module name must be a string")),
        },
        Cfunc::GetSearchList => Ok(Value::array(
            ["~/.jq", "$ORIGIN/../lib/jq", "$ORIGIN/../lib"]
                .into_iter()
                .map(Value::string)
                .collect(),
        )),
        Cfunc::GetJqOrigin | Cfunc::GetProgOrigin => Ok(Value::Null),
        Cfunc::Now
        | Cfunc::Mktime
        | Cfunc::Gmtime
        | Cfunc::Localtime
        | Cfunc::Strftime
        | Cfunc::StrfLocaltime
        | Cfunc::Strptime => unreachable!("the VM runs the time builtins with its clock"),
        Cfunc::MatchImpl => {
            let _recording = meter::record_only();
            let mut budget = u64::MAX;
            super::regex::Matching::begin(args)?
                .run(&mut budget, limits)
                .unwrap_or_else(|| unreachable!("an unlimited search paused"))
        }
    }
}

impl Value {
    fn rank_kind(&self) -> u8 {
        match self {
            Value::False => 1,
            Value::True => 2,
            _ => 0,
        }
    }
}

fn builtins() -> Value {
    Value::array(
        BUILTINS
            .iter()
            .filter(|(name, _, _)| !name.starts_with('_'))
            .map(|(name, arity, _)| Value::string(format!("{name}/{arity}")))
            .collect(),
    )
}

pub(crate) fn module_error(path: &str) -> String {
    if path.contains('\0') {
        return "Module path contains a NUL byte".into();
    }
    if path.contains('\\') {
        return format!("Modules must be named by relative paths using '/', not '\\' ({path})");
    }
    let mut previous = None;
    for component in path.split('/') {
        if component == ".." {
            return format!(
                "Relative paths to modules may not traverse to parent directories ({path})"
            );
        }
        if Some(component) == previous {
            return format!("module names must not have equal consecutive components: {path}");
        }
        previous = Some(component);
    }
    format!("module not found: {path}")
}

/// nextafter: the double adjacent to `x` on `y`'s side.
fn nextafter(x: f64, y: f64) -> f64 {
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if x == y {
        return y;
    }
    if x == 0.0 {
        return f64::from_bits(1).copysign(y);
    }
    let bits = x.to_bits();
    let away = (y > x) == (x > 0.0);
    f64::from_bits(if away { bits + 1 } else { bits - 1 })
}

fn frexp(x: f64) -> (f64, i32) {
    if x == 0.0 || !x.is_finite() {
        return (x, 0);
    }
    let bits = x.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i32;
    if exp == 0 {
        let (m, e) = frexp(x * 2f64.powi(54));
        return (m, e - 54);
    }
    let m = f64::from_bits((bits & !(0x7ff << 52)) | (1022 << 52));
    (m, exp - 1022)
}

fn is_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0;
    if matches!(bytes.get(at), Some(b'-' | b'+')) {
        at += 1;
    }
    let digits = |at: &mut usize| {
        let start = *at;
        while bytes.get(*at).is_some_and(u8::is_ascii_digit) {
            *at += 1;
        }
        *at > start
    };
    let int = digits(&mut at);
    let mut frac = false;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        frac = digits(&mut at);
    }
    if !int && !frac {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        if !digits(&mut at) {
            return false;
        }
    }
    at == bytes.len()
}

fn plus(a: &Value, b: &Value, limits: Limits) -> Answer {
    match (a, b) {
        (Value::Null, _) => Ok(b.clone()),
        (_, Value::Null) => Ok(a.clone()),
        (Value::Number(x), Value::Number(y)) => Ok(Value::number(x.value() + y.value())),
        (Value::String(x), Value::String(y)) => {
            let mut text = String::with_capacity(x.len() + y.len());
            text.push_str(x);
            text.push_str(y);
            string_limit(text, limits)
        }
        (Value::Array(x), Value::Array(y)) => {
            let mut items = x.to_vec();
            items.extend(y.iter().cloned());
            array_limit(items, limits)
        }
        (Value::Object(x), Value::Object(y)) => {
            let mut merged: Object = (**x).clone();
            for (k, v) in y.iter() {
                merged.insert(k.clone(), v.clone());
            }
            Ok(Value::object(merged))
        }
        _ => Err(type_error2(a, b, "cannot be added")),
    }
}

fn minus(a: &Value, b: &Value) -> Answer {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => Ok(Value::number(x.value() - y.value())),
        (Value::Array(x), Value::Array(y)) => Ok(Value::array(
            x.iter()
                .filter(|item| !y.iter().any(|other| item.equals(other)))
                .cloned()
                .collect(),
        )),
        _ => Err(type_error2(a, b, "cannot be subtracted")),
    }
}

/// One array subtraction in progress: binop_minus scans `b` for each item
/// of `a`, which two long arrays make quadratic, so the scan stops when
/// the step budget runs out and goes on at the next drain.
pub(crate) struct Subtracting {
    from: Arc<List>,
    without: Arc<List>,
    at: usize,
    against: usize,
    kept: Vec<Value>,
    comparing: Option<Comparing>,
    charge: Charge,
}

impl Subtracting {
    /// The scan `_minus`'s operands ask for, when both are arrays.
    pub(crate) fn begin(args: &[Value]) -> Option<Subtracting> {
        match (args.get(1), args.get(2)) {
            (Some(Value::Array(from)), Some(Value::Array(without))) => Some(Subtracting {
                from: Arc::clone(from),
                without: Arc::clone(without),
                at: 0,
                against: 0,
                kept: Vec::new(),
                comparing: None,
                charge: Charge::open(0),
            }),
            _ => None,
        }
    }

    /// Scans on, spending `budget`: None when it ran out before the end.
    pub(crate) fn run(&mut self, budget: &mut u64) -> Option<Result<Value, Fault>> {
        while self.at < self.from.len() {
            if *budget == 0 {
                return None;
            }
            *budget -= 1;
            let item = &self.from[self.at];
            if let Some(other) = self.without.get(self.against) {
                if *budget == 0 {
                    *budget = 1;
                }
                let comparing = self
                    .comparing
                    .get_or_insert_with(|| Comparing::equality(item.clone(), other.clone()));
                let answer = comparing.run(budget)?;
                self.comparing = None;
                if answer.is_ok_and(|order| order == Ordering::Equal) {
                    self.at += 1;
                    self.against = 0;
                } else {
                    self.against += 1;
                }
            } else {
                self.kept.push(item.clone());
                self.charge
                    .set(self.kept.capacity() * std::mem::size_of::<Value>());
                if meter::should_pause() {
                    *budget = 0;
                    return None;
                }
                self.at += 1;
                self.against = 0;
            }
        }
        self.charge.set(0);
        Some(Ok(Value::array(std::mem::take(&mut self.kept))))
    }

    pub(crate) fn retire(&mut self) -> Option<Value> {
        if let Some(comparing) = &mut self.comparing {
            if let Some(value) = comparing.retire() {
                return Some(value);
            }
            self.comparing = None;
        }
        self.kept.pop().or_else(|| {
            if !self.from.is_empty() {
                Some(Value::Array(std::mem::take(&mut self.from)))
            } else if !self.without.is_empty() {
                Some(Value::Array(std::mem::take(&mut self.without)))
            } else {
                None
            }
        })
    }
}

fn multiply(a: &Value, b: &Value, limits: Limits) -> Answer {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => Ok(Value::number(x.value() * y.value())),
        (Value::String(s), Value::Number(n)) | (Value::Number(n), Value::String(s)) => {
            let d = n.value();
            if d < 0.0 || d.is_nan() {
                return Ok(Value::Null);
            }
            let times = if d > i32::MAX as f64 {
                i32::MAX as usize
            } else {
                d as usize
            };
            if (s.len() as u64).saturating_mul(times as u64) > limits.bytes as u64 {
                return Err(fail("Repeat string result too long"));
            }
            Ok(StringBuffer::from(s.repeat(times)).into_value())
        }
        (Value::Object(_), Value::Object(_)) => merge_deep(a, b),
        _ => Err(type_error2(a, b, "cannot be multiplied")),
    }
}

/// jv_object_merge_recursive, walked with a stack of the objects it is
/// rebuilding.
fn merge_deep(a: &Value, b: &Value) -> Answer {
    struct Level {
        merged: Object,
        from: Arc<Object>,
        at: usize,
        key: Option<Key>,
    }
    let (Value::Object(x), Value::Object(y)) = (a, b) else {
        return Ok(b.clone());
    };
    let mut stack = vec![Level {
        merged: (**x).clone(),
        from: Arc::clone(y),
        at: 0,
        key: None,
    }];
    loop {
        let depth = stack.len();
        let top = stack.last_mut().expect("a level is open");
        if let Some((k, v)) = top.from.entry(top.at).map(|(k, v)| (k.clone(), v.clone())) {
            top.at += 1;
            match (top.merged.get(&k), &v) {
                (Some(Value::Object(old)), Value::Object(new)) => {
                    if depth > MAX_DEPTH {
                        return Err(fail("Object merge too deep"));
                    }
                    let level = Level {
                        merged: (**old).clone(),
                        from: Arc::clone(new),
                        at: 0,
                        key: Some(k),
                    };
                    stack.push(level);
                }
                _ => top.merged.insert(k, v),
            }
            continue;
        }
        let done = stack.pop().expect("a level is open");
        let value = Value::object(done.merged);
        match (stack.last_mut(), done.key) {
            (Some(parent), Some(key)) => parent.merged.insert(key, value),
            _ => return Ok(value),
        }
    }
}

fn divide(a: &Value, b: &Value, limits: Limits) -> Answer {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            if y.value() == 0.0 {
                return Err(type_error2(
                    a,
                    b,
                    "cannot be divided because the divisor is zero",
                ));
            }
            Ok(Value::number(x.value() / y.value()))
        }
        (Value::String(s), Value::String(sep)) => split(s, sep, limits),
        _ => Err(type_error2(a, b, "cannot be divided")),
    }
}

fn dtoi(n: f64) -> i64 {
    if n < i64::MIN as f64 {
        i64::MIN
    } else if -n <= i64::MIN as f64 {
        i64::MAX
    } else {
        n as i64
    }
}

fn modulo(a: &Value, b: &Value) -> Answer {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (na, nb) = (x.value(), y.value());
            if na.is_nan() || nb.is_nan() {
                return Ok(Value::number(f64::NAN));
            }
            let bi = dtoi(nb);
            if bi == 0 {
                return Err(type_error2(
                    a,
                    b,
                    "cannot be divided (remainder) because the divisor is zero",
                ));
            }
            Ok(Value::number(if bi == -1 {
                0.0
            } else {
                (dtoi(na) % bi) as f64
            }))
        }
        _ => Err(type_error2(a, b, "cannot be divided (remainder)")),
    }
}

fn split(s: &str, sep: &str, limits: Limits) -> Answer {
    if s.is_empty() {
        return Ok(Value::array(Vec::new()));
    }
    let parts: Vec<Value> = if sep.is_empty() {
        s.chars().map(|c| Value::string(c.to_string())).collect()
    } else {
        s.split(sep).map(Value::string).collect()
    };
    array_limit(parts, limits)
}

/// ldexp: `x` times two to the `e`, scaled in two halves so an
/// intermediate power of two neither overflows nor underflows when the
/// answer does not.
fn scale(x: f64, e: f64) -> f64 {
    let e = e.trunc().clamp(-2200.0, 2200.0) as i32;
    let half = e / 2;
    x * 2f64.powi(half) * 2f64.powi(e - half)
}

fn indices(s: &str, needle: &str) -> Vec<Value> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let (mut from, mut chars) = (0, 0);
    while let Some(at) = s[from..].find(needle) {
        let byte = from + at;
        chars += s[from..byte].chars().count();
        out.push(Value::number(chars as f64));
        let step = s[byte..].chars().next().map_or(1, char::len_utf8);
        from = byte + step;
        chars += 1;
    }
    out
}

fn implode(input: &Value, limits: Limits) -> Answer {
    let Value::Array(items) = input else {
        return Err(fail("implode input must be an array"));
    };
    let mut text = StringBuffer::with_capacity(items.len());
    for item in items.iter() {
        let Some(point) = item.as_f64().filter(|p| !p.is_nan()) else {
            return Err(type_error(
                item,
                "can't be imploded, unicode codepoint needs to be numeric",
            ));
        };
        let point = point as i64;
        let ch = u32::try_from(point)
            .ok()
            .and_then(char::from_u32)
            .unwrap_or('\u{FFFD}');
        text.push(ch);
    }
    text.finish(limits)
}

fn has(t: &Value, k: &Value) -> Answer {
    match (t, k) {
        (Value::Object(fields), Value::String(key)) => Ok(Value::bool(fields.get(key).is_some())),
        (Value::Array(items), Value::Number(n)) => {
            let d = n.value();
            Ok(Value::bool(
                !d.is_nan() && d >= 0.0 && (d as usize) < items.len(),
            ))
        }
        _ => Err(fail(format!(
            "Cannot check whether {} has a {} key",
            t.kind(),
            k.kind()
        ))),
    }
}

/// A level of `contains` in progress: an object's keys checked so far, or
/// an array's wanted item and the candidate it is being matched against.
enum Containment<'a> {
    Object(&'a Object, &'a Object, usize),
    Array(&'a [Value], &'a [Value], usize, usize),
}

/// jv_get_kind's equality, which tells `true` from `false`.
fn same_kind(a: &Value, b: &Value) -> bool {
    a.kind() == b.kind() && a.rank_kind() == b.rank_kind()
}

/// Start checking that `a` contains `b`: the answer for scalars, or a
/// level pushed for containers.
fn enter<'a>(a: &'a Value, b: &'a Value, stack: &mut Vec<Containment<'a>>) -> Option<bool> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            stack.push(Containment::Object(x, y, 0));
            None
        }
        (Value::Array(x), Value::Array(y)) => {
            stack.push(Containment::Array(x, y, 0, 0));
            None
        }
        (Value::String(x), Value::String(y)) => Some(x.contains(y.as_str())),
        _ => Some(a.equals(b)),
    }
}

/// jv_contains, walked with a stack, refused past jq's depth limit.
fn contains(a: &Value, b: &Value) -> Result<bool, Fault> {
    let mut stack: Vec<Containment> = Vec::new();
    let mut answer = enter(a, b, &mut stack);
    loop {
        if stack.len() > MAX_DEPTH {
            return Err(fail("Containment check too deep"));
        }
        let next = match stack.last_mut() {
            None => return Ok(answer.unwrap_or(true)),
            Some(Containment::Object(x, y, at)) => {
                if let Some(found) = answer.take() {
                    if !found {
                        stack.pop();
                        answer = Some(false);
                        continue;
                    }
                    *at += 1;
                }
                match y.entry(*at) {
                    None => None,
                    Some((k, v)) => match x.get(k) {
                        Some(u) if same_kind(u, v) => Some((u, v)),
                        _ => {
                            stack.pop();
                            answer = Some(false);
                            continue;
                        }
                    },
                }
            }
            Some(Containment::Array(x, y, i, j)) => {
                if let Some(found) = answer.take() {
                    if found {
                        *i += 1;
                        *j = 0;
                    } else {
                        *j += 1;
                    }
                }
                if *i >= y.len() {
                    None
                } else {
                    while *j < x.len() && !same_kind(&x[*j], &y[*i]) {
                        *j += 1;
                    }
                    if *j >= x.len() {
                        stack.pop();
                        answer = Some(false);
                        continue;
                    }
                    Some((&x[*j], &y[*i]))
                }
            }
        };
        match next {
            Some((u, v)) => answer = enter(u, v, &mut stack),
            None => {
                stack.pop();
                answer = Some(true);
            }
        }
    }
}

fn bsearch(input: &Value, target: &Value) -> Answer {
    let Value::Array(items) = input else {
        return Err(type_error(input, "cannot be searched from"));
    };
    let (mut start, mut end) = (0usize, items.len());
    while start < end {
        let mid = start + (end - start) / 2;
        match order(&items[mid], target)? {
            Ordering::Equal => return Ok(Value::number(mid as f64)),
            Ordering::Greater => end = mid,
            Ordering::Less => start = mid + 1,
        }
    }
    Ok(Value::number(-1.0 - start as f64))
}

struct FormatInput<'a> {
    text: Cow<'a, str>,
    _charge: Charge,
}

impl Deref for FormatInput<'_> {
    type Target = str;

    fn deref(&self) -> &str {
        &self.text
    }
}

struct StringBuffer {
    text: String,
    charge: Charge,
}

impl From<String> for StringBuffer {
    fn from(text: String) -> Self {
        let charge = Charge::open(text.capacity());
        Self { text, charge }
    }
}

impl StringBuffer {
    fn with_capacity(capacity: usize) -> Self {
        String::with_capacity(capacity).into()
    }

    fn push(&mut self, ch: char) {
        let capacity = self.text.capacity();
        self.text.push(ch);
        if self.text.capacity() != capacity {
            self.charge.set(self.text.capacity());
        }
    }

    fn push_str(&mut self, text: &str) {
        let capacity = self.text.capacity();
        self.text.push_str(text);
        if self.text.capacity() != capacity {
            self.charge.set(self.text.capacity());
        }
    }

    fn into_value(mut self) -> Value {
        self.charge.set(0);
        Value::string(self.text)
    }

    fn finish(self, limits: Limits) -> Answer {
        if self.text.len() > limits.bytes {
            return Err(string_too_long(limits));
        }
        Ok(self.into_value())
    }
}

fn escape(text: &str, table: &[(char, &str)], out: &mut StringBuffer) {
    for c in text.chars() {
        match table.iter().find(|(from, _)| *from == c) {
            Some((_, to)) => out.push_str(to),
            None => out.push(c),
        }
    }
}

fn to_text(v: &Value) -> FormatInput<'_> {
    let text = match v {
        Value::String(s) => Cow::Borrowed(s.as_str()),
        other => Cow::Owned(other.dump()),
    };
    let charge = Charge::open(match &text {
        Cow::Borrowed(_) => 0,
        Cow::Owned(text) => text.capacity(),
    });
    FormatInput {
        text,
        _charge: charge,
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn format(input: &Value, fmt: &Value, limits: Limits) -> Answer {
    let Value::String(name) = fmt else {
        return Err(type_error(fmt, "is not a valid format"));
    };
    let dispatch = name
        .split_once('\0')
        .map_or(name.as_str(), |(prefix, _)| prefix);
    let text = match dispatch {
        "json" => StringBuffer::from(input.dump()),
        "text" => match input {
            Value::String(text) => {
                if text.len() > limits.bytes {
                    return Err(string_too_long(limits));
                }
                return Ok(input.clone());
            }
            other => StringBuffer::from(other.dump()),
        },
        "csv" | "tsv" => {
            let csv = dispatch == "csv";
            let Value::Array(items) = input else {
                return Err(type_error(
                    input,
                    if csv {
                        "cannot be csv-formatted, only array"
                    } else {
                        "cannot be tsv-formatted, only array"
                    },
                ));
            };
            let mut line = StringBuffer::with_capacity(0);
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    line.push_str(if csv { "," } else { "\t" });
                }
                match x {
                    Value::Null => {}
                    Value::True => line.push_str("true"),
                    Value::False => line.push_str("false"),
                    Value::Number(n) if n.value().is_nan() => {}
                    Value::Number(_) => line.push_str(&to_text(x)),
                    Value::String(s) => {
                        if csv {
                            line.push('"');
                            escape(s, &[('"', "\"\"")], &mut line);
                            line.push('"');
                        } else {
                            escape(
                                s,
                                &[('\t', "\\t"), ('\r', "\\r"), ('\n', "\\n"), ('\\', "\\\\")],
                                &mut line,
                            );
                        }
                    }
                    _ => return Err(type_error(x, "is not valid in a csv row")),
                }
            }
            line
        }
        "html" => {
            let text = to_text(input);
            let mut out = StringBuffer::with_capacity(text.len());
            escape(
                &text,
                &[
                    ('&', "&amp;"),
                    ('<', "&lt;"),
                    ('>', "&gt;"),
                    ('\'', "&apos;"),
                    ('"', "&quot;"),
                ],
                &mut out,
            );
            out
        }
        "uri" => {
            let text = to_text(input);
            let mut out = StringBuffer::with_capacity(text.len());
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            for byte in text.bytes() {
                if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                    out.push(byte as char);
                } else {
                    out.push('%');
                    out.push(HEX[(byte >> 4) as usize] as char);
                    out.push(HEX[(byte & 0xf) as usize] as char);
                }
            }
            out
        }
        "urid" => {
            let text = to_text(input);
            let bad = || {
                type_error(
                    &Value::string(text.chars().take(30).collect::<String>()),
                    "is not a valid uri encoding",
                )
            };
            let bytes = text.as_bytes();
            let mut out = Vec::with_capacity(bytes.len());
            let mut charge = Charge::open(out.capacity());
            let mut at = 0;
            while at < bytes.len() {
                if bytes[at] != b'%' {
                    out.push(bytes[at]);
                    at += 1;
                    continue;
                }
                let digits = bytes.get(at + 1..at + 3).ok_or_else(bad)?;
                if !digits.iter().all(u8::is_ascii_hexdigit) {
                    return Err(bad());
                }
                let hex = std::str::from_utf8(digits).map_err(|_| bad())?;
                out.push(u8::from_str_radix(hex, 16).map_err(|_| bad())?);
                at += 3;
            }
            let decoded = String::from_utf8(out).map_err(|_| bad())?;
            charge.set(0);
            StringBuffer::from(decoded)
        }
        "sh" => {
            let items: &[Value] = match input {
                Value::Array(items) => items,
                other => std::slice::from_ref(other),
            };
            let mut line = StringBuffer::with_capacity(0);
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    line.push(' ');
                }
                match x {
                    Value::String(s) => {
                        line.push('\'');
                        escape(s, &[('\'', "'\\''")], &mut line);
                        line.push('\'');
                    }
                    Value::Array(_) | Value::Object(_) => {
                        return Err(type_error(x, "can not be escaped for shell"));
                    }
                    _ => line.push_str(&to_text(x)),
                }
            }
            line
        }
        "base64" => {
            let data = to_text(input);
            let bytes = data.as_bytes();
            let mut out = StringBuffer::with_capacity(bytes.len().div_ceil(3) * 4);
            for chunk in bytes.chunks(3) {
                let mut code = 0u32;
                for j in 0..3 {
                    code = (code << 8) | chunk.get(j).copied().unwrap_or(0) as u32;
                }
                for j in 0..4 {
                    if j > chunk.len() {
                        out.push('=');
                    } else {
                        out.push(BASE64[((code >> (18 - j * 6)) & 0x3f) as usize] as char);
                    }
                }
            }
            out
        }
        "base64d" => {
            let data = to_text(input);
            let mut out: Vec<u8> = Vec::new();
            let mut charge = Charge::open(0);
            let mut code = 0u32;
            let mut read = 0;
            for byte in data.bytes() {
                if byte == b'=' {
                    break;
                }
                let Some(value) = BASE64.iter().position(|c| *c == byte) else {
                    return Err(type_error(input, "is not valid base64 data"));
                };
                code = (code << 6) | value as u32;
                read += 1;
                if read == 4 {
                    let capacity = out.capacity();
                    out.extend_from_slice(&[(code >> 16) as u8, (code >> 8) as u8, code as u8]);
                    if out.capacity() != capacity {
                        charge.set(out.capacity());
                    }
                    read = 0;
                    code = 0;
                }
            }
            match read {
                3 => out.extend_from_slice(&[(code >> 10) as u8, (code >> 2) as u8]),
                2 => out.push((code >> 4) as u8),
                1 => return Err(type_error(input, "trailing base64 byte found")),
                _ => {}
            }
            charge.set(out.capacity());
            match String::from_utf8(out) {
                Ok(text) => {
                    charge.set(0);
                    StringBuffer::from(text)
                }
                Err(error) => {
                    let text =
                        StringBuffer::from(String::from_utf8_lossy(error.as_bytes()).into_owned());
                    drop(error);
                    charge.set(0);
                    text
                }
            }
        }
        _ => {
            return Err(Fault::Error(
                StringBuffer::from(format!("{name} is not a valid format")).into_value(),
            ));
        }
    };
    text.finish(limits)
}

/// jv_get: index `t` by `k`.
pub(crate) fn get(t: &Value, k: &Value) -> Result<Value, Value> {
    match (t, k) {
        (Value::Object(fields), Value::String(key)) => {
            Ok(fields.get(key).cloned().unwrap_or(Value::Null))
        }
        (Value::Array(items), Value::Number(n)) => {
            let d = n.value();
            if d.is_nan() {
                return Ok(Value::Null);
            }
            let mut idx = d.clamp(i32::MIN as f64, i32::MAX as f64) as i64;
            if idx < 0 {
                idx += items.len() as i64;
            }
            Ok(usize::try_from(idx)
                .ok()
                .and_then(|i| items.get(i).cloned())
                .unwrap_or(Value::Null))
        }
        (Value::Array(items), Value::Object(slice)) => {
            let (start, end) = parse_slice(items.len(), slice)?;
            Ok(Value::array(items[start..end].to_vec()))
        }
        (Value::String(s), Value::Object(slice)) => {
            let len = s.chars().count();
            let (start, end) = parse_slice(len, slice)?;
            Ok(
                StringBuffer::from(s.chars().skip(start).take(end - start).collect::<String>())
                    .into_value(),
            )
        }
        (Value::Array(items), Value::Array(needle)) => Ok(array_indexes(items, needle)),
        (Value::Null, Value::String(_) | Value::Number(_) | Value::Object(_)) => Ok(Value::Null),
        _ => Err(Value::string(format!(
            "Cannot index {} with {} ({})",
            t.kind(),
            k.kind(),
            k.dump_trunc()
        ))),
    }
}

fn array_indexes(items: &[Value], needle: &[Value]) -> Value {
    let mut out = Vec::new();
    if !needle.is_empty() && needle.len() <= items.len() {
        for start in 0..=items.len() - needle.len() {
            if needle
                .iter()
                .enumerate()
                .all(|(j, n)| items[start + j].equals(n))
            {
                out.push(Value::number(start as f64));
            }
        }
    }
    Value::array(out)
}

fn parse_slice(len: usize, slice: &Object) -> Result<(usize, usize), Value> {
    let start = slice.get("start").cloned().unwrap_or(Value::Null);
    let end = slice.get("end").cloned().unwrap_or(Value::Null);
    let start = match start {
        Value::Null => 0.0,
        Value::Number(n) => n.value(),
        _ => return Err(Value::string("Array/string slice indices must be integers")),
    };
    let end = match end {
        Value::Null => len as f64,
        Value::Number(n) => n.value(),
        _ => return Err(Value::string("Array/string slice indices must be integers")),
    };
    let flen = len as f64;
    let mut dstart = if start.is_nan() { 0.0 } else { start };
    if dstart < 0.0 {
        dstart += flen;
    }
    dstart = dstart.clamp(0.0, flen);
    let s = dstart as usize;
    let mut dend = if end.is_nan() { flen } else { end };
    if dend < 0.0 {
        dend += flen;
    }
    if dend < 0.0 {
        dend = s as f64;
    }
    let mut e = if dend > flen { len } else { dend as usize };
    if e < len && (e as f64) < dend {
        e += 1;
    }
    if e < s {
        e = s;
    }
    Ok((s, e))
}

fn set(t: Value, k: &Value, v: Value, limits: Limits) -> Answer {
    match (t, k) {
        (Value::Object(mut fields), Value::String(key)) => {
            Arc::make_mut(&mut fields).insert(key.clone().into(), v);
            Ok(Value::Object(fields))
        }
        (Value::Null, Value::String(key)) => {
            let mut fields = Object::default();
            fields.insert(key.clone().into(), v);
            Ok(Value::object(fields))
        }
        (t @ (Value::Array(_) | Value::Null), Value::Number(n)) => {
            let d = n.value();
            if d.is_nan() {
                return Err(fail("Cannot set array element at NaN index"));
            }
            let mut items = match t {
                Value::Array(items) => items,
                _ => Arc::new(super::value::List::default()),
            };
            let list = Arc::make_mut(&mut items);
            let mut idx = d.clamp(i32::MIN as f64, i32::MAX as f64) as i64;
            if idx < 0 {
                idx += list.len() as i64;
            }
            if idx < 0 {
                return Err(fail("Out of bounds negative array index"));
            }
            if idx as f64 > INDEX_MAX {
                return Err(fail("Array index too large"));
            }
            let idx = idx as usize;
            if idx >= limits.items {
                return Err(fail(format!(
                    "jq array limit of {} elements exceeded",
                    limits.items
                )));
            }
            list.set(idx, v);
            Ok(Value::Array(items))
        }
        (t @ (Value::Array(_) | Value::Null), Value::Object(slice)) => {
            let items: Vec<Value> = match &t {
                Value::Array(items) => items.to_vec(),
                _ => Vec::new(),
            };
            let (start, end) = parse_slice(items.len(), slice).map_err(Fault::Error)?;
            let Value::Array(insert) = v else {
                return Err(fail(
                    "A slice of an array can only be assigned another array",
                ));
            };
            let mut out = items;
            out.splice(start..end, insert.iter().cloned());
            array_limit(out, limits)
        }
        (Value::String(_), Value::Object(_)) => Err(fail("Cannot update string slices")),
        (t, k) => Err(fail(format!(
            "Cannot update field at {} index of {}",
            k.kind(),
            t.kind()
        ))),
    }
}

pub(crate) fn getpath(root: &Value, path: &Value) -> Answer {
    let Value::Array(keys) = path else {
        return Err(fail("Path must be specified as an array"));
    };
    if keys.len() > PATH_DEPTH {
        return Err(fail("Path too deep"));
    }
    let mut curr = root.clone();
    for key in keys.iter() {
        curr = get(&curr, key).map_err(Fault::Error)?;
    }
    Ok(curr)
}

/// jv_setpath, walked with a stack of the values it descends through.
fn setpath(root: Value, path: &Value, value: Value, limits: Limits) -> Answer {
    let Value::Array(keys) = path else {
        return Err(fail("Path must be specified as an array"));
    };
    if keys.len() > PATH_DEPTH {
        return Err(fail("Path too deep"));
    }
    let mut parents: Vec<Value> = Vec::with_capacity(keys.len());
    let mut curr = root;
    for key in keys.iter() {
        let child = get(&curr, key).map_err(Fault::Error)?;
        if !matches!(key, Value::Object(_)) {
            curr = set(curr, key, Value::Null, limits)?;
        }
        parents.push(curr);
        curr = child;
    }
    let mut built = value;
    for (key, parent) in keys.iter().zip(parents).rev() {
        built = set(parent, key, built, limits)?;
    }
    drop(curr);
    Ok(built)
}

fn dels(t: Value, keys: Vec<Value>) -> Answer {
    if keys.is_empty() || matches!(t, Value::Null) {
        return Ok(t);
    }
    match t {
        Value::Array(items) => {
            let len = items.len();
            let mut drop_at = vec![false; len];
            for key in &keys {
                match key {
                    Value::Number(n) => {
                        let d = n.value();
                        if d.is_nan() {
                            continue;
                        }
                        let idx = if d < 0.0 {
                            len as i64 + d as i64
                        } else {
                            d as i64
                        };
                        if idx >= 0 && (idx as usize) < len {
                            drop_at[idx as usize] = true;
                        }
                    }
                    Value::Object(slice) => {
                        let (s, e) = parse_slice(len, slice).map_err(Fault::Error)?;
                        for flag in &mut drop_at[s..e] {
                            *flag = true;
                        }
                    }
                    other => {
                        return Err(fail(format!(
                            "Cannot delete {} element of array",
                            other.kind()
                        )));
                    }
                }
            }
            Ok(Value::array(
                items
                    .iter()
                    .zip(drop_at)
                    .filter(|(_, d)| !d)
                    .map(|(v, _)| v.clone())
                    .collect(),
            ))
        }
        Value::Object(mut fields) => {
            for key in &keys {
                let Value::String(k) = key else {
                    return Err(fail(format!(
                        "Cannot delete {} field of object",
                        key.kind()
                    )));
                };
                Arc::make_mut(&mut fields).remove(k);
            }
            Ok(Value::Object(fields))
        }
        other => Err(fail(format!("Cannot delete fields from {}", other.kind()))),
    }
}

/// jq's delpaths_sorted, walked with a stack of the values it is
/// rebuilding. Each level covers the run of sorted paths that share its
/// prefix, so no path is copied on the way down.
fn delpaths_sorted(object: Value, paths: &[Vec<Value>], limits: Limits) -> Answer {
    struct Level {
        object: Value,
        end: usize,
        at: usize,
        delkeys: Vec<Value>,
        key: Value,
    }
    let mut stack = vec![Level {
        object,
        end: paths.len(),
        at: 0,
        delkeys: Vec::new(),
        key: Value::Null,
    }];
    loop {
        let start = stack.len() - 1;
        let Some(level) = stack.last_mut() else {
            unreachable!("the walk holds its root")
        };
        if level.at == level.end {
            let Some(done) = stack.pop() else {
                unreachable!("the walk holds its root")
            };
            let object = dels(done.object, done.delkeys)?;
            let Some(parent) = stack.last_mut() else {
                return Ok(object);
            };
            let key = std::mem::replace(&mut parent.key, Value::Null);
            let held = std::mem::replace(&mut parent.object, Value::Null);
            parent.object = set(held, &key, object, limits)?;
            continue;
        }
        let i = level.at;
        let key = paths[i][start].clone();
        let mut j = i + 1;
        while j < level.end && paths[j][start].equals(&key) {
            j += 1;
        }
        level.at = j;
        if paths[i].len() == start + 1 {
            level.delkeys.push(key);
            continue;
        }
        let sub = get(&level.object, &key).map_err(Fault::Error)?;
        if matches!(sub, Value::Null) {
            continue;
        }
        if start + 1 > PATH_DEPTH {
            return Err(fail("Path too deep"));
        }
        level.key = key;
        stack.push(Level {
            object: sub,
            end: j,
            at: i,
            delkeys: Vec::new(),
            key: Value::Null,
        });
    }
}

fn delpaths(object: Value, paths: &Value, limits: Limits) -> Answer {
    if !matches!(paths, Value::Array(_)) {
        return Err(fail("Paths must be specified as an array"));
    }
    let sorted = sorting(Cfunc::Sort, std::slice::from_ref(paths))?.finish()?;
    let Value::Array(sorted) = &sorted else {
        unreachable!("a sort answers an array")
    };
    let mut keys: Vec<Vec<Value>> = Vec::with_capacity(sorted.len());
    for path in sorted.iter() {
        let Value::Array(items) = path else {
            return Err(fail(format!(
                "Path must be specified as array, not {}",
                path.kind()
            )));
        };
        if items.len() > PATH_DEPTH {
            return Err(fail("Path too deep"));
        }
        keys.push(items.to_vec());
    }
    if keys.is_empty() {
        return Ok(object);
    }
    if keys[0].is_empty() {
        return Ok(Value::Null);
    }
    delpaths_sorted(object, &keys, limits)
}

#[cfg(test)]
mod tests {
    use super::super::meter::{self, Meter};
    use super::*;

    const LIMITS: Limits = Limits {
        blocks: 1 << 20,
        items: 1 << 24,
        bytes: 1 << 28,
        memory: 1 << 30,
    };

    #[test]
    fn runtime_strings_charge_capacity_before_value_transfer_or_rejection() {
        for bytes in [0, 1000] {
            let meter = Arc::new(Meter::limited(150));
            let _installed = meter::install(&meter);
            let mut text = String::with_capacity(200);
            text.push('x');
            let answer = string_limit(text, Limits { bytes, ..LIMITS });
            assert_eq!(answer.is_ok(), bytes > 0);
            assert!(meter.exceeded());
            drop(answer);
            assert_eq!(meter.live(), 0);
        }
        let a = Value::string("x".repeat(100));
        let b = Value::string("y".repeat(100));
        let meter = Arc::new(Meter::limited(150));
        let _installed = meter::install(&meter);
        let answer = plus(&a, &b, Limits { bytes: 1, ..LIMITS });
        assert!(answer.is_err());
        assert!(meter.exceeded());
        drop(answer);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn runtime_string_transfers_do_not_charge_the_same_buffer_twice() {
        let meter = Arc::new(Meter::limited(150));
        let _installed = meter::install(&meter);
        let answer = string_limit("x".repeat(100), LIMITS).unwrap_or_else(|_| unreachable!());
        assert!(!meter.exceeded());
        drop(answer);
        assert_eq!(meter.live(), 0);
        drop(_installed);
        let meter = Arc::new(Meter::limited(50));
        let _installed = meter::install(&meter);
        let answer = array_limit(vec![Value::Null], LIMITS).unwrap_or_else(|_| unreachable!());
        assert!(!meter.exceeded());
        drop(answer);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn discarded_string_and_array_capacities_still_latch_the_peak() {
        let meter = Arc::new(Meter::limited(150));
        let _installed = meter::install(&meter);
        let mut text = String::with_capacity(200);
        text.push('x');
        let error = fail(text);
        assert!(meter.exceeded());
        drop(error);
        assert_eq!(meter.live(), 0);
        meter.reset();
        let mut items = Vec::with_capacity(100);
        items.push(Value::Null);
        let error = array_limit(items, Limits { items: 0, ..LIMITS });
        assert!(error.is_err());
        assert!(meter.exceeded());
        drop(error);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn string_slice_capacity_is_observed_before_it_shrinks() {
        let text = Value::string("€".repeat(32768) + &"a".repeat(32768));
        let mut fields = Object::default();
        fields.insert("start".into(), Value::number(0.0));
        fields.insert("end".into(), Value::number(32768.0));
        let slice = Value::object(fields);
        let meter = Arc::new(Meter::limited(110000));
        let _installed = meter::install(&meter);
        let answer = get(&text, &slice).unwrap_or_else(|_| unreachable!());
        assert!(meter.exceeded());
        drop(answer);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn sorted_key_scratch_stays_charged_until_the_result_is_owned() {
        let mut fields = Object::default();
        for index in 0..1000 {
            fields.insert(index.to_string().into(), Value::Null);
        }
        let input = Value::object(fields);
        let output_bytes = {
            let meter = Arc::new(Meter::default());
            let _installed = meter::install(&meter);
            let answer = call(Cfunc::Keys, std::slice::from_ref(&input), LIMITS)
                .unwrap_or_else(|_| unreachable!());
            let bytes = meter.live();
            drop(answer);
            assert_eq!(meter.live(), 0);
            bytes
        };
        for function in [Cfunc::KeysUnsorted, Cfunc::Keys] {
            let meter = Arc::new(Meter::limited(output_bytes + 4000));
            let _installed = meter::install(&meter);
            let answer = call(function, std::slice::from_ref(&input), LIMITS)
                .unwrap_or_else(|_| unreachable!());
            assert_eq!(meter.exceeded(), function == Cfunc::Keys);
            drop(answer);
            assert_eq!(meter.live(), 0);
        }
    }

    #[test]
    fn sort_buffers_are_lazy_charged_and_released() {
        let meter = Arc::new(Meter::default());
        let _installed = meter::install(&meter);
        let input = Value::array(
            (0..10000)
                .rev()
                .map(|i| Value::number(f64::from(i)))
                .collect(),
        );
        let before = meter.live();
        let mut task =
            sorting(Cfunc::Sort, std::slice::from_ref(&input)).unwrap_or_else(|_| unreachable!());
        assert_eq!(meter.live(), before);
        assert!(task.run(&mut 1).is_none());
        assert_eq!(task.order.len(), 1);
        assert_eq!(task.merged.len(), 1);
        assert!(meter.live() > before);
        drop(task);
        assert_eq!(meter.live(), before);
        drop(input);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn sort_buffer_transfers_do_not_latch_a_false_memory_error() {
        let meter = Arc::new(Meter::limited(75000));
        let _installed = meter::install(&meter);
        let input = Value::array(
            (0..1000)
                .rev()
                .map(|i| Value::number(f64::from(i)))
                .collect(),
        );
        let mut task =
            sorting(Cfunc::Sort, std::slice::from_ref(&input)).unwrap_or_else(|_| unreachable!());
        let output = loop {
            if let Some(answer) = task.run(&mut 128) {
                break answer.unwrap_or_else(|_| unreachable!());
            }
        };
        assert!(!meter.exceeded());
        assert!(matches!(output,Value::Array(items) if items.len()==1000));
        drop(task);
        drop(input);
        assert_eq!(meter.live(), 0);
    }

    #[test]
    fn subtraction_yields_inside_one_right_operand_scan() {
        let from = Value::array(vec![Value::number(-1.0)]);
        let without = Value::array((0..100000).map(|i| Value::number(f64::from(i))).collect());
        let mut task = Subtracting::begin(&[Value::Null, from, without]).unwrap();
        assert!(task.run(&mut 1).is_none());
        assert_eq!(task.at, 0);
        assert!(task.against <= 1);
        assert!(task.kept.is_empty());
        assert!(task.run(&mut 1).is_none());
        assert_eq!(task.at, 0);
        assert!(task.against <= 1);
    }
}
