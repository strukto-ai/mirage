use std::collections::HashMap;
use std::sync::Arc;

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyBytes, PyDict, PyList, PyTuple};
use streams::arith;
use streams::interp::codec::Item;
use streams::interp::expand::Substitution;
use streams::interp::host::{self, Held};
use streams::interp::job::{Job, Running, Step};
use streams::interp::shell::{Frame, Shell as Inner};
use streams::interp::task::{self, Answer, Ask, Mode, Write};
use streams::interp::write::{Denied, Fault};
use streams::interp::{listing, quote};
use streams::shell::Tree;
use streams::vars::{self, Assigned, Indexed, Kind, Managed, Store, Value, Var};

use crate::shell::ShellNode;
use crate::text::{bytes_of, text_of};

/// A managed variable's pointer as Python passes it: source, reference,
/// key, and whether it is fetched eagerly.
type ManagedTuple = (String, String, String, bool);

fn running() -> PyErr {
    PyRuntimeError::new_err("the shell is running a task")
}

/// The ids a session draws `$RANDOM`'s first seed from: the host's source,
/// a raise reported as unraisable and read as 0.
fn ids(source: Py<PyAny>) -> vars::Ids {
    Arc::new(move || {
        Python::attach(
            |py| match source.call0(py).and_then(|id| id.extract::<u32>(py)) {
                Ok(id) => id,
                Err(err) => {
                    err.write_unraisable(py, None);
                    0
                }
            },
        )
    })
}

/// An engine answer as Python reads it: a list as a list, a tuple as a
/// tuple, a map as a dict, text as shell text and raw bytes as bytes.
fn py_of<'py>(py: Python<'py>, item: &Item) -> PyResult<Bound<'py, PyAny>> {
    let items = |items: &[Item]| {
        items
            .iter()
            .map(|item| py_of(py, item))
            .collect::<PyResult<Vec<_>>>()
    };
    Ok(match item {
        Item::Nil => py.None().into_bound(py),
        Item::Bool(value) => PyBool::new(py, *value).to_owned().into_any(),
        Item::Int(value) | Item::Big(value) => value.into_pyobject(py)?.into_any(),
        Item::Text(text) => text_of(py, text)?,
        Item::Raw(bytes) => PyBytes::new(py, bytes).into_any(),
        Item::List(list) => PyList::new(py, items(list)?)?.into_any(),
        Item::Tuple(tuple) => PyTuple::new(py, items(tuple)?)?.into_any(),
        Item::Map(pairs) => {
            let out = PyDict::new(py);
            for (key, value) in pairs {
                out.set_item(py_of(py, key)?, py_of(py, value)?)?;
            }
            out.into_any()
        }
    })
}

/// A value from Python: text, or a mapping, an associative array's when
/// `assoc`, an indexed one's otherwise.
fn value_in(value: &Bound<'_, PyAny>, assoc: bool) -> PyResult<Value> {
    let Ok(map) = value.cast::<PyDict>() else {
        return Ok(Value::Scalar(bytes_of(value)?));
    };
    if assoc {
        let entries = map
            .iter()
            .map(|(key, element)| Ok((bytes_of(&key)?, bytes_of(&element)?)))
            .collect::<PyResult<Vec<_>>>()?;
        return Ok(Value::Assoc(Box::new(entries.into_iter().collect())));
    }
    let mut array = Indexed::default();
    for (index, element) in map.iter() {
        array.set(index.extract()?, bytes_of(&element)?);
    }
    Ok(Value::Indexed(array))
}

fn record_in(
    value: Option<&Bound<'_, PyAny>>,
    cluster: &str,
    managed: Option<ManagedTuple>,
) -> PyResult<Var> {
    let value = value
        .filter(|value| !value.is_none())
        .map(|value| value_in(value, cluster.starts_with('A')))
        .transpose()?;
    Ok(Var {
        value,
        attrs: vars::attrs_of(cluster),
        managed: managed.map(|(source, reference, key, eager)| {
            Box::new(Managed {
                source,
                reference,
                key,
                eager,
            })
        }),
    })
}

/// One session's shell: its variables, the positional parameters, the
/// special parameters and the options, held in mirage-rs. While a
/// `ShellTask` runs on it the shell is the task's, and any read of it
/// raises until the task finishes.
#[pyclass(module = "mirage._rs")]
pub struct Shell(
    Held,
    /// The host's positional lists the last frame read.
    Option<(Py<PyAny>, Vec<Py<PyAny>>)>,
);

