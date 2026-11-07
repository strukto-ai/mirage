//! The lines `declare -p` and a bare `set` print for a variable.

use super::quote;
use crate::vars::{BASHPID, INTEGER, LINENO, Store, UNASSIGNED, Value, Var};

/// The bytes a bare `set` single-quotes a value for.
const SET_QUOTED: &[u8] = b" \t\n'\"\\|&;()<>!{}*[?]^$`";

/// An array's `=(...)`: each element as `[index]="value"`, an associative
/// array's in sorted-key order (bash prints its hash order) with a space
/// before the `)` that an empty one does not carry. A scalar is `="value"`.
pub fn body(value: &Value) -> Vec<u8> {
    let parts: Vec<Vec<u8>> = match value {
        Value::Scalar(text) => return [b"=".to_vec(), quote::declare(text)].concat(),
        Value::Indexed(array) => array
            .iter()
            .map(|(index, value)| {
                [format!("[{index}]=").into_bytes(), quote::declare(value)].concat()
            })
            .collect(),
        Value::Assoc(map) => map
            .sorted()
            .into_iter()
            .map(|(key, value)| {
                [
                    b"[".to_vec(),
                    quote::key(key),
                    b"]=".to_vec(),
                    quote::declare(value),
                ]
                .concat()
            })
            .collect(),
    };
    let mut out = b"=(".to_vec();
    out.extend(parts.join(&b' '));
    if matches!(value, Value::Assoc(_)) && !parts.is_empty() {
        out.push(b' ');
    }
    out.push(b')');
    out
}

/// The line `declare -p` prints for a name, references not followed: its
/// attribute cluster (`--` for none), the name, then the value; one
/// declared and never assigned (`local x`, `declare -a y`) has none. A name
/// the shell computes prints what a read of it holds now (`computed`).
/// None for a name unset or hidden.
pub fn declaration(vars: &Store, name: &str) -> Option<Vec<u8>> {
    if vars.hidden(name) {
        return None;
    }
    if let Some(var) = computed(vars, name) {
        return Some(line(name, &var));
    }
    vars.record(name).map(|var| line(name, var))
}

/// `declare -p`'s line for `name` holding `var`.
pub fn line(name: &str, var: &Var) -> Vec<u8> {
    let cluster = var.cluster();
    let mut out = format!(
        "declare -{} {name}",
        if cluster.is_empty() { "-" } else { &cluster }
    )
    .into_bytes();
    if let Some(value) = var.value.as_ref().filter(|_| !var.has(UNASSIGNED)) {
        out.extend(body(value));
    }
    out
}

/// A name the shell computes, as a read of it holds it now, over the
/// attributes its own record adds: `PIPESTATUS` once a command has run
/// and `FUNCNAME` as arrays, `FUNCNAME` declared and never assigned outside
/// a function, and `LINENO` and `BASHPID` as scalars, `BASHPID` an integer.
/// None for any other name, or one no longer computed.
pub fn computed(vars: &Store, name: &str) -> Option<Var> {
    let (value, base) = match name {
        "PIPESTATUS" | "FUNCNAME" => {
            let array = vars.special(name)?;
            if array.is_empty() && name == "PIPESTATUS" {
                return None;
            }
            let base = if array.is_empty() { UNASSIGNED } else { 0 };
            (Value::Indexed(array), base)
        }
        LINENO => (Value::Scalar(vars.dynamic(name)?), 0),
        BASHPID => (Value::Scalar(vars.dynamic(name)?), INTEGER),
        _ => return None,
    };
    Some(Var {
        value: Some(value),
        attrs: vars.record(name).map_or(0, |var| var.attrs) | base,
        managed: None,
    })
}

