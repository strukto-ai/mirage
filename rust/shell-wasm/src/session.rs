//! The session engine for the TypeScript host, as `rust/python/src/session.rs`
//! is for Python: shells and the tasks running on them, each held here under
//! a handle, expanding the trees `mirage_rs_shell_parse` keeps. Every call is
//! one request, a list naming its target and operation then the arguments,
//! and one reply, in `codec`'s layout.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use mirage_rs::arith;
use mirage_rs::interp::expand::{Substitution, marked};
use mirage_rs::interp::job::{Job, Output, Running, Step};
use mirage_rs::interp::shell::Shell as Inner;
use mirage_rs::interp::task::{self, Answer, Ask, Expanded, Mode, Write};
use mirage_rs::interp::write::{Denied, Fault, Verb};
use mirage_rs::interp::{Diagnostic, Signal};
use mirage_rs::vars::{self, Assigned, Indexed, Kind, Managed, Store, Value, Var};

use crate::codec::{Args, Item, one};
use crate::{ARGS, shell_tree};

#[link(wasm_import_module = "mirage")]
unsafe extern "C" {
    /// The id the host's source `source` hands out next, which a fresh
    /// `$RANDOM` generator seeds from.
    fn mirage_ids(source: u32) -> u32;
    /// No shell draws from `source` any more.
    fn mirage_ids_release(source: u32);
}

type Reply = Result<Item, String>;

fn running() -> String {
    "the shell is running a task".to_owned()
}

/// A host id source, released when the last shell drawing from it goes.
struct Source(u32);

impl Drop for Source {
    fn drop(&mut self) {
        // SAFETY: the host's import takes a plain number.
        unsafe { mirage_ids_release(self.0) }
    }
}

fn ids(source: u32) -> vars::Ids {
    let source = Source(source);
    Arc::new(move || {
        // The whole guard, not just its number: a closure capturing
        // `source.0` alone drops the guard here and releases the source.
        let held = &source;
        // SAFETY: the host's import takes a plain number and returns one.
        unsafe { mirage_ids(held.0) }
    })
}

struct Shell {
    inner: Option<Inner>,
    /// The globals each running `declare -g` set aside, innermost last.
    stepped: Vec<Vec<(String, Option<Arc<Var>>)>>,
    /// The bytes the records held when a task took the shell.
    parked: usize,
}

impl Shell {
    fn wrap(inner: Inner) -> Self {
        Self {
            inner: Some(inner),
            stepped: Vec::new(),
            parked: 0,
        }
    }

    fn shell(&self) -> Result<&Inner, String> {
        self.inner.as_ref().ok_or_else(running)
    }

    fn shell_mut(&mut self) -> Result<&mut Inner, String> {
        self.inner.as_mut().ok_or_else(running)
    }

    fn store(&self) -> Result<&Store, String> {
        Ok(&self.shell()?.vars)
    }

    fn store_mut(&mut self) -> Result<&mut Store, String> {
        Ok(&mut self.shell_mut()?.vars)
    }
}

/// A running operation and the shell it gives back when it ends.
struct Owned {
    job: Job,
    owner: u32,
}

#[derive(Default)]
struct Engine {
    shells: HashMap<u32, Shell>,
    jobs: HashMap<u32, Owned>,
    next: u32,
    out: Vec<u8>,
}

impl Engine {
    fn handle(&mut self) -> u32 {
        self.next = self.next.wrapping_add(1).max(1);
        while self.shells.contains_key(&self.next) || self.jobs.contains_key(&self.next) {
            self.next = self.next.wrapping_add(1).max(1);
        }
        self.next
    }

    fn adopt(&mut self, inner: Inner) -> u32 {
        let handle = self.handle();
        self.shells.insert(handle, Shell::wrap(inner));
        handle
    }

    fn shell(&mut self, handle: u32) -> Result<&mut Shell, String> {
        self.shells
            .get_mut(&handle)
            .ok_or_else(|| format!("no shell {handle}"))
    }

    fn job(&mut self, handle: u32) -> Result<&mut Owned, String> {
        self.jobs
            .get_mut(&handle)
            .ok_or_else(|| format!("no task {handle}"))
    }

