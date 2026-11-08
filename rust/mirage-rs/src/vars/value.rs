//! A value a variable holds and the record holding it: a scalar, an indexed
//! array keeping only its assigned elements, or an associative array in
//! insertion order, with the attributes set on the name.

use std::collections::{BTreeMap, HashMap};

use super::{Assigned, NAMEREF, UNASSIGNED, letters};

/// An indexed array as bash keeps one: only its assigned elements, by
/// index. `a[1000000000]=x` holds one element, and an index no write
/// reached, or `unset` cleared, is no element at all.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Indexed(pub(super) BTreeMap<i64, Vec<u8>>);

impl Indexed {
    /// The array holding `values` at 0, 1, ...
    pub fn dense(values: impl IntoIterator<Item = Vec<u8>>) -> Self {
        Self((0..).zip(values).collect())
    }

    /// One past the highest assigned index, which a negative subscript
    /// counts back from: wider than an index, as bash keeps it, so an
    /// element at `i64::MAX` still counts.
    pub fn extent(&self) -> i128 {
        self.0
            .last_key_value()
            .map_or(0, |(index, _)| i128::from(*index) + 1)
    }

    /// A subscript as it lands: a negative one counted back from the
    /// extent, still negative when it reaches before index 0; any other
    /// as given.
    pub fn back(&self, index: i64) -> i64 {
        match self.0.last_key_value() {
            Some((last, _)) if index < 0 => index + 1 + last,
            _ => index,
        }
    }

    pub fn count(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn get(&self, index: i64) -> Option<&[u8]> {
        self.0.get(&index).map(Vec::as_slice)
    }

    /// Assign `value` at `index`, handing back what the index held.
    pub fn set(&mut self, index: i64, value: Vec<u8>) -> Option<Vec<u8>> {
        self.0.insert(index, value)
    }

    pub fn remove(&mut self, index: i64) -> Option<Vec<u8>> {
        self.0.remove(&index)
    }

    pub fn iter(&self) -> impl Iterator<Item = (i64, &[u8])> {
        self.0
            .iter()
            .map(|(index, value)| (*index, value.as_slice()))
    }

    /// The elements from subscript `offset` on, as bash slices an indexed
    /// array: by index, not by position among the assigned values, so for
    /// `([1]=b [3]=d [9]=j)` an offset of 2 keeps `d j`. A negative offset
    /// counts back from the extent; `length` caps the count, a negative
    /// one dropping that many from the end.
    pub fn slice(&self, offset: i64, length: Option<i64>) -> Vec<&[u8]> {
        let offset = self.back(offset);
        if offset < 0 {
            return Vec::new();
        }
        let picked: Vec<&[u8]> = self.0.range(offset..).map(|(_, v)| v.as_slice()).collect();
        match length {
            None => picked,
            Some(length) if length < 0 => {
                let keep = picked.len().saturating_sub(length.unsigned_abs() as usize);
                picked[..keep].to_vec()
            }
            Some(length) => picked.into_iter().take(length as usize).collect(),
        }
    }
}

/// An associative array, its keys in the order they were first assigned.
/// A removed key leaves a hole the walk skips, so a removal costs what a
/// lookup does; the holes are swept once they outnumber the keys.
#[derive(Clone, Debug, Default)]
pub struct Assoc {
    entries: Vec<Option<(Vec<u8>, Vec<u8>)>>,
    at: HashMap<Vec<u8>, usize>,
}

impl PartialEq for Assoc {
    fn eq(&self, other: &Self) -> bool {
        self.iter().eq(other.iter())
    }
}

impl Eq for Assoc {}

impl Assoc {
    pub fn get(&self, key: &[u8]) -> Option<&[u8]> {
        let i = *self.at.get(key)?;
        self.entries[i].as_ref().map(|(_, value)| value.as_slice())
    }

    /// Assign `value` at `key`, handing back what the key held.
    pub fn set(&mut self, key: Vec<u8>, value: Vec<u8>) -> Option<Vec<u8>> {
        match self.at.get(&key) {
            Some(&i) => self.entries[i]
                .as_mut()
                .map(|(_, held)| std::mem::replace(held, value)),
            None => {
                self.at.insert(key.clone(), self.entries.len());
                self.entries.push(Some((key, value)));
                None
            }
        }
    }