impl Shell {
    fn wrap(inner: Inner) -> Self {
        Self(Held::new(inner), None)
    }

    fn shell(&self) -> PyResult<&Inner> {
        self.0.shell().ok_or_else(running)
    }

    fn shell_mut(&mut self) -> PyResult<&mut Inner> {
        self.0.shell_mut().ok_or_else(running)
    }

    fn store(&self) -> PyResult<&Store> {
        Ok(&self.shell()?.vars)
    }

    fn store_mut(&mut self) -> PyResult<&mut Store> {
        Ok(&mut self.shell_mut()?.vars)
    }

    fn write_task(
        slf: &Bound<'_, Self>,
        write: Write,
        listens: bool,
        warns: bool,
    ) -> PyResult<ShellTask> {
        ShellTask::start(slf, None, |inner| {
            Running::Write(task::write(inner, write, listens, warns))
        })
    }
}

#[pymethods]
impl Shell {
    /// `ids` returns the id a fresh `$RANDOM` generator seeds from.
    #[new]
    fn new(ids_source: Py<PyAny>) -> Self {
        Self::wrap(Inner::new(Store::new(ids(ids_source))))
    }

    /// Draw `$RANDOM`'s first seeds from `ids` from now on.
    fn use_ids(&mut self, ids_source: Py<PyAny>) -> PyResult<()> {
        self.store_mut()?.set_ids(ids(ids_source));
        Ok(())
    }

