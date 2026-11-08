//! The lines `declare -p` and a bare `set` print for a variable.

use super::quote;
use crate::vars::{BASH_LINENO, BASHPID, INTEGER, LINENO, RANDOM, Store, UNASSIGNED, Value, Var};

/// The bytes a bare `set` single-quotes a value for.
const SET_QUOTED: &[u8] = b" \t\n'\"\\|&;()<>!{}*[?]^$`";

/// The names the shell computes, which a listing shows with no record.
const COMPUTED: [&str; 6] = [
    BASHPID,
    BASH_LINENO,
    "FUNCNAME",
    LINENO,
    "PIPESTATUS",
    RANDOM,
];

/// The attribute letters a bare `declare` listing narrows to.
const LISTED: &str = "ilnrtux";

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
/// the shell computes prints what a read of it holds now (`computed`), and
/// `RANDOM` draws, as a read would; a seed that does not evaluate leaves
/// it as it is. None for a name unset or hidden.
pub fn declaration(vars: &mut Store, name: &str) -> Option<Vec<u8>> {
    if vars.hidden(name) {
        return None;
    }
    if name == RANDOM {
        vars.next_random().ok();
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
/// attributes its own record adds: `PIPESTATUS` once a command has run,
/// `FUNCNAME` and `BASH_LINENO` as arrays, `FUNCNAME` declared and never
/// assigned outside a function, `LINENO` and `BASHPID` as scalars, and
/// `BASHPID` and `RANDOM` integers, `RANDOM` holding its last draw. None
/// for any other name, or one no longer computed.
pub fn computed(vars: &Store, name: &str) -> Option<Var> {
    let (value, base) = match name {
        RANDOM => {
            let held = vars.record(name).and_then(|var| var.value.clone());
            return vars.computed().any(|name| name == RANDOM).then(|| Var {
                value: held,
                attrs: vars.record(name).map_or(0, |var| var.attrs) | INTEGER,
                managed: None,
            });
        }
        BASH_LINENO => (Value::Indexed(vars.special(name)?), 0),
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

/// The lines a bare `declare -p` prints, sorted by name: each record,
/// references not followed, and each name the shell computes as a read of
/// it holds it now (`computed`), but for `LINENO` and `BASHPID`, which hold
/// no value until read. `letters` narrow it: `a` / `A` to that array kind
/// (both to nothing), any of `ilnrtux` to a name carrying one. Hidden names
/// and those in `skip`, a running command's temporaries, are left out.
pub fn listing(vars: &Store, letters: &str, skip: &[String]) -> Vec<Vec<u8>> {
    let wanted: Vec<char> = letters.chars().filter(|&c| LISTED.contains(c)).collect();
    named(vars, skip)
        .into_iter()
        .filter(|name| !vars.hidden(name))
        .filter_map(|name| {
            let var = match computed(vars, name) {
                Some(mut var) => {
                    if matches!(name, LINENO | BASHPID) {
                        var.attrs |= UNASSIGNED;
                    }
                    var
                }
                None => vars.record(name)?.clone(),
            };
            let cluster = var.cluster();
            let kind = |c| !letters.contains(c) || cluster.contains(c);
            let marked = wanted.is_empty() || wanted.iter().any(|&c| cluster.contains(c));
            (kind('a') && kind('A') && marked).then(|| line(name, &var))
        })
        .collect()
}

/// Every record's name and each the shell computes, sorted, those in
/// `skip` left out.
fn named<'a>(vars: &'a Store, skip: &[String]) -> Vec<&'a str> {
    let mut names: Vec<&str> = vars
        .records()
        .map(|(name, _)| name)
        .chain(COMPUTED)
        .filter(|name| !skip.iter().any(|skipped| skipped == name))
        .collect();
    names.sort_unstable();
    names.dedup();
    names
}

/// The variable lines a bare `set` prints, sorted by name: `name=value`
/// for each name whose record, references followed, holds a value it was
/// assigned and is not hidden, and each array the shell computes that
/// holds one now (`computed`), a scalar quoted only where the shell would
/// read it specially (`x='a b'`, `y=a,b`, `IFS=$' \t\n'`). The names in
/// `skip` are a running command's temporaries, which no listing shows.
pub fn assignments(vars: &Store, skip: &[String]) -> Vec<Vec<u8>> {
    named(vars, skip)
        .into_iter()
        .filter_map(|name| {
            let array =
                computed(vars, name).filter(|var| matches!(var.value, Some(Value::Indexed(_))));
            let var = match &array {
                Some(var) => var,
                None => vars.visible(name)?,
            };
            if var.has(UNASSIGNED) {
                return None;
            }
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
        let mut line = |name| String::from_utf8(declaration(&mut vars, name).unwrap()).unwrap();
        assert_eq!(line("s"), "declare -- s=\"a b\"");
        assert_eq!(line("a"), "declare -a a=([0]=\"x\" [1]=\"\\$y\")");
        assert_eq!(line("m"), "declare -A m=([\"a b\"]=\"w\" [k]=\"v\" )");
        assert_eq!(line("e"), "declare -A e=()");
        assert_eq!(line("y"), "declare -ar y");
        assert_eq!(line("u"), "declare -- u");
        assert_eq!(line("BASH_LINENO"), "declare -a BASH_LINENO=()");
        assert!(declaration(&mut vars, "nope").is_none());
        let set: Vec<String> = assignments(&vars, &["e".to_owned()])
            .into_iter()
            .map(|line| String::from_utf8(line).unwrap())
            .collect();
        assert_eq!(
            set,
            [
                "BASH_LINENO=()",
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

    #[test]
    fn computed_names_list_as_bash_lists_them() {
        let mut vars = Store::new(Arc::new(|| 7));
        vars.set_specials(
            vec![0],
            Some(vec![b"f".to_vec()]),
            vec![3],
            3,
            9,
            Vec::new(),
        );
        vars.seed("n", Value::Scalar(b"1".to_vec()));
        vars.set_attr("n", Some(INTEGER), true);
        let listed = |vars: &Store, letters| -> Vec<String> {
            listing(vars, letters, &[])
                .into_iter()
                .map(|line| String::from_utf8(line).unwrap())
                .collect()
        };
        assert_eq!(
            listed(&vars, ""),
            [
                "declare -i BASHPID",
                "declare -a BASH_LINENO=([0]=\"3\")",
                "declare -a FUNCNAME=([0]=\"f\")",
                "declare -- LINENO",
                "declare -a PIPESTATUS=([0]=\"0\")",
                "declare -i RANDOM",
                "declare -i n=\"1\"",
            ]
        );
        assert_eq!(
            listed(&vars, "pi"),
            [
                "declare -i BASHPID",
                "declare -i RANDOM",
                "declare -i n=\"1\""
            ]
        );
        assert_eq!(listed(&vars, "pa").len(), 3);
        assert!(listed(&vars, "aA").is_empty());
        let drawn = String::from_utf8(declaration(&mut vars, RANDOM).unwrap()).unwrap();
        assert!(drawn.starts_with("declare -i RANDOM=\""), "{drawn}");
        assert_eq!(listed(&vars, "pi")[1], drawn);
        let set: Vec<String> = assignments(&vars, &[])
            .into_iter()
            .map(|line| String::from_utf8(line).unwrap())
            .collect();
        assert_eq!(
            &set[..3],
            [
                "BASH_LINENO=([0]=\"3\")",
                "FUNCNAME=([0]=\"f\")",
                "PIPESTATUS=([0]=\"0\")"
            ]
        );
    }
}
