//! The session plane's writes: a variable set, unset or marked, its value
//! shaped by its attributes first, a name the session may not write
//! refused before anything lands. The assignments an `-i` value or a
//! subscript makes land the same way, each before the write they were
//! made for.

use std::collections::HashSet;
use std::sync::Arc;

use super::shell::Shell;
use super::{Diagnostic, Signal};
use crate::arith::{self, plain_decimal};
use crate::integer::parse_decimal;
use crate::vars::{
    Assigned, Coercion, Draws, INTEGER, Indexed, NAMEREF, Slot, Store, Value, entry_bytes,
    strip_key_quotes,
};

/// bash's own exit when it cannot allocate.
const ENV_EXHAUSTED_STATUS: i32 = 2;

/// What an element write a builtin asks for comes to, short of a fault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Element {
    Landed,
    /// A name the session may not write: hidden or protected.
    Denied,
    Readonly,
    /// The subscript names no element: empty, or before the first.
    Subscript,
    /// A subscript other than 0 on a scalar, which `unset 'x[1]'` refuses.
    NotArray,
}

/// A `name` or `name[sub]` reference split, None when it is neither.
pub fn element_reference(reference: &[u8]) -> Option<(&str, Option<&[u8]>)> {
    let end = reference
        .iter()
        .position(|b| !(b.is_ascii_alphanumeric() || *b == b'_'))
        .unwrap_or(reference.len());
    if end == 0 || reference[0].is_ascii_digit() {
        return None;
    }
    let name = std::str::from_utf8(&reference[..end]).ok()?;
    match &reference[end..] {
        [] => Some((name, None)),
        [b'[', inner @ .., b']'] if !inner.is_empty() => Some((name, Some(inner))),
        _ => None,
    }
}

/// Why a write did not land.
#[derive(Debug)]
pub enum Fault {
    /// The name is hidden or protected for this session: EACCES, the
    /// variables twin of a create into hidden path space.
    Denied(String),
    Readonly {
        name: String,
        subscript: bool,
    },
    /// An arithmetic error; the writes made before it have landed.
    Arith(arith::Error),
    Signal(Signal),
    /// A `${...}` bash cannot read, named by the word being expanded;
    /// `fixed` once a boundary named it for good.
    Bad {
        text: Vec<u8>,
        fixed: bool,
    },
    /// What the operation builds outgrows the workspace's `max_memory`.
    Memory,
    /// The host failed what it was asked, or answered something else; the
    /// operation stops, and the host raises its own error.
    Host(&'static str),
}

impl From<Signal> for Fault {
    fn from(signal: Signal) -> Self {
        Fault::Signal(signal)
    }
}

/// A coercion's or a subscript's error, a readonly name in it ending the
/// shell (`declare -i n; ( n='R=3'; echo no )` ends the subshell), in the
/// shell's `voice`.
fn fatal(voice: &[u8], error: arith::Error) -> Fault {
    match error {
        arith::Error::Readonly { name, .. } => Signal::readonly(voice, &name, true).into(),
        arith::Error::Unbound(name) => Signal::unbound(voice, &name).into(),
        error => Fault::Arith(error),
    }
}

/// The session as one line writes it.
pub struct Writer<'a> {
    pub store: &'a mut Store,
    /// `set -a`: every name assigned while it is on is exported.
    pub allexport: bool,
    /// `set -u`, which a subscript's reads obey.
    pub nounset: bool,
    /// Where a warning goes; without one, an error a seed makes is raised.
    pub diagnostics: Option<&'a mut Vec<Diagnostic>>,
    /// `max_env`, and the bytes the session holds outside its variables:
    /// functions, aliases, positional parameters.
    pub limit: Option<usize>,
    pub outside: usize,
}

impl<'a> Writer<'a> {
    /// A writer over a shell's variables with its options and bounds, its
    /// warnings landing in `diagnostics`.
    pub fn of(shell: &'a mut Shell, diagnostics: Option<&'a mut Vec<Diagnostic>>) -> Self {
        Writer {
            allexport: shell.option("allexport"),
            nounset: shell.option("nounset"),
            limit: shell.env_limit,
            outside: shell.outside,
            store: &mut shell.vars,
            diagnostics,
        }
    }

    /// The name a write lands on: a reference's target when `follow_ref`.
    fn aim(&self, name: &str, follow_ref: bool) -> String {
        if follow_ref {
            self.store.target(name)
        } else {
            name.to_owned()
        }
    }

    /// Whether the session may not write `name`: hidden, which reads as
    /// unset, or protected, which reads as any name does.
    fn denied(&self, name: &str) -> bool {
        self.store.hidden(name) || self.store.protected(name)
    }

    fn permitted(&self, name: &str) -> Result<(), Fault> {
        if self.denied(name) {
            return Err(Fault::Denied(name.to_owned()));
        }
        Ok(())
    }

    /// Refuse a write to a hidden, protected or readonly name.
    fn writable(&self, name: &str) -> Result<(), Fault> {
        self.permitted(name)?;
        if self.store.is_readonly(name, false) {
            return Err(Fault::Readonly {
                name: name.to_owned(),
                subscript: false,
            });
        }
        Ok(())
    }

    /// Refuse a write that grows the session past `max_env`, as bash fails
    /// when it cannot allocate, saying the bound is a setting so an agent
    /// does not take it for a broken shell. A write that does not grow
    /// passes unchecked.
    fn check(&self, before: usize, after: usize) -> Result<(), Fault> {
        if self.fits(before, after) {
            return Ok(());
        }
        Err(self.exhausted(after))
    }

    /// Whether an entry growing from `before` bytes to `after` stays
    /// within `max_env`.
    fn fits(&self, before: usize, after: usize) -> bool {
        self.limit.is_none_or(|limit| {
            after <= before
                || (self.store.held() + self.outside + after).saturating_sub(before) <= limit
        })
    }