    pub fn remove(&mut self, key: &[u8]) -> Option<Vec<u8>> {
        let i = self.at.remove(key)?;
        let (_, value) = self.entries[i].take()?;
        if self.entries.len() > 2 * self.at.len() + 8 {
            self.entries.retain(Option::is_some);
            for (i, (key, _)) in self.entries.iter().flatten().enumerate() {
                self.at.insert(key.clone(), i);
            }
        }
        Some(value)
    }

    pub fn len(&self) -> usize {
        self.at.len()
    }

    pub fn is_empty(&self) -> bool {
        self.at.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&[u8], &[u8])> {
        self.entries
            .iter()
            .flatten()
            .map(|(key, value)| (key.as_slice(), value.as_slice()))
    }

    /// The entries in sorted-key order, mirage's pinned order where bash
    /// walks its hash order.
    pub fn sorted(&self) -> Vec<(&[u8], &[u8])> {
        let mut entries: Vec<_> = self.iter().collect();
        entries.sort();
        entries
    }
}

impl IntoIterator for Assoc {
    type Item = (Vec<u8>, Vec<u8>);
    type IntoIter = std::iter::Flatten<std::vec::IntoIter<Option<(Vec<u8>, Vec<u8>)>>>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter().flatten()
    }
}

impl FromIterator<(Vec<u8>, Vec<u8>)> for Assoc {
    fn from_iter<I: IntoIterator<Item = (Vec<u8>, Vec<u8>)>>(entries: I) -> Self {
        let mut assoc = Self::default();
        for (key, value) in entries {
            assoc.set(key, value);
        }
        assoc
    }
}

/// One element of an array: an indexed one's index or an associative
/// one's key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Slot {
    Index(i64),
    Key(Vec<u8>),
}

impl Slot {
    /// The bytes `text` holds at this slot against `max_env`: the
    /// element, the key, and one more.
    pub fn bytes(&self, text: &[u8]) -> usize {
        match self {
            Slot::Index(_) => text.len() + 1,
            Slot::Key(key) => key.len() + text.len() + 1,
        }
    }

    /// What a write of this slot assigns, for an `-i` array's coercion:
    /// the slot when it `put` a value, nothing when it cleared one.
    pub fn assigned(&self, put: bool) -> Assigned {
        match self {
            Slot::Index(index) => Assigned::Indexes(put.then_some(*index).into_iter().collect()),
            Slot::Key(key) => Assigned::Keys(put.then(|| key.clone()).into_iter().collect()),
        }
    }
}

/// A value; the rare associative one is boxed so every record stays small.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Scalar(Vec<u8>),
    Indexed(Indexed),
    Assoc(Box<Assoc>),
}

impl Value {
    /// The bytes it holds against `max_env`; an element holds one more, so
    /// an empty one is not free.
    pub fn held(&self) -> usize {
        match self {
            Value::Scalar(text) => text.len(),
            Value::Indexed(array) => array.iter().map(|(_, v)| v.len() + 1).sum(),
            Value::Assoc(map) => map.iter().map(|(k, v)| k.len() + v.len() + 1).sum(),
        }
    }

    /// What a `pre_session` rule is shown for it: a scalar as itself, an
    /// indexed array's elements joined by spaces, an associative one's in
    /// sorted-key order. One rendering, so a rule reads the same text
    /// whether the write came from a typed line or a restore.
    pub fn rendering(&self) -> Vec<u8> {
        match self {
            Value::Scalar(text) => text.clone(),
            Value::Indexed(array) => array.iter().map(|(_, v)| v).collect::<Vec<_>>().join(&b' '),
            Value::Assoc(map) => map
                .sorted()
                .into_iter()
                .map(|(_, v)| v)
                .collect::<Vec<_>>()
                .join(&b' '),
        }
    }

    pub fn is_array(&self) -> bool {
        !matches!(self, Value::Scalar(_))
    }

    /// The element `slot` names, None when the value is no array of the
    /// slot's kind or the slot holds none.
    pub fn element(&self, slot: &Slot) -> Option<&[u8]> {
        match (self, slot) {
            (Value::Indexed(array), Slot::Index(index)) => array.get(*index),
            (Value::Assoc(map), Slot::Key(key)) => map.get(key),
            _ => None,
        }
    }

