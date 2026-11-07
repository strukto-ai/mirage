//! A shell operation its host drives: an expansion or a gated write runs as
//! a future that owns its shell, and each time it waits on the host it
//! hands over one request, which the host answers before stepping it again.
//! A request that needs the shell's state carries a copy of it, a child
//! shell for a substitution and a read-only fork for a policy, so the host
//! never reaches the shell a task holds.

use std::borrow::Cow;
use std::cell::RefCell;
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use super::Diagnostic;
use super::expand::{Expander, Field, Host, Substitution};
use super::shell::Shell;
use super::write::{Denied, Fault, Gate, Verb, Writer, element_reference};
use crate::shell::Tree;
use crate::vars::{Assigned, Store, Value};

/// What a running operation asks its host.
pub enum Ask {
    /// Run `body` in `shell`, a child shell, and capture its output;
    /// for `$(< file)` read the file `read` names, the fields its name
    /// expanded to already (any but one is an ambiguous redirect).
    Substitute {
        shell: Shell,
        body: Vec<u8>,
        node: usize,
        span: Option<(usize, usize)>,
        read: Option<Vec<Field>>,
    },
    /// Start `node`'s process substitution in `shell` and name its pipe.
    ProcessSubstitution { shell: Shell, node: usize },
    /// The `pre_session` (`post` false) or `post_session` policies on a
    /// write; `view` is the session as the write finds it.
    Gate {
        post: bool,
        verb: Verb,
        key: String,
        value: Option<Vec<u8>>,
        old: Option<Vec<u8>>,
        view: Store,
    },
    /// A long piece of work has run a while; the host lets others run, or
    /// stops the operation, before it goes on. `view` is the session as the
    /// work has left it so far, which whatever the host runs meanwhile reads
    /// (a call forking the session) while the operation holds the shell.
    Pause { view: Store },
}

/// The host's answer to an `Ask`.
pub enum Answer {
    Substituted(Substitution),
    Path(Vec<u8>),
    Gate(Result<(), Denied>),
    Resumed,
    /// The host could not do it; the operation stops with this.
    Failed(Fault),
}

/// The slices of work between two pauses that reach the host: each
/// slice is a glob matcher's drain or a run of characters, and a value
/// operator over many small values pauses once per value.
const PAUSE_SLICES: u32 = 16;

#[derive(Default)]
struct Slot {
    asked: Option<Ask>,
    answer: Option<Answer>,
    slices: u32,
}

/// The operation's side of its host.
#[derive(Clone)]
pub struct Line {
    slot: Rc<RefCell<Slot>>,
    listens: bool,
}

impl Line {
    async fn ask(&self, ask: Ask) -> Answer {
        let mut ask = Some(ask);
        poll_fn(|_| {
            let mut slot = self.slot.borrow_mut();
            if let Some(ask) = ask.take() {
                slot.asked = Some(ask);
                return Poll::Pending;
            }
            slot.answer.take().map_or(Poll::Pending, Poll::Ready)
        })
        .await
    }

    /// A gate question's answer: the policy's refusal as a denial, a host
    /// that failed answering as its own fault.
    async fn gated(&self, ask: Ask) -> Result<(), Fault> {
        match self.ask(ask).await {
            Answer::Gate(answer) => answer.map_err(Fault::Denied),
            Answer::Failed(fault) => Err(fault),
            _ => Err(Fault::Host("an answer that is no gate")),
        }
    }
}

impl Gate for Line {
    fn listens(&self) -> bool {
        self.listens
    }

    async fn pre(
        &mut self,
        verb: Verb,
        key: &str,
        value: Option<&[u8]>,
        store: &Store,
    ) -> Result<(), Fault> {
        let ask = Ask::Gate {
            post: false,
            verb,
            key: key.to_owned(),
            value: value.map(<[u8]>::to_vec),
            old: None,
            view: store.fork(),
        };
        self.gated(ask).await
    }

    async fn post(
        &mut self,
        verb: Verb,
        key: &str,
        value: Option<&[u8]>,
        old: Option<&[u8]>,
        store: &Store,
    ) -> Result<(), Fault> {
        let ask = Ask::Gate {
            post: true,
            verb,
            key: key.to_owned(),
            value: value.map(<[u8]>::to_vec),
            old: old.map(<[u8]>::to_vec),
            view: store.fork(),
        };
        self.gated(ask).await
    }
}

