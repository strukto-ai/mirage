use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::expand::{Host, subscript_of};
use super::listing;
use super::shell::Shell;
use super::write::{Element, Fault, Writer};
use super::{Diagnostic, Signal};
use crate::vars::{
    Assigned, Assoc, EXPORT, INTEGER, Indexed, LOWER, NAMEREF, READONLY, Store, UNASSIGNED, UPPER,
    Value, Var, attrs_of,
};

/// One declaration operand in the order typed: a word (`NAME`,
/// `NAME=value`) or an array literal, expanded and staged.
pub enum Operand {
    Word(Vec<u8>),
    Literal {
        name: String,
        append: bool,
        items: Vec<Vec<u8>>,
    },
}

/// The array kind a declaration's `-a` / `-A` asks for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ArrayKind {
    Indexed,
    Assoc,
}

/// What a declaration printed, in order, each piece true for stderr, and
/// its status.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Declared {
    pub pieces: Vec<(bool, Vec<u8>)>,
    pub status: i32,
}

impl Declared {
    pub(super) fn failed(line: Vec<u8>, status: i32) -> Self {
        Self {
            pieces: vec![(true, line)],
            status,
        }
    }

    fn printed(lines: impl IntoIterator<Item = Vec<u8>>) -> Self {
        Self {
            pieces: lines
                .into_iter()
                .map(|line| (false, [line, b"\n".to_vec()].concat()))
                .collect(),
            status: 0,
        }
    }
}

/// Each attribute and whether it goes on or off, in order.
type Marks = Vec<(u8, bool)>;

/// `declare`, `typeset` or `local` as its statement read them.
pub struct Declaration {
    pub cmd: String,
    pub flags: Vec<u8>,
    pub plus: Vec<u8>,
    pub operands: Vec<Operand>,
    /// The running command's temporaries, which a listing leaves out.
    pub temporaries: Vec<String>,
    /// Whether an element operand's subscript expands once more
    /// (`declare 'd[$i]=w'`); false takes it as typed.
    pub subscripts: bool,
}

/// `export` or `readonly` on variables, options already read.
pub struct Marking {
    pub cmd: String,
    pub attr: u8,
    pub on: bool,
    pub flags: Vec<u8>,
    pub operands: Vec<Operand>,
    pub temporaries: Vec<String>,
}

/// The letters a no-name `declare` listing filters on.
const LISTED: &[u8] = b"ilnrtux";
/// The attributes that shape a value as it stores.
const SHAPING: u8 = INTEGER | LOWER | UPPER;

fn identifier_char(byte: &u8) -> bool {
    byte.is_ascii_alphanumeric() || *byte == b'_'
}

/// Whether the word is a shell identifier.
pub fn is_name(word: &[u8]) -> bool {
    word.first()
        .is_some_and(|first| first.is_ascii_alphabetic() || *first == b'_')
        && word.iter().all(identifier_char)
}

/// The length of the `NAME[` `word` opens with, None for any other word.
fn name_bracket(word: &[u8]) -> Option<usize> {
    let name = word.iter().take_while(|b| identifier_char(b)).count();
    (name > 0 && !word[0].is_ascii_digit() && word.get(name) == Some(&b'[')).then_some(name + 1)
}

/// Whether the word parses as `NAME[...]`: an assignment target that is
/// not a plain name.
fn is_subscripted(word: &[u8]) -> bool {
    name_bracket(word).is_some_and(|head| {
        word.len() > head && word.ends_with(b"]") && !word[head..word.len() - 1].contains(&b'\n')
    })
}