    /// Assign `text` at `slot`, or clear the slot with None, handing back
    /// what it held; None when the value is no array of the slot's kind.
    pub fn put(&mut self, slot: &Slot, text: Option<Vec<u8>>) -> Option<Option<Vec<u8>>> {
        Some(match (self, slot, text) {
            (Value::Indexed(array), Slot::Index(index), Some(text)) => array.set(*index, text),
            (Value::Indexed(array), Slot::Index(index), None) => array.remove(*index),
            (Value::Assoc(map), Slot::Key(key), Some(text)) => map.set(key.clone(), text),
            (Value::Assoc(map), Slot::Key(key), None) => map.remove(key),
            _ => return None,
        })
    }

    pub fn kind(&self) -> Kind {
        match self {
            Value::Scalar(_) => Kind::Scalar,
            Value::Indexed(_) => Kind::Indexed,
            Value::Assoc(_) => Kind::Assoc,
        }
    }
}

/// What a value is, which a reader lists names by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Scalar,
    Indexed,
    Assoc,
}

impl Kind {
    /// The kind as a host names it: `scalar`, `indexed` or `assoc`.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Scalar => "scalar",
            Kind::Indexed => "indexed",
            Kind::Assoc => "assoc",
        }
    }
}

impl std::str::FromStr for Kind {
    type Err = String;

    fn from_str(name: &str) -> Result<Self, String> {
        Ok(match name {
            "scalar" => Kind::Scalar,
            "indexed" => Kind::Indexed,
            "assoc" => Kind::Assoc,
            other => return Err(format!("no value kind {other}")),
        })
    }
}

/// Where a managed variable's value comes from: host configuration, never
/// something a line can spell, and what serializes in place of the value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Managed {
    pub source: String,
    pub reference: String,
    pub key: String,
    pub eager: bool,
}

/// One shell variable: its value, None for declared but unset, the
/// attributes set on the name, and where a managed one's value comes from,
/// boxed as rare.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Var {
    pub value: Option<Value>,
    pub attrs: u8,
    pub managed: Option<Box<Managed>>,
}

impl Var {
    pub fn scalar(text: impl Into<Vec<u8>>) -> Self {
        Self {
            value: Some(Value::Scalar(text.into())),
            ..Self::default()
        }
    }

    pub fn has(&self, attr: u8) -> bool {
        self.attrs & attr != 0
    }

    /// The record holding `value` with the same attributes, but a
    /// reference's under an array: bash's reference cannot hold one, so
    /// `declare -n r; r=(x)` leaves `declare -a r`. It is assigned now.
    pub fn holding(&self, value: Option<Value>) -> Self {
        let mut attrs = self.attrs & !UNASSIGNED;
        if value.as_ref().is_some_and(Value::is_array) {
            attrs &= !NAMEREF;
        }
        Self {
            value,
            attrs,
            managed: self.managed.clone(),
        }
    }

    /// The cluster `declare -p` prints: `a`/`A` from the value's kind, then
    /// the stored letters.
    pub fn cluster(&self) -> String {
        let lead = match &self.value {
            Some(Value::Indexed(_)) => "a",
            Some(Value::Assoc(_)) => "A",
            _ => "",
        };
        format!("{lead}{}", letters(self.attrs))
    }

    pub(super) fn text(&self) -> Option<&[u8]> {
        match &self.value {
            Some(Value::Scalar(text)) => Some(text),
            _ => None,
        }
    }
}

/// Whether two records save alike: the same attributes, pointer and
/// saved value.
pub(super) fn saves_alike(a: &Var, b: &Var) -> bool {
    a.attrs == b.attrs && a.managed == b.managed && saved_value(a) == saved_value(b)
}

/// The value a record saves. A managed one saves its pointer in place of
/// the text a host fetched into it, so a fetch changes nothing saved;
/// only an array it came to hold is.
fn saved_value(var: &Var) -> Option<&Value> {
    var.value
        .as_ref()
        .filter(|value| var.managed.is_none() || value.is_array())
}

/// The bytes one name and its value hold.
pub fn entry_bytes(name: &str, value: Option<&Value>) -> usize {
    name.len() + value.map_or(0, Value::held)
}
