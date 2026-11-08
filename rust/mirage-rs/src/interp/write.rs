//! The session plane's writes: a variable set, unset or marked through the
//! policy gate, its value shaped by its attributes first, so a rule judges
//! the value that will land (`declare -l p; p=ADMIN` is shown `admin`). A
//! write a policy refuses after it landed is put back, the generator a
//! `RANDOM=` seeded included, so a refusal never leaves a write half done.
//! The assignments an `-i` value or a subscript makes land the same way,
//! each gated, before the write they were made for.

use std::collections::HashSet;
use std::future::Future;

use super::{Diagnostic, Signal};
use crate::arith::{self, plain_decimal};
use crate::vars::{
    Assigned, Coercion, Draws, INTEGER, Indexed, NAMEREF, Slot, Store, Value, entry_bytes,
    strip_key_quotes,
};

/// bash's own exit when it cannot allocate.
const ENV_EXHAUSTED_STATUS: i32 = 2;

/// What a write is to the gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Set,
    Unset,
}

/// A policy refused a write; `record` is the host's own record of the
/// refusal, which it words and reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Denied {
    pub name: String,
    pub record: u32,
}

/// What an element write a builtin asks for comes to, short of a fault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Element {
    Landed,
    Hidden,
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

/// The host's side of a session write: the `pre_session` policy before it
/// lands and `post_session` after, each shown the value rendered, and
/// before both whether any policy listens, so a session none governs pays
/// nothing per write.
pub trait Gate {
    fn listens(&self) -> bool;

    /// `store` is the session as the write finds it, for a policy that
    /// reads it.
    fn pre(
        &mut self,
        verb: Verb,
        key: &str,
        value: Option<&[u8]>,
        store: &Store,
    ) -> impl Future<Output = Result<(), Fault>>;

    fn post(
        &mut self,
        verb: Verb,
        key: &str,
        value: Option<&[u8]>,
        old: Option<&[u8]>,
        store: &Store,
    ) -> impl Future<Output = Result<(), Fault>>;
}

/// Why a write did not land.
#[derive(Debug)]
pub enum Fault {
    /// The name is hidden for this session: EACCES, the variables twin of
    /// a create into hidden path space.
    Hidden(String),
    Denied(Denied),
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
pub struct Writer<'a, G: Gate> {
    pub store: &'a mut Store,
    pub gate: &'a mut G,
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

impl<G: Gate> Writer<'_, G> {
    fn visible(&self, name: &str) -> Result<(), Fault> {
        if self.store.hidden(name) {
            return Err(Fault::Hidden(name.to_owned()));
        }
        Ok(())
    }