impl Host for Line {
    async fn substitute(
        &mut self,
        shell: &mut Shell,
        body: &[u8],
        node: usize,
        span: Option<(usize, usize)>,
        read: Option<&[Field]>,
    ) -> Result<Substitution, Fault> {
        let ask = Ask::Substitute {
            shell: shell.subshell(),
            body: body.to_vec(),
            node,
            span,
            read: read.map(<[Field]>::to_vec),
        };
        match self.ask(ask).await {
            Answer::Substituted(ran) => Ok(ran),
            Answer::Failed(fault) => Err(fault),
            _ => Err(Fault::Host("an answer that is no substitution")),
        }
    }

    async fn process_substitution(
        &mut self,
        shell: &mut Shell,
        node: usize,
    ) -> Result<Vec<u8>, Fault> {
        match self
            .ask(Ask::ProcessSubstitution {
                shell: shell.subshell(),
                node,
            })
            .await
        {
            Answer::Path(path) => Ok(path),
            Answer::Failed(fault) => Err(fault),
            _ => Err(Fault::Host("an answer that is no path")),
        }
    }

    async fn pause(&mut self, shell: &Shell) -> Result<(), Fault> {
        let due = {
            let mut slot = self.slot.borrow_mut();
            slot.slices += 1;
            slot.slices % PAUSE_SLICES == 0
        };
        if !due {
            return Ok(());
        }
        match self
            .ask(Ask::Pause {
                view: shell.vars.fork(),
            })
            .await
        {
            Answer::Resumed => Ok(()),
            Answer::Failed(fault) => Err(fault),
            _ => Err(Fault::Host("an answer that is no resumption")),
        }
    }
}

/// A running operation, its result once it ends.
pub struct Task<T> {
    future: Pin<Box<dyn Future<Output = T>>>,
    slot: Rc<RefCell<Slot>>,
    output: Option<T>,
}

impl<T: 'static> Task<T> {
    /// Start `run` against a host that `listens` for session writes or not.
    pub fn new<F, R>(listens: bool, run: F) -> Self
    where
        F: FnOnce(Line) -> R,
        R: Future<Output = T> + 'static,
    {
        let slot = Rc::new(RefCell::new(Slot::default()));
        let line = Line {
            slot: Rc::clone(&slot),
            listens,
        };
        Self {
            future: Box::pin(run(line)),
            slot,
            output: None,
        }
    }

    /// Run until the operation ends, None then, or asks its host.
    pub fn step(&mut self) -> Option<Ask> {
        if self.output.is_some() {
            return None;
        }
        match self
            .future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(output) => {
                self.output = Some(output);
                None
            }
            Poll::Pending => self.slot.borrow_mut().asked.take(),
        }
    }

    /// Answer what the last step asked.
    pub fn answer(&mut self, answer: Answer) {
        self.slot.borrow_mut().answer = Some(answer);
    }

    /// The result, once `step` has answered None.
    pub fn output(&mut self) -> Option<T> {
        self.output.take()
    }
}

/// How a host reads a word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A command's argument: fields, each glob-ready.
    Fields,
    /// A word where nothing splits.
    Text,
    /// An assignment's value.
    Assignment,
    /// A `case` or `[[ == ]]` pattern, as runs.
    Pattern,
    /// The right side of `[[ =~ ]]`.
    Regex,
    /// An arithmetic command's expression text, names left for the
    /// evaluator.
    Arith,
    /// The subscript of a `${x[...]}`, its key or index text, as a
    /// builtin's subscript given as text expands.
    Subscript,
}

/// What an expansion produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expanded {
    Fields(Vec<Field>),
    Text(Vec<u8>),
    Runs(Vec<(Vec<u8>, bool)>),
}

/// An operation's end: the shell it ran on, its result, and what it left
/// for the statement's stderr.
pub struct Ended<T> {
    pub shell: Shell,
    pub result: Result<T, Fault>,
    pub diagnostics: Vec<Diagnostic>,
}

impl<T> Ended<T> {
    /// The same end, its result's value made another.
    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Ended<U> {
        Ended {
            shell: self.shell,
            result: self.result.map(f),
            diagnostics: self.diagnostics,
        }
    }
}