    /// The end of a shell whose entry would grow to `after` bytes past
    /// `max_env`.
    fn exhausted(&self, after: usize) -> Fault {
        let limit = self.limit.unwrap_or_default();
        Signal::Exit {
            status: ENV_EXHAUSTED_STATUS,
            stderr: format!(
                "bash: xmalloc: cannot allocate {after} bytes (past max_env of {limit} bytes, a mirage workspace setting)\n"
            )
            .into_bytes(),
            contained: ENV_EXHAUSTED_STATUS,
        }
        .into()
    }

    /// The bytes `name` holds, its name included.
    fn entry(&self, name: &str) -> usize {
        entry_bytes(
            name,
            self.store.record(name).and_then(|var| var.value.as_ref()),
        )
    }

    /// Write one variable: a reference's target unless `follow_ref` is off
    /// (`declare -n r=w` re-aims `r`), refused when hidden, protected or
    /// readonly, its value shaped by the name's attributes (`assigned`
    /// naming the elements an array write assigns, `added` an integer
    /// `+=`'s text, evaluated after the held one), a `RANDOM=` seeding the
    /// generator.
    pub fn set(
        &mut self,
        name: &str,
        value: Value,
        follow_ref: bool,
        assigned: Option<&Assigned>,
        added: Option<&[u8]>,
    ) -> Result<(), Fault> {
        let name = self.aim(name, follow_ref);
        self.writable(&name)?;
        // A scalar landing on an array is its element 0, the key `0` in an
        // associative one, as bash binds `read a` or `for a in x` there.
        let value = match (
            value,
            self.store.record(&name).and_then(|var| var.value.as_ref()),
        ) {
            (Value::Scalar(text), Some(Value::Indexed(_))) => {
                return self.set_element(&name, Slot::Index(0), Some(text), added);
            }
            (Value::Scalar(text), Some(Value::Assoc(_))) => {
                let slot = Slot::Key(b"0".to_vec());
                return self.set_element(&name, slot, Some(text), added);
            }
            (value, _) => value,
        };
        let existing = self.store.share(&name);
        let mut value = value;
        let mut coercion = Coercion::default();
        if let Some(attrs) = existing.as_ref().map(|var| var.attrs).filter(|&a| a != 0) {
            match self
                .store
                .coerce(&mut coercion, value, attrs, added, assigned)
            {
                Ok(shaped) => value = shaped,
                Err(error) => {
                    self.land_coercion(&mut coercion)?;
                    return Err(fatal(self.store.voice(), error));
                }
            }
        }
        if value.is_array() && self.store.seeds_random(&name) {
            // An element written to RANDOM seeds it, which bash evaluates
            // there, landing what it assigns (`RANDOM[0]='x=5'`): one that
            // does not evaluate ends the line.
            match self
                .store
                .coerce(&mut coercion, value, INTEGER, None, assigned)
            {
                Ok(shaped) => value = shaped,
                Err(error) => {
                    self.land_coercion(&mut coercion)?;
                    return Err(fatal(self.store.voice(), error));
                }
            }
        }
        let seeding = match &value {
            Value::Scalar(word) if self.store.seeds_random(&name) => Some(word),
            _ => None,
        };
        if let Some(word) = seeding {
            match self.store.evaluate_integer(&mut coercion, word, None) {
                Ok(text) => {
                    let state = parse_decimal::<i64>(&text).unwrap_or(0).rem_euclid(1 << 32) as u32;
                    self.store.seed_random(word.clone(), state);
                }
                Err(error) => {
                    self.land_coercion(&mut coercion)?;
                    let subscript = matches!(
                        error,
                        arith::Error::Readonly {
                            subscript: true,
                            ..
                        }
                    );
                    return match (error, self.diagnostics.as_deref_mut()) {
                        (arith::Error::Readonly { name, .. }, None) => {
                            Err(Signal::readonly(self.store.voice(), &name, subscript).into())
                        }
                        (arith::Error::Readonly { name, .. }, Some(_)) if subscript => {
                            Err(Signal::readonly(self.store.voice(), &name, true).into())
                        }
                        (error, None) => Err(fatal(self.store.voice(), error)),
                        (error, Some(diagnostics)) => {
                            diagnostics.push(Diagnostic::Text(super::arith_line(&error)));
                            Ok(())
                        }
                    };
                }
            }
        }
        self.store.note_kind(&name, &value);
        self.land_coercion(&mut coercion)?;
        let unaimed = existing.as_ref().is_some_and(|var| var.has(NAMEREF));
        if unaimed && value.is_array() {
            if let Some(diagnostics) = self.diagnostics.as_deref_mut() {
                diagnostics.push(Diagnostic::Bytes(super::voiced(
                    self.store.voice(),
                    &format!("warning: {name}: removing nameref attribute\n"),
                )));
            }
        }
        let before = existing
            .as_ref()
            .map_or(0, |var| entry_bytes(&name, var.value.as_ref()));
        self.check(before, entry_bytes(&name, Some(&value)))?;
        self.store.land(&name, value, self.allexport);
        Ok(())
    }

