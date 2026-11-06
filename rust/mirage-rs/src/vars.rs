//! A session's shell variables: one record per name, holding its value and
//! the attributes set on it, the scopes a function call and a prefix
//! assignment open over the records, and `$RANDOM`'s generator. A value is a
//! scalar, an indexed array or an associative one, or none at all for a name
//! declared but unset, which is not the empty string: `${D-d}` reads `d` for
//! `declare D` and nothing for `D=`. Text is bytes, as the shell's is.
//!
//! The store is the one place a record changes (`place`), so the bytes the
//! records hold, which `max_env` caps, are counted as they change. A write
//! the line asks for is gated by the host before and after it lands; the
//! steps here are its synchronous parts, each handing back what it replaced
//! so a refusal can put it back.
//!
//! Forks share what they hold: the table and each record are counted
//! references, so a subshell or a command substitution copies nothing until
//! it writes, and its first write copies the table's pointers, not the
//! values.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::arith::{self, Halt, Outcome, Vars};
use crate::policy::{VarScope, Visibility, VisibilityMatcher};

/// `declare -i`: a value assigned is evaluated as arithmetic.
pub const INTEGER: u8 = 1;
/// `declare -n`: the name stands for the variable its value names.
pub const NAMEREF: u8 = 1 << 1;
pub const READONLY: u8 = 1 << 2;
pub const TRACE: u8 = 1 << 3;
pub const EXPORT: u8 = 1 << 4;
/// `declare -l`: a value assigned is lowercased.
pub const LOWER: u8 = 1 << 5;
/// `declare -u`: a value assigned is uppercased.
pub const UPPER: u8 = 1 << 6;

/// The stored attributes as `declare -p` prints them, in bash's own order,
/// pinned over every ordered pair of `a A i l n r t u x`: `i n r t x`, then
/// `l`/`u`. `-a` and `-A` are the value's kind, never stored.
const LETTERS: [(u8, char); 7] = [
    (INTEGER, 'i'),
    (NAMEREF, 'n'),
    (READONLY, 'r'),
    (TRACE, 't'),
    (EXPORT, 'x'),
    (LOWER, 'l'),
    (UPPER, 'u'),
];

pub const RANDOM: &str = "RANDOM";
/// bash 5.2's generator: Park-Miller's minimal standard stepped through
/// Schrage's method, so `RANDOM=42` is the same sequence everywhere.
const RANDOM_A: i64 = 16807;
const RANDOM_Q: i64 = 127_773;
const RANDOM_R: i64 = 2836;
const RANDOM_M: i64 = 0x7FFF_FFFF;
const RANDOM_ZERO_SEED: i64 = 123_459_876;
const RANDOM_MAX: u32 = 32767;

/// The stored attribute letters, in print order.
pub fn letters(attrs: u8) -> String {
    LETTERS
        .iter()
        .filter(|(attr, _)| attrs & attr != 0)
        .map(|(_, letter)| *letter)
        .collect()
}

/// The attributes a stored letter cluster spells. A letter naming none is
/// skipped: the cluster is shared with the other host and later versions,
/// and refusing a session over one letter loses more than the letter.
pub fn attrs_of(cluster: &str) -> u8 {
    cluster
        .chars()
        .filter_map(|c| LETTERS.iter().find(|(_, letter)| *letter == c))
        .fold(0, |attrs, (attr, _)| attrs | attr)
}

/// An indexed array as bash keeps one: only its assigned elements, by
/// index. `a[1000000000]=x` holds one element, and an index no write
/// reached, or `unset` cleared, is no element at all.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Indexed(BTreeMap<i64, Vec<u8>>);

impl Indexed {
    /// The array holding `values` at 0, 1, ...
    pub fn dense(values: impl IntoIterator<Item = Vec<u8>>) -> Self {
        Self((0..).zip(values).collect())
    }