/// Expand `node` of `tree` as `mode` says.
pub fn expand(
    shell: Shell,
    tree: Arc<Tree>,
    node: usize,
    mode: Mode,
    listens: bool,
) -> Task<Ended<Expanded>> {
    Task::new(listens, move |mut line| async move {
        let mut shell = shell;
        let mut diagnostics = Vec::new();
        let result = {
            let room = shell.memory_room;
            let mut expander = Expander {
                shell: &mut shell,
                host: &mut line,
                tree: &tree,
                diagnostics: &mut diagnostics,
                room,
            };
            match mode {
                Mode::Fields => expander.fields(node).await.map(Expanded::Fields),
                Mode::Text => expander.word_text(node).await.map(Expanded::Text),
                Mode::Assignment => expander.assignment(node).await.map(Expanded::Text),
                Mode::Pattern => expander.pattern_runs(node).await.map(Expanded::Runs),
                Mode::Regex => expander.regex(node).await.map(Expanded::Text),
                Mode::Arith => expander.arith(node).await.map(Expanded::Text),
                Mode::Subscript => expander.subscript(node).await.map(Expanded::Text),
            }
        };
        Ended {
            shell,
            result,
            diagnostics,
        }
    })
}

/// A session write the line asks for.
pub enum Write {
    Set {
        name: String,
        value: Value,
        follow_ref: bool,
        assigned: Option<Assigned>,
        added: Option<Vec<u8>>,
    },
    Unset {
        name: String,
        follow_ref: bool,
    },
    Mark {
        name: String,
        attr: Option<u8>,
        on: bool,
        follow_ref: bool,
    },
    /// An index resolved outside arithmetic (`a[i]=v`), what it assigns
    /// landed; the result is the index.
    Index {
        subscript: Vec<u8>,
    },
    /// An arithmetic command or `let` operand, its writes landed; the
    /// result is its value. `expand` for a `let` operand, whose subscripts
    /// expand as a value's do.
    Arith {
        text: Vec<u8>,
        expand: bool,
    },
    /// A value evaluated as an `-i` write coerces it (`declare -ni r=M`),
    /// `added` an integer `+=`'s text; the result is its value.
    Integer {
        text: Vec<u8>,
        added: Option<Vec<u8>>,
    },
    /// Whether a `name` / `name[sub]` reference is set (`test -v`), what
    /// its subscript assigns landed; the result is 1 or 0. `expanded` for
    /// a subscript the host already expanded, an associative key then
    /// taken verbatim.
    IsSet {
        reference: Vec<u8>,
        expanded: bool,
    },
    /// One element a builtin writes (`read 'a[k]'`); the result is the
    /// [`Element`] it came to.
    Element {
        name: String,
        subscript: Option<Vec<u8>>,
        value: Vec<u8>,
        append: bool,
    },
}