    /// Hand a shell to an operation and run it to its first request or
    /// its end: the task's handle and where it stopped.
    fn start(&mut self, owner: u32, run: impl FnOnce(Inner) -> Running) -> Reply {
        let shell = self.shell(owner)?;
        let inner = shell.inner.take().ok_or_else(running)?;
        shell.parked = inner.vars.held();
        let (job, step) = Job::start(run(inner));
        let handle = self.handle();
        self.jobs.insert(handle, Owned { job, owner });
        Ok(Item::list([Item::int(handle), self.land(handle, step)]))
    }

    /// Where a run stopped, as the host reads it: `["ask", request]`, or
    /// `["done", result, diagnostics, more]` with the shell back with its
    /// owner and the task gone unless slices of its fields are left.
    fn land(&mut self, handle: u32, step: Step) -> Item {
        let ended = match step {
            Step::Asked(ask) => return Item::list([Item::text("ask"), ask_out(self, ask)]),
            Step::Ended(ended) => ended,
        };
        let result = match &ended.result {
            Ok(Output::Expanded(done)) => Item::list([Item::text("ok"), expanded_out(done)]),
            Ok(Output::Wrote(value)) => Item::list([Item::text("ok"), Item::Big(*value)]),
            Err(fault) => fault_out(fault),
        };
        let more = self.jobs.get(&handle).is_some_and(|owned| owned.job.more());
        if let Some(owned) = self.jobs.get(&handle) {
            let owner = owned.owner;
            if let Some(shell) = self.shells.get_mut(&owner) {
                shell.inner = Some(ended.shell);
            }
        }
        if !more {
            self.jobs.remove(&handle);
        }
        Item::list([
            Item::text("done"),
            result,
            diagnostics_out(&ended.diagnostics),
            Item::Bool(more),
        ])
    }

    fn write(&mut self, owner: u32, write: Write, listens: bool, warns: bool) -> Reply {
        self.start(owner, |inner| {
            Running::Write(task::write(inner, write, listens, warns))
        })
    }
}

thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::default());
}

fn value_out(value: &Value) -> Item {
    match value {
        Value::Scalar(text) => Item::text(text),
        Value::Indexed(array) => Item::Map(
            array
                .iter()
                .map(|(index, element)| (Item::Big(index), Item::text(element)))
                .collect(),
        ),
        Value::Assoc(map) => Item::Map(
            map.iter()
                .map(|(key, element)| (Item::text(key), Item::text(element)))
                .collect(),
        ),
    }
}

/// A value from the host: text, or a map, an associative array's when
/// `assoc`, an indexed one's otherwise.
fn value_in(item: Item, assoc: bool) -> Result<Value, String> {
    let pairs = match item {
        Item::Map(pairs) => pairs,
        other => return one(other, Args::bytes).map(Value::Scalar),
    };
    if assoc {
        let entries = pairs
            .into_iter()
            .map(|(key, element)| Ok((one(key, Args::bytes)?, one(element, Args::bytes)?)))
            .collect::<Result<Vec<_>, String>>()?;
        return Ok(Value::Assoc(Box::new(entries.into_iter().collect())));
    }
    let mut array = Indexed::default();
    for (index, element) in pairs {
        array.set(one(index, Args::int)?, one(element, Args::bytes)?);
    }
    Ok(Value::Indexed(array))
}

/// A record as the host reads it: the value, none for declared but unset,
/// the cluster `declare -p` prints (`a`/`A` leading for an array), and a
/// managed variable's pointer.
fn record_out(var: &Var) -> Item {
    let managed = Item::opt(var.managed.as_ref(), |managed| {
        Item::list([
            Item::text(&managed.source),
            Item::text(&managed.reference),
            Item::text(&managed.key),
            Item::Bool(managed.eager),
        ])
    });
    Item::list([
        Item::opt(var.value.as_ref(), value_out),
        Item::text(var.cluster()),
        managed,
    ])
}