    /// The raw record a name holds, references not followed, hidden or
    /// not: `(value, cluster, managed)`.
    fn get<'py>(&self, py: Python<'py>, name: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
        self.store()?
            .record(name)
            .map(|var| py_of(py, &host::record_out(var)))
            .transpose()
    }

    /// The record a name stands for, references followed; None when
    /// unset or hidden.
    fn visible<'py>(&self, py: Python<'py>, name: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
        self.store()?
            .visible(name)
            .map(|var| py_of(py, &host::record_out(var)))
            .transpose()
    }

    /// Replace a name's record, or drop it with None, returning the one
    /// it replaced. Shell bookkeeping only: a line's writes run as tasks.
    #[pyo3(signature = (name, record))]
    fn place<'py>(
        &mut self,
        py: Python<'py>,
        name: &str,
        record: Option<(Bound<'py, PyAny>, String, Option<ManagedTuple>)>,
    ) -> PyResult<Option<Bound<'py, PyAny>>> {
        let var = match record {
            Some((value, cluster, managed)) => Some(record_in(Some(&value), &cluster, managed)?),
            None => None,
        };
        self.store_mut()?
            .place(name, var.map(Arc::new))
            .map(|old| py_of(py, &host::record_out(&old)))
            .transpose()
    }

    /// The names a reader lists for one kind of value (`scalar`,
    /// `indexed` or `assoc`), sorted: each a lookup finds.
    fn visible_names(&self, kind: &str) -> PyResult<Vec<String>> {
        let kind: Kind = kind.parse().map_err(PyValueError::new_err)?;
        Ok(self
            .store()?
            .visible_names(kind)
            .into_iter()
            .map(str::to_owned)
            .collect())
    }

    /// What the value a name stands for is (`scalar`, `indexed` or
    /// `assoc`), references followed; None when unset or hidden.
    fn kind(&self, name: &str) -> PyResult<Option<&'static str>> {
        Ok(self
            .store()?
            .visible(name)
            .and_then(|var| var.value.as_ref())
            .map(|value| value.kind().name()))
    }

    /// An indexed array by name as `${a[@]}` reads it, `PIPESTATUS` and
    /// `FUNCNAME` from the last frame; None when unset, hidden or not one.
    fn indexed<'py>(&self, py: Python<'py>, name: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
        self.shell()?
            .indexed(name)
            .map(|array| py_of(py, &host::value_out(&Value::Indexed(array.into_owned()))))
            .transpose()
    }

    /// What a `pre_session` rule is shown for a name's record, references
    /// not followed; None when it is unset.
    fn rendered<'py>(&self, py: Python<'py>, name: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
        self.store()?
            .record(name)
            .and_then(|var| var.value.as_ref())
            .map(|value| text_of(py, &value.rendering()))
            .transpose()
    }

    fn names(&self) -> PyResult<Vec<String>> {
        Ok(self
            .store()?
            .records()
            .map(|(name, _)| name.to_owned())
            .collect())
    }

    /// Every record as `(name, (value, cluster, managed))`, in no order.
    fn records<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let out = PyList::empty(py);
        for (name, var) in self.store()?.records() {
            out.append((name, py_of(py, &host::record_out(var))?))?;
        }
        Ok(out)
    }

    fn __len__(&self) -> PyResult<usize> {
        Ok(self.store()?.records().count())
    }

    fn __contains__(&self, name: &str) -> PyResult<bool> {
        Ok(self.store()?.record(name).is_some())
    }

    /// The stamp the records and the names hidden from them carry, a
    /// fresh one on every change, which a host keys what it derives from
    /// them by.
    fn stamp(&self) -> PyResult<u64> {
        Ok(self.store()?.stamp())
    }

    /// The bytes every record holds, names and values; while a task
    /// runs, what they held as it started.
    fn held(&self) -> usize {
        self.0.held()
    }

    /// Whether this shell holds the records `other` holds, value for
    /// value: a host keeps a fork of what it saved and saves again only
    /// once they part.
    fn same_vars(&self, other: PyRef<'_, Shell>) -> PyResult<bool> {
        Ok(self.store()?.same_records(other.store()?))
    }

    /// Hide the names a session's visibility lists, exactly or by glob.
    fn hide(&mut self, names: Vec<String>, patterns: Vec<String>) -> PyResult<()> {
        self.store_mut()?.hide_vars(&names, &patterns);
        Ok(())
    }

    fn hidden(&self, name: &str) -> PyResult<bool> {
        Ok(self.store()?.hidden(name))
    }

    fn nameref_target(&self, name: &str) -> PyResult<Option<String>> {
        Ok(self.store()?.nameref_target(name).map(str::to_owned))
    }

    /// A name as a diagnostic names it, under the shell's locale: as it is,
    /// or `$'...'` when it does not show as it is.
    fn shown<'py>(&self, py: Python<'py>, value: Bound<'_, PyAny>) -> PyResult<Bound<'py, PyAny>> {
        let utf8 = self.shell()?.utf8();
        text_of(py, &quote::shown(&bytes_of(&value)?, utf8))
    }

    /// The variable a name stands for, references followed.
    fn deref(&self, name: &str) -> PyResult<String> {
        Ok(self.store()?.deref(name))
    }

    /// Where a write to a name lands, references followed.
    fn target(&self, name: &str) -> PyResult<String> {
        Ok(self.store()?.target(name))
    }

    fn is_readonly(&self, name: &str, follow_ref: bool) -> PyResult<bool> {
        Ok(self.store()?.is_readonly(name, follow_ref))
    }

    /// The exported scalars a child process inherits, hidden names left
    /// out.
    fn exported<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let out = PyList::empty(py);
        for (name, value) in self.store()?.exported() {
            out.append((name, text_of(py, value)?))?;
        }
        Ok(out)
    }

    /// Write a value with no gate, as seeding a session does.
    #[pyo3(signature = (name, value, assoc = false))]
    fn seed(&mut self, name: &str, value: Bound<'_, PyAny>, assoc: bool) -> PyResult<()> {
        let value = value_in(&value, assoc)?;
        self.store_mut()?.seed(name, value);
        Ok(())
    }

    /// Set or clear one attribute (its `declare` letter) with no gate.
    #[pyo3(signature = (name, letter, on))]
    fn set_attr(&mut self, name: &str, letter: Option<&str>, on: bool) -> PyResult<()> {
        let attr = letter.map(vars::attrs_of);
        self.store_mut()?.set_attr(name, attr, on);
        Ok(())
    }

    /// Mark an array `declare -a` / `-A` just made as never assigned,
    /// which its first write clears: bookkeeping, not a write.
    fn unassigned(&mut self, name: &str) -> PyResult<()> {
        self.store_mut()?
            .set_attr(name, Some(vars::UNASSIGNED), true);
        Ok(())
    }

    /// Whether `name`'s record is one declared and never assigned, which
    /// a host putting the record back marks again (`unassigned`).
    fn is_unassigned(&self, name: &str) -> PyResult<bool> {
        Ok(self
            .store()?
            .record(name)
            .is_some_and(|var| var.has(vars::UNASSIGNED)))
    }

    /// The line `declare -p` prints for a name, `RANDOM` drawing; None
    /// for one unset or hidden.
    fn declaration<'py>(
        &mut self,
        py: Python<'py>,
        name: &str,
    ) -> PyResult<Option<Bound<'py, PyAny>>> {
        listing::declaration(self.store_mut()?, name)
            .map(|line| text_of(py, &line))
            .transpose()
    }

    /// The lines a bare `declare -p` prints, sorted by name, narrowed by
    /// its option `letters`, the running command's temporaries in `skip`
    /// left out.
    fn listing<'py>(
        &self,
        py: Python<'py>,
        letters: &str,
        skip: Vec<String>,
    ) -> PyResult<Vec<Bound<'py, PyAny>>> {
        listing::listing(self.store()?, letters, &skip)
            .iter()
            .map(|line| text_of(py, line))
            .collect()
    }

    /// The variable lines a bare `set` prints, sorted by name, the running
    /// command's temporaries in `skip` left out.
    fn assignments<'py>(
        &self,
        py: Python<'py>,
        skip: Vec<String>,
    ) -> PyResult<Vec<Bound<'py, PyAny>>> {
        listing::assignments(self.store()?, &skip)
            .iter()
            .map(|line| text_of(py, line))
            .collect()
    }

    /// Open a function call's scope; the token closes it.
    fn enter(&mut self) -> PyResult<Option<usize>> {
        Ok(self.store_mut()?.enter())
    }

    #[pyo3(signature = (outer))]
    fn leave(&mut self, outer: Option<usize>) -> PyResult<()> {
        self.store_mut()?.leave(outer);
        Ok(())
    }

    fn in_function(&self) -> PyResult<bool> {
        Ok(self.store()?.in_function())
    }

    fn is_local(&self, name: &str) -> PyResult<bool> {
        Ok(self.store()?.is_local(name))
    }

    /// The names the running function made local, sorted.
    fn locals(&self) -> PyResult<Vec<String>> {
        Ok(self.store()?.locals())
    }

    /// Set the caller's record aside before a `local` shadows it; with
    /// `inherit` (`local -I`) a `LINENO` or `BASHPID` stays special.
    fn shadow(&mut self, name: &str, inherit: bool) -> PyResult<()> {
        self.store_mut()?.shadow(name, inherit);
        Ok(())
    }

    /// Open a prefix assignment's scope around a function call.
    fn open_temp(&mut self) -> PyResult<usize> {
        Ok(self.store_mut()?.open_temp())
    }

    fn save_temp(&mut self, index: usize, name: &str) -> PyResult<()> {
        self.store_mut()?.save_temp(index, name);
        Ok(())
    }

    fn close_temp(&mut self, index: usize) -> PyResult<()> {
        self.store_mut()?.close_temp(index);
        Ok(())
    }

    /// Let a prefix assignment's value outlive the call (`export`,
    /// `readonly` of the name inside it).
    fn outlive_call(&mut self, name: &str) -> PyResult<()> {
        self.store_mut()?.outlive_call(name);
        Ok(())
    }

    fn in_call_env(&self, name: &str) -> PyResult<bool> {
        Ok(self.store()?.in_call_env(name))
    }

    /// `declare -g`: the names reach global scope until `unreach`.
    fn reach_global(&mut self, names: Vec<String>) -> PyResult<()> {
        self.store_mut()?.reach_global(&names);
        Ok(())
    }

    fn unreach(&mut self) -> PyResult<()> {
        self.store_mut()?.unreach();
        Ok(())
    }

    /// One `$RANDOM` read: the draw, None once RANDOM is not special;
    /// a seed that does not evaluate comes back as its error tuple.
    fn next_random<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        py_of(py, &host::random_out(&self.store_mut()?.next_random()))
    }

    /// The state around a line that the shell reads: the positional
    /// parameters, each running function's, `$?`, `$$`, `$!`, `$0`, the
    /// `set -o` and `shopt` options set, `max_env` and the bytes the
    /// session holds outside its variables, `${PIPESTATUS[@]}`,
    /// `${FUNCNAME[@]}` (None once unset made it an ordinary name),
    /// `${BASH_LINENO[@]}` and whether the shell is a `( )` subshell or a forked stage, the bytes
    /// left under `max_memory` (None for no cap), `$LINENO`, `$BASHPID`,
    /// and the voice the shell's own diagnostics lead with.
    #[pyo3(signature = (*, positional, calls, status, pid, last_job, argv0, options, shopts, env_limit, outside, pipe_status, function_names, call_lines, paren, memory_room, line, bash_pid, voice))]
    #[allow(clippy::too_many_arguments)]
    fn frame(
        &mut self,
        positional: Bound<'_, PyAny>,
        calls: Vec<Bound<'_, PyAny>>,
        status: i32,
        pid: u32,
        last_job: Option<u32>,
        argv0: Bound<'_, PyAny>,
        options: HashMap<String, bool>,
        shopts: HashMap<String, bool>,
        env_limit: Option<usize>,
        outside: usize,
        pipe_status: Vec<i32>,
        function_names: Option<Vec<Bound<'_, PyAny>>>,
        call_lines: Vec<usize>,
        paren: bool,
        memory_room: Option<usize>,
        line: usize,
        bash_pid: u32,
        voice: Bound<'_, PyAny>,
    ) -> PyResult<()> {
        let texts =
            |list: &[Bound<'_, PyAny>]| list.iter().map(bytes_of).collect::<PyResult<Vec<_>>>();
        let read = |list: &Bound<'_, PyAny>| {
            list.try_iter()?
                .map(|item| bytes_of(&item?))
                .collect::<PyResult<Vec<_>>>()
        };
        let (held, held_calls) = match &self.1 {
            Some((held, calls)) => (Some(held.as_ptr()), Some(calls)),
            None => (None, None),
        };
        let same_calls = held_calls.is_some_and(|held| {
            held.len() == calls.len()
                && held
                    .iter()
                    .zip(&calls)
                    .all(|(held, call)| held.as_ptr() == call.as_ptr())
        });
        let framed = Some((
            positional.clone().unbind(),
            calls.iter().map(|call| call.clone().unbind()).collect(),
        ));
        // The host replaces a list rather than change it, so one it handed
        // over before is read already.
        let positional = if held == Some(positional.as_ptr()) {
            None
        } else {
            Some(read(&positional)?)
        };
        let calls = if same_calls {
            None
        } else {
            Some(calls.iter().map(read).collect::<PyResult<Vec<_>>>()?)
        };
        let frame = Frame {
            positional,
            calls,
            status,
            pid,
            last_job,
            argv0: bytes_of(&argv0)?,
            options,
            shopts,
            env_limit,
            outside,
            pipe_status,
            function_names: function_names.as_deref().map(texts).transpose()?,
            call_lines,
            paren,
            memory_room,
            line,
            bash_pid,
            voice: bytes_of(&voice)?,
        };
        self.shell_mut()?.apply(frame);
        self.1 = framed;
        Ok(())
    }

    /// The scalar an array conversion keeps as element 0, a live
    /// `RANDOM` drawing; a seed that does not evaluate comes back as its
    /// error tuple.
    fn conversion_scalar<'py>(
        &mut self,
        py: Python<'py>,
        name: &str,
    ) -> PyResult<Bound<'py, PyAny>> {
        py_of(
            py,
            &host::conversion_out(&self.store_mut()?.conversion_scalar(name)),
        )
    }

    /// A copy for a fork of the session: the same records, a fresh
    /// generator.
    fn fork(&self) -> PyResult<Self> {
        let shell = self.shell()?;
        let mut forked = shell.clone();
        forked.vars = shell.vars.fork();
        Ok(Self::wrap(forked))
    }

    /// A child shell's copy: the scopes too, `$RANDOM` starting anew.
    fn subshell(&self) -> PyResult<Self> {
        Ok(Self::wrap(self.shell()?.subshell()))
    }

    /// Expand `node` as `mode` (`fields`, `text`, `assignment`, `pattern`,
    /// `regex` or `arith`) says; `listens` when a session policy hears writes.
    fn expand(
        slf: &Bound<'_, Self>,
        node: &ShellNode,
        mode: &str,
        listens: bool,
    ) -> PyResult<ShellTask> {
        let mode: Mode = mode.parse().map_err(PyRuntimeError::new_err)?;
        let tree = Arc::clone(&node.tree);
        let index = node.index as usize;
        ShellTask::start(slf, Some((Arc::clone(&tree), node.serial)), |inner| {
            Running::Expand(task::expand(inner, tree, index, mode, listens))
        })
    }

    /// Set a variable through the gate. `value` is text, or a mapping for
    /// an array (`assoc` for an associative one); `assigned` names the
    /// indexes or keys an array write assigns; `added` is an integer
    /// `+=`'s operand.
    #[pyo3(signature = (name, value, *, assoc = false, follow_ref = true, assigned = None, added = None, listens = false, warns = true))]
    #[allow(clippy::too_many_arguments)]
    fn set(
        slf: &Bound<'_, Self>,
        name: String,
        value: Bound<'_, PyAny>,
        assoc: bool,
        follow_ref: bool,
        assigned: Option<Vec<Bound<'_, PyAny>>>,
        added: Option<Bound<'_, PyAny>>,
        listens: bool,
        warns: bool,
    ) -> PyResult<ShellTask> {
        let value = value_in(&value, assoc)?;
        let assigned = match assigned {
            None => None,
            Some(keys) if assoc => Some(Assigned::Keys(
                keys.iter().map(bytes_of).collect::<PyResult<_>>()?,
            )),
            Some(indexes) => Some(Assigned::Indexes(
                indexes
                    .iter()
                    .map(|index| index.extract())
                    .collect::<PyResult<_>>()?,
            )),
        };
        let added = added.as_ref().map(bytes_of).transpose()?;
        let write = Write::Set {
            name,
            value,
            follow_ref,
            assigned,
            added,
        };
        Self::write_task(slf, write, listens, warns)
    }

    #[pyo3(signature = (name, *, follow_ref = true, listens = false))]
    fn unset(
        slf: &Bound<'_, Self>,
        name: String,
        follow_ref: bool,
        listens: bool,
    ) -> PyResult<ShellTask> {
        Self::write_task(slf, Write::Unset { name, follow_ref }, listens, true)
    }

    /// Set or clear an attribute through the gate; no letter declares
    /// the name only.
    #[pyo3(signature = (name, letter, on, *, follow_ref = true, listens = false))]
    fn mark(
        slf: &Bound<'_, Self>,
        name: String,
        letter: Option<&str>,
        on: bool,
        follow_ref: bool,
        listens: bool,
    ) -> PyResult<ShellTask> {
        let attr = letter.map(vars::attrs_of);
        let write = Write::Mark {
            name,
            attr,
            on,
            follow_ref,
        };
        Self::write_task(slf, write, listens, true)
    }

    /// A subscript that is a plain decimal, read without evaluating;
    /// None when it has to be evaluated (`index`).
    fn plain_index(&self, subscript: Bound<'_, PyAny>) -> PyResult<Option<i64>> {
        Ok(arith::plain_decimal(&bytes_of(&subscript)?))
    }

    /// Resolve an indexed array's subscript, what it assigns landed.
    #[pyo3(signature = (subscript, *, listens = false))]
    fn index(
        slf: &Bound<'_, Self>,
        subscript: Bound<'_, PyAny>,
        listens: bool,
    ) -> PyResult<ShellTask> {
        let subscript = bytes_of(&subscript)?;
        Self::write_task(slf, Write::Index { subscript }, listens, true)
    }

    /// Whether a `name` / `name[sub]` reference is set, as `test -v`
    /// asks; what its subscript assigns landed. The result is 1 or 0.
    /// `expanded` for a subscript already expanded, an associative key
    /// then taken verbatim.
    #[pyo3(signature = (reference, *, expanded = false, listens = false))]
    fn is_set(
        slf: &Bound<'_, Self>,
        reference: Bound<'_, PyAny>,
        expanded: bool,
        listens: bool,
    ) -> PyResult<ShellTask> {
        let reference = bytes_of(&reference)?;
        let write = Write::IsSet {
            reference,
            expanded,
        };
        Self::write_task(slf, write, listens, true)
    }

    /// Write one element a builtin names, or a bare name as element 0;
    /// the result is 0 landed, 1 hidden, 2 readonly or 3 a subscript that
    /// names no element. `warns` as for `set`.
    #[pyo3(signature = (name, subscript, value, *, append = false, listens = false, warns = true))]
    #[allow(clippy::too_many_arguments)]
    fn element(
        slf: &Bound<'_, Self>,
        name: String,
        subscript: Option<Bound<'_, PyAny>>,
        value: Bound<'_, PyAny>,
        append: bool,
        listens: bool,
        warns: bool,
    ) -> PyResult<ShellTask> {
        let write = Write::Element {
            name,
            subscript: subscript.as_ref().map(bytes_of).transpose()?,
            value: bytes_of(&value)?,
            append,
        };
        Self::write_task(slf, write, listens, warns)
    }

    /// Append words at an indexed array's extent (`a+=(x y)`).
    #[pyo3(signature = (name, words, *, listens = false))]
    fn push(
        slf: &Bound<'_, Self>,
        name: String,
        words: Vec<Bound<'_, PyAny>>,
        listens: bool,
    ) -> PyResult<ShellTask> {
        let words = words.iter().map(bytes_of).collect::<PyResult<_>>()?;
        Self::write_task(slf, Write::Push { name, words }, listens, true)
    }

    /// Clear one element (`unset 'a[i]'`), or every one when `every`, a
    /// subscript typed as `@` or `*`; the result is 0 cleared, 3 a
    /// subscript that names no element or 4 one other than 0 on a scalar.
    #[pyo3(signature = (name, subscript, *, every = false, listens = false))]
    fn unset_element(
        slf: &Bound<'_, Self>,
        name: String,
        subscript: Bound<'_, PyAny>,
        every: bool,
        listens: bool,
    ) -> PyResult<ShellTask> {
        let subscript = bytes_of(&subscript)?;
        let write = Write::UnsetElement {
            name,
            subscript,
            every,
        };
        Self::write_task(slf, write, listens, true)
    }

    /// Evaluate an arithmetic command or `let` operand, its writes landed;
    /// `expand` for a `let` operand, whose subscripts expand first.
    #[pyo3(signature = (text, *, listens = false, expand = false))]
    fn arith(
        slf: &Bound<'_, Self>,
        text: Bound<'_, PyAny>,
        listens: bool,
        expand: bool,
    ) -> PyResult<ShellTask> {
        let text = bytes_of(&text)?;
        Self::write_task(slf, Write::Arith { text, expand }, listens, true)
    }

    /// Evaluate a value as an `-i` write coerces it, its writes landed;
    /// `added` is an integer `+=`'s text.
    #[pyo3(signature = (text, added = None, *, listens = false))]
    fn integer(
        slf: &Bound<'_, Self>,
        text: Bound<'_, PyAny>,
        added: Option<Bound<'_, PyAny>>,
        listens: bool,
    ) -> PyResult<ShellTask> {
        let text = bytes_of(&text)?;
        let added = added.as_ref().map(bytes_of).transpose()?;
        Self::write_task(slf, Write::Integer { text, added }, listens, true)
    }
}