    /// One past the highest assigned index, which a negative subscript
    /// counts back from.
    pub fn extent(&self) -> i64 {
        self.0.last_key_value().map_or(0, |(index, _)| index + 1)
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

    pub fn set(&mut self, index: i64, value: Vec<u8>) {
        self.0.insert(index, value);
    }

    pub fn unset(&mut self, index: i64) {
        self.0.remove(&index);
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
        let offset = if offset < 0 {
            let back = offset + self.extent();
            if back < 0 {
                return Vec::new();
            }
            back
        } else {
            offset
        };
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
#[derive(Clone, Debug, Default)]
pub struct Assoc {
    entries: Vec<(Vec<u8>, Vec<u8>)>,
    at: HashMap<Vec<u8>, usize>,
}

impl PartialEq for Assoc {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}

impl Eq for Assoc {}

impl Assoc {
    pub fn get(&self, key: &[u8]) -> Option<&[u8]> {
        self.at.get(key).map(|&i| self.entries[i].1.as_slice())
    }

    pub fn set(&mut self, key: Vec<u8>, value: Vec<u8>) {
        match self.at.get(&key) {
            Some(&i) => self.entries[i].1 = value,
            None => {
                self.at.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    pub fn remove(&mut self, key: &[u8]) -> Option<Vec<u8>> {
        let i = self.at.remove(key)?;
        let (_, value) = self.entries.remove(i);
        for at in self.at.values_mut() {
            if *at > i {
                *at -= 1;
            }
        }
        Some(value)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&[u8], &[u8])> {
        self.entries
            .iter()
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

impl FromIterator<(Vec<u8>, Vec<u8>)> for Assoc {
    fn from_iter<I: IntoIterator<Item = (Vec<u8>, Vec<u8>)>>(entries: I) -> Self {
        let mut assoc = Self::default();
        for (key, value) in entries {
            assoc.set(key, value);
        }
        assoc
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
    /// `declare -n r; r=(x)` leaves `declare -a r`.
    pub fn holding(&self, value: Option<Value>) -> Self {
        let mut attrs = self.attrs;
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

    fn text(&self) -> Option<&[u8]> {
        match &self.value {
            Some(Value::Scalar(text)) => Some(text),
            _ => None,
        }
    }
}

/// The bytes one name and its value hold.
pub fn entry_bytes(name: &str, value: Option<&Value>) -> usize {
    name.len() + value.map_or(0, Value::held)
}

/// The seed word `$RANDOM`'s generator last consumed. `Fresh` has none and
/// draws its first seed from the host; `Off` is after `unset RANDOM`, or
/// an array landing on it, which end its special meaning for good.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Seed {
    Fresh,
    Off,
    Word(Vec<u8>),
}

/// The scope a function call or a prefix assignment opens: the records it
/// shadowed, None for a name that had none. `temp` marks a prefix
/// assignment's scope, bash's temporary environment of `x=1 f`.
#[derive(Clone, Debug, Default)]
struct Frame {
    saved: HashMap<String, Option<Arc<Var>>>,
    temp: bool,
}

/// What a write assigns of an array: the indexes or keys, so an `-i`
/// array never evaluates its other elements again.
#[derive(Clone, Debug)]
pub enum Assigned {
    Indexes(HashSet<i64>),
    Keys(HashSet<Vec<u8>>),
}

/// Where a host draws a generator's first seed: the workspace's id source.
pub type Ids = Arc<dyn Fn() -> u32 + Send + Sync>;

/// A session's variables.
#[derive(Clone)]
pub struct Store {
    vars: Arc<HashMap<Arc<str>, Arc<Var>>>,
    frames: Vec<Frame>,
    /// The running function's frame, None outside every function.
    local: Option<usize>,
    /// The names a running `declare -g` put at global scope: each with
    /// the outermost frame that shadows it and the local it set aside.
    reached: Vec<(String, usize, Option<Arc<Var>>)>,
    /// The caller's seed for every frame shadowing `RANDOM`, innermost last.
    local_random: Vec<Seed>,
    random_state: Option<u32>,
    random_seed: Seed,
    random_last: u32,
    hidden: Option<Arc<VisibilityMatcher>>,
    ids: Ids,
    held: usize,
    /// The number of the last change to the records, which every copy
    /// holding the same records shares.
    version: u64,
}

/// The number the next change to any store's records takes: one count for
/// every store, so two stores at one number hold the same records.
static VERSIONS: AtomicU64 = AtomicU64::new(1);

fn next_version() -> u64 {
    VERSIONS.fetch_add(1, Ordering::Relaxed)
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("vars", &self.vars)
            .field("held", &self.held)
            .finish_non_exhaustive()
    }
}

/// Why a step of a write stopped.
#[derive(Debug)]
pub enum Refused {
    /// The name is hidden for this session.
    Hidden(String),
    Readonly(String),
    /// An `-i` value did not evaluate, or reached a readonly name; the
    /// writes it made before stopping are still owed.
    Arith(arith::Error),
}

impl Store {
    pub fn new(ids: Ids) -> Self {
        Self {
            vars: Arc::default(),
            frames: Vec::new(),
            local: None,
            reached: Vec::new(),
            local_random: Vec::new(),
            random_state: None,
            random_seed: Seed::Fresh,
            random_last: 0,
            hidden: None,
            ids,
            held: 0,
            version: next_version(),
        }
    }

    /// The number of the records' last change: a store at the number it
    /// was at before holds the records it held then, so a host can tell
    /// whether to save them again without reading them.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// Draw first seeds from `ids` from now on.
    pub fn set_ids(&mut self, ids: Ids) {
        self.ids = ids;
    }

    /// Hide the names `matcher` hides: they read as unset and refuse
    /// writes.
    pub fn hide(&mut self, matcher: Option<Arc<VisibilityMatcher>>) {
        self.hidden = matcher;
    }

    /// Hide the names a session's visibility lists, exactly or by glob.
    pub fn hide_vars(&mut self, names: &[String], patterns: &[String]) {
        let units = |list: &[String]| -> Vec<Vec<u32>> {
            list.iter()
                .map(|name| name.chars().map(u32::from).collect())
                .collect()
        };
        let hides = !names.is_empty() || !patterns.is_empty();
        self.hide(hides.then(|| {
            Arc::new(VisibilityMatcher::new(Visibility {
                vars: VarScope {
                    names: units(names),
                    patterns: units(patterns),
                },
                ..Visibility::default()
            }))
        }));
    }

    /// The bytes every record holds, names and values.
    pub fn held(&self) -> usize {
        self.held
    }

    pub fn hidden(&self, name: &str) -> bool {
        self.hidden.as_ref().is_some_and(|matcher| {
            let units: Vec<u32> = name.chars().map(u32::from).collect();
            matcher.var_hidden(&units)
        })
    }

    /// The raw record, hidden or not, references not followed.
    pub fn record(&self, name: &str) -> Option<&Var> {
        self.vars.get(name).map(Arc::as_ref)
    }

    /// The raw record shared rather than copied, which an undo puts back.
    pub fn share(&self, name: &str) -> Option<Arc<Var>> {
        self.vars.get(name).cloned()
    }

    /// Every record, in no order.
    pub fn records(&self) -> impl Iterator<Item = (&str, &Var)> {
        self.vars
            .iter()
            .map(|(name, var)| (name.as_ref(), var.as_ref()))
    }

    /// The one place a record changes: `var` replaces the name's record,
    /// or None drops it, and the one it replaced comes back. A table a fork
    /// still shares is copied first, pointers only.
    pub fn place(&mut self, name: &str, var: Option<Arc<Var>>) -> Option<Arc<Var>> {
        if var.is_none() && !self.vars.contains_key(name) {
            return None;
        }
        let vars = Arc::make_mut(&mut self.vars);
        self.version = next_version();
        let old = match var {
            Some(var) => {
                self.held += entry_bytes(name, var.value.as_ref());
                match vars.get_mut(name) {
                    Some(slot) => Some(std::mem::replace(slot, var)),
                    None => vars.insert(Arc::from(name), var),
                }
            }
            None => vars.remove(name),
        };
        if let Some(old) = &old {
            self.held -= entry_bytes(name, old.value.as_ref());
        }
        old
    }

    /// The name a `declare -n` reference points at; None for one not yet
    /// aimed (`declare -n r` before `r=v`), which stands for nothing.
    pub fn nameref_target(&self, name: &str) -> Option<&str> {
        let var = self.record(name).filter(|var| var.has(NAMEREF))?;
        match var.text() {
            Some(target) if !target.is_empty() => std::str::from_utf8(target).ok(),
            _ => None,
        }
    }

    /// The variable a name stands for, following references. A chain that
    /// comes back to itself is bash's circular reference, read as unset:
    /// the empty name, which no record has.
    pub fn deref(&self, name: &str) -> String {
        let mut current = name;
        let mut seen = HashSet::new();
        while let Some(target) = self.nameref_target(current) {
            if !seen.insert(current) {
                return String::new();
            }
            current = target;
        }
        current.to_owned()
    }

    /// The name a write lands on: its reference's target, or the
    /// reference's own record for a cycle.
    pub fn target(&self, name: &str) -> String {
        let target = self.deref(name);
        if target.is_empty() {
            name.to_owned()
        } else {
            target
        }
    }

    /// The record a name stands for, references followed; None when
    /// unset or hidden.
    pub fn visible(&self, name: &str) -> Option<&Var> {
        let name = self.deref(name);
        if self.hidden(&name) {
            return None;
        }
        self.record(&name)
    }

    /// A scalar's value, None when unset, hidden or an array: `$X`.
    pub fn scalar(&self, name: &str) -> Option<&[u8]> {
        self.visible(name).and_then(Var::text)
    }

    pub fn indexed(&self, name: &str) -> Option<&Indexed> {
        match self.visible(name)?.value.as_ref()? {
            Value::Indexed(array) => Some(array),
            _ => None,
        }
    }

    pub fn assoc(&self, name: &str) -> Option<&Assoc> {
        match self.visible(name)?.value.as_ref()? {
            Value::Assoc(map) => Some(map),
            _ => None,
        }
    }

    /// The names a reader lists for one kind of value, sorted: each whose
    /// record, references followed, holds that kind and is not hidden, so
    /// every name listed is one a lookup finds.
    pub fn visible_names(&self, kind: Kind) -> Vec<&str> {
        let mut names: Vec<&str> = self
            .vars
            .keys()
            .filter(|name| {
                self.visible(name)
                    .and_then(|var| var.value.as_ref())
                    .is_some_and(|value| value.kind() == kind)
            })
            .map(AsRef::as_ref)
            .collect();
        names.sort_unstable();
        names
    }

    /// Whether `readonly` marked the name; a hidden name is not, which
    /// would leak it. `follow_ref` asks about a reference's target.
    pub fn is_readonly(&self, name: &str, follow_ref: bool) -> bool {
        let name = if follow_ref {
            self.deref(name)
        } else {
            name.to_owned()
        };
        !self.hidden(&name) && self.record(&name).is_some_and(|var| var.has(READONLY))
    }

    /// The readonly variable a write to `name` reaches, which a refusal
    /// names; None when the write lands.
    pub fn frozen(&self, name: &str) -> Option<String> {
        let target = self.deref(name);
        self.is_readonly(&target, false).then_some(target)
    }

    /// The process environment a command is handed: the exported scalars,
    /// hidden names left out. An exported name with no value is absent.
    pub fn exported(&self) -> Vec<(&str, &[u8])> {
        let mut env: Vec<_> = self
            .vars
            .iter()
            .filter(|(name, var)| var.has(EXPORT) && !self.hidden(name))
            .filter_map(|(name, var)| Some((name.as_ref(), var.text()?)))
            .collect();
        env.sort();
        env
    }

    /// Write a record without the gate: a session being seeded, or the
    /// shell's own bookkeeping (`PWD`, `BASH_REMATCH`).
    pub fn seed(&mut self, name: &str, value: Value) {
        let var = match self.vars.get(name) {
            Some(existing) => existing.holding(Some(value)),
            None => Var {
                value: Some(value),
                ..Var::default()
            },
        };
        if let Some(value) = &var.value {
            self.note_kind(name, value);
        }
        self.place(name, Some(Arc::new(var)));
    }

    /// Turn one attribute on or off, creating the name unset if needed, as
    /// `readonly NAME` on a fresh name does; None only declares it.
    pub fn set_attr(&mut self, name: &str, attr: Option<u8>, on: bool) {
        let mut var = self.record(name).cloned().unwrap_or_default();
        if let Some(attr) = attr {
            if on {
                var.attrs |= attr;
            } else {
                var.attrs &= !attr;
            }
        }
        self.place(name, Some(Arc::new(var)));
    }

    /// End `RANDOM`'s special meaning once a non-scalar lands on it: bash
    /// neither draws nor seeds an array, for good.
    pub fn note_kind(&mut self, name: &str, value: &Value) {
        if name == RANDOM && value.is_array() {
            self.random_seed = Seed::Off;
        }
    }

    /// Store a write the gate passed: the coerced value on the name's
    /// record, a managed pointer dropped (an agent write shadows it for
    /// this session only), exported under `set -a`. The record it replaced
    /// comes back for an undo.
    pub fn land(&mut self, name: &str, value: Value, allexport: bool) -> Option<Arc<Var>> {
        let mut var = match self.vars.get(name) {
            Some(existing) => existing.holding(Some(value)),
            None => Var {
                value: Some(value),
                ..Var::default()
            },
        };
        var.managed = None;
        if allexport {
            var.attrs |= EXPORT;
        }
        if let Some(value) = &var.value {
            self.note_kind(name, value);
        }
        self.place(name, Some(Arc::new(var)))
    }

    /// The innermost scope on the call path that saved `name`.
    fn shadowing(&self, name: &str) -> Option<usize> {
        self.frames
            .iter()
            .rposition(|frame| frame.saved.contains_key(name))
    }

    /// Drop a variable as `unset` does. A name the running function made
    /// local stays unset until it returns; a name an enclosing scope
    /// shadows is that scope's to lose: the unset reveals the value it
    /// saved, which the name holds from then on (`x=old; x=pre f` where f
    /// runs `unset x` reads `old` inside f and after it). Returns the
    /// record dropped and the scope it emptied, for an undo.
    pub fn drop_var(&mut self, name: &str) -> (Option<Arc<Var>>, Option<usize>) {
        let frame = self.shadowing(name);
        let old = self.vars.get(name).cloned();
        match frame {
            Some(index) if Some(index) != self.local && name != RANDOM => {
                let saved = self.frames[index].saved.remove(name).flatten();
                self.place(name, saved);
            }
            _ => {
                self.place(name, None);
            }
        }
        if name == RANDOM {
            self.random_seed = Seed::Off;
        }
        (old, frame)
    }

    /// Put back what `drop_var` dropped, after a refusal: the value the
    /// unset revealed goes back to its scope before the name's own record.
    pub fn undrop(&mut self, name: &str, old: Option<Arc<Var>>, frame: Option<usize>, seed: Seed) {
        let unsaved = frame.filter(|&index| {
            index < self.frames.len() && !self.frames[index].saved.contains_key(name)
        });
        if let Some(index) = unsaved {
            let revealed = self.vars.get(name).cloned();
            self.frames[index].saved.insert(name.to_owned(), revealed);
        }
        self.place(name, old);
        self.random_seed = seed;
    }

    /// Open a function's scope; returns the caller's, for `leave`.
    pub fn enter(&mut self) -> Option<usize> {
        let outer = self.local;
        self.local = Some(self.frames.len());
        self.frames.push(Frame::default());
        outer
    }

    /// Close the running function's scope: its shadowed records come back,
    /// and a local `RANDOM` hands the caller's generator back. Deliberate
    /// divergence: bash reseeds the generator there; mirage resumes the
    /// caller's sequence where it left off.
    pub fn leave(&mut self, outer: Option<usize>) {
        if let Some(frame) = self.frames.pop() {
            let random = frame.saved.contains_key(RANDOM);
            for (name, old) in frame.saved {
                self.place(&name, old);
            }
            if random {
                self.random_seed = self.local_random.pop().unwrap_or(Seed::Fresh);
            }
        }
        self.local = outer;
    }

    /// Whether a function is running.
    pub fn in_function(&self) -> bool {
        self.local.is_some()
    }

    /// Whether the running function made `name` local already.
    pub fn is_local(&self, name: &str) -> bool {
        self.local
            .is_some_and(|index| self.frames[index].saved.contains_key(name))
    }

    /// Record the caller's record before a `local` shadows it, once per
    /// scope. A local `RANDOM` is an ordinary variable for the function's
    /// extent (`local RANDOM=5; echo $RANDOM` prints 5).
    pub fn shadow(&mut self, name: &str) {
        let Some(index) = self.local else {
            return;
        };
        if self.frames[index].saved.contains_key(name) {
            return;
        }
        let old = self.vars.get(name).cloned();
        self.frames[index].saved.insert(name.to_owned(), old);
        if name == RANDOM {
            let seed = std::mem::replace(&mut self.random_seed, Seed::Off);
            self.local_random.push(seed);
        }
    }

    /// Open a prefix assignment's scope (`x=1 f`): the names it assigns
    /// are put back when `close_temp` closes it.
    pub fn open_temp(&mut self) -> usize {
        self.frames.push(Frame {
            temp: true,
            ..Frame::default()
        });
        self.frames.len() - 1
    }

    /// Save `name`'s record in the prefix scope `index`, once.
    pub fn save_temp(&mut self, index: usize, name: &str) {
        if !self.frames[index].saved.contains_key(name) {
            let old = self.vars.get(name).cloned();
            self.frames[index].saved.insert(name.to_owned(), old);
        }
    }

    /// Close prefix scope `index`, putting back what it saved.
    pub fn close_temp(&mut self, index: usize) {
        if index < self.frames.len() {
            let frame = self.frames.remove(index);
            for (name, old) in frame.saved {
                self.place(&name, old);
            }
        }
    }

    /// Let a temporary-environment variable outlive its call: bash keeps
    /// `x` from `x=1 f` once something inside runs `export x` or
    /// `readonly x`.
    pub fn outlive_call(&mut self, name: &str) {
        if let Some(index) = self
            .shadowing(name)
            .filter(|&index| self.frames[index].temp)
        {
            self.frames[index].saved.remove(name);
        }
    }

    /// Whether the running function's call assigned `name` in front.
    pub fn in_call_env(&self, name: &str) -> bool {
        self.local.is_some_and(|index| {
            index > 0
                && self.frames[index - 1].temp
                && self.frames[index - 1].saved.contains_key(name)
        })
    }

    /// Put each name's global record in place for a `declare -g`: the
    /// running local lives in the store and the global is what the
    /// outermost shadowing scope saved, so the two swap until `unreach`
    /// (`local G=5; declare -gr G=1` leaves `$G` at 5 in the function, 1
    /// and frozen outside).
    pub fn reach_global(&mut self, names: &[String]) {
        let mut seen = HashSet::new();
        let mut reached = Vec::new();
        for name in names {
            if !seen.insert(name) {
                continue;
            }
            let Some(index) = self.frames.iter().position(|f| f.saved.contains_key(name)) else {
                continue;
            };
            let global = self.frames[index].saved.get(name).cloned().flatten();
            let running = self.place(name, global);
            reached.push((name.clone(), index, running));
        }
        self.reached = reached;
    }

    /// Put the running locals back after a `declare -g`.
    pub fn unreach(&mut self) {
        for (name, index, running) in std::mem::take(&mut self.reached) {
            let global = self.share(&name);
            if let Some(frame) = self.frames.get_mut(index) {
                frame.saved.insert(name.clone(), global);
            }
            self.place(&name, running);
        }
    }

    /// Put the locals a running `declare -g` set aside back for one
    /// arithmetic evaluation, which reads the function's scope as bash's
    /// does (`local H=2; declare -gi G=H` stores 2); `step_forward` reaches
    /// the globals again, keeping what the evaluation gave the locals.
    pub fn step_back(&mut self) -> Vec<(String, Option<Arc<Var>>)> {
        let reached: Vec<(String, Option<Arc<Var>>)> = self
            .reached
            .iter()
            .map(|(name, _, _)| (name.clone(), self.share(name)))
            .collect();
        let running: Vec<(String, Option<Arc<Var>>)> = self
            .reached
            .iter()
            .map(|(name, _, running)| (name.clone(), running.clone()))
            .collect();
        for (name, var) in running {
            self.place(&name, var);
        }
        reached
    }

    pub fn step_forward(&mut self, globals: Vec<(String, Option<Arc<Var>>)>) {
        for entry in self.reached.iter_mut() {
            entry.2 = self.vars.get(entry.0.as_str()).cloned();
        }
        for (name, var) in globals {
            self.place(&name, var);
        }
    }

    /// A copy for a fork of the session: the same records, a generator that
    /// starts afresh unless `unset RANDOM` ended it.
    pub fn fork(&self) -> Self {
        let mut forked = Self::new(self.ids.clone());
        forked.vars = self.vars.clone();
        forked.held = self.held;
        forked.version = self.version;
        forked.hidden = self.hidden.clone();
        if self.random_seed == Seed::Off {
            forked.random_seed = Seed::Off;
        }
        forked
    }

    /// A child shell's copy (a subshell, a command substitution): the
    /// scopes too, and `$RANDOM` starting a new sequence at its next draw
    /// rather than seeding from the value it holds now.
    pub fn subshell(&self) -> Self {
        let mut child = self.clone();
        child.reached = Vec::new();
        // A call's temporary environment is an ordinary saved scope in the
        // child: `export x` there keeps what the call saved under it.
        for frame in &mut child.frames {
            frame.temp = false;
        }
        if child.random_seed != Seed::Off {
            child.random_state = None;
            child.random_last = 0;
            child.random_seed = match self.record(RANDOM).and_then(Var::text) {
                Some(word) => Seed::Word(word.to_vec()),
                None => Seed::Fresh,
            };
        }
        child
    }

    pub fn random_seed(&self) -> &Seed {
        &self.random_seed
    }

    /// Whether `RANDOM` is special here: not hidden, not ended.
    fn random_special(&self, name: &str) -> bool {
        name == RANDOM && !self.hidden(name) && self.random_seed != Seed::Off
    }

    /// One `$RANDOM` read: a draw from the generator, or None once it is
    /// no longer special. A value the host seeded is consumed on its first
    /// read; a seed that does not evaluate is an arithmetic error.
    pub fn next_random(&mut self) -> Result<Option<u32>, arith::Error> {
        let stored = self.scalar(RANDOM).map(<[u8]>::to_vec);
        if self.random_seed == Seed::Off || (stored.is_none() && self.random_seed != Seed::Fresh) {
            return Ok(None);
        }
        let reseed = match (&stored, &self.random_seed) {
            (Some(word), Seed::Word(seed)) if word == seed => None,
            (Some(word), _) => Some(self.seed_from(word)?),
            (None, _) => None,
        };
        let (state, last) = match (reseed, self.random_state) {
            (Some(seed), _) => (seed, 0),
            (None, None) => ((self.ids)(), 0),
            (None, Some(state)) => (state, self.random_last),
        };
        let (state, value) = draw(state, last);
        self.random_state = Some(state);
        self.random_last = value;
        let word = value.to_string().into_bytes();
        let var = match self.vars.get(RANDOM) {
            Some(existing) => existing.holding(Some(Value::Scalar(word.clone()))),
            None => Var::scalar(word.clone()),
        };
        self.place(RANDOM, Some(Arc::new(var)));
        self.random_seed = Seed::Word(word);
        Ok(Some(value))
    }

    /// A seed word as the generator's state: evaluated as arithmetic,
    /// without the generator on offer, modulo 2^32.
    fn seed_from(&mut self, word: &[u8]) -> Result<u32, arith::Error> {
        let mut reading = Reading::plain(self);
        let outcome = reading.evaluate(word, None, false, &[]);
        outcome.value.map(|value| value as u32)
    }

    /// Seed the generator at a gated `RANDOM=` write: the word's value
    /// modulo 2^32, the sequence restarting.
    pub fn seed_random(&mut self, word: Vec<u8>, state: u32) {
        self.random_state = Some(state);
        self.random_seed = Seed::Word(word);
        self.random_last = 0;
    }

    /// The generator as it stands, for an undo.
    pub fn generator(&self) -> (Option<u32>, Seed, u32) {
        (
            self.random_state,
            self.random_seed.clone(),
            self.random_last,
        )
    }

    pub fn set_generator(&mut self, generator: (Option<u32>, Seed, u32)) {
        (self.random_state, self.random_seed, self.random_last) = generator;
    }

    /// Whether a write to RANDOM seeds it now.
    pub fn seeds_random(&self, name: &str) -> bool {
        name == RANDOM && self.random_seed != Seed::Off
    }

    /// Evaluate `text` as arithmetic against the session, as every
    /// arithmetic context does: drawing through `draws`, stopping at a
    /// write to a readonly name. The writes come back for the caller to
    /// land through the gate.
    pub fn arith(
        &mut self,
        draws: &mut Draws,
        text: &[u8],
        added: Option<&[u8]>,
        nounset: bool,
    ) -> Outcome {
        let mut reading = Reading {
            store: self,
            draws: Some(draws),
            kept: None,
        };
        let dynamic: Vec<String> = if reading.store.random_special(RANDOM) {
            vec![RANDOM.to_owned()]
        } else {
            Vec::new()
        };
        reading.evaluate(text, added, nounset, &dynamic)
    }

    /// Replay an evaluation's scratch draws on the generator, once the gate
    /// landed the seed it assigned: the session ends seeded and advanced by
    /// every read since, as bash's does.
    pub fn settle(&mut self, draws: &mut Draws) -> Result<(), arith::Error> {
        let Some(seeded) = draws.seeded.take() else {
            return Ok(());
        };
        if self.random_seed != Seed::Word(seeded.into_bytes()) {
            return Ok(());
        }
        for _ in 0..std::mem::take(&mut draws.count) {
            self.next_random()?;
        }
        Ok(())
    }

    /// The `-i` coercion of one value, as one evaluation: against the
    /// visible session, inside a `declare -g` against the function's
    /// scope, keeping the writes it made in `coercion` (bash binds `x` in
    /// `n='x=5'`, before an error too).
    pub fn evaluate_integer(
        &mut self,
        coercion: &mut Coercion,
        text: &[u8],
        added: Option<&[u8]>,
    ) -> Result<Vec<u8>, arith::Error> {
        let globals = self.step_back();
        let outcome = self.arith(&mut coercion.draws, text, added, false);
        self.step_forward(globals);
        coercion.writes.extend(outcome.writes);
        outcome.value.map(|value| value.to_string().into_bytes())
    }

    /// Shape one scalar as its name's attributes say, at the write, as
    /// bash does: integer first, then case.
    fn coerce_text(
        &mut self,
        coercion: &mut Coercion,
        text: Vec<u8>,
        attrs: u8,
        added: Option<&[u8]>,
    ) -> Result<Vec<u8>, arith::Error> {
        let text = if attrs & INTEGER != 0 {
            self.evaluate_integer(coercion, &text, added)?
        } else {
            text
        };
        Ok(if attrs & LOWER != 0 {
            recase(&text, str::to_lowercase)
        } else if attrs & UPPER != 0 {
            recase(&text, str::to_uppercase)
        } else {
            text
        })
    }

    /// Shape a value as its name's attributes say: an array per element,
    /// only the elements `assigned` names when it names some (bash shapes
    /// a value when it is assigned, so `declare -i a; a[0]=9` never
    /// evaluates a stored `a[1]` again).
    pub fn coerce(
        &mut self,
        coercion: &mut Coercion,
        value: Value,
        attrs: u8,
        added: Option<&[u8]>,
        assigned: Option<&Assigned>,
    ) -> Result<Value, arith::Error> {
        if attrs & (INTEGER | LOWER | UPPER) == 0 {
            return Ok(value);
        }
        Ok(match value {
            Value::Scalar(text) => Value::Scalar(self.coerce_text(coercion, text, attrs, added)?),
            Value::Indexed(array) => {
                let mut out = Indexed::default();
                for (index, text) in array.0 {
                    let skip =
                        matches!(assigned, Some(Assigned::Indexes(set)) if !set.contains(&index));
                    let text = if skip {
                        text
                    } else {
                        self.coerce_text(coercion, text, attrs, added)?
                    };
                    out.set(index, text);
                }
                Value::Indexed(out)
            }
            Value::Assoc(map) => {
                let mut out = Assoc::default();
                for (key, text) in map.entries {
                    let skip = matches!(assigned, Some(Assigned::Keys(set)) if !set.contains(&key));
                    let text = if skip {
                        text
                    } else {
                        self.coerce_text(coercion, text, attrs, added)?
                    };
                    out.set(key, text);
                }
                Value::Assoc(Box::new(out))
            }
        })
    }

    /// The scalar an array conversion keeps as element 0; for a live
    /// `RANDOM` the read draws (`RANDOM[1]=5` leaves `[0]` one draw).
    pub fn conversion_scalar(&mut self, name: &str) -> Result<Option<Vec<u8>>, arith::Error> {
        if name == RANDOM {
            if let Some(value) = self.next_random()? {
                return Ok(Some(value.to_string().into_bytes()));
            }
        }
        Ok(self.record(name).and_then(Var::text).map(<[u8]>::to_vec))
    }
}

/// Case-convert the UTF-8 runs of `text`, any other byte kept as it is.
fn recase(text: &[u8], convert: fn(&str) -> String) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for chunk in text.utf8_chunks() {
        out.extend_from_slice(convert(chunk.valid()).as_bytes());
        out.extend_from_slice(chunk.invalid());
    }
    out
}

/// One step of the generator, a zero state stepping from the fixed seed.
fn step_state(state: u32) -> u32 {
    let ret = if state == 0 {
        RANDOM_ZERO_SEED
    } else {
        i64::from(state)
    };
    let high = ret / RANDOM_Q;
    let low = ret - RANDOM_Q * high;
    let step = RANDOM_A * low - RANDOM_R * high;
    (if step < 0 { step + RANDOM_M } else { step }) as u32
}

/// One draw: step until the value, the state's 16-bit halves folded to 15
/// bits, differs from the last one, as bash does.
fn draw(mut state: u32, last: u32) -> (u32, u32) {
    loop {
        state = step_state(state);
        let value = ((state >> 16) ^ (state & 0xFFFF)) & RANDOM_MAX;
        if value != last {
            return (state, value);
        }
    }
}

/// An arithmetic evaluation's reads of `$RANDOM`. A read before the
/// expression assigns `RANDOM` draws from the session; once it assigns one,
/// the assignment is still pending at the gate, so reads draw from a
/// scratch generator seeded the way the gate will seed the session, and
/// `Store::settle` replays them once it has.
#[derive(Debug, Default)]
pub struct Draws {
    seeded: Option<String>,
    state: u32,
    last: u32,
    count: usize,
}

/// An `-i` coercion's evaluations: their `RANDOM` reads and the writes they
/// made, which land through the gate before the value they were made for.
#[derive(Debug, Default)]
pub struct Coercion {
    pub draws: Draws,
    pub writes: Vec<arith::Write>,
}

/// The session as arithmetic reads it.
struct Reading<'s> {
    store: &'s mut Store,
    draws: Option<&'s mut Draws>,
    /// The error a question raised, which the evaluation stops on.
    kept: Option<arith::Error>,
}

impl<'s> Reading<'s> {
    fn plain(store: &'s mut Store) -> Self {
        Self {
            store,
            draws: None,
            kept: None,
        }
    }

    fn evaluate(
        &mut self,
        text: &[u8],
        added: Option<&[u8]>,
        nounset: bool,
        dynamic: &[String],
    ) -> Outcome {
        let request = arith::Request {
            expression: text,
            added,
            nounset,
            elements: true,
            dynamic,
        };
        let mut outcome = arith::evaluate(&request, self);
        if let Err(arith::Error::Halt { subscript }) = outcome.value {
            if let Some(mut kept) = self.kept.take() {
                if let arith::Error::Arith {
                    subscript: inner, ..
                } = &mut kept
                {
                    *inner |= subscript;
                }
                outcome.value = Err(kept);
            }
        }
        outcome
    }

    fn keep<T>(&mut self, answer: Result<T, arith::Error>) -> Result<T, Halt> {
        answer.map_err(|error| {
            self.kept = Some(error);
            Halt
        })
    }
}

impl Vars for Reading<'_> {
    fn draw(&mut self, name: &str) -> Result<Option<Vec<u8>>, Halt> {
        if !self.store.random_special(name) {
            return Ok(None);
        }
        let Some(draws) = self.draws.as_deref_mut() else {
            return Ok(None);
        };
        if draws.seeded.is_none() {
            let value = self.store.next_random();
            return self
                .keep(value)
                .map(|v| v.map(|v| v.to_string().into_bytes()));
        }
        let (state, value) = draw(draws.state, draws.last);
        draws.state = state;
        draws.last = value;
        draws.count += 1;
        Ok(Some(value.to_string().into_bytes()))
    }

    fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, Halt> {
        if let Some(text) = self.store.scalar(name) {
            return Ok(Some(text.to_vec()));
        }
        self.element(name, b"0")
    }

    fn holds_array(&mut self, name: &str) -> Result<bool, Halt> {
        Ok(self.store.indexed(name).is_some() || self.store.assoc(name).is_some())
    }

    fn assoc(&mut self, name: &str) -> Result<bool, Halt> {
        Ok(self.store.assoc(name).is_some())
    }

    fn resolve(&mut self, name: &str, subscript: &[u8]) -> Result<Vec<u8>, Halt> {
        if self.store.assoc(name).is_some() {
            return Ok(strip_key_quotes(subscript).to_vec());
        }
        let mut index: i64 = std::str::from_utf8(subscript)
            .ok()
            .and_then(|text| text.parse().ok())
            .unwrap_or(0);
        if index < 0 {
            if let Some(array) = self.store.indexed(name) {
                index += array.extent();
            } else if self.store.scalar(name).is_some() {
                index += 1;
            }
            if index < 0 {
                let mut expression = name.as_bytes().to_vec();
                expression.push(b'[');
                expression.extend_from_slice(subscript);
                expression.push(b']');
                return self.keep(Err(arith::Error::Arith {
                    reason: "bad array subscript".to_owned(),
                    expression,
                    token: None,
                    subscript: false,
                }));
            }
        }
        Ok(index.to_string().into_bytes())
    }

    fn element(&mut self, name: &str, key: &[u8]) -> Result<Option<Vec<u8>>, Halt> {
        if let Some(map) = self.store.assoc(name) {
            return Ok(map.get(key).map(<[u8]>::to_vec));
        }
        let index: i64 = std::str::from_utf8(key)
            .ok()
            .and_then(|text| text.parse().ok())
            .unwrap_or(0);
        if let Some(array) = self.store.indexed(name) {
            return Ok(array.get(index).map(<[u8]>::to_vec));
        }
        Ok(self
            .store
            .scalar(name)
            .filter(|_| index == 0)
            .map(<[u8]>::to_vec))
    }

    fn frozen(&mut self, name: &str) -> Result<Option<String>, Halt> {
        Ok(self.store.frozen(name))
    }

    fn wrote(&mut self, name: &str, value: &str) -> Result<(), Halt> {
        if !self.store.random_special(name) {
            return Ok(());
        }
        if let Some(draws) = self.draws.as_deref_mut() {
            draws.seeded = Some(value.to_owned());
            draws.state = value.parse::<i64>().map_or(0, |v| v as u32);
            draws.last = 0;
            draws.count = 0;
        }
        Ok(())
    }
}

/// An associative subscript with one surrounding quote pair removed: an
/// arithmetic reference carries its subscript as typed (`m["x"]`).
pub fn strip_key_quotes(text: &[u8]) -> &[u8] {
    match text {
        [open, inner @ .., close] if open == close && matches!(open, b'"' | b'\'') => inner,
        _ => text,
    }
}

/// Split one `[key]=value` array-literal word at its first `]=`, None for
/// a plain word.
pub fn keyed_word(word: &[u8]) -> Option<(&[u8], &[u8])> {
    if word.first() != Some(&b'[') {
        return None;
    }
    let at = word[1..].windows(2).position(|pair| pair == b"]=")? + 1;
    if at <= 1 {
        return None;
    }
    Some((&word[1..at], &word[at + 2..]))
}

/// The associative array a compound literal makes. The first word picks
/// the grammar, as bash's does: a `[key]=value` first word makes every
/// plain word an error, handed back for the caller to report, while a
/// plain first word reads the list as alternating keys and values, an odd
/// one out storing an empty value. `+=` merges over `base`.
pub fn assoc_literal(
    base: Option<&Assoc>,
    words: &[Vec<u8>],
    append: bool,
) -> (Assoc, Vec<Vec<u8>>) {
    let mut out = match base {
        Some(base) if append => base.clone(),
        _ => Assoc::default(),
    };
    let Some(first) = words.first() else {
        return (out, Vec::new());
    };
    if keyed_word(first).is_none() {
        for pair in words.chunks(2) {
            out.set(pair[0].clone(), pair.get(1).cloned().unwrap_or_default());
        }
        return (out, Vec::new());
    }
    let mut errors = Vec::new();
    for word in words {
        match keyed_word(word) {
            Some((key, value)) => out.set(key.to_vec(), value.to_vec()),
            None => errors.push(word.clone()),
        }
    }
    (out, errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::new(Arc::new(|| 7))
    }

    fn scalar(store: &Store, name: &str) -> Option<String> {
        store
            .scalar(name)
            .map(|text| String::from_utf8_lossy(text).into_owned())
    }

    #[test]
    fn letters_print_in_bash_order() {
        assert_eq!(letters(UPPER | EXPORT | INTEGER | READONLY), "irxu");
        assert_eq!(attrs_of("xri?"), INTEGER | READONLY | EXPORT);
        let var = Var {
            value: Some(Value::Indexed(Indexed::dense([b"x".to_vec()]))),
            attrs: EXPORT,
            managed: None,
        };
        assert_eq!(var.cluster(), "ax");
    }

    #[test]
    fn indexed_arrays_are_sparse() {
        let mut array = Indexed::default();
        array.set(9, b"j".to_vec());
        array.set(1, b"b".to_vec());
        array.set(3, b"d".to_vec());
        assert_eq!(array.extent(), 10);
        assert_eq!(array.slice(2, None), vec![&b"d"[..], b"j"]);
        assert_eq!(array.slice(-9, Some(-1)), vec![&b"b"[..], b"d"]);
        assert_eq!(array.slice(-11, None), Vec::<&[u8]>::new());
        array.unset(9);
        assert_eq!(array.extent(), 4);
    }

    #[test]
    fn assoc_keeps_first_assignment_order() {
        let mut map: Assoc = [
            (b"b".to_vec(), b"1".to_vec()),
            (b"a".to_vec(), b"2".to_vec()),
        ]
        .into_iter()
        .collect();
        map.set(b"b".to_vec(), b"3".to_vec());
        map.set(b"c".to_vec(), b"4".to_vec());
        assert_eq!(map.remove(b"a"), Some(b"2".to_vec()));
        let keys: Vec<_> = map.iter().map(|(k, _)| k.to_vec()).collect();
        assert_eq!(keys, vec![b"b".to_vec(), b"c".to_vec()]);
        assert_eq!(map.get(b"c"), Some(&b"4"[..]));
        assert_eq!(Value::Assoc(Box::new(map)).rendering(), b"3 4");
    }

    #[test]
    fn references_follow_and_cycles_read_unset() {
        let mut store = store();
        store.seed("v", Value::Scalar(b"x".to_vec()));
        store.seed("r", Value::Scalar(b"v".to_vec()));
        store.set_attr("r", Some(NAMEREF), true);
        assert_eq!(scalar(&store, "r").as_deref(), Some("x"));
        store.seed("a", Value::Scalar(b"b".to_vec()));
        store.set_attr("a", Some(NAMEREF), true);
        store.seed("b", Value::Scalar(b"a".to_vec()));
        store.set_attr("b", Some(NAMEREF), true);
        assert_eq!(store.deref("a"), "");
        assert_eq!(store.target("a"), "a");
        assert_eq!(scalar(&store, "a"), None);
    }

    #[test]
    fn names_list_what_a_lookup_finds() {
        let mut store = store();
        store.seed("s", Value::Scalar(b"x".to_vec()));
        store.seed("arr", Value::Indexed(Indexed::dense([b"p".to_vec()])));
        store.seed("SECRET", Value::Scalar(b"k".to_vec()));
        store.seed("r", Value::Scalar(b"arr".to_vec()));
        store.set_attr("r", Some(NAMEREF), true);
        store.set_attr("d", None, true);
        store.hide_vars(&["SECRET".to_owned()], &[]);
        assert_eq!(store.visible_names(Kind::Scalar), vec!["s"]);
        assert_eq!(store.visible_names(Kind::Indexed), vec!["arr", "r"]);
        assert!(store.visible_names(Kind::Assoc).is_empty());
    }

    #[test]
    fn held_bytes_follow_every_change() {
        let mut store = store();
        store.seed("AB", Value::Scalar(b"xyz".to_vec()));
        assert_eq!(store.held(), 5);
        store.seed(
            "A",
            Value::Indexed(Indexed::dense([b"".to_vec(), b"q".to_vec()])),
        );
        assert_eq!(store.held(), 5 + 1 + 1 + 2);
        store.place("AB", None);
        assert_eq!(store.held(), 4);
    }

    #[test]
    fn forks_share_records_until_one_writes() {
        let mut store = store();
        store.seed("x", Value::Scalar(b"1".to_vec()));
        store.seed("y", Value::Scalar(b"2".to_vec()));
        let mut child = store.subshell();
        let forked = store.fork();
        assert!(Arc::ptr_eq(&store.vars, &child.vars));
        assert!(Arc::ptr_eq(&store.vars, &forked.vars));
        child.seed("x", Value::Scalar(b"three".to_vec()));
        child.drop_var("y");
        assert_eq!(store.scalar("x"), Some(&b"1"[..]));
        assert_eq!(store.scalar("y"), Some(&b"2"[..]));
        assert_eq!(forked.scalar("x"), Some(&b"1"[..]));
        assert_eq!(child.scalar("x"), Some(&b"three"[..]));
        assert_eq!(child.scalar("y"), None);
        assert_eq!((store.held(), child.held()), (4, 6));
        store.seed("z", Value::Scalar(b"3".to_vec()));
        assert!(Arc::ptr_eq(&store.vars["y"], &forked.vars["y"]));
        assert_eq!(forked.scalar("z"), None);
    }

    #[test]
    fn a_version_moves_with_every_change_and_copies_share_it() {
        let mut store = store();
        store.seed("x", Value::Scalar(b"1".to_vec()));
        let before = store.version();
        let forked = store.fork();
        assert_eq!(forked.version(), before);
        store.drop_var("absent");
        assert_eq!(store.version(), before);
        store.set_attr("x", Some(EXPORT), true);
        let marked = store.version();
        assert_ne!(marked, before);
        store.seed("x", Value::Scalar(b"2".to_vec()));
        assert_ne!(store.version(), marked);
        assert_eq!(forked.version(), before);
    }

    #[test]
    fn exported_lists_set_exported_scalars() {
        let mut store = store();
        store.seed("X", Value::Scalar(b"hello".to_vec()));
        store.land("Y", Value::Scalar(b"world".to_vec()), true);
        store.set_attr("Z", Some(EXPORT), true);
        assert_eq!(store.exported(), vec![("Y", &b"world"[..])]);
    }

    #[test]
    fn unset_in_function_reveals_the_enclosing_scope() {
        let mut store = store();
        store.seed("x", Value::Scalar(b"old".to_vec()));
        let temp = store.open_temp();
        store.save_temp(temp, "x");
        store.seed("x", Value::Scalar(b"pre".to_vec()));
        let outer = store.enter();
        assert!(store.in_call_env("x"));
        store.drop_var("x");
        assert_eq!(scalar(&store, "x").as_deref(), Some("old"));
        store.leave(outer);
        store.close_temp(temp);
        assert_eq!(scalar(&store, "x").as_deref(), Some("old"));
    }

    #[test]
    fn locals_shadow_and_come_back() {
        let mut store = store();
        store.seed("v", Value::Scalar(b"global".to_vec()));
        let outer = store.enter();
        store.shadow("v");
        store.seed("v", Value::Scalar(b"local".to_vec()));
        store.drop_var("v");
        assert_eq!(scalar(&store, "v"), None);
        store.leave(outer);
        assert_eq!(scalar(&store, "v").as_deref(), Some("global"));
    }

    #[test]
    fn declare_g_reaches_past_the_local() {
        let mut store = store();
        let outer = store.enter();
        store.shadow("G");
        store.seed("G", Value::Scalar(b"5".to_vec()));
        store.reach_global(&["G".to_owned()]);
        assert_eq!(scalar(&store, "G"), None);
        store.seed("G", Value::Scalar(b"1".to_vec()));
        store.unreach();
        assert_eq!(scalar(&store, "G").as_deref(), Some("5"));
        store.leave(outer);
        assert_eq!(scalar(&store, "G").as_deref(), Some("1"));
    }

    #[test]
    fn random_matches_bash_after_a_seed() {
        let mut store = store();
        store.seed(RANDOM, Value::Scalar(b"42".to_vec()));
        let draws: Vec<u32> = (0..3)
            .map(|_| store.next_random().unwrap().unwrap())
            .collect();
        assert_eq!(draws, vec![17772, 26794, 1435]);
        store.drop_var(RANDOM);
        assert_eq!(store.next_random().unwrap(), None);
    }

    #[test]
    fn integer_coercion_reads_the_session_and_keeps_its_writes() {
        let mut store = store();
        store.seed("x", Value::Scalar(b"4".to_vec()));
        let mut coercion = Coercion::default();
        let value = store
            .coerce(
                &mut coercion,
                Value::Scalar(b"y=x*2, y+1".to_vec()),
                INTEGER,
                None,
                None,
            )
            .unwrap();
        assert_eq!(value, Value::Scalar(b"9".to_vec()));
        assert_eq!(coercion.writes.len(), 1);
        assert_eq!(coercion.writes[0].name, "y");
        let lower = store
            .coerce(
                &mut coercion,
                Value::Scalar("ÀBC\u{3A3}".into()),
                LOWER,
                None,
                None,
            )
            .unwrap();
        assert_eq!(lower, Value::Scalar("àbcς".into()));
    }

    #[test]
    fn negative_subscripts_count_back_or_fail() {
        let mut store = store();
        store.seed(
            "a",
            Value::Indexed(Indexed::dense([b"p".to_vec(), b"q".to_vec()])),
        );
        let mut draws = Draws::default();
        let outcome = store.arith(&mut draws, b"a[-1]", None, false);
        assert_eq!(outcome.value.ok(), Some(0));
        store.seed(
            "n",
            Value::Indexed(Indexed::dense([b"5".to_vec(), b"6".to_vec()])),
        );
        let outcome = store.arith(&mut draws, b"n[-1] + n", None, false);
        assert_eq!(outcome.value.ok(), Some(11));
        let outcome = store.arith(&mut draws, b"n[-3]", None, false);
        match outcome.value {
            Err(arith::Error::Arith {
                reason, expression, ..
            }) => {
                assert_eq!(reason, "bad array subscript");
                assert_eq!(expression, b"n[-3]");
            }
            _ => panic!("expected a bad subscript"),
        }
    }

    #[test]
    fn literals_pick_their_grammar_from_the_first_word() {
        let words: Vec<Vec<u8>> = vec![b"k".to_vec(), b"v".to_vec(), b"odd".to_vec()];
        let (map, errors) = assoc_literal(None, &words, false);
        assert!(errors.is_empty());
        assert_eq!(map.get(b"odd"), Some(&b""[..]));
        let words: Vec<Vec<u8>> = vec![b"[a]=1".to_vec(), b"plain".to_vec()];
        let (map, errors) = assoc_literal(None, &words, false);
        assert_eq!(map.get(b"a"), Some(&b"1"[..]));
        assert_eq!(errors, vec![b"plain".to_vec()]);
        assert_eq!(keyed_word(b"[]=x"), None);
        assert_eq!(strip_key_quotes(b"\"x\""), b"x");
    }
}