fn record_in(item: Item) -> Result<Var, String> {
    let mut fields = Args::new(one(item, Args::list)?);
    let value = fields.maybe()?;
    let cluster = fields.string()?;
    let managed = match fields.maybe()? {
        None => None,
        Some(item) => {
            let mut pointer = Args::new(one(item, Args::list)?);
            Some(Box::new(Managed {
                source: pointer.string()?,
                reference: pointer.string()?,
                key: pointer.string()?,
                eager: pointer.flag()?,
            }))
        }
    };
    let value = value
        .map(|value| value_in(value, cluster.starts_with('A')))
        .transpose()?;
    Ok(Var {
        value,
        attrs: vars::attrs_of(&cluster),
        managed,
    })
}

fn arith_error(error: &arith::Error) -> Item {
    match error {
        arith::Error::Arith {
            reason,
            expression,
            token,
            subscript,
        } => Item::list([
            Item::text("arith"),
            Item::text(reason),
            Item::text(expression),
            Item::opt(token.as_ref(), Item::text),
            Item::Bool(*subscript),
        ]),
        arith::Error::Readonly { name, subscript } => Item::list([
            Item::text("readonly"),
            Item::text(name),
            Item::Bool(*subscript),
        ]),
        arith::Error::Unbound(name) => Item::list([Item::text("unbound"), Item::text(name)]),
        arith::Error::Halt { subscript } => {
            Item::list([Item::text("halt"), Item::Bool(*subscript)])
        }
    }
}

/// Why an operation stopped, as a tagged list the host maps to its own
/// errors.
fn fault_out(fault: &Fault) -> Item {
    match fault {
        Fault::Hidden(name) => Item::list([Item::text("hidden"), Item::text(name)]),
        Fault::Denied(Denied { name, record }) => {
            Item::list([Item::text("denied"), Item::text(name), Item::int(*record)])
        }
        Fault::Readonly { name, subscript } => Item::list([
            Item::text("readonly"),
            Item::text(name),
            Item::Bool(*subscript),
        ]),
        Fault::Arith(error) => Item::list([Item::text("arith"), arith_error(error)]),
        Fault::Signal(Signal::Exit {
            status,
            stderr,
            contained,
        }) => Item::list([
            Item::text("exit"),
            Item::int(*status),
            Item::Raw(stderr.clone()),
            Item::int(*contained),
        ]),
        Fault::Signal(Signal::Discard { stderr, contained }) => Item::list([
            Item::text("discard"),
            Item::Raw(stderr.clone()),
            Item::int(*contained),
        ]),
        Fault::Bad { text, fixed } => {
            Item::list([Item::text("bad"), Item::text(text), Item::Bool(*fixed)])
        }
        Fault::Memory => Item::list([Item::text("memory")]),
        Fault::Unsupported(what) => Item::list([Item::text("unsupported"), Item::text(what)]),
    }
}

fn expanded_out(expanded: &Expanded) -> Item {
    match expanded {
        Expanded::Fields(fields) => {
            Item::list(fields.iter().map(|field| Item::Text(marked(&field.0))))
        }
        Expanded::Text(text) => Item::text(text),
        Expanded::Runs(runs) => Item::list(
            runs.iter()
                .map(|(text, quoted)| Item::list([Item::text(text), Item::Bool(*quoted)])),
        ),
    }
}

fn diagnostics_out(diagnostics: &[Diagnostic]) -> Item {
    Item::list(diagnostics.iter().map(|diagnostic| match diagnostic {
        Diagnostic::Text(text) => Item::text(text),
        Diagnostic::Bytes(bytes) => Item::Raw(bytes.clone()),
    }))
}

fn texts(items: Vec<Item>) -> Result<Vec<Vec<u8>>, String> {
    items
        .into_iter()
        .map(|item| one(item, Args::bytes))
        .collect()
}

fn names_in(items: Vec<Item>) -> Result<Vec<String>, String> {
    items
        .into_iter()
        .map(|item| one(item, Args::string))
        .collect()
}

fn flags_in(item: Item) -> Result<HashMap<String, bool>, String> {
    let Item::Map(pairs) = item else {
        return Err("a request expected a map".to_owned());
    };
    pairs
        .into_iter()
        .map(|(name, on)| Ok((one(name, Args::string)?, one(on, Args::flag)?)))
        .collect()
}

fn size(value: i64) -> Result<usize, String> {
    usize::try_from(value).map_err(|_| "a size is out of range".to_owned())
}