/// What an ended task leaves: its result tuple and diagnostics.
type Outcome = (Py<PyAny>, Py<PyAny>);

/// An operation running on a shell, driven by the host. Started, it has
/// run to its first request or its end: `step` returns the request it
/// waits on, which one `answer_*` call answers, running it to the next,
/// or None once it has ended, when the shell is its owner's again and
/// `finish` returns `(("ok", value) | fault, diagnostics)`. A long list
/// of fields comes in slices: the first in `finish`, the rest from
/// `slice` while `more` says some are left.
#[pyclass(module = "mirage._rs", unsendable)]
pub struct ShellTask {
    job: Job,
    owner: Py<Shell>,
    tree: Option<(Arc<Tree>, u64)>,
    asked: Option<Py<PyAny>>,
    ended: Option<Outcome>,
}

impl ShellTask {
    /// Hand the shell to an operation and run it to its first request
    /// or its end, when the shell comes back.
    fn start(
        slf: &Bound<'_, Shell>,
        tree: Option<(Arc<Tree>, u64)>,
        run: impl FnOnce(Inner) -> Running,
    ) -> PyResult<Self> {
        let mut shell = slf.borrow_mut();
        let inner = shell.0.take().ok_or_else(running)?;
        drop(shell);
        let (job, step) = Job::start(run(inner));
        let mut task = Self {
            job,
            owner: slf.clone().unbind(),
            tree,
            asked: None,
            ended: None,
        };
        task.land(slf.py(), step)?;
        Ok(task)
    }