    /// Write one element of the array `name` holds, or clear it with None,
    /// as `set` writes the whole value it makes; `name` is a reference's
    /// target already. The element is shaped by the name's attributes
    /// first, so what an `-i` value assigns lands before it, as bash
    /// evaluates an element in place (`a[0]='a[1]=9,5'` leaves `a[1]` at
    /// 9). It then lands in place, costing the element rather than the
    /// array.
    fn set_element(
        &mut self,
        name: &str,
        slot: Slot,
        text: Option<Vec<u8>>,
        added: Option<&[u8]>,
    ) -> Result<(), Fault> {
        self.writable(name)?;
        let none = || Fault::Host("an element of no array");
        let attrs = self.store.record(name).ok_or_else(none)?.attrs;
        let text = match text {
            Some(text) => {
                let mut coercion = Coercion::default();
                let shaped = self.store.coerce_text(&mut coercion, text, attrs, added);
                self.land_coercion(&mut coercion)?;
                Some(shaped.map_err(|error| fatal(self.store.voice(), error))?)
            }
            None => None,
        };
        if let Some(text) = &text {
            let old = self
                .store
                .element(name, &slot)
                .map_or(0, |old| slot.bytes(old));
            let new = slot.bytes(text);
            if !self.fits(old, new) {
                return Err(self.exhausted(self.entry(name) + new - old));
            }
        }
        if !self.store.put_element(name, &slot, text, self.allexport) {
            return Err(none());
        }
        Ok(())
    }

    /// Append `words` at the extent of the indexed array `name` holds
    /// (`a+=(x y)`): each lands in place as `set_element` writes it, as
    /// bash's do, so an `-i` word's own write to the array stands
    /// (`b+=(2 'b[1]=9,1')` leaves `b[1]` at 9). A word refused takes back
    /// the slots the append filled before it, but under `-i`, where the
    /// words before it are evaluated and may write the array, the array
    /// stays as they left it, as bash's does.
    pub fn push(&mut self, name: &str, words: Vec<Vec<u8>>) -> Result<(), Fault> {
        let name = self.store.target(name);
        self.writable(&name)?;
        let Some(var) = self.store.record(&name) else {
            return Err(Fault::Host("no array to append to"));
        };
        let integer = var.has(INTEGER);
        let marks = (var.attrs, var.managed.clone());
        let Some(Value::Indexed(array)) = &var.value else {
            return Err(Fault::Host("no array to append to"));
        };
        let slots = words
            .into_iter()
            .zip(array.extent()..)
            .map(|(word, index)| {
                i64::try_from(index)
                    .map(|index| (index, word))
                    .map_err(|_| Fault::Host("an index past the largest"))
            })
            .collect::<Result<Vec<_>, Fault>>()?;
        if slots.is_empty() {
            let assigned = Assigned::Indexes(HashSet::new());
            let array = Value::Indexed(array.clone());
            return self.set(&name, array, false, Some(&assigned), None);
        }
        let mut filled = Vec::new();
        for (index, word) in slots {
            let slot = Slot::Index(index);
            if let Err(fault) = self.set_element(&name, slot.clone(), Some(word), None) {
                if !integer {
                    for slot in filled.into_iter().rev() {
                        self.store.put_element(&name, &slot, None, false);
                    }
                    let (attrs, managed) = marks;
                    let changed = self
                        .store
                        .record(&name)
                        .filter(|var| var.attrs != attrs || var.managed != managed);
                    if let Some(var) = changed {
                        let mut var = var.clone();
                        (var.attrs, var.managed) = (attrs, managed);
                        self.store.place(&name, Some(Arc::new(var)));
                    }
                }
                return Err(fault);
            }
            filled.push(slot);
        }
        Ok(())
    }

    /// Clear one element a builtin names (`unset 'a[i]'`), keeping the
    /// indexes after it, as one write. An associative subscript is the key
    /// verbatim, and a key not there clears nothing; an indexed one is
    /// arithmetic, its writes landed first; a scalar's element 0 is the
    /// whole scalar. A hidden or unset name clears nothing, quietly, and a
    /// protected one is refused. An
    /// array the shell computes (`PIPESTATUS`, `FUNCNAME`) clears nothing
    /// whatever a write left on its name, as a read answers from it, but
    /// its subscript is still read, so its writes land and an index before
    /// the first refuses. `every` for a subscript typed as `@` or `*`,
    /// which names every element, never one only expanding to it: an
    /// indexed array is emptied, its marks kept, a scalar refuses as `x[1]`
    /// does, and an associative one takes it as the key it spells, as
    /// bash's does.
    pub fn unset_element(
        &mut self,
        name: &str,
        subscript: &[u8],
        every: bool,
    ) -> Result<Element, Fault> {
        let name = self.store.target(name);
        if self.store.hidden(&name) {
            return Ok(Element::Landed);
        }
        self.permitted(&name)?;
        if let Some(array) = self.store.special(&name) {
            if every {
                return Ok(Element::Landed);
            }
            let index = array.back(self.subscript_index(subscript)?);
            return Ok(if index < 0 {
                Element::Subscript
            } else {
                Element::Landed
            });
        }
        match self.store.record(&name).and_then(|var| var.value.as_ref()) {
            Some(Value::Indexed(array)) if every => {
                // An empty array stays as it was declared, and clearing one
                // marks nothing for export under `set -a`.
                if !array.is_empty() {
                    let empty = Value::Indexed(Indexed::default());
                    let assigned = Assigned::Indexes(HashSet::new());
                    let allexport = std::mem::replace(&mut self.allexport, false);
                    let cleared = self.set(&name, empty, false, Some(&assigned), None);
                    self.allexport = allexport;
                    cleared?;
                }
                return Ok(Element::Landed);
            }
            Some(Value::Scalar(_)) if every => return Ok(Element::NotArray),
            _ => {}
        }
        let slot = match self.store.record(&name).and_then(|var| var.value.as_ref()) {
            Some(Value::Assoc(map)) if map.get(subscript).is_none() => {
                return Ok(Element::Landed);
            }
            Some(Value::Assoc(_)) => Slot::Key(subscript.to_vec()),
            Some(Value::Indexed(_)) => {
                let index = self.subscript_index(subscript)?;
                let index = self
                    .store
                    .indexed(&name)
                    .map_or(index, |array| array.back(index));
                if index < 0 {
                    return Ok(Element::Subscript);
                }
                Slot::Index(index)
            }
            Some(Value::Scalar(_)) => {
                if self.subscript_index(subscript)? != 0 {
                    return Ok(Element::NotArray);
                }
                self.unset(&name, false)?;
                return Ok(Element::Landed);
            }
            None => return Ok(Element::Landed),
        };
        self.set_element(&name, slot, None, None)?;
        Ok(Element::Landed)
    }

