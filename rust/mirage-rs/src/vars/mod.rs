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

mod reading;
mod value;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::arith::{self, Halt, Outcome, Vars};
use crate::policy::{VarScope, Visibility, VisibilityMatcher};

use reading::Reading;
use value::saves_alike;
pub use value::{Assoc, Indexed, Kind, Managed, Slot, Value, Var, entry_bytes};

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
/// An array `declare -a` / `-A` made and nothing assigned yet: it lists
/// with no value and no letter, and the first write clears it.
pub const UNASSIGNED: u8 = 1 << 7;

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
/// The running command's line and the process running it, which the
/// shell computes at each read until `unset` makes them ordinary names.
pub const LINENO: &str = "LINENO";
pub const BASHPID: &str = "BASHPID";
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

/// The stamps the stores' records take, each used once across every store.
static STAMPS: AtomicU64 = AtomicU64::new(1);

/// A stamp no store has taken.
fn fresh_stamp() -> u64 {
    STAMPS.fetch_add(1, Ordering::Relaxed)
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
    /// A fresh stamp on every change to the records or the hidden names.
    stamp: u64,
    /// `${PIPESTATUS[@]}`: each stage's status in the last pipeline.
    pipe_status: Vec<i32>,
    /// `${FUNCNAME[@]}`: the running functions, innermost first; None
    /// once `unset FUNCNAME` made it an ordinary name.
    function_names: Option<Vec<Vec<u8>>>,
    /// `$LINENO`, the running command's line, and `$BASHPID`, the process
    /// running it.
    line: usize,
    bash_pid: u32,
    /// `LINENO` and `BASHPID` once unset: ordinary names from then on.
    plain: Vec<String>,
    /// Whether `LINENO` or `BASHPID` was plain where a frame made it
    /// local, one entry per local, innermost last.
    local_plain: Vec<(String, bool)>,
    /// How the shell leads a diagnostic of its own (`bash: line 3: `).
    voice: Vec<u8>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("vars", &self.vars)
            .field("held", &self.held)
            .finish_non_exhaustive()
    }
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
            stamp: fresh_stamp(),
            pipe_status: Vec::new(),
            function_names: Some(Vec::new()),
            line: 0,
            bash_pid: 0,
            plain: Vec::new(),
            local_plain: Vec::new(),
            voice: b"bash: ".to_vec(),
        }
    }

    /// Set what the shell keeps of its own: each stage's status in the
    /// last pipeline, the running functions, innermost first, the running
    /// command's line, the process running it, and the voice its
    /// diagnostics lead with.
    pub fn set_specials(
        &mut self,
        pipe_status: Vec<i32>,
        function_names: Option<Vec<Vec<u8>>>,
        line: usize,
        bash_pid: u32,
        voice: Vec<u8>,
    ) {
        self.pipe_status = pipe_status;
        self.function_names = function_names;
        self.line = line;
        self.bash_pid = bash_pid;
        self.voice = voice;
    }

    /// How the shell leads a diagnostic of its own: the name of what it is
    /// reading and the running command's line (`bash: line 3: `).
    pub fn voice(&self) -> &[u8] {
        &self.voice
    }

    /// What a read of `$LINENO` or `$BASHPID` computes, through a
    /// reference: the running command's line, the process running it;
    /// None for any other name, a hidden one, or one unset or made local
    /// since, which reads as it was assigned.
    pub fn dynamic(&self, name: &str) -> Option<Vec<u8>> {
        let name = self.target(name);
        if self.hidden(&name) || self.plain.contains(&name) {
            return None;
        }
        match name.as_str() {
            LINENO => Some(self.line.to_string().into_bytes()),
            BASHPID => Some(self.bash_pid.to_string().into_bytes()),
            _ => None,
        }
    }

    /// End `LINENO`'s or `BASHPID`'s special meaning; no other name has one
    /// to end.
    fn make_plain(&mut self, name: &str) {
        if (name == LINENO || name == BASHPID) && !self.plain.iter().any(|plain| plain == name) {
            self.plain.push(name.to_owned());
        }
    }

    /// `PIPESTATUS`, and `FUNCNAME` until `unset FUNCNAME`, from the shell's
    /// own bookkeeping, which a lookup and arithmetic answer, through a
    /// reference too, and an assignment never reaches; None for every other
    /// name, or a hidden one.
    pub fn special(&self, name: &str) -> Option<Indexed> {
        let name = self.target(name);
        let array = match (name.as_str(), &self.function_names) {
            ("PIPESTATUS", _) => Indexed::dense(
                self.pipe_status
                    .iter()
                    .map(|status| status.to_string().into_bytes()),
            ),
            ("FUNCNAME", Some(names)) => Indexed::dense(names.iter().cloned()),
            _ => return None,
        };
        (!self.hidden(&name)).then_some(array)
    }

    /// The names set now whose value the shell computes at each read, which
    /// `${!prefix@}` lists beside the stored ones: `PIPESTATUS` once a
    /// command has run, `FUNCNAME` inside a function, and `RANDOM`,
    /// `LINENO` and `BASHPID` until each is no longer special.
    pub fn computed(&self) -> impl Iterator<Item = &'static str> + '_ {
        [RANDOM, LINENO, BASHPID, "PIPESTATUS", "FUNCNAME"]
            .into_iter()
            .filter(|&name| {
                self.random_special(name)
                    || self.dynamic(name).is_some()
                    || self.special(name).is_some_and(|array| !array.is_empty())
            })
    }

    /// Whether this store saves as `other` does, record for record. A
    /// fork that has written nothing shares the records outright, and a
    /// write undone (`TMP=x true`) puts back the record it replaced, so a
    /// host holding a fork of what it saved tells whether to save again
    /// without reading the records out.
    pub fn same_records(&self, other: &Store) -> bool {
        Arc::ptr_eq(&self.vars, &other.vars)
            || self.vars.len() == other.vars.len()
                && self.vars.iter().all(|(name, var)| {
                    other
                        .vars
                        .get(name)
                        .is_some_and(|theirs| Arc::ptr_eq(var, theirs) || saves_alike(var, theirs))
                })
    }

    /// Draw first seeds from `ids` from now on.
    pub fn set_ids(&mut self, ids: Ids) {
        self.ids = ids;
    }

    /// Hide the names `matcher` hides: they read as unset and refuse
    /// writes.
    pub fn hide(&mut self, matcher: Option<Arc<VisibilityMatcher>>) {
        self.hidden = matcher;
        self.stamp = fresh_stamp();
    }

    /// The stamp the records and the names hidden from them carry now: a
    /// fork keeps its source's until it changes, so a stamp names one view
    /// of the records, which a host keys what it derives from them by.
    pub fn stamp(&self) -> u64 {
        self.stamp
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

    /// The bytes the variables hold: every record, names and values, and
    /// the records a running prefix assignment set aside, which bash keeps
    /// too.
    pub fn held(&self) -> usize {
        self.held + self.aside()
    }

    /// The bytes of what each prefix scope saved and of the values a
    /// `declare -g` reaching past one put aside, each unless the variables
    /// hold it again.
    fn aside(&self) -> usize {
        let temp = |index: usize| self.frames.get(index).is_some_and(|frame| frame.temp);
        let saved = self
            .frames
            .iter()
            .filter(|frame| frame.temp)
            .flat_map(|frame| frame.saved.iter());
        let reached = self
            .reached
            .iter()
            .filter(|(_, index, _)| temp(*index))
            .map(|(name, _, running)| (name, running));
        saved
            .chain(reached)
            .filter_map(|(name, var)| var.as_ref().map(|var| (name, var)))
            .filter(|(name, var)| {
                !self
                    .vars
                    .get(name.as_str())
                    .is_some_and(|held| Arc::ptr_eq(held, var))
            })
            .map(|(name, var)| entry_bytes(name, var.value.as_ref()))
            .sum()
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
        self.stamp = fresh_stamp();
        let vars = Arc::make_mut(&mut self.vars);
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

    /// Whether characters are UTF-8 here, as setlocale reads it: the
    /// first of `LC_ALL`, `LC_CTYPE` and `LANG` that is set and not empty
    /// names a `language[_territory][.codeset][@modifier]` whose codeset,
    /// case and punctuation dropped, is `utf8`. Otherwise a character is a
    /// byte, as in the C locale.
    pub fn utf8(&self) -> bool {
        ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .find_map(|name| self.scalar(name).filter(|value| !value.is_empty()))
            .is_some_and(|locale| {
                let name = locale.split(|&b| b == b'@').next().unwrap_or_default();
                let codeset = name
                    .iter()
                    .position(|&b| b == b'.')
                    .map_or(&[][..], |dot| &name[dot + 1..]);
                let folded: Vec<u8> = codeset
                    .iter()
                    .filter(|b| b.is_ascii_alphanumeric())
                    .map(u8::to_ascii_lowercase)
                    .collect();
                folded == b"utf8"
            })
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

    /// The element `slot` of the array `name` holds, None when the record
    /// holds no array of that kind or the slot no element.
    pub fn element(&self, name: &str, slot: &Slot) -> Option<&[u8]> {
        self.record(name)?.value.as_ref()?.element(slot)
    }

    /// Write one element of the array `name` holds in place, or clear it
    /// with None, keeping the indexes after it, as `land` stores a whole
    /// value: the record assigned, a managed pointer dropped, exported
    /// under `set -a`. The table and the record are copied first only
    /// while a fork or a saved scope shares them. False when the record
    /// holds no array of the slot's kind.
    pub fn put_element(
        &mut self,
        name: &str,
        slot: &Slot,
        text: Option<Vec<u8>>,
        allexport: bool,
    ) -> bool {
        if !self
            .record(name)
            .and_then(|var| var.value.as_ref())
            .is_some_and(|value| value.is_array())
        {
            return false;
        }
        let grown = text.as_deref().map_or(0, |text| slot.bytes(text));
        let Some(var) = Arc::make_mut(&mut self.vars).get_mut(name) else {
            return false;
        };
        let var = Arc::make_mut(var);
        let Some(old) = var.value.as_mut().and_then(|value| value.put(slot, text)) else {
            return false;
        };
        var.attrs &= !UNASSIGNED;
        var.managed = None;
        if allexport {
            var.attrs |= EXPORT;
        }
        self.held = self.held + grown - old.map_or(0, |old| slot.bytes(&old));
        self.stamp = fresh_stamp();
        true
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
        self.make_plain(name);
        (old, frame)
    }

    /// What makes `RANDOM`, `LINENO` and `BASHPID` special as it stands,
    /// for an undo.
    pub fn marks(&self) -> (Seed, Vec<String>) {
        (self.random_seed.clone(), self.plain.clone())
    }

    /// Put back what `drop_var` dropped, after a refusal: the value the
    /// unset revealed goes back to its scope before the name's own record.
    pub fn undrop(
        &mut self,
        name: &str,
        old: Option<Arc<Var>>,
        frame: Option<usize>,
        marks: (Seed, Vec<String>),
    ) {
        let unsaved = frame.filter(|&index| {
            index < self.frames.len() && !self.frames[index].saved.contains_key(name)
        });
        if let Some(index) = unsaved {
            let revealed = self.vars.get(name).cloned();
            self.frames[index].saved.insert(name.to_owned(), revealed);
        }
        self.place(name, old);
        (self.random_seed, self.plain) = marks;
    }

    /// Open a function's scope; returns the caller's, for `leave`.
    pub fn enter(&mut self) -> Option<usize> {
        let outer = self.local;
        self.local = Some(self.frames.len());
        self.frames.push(Frame::default());
        outer
    }

    /// Close the running function's scope: its shadowed records come back,
    /// a local `RANDOM` hands the caller's generator back, and a local
    /// `LINENO` or `BASHPID` the meaning the caller's had. Deliberate
    /// divergence: bash reseeds the generator there; mirage resumes the
    /// caller's sequence where it left off. An `outer` scope no frame
    /// holds is the top level.
    pub fn leave(&mut self, outer: Option<usize>) {
        if let Some(frame) = self.frames.pop() {
            let random = frame.saved.contains_key(RANDOM);
            let specials = [LINENO, BASHPID]
                .iter()
                .filter(|name| frame.saved.contains_key(**name))
                .count();
            for (name, old) in frame.saved {
                self.place(&name, old);
            }
            if random {
                self.random_seed = self.local_random.pop().unwrap_or(Seed::Fresh);
            }
            for (name, plain) in self
                .local_plain
                .split_off(self.local_plain.len().saturating_sub(specials))
            {
                self.plain.retain(|held| *held != name);
                if plain {
                    self.plain.push(name);
                }
            }
        }
        self.local = outer.filter(|&index| index < self.frames.len());
    }

    /// Whether a function is running.
    pub fn in_function(&self) -> bool {
        self.local.is_some()
    }

    /// The names the running function made local, sorted; none at top
    /// level.
    pub fn locals(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .local
            .map(|index| self.frames[index].saved.keys().cloned().collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Whether the running function made `name` local already.
    pub fn is_local(&self, name: &str) -> bool {
        self.local
            .is_some_and(|index| self.frames[index].saved.contains_key(name))
    }

    /// Record the caller's record before a `local` shadows it, once per
    /// scope. A local `RANDOM` is an ordinary variable for the function's
    /// extent (`local RANDOM=5; echo $RANDOM` prints 5), and so is a local
    /// `LINENO` or `BASHPID`, its `unset` the function's own, unless `-I`
    /// (`inherit`) keeps the meaning the caller's has.
    pub fn shadow(&mut self, name: &str, inherit: bool) {
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
        } else if name == LINENO || name == BASHPID {
            let plain = self.plain.iter().any(|held| held == name);
            self.local_plain.push((name.to_owned(), plain));
            if !inherit {
                self.make_plain(name);
            }
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

    /// Save `name`'s record in the prefix scope `index`, once; an index no
    /// frame holds saves nothing.
    pub fn save_temp(&mut self, index: usize, name: &str) {
        let Some(frame) = self.frames.get_mut(index) else {
            return;
        };
        if !frame.saved.contains_key(name) {
            frame
                .saved
                .insert(name.to_owned(), self.vars.get(name).cloned());
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
    /// starts afresh unless `unset RANDOM` ended it, and `LINENO` and
    /// `BASHPID` as special as they were.
    pub fn fork(&self) -> Self {
        let mut forked = Self::new(self.ids.clone());
        forked.vars = self.vars.clone();
        forked.held = self.held;
        forked.stamp = self.stamp;
        forked.hidden = self.hidden.clone();
        forked.pipe_status = self.pipe_status.clone();
        forked.function_names = self.function_names.clone();
        forked.line = self.line;
        forked.bash_pid = self.bash_pid;
        forked.plain = self.plain.clone();
        forked.voice = self.voice.clone();
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

    /// Whether `RANDOM` is special here: not hidden, not ended.
    fn random_special(&self, name: &str) -> bool {
        name == RANDOM && !self.hidden(name) && self.random_seed != Seed::Off
    }

    /// One `$RANDOM` read: a draw from the generator, or None once it is
    /// no longer special, or hidden. A value the host seeded is consumed on
    /// its first read; a seed that does not evaluate is an arithmetic error.
    pub fn next_random(&mut self) -> Result<Option<u32>, arith::Error> {
        let stored = self.scalar(RANDOM).map(<[u8]>::to_vec);
        if !self.random_special(RANDOM) || (stored.is_none() && self.random_seed != Seed::Fresh) {
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
        let outcome = reading.evaluate(word, None, false, &[], false);
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
    /// write to a readonly name, its subscripts expanding first when
    /// `expand` (a `let` operand, an `-i` value). The writes come back for
    /// the caller to land through the gate.
    pub fn arith(
        &mut self,
        draws: &mut Draws,
        text: &[u8],
        added: Option<&[u8]>,
        nounset: bool,
        expand: bool,
    ) -> Outcome {
        let mut reading = Reading {
            store: self,
            draws: Some(draws),
            kept: None,
        };
        let store = &reading.store;
        let dynamic: Vec<String> = [RANDOM, LINENO, BASHPID]
            .into_iter()
            .filter(|&name| store.random_special(name) || store.dynamic(name).is_some())
            .map(str::to_owned)
            .collect();
        reading.evaluate(text, added, nounset, &dynamic, expand)
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
        let outcome = self.arith(&mut coercion.draws, text, added, false, true);
        self.step_forward(globals);
        coercion.writes.extend(outcome.writes);
        outcome.value.map(|value| value.to_string().into_bytes())
    }

    /// Shape one scalar as its name's attributes say, at the write, as
    /// bash does: integer first, then case, which in the C locale changes
    /// only ASCII letters.
    /// Shape one text as attributes `attrs` say: evaluated under `-i`
    /// (`added` an integer `+=`'s text), cased under `-l` or `-u`.
    pub fn coerce_text(
        &mut self,
        coercion: &mut Coercion,
        text: Vec<u8>,
        attrs: u8,
        added: Option<&[u8]>,
    ) -> Result<Vec<u8>, arith::Error> {
        if attrs & (INTEGER | LOWER | UPPER) == 0 {
            return Ok(text);
        }
        let text = if attrs & INTEGER != 0 {
            self.evaluate_integer(coercion, &text, added)?
        } else {
            text
        };
        let utf8 = self.utf8();
        Ok(match (attrs & LOWER != 0, attrs & UPPER != 0) {
            (true, _) if utf8 => recase(&text, str::to_lowercase),
            (true, _) => text.to_ascii_lowercase(),
            (_, true) if utf8 => recase(&text, str::to_uppercase),
            (_, true) => text.to_ascii_uppercase(),
            _ => text,
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
                for (key, text) in *map {
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

/// An associative subscript with one surrounding quote pair removed: an
/// arithmetic reference carries its subscript as typed (`m["x"]`).
pub fn strip_key_quotes(text: &[u8]) -> &[u8] {
    match text {
        [open, inner @ .., close] if open == close && matches!(open, b'"' | b'\'') => inner,
        _ => text,
    }
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
        array.0.remove(&9);
        assert_eq!(array.extent(), 4);
        assert_eq!(array.back(-4), 0);
        assert_eq!(array.back(-5), -1);
        array.set(i64::MAX, b"x".to_vec());
        assert_eq!(array.extent(), i128::from(i64::MAX) + 1);
        assert_eq!(array.back(-1), i64::MAX);
        assert_eq!(array.back(i64::MIN), 0);
        assert_eq!(array.slice(-1, None), vec![&b"x"[..]]);
        assert_eq!(array.slice(0, None), vec![&b"b"[..], b"d", b"x"]);
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
        let keys: Vec<Vec<u8>> = (0..20).map(|n| format!("k{n}").into_bytes()).collect();
        for key in &keys {
            map.set(key.clone(), b"v".to_vec());
        }
        for key in &keys[..18] {
            map.remove(key);
        }
        let kept: Vec<_> = map.iter().map(|(k, _)| k.to_vec()).collect();
        assert_eq!(
            kept,
            vec![
                b"b".to_vec(),
                b"c".to_vec(),
                keys[18].clone(),
                keys[19].clone()
            ]
        );
        assert_eq!((map.len(), map.get(&keys[19])), (4, Some(&b"v"[..])));
        map.remove(&keys[18]);
        map.remove(&keys[19]);
        assert_eq!(Value::Assoc(Box::new(map)).rendering(), b"3 4");
    }

    #[test]
    fn an_element_lands_in_place_unless_a_fork_shares_the_record() {
        let mut store = store();
        store.seed("a", Value::Indexed(Indexed::dense([b"x".to_vec()])));
        let record = Arc::as_ptr(&store.vars["a"]);
        let stamp = store.stamp();
        assert!(store.put_element("a", &Slot::Index(5), Some(b"yz".to_vec()), false));
        assert!(std::ptr::eq(record, Arc::as_ptr(&store.vars["a"])));
        assert_ne!(store.stamp(), stamp);
        assert_eq!(store.held(), 1 + 2 + 3);
        let forked = store.fork();
        assert_eq!(forked.stamp(), store.stamp());
        assert!(store.put_element("a", &Slot::Index(0), None, false));
        assert_eq!(forked.indexed("a").map(Indexed::count), Some(2));
        assert_eq!(store.indexed("a").map(Indexed::count), Some(1));
        assert_eq!(store.held(), 1 + 3);
        let key = Slot::Key(b"k".to_vec());
        assert!(!store.put_element("a", &key, Some(b"v".to_vec()), false));
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
    fn a_fork_holds_the_same_records_until_one_changes_and_stays() {
        let mut store = store();
        store.seed("x", Value::Scalar(b"1".to_vec()));
        let saved = store.fork();
        assert!(store.same_records(&saved));
        store.drop_var("absent");
        assert!(store.same_records(&saved));
        let old = store.place("x", Some(Arc::new(Var::scalar("2"))));
        assert!(!store.same_records(&saved));
        store.place("x", old);
        store.place("y", Some(Arc::new(Var::scalar("3"))));
        store.place("y", None);
        assert!(store.same_records(&saved));
        store.seed("x", Value::Scalar(b"1".to_vec()));
        assert!(store.same_records(&saved));
        store.set_attr("x", Some(EXPORT), true);
        assert!(!store.same_records(&saved));
        assert!(saved.same_records(&saved.fork()));
    }

    #[test]
    fn a_prefix_scope_holds_what_it_set_aside_until_it_closes() {
        let mut store = store();
        store.seed("x", Value::Scalar(b"old".to_vec()));
        assert_eq!(store.held(), 4);
        let temp = store.open_temp();
        store.save_temp(temp, "x");
        store.seed("x", Value::Scalar(b"new!".to_vec()));
        assert_eq!(store.held(), 5 + 4);
        store.enter();
        store.reach_global(&["x".to_owned()]);
        assert_eq!(store.held(), 4 + 5);
        store.seed("x", Value::Scalar(b"global".to_vec()));
        assert_eq!(store.held(), 7 + 4 + 5);
        store.unreach();
        assert_eq!(store.held(), 5 + 7);
        store.leave(None);
        store.close_temp(temp);
        assert_eq!(store.held(), 7);
    }

    #[test]
    fn a_fetched_secret_saves_as_its_pointer() {
        let mut store = store();
        let pointer = Managed {
            source: "aws-sm".into(),
            reference: "prod".into(),
            key: String::new(),
            eager: false,
        };
        let managed = |value: Option<Value>, reference: &str| {
            Arc::new(Var {
                value,
                managed: Some(Box::new(Managed {
                    reference: reference.into(),
                    ..pointer.clone()
                })),
                ..Var::default()
            })
        };
        store.place("TOKEN", Some(managed(None, "prod")));
        let saved = store.fork();
        store.place(
            "TOKEN",
            Some(managed(Some(Value::Scalar(b"s3cret".to_vec())), "prod")),
        );
        assert!(store.same_records(&saved));
        store.place("TOKEN", Some(managed(None, "dev")));
        assert!(!store.same_records(&saved));
        store.land("TOKEN", Value::Scalar(b"mine".to_vec()), false);
        assert!(!store.same_records(&saved));
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
        store.shadow("v", false);
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
        store.shadow("G", false);
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
        let mut hidden = self::store();
        hidden.hide_vars(&[RANDOM.to_owned()], &[]);
        assert_eq!(hidden.next_random().unwrap(), None);
        assert_eq!(hidden.scalar(RANDOM), None);
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
        let mut lower = |store: &mut Store| {
            store
                .coerce(
                    &mut coercion,
                    Value::Scalar("ÀBC\u{3A3}".into()),
                    LOWER,
                    None,
                    None,
                )
                .unwrap()
        };
        assert_eq!(lower(&mut store), Value::Scalar("Àbc\u{3A3}".into()));
        store.seed("LC_ALL", Value::Scalar(b"C.UTF-8".to_vec()));
        assert_eq!(lower(&mut store), Value::Scalar("àbcς".into()));
    }

    #[test]
    fn arithmetic_reads_the_shell_s_own_arrays() {
        let mut store = store();
        store.set_specials(
            vec![1, 0],
            Some(vec![b"f".to_vec(), b"main".to_vec()]),
            0,
            0,
            Vec::new(),
        );
        let mut draws = Draws::default();
        let outcome = store.arith(
            &mut draws,
            b"PIPESTATUS[0] * 10 + PIPESTATUS[1] + PIPESTATUS + PIPESTATUS[-2]",
            None,
            false,
            false,
        );
        assert_eq!(outcome.value.unwrap(), 12);
        store.set_specials(vec![3], None, 0, 0, Vec::new());
        let outcome = store.arith(
            &mut draws,
            b"PIPESTATUS[0] + FUNCNAME[0]",
            None,
            false,
            false,
        );
        assert_eq!(outcome.value.unwrap(), 3);
        store.seed("r", Value::Scalar(b"PIPESTATUS".to_vec()));
        store.set_attr("r", Some(NAMEREF), true);
        assert_eq!(store.special("r"), Some(Indexed::dense([b"3".to_vec()])));
        let outcome = store.arith(&mut draws, b"r[-1] + r", None, false, false);
        assert_eq!(outcome.value.unwrap(), 6);
        store.hide_vars(&["PIPESTATUS".to_owned()], &[]);
        assert_eq!(store.special("PIPESTATUS"), None);
        assert_eq!(store.special("r"), None);
    }

    #[test]
    fn lineno_and_bashpid_compute_until_unset_or_made_local() {
        let mut store = store();
        store.set_specials(Vec::new(), None, 7, 42, b"bash: line 7: ".to_vec());
        store.seed("r", Value::Scalar(b"LINENO".to_vec()));
        store.set_attr("r", Some(NAMEREF), true);
        assert_eq!(store.dynamic(LINENO), Some(b"7".to_vec()));
        assert_eq!(store.dynamic("r"), Some(b"7".to_vec()));
        assert_eq!(store.dynamic(BASHPID), Some(b"42".to_vec()));
        let mut draws = Draws::default();
        let outcome = store.arith(&mut draws, b"LINENO * 100 + BASHPID", None, false, false);
        assert_eq!(outcome.value.unwrap(), 742);

        let outer = store.enter();
        store.shadow(LINENO, false);
        store.shadow(BASHPID, true);
        assert_eq!(store.dynamic(LINENO), None);
        assert_eq!(store.dynamic(BASHPID), Some(b"42".to_vec()));
        store.drop_var(BASHPID);
        assert_eq!(store.dynamic(BASHPID), None);
        store.leave(outer);
        assert_eq!(store.dynamic(LINENO), Some(b"7".to_vec()));
        assert_eq!(store.dynamic(BASHPID), Some(b"42".to_vec()));

        let marks = store.marks();
        let (old, frame) = store.drop_var(LINENO);
        assert_eq!(store.fork().dynamic(LINENO), None);
        store.undrop(LINENO, old, frame, marks);
        assert_eq!(store.dynamic(LINENO), Some(b"7".to_vec()));

        store.drop_var(LINENO);
        let outer = store.enter();
        store.shadow(LINENO, true);
        assert_eq!(store.dynamic(LINENO), None);
        store.leave(outer);
        assert_eq!(store.subshell().dynamic(LINENO), None);
        store.hide_vars(&[BASHPID.to_owned()], &[]);
        assert_eq!(store.dynamic(BASHPID), None);
    }

    #[test]
    fn scopes_a_host_names_wrongly_change_nothing() {
        let mut store = store();
        store.seed("x", Value::Scalar(b"1".to_vec()));
        store.save_temp(9, "x");
        let temp = store.open_temp();
        store.save_temp(temp, LINENO);
        store.leave(Some(9));
        assert!(!store.in_function());
        store.shadow("x", false);
        assert_eq!(store.locals(), Vec::<String>::new());
        assert_eq!(scalar(&store, "x").as_deref(), Some("1"));
    }

    #[test]
    fn negative_subscripts_count_back_or_fail() {
        let mut store = store();
        store.seed(
            "a",
            Value::Indexed(Indexed::dense([b"p".to_vec(), b"q".to_vec()])),
        );
        let mut draws = Draws::default();
        let outcome = store.arith(&mut draws, b"a[-1]", None, false, false);
        assert_eq!(outcome.value.ok(), Some(0));
        store.seed(
            "n",
            Value::Indexed(Indexed::dense([b"5".to_vec(), b"6".to_vec()])),
        );
        let outcome = store.arith(&mut draws, b"n[-1] + n", None, false, false);
        assert_eq!(outcome.value.ok(), Some(11));
        let outcome = store.arith(&mut draws, b"n[-3]", None, false, false);
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
    fn a_key_loses_one_pair_of_quotes() {
        assert_eq!(strip_key_quotes(b"\"x\""), b"x");
        assert_eq!(strip_key_quotes(b"'x\""), b"'x\"");
    }
}
