// Adapted from jq 1.8.2 (MIT), src/builtin.c, src/jv.c and src/jv_aux.c. See licenses/third_party/jq.txt.

use std::cmp::Ordering;
use std::sync::Arc;

use super::parse::parse_value;
use super::value::{List, MAX_DEPTH, Number, Object, TooDeep, Value, try_compare};
use super::vm::Limits;

const PATH_DEPTH: usize = 10000;
const INDEX_MAX: f64 = (i32::MAX >> 2) as f64;

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

/// Sort stably by `key`, failing when a comparison went too deep. A
/// merge sort of our own: jq's number order is not total (a literal and
/// a computed number compare by different rules, Number::cmp_exact), and
/// the standard library's sort may panic on such an order.
fn sort_by_key<T>(items: &mut Vec<T>, key: impl Fn(&T) -> &Value) -> Result<(), Fault> {
    let n = items.len();
    let mut deep = false;
    let mut order: Vec<usize> = (0..n).collect();
    let mut merged = vec![0; n];
    let mut width = 1;
    while width < n {
        let mut start = 0;
        while start < n {
            let mid = (start + width).min(n);
            let end = (start + 2 * width).min(n);
            let (mut i, mut j) = (start, mid);
            for slot in &mut merged[start..end] {
                let left = i < mid
                    && (j >= end
                        || try_compare(key(&items[order[i]]), key(&items[order[j]]))
                            .unwrap_or_else(|_| {
                                deep = true;
                                Ordering::Equal
                            })
                            != Ordering::Greater);
                if left {
                    *slot = order[i];
                    i += 1;
                } else {
                    *slot = order[j];
                    j += 1;
                }
            }
            start = end;
        }
        std::mem::swap(&mut order, &mut merged);
        width *= 2;
    }
    if deep {
        return Err(fail("Comparison too deep"));
    }
    let mut slots: Vec<Option<T>> = items.drain(..).map(Some).collect();
    items.extend(order.into_iter().filter_map(|at| slots[at].take()));
    Ok(())
}