    /// Drop one variable; a missing or hidden name is quiet, as bash's
    /// unset of a missing name is, and a protected one is refused.
    pub fn unset(&mut self, name: &str, follow_ref: bool) -> Result<(), Fault> {
        let name = self.aim(name, follow_ref);
        if self.store.hidden(&name) {
            return Ok(());
        }
        self.writable(&name)?;
        self.store.drop_var(&name);
        Ok(())
    }

    /// Turn one attribute on or off, or with None only declare the name:
    /// the no-value writer beside `set`, since `export Z` on a fresh name
    /// leaves it unset, not empty. `-n` itself marks the reference's own
    /// record.
    pub fn mark(
        &mut self,
        name: &str,
        attr: Option<u8>,
        on: bool,
        follow_ref: bool,
    ) -> Result<(), Fault> {
        let name = self.aim(name, follow_ref && attr != Some(NAMEREF));
        self.permitted(&name)?;
        if self.store.record(&name).is_none() {
            self.check(0, entry_bytes(&name, None))?;
        }
        self.store.set_attr(&name, attr, on);
        Ok(())
    }

    /// Land an evaluation's assignments in order, each as the whole
    /// variable it makes (`land_element`): through a reference on its
    /// target, a bare name over an array at element 0 (`A=(old keep);
    /// n='A=9'` keeps `keep`), naming the element so an `-i` array never
    /// evaluates its others again. A readonly name ends the shell in both
    /// contexts that make them, a subscript and an `-i` value.
    fn land_writes(&mut self, writes: Vec<arith::Write>) -> Result<(), Fault> {
        for write in writes {
            match self.land_element(&write.name, write.key, write.value.into_bytes()) {
                Err(Fault::Readonly { name, .. }) => {
                    return Err(Signal::readonly(self.store.voice(), &name, true).into());
                }
                landed => landed?,
            }
        }
        Ok(())
    }

    /// Land one assignment as the whole variable it makes: an element
    /// write for a key, and a bare name over an array at element 0.
    pub fn land_element(
        &mut self,
        name: &str,
        key: Option<Vec<u8>>,
        text: Vec<u8>,
    ) -> Result<(), Fault> {
        let name = self.store.target(name);
        let index = |key: Option<&[u8]>| key.and_then(parse_decimal).unwrap_or(0);
        match self.store.record(&name).and_then(|var| var.value.as_ref()) {
            Some(Value::Assoc(_)) => {
                let key = key.unwrap_or_else(|| b"0".to_vec());
                self.set_element(&name, Slot::Key(key), Some(text), None)
            }
            Some(Value::Indexed(_)) => {
                let slot = Slot::Index(index(key.as_deref()));
                self.set_element(&name, slot, Some(text), None)
            }
            _ if key.is_some() => {
                let index = index(key.as_deref());
                let mut array = Indexed::dense(
                    self.store
                        .conversion_scalar(&name)
                        .map_err(|error| fatal(self.store.voice(), error))?,
                );
                array.set(index, text);
                let assigned = Assigned::Indexes(HashSet::from([index]));
                self.set(&name, Value::Indexed(array), true, Some(&assigned), None)
            }
            _ => self.set(&name, Value::Scalar(text), true, None, None),
        }
    }

    /// Land what a coercion assigned, in the scope it read (inside a
    /// `declare -g`, the function's), then replay its `RANDOM` draws.
    fn land_coercion(&mut self, coercion: &mut Coercion) -> Result<(), Fault> {
        let globals = self.store.step_back();
        let landed = self.land_writes(std::mem::take(&mut coercion.writes));
        self.store.step_forward(globals);
        landed?;
        self.settle(&mut coercion.draws)
    }

    /// Replay an evaluation's `RANDOM` draws; a seed that does not
    /// evaluate stops the line as a coercion's error does.
    fn settle(&mut self, draws: &mut Draws) -> Result<(), Fault> {
        self.store
            .settle(draws)
            .map_err(|error| fatal(self.store.voice(), error))
    }

    /// An indexed subscript resolved outside arithmetic (`${a[i]}`,
    /// `a[i]=v`, `unset 'a[i]'`): it may assign (`a[x=3]`) and seed, and
    /// those land before the index is used; one that fails lands what it
    /// assigned first, then stops the line.
    pub fn subscript_index(&mut self, subscript: &[u8]) -> Result<i64, Fault> {
        if let Some(index) = plain_decimal(subscript) {
            return Ok(index);
        }
        let mut draws = Draws::default();
        let outcome = self
            .store
            .arith(&mut draws, subscript, None, self.nounset, false);
        let (index, error) = match outcome.value {
            Ok(index) => (index, None),
            Err(error) => (0, Some(error)),
        };
        self.land_writes(outcome.writes)?;
        self.settle(&mut draws)?;
        match error {
            None => Ok(index),
            Some(arith::Error::Arith {
                reason,
                expression,
                token,
                ..
            }) => Err(Fault::Arith(arith::Error::Arith {
                reason,
                expression,
                token,
                subscript: true,
            })),
            Some(error) => Err(fatal(self.store.voice(), error)),
        }
    }