    fn node(&self, index: usize) -> PyResult<ShellNode> {
        let (tree, serial) = self
            .tree
            .as_ref()
            .ok_or_else(|| PyRuntimeError::new_err("a write has no tree"))?;
        Ok(ShellNode {
            tree: Arc::clone(tree),
            serial: *serial,
            index: index as u32,
        })
    }

    fn ask<'py>(&self, py: Python<'py>, ask: Ask) -> PyResult<Bound<'py, PyAny>> {
        Ok(match ask {
            Ask::Substitute {
                shell,
                body,
                node,
                span,
                read,
            } => (
                "substitute",
                Shell::wrap(shell),
                text_of(py, &body)?,
                self.node(node)?,
                span,
                read.map(|fields| py_of(py, &host::fields_out(&fields)))
                    .transpose()?,
            )
                .into_pyobject(py)?
                .into_any(),
            Ask::ProcessSubstitution { shell, node } => {
                ("process", Shell::wrap(shell), self.node(node)?)
                    .into_pyobject(py)?
                    .into_any()
            }
            Ask::Gate {
                post,
                verb,
                key,
                value,
                old,
                view,
            } => {
                let verb = host::verb_name(verb);
                let value = value.map(|v| text_of(py, &v)).transpose()?;
                let old = old.map(|v| text_of(py, &v)).transpose()?;
                (
                    "gate",
                    post,
                    verb,
                    key,
                    value,
                    old,
                    Shell::wrap(Inner::new(view)),
                )
                    .into_pyobject(py)?
                    .into_any()
            }
            Ask::Pause { view } => ("pause", Shell::wrap(Inner::new(view)))
                .into_pyobject(py)?
                .into_any(),
        })
    }

    /// Keep where a run stopped: the request it waits on, or its end,
    /// giving the shell back to its owner.
    fn land(&mut self, py: Python<'_>, step: Step) -> PyResult<()> {
        let ended = match step {
            Step::Asked(ask) => {
                self.asked = Some(self.ask(py, ask)?.unbind());
                return Ok(());
            }
            Step::Ended(ended) => ended,
        };
        let result = py_of(py, &host::result_out(&ended.result))?;
        let diagnostics = py_of(py, &host::diagnostics_out(&ended.diagnostics))?;
        self.owner.borrow_mut(py).0.give_back(ended.shell);
        self.asked = None;
        self.ended = Some((result.unbind(), diagnostics.unbind()));
        Ok(())
    }

    fn answer(&mut self, py: Python<'_>, answer: Answer) -> PyResult<()> {
        // The request goes before the task resumes, so the copies it lent
        // share no record with a write the task lands.
        self.asked = None;
        let step = self
            .job
            .answer(answer)
            .ok_or_else(|| PyRuntimeError::new_err("the task has ended"))?;
        self.land(py, step)
    }
}