fn optional_size(item: Option<Item>) -> Result<Option<usize>, String> {
    item.map(|item| one(item, Args::int).and_then(size))
        .transpose()
}

fn letter(item: Option<Item>) -> Result<Option<u8>, String> {
    Ok(item
        .map(|item| one(item, Args::string))
        .transpose()?
        .map(|letter| vars::attrs_of(&letter)))
}

/// One operation on a shell, the handle its first argument.
fn shell_call(engine: &mut Engine, op: &str, args: &mut Args) -> Reply {
    if op == "new" {
        let source = args.handle()?;
        return Ok(Item::int(engine.adopt(Inner::new(Store::new(ids(source))))));
    }
    let handle = args.handle()?;
    match op {
        "drop" => {
            engine.shells.remove(&handle);
            return Ok(Item::Nil);
        }
        "fork" => {
            let shell = engine.shell(handle)?.shell()?;
            let mut forked = shell.clone();
            forked.vars = shell.vars.fork();
            return Ok(Item::int(engine.adopt(forked)));
        }
        "subshell" => {
            let child = engine.shell(handle)?.shell()?.subshell();
            return Ok(Item::int(engine.adopt(child)));
        }
        "expand" => {
            let tree = args.handle()?;
            let node = size(args.int()?)?;
            let mode = match args.string()?.as_str() {
                "fields" => Mode::Fields,
                "text" => Mode::Text,
                "assignment" => Mode::Assignment,
                "pattern" => Mode::Pattern,
                "regex" => Mode::Regex,
                "arith" => Mode::Arith,
                other => return Err(format!("no expansion mode {other}")),
            };
            let listens = args.flag()?;
            let tree = shell_tree(tree).ok_or_else(|| format!("no tree {tree}"))?;
            return engine.start(handle, |inner| {
                Running::Expand(task::expand(inner, tree, node, mode, listens))
            });
        }
        "set" => {
            let name = args.string()?;
            let value = args.item()?;
            let assoc = args.flag()?;
            let follow_ref = args.flag()?;
            let assigned = match args.maybe()? {
                None => None,
                Some(keys) if assoc => Some(Assigned::Keys(
                    texts(one(keys, Args::list)?)?.into_iter().collect(),
                )),
                Some(indexes) => Some(Assigned::Indexes(
                    one(indexes, Args::list)?
                        .into_iter()
                        .map(|index| one(index, Args::int))
                        .collect::<Result<_, String>>()?,
                )),
            };
            let added = args
                .maybe()?
                .map(|item| one(item, Args::bytes))
                .transpose()?;
            let listens = args.flag()?;
            let warns = args.flag()?;
            let write = Write::Set {
                name,
                value: value_in(value, assoc)?,
                follow_ref,
                assigned,
                added,
            };
            return engine.write(handle, write, listens, warns);
        }
        "unset" => {
            let name = args.string()?;
            let follow_ref = args.flag()?;
            let listens = args.flag()?;
            return engine.write(handle, Write::Unset { name, follow_ref }, listens, true);
        }
        "mark" => {
            let name = args.string()?;
            let attr = letter(args.maybe()?)?;
            let on = args.flag()?;
            let follow_ref = args.flag()?;
            let listens = args.flag()?;
            let write = Write::Mark {
                name,
                attr,
                on,
                follow_ref,
            };
            return engine.write(handle, write, listens, true);
        }
        "index" => {
            let subscript = args.bytes()?;
            let listens = args.flag()?;
            return engine.write(handle, Write::Index { subscript }, listens, true);
        }
        "is_set" => {
            let reference = args.bytes()?;
            let listens = args.flag()?;
            return engine.write(handle, Write::IsSet { reference }, listens, true);
        }
        "element" => {
            let name = args.string()?;
            let subscript = args
                .maybe()?
                .map(|item| one(item, Args::bytes))
                .transpose()?;
            let value = args.bytes()?;
            let append = args.flag()?;
            let listens = args.flag()?;
            let warns = args.flag()?;
            let write = Write::Element {
                name,
                subscript,
                value,
                append,
            };
            return engine.write(handle, write, listens, warns);
        }
        "arith" => {
            let text = args.bytes()?;
            let listens = args.flag()?;
            return engine.write(handle, Write::Arith { text }, listens, true);
        }
        "integer" => {
            let text = args.bytes()?;
            let added = args
                .maybe()?
                .map(|item| one(item, Args::bytes))
                .transpose()?;
            let listens = args.flag()?;
            return engine.write(handle, Write::Integer { text, added }, listens, true);
        }
        _ => {}
    }
    let shell = engine.shell(handle)?;
    Ok(match op {
        "use_ids" => {
            let source = args.handle()?;
            shell.store_mut()?.set_ids(ids(source));
            Item::Nil
        }
        "get" => Item::opt(shell.store()?.record(&args.string()?), record_out),
        "visible" => Item::opt(shell.store()?.visible(&args.string()?), record_out),
        "place" => {
            let name = args.string()?;
            let var = args.maybe()?.map(record_in).transpose()?.map(Arc::new);
            Item::opt(shell.store_mut()?.place(&name, var), |old| record_out(&old))
        }
        "visible_names" => {
            let kind = match args.string()?.as_str() {
                "scalar" => Kind::Scalar,
                "indexed" => Kind::Indexed,
                "assoc" => Kind::Assoc,
                other => return Err(format!("no value kind {other}")),
            };
            Item::list(
                shell
                    .store()?
                    .visible_names(kind)
                    .into_iter()
                    .map(Item::text),
            )
        }
        "indexed" => Item::opt(shell.shell()?.indexed(&args.string()?), |array| {
            value_out(&Value::Indexed(array.into_owned()))
        }),
        "rendered" => Item::opt(
            shell
                .store()?
                .record(&args.string()?)
                .and_then(|var| var.value.as_ref()),
            |value| Item::text(value.rendering()),
        ),
        "names" => Item::list(shell.store()?.records().map(|(name, _)| Item::text(name))),
        "records" => Item::list(
            shell
                .store()?
                .records()
                .map(|(name, var)| Item::list([Item::text(name), record_out(var)])),
        ),
        "len" => Item::int(shell.store()?.records().count()),
        "contains" => Item::Bool(shell.store()?.record(&args.string()?).is_some()),
        "version" => Item::Big(i64::try_from(shell.store()?.version()).unwrap_or(i64::MAX)),
        "held" => Item::int(
            shell
                .inner
                .as_ref()
                .map_or(shell.parked, |inner| inner.vars.held()),
        ),
        "hide" => {
            let names = names_in(args.list()?)?;
            let patterns = names_in(args.list()?)?;
            shell.store_mut()?.hide_vars(&names, &patterns);
            Item::Nil
        }
        "hidden" => Item::Bool(shell.store()?.hidden(&args.string()?)),
        "nameref_target" => Item::opt(shell.store()?.nameref_target(&args.string()?), Item::text),
        "deref" => Item::text(shell.store()?.deref(&args.string()?)),
        "target" => Item::text(shell.store()?.target(&args.string()?)),
        "is_readonly" => {
            let name = args.string()?;
            Item::Bool(shell.store()?.is_readonly(&name, args.flag()?))
        }
        "frozen" => Item::opt(shell.store()?.frozen(&args.string()?), Item::text),
        "exported" => Item::list(
            shell
                .store()?
                .exported()
                .into_iter()
                .map(|(name, value)| Item::list([Item::text(name), Item::text(value)])),
        ),
        "seed" => {
            let name = args.string()?;
            let value = args.item()?;
            let value = value_in(value, args.flag()?)?;
            shell.store_mut()?.seed(&name, value);
            Item::Nil
        }
        "set_attr" => {
            let name = args.string()?;
            let attr = letter(args.maybe()?)?;
            shell.store_mut()?.set_attr(&name, attr, args.flag()?);
            Item::Nil
        }
        "enter" => Item::opt(shell.store_mut()?.enter(), Item::int),
        "leave" => {
            let outer = optional_size(args.maybe()?)?;
            shell.store_mut()?.leave(outer);
            Item::Nil
        }
        "in_function" => Item::Bool(shell.store()?.in_function()),
        "is_local" => Item::Bool(shell.store()?.is_local(&args.string()?)),
        "shadow" => {
            shell.store_mut()?.shadow(&args.string()?);
            Item::Nil
        }
        "open_temp" => Item::int(shell.store_mut()?.open_temp()),
        "save_temp" => {
            let index = size(args.int()?)?;
            shell.store_mut()?.save_temp(index, &args.string()?);
            Item::Nil
        }
        "close_temp" => {
            let index = size(args.int()?)?;
            shell.store_mut()?.close_temp(index);
            Item::Nil
        }
        "outlive_call" => {
            shell.store_mut()?.outlive_call(&args.string()?);
            Item::Nil
        }
        "in_call_env" => Item::Bool(shell.store()?.in_call_env(&args.string()?)),
        "reach_global" => {
            let names = names_in(args.list()?)?;
            shell.store_mut()?.reach_global(&names);
            Item::Nil
        }
        "unreach" => {
            shell.store_mut()?.unreach();
            Item::Nil
        }
        "step_back" => {
            let globals = shell.store_mut()?.step_back();
            shell.stepped.push(globals);
            Item::Nil
        }
        "step_forward" => {
            let globals = shell.stepped.pop().unwrap_or_default();
            shell.store_mut()?.step_forward(globals);
            Item::Nil
        }
        "next_random" => match shell.store_mut()?.next_random() {
            Ok(drawn) => Item::opt(drawn, Item::int),
            Err(error) => arith_error(&error),
        },
        "frame" => {
            let positional = texts(args.list()?)?;
            let calls = args
                .list()?
                .into_iter()
                .map(|call| texts(one(call, Args::list)?))
                .collect::<Result<Vec<_>, String>>()?;
            let status = i32::try_from(args.int()?).unwrap_or(1);
            let pid = u32::try_from(args.int()?).unwrap_or(0);
            let last_job = args
                .maybe()?
                .map(|item| one(item, Args::handle))
                .transpose()?;
            let argv0 = args.bytes()?;
            let options = flags_in(args.item()?)?;
            let shopts = flags_in(args.item()?)?;
            let env_limit = optional_size(args.maybe()?)?;
            let outside = size(args.int()?)?;
            let pipe_status = args
                .list()?
                .into_iter()
                .map(|item| one(item, Args::int).map(|status| status as i32))
                .collect::<Result<Vec<_>, String>>()?;
            let function_names = args
                .maybe()?
                .map(|item| texts(one(item, Args::list)?))
                .transpose()?;
            let paren = args.flag()?;
            let memory_room = optional_size(args.maybe()?)?;
            let inner = shell.shell_mut()?;
            inner.positional = positional;
            inner.calls = calls;
            inner.status = status;
            inner.pid = pid;
            inner.last_job = last_job;
            inner.argv0 = argv0;
            inner.options = options;
            inner.shopts = shopts;
            inner.env_limit = env_limit;
            inner.outside = outside;
            inner.pipe_status = pipe_status;
            inner.function_names = function_names;
            inner.paren = paren;
            inner.memory_room = memory_room;
            Item::Nil
        }
        "conversion_scalar" => match shell.store_mut()?.conversion_scalar(&args.string()?) {
            Ok(text) => Item::opt(text, Item::text),
            Err(error) => Item::list([Item::text("error"), arith_error(&error)]),
        },
        "status" => Item::int(shell.shell()?.status),
        "take_substituted" => Item::opt(shell.shell_mut()?.substituted.take(), Item::int),
        other => return Err(format!("no shell operation {other}")),
    })
}