    /// Whether a `name` / `name[sub]` reference names a set value, which
    /// `test -v` asks. A bare name over an array asks after element 0 (an
    /// associative one's key `0`), `name[@]` and `name[*]` whether any
    /// element is set. An associative subscript is the key as typed, one
    /// quote pair removed, or verbatim once `expanded`; an indexed one is
    /// arithmetic, evaluated even on an unset name, whose writes land
    /// (`[[ -v a[x=2] ]]` leaves x at 2).
    /// `array` is the indexed array the name reads as, `PIPESTATUS` and
    /// `FUNCNAME` included.
    pub fn is_set(
        &mut self,
        reference: &[u8],
        array: Option<Indexed>,
        expanded: bool,
    ) -> Result<bool, Fault> {
        let Some((name, subscript)) = element_reference(reference) else {
            return Ok(false);
        };
        let assoc = self.store.assoc(name);
        let scalar = self.store.scalar(name).is_some();
        match subscript {
            None | Some(b"@" | b"*") => {
                let any = subscript.is_some();
                return Ok(match (assoc, &array) {
                    (Some(map), _) if any => !map.is_empty(),
                    (Some(map), _) => map.get(b"0").is_some(),
                    (None, Some(array)) if any => !array.is_empty(),
                    (None, Some(array)) => array.get(0).is_some(),
                    (None, None) => scalar,
                });
            }
            Some(key) if assoc.is_some() => {
                let key = if expanded { key } else { strip_key_quotes(key) };
                return Ok(assoc.is_some_and(|map| map.get(key).is_some()));
            }
            Some(_) => {}
        }
        let index = self.subscript_index(subscript.unwrap_or_default())?;
        let held = match array {
            Some(array) => array,
            None if scalar => Indexed::dense([Vec::new()]),
            None => return Ok(false),
        };
        Ok(held.get(held.back(index)).is_some())
    }

    /// Write one element (`a[k]=v`, `read 'a[k]'`, `printf -v 'a[k]'`),
    /// or a bare name as element 0 of an array and a scalar otherwise,
    /// `append` concatenating onto what it holds, or adding under `-i`.
    /// An associative subscript is the key verbatim, an indexed one
    /// arithmetic whose writes land first, even on a readonly name, as
    /// bash's `read 'a[x=3]'` leaves x at 3. A name hidden, protected,
    /// readonly or given a subscript that names no element comes back as
    /// its [`Element`] for the caller to voice.
    pub fn element(
        &mut self,
        name: &str,
        subscript: Option<&[u8]>,
        value: &[u8],
        append: bool,
    ) -> Result<Element, Fault> {
        let name = self.store.target(name);
        if self.denied(&name) {
            return Ok(Element::Denied);
        }
        // An existing scalar becomes element 0, even when empty: bash
        // resolves `x[-1]` against the length-1 array that makes, and a
        // name with no record against the one the shell computes
        // (`PIPESTATUS[-1]=0`).
        let mut converted = None;
        let slot = match self.store.record(&name).and_then(|var| var.value.as_ref()) {
            Some(Value::Assoc(_)) => match subscript.unwrap_or(b"0") {
                [] => return Ok(Element::Subscript),
                key => Some(Slot::Key(key.to_vec())),
            },
            Some(Value::Scalar(_)) | None if subscript.is_none() => None,
            held => {
                if !matches!(held, Some(Value::Indexed(_))) {
                    let special = held.is_none().then(|| self.store.special(&name)).flatten();
                    converted = Some(match special {
                        Some(array) => array,
                        None => Indexed::dense(
                            self.store.conversion_scalar(&name).map_err(Fault::Arith)?,
                        ),
                    });
                }
                let index = match subscript {
                    Some(subscript) => self.subscript_index(subscript)?,
                    None => 0,
                };
                let index = match (&converted, self.store.indexed(&name)) {
                    (Some(array), _) | (None, Some(array)) => array.back(index),
                    (None, None) => index,
                };
                if index < 0 {
                    return Ok(Element::Subscript);
                }
                Some(Slot::Index(index))
            }
        };
        if self.store.is_readonly(&name, false) {
            return Ok(Element::Readonly);
        }
        let held = match (&slot, &converted) {
            (None, _) => self
                .store
                .record(&name)
                .and_then(|var| var.value.as_ref())
                .and_then(|value| match value {
                    Value::Scalar(text) => Some(text.as_slice()),
                    _ => None,
                }),
            (Some(Slot::Index(index)), Some(array)) => array.get(*index),
            (Some(slot), _) => self.store.element(&name, slot),
        };
        let integer = self.store.record(&name).is_some_and(|var| var.has(INTEGER));
        let (text, added) = match (append, integer) {
            (false, _) => (value.to_vec(), None),
            (true, true) => (held.unwrap_or_default().to_vec(), Some(value)),
            (true, false) => ([held.unwrap_or_default(), value].concat(), None),
        };
        match (slot, converted) {
            (None, _) => self.set(&name, Value::Scalar(text), true, None, added)?,
            (Some(Slot::Index(index)), Some(mut array)) => {
                array.set(index, text);
                let assigned = Assigned::Indexes(HashSet::from([index]));
                self.set(&name, Value::Indexed(array), true, Some(&assigned), added)?;
            }
            (Some(slot), _) => self.set_element(&name, slot, Some(text), added)?,
        }
        Ok(Element::Landed)
    }