/// The variable lines a bare `set` prints, sorted by name: `name=value`
/// for each name whose record, references followed, holds a value it was
/// assigned and is not hidden, a scalar quoted only where the shell would
/// read it specially (`x='a b'`, `y=a,b`, `IFS=$' \t\n'`). The names in
/// `skip` are a running command's temporaries, which no listing shows.
pub fn assignments(vars: &Store, skip: &[String]) -> Vec<Vec<u8>> {
    let mut names: Vec<&str> = vars
        .records()
        .map(|(name, _)| name)
        .filter(|name| !skip.iter().any(|skipped| skipped == name))
        .collect();
    names.sort_unstable();
    names
        .into_iter()
        .filter_map(|name| {
            let var = vars.visible(name).filter(|var| !var.has(UNASSIGNED))?;
            let mut line = name.as_bytes().to_vec();
            match var.value.as_ref()? {
                Value::Scalar(text) => {
                    line.push(b'=');
                    line.extend(set_quoted(text));
                }
                value => line.extend(body(value)),
            }
            Some(line)
        })
        .collect()
}

/// A scalar as a bare `set` prints it: `$'...'` with a control byte, single
/// quotes with a byte the shell reads specially or a `~` it would expand
/// or a leading `#`, else as it is.
fn set_quoted(text: &[u8]) -> Vec<u8> {
    if text.iter().any(|&b| b < 0x20 || b == 0x7F) {
        return quote::declare(text);
    }
    let tilde = text
        .iter()
        .enumerate()
        .any(|(i, &b)| b == b'~' && (i == 0 || matches!(text[i - 1], b'=' | b':')));
    if !tilde && text.first() != Some(&b'#') && !text.iter().any(|b| SET_QUOTED.contains(b)) {
        return text.to_vec();
    }
    let mut out = vec![b'\''];
    for &byte in text {
        if byte == b'\'' {
            out.extend_from_slice(b"'\\''");
        } else {
            out.push(byte);
        }
    }
    out.push(b'\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vars::{Assoc, Indexed, READONLY, Var};
    use std::sync::Arc;

    #[test]
    fn lines_as_bash_prints_them() {
        let mut vars = Store::new(Arc::new(|| 7));
        vars.seed("s", Value::Scalar(b"a b".to_vec()));
        vars.seed(
            "a",
            Value::Indexed(Indexed::dense([b"x".to_vec(), b"$y".to_vec()])),
        );
        let mut map = Assoc::default();
        map.set(b"k".to_vec(), b"v".to_vec());
        map.set(b"a b".to_vec(), b"w".to_vec());
        vars.seed("m", Value::Assoc(Box::new(map)));
        vars.seed("e", Value::Assoc(Box::default()));
        vars.place(
            "y",
            Some(Arc::new(Var {
                value: Some(Value::Indexed(Indexed::default())),
                attrs: UNASSIGNED | READONLY,
                managed: None,
            })),
        );
        vars.set_attr("u", None, true);
        let line = |name| String::from_utf8(declaration(&vars, name).unwrap()).unwrap();
        assert_eq!(line("s"), "declare -- s=\"a b\"");
        assert_eq!(line("a"), "declare -a a=([0]=\"x\" [1]=\"\\$y\")");
        assert_eq!(line("m"), "declare -A m=([\"a b\"]=\"w\" [k]=\"v\" )");
        assert_eq!(line("e"), "declare -A e=()");
        assert_eq!(line("y"), "declare -ar y");
        assert_eq!(line("u"), "declare -- u");
        assert!(declaration(&vars, "nope").is_none());
        let set: Vec<String> = assignments(&vars, &["e".to_owned()])
            .into_iter()
            .map(|line| String::from_utf8(line).unwrap())
            .collect();
        assert_eq!(
            set,
            [
                "a=([0]=\"x\" [1]=\"\\$y\")",
                "m=([\"a b\"]=\"w\" [k]=\"v\" )",
                "s='a b'"
            ]
        );
        assert_eq!(set_quoted(b"a,b"), b"a,b");
        assert_eq!(set_quoted(b"x:~/y"), b"'x:~/y'");
        assert_eq!(set_quoted(b"it's"), b"'it'\\''s'");
        assert_eq!(set_quoted(b"\t"), b"$'\\t'");
    }
}