/// A request a task waits on, as the host reads it.
fn ask_out(engine: &mut Engine, ask: Ask) -> Item {
    match ask {
        Ask::Substitute {
            shell,
            body,
            node,
            span,
            read,
        } => Item::list([
            Item::text("substitute"),
            Item::int(engine.adopt(shell)),
            Item::text(body),
            Item::int(node),
            Item::opt(span, |(start, end)| {
                Item::list([Item::int(start), Item::int(end)])
            }),
            Item::opt(read, |field| Item::Text(marked(&field.0))),
        ]),
        Ask::ProcessSubstitution { shell, node } => Item::list([
            Item::text("process"),
            Item::int(engine.adopt(shell)),
            Item::int(node),
        ]),
        Ask::Gate {
            post,
            verb,
            key,
            value,
            old,
            view,
        } => Item::list([
            Item::text("gate"),
            Item::Bool(post),
            Item::text(match verb {
                Verb::Set => "set",
                Verb::Unset => "unset",
            }),
            Item::text(key),
            Item::opt(value, Item::text),
            Item::opt(old, Item::text),
            Item::int(engine.adopt(Inner::new(view))),
        ]),
        Ask::Pause { view } => Item::list([
            Item::text("pause"),
            Item::int(engine.adopt(Inner::new(view))),
        ]),
    }
}