    /// Refuse a write to a hidden or readonly name.
    fn writable(&self, name: &str) -> Result<(), Fault> {
        self.visible(name)?;
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

    /// Write one variable through the gate: a reference's target unless
    /// `follow_ref` is off (`declare -n r=w` re-aims `r`), refused when
    /// hidden or readonly, its value shaped by the name's attributes
    /// (`assigned` naming the elements an array write assigns, `added` an
    /// integer `+=`'s text, evaluated after the held one), a `RANDOM=`
    /// seeding the generator.
    pub async fn set(
        &mut self,
        name: &str,
        value: Value,
        follow_ref: bool,
        assigned: Option<&Assigned>,
        added: Option<&[u8]>,
    ) -> Result<(), Fault> {
        let name = if follow_ref {
            self.store.target(name)
        } else {
            name.to_owned()
        };
        self.writable(&name)?;
        // A scalar landing on an array is its element 0, the key `0` in an
        // associative one, as bash binds `read a` or `for a in x` there.
        let value = match (
            value,
            self.store.record(&name).and_then(|var| var.value.as_ref()),
        ) {
            (Value::Scalar(text), Some(Value::Indexed(_))) => {
                return self
                    .set_element(&name, Slot::Index(0), Some(text), added)
                    .await;
            }
            (Value::Scalar(text), Some(Value::Assoc(_))) => {
                let slot = Slot::Key(b"0".to_vec());
                return self.set_element(&name, slot, Some(text), added).await;
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
                    self.land_coercion(&mut coercion).await?;
                    return Err(fatal(self.store.voice(), error));
                }
            }
        }
        let rendering = self.gate.listens().then(|| value.rendering());
        if let Some(rendering) = &rendering {
            self.gate
                .pre(Verb::Set, &name, Some(rendering), self.store)
                .await?;
        }
        let generator = self.store.generator();
        let seeding = match &value {
            Value::Scalar(word) if self.store.seeds_random(&name) => Some(word),
            _ => None,
        };
        if let Some(word) = seeding {
            match self.store.evaluate_integer(&mut coercion, word, None) {
                Ok(text) => {
                    let state = std::str::from_utf8(&text)
                        .ok()
                        .and_then(|text| text.parse::<i64>().ok())
                        .unwrap_or(0)
                        .rem_euclid(1 << 32) as u32;
                    self.store.seed_random(word.clone(), state);
                }
                Err(error) => {
                    self.land_coercion(&mut coercion).await?;
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
        self.land_coercion(&mut coercion).await?;
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
        let old = self.store.land(&name, value, self.allexport);
        if let Some(rendering) = &rendering {
            let old_rendering = old
                .as_ref()
                .and_then(|var| var.value.as_ref())
                .map(Value::rendering);
            if let Err(fault) = self
                .gate
                .post(
                    Verb::Set,
                    &name,
                    Some(rendering),
                    old_rendering.as_deref(),
                    self.store,
                )
                .await
            {
                self.store.place(&name, old);
                self.store.set_generator(generator);
                return Err(fault);
            }
        }
        Ok(())
    }

    /// Write one element of the array `name` holds, or clear it with None,
    /// as `set` writes the whole value it makes; `name` is a reference's
    /// target already. With no policy listening it lands in place, shaped
    /// by the name's attributes, so a write costs the element rather than
    /// the array; a listening policy is shown the whole value, which then
    /// lands through `set`.
    async fn set_element(
        &mut self,
        name: &str,
        slot: Slot,
        text: Option<Vec<u8>>,
        added: Option<&[u8]>,
    ) -> Result<(), Fault> {
        self.writable(name)?;
        let none = || Fault::Host("an element of no array");
        let var = self.store.record(name).ok_or_else(none)?;
        if self.gate.listens() {
            let assigned = slot.assigned(text.is_some());
            let mut value = var.value.clone().ok_or_else(none)?;
            value.put(&slot, text).ok_or_else(none)?;
            return Box::pin(self.set(name, value, false, Some(&assigned), added)).await;
        }
        let attrs = var.attrs;
        let text = match text {
            Some(text) => {
                let mut coercion = Coercion::default();
                let shaped = self.store.coerce_text(&mut coercion, text, attrs, added);
                self.land_coercion(&mut coercion).await?;
                let text = shaped.map_err(|error| fatal(self.store.voice(), error))?;
                let old = self
                    .store
                    .element(name, &slot)
                    .map_or(0, |old| slot.bytes(old));
                let new = slot.bytes(&text);
                if !self.fits(old, new) {
                    return Err(self.exhausted(self.entry(name) + new - old));
                }
                Some(text)
            }
            None => None,
        };
        if !self.store.put_element(name, &slot, text, self.allexport) {
            return Err(none());
        }
        Ok(())
    }

    /// Append `words` at the extent of the indexed array `name` holds
    /// (`a+=(x y)`): each lands in place as `set_element` writes it, as
    /// bash's do, so an `-i` word's own write to the array stands
    /// (`b+=(2 'b[1]=9,1')` leaves `b[1]` at 9). A word refused takes back
    /// what the append stored before it, each slot that still holds it.
    /// With a policy listening, the whole value lands through `set` as one
    /// write.
    pub async fn push(&mut self, name: &str, words: Vec<Vec<u8>>) -> Result<(), Fault> {
        let name = self.store.target(name);
        self.writable(&name)?;
        let Some(Value::Indexed(array)) =
            self.store.record(&name).and_then(|var| var.value.as_ref())
        else {
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
        if slots.is_empty() || self.gate.listens() {
            let mut array = array.clone();
            let assigned = Assigned::Indexes(slots.iter().map(|(index, _)| *index).collect());
            for (index, word) in slots {
                array.set(index, word);
            }
            return self
                .set(&name, Value::Indexed(array), false, Some(&assigned), None)
                .await;
        }
        let mut stored: Vec<(Slot, Vec<u8>)> = Vec::new();
        for (index, word) in slots {
            let slot = Slot::Index(index);
            if let Err(fault) = self
                .set_element(&name, slot.clone(), Some(word), None)
                .await
            {
                for (slot, text) in stored.into_iter().rev() {
                    if self.store.element(&name, &slot) == Some(&text[..]) {
                        self.store.put_element(&name, &slot, None, false);
                    }
                }
                return Err(fault);
            }
            let text = self
                .store
                .element(&name, &slot)
                .unwrap_or_default()
                .to_vec();
            stored.push((slot, text));
        }
        Ok(())
    }

    /// Clear one element a builtin names (`unset 'a[i]'`), keeping the
    /// indexes after it, as one write. An associative subscript is the key
    /// verbatim, and a key not there clears nothing; an indexed one is
    /// arithmetic, its writes landed first; a scalar's element 0 is the
    /// whole scalar. A hidden or unset name clears nothing, quietly.
    pub async fn unset_element(&mut self, name: &str, subscript: &[u8]) -> Result<Element, Fault> {
        let name = self.store.target(name);
        if self.store.hidden(&name) {
            return Ok(Element::Landed);
        }
        let slot = match self.store.record(&name).and_then(|var| var.value.as_ref()) {
            Some(Value::Assoc(map)) if map.get(subscript).is_none() => {
                return Ok(Element::Landed);
            }
            Some(Value::Assoc(_)) => Slot::Key(subscript.to_vec()),
            Some(Value::Indexed(_)) => {
                let index = self.subscript_index(subscript).await?;
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
                if self.subscript_index(subscript).await? != 0 {
                    return Ok(Element::NotArray);
                }
                self.unset(&name, false).await?;
                return Ok(Element::Landed);
            }
            None => return Ok(Element::Landed),
        };
        self.set_element(&name, slot, None, None).await?;
        Ok(Element::Landed)
    }

    /// Drop one variable through the gate; a missing or hidden name is
    /// quiet, as bash's unset of a missing name is. An unset that revealed
    /// an enclosing scope's value and is then refused gives that value back
    /// to the scope.
    pub async fn unset(&mut self, name: &str, follow_ref: bool) -> Result<(), Fault> {
        let name = if follow_ref {
            self.store.target(name)
        } else {
            name.to_owned()
        };
        if self.store.hidden(&name) {
            return Ok(());
        }
        if self.store.is_readonly(&name, false) {
            return Err(Fault::Readonly {
                name,
                subscript: false,
            });
        }
        if self.gate.listens() {
            self.gate.pre(Verb::Unset, &name, None, self.store).await?;
        }
        let marks = self.store.marks();
        let (old, frame) = self.store.drop_var(&name);
        if self.gate.listens() {
            let old_rendering = old
                .as_ref()
                .and_then(|var| var.value.as_ref())
                .map(Value::rendering);
            if let Err(fault) = self
                .gate
                .post(
                    Verb::Unset,
                    &name,
                    None,
                    old_rendering.as_deref(),
                    self.store,
                )
                .await
            {
                self.store.undrop(&name, old, frame, marks);
                return Err(fault);
            }
        }
        Ok(())
    }

    /// Turn one attribute on or off through the gate, or with None only
    /// declare the name: the no-value writer beside `set`, since
    /// `export Z` on a fresh name leaves it unset, not empty. The gate
    /// sees it with no value, which is how a rule tells a mark from an
    /// assignment. `-n` itself marks the reference's own record.
    pub async fn mark(
        &mut self,
        name: &str,
        attr: Option<u8>,
        on: bool,
        follow_ref: bool,
    ) -> Result<(), Fault> {
        let name = if follow_ref && attr != Some(NAMEREF) {
            self.store.target(name)
        } else {
            name.to_owned()
        };
        self.visible(&name)?;
        if self.gate.listens() {
            self.gate.pre(Verb::Set, &name, None, self.store).await?;
        }
        let old = self.store.share(&name);
        let generator = self.store.generator();
        if old.is_none() {
            self.check(0, entry_bytes(&name, None))?;
        }
        self.store.set_attr(&name, attr, on);
        if self.gate.listens() {
            let old_rendering = old
                .as_ref()
                .and_then(|var| var.value.as_ref())
                .map(Value::rendering);
            if let Err(fault) = self
                .gate
                .post(Verb::Set, &name, None, old_rendering.as_deref(), self.store)
                .await
            {
                self.store.place(&name, old);
                self.store.set_generator(generator);
                return Err(fault);
            }
        }
        Ok(())
    }

    /// Land an evaluation's assignments in order, each as the whole
    /// variable it makes (`land_element`): through a reference on its
    /// target, a bare name over an array at element 0 (`A=(old keep);
    /// n='A=9'` keeps `keep`), naming the element so an `-i` array never
    /// evaluates its others again. A readonly name ends the shell in both
    /// contexts that make them, a subscript and an `-i` value.
    async fn land_writes(&mut self, writes: Vec<arith::Write>) -> Result<(), Fault> {
        for write in writes {
            match self
                .land_element(&write.name, write.key, write.value.into_bytes())
                .await
            {
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
    pub async fn land_element(
        &mut self,
        name: &str,
        key: Option<Vec<u8>>,
        text: Vec<u8>,
    ) -> Result<(), Fault> {
        let name = self.store.target(name);
        let index = |key: Option<&[u8]>| {
            key.and_then(|key| std::str::from_utf8(key).ok())
                .and_then(|key| key.parse().ok())
                .unwrap_or(0)
        };
        match self.store.record(&name).and_then(|var| var.value.as_ref()) {
            Some(Value::Assoc(_)) => {
                let key = key.unwrap_or_else(|| b"0".to_vec());
                Box::pin(self.set_element(&name, Slot::Key(key), Some(text), None)).await
            }
            Some(Value::Indexed(_)) => {
                let slot = Slot::Index(index(key.as_deref()));
                Box::pin(self.set_element(&name, slot, Some(text), None)).await
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
                Box::pin(self.set(&name, Value::Indexed(array), true, Some(&assigned), None)).await
            }
            _ => Box::pin(self.set(&name, Value::Scalar(text), true, None, None)).await,
        }
    }

    /// Land what a coercion assigned, in the scope it read (inside a
    /// `declare -g`, the function's), then replay its `RANDOM` draws.
    async fn land_coercion(&mut self, coercion: &mut Coercion) -> Result<(), Fault> {
        let globals = self.store.step_back();
        let landed = self.land_writes(std::mem::take(&mut coercion.writes)).await;
        self.store.step_forward(globals);
        landed?;
        self.store
            .settle(&mut coercion.draws)
            .map_err(|error| fatal(self.store.voice(), error))
    }

    /// An indexed subscript resolved outside arithmetic (`${a[i]}`,
    /// `a[i]=v`, `unset 'a[i]'`): it may assign (`a[x=3]`) and seed, and
    /// those land before the index is used; one that fails lands what it
    /// assigned first, then stops the line.
    pub async fn subscript_index(&mut self, subscript: &[u8]) -> Result<i64, Fault> {
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
        self.land_writes(outcome.writes).await?;
        self.store
            .settle(&mut draws)
            .map_err(|error| fatal(self.store.voice(), error))?;
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
    pub async fn is_set(
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
        let index = self.subscript_index(subscript.unwrap_or_default()).await?;
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
    /// It lands as one write of the whole value it makes, so a rule sees
    /// `a[k]=v` as a write to `a` and a refusal leaves nothing half done.
    /// An associative subscript is the key verbatim, an indexed one
    /// arithmetic whose writes land first, even on a readonly name, as
    /// bash's `read 'a[x=3]'` leaves x at 3. A name hidden, readonly or
    /// given a subscript that names no element comes back as its
    /// [`Element`] for the caller to voice.
    pub async fn element(
        &mut self,
        name: &str,
        subscript: Option<&[u8]>,
        value: &[u8],
        append: bool,
    ) -> Result<Element, Fault> {
        let name = self.store.target(name);
        if self.store.hidden(&name) {
            return Ok(Element::Hidden);
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
                    Some(subscript) => self.subscript_index(subscript).await?,
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
            (None, _) => {
                self.set(&name, Value::Scalar(text), true, None, added)
                    .await?
            }
            (Some(Slot::Index(index)), Some(mut array)) => {
                array.set(index, text);
                let assigned = Assigned::Indexes(HashSet::from([index]));
                self.set(&name, Value::Indexed(array), true, Some(&assigned), added)
                    .await?;
            }
            (Some(slot), _) => self.set_element(&name, slot, Some(text), added).await?,
        }
        Ok(Element::Landed)
    }

    /// An arithmetic command (`(( ))`, `let`, `for ((;;))`): evaluated,
    /// its writes landed in order, a hidden name refusing and the writes
    /// after it never landing, as a readonly name stops the evaluation
    /// itself (`let 'X=5, R=3'` leaves X at 5). The draws settle either
    /// way, and an unset name under `set -u` stops the line only after the
    /// writes before it. An error comes back unworded, for the command to
    /// voice. `expand` for a `let` operand, whose subscripts expand first.
    pub async fn arith(&mut self, text: &[u8], expand: bool) -> Result<i64, Fault> {
        let mut draws = Draws::default();
        let outcome = self
            .store
            .arith(&mut draws, text, None, self.nounset, expand);
        let value = outcome.value;
        let mut landed = Ok(());
        for write in outcome.writes {
            if self.store.hidden(&self.store.target(&write.name)) {
                landed = Err(Fault::Hidden(write.name));
                break;
            }
            match self
                .land_element(&write.name, write.key, write.value.into_bytes())
                .await
            {
                Ok(()) | Err(Fault::Readonly { .. }) => {}
                Err(fault) => {
                    landed = Err(fault);
                    break;
                }
            }
        }
        self.store
            .settle(&mut draws)
            .map_err(|error| fatal(self.store.voice(), error))?;
        landed?;
        value.map_err(|error| match error {
            arith::Error::Unbound(name) => Signal::unbound(self.store.voice(), &name).into(),
            arith::Error::Readonly { name, subscript } => Fault::Readonly { name, subscript },
            error => Fault::Arith(error),
        })
    }

    /// Evaluate `text` as an `-i` write would, landing what it assigns: a
    /// `declare -ni r=M` value, evaluated before the reference refuses it.
    pub async fn evaluate_integer(
        &mut self,
        text: &[u8],
        added: Option<&[u8]>,
    ) -> Result<Vec<u8>, Fault> {
        let mut coercion = Coercion::default();
        let value = self.store.evaluate_integer(&mut coercion, text, added);
        self.land_coercion(&mut coercion).await?;
        value.map_err(|error| fatal(self.store.voice(), error))
    }
}

#[cfg(test)]
mod tests {
    use std::pin::pin;
    use std::sync::Arc;
    use std::task::{Context, Poll, Waker};

    use super::*;
    use crate::vars::{INTEGER, RANDOM, READONLY};

    #[derive(Default)]
    struct Recorder {
        heard: Vec<(Verb, String, Option<Vec<u8>>)>,
        refuse_post: Option<String>,
    }

    impl Gate for Recorder {
        fn listens(&self) -> bool {
            true
        }

        async fn pre(
            &mut self,
            verb: Verb,
            key: &str,
            value: Option<&[u8]>,
            _: &Store,
        ) -> Result<(), Fault> {
            self.heard
                .push((verb, key.to_owned(), value.map(<[u8]>::to_vec)));
            Ok(())
        }

        async fn post(
            &mut self,
            _: Verb,
            key: &str,
            _: Option<&[u8]>,
            _: Option<&[u8]>,
            _: &Store,
        ) -> Result<(), Fault> {
            if self.refuse_post.as_deref() == Some(key) {
                return Err(Fault::Denied(Denied {
                    name: key.to_owned(),
                    record: 1,
                }));
            }
            Ok(())
        }
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        let mut future = pin!(future);
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("a gate that answers at once never pends"),
        }
    }

    /// A host no policy of which hears session writes.
    struct Deaf;

    impl Gate for Deaf {
        fn listens(&self) -> bool {
            false
        }

        async fn pre(
            &mut self,
            _: Verb,
            _: &str,
            _: Option<&[u8]>,
            _: &Store,
        ) -> Result<(), Fault> {
            Ok(())
        }

        async fn post(
            &mut self,
            _: Verb,
            _: &str,
            _: Option<&[u8]>,
            _: Option<&[u8]>,
            _: &Store,
        ) -> Result<(), Fault> {
            Ok(())
        }
    }

    fn writer<'a>(store: &'a mut Store, gate: &'a mut Recorder) -> Writer<'a, Recorder> {
        Writer {
            store,
            gate,
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
    fn integer_writes_land_gated_before_their_value() {
        let mut store = Store::new(Arc::new(|| 1));
        store.set_attr("n", Some(INTEGER), true);
        let mut gate = Recorder::default();
        run(writer(&mut store, &mut gate).set("n", scalar("x=5, x+1"), true, None, None)).unwrap();
        assert_eq!(text(&store, "x").as_deref(), Some("5"));
        assert_eq!(text(&store, "n").as_deref(), Some("6"));
        let keys: Vec<_> = gate.heard.iter().map(|(_, key, _)| key.as_str()).collect();
        assert_eq!(keys, ["n", "x"]);
        assert_eq!(gate.heard[0].2.as_deref(), Some(&b"6"[..]));
    }

    #[test]
    fn a_refusal_after_landing_puts_the_old_record_back() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("v", scalar("old"));
        let mut gate = Recorder {
            refuse_post: Some("v".to_owned()),
            ..Recorder::default()
        };
        let landed = run(writer(&mut store, &mut gate).set("v", scalar("new"), true, None, None));
        assert!(matches!(landed, Err(Fault::Denied(_))));
        assert_eq!(text(&store, "v").as_deref(), Some("old"));
        let unset = run(writer(&mut store, &mut gate).unset("v", true));
        assert!(matches!(unset, Err(Fault::Denied(_))));
        assert_eq!(text(&store, "v").as_deref(), Some("old"));
    }

    #[test]
    fn readonly_and_hidden_names_refuse() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("R", scalar("1"));
        store.set_attr("R", Some(READONLY), true);
        let mut gate = Recorder::default();
        let refused = run(writer(&mut store, &mut gate).set("R", scalar("2"), true, None, None));
        assert!(matches!(refused, Err(Fault::Readonly { .. })));
        store.set_attr("n", Some(INTEGER), true);
        let fatal = run(writer(&mut store, &mut gate).set("n", scalar("R=3"), true, None, None));
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
        let mut gate = Recorder::default();
        run(writer(&mut store, &mut gate).set(RANDOM, scalar("42"), true, None, None)).unwrap();
        assert_eq!(store.next_random().unwrap(), Some(17772));
    }

    #[test]
    fn a_bare_name_over_an_array_assigns_element_zero() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed(
            "A",
            Value::Indexed(Indexed::dense([b"old".to_vec(), b"keep".to_vec()])),
        );
        store.set_attr("n", Some(INTEGER), true);
        let mut gate = Recorder::default();
        run(writer(&mut store, &mut gate).set("n", scalar("A=9"), true, None, None)).unwrap();
        let array = store.indexed("A").unwrap();
        assert_eq!(array.get(0), Some(&b"9"[..]));
        assert_eq!(array.get(1), Some(&b"keep"[..]));
    }

    #[test]
    fn a_subscript_lands_what_it_assigns() {
        let mut store = Store::new(Arc::new(|| 1));
        let mut gate = Recorder::default();
        let index = run(writer(&mut store, &mut gate).subscript_index(b"x=3")).unwrap();
        assert_eq!(index, 3);
        assert_eq!(text(&store, "x").as_deref(), Some("3"));
        let failed = run(writer(&mut store, &mut gate).subscript_index(b"y=2, 1/0"));
        assert!(matches!(failed, Err(Fault::Arith(_))));
        assert_eq!(text(&store, "y").as_deref(), Some("2"));
        let mut strict = writer(&mut store, &mut gate);
        strict.nounset = true;
        let failed = run(strict.subscript_index(b"z=4, nope"));
        assert!(matches!(failed, Err(Fault::Signal(_))));
        let mut strict = writer(&mut store, &mut gate);
        strict.nounset = true;
        let failed = run(strict.arith(b"w=5, nope", false));
        assert!(matches!(failed, Err(Fault::Signal(_))));
        assert_eq!(text(&store, "z").as_deref(), Some("4"));
        assert_eq!(text(&store, "w").as_deref(), Some("5"));
    }

    #[test]
    fn a_write_past_max_env_ends_the_shell() {
        let mut store = Store::new(Arc::new(|| 1));
        let mut gate = Recorder::default();
        let mut writer = writer(&mut store, &mut gate);
        writer.limit = Some(8);
        run(writer.set("AB", scalar("xyz"), true, None, None)).unwrap();
        match run(writer.set("CD", scalar("long"), true, None, None)) {
            Err(Fault::Signal(Signal::Exit { status, .. })) => assert_eq!(status, 2),
            other => panic!("expected max_env to refuse, got {other:?}"),
        }
        run(writer.set("AB", scalar("x"), true, None, None)).unwrap();
    }

    #[test]
    fn a_reference_is_set_as_test_v_reads_it() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("s", scalar("v"));
        let map = [(b"a".to_vec(), b"1".to_vec())].into_iter().collect();
        store.seed("m", Value::Assoc(Box::new(map)));
        let mut gate = Recorder::default();
        let mut writer = writer(&mut store, &mut gate);
        let arr = || Some(Indexed::dense([b"p".to_vec(), b"q".to_vec()]));
        assert!(run(writer.is_set(b"s", None, false)).unwrap());
        assert!(run(writer.is_set(b"s[0]", None, false)).unwrap());
        assert!(!run(writer.is_set(b"s[1]", None, false)).unwrap());
        assert!(run(writer.is_set(b"m[\"a\"]", None, false)).unwrap());
        assert!(!run(writer.is_set(b"m[\"a\"]", None, true)).unwrap());
        assert!(run(writer.is_set(b"m[a]", None, true)).unwrap());
        assert!(!run(writer.is_set(b"m[1+1]", None, false)).unwrap());
        assert!(run(writer.is_set(b"m[@]", None, false)).unwrap());
        assert!(run(writer.is_set(b"arr[-1]", arr(), false)).unwrap());
        assert!(!run(writer.is_set(b"arr[x=2]", arr(), false)).unwrap());
        assert_eq!(text(writer.store, "x").as_deref(), Some("2"));
        assert!(!run(writer.is_set(b"1x", None, false)).unwrap());
        assert!(!run(writer.is_set(b"m[]", None, false)).unwrap());
    }

    #[test]
    fn an_element_write_lands_the_whole_value() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("s", scalar("v"));
        store.seed("R", scalar("1"));
        store.set_attr("R", Some(READONLY), true);
        let map = [(b"a".to_vec(), b"1".to_vec())].into_iter().collect();
        store.seed("m", Value::Assoc(Box::new(map)));
        let mut gate = Recorder::default();
        let mut writer = writer(&mut store, &mut gate);
        let landed = run(writer.element("m", Some(b"a"), b"2", true)).unwrap();
        assert_eq!(landed, Element::Landed);
        assert_eq!(writer.store.assoc("m").unwrap().get(b"a"), Some(&b"12"[..]));
        run(writer.element("s", Some(b"2"), b"w", false)).unwrap();
        let array = writer.store.indexed("s").unwrap();
        assert_eq!(
            (array.get(0), array.get(2)),
            (Some(&b"v"[..]), Some(&b"w"[..]))
        );
        run(writer.element("s", Some(b"-1"), b"!", true)).unwrap();
        assert_eq!(writer.store.indexed("s").unwrap().get(2), Some(&b"w!"[..]));
        run(writer.element("t", None, b"x", true)).unwrap();
        assert_eq!(text(writer.store, "t").as_deref(), Some("x"));
        let refused = |w: &mut Writer<'_, Recorder>, name: &str, sub: &[u8]| {
            run(w.element(name, Some(sub), b"x", false)).unwrap()
        };
        assert_eq!(refused(&mut writer, "R", b"0"), Element::Readonly);
        assert_eq!(refused(&mut writer, "m", b""), Element::Subscript);
        assert_eq!(refused(&mut writer, "s", b"-9"), Element::Subscript);
        let keys: Vec<_> = gate.heard.iter().map(|(_, key, _)| key.as_str()).collect();
        assert_eq!(keys, ["m", "s", "s", "t"]);
    }

    #[test]
    fn unheard_element_writes_land_in_place_as_bash_orders_them() {
        let mut store = Store::new(Arc::new(|| 1));
        store.seed("a", Value::Indexed(Indexed::dense([b"1".to_vec()])));
        store.seed("i", Value::Indexed(Indexed::dense([b"5".to_vec()])));
        store.set_attr("i", Some(INTEGER), true);
        store.seed("s", scalar("v"));
        let mut gate = Deaf;
        let mut writer = Writer {
            store: &mut store,
            gate: &mut gate,
            allexport: false,
            nounset: false,
            diagnostics: None,
            limit: None,
            outside: 0,
        };
        run(writer.push("a", vec![b"2".to_vec(), b"3".to_vec()])).unwrap();
        let landed = run(writer.element("a", Some(b"x=1"), b"!", true)).unwrap();
        assert_eq!(landed, Element::Landed);
        assert_eq!(
            run(writer.unset_element("a", b"0")).unwrap(),
            Element::Landed
        );
        assert_eq!(
            run(writer.unset_element("a", b"-9")).unwrap(),
            Element::Subscript
        );
        let array: Vec<_> = writer.store.indexed("a").unwrap().iter().collect();
        assert_eq!(array, [(1, &b"2!"[..]), (2, &b"3"[..])]);
        run(writer.element("i", Some(b"0"), b"3", true)).unwrap();
        assert_eq!(writer.store.indexed("i").unwrap().get(0), Some(&b"8"[..]));
        writer.store.set_attr("i", Some(READONLY), true);
        let refused = run(writer.element("i", Some(b"y=2"), b"0", false)).unwrap();
        assert_eq!(refused, Element::Readonly);
        assert_eq!(
            run(writer.unset_element("s", b"1")).unwrap(),
            Element::NotArray
        );
        assert_eq!(
            run(writer.unset_element("s", b"0")).unwrap(),
            Element::Landed
        );
        assert_eq!(text(writer.store, "s"), None);
        assert_eq!(text(writer.store, "x").as_deref(), Some("1"));
        assert_eq!(text(writer.store, "y").as_deref(), Some("2"));
        writer
            .store
            .set_specials(vec![1], None, 1, 1, b"bash: ".to_vec());
        let special = run(writer.element("PIPESTATUS", Some(b"-1"), b"0", false)).unwrap();
        assert_eq!(special, Element::Landed);
        writer.limit = Some(writer.store.held() + 4);
        let refused = run(writer.push("a", vec![b"4".to_vec(), b"far too long".to_vec()]));
        assert!(matches!(
            refused,
            Err(Fault::Signal(Signal::Exit { status: 2, .. }))
        ));
        assert_eq!(writer.store.indexed("a").unwrap().count(), 2);
        writer.limit = None;
        writer
            .store
            .seed("n", Value::Indexed(Indexed::dense([b"1".to_vec()])));
        writer.store.set_attr("n", Some(INTEGER), true);
        let failed = run(writer.push("n", vec![b"2".to_vec(), b"n[1]=9,1/0".to_vec()]));
        assert!(matches!(failed, Err(Fault::Arith(_))));
        let kept: Vec<_> = writer.store.indexed("n").unwrap().iter().collect();
        assert_eq!(kept, [(0, &b"1"[..]), (1, &b"9"[..])]);
        let counted: usize = writer
            .store
            .records()
            .map(|(name, var)| entry_bytes(name, var.value.as_ref()))
            .sum();
        assert_eq!(writer.store.held(), counted);
    }
}