/// The index just past the `]` closing the subscript `word` opens with;
/// None when it opens with none or never closes it. A quoted or escaped
/// bracket does not count, as bash skips it.
fn subscript_end(word: &[u8]) -> Option<usize> {
    let mut i = name_bracket(word)? - 1;
    let mut depth = 0;
    while i < word.len() {
        match word[i] {
            b'\\' => i += 1,
            b'\'' => {
                i += 1 + word[i + 1..].iter().position(|&b| b == b'\'')?;
            }
            b'"' => {
                i += 1;
                while i < word.len() && word[i] != b'"' {
                    i += if word[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// A declaration operand as its name, whether it appends, and its value,
/// None for a bare name. An element's subscript runs to its matching `]`,
/// so an `=` inside it is the subscript's; one that never closes, or
/// closes anywhere but before its `=`, assigns nothing.
pub fn operand_parts(word: &[u8]) -> (Vec<u8>, bool, Option<Vec<u8>>) {
    if name_bracket(word).is_some() {
        if let Some(end) = subscript_end(word) {
            let rest = &word[end..];
            if let Some(value) = rest.strip_prefix(b"+=") {
                return (word[..end].to_vec(), true, Some(value.to_vec()));
            }
            if let Some(value) = rest.strip_prefix(b"=") {
                return (word[..end].to_vec(), false, Some(value.to_vec()));
            }
        }
        return (word.to_vec(), false, None);
    }
    let Some(eq) = word.iter().position(|&b| b == b'=') else {
        return (word.to_vec(), false, None);
    };
    let name = &word[..eq];
    let value = word[eq + 1..].to_vec();
    match name.strip_suffix(b"+") {
        Some(name) => (name.to_vec(), true, Some(value)),
        None => (name.to_vec(), false, Some(value)),
    }
}

/// The name a bare element operand declares (`a[1]`), None for any other
/// word.
fn element_name(word: &[u8]) -> Option<&[u8]> {
    (subscript_end(word) == Some(word.len()))
        .then(|| word.split(|&b| b == b'[').next().unwrap_or(word))
}

/// One `[key]=value` literal element, None for a plain word. The split
/// lands on the first `]=`, where bash finds it after quote removal.
fn keyed_word(word: &[u8]) -> Option<(&[u8], &[u8])> {
    if word.first() != Some(&b'[') {
        return None;
    }
    let pos = word[1..].windows(2).position(|w| w == b"]=")? + 1;
    (pos > 1).then(|| (&word[1..pos], &word[pos + 2..]))
}

/// The array kind `-a` / `-A` asks for, `-A` winning when both are given.
fn declared_kind(flags: &[u8]) -> Option<ArrayKind> {
    if flags.contains(&b'A') {
        Some(ArrayKind::Assoc)
    } else if flags.contains(&b'a') {
        Some(ArrayKind::Indexed)
    } else {
        None
    }
}

/// bash's refusal when a declared kind meets a value of the other kind.
fn kind_conflict(held: Option<&Value>, kind: Option<ArrayKind>) -> Option<&'static str> {
    match (kind, held) {
        (Some(ArrayKind::Assoc), Some(Value::Indexed(_))) => {
            Some("cannot convert indexed to associative array")
        }
        (Some(ArrayKind::Indexed), Some(Value::Assoc(_))) => {
            Some("cannot convert associative to indexed array")
        }
        _ => None,
    }
}

/// What a declaration's `NAME=value` stores and the elements it assigns:
/// an array keeps its kind and takes the value at element 0, `-A` makes
/// the map `([0]=value)`, `-a` the one-element array, a held scalar
/// converting first, and with neither the value stays a scalar.
fn scalar_value(
    held: Option<&Value>,
    value: Vec<u8>,
    kind: Option<ArrayKind>,
) -> (Value, Option<Assigned>) {
    if matches!(held, Some(Value::Assoc(_))) || kind == Some(ArrayKind::Assoc) {
        let mut map = match held {
            Some(Value::Assoc(map)) => map.clone(),
            _ => Box::default(),
        };
        map.set(b"0".to_vec(), value);
        let keys = HashSet::from([b"0".to_vec()]);
        return (Value::Assoc(map), Some(Assigned::Keys(keys)));
    }
    if matches!(held, Some(Value::Indexed(_))) || kind == Some(ArrayKind::Indexed) {
        let mut array = match held {
            Some(Value::Indexed(array)) => array.clone(),
            Some(Value::Scalar(text)) => Indexed::dense([text.clone()]),
            _ => Indexed::default(),
        };
        array.set(0, value);
        return (
            Value::Indexed(array),
            Some(Assigned::Indexes(HashSet::from([0]))),
        );
    }
    (Value::Scalar(value), None)
}

/// What a `+=` builds on: the held text and, under `-i`, the text to add
/// once it evaluates.
fn appended(held: Option<&Value>, added: &[u8], integer: bool) -> (Vec<u8>, Option<Vec<u8>>) {
    let text = match held {
        Some(Value::Assoc(map)) => map.get(b"0"),
        Some(Value::Indexed(array)) => array.get(0),
        Some(Value::Scalar(text)) => Some(text.as_slice()),
        None => None,
    }
    .unwrap_or_default();
    if integer {
        (text.to_vec(), Some(added.to_vec()))
    } else {
        ([text, added].concat(), None)
    }
}

/// The attributes a new local takes from the variable it shadows: the
/// export mark alone, or with `-I` every one but a reference.
fn local_attrs(var: Option<&Var>, inherit: bool) -> u8 {
    match var {
        None => 0,
        Some(var) if inherit => var.attrs & !NAMEREF,
        Some(var) => var.attrs & EXPORT,
    }
}

/// The attribute marks a declaration puts on each operand once it lands,
/// readonly last: `-l` and `-u` displace each other, a cluster naming both
/// sets neither, and a `+` letter clears, but `+r`, which only refuses.
fn declared_marks(flags: &[u8], plus: &[u8]) -> Marks {
    let mut on: HashSet<u8> = b"iluntxr"
        .iter()
        .copied()
        .filter(|c| flags.contains(c) && !plus.contains(c))
        .collect();
    if on.contains(&b'l') && on.contains(&b'u') {
        on.remove(&b'l');
        on.remove(&b'u');
    }
    let mut marks = Vec::new();
    for c in *b"xiluntr" {
        let attr = attrs_of(&char::from(c).to_string());
        if on.contains(&c) {
            marks.push((attr, true));
            match c {
                b'l' => marks.push((UPPER, false)),
                b'u' => marks.push((LOWER, false)),
                _ => {}
            }
        } else if plus.contains(&c) && c != b'r' {
            marks.push((attr, false));
        }
    }
    marks
}

/// `marks` taking off each of `-i -l -u` they do not name.
fn unshaped(marks: &[(u8, bool)]) -> Marks {
    let mut out: Marks = [INTEGER, LOWER, UPPER]
        .into_iter()
        .filter(|attr| !marks.iter().any(|(named, _)| named == attr))
        .map(|attr| (attr, false))
        .collect();
    out.extend_from_slice(marks);
    out
}

/// A name as the store takes it.
pub(super) fn text(name: &[u8]) -> String {
    String::from_utf8_lossy(name).into_owned()
}

/// A declaration's lines: warnings, then each refusal, one line apiece,
/// exit 1 when an operand refused; an empty refusal fails without a word.
fn result_of(errors: &[Vec<u8>], warnings: &[Vec<u8>], failed: Option<bool>) -> Declared {
    let pieces = warnings
        .iter()
        .chain(errors.iter().filter(|line| !line.is_empty()))
        .map(|line| (true, [line.as_slice(), b"\n"].concat()))
        .collect();
    let failed = failed.unwrap_or(!errors.is_empty());
    Declared {
        pieces,
        status: i32::from(failed),
    }
}

/// The line a write the session hides answers with.
pub(super) fn denied(name: &str) -> Vec<u8> {
    format!("{name}: permission denied\n").into_bytes()
}

struct Run<'a, H: Host> {
    shell: &'a mut Shell,
    host: &'a mut H,
    diagnostics: &'a mut Vec<Diagnostic>,
    cmd: String,
    voice: Vec<u8>,
}

/// Where a `declare` operand's scope and letters come from.
struct Scope {
    kind: Option<ArrayKind>,
    shaping: Marks,
    marks: Marks,
    plus: Vec<u8>,
    nameref: bool,
    inherit: bool,
    scoped: bool,
    subscripts: bool,
}

impl<H: Host> Run<'_, H> {
    fn store(&self) -> &Store {
        &self.shell.vars
    }

    fn writer(&mut self) -> Writer<'_> {
        Writer::of(self.shell, Some(&mut *self.diagnostics))
    }

    fn said(&self, parts: &[&[u8]]) -> Vec<u8> {
        [&[self.voice.as_slice()], parts].concat().concat()
    }

    fn named(&self, name: &[u8], rest: &str) -> Vec<u8> {
        self.said(&[self.cmd.as_bytes(), b": ", name, b": ", rest.as_bytes()])
    }

    fn readonly_line(&self, name: &[u8]) -> Vec<u8> {
        if matches!(self.cmd.as_str(), "declare" | "local" | "typeset") {
            self.named(name, "readonly variable")
        } else {
            self.said(&[name, b": readonly variable"])
        }
    }

    fn identifier_refusal(&self, word: &[u8]) -> Option<Vec<u8>> {
        let name = operand_parts(word).0;
        if is_name(&name) {
            return None;
        }
        let quoted = if is_subscripted(&name) {
            &name[..]
        } else {
            word
        };
        Some(self.said(&[
            self.cmd.as_bytes(),
            b": `",
            quoted,
            b"': not a valid identifier",
        ]))
    }

    fn nameref_refusal(&self, name: &[u8], target: &[u8]) -> Option<Vec<u8>> {
        if is_subscripted(target) {
            return Some(self.named(target, "name reference to an array element: not supported"));
        }
        if !is_name(target) {
            return Some(self.said(&[
                self.cmd.as_bytes(),
                b": `",
                target,
                b"': invalid variable name for name reference",
            ]));
        }
        (target == name).then(|| self.named(name, "nameref variable self references not allowed"))
    }

    /// A name's own record, None when unset or hidden.
    fn visible_record(&self, name: &str) -> Option<&Var> {
        if self.store().hidden(name) {
            return None;
        }
        self.store().record(name)
    }

    /// The value a `NAME=...` lands on: what a reference names.
    fn held_value(&self, name: &str) -> Option<Value> {
        let target = self.store().deref(name);
        self.store().record(&target)?.value.clone()
    }

    /// The line the name a `-n` operand lands on earns, ahead of its
    /// readonly mark.
    fn reference_refusal(&self, name: &str, bare: bool) -> Option<Vec<u8>> {
        let own = self.visible_record(name);
        if own.is_some_and(|var| var.value.as_ref().is_some_and(Value::is_array)) {
            return Some(self.named(name.as_bytes(), "reference variable cannot be an array"));
        }
        let var = own.filter(|var| bare && !var.has(NAMEREF))?;
        let Some(Value::Scalar(held)) = &var.value else {
            return None;
        };
        if held == name.as_bytes() {
            return None;
        }
        self.nameref_refusal(name.as_bytes(), held)
    }

    fn reference_line(&self, name: &str, bare: bool) -> Option<Vec<u8>> {
        self.reference_refusal(name, bare).or_else(|| {
            self.store()
                .is_readonly(name, false)
                .then(|| self.readonly_line(name.as_bytes()))
        })
    }

    /// The line a `+letter` earns on one operand: `+r` on a readonly name,
    /// `+n` on a frozen reference, `+a` / `+A` on an array of that kind.
    fn plus_refusal(&self, name: &str, plus: &[u8]) -> Option<Vec<u8>> {
        let var = self.visible_record(name);
        let value = var.and_then(|var| var.value.as_ref());
        let reference = var.is_some_and(|var| var.has(NAMEREF));
        if (plus.contains(&b'r') && self.store().is_readonly(name, true))
            || (plus.contains(&b'n') && reference && self.store().is_readonly(name, false))
        {
            return Some(self.readonly_line(name.as_bytes()));
        }
        ((plus.contains(&b'a') && matches!(value, Some(Value::Indexed(_))))
            || (plus.contains(&b'A') && matches!(value, Some(Value::Assoc(_)))))
        .then(|| {
            self.named(
                name.as_bytes(),
                "cannot destroy array variables in this way",
            )
        })
    }

    /// Reset a name the function just shadowed to what a new local starts
    /// as: unset, with the attributes `local_attrs` keeps, or under `-I`
    /// the shadowed value too.
    fn start_local(&mut self, name: &str, inherit: bool) {
        let store = &mut self.shell.vars;
        let var = store.place(name, None);
        let kept = local_attrs(var.as_deref(), inherit);
        if let Some(var) = var.filter(|_| kept != 0 || inherit) {
            let value = if inherit { var.value.clone() } else { None };
            let fresh = Var {
                value,
                attrs: kept,
                managed: None,
            };
            store.place(name, Some(Arc::new(fresh)));
        }
    }

    fn premark(&mut self, name: &str, shaping: &[(u8, bool)], follow: bool) -> Result<(), Fault> {
        for &(attr, on) in shaping {
            self.writer().mark(name, Some(attr), on, follow)?;
        }
        Ok(())
    }

    /// Put `attr` on what a write landed on: directly when the write's
    /// checks covered it, else as a mark of its own, for a write that
    /// re-aimed a reference.
    fn mark_written(
        &mut self,
        name: &str,
        checked: &str,
        attr: u8,
        on: bool,
        follow: bool,
    ) -> Result<(), Fault> {
        let follows = follow && attr != NAMEREF;
        let target = if follows {
            self.store().deref(name)
        } else {
            name.to_owned()
        };
        if target == checked {
            self.shell.vars.set_attr(&target, Some(attr), on);
            Ok(())
        } else {
            self.writer().mark(name, Some(attr), on, follow)
        }
    }

    fn stamp_marks(
        &mut self,
        name: &str,
        checked: Option<&str>,
        marks: &[(u8, bool)],
        follow: bool,
    ) -> Result<(), Fault> {
        for &(attr, on) in marks {
            match checked {
                None => self.writer().mark(name, Some(attr), on, follow)?,
                Some(checked) => self.mark_written(name, checked, attr, on, follow)?,
            }
        }
        Ok(())
    }

    /// Take the mark off an unaimed `declare -n` reference a declared array
    /// kind is about to land on.
    fn drop_reference(&mut self, name: &str) -> Result<(), Fault> {
        let target = self.store().deref(name);
        if self.store().record(&target).is_some_and(|v| v.has(NAMEREF)) {
            self.writer().mark(&target, Some(NAMEREF), false, true)?;
        }
        Ok(())
    }

    /// An arithmetic error as the fatal signal it is here, led by `lead`.
    fn arith_fatal(&self, fault: Fault, lead: &str) -> Fault {
        match fault {
            Fault::Arith(error) => Signal::arith(&self.voice, &error, lead, true).into(),
            fault => fault,
        }
    }

    fn indexed_literal(
        &mut self,
        base: Option<Indexed>,
        items: &[Vec<u8>],
        append: bool,
    ) -> Result<Indexed, Fault> {
        let mut array = base.filter(|_| append).unwrap_or_default();
        let mut cursor = if append { array.extent() as i64 } else { 0 };
        for word in items {
            if let Some((key, value)) = keyed_word(word) {
                let mut index = i128::from(self.writer().subscript_index(key)?);
                if index < 0 {
                    index += array.extent();
                }
                if index < 0 {
                    continue;
                }
                let index = index as i64;
                array.set(index, value.to_vec());
                cursor = index.wrapping_add(1);
            } else {
                array.set(cursor, word.clone());
                cursor = cursor.wrapping_add(1);
            }
        }
        Ok(array)
    }

    /// The map a literal makes: a `[key]=value` first word makes every
    /// plain word an error, a plain first word reads the list as keys and
    /// values.
    fn assoc_literal(
        base: Option<Assoc>,
        items: &[Vec<u8>],
        append: bool,
    ) -> (Assoc, Vec<Vec<u8>>) {
        let mut map = base.filter(|_| append).unwrap_or_default();
        let Some(first) = items.first() else {
            return (map, Vec::new());
        };
        if keyed_word(first).is_none() {
            for pair in items.chunks(2) {
                map.set(pair[0].clone(), pair.get(1).cloned().unwrap_or_default());
            }
            return (map, Vec::new());
        }
        let mut bad = Vec::new();
        for word in items {
            match keyed_word(word) {
                Some((key, value)) => {
                    map.set(key.to_vec(), value.to_vec());
                }
                None => bad.push(word.clone()),
            }
        }
        (map, bad)
    }

    fn own_assoc(&self, name: &str) -> Option<Assoc> {
        match self.store().record(name)?.value.as_ref()? {
            Value::Assoc(map) => Some((**map).clone()),
            _ => None,
        }
    }

    fn own_indexed(&self, name: &str) -> Option<Indexed> {
        match self.store().record(name)?.value.as_ref()? {
            Value::Indexed(array) => Some(array.clone()),
            _ => None,
        }
    }

    /// Store a declaration's array literals, the first of bash's two
    /// passes over it: every literal stores before any other operand runs.
    /// The fault a hidden name earned stops the pass, its literals before
    /// it standing; `stored` reports each that landed and on what.
    #[allow(clippy::too_many_arguments)]
    fn store_staged_arrays(
        &mut self,
        operands: &[Operand],
        errors: &mut Vec<Vec<u8>>,
        warnings: &mut Vec<Vec<u8>>,
        fatal: bool,
        stored: &mut HashMap<usize, String>,
        kind: Option<ArrayKind>,
        shaping: &[(u8, bool)],
        global: bool,
        inherit: bool,
    ) -> Result<Option<Fault>, Fault> {
        let scoped = !global
            && !matches!(self.cmd.as_str(), "export" | "readonly")
            && self.store().in_function();
        for (position, operand) in operands.iter().enumerate() {
            let Operand::Literal {
                name,
                append,
                items,
            } = operand
            else {
                continue;
            };
            if self.store().is_readonly(name, true) {
                if fatal || global {
                    return Err(Signal::Discard {
                        stderr: self.said(&[name.as_bytes(), b": readonly variable\n"]),
                        contained: 1,
                    }
                    .into());
                }
                errors.push(self.readonly_line(name.as_bytes()));
                continue;
            }
            let fresh = scoped && !self.store().is_local(name);
            if scoped {
                self.shell.vars.shadow(name, inherit);
            }
            if fresh && !self.store().in_call_env(name) {
                self.start_local(name, inherit);
            }
            let held = if fresh && !inherit {
                None
            } else {
                self.held_value(name)
            };
            if let Some(conflict) = kind_conflict(held.as_ref(), kind) {
                if fatal {
                    return Err(Signal::Discard {
                        stderr: self.said(&[name.as_bytes(), b": ", conflict.as_bytes(), b"\n"]),
                        contained: 1,
                    }
                    .into());
                }
                errors.push(self.named(name.as_bytes(), conflict));
                continue;
            }
            let marked = self.premark(name, shaping, true).and_then(|()| {
                if kind.is_some() {
                    self.drop_reference(name)
                } else {
                    Ok(())
                }
            });
            match marked {
                Err(fault @ Fault::Hidden(_)) => return Ok(Some(fault)),
                other => other?,
            }
            let checked = self.store().deref(name);
            let assoc = kind == Some(ArrayKind::Assoc) || self.own_assoc(name).is_some();
            let value = if assoc {
                let (built, bad) = Self::assoc_literal(self.own_assoc(name), items, *append);
                for word in bad {
                    warnings.push(self.said(&[
                        name.as_bytes(),
                        b": '",
                        &word,
                        b"': must use subscript when assigning associative array",
                    ]));
                }
                Ok(Value::Assoc(Box::new(built)))
            } else {
                let mut indexed = self.own_indexed(name);
                if *append && indexed.is_none() {
                    let scalar = self
                        .shell
                        .vars
                        .conversion_scalar(name)
                        .map_err(Fault::Arith);
                    match scalar {
                        Ok(scalar) => indexed = scalar.map(|text| Indexed::dense([text])),
                        Err(fault) => return Err(self.arith_fatal(fault, "")),
                    }
                }
                self.indexed_literal(indexed, items, *append)
                    .map(Value::Indexed)
            };
            let landed = value.and_then(|v| self.writer().set(name, v, true, None, None));
            match landed {
                Err(fault @ Fault::Hidden(_)) => return Ok(Some(fault)),
                Err(fault) => return Err(self.arith_fatal(fault, "")),
                Ok(()) => {}
            }
            stored.insert(position, checked);
        }
        Ok(None)
    }

    fn refusal(fault: Fault) -> Result<Declared, Fault> {
        match fault {
            Fault::Hidden(name) => Ok(Declared::failed(denied(&name), 1)),
            fault => Err(fault),
        }
    }

    fn mark_listing(&mut self, marking: &Marking) -> Declared {
        let flags = &marking.flags;
        let mut names: Vec<String> = self
            .store()
            .records()
            .filter(|(name, var)| {
                var.has(marking.attr)
                    && (!flags.contains(&b'a') || self.own_indexed(name).is_some())
                    && (!flags.contains(&b'A') || self.own_assoc(name).is_some())
                    && !marking.temporaries.iter().any(|skip| skip == name)
            })
            .map(|(name, _)| name.to_owned())
            .collect();
        names.sort();
        let store = &mut self.shell.vars;
        Declared::printed(
            names
                .iter()
                .filter_map(|name| listing::declaration(store, name)),
        )
    }

    /// Assign and mark one `export` / `readonly` word. A value of the other
    /// array kind is refused and the name is still marked; a bare form
    /// leaves a new name unset and marked.
    fn mark_operand(
        &mut self,
        word: &[u8],
        attr: u8,
        on: bool,
        kind: Option<ArrayKind>,
        traced: Option<&mut Vec<Vec<u8>>>,
    ) -> Result<Option<Vec<u8>>, Fault> {
        if let Some(line) = self.identifier_refusal(word) {
            return Ok(Some(line));
        }
        let (key, append, value) = operand_parts(word);
        let name = text(&key);
        if let (Some(traced), Some(value)) = (traced, &value) {
            traced.push(trace_assignment(&key, value, append));
        }
        if value.is_some() && self.store().is_readonly(&name, true) {
            return Ok(Some(self.readonly_line(&key)));
        }
        let held = value.as_ref().and_then(|_| self.held_value(&name));
        let conflict = value
            .as_ref()
            .and_then(|_| kind_conflict(held.as_ref(), kind));
        match value.filter(|_| conflict.is_none()) {
            Some(given) => {
                let checked = self.store().deref(&name);
                let integer = self
                    .store()
                    .record(&checked)
                    .is_some_and(|var| var.has(INTEGER));
                let (given, added) = if append {
                    appended(held.as_ref(), &given, integer)
                } else {
                    (given, None)
                };
                let (stored, assigned) = scalar_value(held.as_ref(), given, kind);
                if kind.is_some() {
                    self.drop_reference(&name)?;
                }
                self.writer()
                    .set(&name, stored, true, assigned.as_ref(), added.as_deref())?;
                self.mark_written(&name, &checked, attr, on, true)?;
            }
            None => self.writer().mark(&name, Some(attr), on, true)?,
        }
        if on {
            self.shell.vars.outlive_call(&name);
        }
        Ok(conflict.map(|conflict| self.named(&key, conflict)))
    }

    /// `export` or `readonly` over its operands: every array literal
    /// stores first, then each operand in order is assigned and marked.
    fn mark_variables(
        &mut self,
        marking: &Marking,
        kind: Option<ArrayKind>,
    ) -> Result<Declared, Fault> {
        let (mut errors, mut warnings) = (Vec::new(), Vec::new());
        let mut stored = HashMap::new();
        let refused = self.store_staged_arrays(
            &marking.operands,
            &mut errors,
            &mut warnings,
            true,
            &mut stored,
            kind,
            &[],
            false,
            false,
        )?;
        let traced = kind.is_none() && self.shell.option("xtrace");
        let mut failed = false;
        for (position, operand) in marking.operands.iter().enumerate() {
            let ran = match operand {
                Operand::Word(_) if refused.is_some() => Ok(()),
                Operand::Word(word) => {
                    let mut traces = Vec::new();
                    let line = self.mark_operand(
                        word,
                        marking.attr,
                        marking.on,
                        kind,
                        traced.then_some(&mut traces),
                    );
                    errors.append(&mut traces);
                    line.map(|line| {
                        if let Some(line) = line {
                            errors.push(line);
                            failed = true;
                        }
                    })
                }
                Operand::Literal { name, .. } => match stored.get(&position) {
                    Some(checked) => {
                        self.mark_written(name, checked, marking.attr, marking.on, true)
                    }
                    None => Ok(()),
                },
            };
            match ran {
                Ok(()) => {}
                Err(Fault::Hidden(name)) => return Ok(Declared::failed(denied(&name), 1)),
                Err(Fault::Arith(error)) => {
                    let Signal::Exit {
                        status,
                        stderr,
                        contained,
                    } = Signal::arith(&self.voice, &error, &self.cmd, true)
                    else {
                        unreachable!("a fatal arithmetic error ends the shell");
                    };
                    let shown = warnings
                        .iter()
                        .chain(&errors)
                        .filter(|line| !line.is_empty())
                        .flat_map(|line| [line.as_slice(), b"\n"].concat())
                        .collect::<Vec<u8>>();
                    return Err(Signal::Exit {
                        status,
                        stderr: [shown, stderr].concat(),
                        contained,
                    }
                    .into());
                }
                Err(fault) => return Err(fault),
            }
        }
        if let Some(fault) = refused {
            return Self::refusal(fault);
        }
        Ok(result_of(&errors, &warnings, Some(failed)))
    }

    /// Start a new bare `local NAME` unset: only a name the frame did not
    /// shadow yet, a readonly one refusing.
    fn fresh_local(&mut self, name: &str, inherit: bool) -> Result<Option<Vec<u8>>, Fault> {
        let Some(var) = self.store().record(name).cloned() else {
            return Ok(None);
        };
        if self.store().in_call_env(name) {
            return Ok(None);
        }
        if self.store().is_readonly(name, true) {
            return Ok(Some(self.readonly_line(name.as_bytes())));
        }
        if inherit {
            if var.has(NAMEREF) {
                self.writer().mark(name, Some(NAMEREF), false, true)?;
            }
            return Ok(None);
        }
        self.writer().unset(name, false)?;
        if var.has(EXPORT) {
            self.writer().mark(name, Some(EXPORT), true, true)?;
        }
        Ok(None)
    }

    /// Aim a `declare -n NAME=VALUE` once the name may take one: what `+=`
    /// builds, and under `-i` what the arithmetic makes of it, never a
    /// name. A result naming no variable fails, silently when the given
    /// text names one.
    #[allow(clippy::too_many_arguments)]
    fn aim_reference(
        &mut self,
        name: &str,
        append: bool,
        given: &[u8],
        shaping: &[(u8, bool)],
        marks: &[(u8, bool)],
        creates: bool,
    ) -> Result<Option<Vec<u8>>, Fault> {
        let old = match self.visible_record(name).and_then(|v| v.value.as_ref()) {
            Some(Value::Scalar(text)) if append => text.clone(),
            _ => Vec::new(),
        };
        let mut value = [old.as_slice(), given].concat();
        if shaping.contains(&(INTEGER, true)) {
            let (held, added) = if append {
                (old.as_slice(), Some(given))
            } else {
                (given, None)
            };
            self.writer().evaluate_integer(held, added)?;
            value = Vec::new();
        }
        if is_name(&value) || is_subscripted(&value) {
            if let Some(line) = self.nameref_refusal(name.as_bytes(), &value) {
                return Ok(Some(line));
            }
            self.premark(name, shaping, false)?;
            self.writer()
                .set(name, Value::Scalar(value), false, None, None)?;
            self.stamp_marks(name, Some(name), marks, false)?;
            return Ok(None);
        }
        if creates && self.store().record(name).is_none() {
            self.writer().mark(name, None, true, false)?;
        }
        if self.store().record(name).is_some() {
            let kept: Marks = marks
                .iter()
                .copied()
                .filter(|(attr, _)| *attr != NAMEREF)
                .collect();
            self.stamp_marks(name, None, &kept, false)?;
        }
        Ok(Some(if is_name(given) {
            Vec::new()
        } else {
            self.said(&[
                self.cmd.as_bytes(),
                b": `",
                given,
                b"': not a valid identifier",
            ])
        }))
    }

    /// Assign one `NAME[SUB]=value` operand: the subscript expands once
    /// more, the name becomes an array and the element takes the value
    /// before the marks go on.
    async fn declare_element(
        &mut self,
        key: &[u8],
        append: bool,
        value: &[u8],
        scope: &Scope,
    ) -> Result<Option<Vec<u8>>, Fault> {
        if scope.nameref {
            return Ok(Some(self.said(&[
                self.cmd.as_bytes(),
                b": ",
                key,
                b": reference variable cannot be an array",
            ])));
        }
        let inner = &key[..key.len() - 1];
        let bracket = inner.iter().position(|&b| b == b'[').unwrap_or(inner.len());
        let name = text(&inner[..bracket]);
        let raw = inner.get(bracket + 1..).unwrap_or_default();
        if self.store().is_readonly(&name, true) {
            return Ok(Some(self.readonly_line(name.as_bytes())));
        }
        let fresh = scope.scoped && !self.store().is_local(&name);
        if scope.scoped {
            self.shell.vars.shadow(&name, scope.inherit);
        }
        if fresh && !self.store().in_call_env(&name) {
            self.start_local(&name, scope.inherit);
        }
        if let Some(line) = self.plus_refusal(&name, &scope.plus) {
            return Ok(Some(line));
        }
        let held = self.held_value(&name);
        if let Some(conflict) = kind_conflict(held.as_ref(), scope.kind) {
            return Ok(Some(self.named(name.as_bytes(), conflict)));
        }
        let assoc = scope.kind == Some(ArrayKind::Assoc) || matches!(held, Some(Value::Assoc(_)));
        let bad = |run: &Self| run.said(&[key, b": bad array subscript"]);
        if raw.is_empty() || (!assoc && matches!(raw, b"@" | b"*")) {
            return Ok(Some(bad(self)));
        }
        if assoc && !matches!(held, Some(Value::Assoc(_))) {
            let mut map = Assoc::default();
            if let Some(Value::Scalar(text)) = &held {
                map.set(b"0".to_vec(), text.clone());
            }
            self.writer()
                .set(&name, Value::Assoc(Box::new(map)), false, None, None)?;
        }
        let subscript = if scope.subscripts {
            subscript_of(self.shell, self.host, raw).await?
        } else {
            raw.to_vec()
        };
        self.premark(&name, &scope.shaping, true)?;
        let element =
            Writer::of(self.shell, None).element(&name, Some(&subscript), value, append)?;
        match element {
            Element::Landed => {}
            Element::Readonly => return Ok(Some(self.readonly_line(name.as_bytes()))),
            Element::Hidden => {
                return Ok(Some(self.said(&[name.as_bytes(), b": permission denied"])));
            }
            _ => return Ok(Some(bad(self))),
        }
        self.stamp_marks(&name, Some(&name), &scope.marks, true)?;
        Ok(None)
    }

    /// Declare one `NAME`, `NAME=value`, `NAME+=value` or element operand
    /// and mark it.
    async fn declare_operand(
        &mut self,
        word: &[u8],
        scope: &Scope,
    ) -> Result<Option<Vec<u8>>, Fault> {
        let (key, append, value) = operand_parts(word);
        if let Some(value) = value.as_ref().filter(|_| is_subscripted(&key)) {
            return self.declare_element(&key, append, value, scope).await;
        }
        if let Some(line) = self.identifier_refusal(word) {
            return Ok(Some(line));
        }
        let name = text(&key);
        let fresh = scope.scoped && !self.store().is_local(&name);
        let follow = !scope.nameref;
        let (shaping, marks) = if scope.nameref {
            (unshaped(&scope.shaping), unshaped(&scope.marks))
        } else {
            (scope.shaping.clone(), scope.marks.clone())
        };
        let Some(value) = value else {
            if scope.scoped {
                self.shell.vars.shadow(&name, scope.inherit);
            }
            if fresh {
                if let Some(line) = self.fresh_local(&name, scope.inherit)? {
                    return Ok(Some(line));
                }
            }
            let line = if scope.nameref {
                self.reference_line(&name, true)
            } else {
                None
            }
            .or_else(|| self.plus_refusal(&name, &scope.plus));
            if line.is_some() {
                return Ok(line);
            }
            let visible = self
                .store()
                .visible(&name)
                .and_then(|var| var.value.as_ref());
            let held = visible.is_some() || self.own_indexed_visible(&name);
            if !held {
                self.writer().mark(&name, None, true, follow)?;
            }
            self.stamp_marks(&name, None, &marks, follow)?;
            return Ok(None);
        };
        if scope.nameref && !append && !value.is_empty() {
            if let Some(line) = self.nameref_refusal(&key, &value) {
                return Ok(Some(line));
            }
        }
        let creates = fresh && !self.store().in_call_env(&name);
        if (creates || !scope.nameref) && self.store().is_readonly(&name, follow) {
            return Ok(Some(self.readonly_line(&key)));
        }
        if scope.scoped {
            self.shell.vars.shadow(&name, scope.inherit);
        }
        if creates {
            self.start_local(&name, scope.inherit);
        }
        let line = if scope.nameref {
            self.reference_line(&name, false)
        } else {
            None
        }
        .or_else(|| self.plus_refusal(&name, &scope.plus));
        if line.is_some() {
            return Ok(line);
        }
        if scope.nameref {
            return self.aim_reference(&name, append, &value, &shaping, &marks, creates);
        }
        let held = if fresh && !scope.inherit {
            None
        } else {
            self.held_value(&name)
        };
        if let Some(conflict) = kind_conflict(held.as_ref(), scope.kind) {
            return Ok(Some(self.named(&key, conflict)));
        }
        let checked = self.store().deref(&name);
        self.premark(&name, &shaping, true)?;
        let integer = self
            .store()
            .record(&checked)
            .is_some_and(|var| var.has(INTEGER));
        let (value, added) = if append {
            appended(held.as_ref(), &value, integer)
        } else {
            (value, None)
        };
        let (stored, assigned) = scalar_value(held.as_ref(), value, scope.kind);
        if scope.kind.is_some() {
            self.drop_reference(&name)?;
        }
        self.writer()
            .set(&name, stored, true, assigned.as_ref(), added.as_deref())?;
        self.stamp_marks(&name, Some(&checked), &marks, true)?;
        Ok(None)
    }

    /// Whether an array a reader resolves `name` against holds it, the
    /// shell's own `PIPESTATUS` and `FUNCNAME` included.
    fn own_indexed_visible(&self, name: &str) -> bool {
        !self.store().hidden(name) && self.shell.indexed(name).is_some()
    }

    /// Run the operands in the scope settled on: every literal first, then
    /// each operand in order, marked before the next one runs.
    async fn declare_operands(
        &mut self,
        operands: &[Operand],
        scope: &Scope,
    ) -> Result<Declared, Fault> {
        let (mut errors, mut warnings) = (Vec::new(), Vec::new());
        let mut stored = HashMap::new();
        let fatal = !self.store().in_function();
        let refused = self.store_staged_arrays(
            operands,
            &mut errors,
            &mut warnings,
            fatal,
            &mut stored,
            scope.kind,
            &scope.shaping,
            !scope.scoped,
            scope.inherit,
        )?;
        for (position, operand) in operands.iter().enumerate() {
            let line = match operand {
                Operand::Word(_) if refused.is_some() => None,
                Operand::Word(word) => self.declare_operand(word, scope).await?,
                Operand::Literal { name, .. } => match stored.get(&position) {
                    None => continue,
                    Some(checked) => {
                        let line = if scope.nameref {
                            self.reference_line(name, false)
                        } else {
                            None
                        }
                        .or_else(|| self.plus_refusal(name, &scope.plus));
                        if line.is_none() {
                            let marks = if scope.nameref {
                                unshaped(&scope.marks)
                            } else {
                                scope.marks.clone()
                            };
                            self.stamp_marks(name, Some(checked), &marks, !scope.nameref)?;
                        }
                        line
                    }
                },
            };
            if let Some(line) = line {
                errors.push(line);
            }
        }
        if let Some(fault) = refused {
            return Self::refusal(fault);
        }
        Ok(result_of(&errors, &warnings, None))
    }

    /// Declare names in the running function's scope, or globally.
    async fn declare_names(
        &mut self,
        operands: &[Operand],
        kind: Option<ArrayKind>,
        marks: Marks,
        declaration: &Declaration,
    ) -> Result<Declared, Fault> {
        let plus = &declaration.plus;
        let global = declaration.flags.contains(&b'g');
        let scope = Scope {
            kind,
            shaping: marks
                .iter()
                .copied()
                .filter(|(attr, _)| attr & SHAPING != 0)
                .collect(),
            marks,
            plus: plus.clone(),
            nameref: declaration.flags.contains(&b'n') && !plus.contains(&b'n'),
            inherit: declaration.flags.contains(&b'I') || self.shell.shopt("localvar_inherit"),
            scoped: !global && self.store().in_function(),
            subscripts: declaration.subscripts,
        };
        if global {
            let names = operands
                .iter()
                .map(|operand| match operand {
                    Operand::Word(word) => text(&operand_parts(word).0),
                    Operand::Literal { name, .. } => name.clone(),
                })
                .collect::<Vec<_>>();
            self.shell.vars.reach_global(&names);
        }
        let result = self.declare_operands(operands, &scope).await;
        if global {
            self.shell.vars.unreach();
        }
        match result {
            Err(Fault::Hidden(name)) => Ok(Declared::failed(denied(&name), 1)),
            Err(Fault::Arith(error)) => {
                Err(Signal::arith(&self.voice, &error, &self.cmd, true).into())
            }
            other => other,
        }
    }

    /// `declare -p`: declarations for names in the order given, or for all.
    fn print(&mut self, names: &[Vec<u8>], declaration: &Declaration) -> Declared {
        if names.is_empty() {
            let mut letters = declaration.flags.clone();
            letters.sort_unstable();
            letters.dedup();
            let lines = listing::listing(
                self.store(),
                &String::from_utf8_lossy(&letters),
                &declaration.temporaries,
            );
            return Declared::printed(lines);
        }
        let mut out = Declared::default();
        for name in names {
            match listing::declaration(&mut self.shell.vars, &text(name)) {
                Some(line) => out.pieces.push((false, [line, b"\n".to_vec()].concat())),
                None => {
                    out.status = 1;
                    out.pieces.push((
                        true,
                        [self.named(name, "not found"), b"\n".to_vec()].concat(),
                    ));
                }
            }
        }
        out
    }

    /// Declare the bare names `-a` / `-A`, or an element operand, make
    /// arrays, each refusal a line of its own.
    fn convert_bare(
        &mut self,
        words: &[Vec<u8>],
        elements: &HashSet<Vec<u8>>,
        kind: Option<ArrayKind>,
        flags: &[u8],
    ) -> Result<Vec<Vec<u8>>, Fault> {
        let mut errors = Vec::new();
        let global = flags.contains(&b'g');
        let discard = |fault: Fault| match fault {
            Fault::Hidden(name) => Fault::Signal(Signal::Discard {
                stderr: denied(&name),
                contained: 1,
            }),
            fault => fault,
        };
        for bare in words {
            let want = kind.or(elements.contains(bare).then_some(ArrayKind::Indexed));
            let Some(want) = want.filter(|_| !bare.contains(&b'=')) else {
                continue;
            };
            let name = text(bare);
            if self.store().hidden(&name) {
                return Err(discard(Fault::Hidden(name)));
            }
            let fresh = !global && self.store().in_function() && !self.store().is_local(&name);
            if fresh && self.store().record(&name).is_some_and(|v| v.has(READONLY)) {
                continue;
            }
            let local = !global && self.store().in_function();
            if local {
                self.shell.vars.shadow(&name, false);
            }
            if local && fresh {
                self.start_local(&name, flags.contains(&b'I'));
            }
            let held = self.held_value(&name);
            if let Some(conflict) = kind_conflict(held.as_ref(), Some(want)) {
                errors.push(self.named(bare, conflict));
                continue;
            }
            if matches!(
                (&held, want),
                (Some(Value::Assoc(_)), ArrayKind::Assoc)
                    | (Some(Value::Indexed(_)), ArrayKind::Indexed)
            ) {
                continue;
            }
            let scalar = if local {
                None
            } else {
                self.shell
                    .vars
                    .conversion_scalar(&name)
                    .map_err(Fault::Arith)?
            };
            let fill = match want {
                ArrayKind::Assoc => {
                    let mut map = Assoc::default();
                    if let Some(text) = scalar {
                        map.set(b"0".to_vec(), text);
                    }
                    Value::Assoc(Box::new(map))
                }
                ArrayKind::Indexed => Value::Indexed(match scalar {
                    Some(text) => Indexed::dense([text]),
                    None => Indexed::default(),
                }),
            };
            if self.store().is_readonly(&name, false) {
                self.shell.vars.seed(&name, fill);
            } else {
                self.writer()
                    .set(&name, fill, false, None, None)
                    .map_err(discard)?;
            }
            if held.is_none() {
                self.shell.vars.set_attr(&name, Some(UNASSIGNED), true);
            }
        }
        Ok(errors)
    }

    async fn declaration(&mut self, declaration: &Declaration) -> Result<Declared, Fault> {
        let cmd = declaration.cmd.as_str();
        let flags = &declaration.flags;
        let plus = &declaration.plus;
        if cmd == "local" && !self.store().in_function() {
            let line = self.said(&[b"local: can only be used in a function\n"]);
            return Ok(Declared::failed(line, 1));
        }
        let operands = &declaration.operands;
        if cmd == "local" && operands.is_empty() {
            let names = self.store().locals();
            let store = &mut self.shell.vars;
            return Ok(Declared::printed(
                names
                    .iter()
                    .filter_map(|name| listing::declaration(store, name)),
            ));
        }
        let words: Vec<Vec<u8>> = operands
            .iter()
            .filter_map(|operand| match operand {
                Operand::Word(word) => Some(word.clone()),
                Operand::Literal { .. } => None,
            })
            .collect();
        let listing = operands.is_empty()
            && flags
                .iter()
                .any(|c| LISTED.contains(c) || matches!(c, b'a' | b'A'));
        if matches!(cmd, "declare" | "typeset")
            && (flags.contains(&b'p') || plus.contains(&b'p') || listing)
        {
            return Ok(self.print(&words, declaration));
        }
        let marks = declared_marks(flags, plus);
        let kind = declared_kind(flags);
        let base = |word: &Vec<u8>| element_name(word).map_or_else(|| word.clone(), <[u8]>::to_vec);
        let elements: HashSet<Vec<u8>> = words
            .iter()
            .filter(|word| element_name(word).is_some())
            .map(base)
            .collect();
        let based: Vec<Operand>;
        let (operands, words) = if elements.is_empty() {
            (operands.as_slice(), words)
        } else {
            based = operands
                .iter()
                .map(|operand| match operand {
                    Operand::Word(word) => Operand::Word(base(word)),
                    Operand::Literal {
                        name,
                        append,
                        items,
                    } => Operand::Literal {
                        name: name.clone(),
                        append: *append,
                        items: items.clone(),
                    },
                })
                .collect();
            (based.as_slice(), words.iter().map(base).collect())
        };
        let conversions = if kind.is_some() || !elements.is_empty() {
            self.convert_bare(&words, &elements, kind, flags)?
        } else {
            Vec::new()
        };
        let mut result = self
            .declare_names(operands, kind, marks, declaration)
            .await?;
        if !conversions.is_empty() {
            result.pieces.extend(
                conversions
                    .into_iter()
                    .map(|line| (true, [line, b"\n".to_vec()].concat())),
            );
            result.status = 1;
        }
        Ok(result)
    }

    fn marking(&mut self, marking: &Marking) -> Result<Declared, Fault> {
        if marking.operands.is_empty() {
            return Ok(self.mark_listing(marking));
        }
        self.mark_variables(marking, declared_kind(&marking.flags))
    }
}

/// Store array literals only, for `export -f` / `readonly -f`, whose names
/// the host then checks against its functions.
fn staged<H: Host>(run: &mut Run<'_, H>, marking: &Marking) -> Result<Declared, Fault> {
    let (mut errors, mut warnings) = (Vec::new(), Vec::new());
    let refused = run.store_staged_arrays(
        &marking.operands,
        &mut errors,
        &mut warnings,
        true,
        &mut HashMap::new(),
        declared_kind(&marking.flags),
        &[],
        false,
        false,
    )?;
    if let Some(fault) = refused {
        return Run::<H>::refusal(fault);
    }
    Ok(result_of(&errors, &warnings, None))
}

/// The `set -x` trace line for an assignment, without its newline.
fn trace_assignment(key: &[u8], value: &[u8], append: bool) -> Vec<u8> {
    let op: &[u8] = if append { b"+=" } else { b"=" };
    let shown = if value.is_empty() {
        Vec::new()
    } else {
        trace_quote(value)
    };
    [b"+ ", key, op, shown.as_slice()].concat()
}

/// One word as bash's trace writes it: single-quoted when it holds a blank
/// or a shell metacharacter, starts with `#` or `~` or has a `~` after
/// `=` or `:`; else `$'...'` when it holds a control character; else bare.
fn trace_quote(word: &[u8]) -> Vec<u8> {
    let meta = word
        .iter()
        .any(|b| b" \t\n!\"$&'()*;<>?[\\]^`{|}".contains(b))
        || matches!(word.first(), Some(b'#' | b'~'))
        || word.windows(2).any(|w| matches!(w, b"=~" | b":~"));
    if meta {
        let mut out = vec![b'\''];
        for &byte in word {
            if byte == b'\'' {
                out.extend_from_slice(b"'\\''");
            } else {
                out.push(byte);
            }
        }
        out.push(b'\'');
        return out;
    }
    if !word.iter().any(|&b| b < 0x20 || b == 0x7f) {
        return word.to_vec();
    }
    let mut out = b"$'".to_vec();
    for &byte in word {
        match byte {
            0x07 => out.extend_from_slice(b"\\a"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0b => out.extend_from_slice(b"\\v"),
            0x0c => out.extend_from_slice(b"\\f"),
            0x0d => out.extend_from_slice(b"\\r"),
            0x1b => out.extend_from_slice(b"\\E"),
            byte if byte < 0x20 || byte == 0x7f => {
                out.extend_from_slice(format!("\\{byte:03o}").as_bytes());
            }
            byte => out.push(byte),
        }
    }
    out.push(b'\'');
    out
}

/// Run a `declare`, `typeset` or `local` statement on `shell`.
pub async fn run_declaration<H: Host>(
    shell: &mut Shell,
    host: &mut H,
    diagnostics: &mut Vec<Diagnostic>,
    declaration: &Declaration,
) -> Result<Declared, Fault> {
    let voice = shell.vars.voice().to_vec();
    let mut run = Run {
        shell,
        host,
        diagnostics,
        cmd: declaration.cmd.clone(),
        voice,
    };
    run.declaration(declaration).await
}

/// Run `export` or `readonly` on variables; with `functions`, only store
/// the literals of a `-f` line.
pub fn run_marking<H: Host>(
    shell: &mut Shell,
    host: &mut H,
    diagnostics: &mut Vec<Diagnostic>,
    marking: &Marking,
    functions: bool,
) -> Result<Declared, Fault> {
    let voice = shell.vars.voice().to_vec();
    let mut run = Run {
        shell,
        host,
        diagnostics,
        cmd: marking.cmd.clone(),
        voice,
    };
    if functions {
        staged(&mut run, marking)
    } else {
        run.marking(marking)
    }
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::Arc;

    use super::super::expand::{Field, Substitution};
    use super::*;
    use crate::vars::Store;

    pub(in crate::interp) struct NoHost;

    impl Host for NoHost {
        async fn substitute(
            &mut self,
            _: &mut Shell,
            _: &[u8],
            _: usize,
            _: Option<(usize, usize)>,
            _: Option<&[Field]>,
        ) -> Result<Substitution, Fault> {
            Err(Fault::Host("no substitution here"))
        }

        async fn process_substitution(
            &mut self,
            _: &mut Shell,
            _: usize,
        ) -> Result<Vec<u8>, Fault> {
            Err(Fault::Host("no process substitution here"))
        }
    }

    fn shell() -> Shell {
        Shell::new(Store::new(Arc::new(|| 1)))
    }

    fn declaration(cmd: &str, flags: &[u8], words: &[&[u8]]) -> Declaration {
        Declaration {
            cmd: cmd.to_owned(),
            flags: flags.to_vec(),
            plus: Vec::new(),
            operands: words.iter().map(|w| Operand::Word(w.to_vec())).collect(),
            temporaries: Vec::new(),
            subscripts: true,
        }
    }

    fn run(shell: &mut Shell, declaration: &Declaration) -> Result<Declared, Fault> {
        let mut host = NoHost;
        let mut diagnostics = Vec::new();
        let mut future = std::pin::pin!(run_declaration(
            shell,
            &mut host,
            &mut diagnostics,
            declaration
        ));
        let waker = std::task::Waker::noop();
        match future
            .as_mut()
            .poll(&mut std::task::Context::from_waker(waker))
        {
            std::task::Poll::Ready(result) => result,
            std::task::Poll::Pending => panic!("a declaration with no substitution does not wait"),
        }
    }

    #[test]
    fn an_operand_splits_on_the_equals_outside_its_subscript() {
        assert_eq!(operand_parts(b"X"), (b"X".to_vec(), false, None));
        assert_eq!(
            operand_parts(b"X+=y"),
            (b"X".to_vec(), true, Some(b"y".to_vec()))
        );
        assert_eq!(
            operand_parts(b"a[x=5]=1"),
            (b"a[x=5]".to_vec(), false, Some(b"1".to_vec()))
        );
        assert_eq!(operand_parts(b"c[]]=v"), (b"c[]]=v".to_vec(), false, None));
        assert_eq!(element_name(b"t[1]"), Some(&b"t"[..]));
        assert_eq!(element_name(b"t[1]=x"), None);
    }

    #[test]
    fn a_literal_element_is_keyed_at_its_first_close() {
        assert_eq!(keyed_word(b"[a]=1"), Some((&b"a"[..], &b"1"[..])));
        assert_eq!(keyed_word(b"[]=1"), None);
        assert_eq!(keyed_word(b"plain"), None);
    }

    #[test]
    fn the_case_letters_displace_each_other_and_readonly_lands_last() {
        let marks = declared_marks(b"ru", b"");
        assert_eq!(marks, vec![(UPPER, true), (LOWER, false), (READONLY, true)]);
        assert_eq!(declared_marks(b"lu", b""), Vec::new());
    }

    #[test]
    fn a_trace_quotes_what_the_shell_would_read() {
        assert_eq!(trace_assignment(b"x", b"", false), b"+ x=");
        assert_eq!(trace_assignment(b"x", b"a b", true), b"+ x+='a b'");
        assert_eq!(trace_assignment(b"x", b"a\tb", false), b"+ x='a\tb'");
        assert_eq!(trace_assignment(b"x", b"a\x1bb", false), b"+ x=$'a\\Eb'");
    }

    #[test]
    fn a_readonly_operand_refuses_and_the_rest_still_declare() {
        let mut shell = shell();
        let result = run(
            &mut shell,
            &declaration("declare", b"r", &[b"R=1", b"R=2", b"X=3"]),
        )
        .unwrap();
        assert_eq!(result.status, 1);
        assert_eq!(
            result.pieces,
            vec![(true, b"bash: declare: R: readonly variable\n".to_vec())]
        );
        assert_eq!(shell.vars.scalar("R"), Some(&b"1"[..]));
        assert_eq!(shell.vars.scalar("X"), Some(&b"3"[..]));
    }

    #[test]
    fn a_value_is_shaped_by_the_declaration_it_comes_with() {
        let mut shell = shell();
        run(&mut shell, &declaration("declare", b"i", &[b"n=3+4"])).unwrap();
        assert_eq!(shell.vars.scalar("n"), Some(&b"7"[..]));
        run(&mut shell, &declaration("declare", b"u", &[b"s=abc"])).unwrap();
        assert_eq!(shell.vars.scalar("s"), Some(&b"ABC"[..]));
    }

    #[test]
    fn an_element_operand_makes_the_array_it_lands_in() {
        let mut shell = shell();
        let result = run(&mut shell, &declaration("declare", b"", &[b"a[2]=x"])).unwrap();
        assert_eq!(result.status, 0);
        assert_eq!(shell.vars.indexed("a").unwrap().get(2), Some(&b"x"[..]));
    }

    #[test]
    fn local_outside_a_function_is_refused() {
        let mut shell = shell();
        let result = run(&mut shell, &declaration("local", b"", &[b"X=1"])).unwrap();
        assert_eq!(result.status, 1);
        assert_eq!(
            result.pieces,
            vec![(
                true,
                b"bash: local: can only be used in a function\n".to_vec()
            )]
        );
        assert_eq!(shell.vars.scalar("X"), None);
    }

    #[test]
    fn a_kind_the_value_cannot_take_refuses_that_name_alone() {
        let mut shell = shell();
        run(&mut shell, &declaration("declare", b"a", &[b"v"])).unwrap();
        let result = run(&mut shell, &declaration("declare", b"A", &[b"v", b"w"])).unwrap();
        assert_eq!(result.status, 1);
        assert_eq!(
            result.pieces,
            vec![(
                true,
                b"bash: declare: v: cannot convert indexed to associative array\n".to_vec()
            )]
        );
        assert!(shell.vars.assoc("w").is_some());
    }
}
