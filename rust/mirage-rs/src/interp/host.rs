//! What the Python and wasm bindings share: the holder a shell waits in
//! while a task runs on it, and the engine's answers as items, each shape
//! spelled once for both hosts.

use super::codec::Item;
use super::expand::{Field, marked};
use super::job::Output;
use super::shell::Shell;
use super::task::Expanded;
use super::write::{Denied, Fault, Verb};
use super::{Diagnostic, Signal};
use crate::arith;
use crate::vars::{Value, Var};

/// A session's shell as a binding holds it: its own until a task takes
/// it, the bytes its records held then standing in for the memory count.
pub struct Held {
    shell: Option<Shell>,
    parked: usize,
}

impl Held {
    pub fn new(shell: Shell) -> Self {
        Self {
            shell: Some(shell),
            parked: 0,
        }
    }

    /// The shell, None while a task runs on it.
    pub fn shell(&self) -> Option<&Shell> {
        self.shell.as_ref()
    }

    pub fn shell_mut(&mut self) -> Option<&mut Shell> {
        self.shell.as_mut()
    }

    /// Hand the shell to a task, None when one already has it.
    pub fn take(&mut self) -> Option<Shell> {
        let shell = self.shell.take()?;
        self.parked = shell.vars.held();
        Some(shell)
    }

    /// The shell back from the task that ran on it.
    pub fn give_back(&mut self, shell: Shell) {
        self.shell = Some(shell);
    }

    /// The bytes every record holds, names and values; while a task runs,
    /// what they held as it started.
    pub fn held(&self) -> usize {
        self.shell
            .as_ref()
            .map_or(self.parked, |shell| shell.vars.held())
    }
}

/// A value: text, or a map from index or key to element.
pub fn value_out(value: &Value) -> Item {
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

/// A record: the value, none for declared but unset, the cluster
/// `declare -p` prints (`a`/`A` leading for an array), and a managed
/// variable's pointer (source, reference, key, eager).
pub fn record_out(var: &Var) -> Item {
    let managed = Item::opt(var.managed.as_ref(), |managed| {
        Item::tuple([
            Item::text(&managed.source),
            Item::text(&managed.reference),
            Item::text(&managed.key),
            Item::Bool(managed.eager),
        ])
    });
    Item::tuple([
        Item::opt(var.value.as_ref(), value_out),
        Item::text(var.cluster()),
        managed,
    ])
}

/// An arithmetic error, tagged.
pub fn arith_error(error: &arith::Error) -> Item {
    match error {
        arith::Error::Arith {
            reason,
            expression,
            token,
            subscript,
        } => Item::tuple([
            Item::text("arith"),
            Item::text(reason),
            Item::text(expression),
            Item::opt(token.as_ref(), Item::text),
            Item::Bool(*subscript),
        ]),
        arith::Error::Readonly { name, subscript } => Item::tuple([
            Item::text("readonly"),
            Item::text(name),
            Item::Bool(*subscript),
        ]),
        arith::Error::Unbound(name) => Item::tuple([Item::text("unbound"), Item::text(name)]),
        arith::Error::Halt { subscript } => {
            Item::tuple([Item::text("halt"), Item::Bool(*subscript)])
        }
    }
}

/// Why an operation stopped, tagged, which each host maps to its own
/// errors.
pub fn fault_out(fault: &Fault) -> Item {
    match fault {
        Fault::Hidden(name) => Item::tuple([Item::text("hidden"), Item::text(name)]),
        Fault::Denied(Denied { name, record }) => {
            Item::tuple([Item::text("denied"), Item::text(name), Item::int(*record)])
        }
        Fault::Readonly { name, subscript } => Item::tuple([
            Item::text("readonly"),
            Item::text(name),
            Item::Bool(*subscript),
        ]),
        Fault::Arith(error) => Item::tuple([Item::text("arith"), arith_error(error)]),
        Fault::Signal(Signal::Exit {
            status,
            stderr,
            contained,
        }) => Item::tuple([
            Item::text("exit"),
            Item::int(*status),
            Item::Raw(stderr.clone()),
            Item::int(*contained),
        ]),
        Fault::Signal(Signal::Discard { stderr, contained }) => Item::tuple([
            Item::text("discard"),
            Item::Raw(stderr.clone()),
            Item::int(*contained),
        ]),
        Fault::Bad { text, fixed } => {
            Item::tuple([Item::text("bad"), Item::text(text), Item::Bool(*fixed)])
        }
        Fault::Memory => Item::tuple([Item::text("memory")]),
        Fault::Host(what) => Item::tuple([Item::text("host"), Item::text(what)]),
    }
}

/// Fields as the hosts' globbing reads them, each quoted glob character
/// under its mark.
pub fn fields_out(fields: &[Field]) -> Item {
    Item::list(fields.iter().map(|field| Item::Text(marked(&field.0))))
}

/// An expansion's result: fields, text, or runs of text each quoted or
/// live.
pub fn expanded_out(expanded: &Expanded) -> Item {
    match expanded {
        Expanded::Fields(fields) => fields_out(fields),
        Expanded::Text(text) => Item::text(text),
        Expanded::Runs(runs) => Item::list(
            runs.iter()
                .map(|(text, quoted)| Item::tuple([Item::text(text), Item::Bool(*quoted)])),
        ),
    }
}

/// How an operation ended: `("ok", answer)`, or the fault it stopped on.
pub fn result_out(result: &Result<Output, Fault>) -> Item {
    match result {
        Ok(Output::Expanded(done)) => Item::tuple([Item::text("ok"), expanded_out(done)]),
        Ok(Output::Wrote(value)) => Item::tuple([Item::text("ok"), Item::Big(*value)]),
        Err(fault) => fault_out(fault),
    }
}

/// What an operation said on the way, text or raw bytes.
pub fn diagnostics_out(diagnostics: &[Diagnostic]) -> Item {
    Item::list(diagnostics.iter().map(|diagnostic| match diagnostic {
        Diagnostic::Text(text) => Item::text(text),
        Diagnostic::Bytes(bytes) => Item::Raw(bytes.clone()),
    }))
}

/// A `$RANDOM` read: the draw, none once RANDOM is not special, or the
/// error of a seed that does not evaluate.
pub fn random_out(drawn: &Result<Option<u32>, arith::Error>) -> Item {
    match drawn {
        Ok(drawn) => Item::opt(*drawn, Item::int),
        Err(error) => arith_error(error),
    }
}

/// The scalar an array conversion keeps as element 0, none when there is
/// none, or `("error", error)` for a seed that does not evaluate.
pub fn conversion_out(kept: &Result<Option<Vec<u8>>, arith::Error>) -> Item {
    match kept {
        Ok(text) => Item::opt(text.as_ref(), Item::text),
        Err(error) => Item::tuple([Item::text("error"), arith_error(error)]),
    }
}

/// A gate question's verb as the hosts name it.
pub fn verb_name(verb: Verb) -> &'static str {
    match verb {
        Verb::Set => "set",
        Verb::Unset => "unset",
    }
}