/// One operation on a task, the handle its first argument: an answer,
/// which runs the task to where it stops next, the next slice of its
/// fields, or dropping a task the host gives up on.
fn task_call(engine: &mut Engine, op: &str, args: &mut Args) -> Reply {
    let handle = args.handle()?;
    if op == "drop" {
        engine.jobs.remove(&handle);
        return Ok(Item::Nil);
    }
    if op == "slice" {
        let owned = engine.job(handle)?;
        let fields = Item::list(
            owned
                .job
                .slice()
                .iter()
                .map(|field| Item::Text(marked(&field.0))),
        );
        let more = owned.job.more();
        if !more {
            engine.jobs.remove(&handle);
        }
        return Ok(Item::list([fields, Item::Bool(more)]));
    }
    let answer = match op {
        "answer_substituted" => Answer::Substituted(Substitution {
            stdout: args.bytes()?,
            stderr: args.bytes()?,
            status: i32::try_from(args.int()?).unwrap_or(1),
        }),
        "answer_path" => Answer::Path(args.bytes()?),
        "answer_gate" => Answer::Gate(match args.maybe()? {
            None => Ok(()),
            Some(item) => {
                let mut denied = Args::new(one(item, Args::list)?);
                let name = denied.string()?;
                let record = u32::try_from(denied.int()?).unwrap_or(0);
                Err(Denied { name, record })
            }
        }),
        "answer_resumed" => Answer::Resumed,
        "answer_failed" => Answer::Failed(Fault::Unsupported("the host failed")),
        other => return Err(format!("no task operation {other}")),
    };
    let step = engine
        .job(handle)?
        .job
        .answer(answer)
        .ok_or_else(|| "the task has ended".to_owned())?;
    Ok(engine.land(handle, step))
}