#[pymethods]
impl ShellTask {
    /// The request the operation waits on, None once it has ended. A
    /// request is `("substitute", shell, body, node, span, read)`,
    /// `("process", shell, node)`, `("gate", post, verb, key, value, old,
    /// view)` or `("pause", view)`; each shell is one the host may read
    /// while it answers.
    fn step<'py>(&self, py: Python<'py>) -> Option<Bound<'py, PyAny>> {
        self.asked.as_ref().map(|ask| ask.bind(py).clone())
    }

    fn answer_substituted(
        &mut self,
        py: Python<'_>,
        stdout: &[u8],
        stderr: &[u8],
        status: i32,
    ) -> PyResult<()> {
        self.answer(
            py,
            Answer::Substituted(Substitution {
                stdout: stdout.to_vec(),
                stderr: stderr.to_vec(),
                status,
            }),
        )
    }

    fn answer_path(&mut self, py: Python<'_>, path: Bound<'_, PyAny>) -> PyResult<()> {
        let path = bytes_of(&path)?;
        self.answer(py, Answer::Path(path))
    }

    /// The gate's answer: None to let the write through, or the refused
    /// name and the host's record of the refusal.
    #[pyo3(signature = (denied))]
    fn answer_gate(&mut self, py: Python<'_>, denied: Option<(String, u32)>) -> PyResult<()> {
        let answer = match denied {
            None => Ok(()),
            Some((name, record)) => Err(Denied { name, record }),
        };
        self.answer(py, Answer::Gate(answer))
    }

    /// The host has let others run; the operation goes on.
    fn answer_resumed(&mut self, py: Python<'_>) -> PyResult<()> {
        self.answer(py, Answer::Resumed)
    }

    /// Whether a policy hears the session's writes from now on, told
    /// before each answer.
    fn listen(&mut self, listens: bool) {
        self.job.listen(listens);
    }

    /// The host could not do what was asked; the operation stops.
    fn answer_failed(&mut self, py: Python<'_>) -> PyResult<()> {
        self.answer(py, Answer::Failed(Fault::Host("the host failed")))
    }

    /// The result once `step` has returned None: the shell is the
    /// owner's again.
    fn finish(&mut self, py: Python<'_>) -> PyResult<Outcome> {
        let (result, diagnostics) = self.ended.as_ref().ok_or_else(running)?;
        Ok((result.clone_ref(py), diagnostics.clone_ref(py)))
    }

    /// Whether slices of a long list of fields are left to take.
    fn more(&self) -> bool {
        self.job.more()
    }

    /// The next slice of a long list of fields.
    fn slice<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        py_of(py, &host::fields_out(&self.job.slice()))
    }
}