    /// An arithmetic command (`(( ))`, `let`, `for ((;;))`): evaluated,
    /// its writes landed in order, a hidden or protected name refusing and
    /// the writes
    /// after it never landing, as a readonly name stops the evaluation
    /// itself (`let 'X=5, R=3'` leaves X at 5). The draws settle either
    /// way, and an unset name under `set -u` stops the line only after the
    /// writes before it. An error comes back unworded, for the command to
    /// voice. `expand` for a `let` operand, whose subscripts expand first.
    pub fn arith(&mut self, text: &[u8], expand: bool) -> Result<i64, Fault> {
        let mut draws = Draws::default();
        let outcome = self
            .store
            .arith(&mut draws, text, None, self.nounset, expand);
        let value = outcome.value;
        let mut landed = Ok(());
        for write in outcome.writes {
            if self.denied(&self.store.target(&write.name)) {
                landed = Err(Fault::Denied(write.name));
                break;
            }
            match self.land_element(&write.name, write.key, write.value.into_bytes()) {
                Ok(()) | Err(Fault::Readonly { .. }) => {}
                Err(fault) => {
                    landed = Err(fault);
                    break;
                }
            }
        }
        self.settle(&mut draws)?;
        landed?;
        value.map_err(|error| match error {
            arith::Error::Unbound(name) => Signal::unbound(self.store.voice(), &name).into(),
            arith::Error::Readonly { name, subscript } => Fault::Readonly { name, subscript },
            error => Fault::Arith(error),
        })
    }

    /// Evaluate `text` as an `-i` write would, landing what it assigns: a
    /// `declare -ni r=M` value, evaluated before the reference refuses it.
    pub fn evaluate_integer(
        &mut self,
        text: &[u8],
        added: Option<&[u8]>,
    ) -> Result<Vec<u8>, Fault> {
        let mut coercion = Coercion::default();
        let value = self.store.evaluate_integer(&mut coercion, text, added);
        self.land_coercion(&mut coercion)?;
        value.map_err(|error| fatal(self.store.voice(), error))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::vars::{EXPORT, RANDOM, READONLY, UNASSIGNED};

    fn writer(store: &mut Store) -> Writer<'_> {
        Writer {
            store,
            allexport: false,
            nounset: false,
            diagnostics: None,
            limit: None,
            outside: 0,
        }
    }

    fn text(store: &Store, name: &str) -> Option<String> {
        store
            .scalar(name)
            .map(|t| String::from_utf8_lossy(t).into_owned())
    }

    fn scalar(text: &str) -> Value {
        Value::Scalar(text.as_bytes().to_vec())
    }

    #[test]
    fn integer_writes_land_before_their_value() {
        let mut store = Store::new(Arc::new(|| 1));
        store.set_attr("n", Some(INTEGER), true);
        writer(&mut store)
            .set("n", scalar("x=5, x+1"), true, None, None)
            .unwrap();
        assert_eq!(text(&store, "x").as_deref(), Some("5"));
        assert_eq!(text(&store, "n").as_deref(), Some("6"));
    }