fn fail(message: impl Into<String>) -> Fault {
    Fault::Error(Value::string(message.into()))
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

fn string_limit(text: String, limits: Limits) -> Answer {
    if text.len() > limits.bytes {
        return Err(fail(format!(
            "jq string limit of {} bytes exceeded",
            limits.bytes
        )));
    }
    Ok(Value::string(text))
}

pub(super) fn array_limit(items: Vec<Value>, limits: Limits) -> Answer {
    if items.len() > limits.items {
        return Err(fail(format!(
            "jq array limit of {} elements exceeded",
            limits.items
        )));
    }
    Ok(Value::array(items))
}

pub(crate) fn call(f: Cfunc, args: Vec<Value>, limits: Limits) -> Answer {
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
                let keys: Vec<Value> = if f == Cfunc::Keys {
                    fields
                        .sorted_keys()
                        .into_iter()
                        .map(|k| Value::String(Arc::clone(k)))
                        .collect()
                } else {
                    fields
                        .iter()
                        .map(|(k, _)| Value::String(Arc::clone(k)))
                        .collect()
                };
                Ok(Value::array(keys))
            }
            Value::Array(items) => Ok(Value::array(
                (0..items.len()).map(|i| Value::number(i as f64)).collect(),
            )),
            _ => Err(type_error(input, "has no keys")),
        },
        Cfunc::StartsWith => match (input, a) {
            (Value::String(s), Value::String(p)) => Ok(Value::bool(s.starts_with(&**p))),
            _ => Err(fail("startswith() requires string inputs")),
        },
        Cfunc::EndsWith => match (input, a) {
            (Value::String(s), Value::String(p)) => Ok(Value::bool(s.ends_with(&**p))),
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
        Cfunc::Sort => match input {
            Value::Array(items) => {
                let mut sorted: Vec<Value> = items.to_vec();
                sort_by_key(&mut sorted, |v| v)?;
                Ok(Value::array(sorted))
            }
            _ => Err(type_error(input, "cannot be sorted, as it is not an array")),
        },
        Cfunc::SortByImpl => {
            let pairs = keyed(input, a, "cannot be sorted, as they are not both arrays")?;
            Ok(Value::array(pairs.into_iter().map(|(_, v)| v).collect()))
        }
        Cfunc::GroupByImpl => {
            let pairs = keyed(input, a, "cannot be sorted, as they are not both arrays")?;
            let mut groups: Vec<Value> = Vec::new();
            let mut group: Vec<Value> = Vec::new();
            let mut last: Option<Value> = None;
            for (key, value) in pairs {
                if let Some(prev) = &last {
                    if order(prev, &key)? != Ordering::Equal {
                        groups.push(Value::array(std::mem::take(&mut group)));
                    }
                }
                group.push(value);
                last = Some(key);
            }
            if !group.is_empty() {
                groups.push(Value::array(group));
            }
            Ok(Value::array(groups))
        }
        Cfunc::Unique => match input {
            Value::Array(_) => unique(input, input),
            _ => Err(type_error(input, "cannot be sorted, as it is not an array")),
        },
        Cfunc::UniqueByImpl => unique(input, a),
        Cfunc::Bsearch => bsearch(input, a),
        Cfunc::Min => minmax(input, input, true),
        Cfunc::Max => minmax(input, input, false),
        Cfunc::MinByImpl => minmax(input, a, true),
        Cfunc::MaxByImpl => minmax(input, a, false),
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
        Cfunc::Now
        | Cfunc::Mktime
        | Cfunc::Gmtime
        | Cfunc::Localtime
        | Cfunc::Strftime
        | Cfunc::StrfLocaltime
        | Cfunc::Strptime => unreachable!("the VM runs the time builtins with its clock"),
        Cfunc::MatchImpl => {
            let mut budget = u64::MAX;
            super::regex::Matching::begin(&args)?
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
                merged.insert(Arc::clone(k), v.clone());
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
    kept: Vec<Value>,
}

impl Subtracting {
    /// The scan `_minus`'s operands ask for, when both are arrays.
    pub(crate) fn begin(args: &[Value]) -> Option<Subtracting> {
        match (args.get(1), args.get(2)) {
            (Some(Value::Array(from)), Some(Value::Array(without))) => Some(Subtracting {
                from: Arc::clone(from),
                without: Arc::clone(without),
                at: 0,
                kept: Vec::new(),
            }),
            _ => None,
        }
    }

    /// Scans on, spending `budget`: None when it ran out before the end.
    pub(crate) fn run(&mut self, budget: &mut u64) -> Option<Result<Value, Fault>> {
        let cost = (self.without.len() as u64 / 16).max(1);
        if *budget == 0 {
            *budget = 1;
        }
        while self.at < self.from.len() {
            if *budget == 0 {
                return None;
            }
            *budget = budget.saturating_sub(cost);
            let item = &self.from[self.at];
            if !self.without.iter().any(|other| item.equals(other)) {
                self.kept.push(item.clone());
            }
            self.at += 1;
        }
        Some(Ok(Value::array(std::mem::take(&mut self.kept))))
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
            Ok(Value::string(s.repeat(times)))
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
        key: Option<Arc<str>>,
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
        if let Some((k, v)) = top
            .from
            .entry(top.at)
            .map(|(k, v)| (Arc::clone(k), v.clone()))
        {
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
    let mut text = String::with_capacity(items.len());
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
    string_limit(text, limits)
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
        (Value::String(x), Value::String(y)) => Some(x.contains(&**y)),
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

fn keyed(values: &Value, keys: &Value, message: &str) -> Result<Vec<(Value, Value)>, Fault> {
    match (values, keys) {
        (Value::Array(v), Value::Array(k)) if v.len() == k.len() => {
            let mut pairs: Vec<(Value, Value)> = k.iter().cloned().zip(v.iter().cloned()).collect();
            sort_by_key(&mut pairs, |p| &p.0)?;
            Ok(pairs)
        }
        _ => Err(type_error2(values, keys, message)),
    }
}

fn unique(values: &Value, keys: &Value) -> Answer {
    let pairs = keyed(
        values,
        keys,
        "cannot be sorted, as they are not both arrays",
    )?;
    let mut out: Vec<Value> = Vec::new();
    let mut last: Option<Value> = None;
    for (key, value) in pairs {
        if let Some(prev) = &last {
            if order(prev, &key)? == Ordering::Equal {
                continue;
            }
        }
        out.push(value);
        last = Some(key);
    }
    Ok(Value::array(out))
}

fn minmax(values: &Value, keys: &Value, is_min: bool) -> Answer {
    let (Value::Array(v), Value::Array(k)) = (values, keys) else {
        return Err(type_error2(values, keys, "cannot be iterated over"));
    };
    if v.len() != k.len() {
        return Err(type_error2(values, keys, "have wrong length"));
    }
    if v.is_empty() {
        return Ok(Value::Null);
    }
    let mut best = 0;
    for i in 1..v.len() {
        let less = order(&k[i], &k[best])? == Ordering::Less;
        if less == is_min {
            best = i;
        }
    }
    Ok(v[best].clone())
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

fn escape(text: &str, table: &[(char, &str)]) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match table.iter().find(|(from, _)| *from == c) {
            Some((_, to)) => out.push_str(to),
            None => out.push(c),
        }
    }
    out
}

fn to_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.to_string(),
        other => other.dump(),
    }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn format(input: &Value, fmt: &Value, limits: Limits) -> Answer {
    let Value::String(name) = fmt else {
        return Err(type_error(fmt, "is not a valid format"));
    };
    let text = match &**name {
        "json" => input.dump(),
        "text" => to_text(input),
        "csv" | "tsv" => {
            let csv = &**name == "csv";
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
            let mut line = String::new();
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    line.push_str(if csv { "," } else { "\t" });
                }
                match x {
                    Value::Null => {}
                    Value::True | Value::False => line.push_str(&x.dump()),
                    Value::Number(n) if n.value().is_nan() => {}
                    Value::Number(_) => line.push_str(&x.dump()),
                    Value::String(s) => {
                        if csv {
                            line.push('"');
                            line.push_str(&escape(s, &[('"', "\"\"")]));
                            line.push('"');
                        } else {
                            line.push_str(&escape(
                                s,
                                &[('\t', "\\t"), ('\r', "\\r"), ('\n', "\\n"), ('\\', "\\\\")],
                            ));
                        }
                    }
                    _ => return Err(type_error(x, "is not valid in a csv row")),
                }
            }
            line
        }
        "html" => escape(
            &to_text(input),
            &[
                ('&', "&amp;"),
                ('<', "&lt;"),
                ('>', "&gt;"),
                ('\'', "&apos;"),
                ('"', "&quot;"),
            ],
        ),
        "uri" => {
            let mut out = String::new();
            for byte in to_text(input).bytes() {
                if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                    out.push(byte as char);
                } else {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
            out
        }
        "sh" => {
            let items: Vec<Value> = match input {
                Value::Array(items) => items.to_vec(),
                other => vec![other.clone()],
            };
            let mut line = String::new();
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    line.push(' ');
                }
                match x {
                    Value::String(s) => {
                        line.push('\'');
                        line.push_str(&escape(s, &[('\'', "'\\''")]));
                        line.push('\'');
                    }
                    Value::Array(_) | Value::Object(_) => {
                        return Err(type_error(x, "can not be escaped for shell"));
                    }
                    _ => line.push_str(&x.dump()),
                }
            }
            line
        }
        "base64" => {
            let data = to_text(input);
            let bytes = data.as_bytes();
            let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
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
                    out.extend_from_slice(&[(code >> 16) as u8, (code >> 8) as u8, code as u8]);
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
            String::from_utf8_lossy(&out).into_owned()
        }
        other => return Err(fail(format!("{other} is not a valid format"))),
    };
    string_limit(text, limits)
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
            Ok(Value::string(
                s.chars().skip(start).take(end - start).collect::<String>(),
            ))
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
            Arc::make_mut(&mut fields).insert(Arc::clone(key), v);
            Ok(Value::Object(fields))
        }
        (Value::Null, Value::String(key)) => {
            let mut fields = Object::default();
            fields.insert(Arc::clone(key), v);
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
            if idx >= list.len() {
                list.resize(idx + 1, Value::Null);
            }
            list[idx] = v;
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
    let Value::Array(list) = paths else {
        return Err(fail("Paths must be specified as an array"));
    };
    let mut sorted: Vec<Value> = list.to_vec();
    sort_by_key(&mut sorted, |v| v)?;
    let mut keys: Vec<Vec<Value>> = Vec::with_capacity(sorted.len());
    for path in &sorted {
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