/// Run one session write through the gate; an error a `RANDOM=` seed
/// makes is a warning when `warns`, raised otherwise.
pub fn write(shell: Shell, write: Write, listens: bool, warns: bool) -> Task<Ended<i64>> {
    Task::new(listens, move |mut line| async move {
        let mut shell = shell;
        let mut diagnostics = Vec::new();
        let array = match &write {
            Write::IsSet { reference, .. } => element_reference(reference)
                .and_then(|(name, _)| shell.indexed(name))
                .map(Cow::into_owned),
            _ => None,
        };
        let result = {
            let mut writer = Writer {
                allexport: shell.option("allexport"),
                nounset: shell.option("nounset"),
                limit: shell.env_limit,
                outside: shell.outside,
                store: &mut shell.vars,
                gate: &mut line,
                diagnostics: warns.then_some(&mut diagnostics),
            };
            match write {
                Write::Set {
                    name,
                    value,
                    follow_ref,
                    assigned,
                    added,
                } => writer
                    .set(
                        &name,
                        value,
                        follow_ref,
                        assigned.as_ref(),
                        added.as_deref(),
                    )
                    .await
                    .map(|()| 0),
                Write::Unset { name, follow_ref } => {
                    writer.unset(&name, follow_ref).await.map(|()| 0)
                }
                Write::Mark {
                    name,
                    attr,
                    on,
                    follow_ref,
                } => writer.mark(&name, attr, on, follow_ref).await.map(|()| 0),
                Write::Index { subscript } => writer.subscript_index(&subscript).await,
                Write::Arith { text, expand } => writer.arith(&text, expand).await,
                Write::IsSet {
                    reference,
                    expanded,
                } => writer
                    .is_set(&reference, array, expanded)
                    .await
                    .map(i64::from),
                Write::Element {
                    name,
                    subscript,
                    value,
                    append,
                } => writer
                    .element(&name, subscript.as_deref(), &value, append)
                    .await
                    .map(|element| element as i64),
                Write::Integer { text, added } => writer
                    .evaluate_integer(&text, added.as_deref())
                    .await
                    .map(|value| {
                        std::str::from_utf8(&value)
                            .ok()
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(0)
                    }),
            }
        };
        Ended {
            shell,
            result,
            diagnostics,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vars::Store;

    fn shell() -> Shell {
        let mut shell = Shell::new(Store::new(Arc::new(|| 1)));
        shell.vars.seed("x", Value::Scalar(b"a b".to_vec()));
        shell
    }

    #[test]
    fn an_expansion_asks_its_host_for_a_substitution() {
        let tree = Arc::new(crate::shell::parse(b"echo $(hi)$x"));
        let word = (0..tree.nodes.len())
            .find(|&n| tree.kind(n) == "concatenation")
            .unwrap();
        let mut task = expand(shell(), Arc::clone(&tree), word, Mode::Fields, false);
        let Some(Ask::Substitute { body, shell, .. }) = task.step() else {
            panic!("expected a substitution");
        };
        assert_eq!(body, b"hi");
        assert_eq!(shell.vars.scalar("x"), Some(&b"a b"[..]));
        task.answer(Answer::Substituted(Substitution {
            stdout: b"out\n".to_vec(),
            stderr: Vec::new(),
            status: 4,
        }));
        assert!(task.step().is_none());
        let ended = task.output().unwrap();
        let Ok(Expanded::Fields(fields)) = ended.result else {
            panic!("expected fields");
        };
        let texts: Vec<Vec<u8>> = fields.iter().map(Field::text).collect();
        assert_eq!(texts, vec![b"outa".to_vec(), b"b".to_vec()]);
        assert_eq!(ended.shell.status, 4);
    }

    #[test]
    fn a_listened_write_asks_both_gates_and_a_refusal_undoes_it() {
        let mut task = write(
            shell(),
            Write::Set {
                name: "x".to_owned(),
                value: Value::Scalar(b"new".to_vec()),
                follow_ref: true,
                assigned: None,
                added: None,
            },
            true,
            true,
        );
        let Some(Ask::Gate {
            post: false, view, ..
        }) = task.step()
        else {
            panic!("expected pre_session");
        };
        assert_eq!(view.scalar("x"), Some(&b"a b"[..]));
        task.answer(Answer::Gate(Ok(())));
        let Some(Ask::Gate {
            post: true, view, ..
        }) = task.step()
        else {
            panic!("expected post_session");
        };
        assert_eq!(view.scalar("x"), Some(&b"new"[..]));
        task.answer(Answer::Gate(Err(Denied {
            name: "x".to_owned(),
            record: 7,
        })));
        assert!(task.step().is_none());
        let ended = task.output().unwrap();
        assert!(matches!(
            ended.result,
            Err(Fault::Denied(Denied { record: 7, .. }))
        ));
        assert_eq!(ended.shell.vars.scalar("x"), Some(&b"a b"[..]));
    }

    #[test]
    fn a_host_failing_at_the_gate_stops_with_its_own_fault() {
        let mut task = write(
            shell(),
            Write::Unset {
                name: "x".to_owned(),
                follow_ref: true,
            },
            true,
            true,
        );
        assert!(matches!(task.step(), Some(Ask::Gate { post: false, .. })));
        task.answer(Answer::Failed(Fault::Host("the host failed")));
        assert!(task.step().is_none());
        let ended = task.output().unwrap();
        assert!(matches!(ended.result, Err(Fault::Host(_))));
        assert_eq!(ended.shell.vars.scalar("x"), Some(&b"a b"[..]));
    }

    #[test]
    fn an_unheard_write_runs_in_one_step() {
        let mut task = write(
            shell(),
            Write::Arith {
                text: b"y = 6 * 7".to_vec(),
                expand: false,
            },
            false,
            true,
        );
        assert!(task.step().is_none());
        let ended = task.output().unwrap();
        assert_eq!(ended.result.ok(), Some(42));
        assert_eq!(ended.shell.vars.scalar("y"), Some(&b"42"[..]));
    }
}