    #[test]
    fn a_protected_name_reads_and_refuses_every_write() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("TOKEN", scalar("op"));
        store.seed("a", Value::Indexed(Indexed::dense([b"1".to_vec()])));
        store.protect_vars(&["TOKEN".to_owned()], &["a*".to_owned()]);
        let mut writer = writer(&mut store);
        let denied = |fault| matches!(fault, Err(Fault::Denied(name)) if name == "TOKEN");
        assert!(denied(writer.set("TOKEN", scalar("x"), true, None, None)));
        assert!(denied(writer.unset("TOKEN", true)));
        assert!(denied(writer.mark("TOKEN", Some(EXPORT), true, true)));
        assert!(matches!(
            writer.arith(b"TOKEN=1", false),
            Err(Fault::Denied(_))
        ));
        assert_eq!(
            writer.element("a", Some(b"1"), b"2", false).unwrap(),
            Element::Denied
        );
        assert!(matches!(
            writer.push("a", vec![b"2".to_vec()]),
            Err(Fault::Denied(_))
        ));
        assert!(matches!(
            writer.unset_element("a", b"0", false),
            Err(Fault::Denied(_))
        ));
        assert_eq!(text(writer.store, "TOKEN").as_deref(), Some("op"));
        assert_eq!(writer.store.indexed("a").unwrap().count(), 1);
    }

    #[test]
    fn readonly_and_hidden_names_refuse() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("R", scalar("1"));
        store.set_attr("R", Some(READONLY), true);
        let refused = writer(&mut store).set("R", scalar("2"), true, None, None);
        assert!(matches!(refused, Err(Fault::Readonly { .. })));
        store.set_attr("n", Some(INTEGER), true);
        let fatal = writer(&mut store).set("n", scalar("R=3"), true, None, None);
        match fatal {
            Err(Fault::Signal(Signal::Exit { status, stderr, .. })) => {
                assert_eq!(status, 1);
                assert_eq!(stderr, b"bash: R: readonly variable\n");
            }
            other => panic!("expected the shell to end, got {other:?}"),
        }
    }

    #[test]
    fn a_seed_restarts_the_generator() {
        let mut store = Store::new(Arc::new(|| 1));
        writer(&mut store)
            .set(RANDOM, scalar("42"), true, None, None)
            .unwrap();
        assert_eq!(store.next_random().unwrap(), Some(17772));
    }

    #[test]
    fn an_element_seeding_random_lands_what_it_assigns() {
        let mut store = Store::new(Arc::new(|| 1));
        let seeded = Value::Indexed(Indexed::dense([b"x=1+2".to_vec()]));
        writer(&mut store)
            .set(RANDOM, seeded, true, None, None)
            .unwrap();
        assert_eq!(text(&store, "x").as_deref(), Some("3"));
        assert_eq!(store.indexed(RANDOM).unwrap().get(0), Some(&b"3"[..]));
    }

    #[test]
    fn a_bare_name_over_an_array_assigns_element_zero() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed(
            "A",
            Value::Indexed(Indexed::dense([b"old".to_vec(), b"keep".to_vec()])),
        );
        store.set_attr("n", Some(INTEGER), true);
        writer(&mut store)
            .set("n", scalar("A=9"), true, None, None)
            .unwrap();
        let array = store.indexed("A").unwrap();
        assert_eq!(array.get(0), Some(&b"9"[..]));
        assert_eq!(array.get(1), Some(&b"keep"[..]));
    }

    #[test]
    fn a_subscript_lands_what_it_assigns() {
        let mut store = Store::new(Arc::new(|| 1));
        let index = writer(&mut store).subscript_index(b"x=3").unwrap();
        assert_eq!(index, 3);
        assert_eq!(text(&store, "x").as_deref(), Some("3"));
        let failed = writer(&mut store).subscript_index(b"y=2, 1/0");
        assert!(matches!(failed, Err(Fault::Arith(_))));
        assert_eq!(text(&store, "y").as_deref(), Some("2"));
        let mut strict = writer(&mut store);
        strict.nounset = true;
        let failed = strict.subscript_index(b"z=4, nope");
        assert!(matches!(failed, Err(Fault::Signal(_))));
        let mut strict = writer(&mut store);
        strict.nounset = true;
        let failed = strict.arith(b"w=5, nope", false);
        assert!(matches!(failed, Err(Fault::Signal(_))));
        assert_eq!(text(&store, "z").as_deref(), Some("4"));
        assert_eq!(text(&store, "w").as_deref(), Some("5"));
    }

    #[test]
    fn a_write_past_max_env_ends_the_shell() {
        let mut store = Store::new(Arc::new(|| 1));
        let mut writer = writer(&mut store);
        writer.limit = Some(8);
        writer.set("AB", scalar("xyz"), true, None, None).unwrap();
        match writer.set("CD", scalar("long"), true, None, None) {
            Err(Fault::Signal(Signal::Exit { status, .. })) => assert_eq!(status, 2),
            other => panic!("expected max_env to refuse, got {other:?}"),
        }
        writer.set("AB", scalar("x"), true, None, None).unwrap();
    }

    #[test]
    fn a_reference_is_set_as_test_v_reads_it() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("s", scalar("v"));
        let map = [(b"a".to_vec(), b"1".to_vec())].into_iter().collect();
        store.seed("m", Value::Assoc(Box::new(map)));
        let mut writer = writer(&mut store);
        let arr = || Some(Indexed::dense([b"p".to_vec(), b"q".to_vec()]));
        assert!(writer.is_set(b"s", None, false).unwrap());
        assert!(writer.is_set(b"s[0]", None, false).unwrap());
        assert!(!writer.is_set(b"s[1]", None, false).unwrap());
        assert!(writer.is_set(b"m[\"a\"]", None, false).unwrap());
        assert!(!writer.is_set(b"m[\"a\"]", None, true).unwrap());
        assert!(writer.is_set(b"m[a]", None, true).unwrap());
        assert!(!writer.is_set(b"m[1+1]", None, false).unwrap());
        assert!(writer.is_set(b"m[@]", None, false).unwrap());
        assert!(writer.is_set(b"arr[-1]", arr(), false).unwrap());
        assert!(!writer.is_set(b"arr[x=2]", arr(), false).unwrap());
        assert_eq!(text(writer.store, "x").as_deref(), Some("2"));
        assert!(!writer.is_set(b"1x", None, false).unwrap());
        assert!(!writer.is_set(b"m[]", None, false).unwrap());
    }

    #[test]
    fn an_element_write_lands_the_whole_value() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("s", scalar("v"));
        store.seed("R", scalar("1"));
        store.set_attr("R", Some(READONLY), true);
        let map = [(b"a".to_vec(), b"1".to_vec())].into_iter().collect();
        store.seed("m", Value::Assoc(Box::new(map)));
        let mut writer = writer(&mut store);
        let landed = writer.element("m", Some(b"a"), b"2", true).unwrap();
        assert_eq!(landed, Element::Landed);
        assert_eq!(writer.store.assoc("m").unwrap().get(b"a"), Some(&b"12"[..]));
        writer.element("s", Some(b"2"), b"w", false).unwrap();
        let array = writer.store.indexed("s").unwrap();
        assert_eq!(
            (array.get(0), array.get(2)),
            (Some(&b"v"[..]), Some(&b"w"[..]))
        );
        writer.element("s", Some(b"-1"), b"!", true).unwrap();
        assert_eq!(writer.store.indexed("s").unwrap().get(2), Some(&b"w!"[..]));
        writer.element("t", None, b"x", true).unwrap();
        assert_eq!(text(writer.store, "t").as_deref(), Some("x"));
        let refused = |w: &mut Writer<'_>, name: &str, sub: &[u8]| {
            w.element(name, Some(sub), b"x", false).unwrap()
        };
        assert_eq!(refused(&mut writer, "R", b"0"), Element::Readonly);
        assert_eq!(refused(&mut writer, "m", b""), Element::Subscript);
        assert_eq!(refused(&mut writer, "s", b"-9"), Element::Subscript);
    }

    #[test]
    fn an_integer_element_keeps_what_its_value_assigned() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("b", Value::Indexed(Indexed::dense([b"1".to_vec()])));
        store.set_attr("b", Some(INTEGER), true);
        let mut writer = writer(&mut store);
        writer
            .push("b", vec![b"2".to_vec(), b"b[1]=9,1".to_vec()])
            .unwrap();
        writer.element("b", Some(b"0"), b"b[2]=7,5", false).unwrap();
        let held: Vec<_> = writer.store.indexed("b").unwrap().iter().collect();
        assert_eq!(held, [(0, &b"5"[..]), (1, &b"9"[..]), (2, &b"7"[..])]);
        let failed = writer.push("b", vec![b"2".to_vec(), b"b[0]=4,1/0".to_vec()]);
        assert!(matches!(failed, Err(Fault::Arith(_))));
        let left: Vec<_> = writer.store.indexed("b").unwrap().iter().collect();
        assert_eq!(
            left,
            [
                (0, &b"4"[..]),
                (1, &b"9"[..]),
                (2, &b"7"[..]),
                (3, &b"2"[..])
            ]
        );
    }

    #[test]
    fn element_writes_land_in_place_as_bash_orders_them() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("a", Value::Indexed(Indexed::dense([b"1".to_vec()])));
        store.seed("i", Value::Indexed(Indexed::dense([b"5".to_vec()])));
        store.set_attr("i", Some(INTEGER), true);
        store.seed("s", scalar("v"));
        let mut writer = writer(&mut store);
        writer
            .push("a", vec![b"2".to_vec(), b"3".to_vec()])
            .unwrap();
        let landed = writer.element("a", Some(b"x=1"), b"!", true).unwrap();
        assert_eq!(landed, Element::Landed);
        assert_eq!(
            writer.unset_element("a", b"0", false).unwrap(),
            Element::Landed
        );
        assert_eq!(
            writer.unset_element("a", b"-9", false).unwrap(),
            Element::Subscript
        );
        let array: Vec<_> = writer.store.indexed("a").unwrap().iter().collect();
        assert_eq!(array, [(1, &b"2!"[..]), (2, &b"3"[..])]);
        writer.element("i", Some(b"0"), b"3", true).unwrap();
        assert_eq!(writer.store.indexed("i").unwrap().get(0), Some(&b"8"[..]));
        writer.store.set_attr("i", Some(READONLY), true);
        let refused = writer.element("i", Some(b"y=2"), b"0", false).unwrap();
        assert_eq!(refused, Element::Readonly);
        assert_eq!(
            writer.unset_element("s", b"1", false).unwrap(),
            Element::NotArray
        );
        assert_eq!(
            writer.unset_element("s", b"*", true).unwrap(),
            Element::NotArray
        );
        let pair = Indexed::dense([b"x".to_vec(), b"y".to_vec()]);
        writer.store.seed("e", Value::Indexed(pair));
        let expanded = writer.unset_element("e", b"@", false);
        assert!(matches!(expanded, Err(Fault::Arith(_))));
        writer.unset_element("e", b"@", true).unwrap();
        assert_eq!(writer.store.indexed("e").map(Indexed::count), Some(0));
        let keyed = [
            (b"@".to_vec(), b"v".to_vec()),
            (b"k".to_vec(), b"w".to_vec()),
        ];
        writer
            .store
            .seed("q", Value::Assoc(Box::new(keyed.into_iter().collect())));
        writer.unset_element("q", b"@", true).unwrap();
        let left: Vec<_> = writer
            .store
            .assoc("q")
            .unwrap()
            .iter()
            .map(|(k, _)| k.to_vec())
            .collect();
        assert_eq!(left, [b"k".to_vec()]);
        assert_eq!(
            writer.unset_element("s", b"0", false).unwrap(),
            Element::Landed
        );
        assert_eq!(text(writer.store, "s"), None);
        assert_eq!(text(writer.store, "x").as_deref(), Some("1"));
        assert_eq!(text(writer.store, "y").as_deref(), Some("2"));
        writer
            .store
            .set_specials(vec![1], None, Vec::new(), 1, 1, b"bash: ".to_vec());
        let read = writer.unset_element("PIPESTATUS", b"z=4", false).unwrap();
        assert_eq!(read, Element::Landed);
        assert_eq!(text(writer.store, "z").as_deref(), Some("4"));
        let before = writer.unset_element("PIPESTATUS", b"-5", false).unwrap();
        assert_eq!(before, Element::Subscript);
        let every = writer.unset_element("PIPESTATUS", b"@", true).unwrap();
        assert_eq!(every, Element::Landed);
        writer.store.seed("PIPESTATUS", scalar("left"));
        let shadowed = writer.unset_element("PIPESTATUS", b"*", true).unwrap();
        assert_eq!(shadowed, Element::Landed);
        let special = writer
            .element("PIPESTATUS", Some(b"-1"), b"0", false)
            .unwrap();
        assert_eq!(special, Element::Landed);
        writer.limit = Some(writer.store.held() + 4);
        let refused = writer.push("a", vec![b"4".to_vec(), b"far too long".to_vec()]);
        assert!(matches!(
            refused,
            Err(Fault::Signal(Signal::Exit { status: 2, .. }))
        ));
        assert_eq!(writer.store.indexed("a").unwrap().count(), 2);
        writer.store.seed("g", Value::Indexed(Indexed::default()));
        writer.store.set_attr("g", Some(UNASSIGNED), true);
        writer.allexport = true;
        let fresh = writer.push("g", vec![b"1".to_vec(), b"far too long".to_vec()]);
        assert!(fresh.is_err());
        let g = writer.store.record("g").unwrap();
        assert!(g.has(UNASSIGNED) && !g.has(EXPORT));
        writer.allexport = false;
        writer.limit = None;
        writer
            .store
            .seed("n", Value::Indexed(Indexed::dense([b"1".to_vec()])));
        writer.store.set_attr("n", Some(INTEGER), true);
        let failed = writer.push("n", vec![b"2".to_vec(), b"n[1]=2,1/0".to_vec()]);
        assert!(matches!(failed, Err(Fault::Arith(_))));
        let kept: Vec<_> = writer.store.indexed("n").unwrap().iter().collect();
        assert_eq!(kept, [(0, &b"1"[..]), (1, &b"2"[..])]);
        let counted: usize = writer
            .store
            .records()
            .map(|(name, var)| entry_bytes(name, var.value.as_ref()))
            .sum();
        assert_eq!(writer.store.held(), counted);
    }
}