/// A request, or a batch of them run in order whose last reply is the
/// batch's: a frame goes with the operation that reads it, in one call.
fn call(request: &[u8]) -> Reply {
    let mut bytes = request;
    let Some(Item::List(items)) = Item::decode(&mut bytes) else {
        return Err("a request is malformed".to_owned());
    };
    if !matches!(items.first(), Some(Item::List(_))) {
        return run(items);
    }
    let mut reply = Ok(Item::Nil);
    for item in items {
        let Item::List(request) = item else {
            return Err("a batch holds a request that is no list".to_owned());
        };
        reply = Ok(run(request)?);
    }
    reply
}

fn run(request: Vec<Item>) -> Reply {
    let mut args = Args::new(request);
    let target = args.string()?;
    let op = args.string()?;
    ENGINE.with_borrow_mut(|engine| match target.as_str() {
        "shell" => shell_call(engine, &op, &mut args),
        "task" => task_call(engine, &op, &mut args),
        other => Err(format!("no engine target {other}")),
    })
}

/// Run one engine request, the args buffer's first `len` bytes: 0 when it
/// ran, its reply at `mirage_rs_engine_output`; 1 when it was refused, the
/// reason there instead.
#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_engine(len: usize) -> i32 {
    let args = ARGS.with_borrow_mut(std::mem::take);
    let reply = call(&args[..len.min(args.len())]);
    ARGS.with_borrow_mut(|kept| {
        if kept.capacity() < args.capacity() {
            *kept = args;
        }
    });
    ENGINE.with_borrow_mut(|engine| {
        engine.out.clear();
        mirage_rs::release_capacity(&mut engine.out);
        match reply {
            Ok(item) => {
                item.encode(&mut engine.out);
                0
            }
            Err(reason) => {
                engine.out.extend_from_slice(reason.as_bytes());
                1
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_engine_output() -> *const u8 {
    ENGINE.with_borrow(|engine| engine.out.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_rs_engine_output_len() -> usize {
    ENGINE.with_borrow(|engine| engine.out.len())
}
