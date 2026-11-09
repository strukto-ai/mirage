use std::future::Future;

use super::declare::denied;
use super::expand::{Expander, Host};
use super::pattern::{self, Pattern};
use super::shell::Shell;
use super::write::{Fault, Writer};
use super::{Diagnostic, Signal, arith_line, voiced};
use crate::arith;
use crate::shell::Tree;
use crate::vars::Value;

/// The lists run here between two the host runs, which checks for a cancel
/// and lets others run.
const QUICK_TURNS: u32 = 64;

/// How a list of statements the host ran left.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Unwound {
    #[default]
    None,
    Break(u32),
    Continue(u32),
    /// `return`, `exit` or a failure; the host holds what unwinds.
    Stop,
}

/// What running a list came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ran {
    pub status: i32,
    pub unwound: Unwound,
    /// `set -e` is ending the shell, which stops a loop's next turn.
    pub exiting: bool,
}

/// How an arm of `case` ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fall {
    /// `;;`.
    Stop,
    /// `;&`: the next arm's body runs untested.
    Through,
    /// `;;&`: the arms after it are tested.
    Test,
}

impl std::str::FromStr for Fall {
    type Err = String;

    /// A terminator as the parser spells it.
    fn from_str(terminator: &str) -> Result<Self, String> {
        Ok(match terminator {
            ";;" => Fall::Stop,
            ";&" => Fall::Through,
            ";;&" => Fall::Test,
            other => return Err(format!("no terminator {other}")),
        })
    }
}

/// An arm of `case`: its pattern nodes, its body and how it ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Arm {
    pub patterns: Vec<usize>,
    pub body: usize,
    pub fall: Fall,
}

/// One expression of a C-style `for`: its nodes and tokens in order, and
/// the node after them, whose start ends the expression's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Slot {
    pub parts: Vec<usize>,
    pub closer: Option<usize>,
}

/// A compound command; each `usize` that is no node names a list of
/// statements the host holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Construct {
    If {
        branches: Vec<(usize, usize)>,
        otherwise: usize,
    },
    While {
        test: usize,
        body: usize,
        until: bool,
    },
    For {
        variable: String,
        values: Vec<Vec<u8>>,
        body: usize,
    },
    CFor {
        slots: [Option<Slot>; 3],
        body: usize,
    },
    Case {
        word: Vec<u8>,
        arms: Vec<Arm>,
    },
}

/// What a construct came to: the line that refused it and its status 1
/// when `failed`, and what goes on unwinding past it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Control {
    pub said: Vec<u8>,
    pub failed: bool,
    pub unwound: Unwound,
    /// What the statements run here last left in `$?`, for the host to
    /// record.
    pub pending: Option<i32>,
    /// The construct's status, when a list run here set it last.
    pub status: Option<i32>,
}

impl Control {
    fn left(unwound: Unwound) -> Self {
        Self {
            unwound,
            ..Self::default()
        }
    }

    fn refused(said: Vec<u8>) -> Self {
        Self {
            said,
            failed: true,
            ..Self::default()
        }
    }
}

/// A list the host is asked to run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListRun {
    pub list: usize,
    /// Its status decides a branch.
    pub test: bool,
    /// The first statement to run, those before it having run here.
    pub start: usize,
    /// What the statements run here left in `$?`, for the host to record.
    pub pending: Option<i32>,
    /// The construct reads the session, so the host frames the shell again.
    pub framed: bool,
}

/// What a construct asks of its host: to run one list on the shell.
pub trait Runs {
    fn run(&mut self, shell: &mut Shell, run: ListRun) -> impl Future<Output = Result<Ran, Fault>>;
}

/// A statement that runs inside the loop: it touches no stream, no mount
/// and no state of the host's.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Quick {
    Arith {
        node: usize,
        line: usize,
    },
    Assign {
        name: String,
        value: Option<usize>,
        line: usize,
    },
}

/// Whether a node expands with nothing happening but reads.
fn calm(tree: &Tree, node: usize) -> bool {
    match tree.kind(node) {
        "command_substitution" | "process_substitution" => return false,
        "expansion" if tree.named_children(node).count() != 1 || tree.children(node).len() != 3 => {
            return false;
        }
        _ => {}
    }
    tree.children(node).all(|child| calm(tree, child))
}

/// Whether an assignment's value is one of the words that expand quietly.
fn plain_word(tree: &Tree, node: usize) -> bool {
    let reading = match tree.kind(node) {
        "arithmetic_expansion" => tree.children(node).all(|child| !writes(tree, child)),
        "word" | "number" | "raw_string" | "string" | "simple_expansion" | "expansion"
        | "concatenation" => tree
            .named_children(node)
            .all(|child| plain_word(tree, child)),
        "string_content" | "variable_name" | "special_variable_name" => true,
        _ => false,
    };
    reading && calm(tree, node)
}

/// Whether an arithmetic node assigns.
fn writes(tree: &Tree, node: usize) -> bool {
    matches!(
        tree.kind(node),
        "=" | "+="
            | "-="
            | "*="
            | "/="
            | "%="
            | "**="
            | "<<="
            | ">>="
            | "&="
            | "^="
            | "|="
            | "++"
            | "--"
    ) || tree.children(node).any(|child| writes(tree, child))
}

fn quick_statement(tree: &Tree, node: usize, line: usize) -> Option<Quick> {
    let parent = tree.nodes[node].parent;
    let backgrounded = parent != u32::MAX
        && tree.children(parent as usize).contains(&(node + 1))
        && tree.kind(node + 1) == "&";
    if backgrounded {
        return None;
    }
    let children: Vec<usize> = tree.children(node).collect();
    match tree.kind(node) {
        "compound_statement" if tree.kind(*children.first()?) == "((" && calm(tree, node) => {
            Some(Quick::Arith { node, line })
        }
        "variable_assignment" => {
            let [name, operator, rest @ ..] = children.as_slice() else {
                return None;
            };
            let spelled = std::str::from_utf8(tree.text(*name)).ok()?;
            let value = rest.first().copied();
            let plain = tree.kind(*name) == "variable_name"
                && tree.kind(*operator) == "="
                && rest.len() < 2
                && spelled != "OPTIND"
                && spelled != "PIPESTATUS"
                && value.is_none_or(|value| plain_word(tree, value));
            plain.then(|| Quick::Assign {
                name: spelled.to_owned(),
                value,
                line,
            })
        }
        _ => None,
    }
}

/// A list's statements when all of them can run inside the loop.
fn quick_list(tree: &Tree, nodes: &[(usize, usize)]) -> Option<Vec<Quick>> {
    let statements = nodes
        .iter()
        .filter(|&&(node, _)| tree.kind(node) != "comment")
        .map(|&(node, line)| quick_statement(tree, node, line))
        .collect::<Option<Vec<_>>>()?;
    (!statements.is_empty()).then_some(statements)
}

/// Where a loop goes after a list: on, out, or up past the loop.
enum Turn {
    On,
    Leave,
    Up(Unwound),
}

fn turn(ran: &Ran) -> Turn {
    match ran.unwound {
        Unwound::None if ran.exiting => Turn::Leave,
        Unwound::None | Unwound::Continue(1) => Turn::On,
        Unwound::Break(1) => Turn::Leave,
        Unwound::Break(levels) => Turn::Up(Unwound::Break(levels - 1)),
        Unwound::Continue(levels) => Turn::Up(Unwound::Continue(levels - 1)),
        Unwound::Stop => Turn::Up(Unwound::Stop),
    }
}

struct Walk<'a, H> {
    shell: &'a mut Shell,
    host: &'a mut H,
    tree: &'a Tree,
    diagnostics: &'a mut Vec<Diagnostic>,
    quick: &'a [Option<Vec<Quick>>],
    framed: bool,
    turns: u32,
    pending: Option<i32>,
    status: Option<i32>,
}

impl<H: Host + Runs> Walk<'_, H> {
    fn noexec(&self) -> bool {
        self.shell.option("noexec")
    }

    /// Whether a statement may run inside the loop: nothing watches it, and
    /// nothing it does can refuse once its expansion went through.
    fn plain(&self) -> bool {
        const WATCHING: [&str; 5] = ["xtrace", "verbose", "errexit", "nounset", "noexec"];
        !self.shell.err_trap && !WATCHING.iter().any(|option| self.shell.option(option))
    }

    /// Run a statement here. None leaves the shell as it was, for the host
    /// to run it and report what it finds.
    async fn quick(&mut self, statement: &Quick) -> Option<i32> {
        match statement {
            Quick::Arith { node, line } => {
                self.shell.vars.set_line(*line);
                let text = self.expander().arith(*node).await.ok()?;
                let value =
                    Writer::of(self.shell, Some(&mut *self.diagnostics)).clean_arith(&text)?;
                Some(i32::from(value == 0))
            }
            Quick::Assign { name, value, line } => {
                self.shell.vars.set_line(*line);
                let value = match value {
                    Some(node) => self.expander().assignment(*node).await.ok()?,
                    None => Vec::new(),
                };
                Writer::of(self.shell, Some(&mut *self.diagnostics)).clean_scalar(name, &value)?;
                self.shell.vars.seed("_", Value::Scalar(Vec::new()));
                Some(0)
            }
        }
    }

    async fn list(&mut self, list: usize, test: bool) -> Result<Ran, Fault> {
        let quick = self.quick;
        let mut start = 0;
        if let Some(statements) = quick.get(list).and_then(Option::as_ref)
            && self.plain()
        {
            self.turns = self.turns.wrapping_add(1);
            if self.turns % QUICK_TURNS != 0 {
                let mut status = 0;
                for statement in statements {
                    let Some(ended) = self.quick(statement).await else {
                        break;
                    };
                    status = ended;
                    start += 1;
                    self.shell.record_status(status);
                    self.pending = Some(status);
                }
                if start == statements.len() {
                    if !test {
                        self.status = Some(status);
                    }
                    return Ok(Ran {
                        status,
                        unwound: Unwound::None,
                        exiting: false,
                    });
                }
            }
        }
        let run = ListRun {
            list,
            test,
            start,
            pending: self.pending.take(),
            framed: self.framed,
        };
        let ran = self.host.run(self.shell, run).await?;
        if !test {
            self.status = None;
        }
        Ok(ran)
    }

    fn expander(&mut self) -> Expander<'_, H> {
        let room = self.shell.memory_room;
        Expander {
            shell: &mut *self.shell,
            host: &mut *self.host,
            tree: self.tree,
            diagnostics: &mut *self.diagnostics,
            room,
        }
    }

    async fn conditional(
        &mut self,
        branches: Vec<(usize, usize)>,
        otherwise: usize,
    ) -> Result<Control, Fault> {
        for (test, body) in branches {
            let tested = self.list(test, true).await?;
            if tested.unwound != Unwound::None {
                return Ok(Control::left(tested.unwound));
            }
            if tested.status == 0 {
                let ran = self.list(body, false).await?;
                return Ok(Control::left(ran.unwound));
            }
        }
        let ran = self.list(otherwise, false).await?;
        Ok(Control::left(ran.unwound))
    }

    async fn repeat(&mut self, test: usize, body: usize, until: bool) -> Result<Control, Fault> {
        while !self.noexec() {
            let tested = self.list(test, true).await?;
            match turn(&tested) {
                Turn::Up(unwound) => return Ok(Control::left(unwound)),
                Turn::Leave => break,
                Turn::On if tested.unwound != Unwound::None => continue,
                Turn::On => {}
            }
            if (tested.status == 0) == until {
                break;
            }
            let ran = self.list(body, false).await?;
            match turn(&ran) {
                Turn::Up(unwound) => return Ok(Control::left(unwound)),
                Turn::Leave => break,
                Turn::On => {}
            }
        }
        Ok(Control::default())
    }

    async fn each(
        &mut self,
        variable: &str,
        values: Vec<Vec<u8>>,
        body: usize,
    ) -> Result<Control, Fault> {
        let voice = self.shell.vars.voice().to_vec();
        if self.shell.vars.is_readonly(variable, true) {
            let line = voiced(&voice, &format!("{variable}: readonly variable\n"));
            return Ok(Control::refused(line));
        }
        for value in values {
            if self.noexec() {
                break;
            }
            let landed = Writer::of(self.shell, Some(&mut *self.diagnostics)).set(
                variable,
                Value::Scalar(value),
                true,
                None,
                None,
            );
            match landed {
                Ok(()) => {}
                Err(Fault::Hidden(name)) => return Ok(Control::refused(denied(&name))),
                Err(Fault::Arith(error)) => {
                    return Err(Signal::arith(&voice, &error, "", true).into());
                }
                Err(fault) => return Err(fault),
            }
            let ran = self.list(body, false).await?;
            match turn(&ran) {
                Turn::Up(unwound) => return Ok(Control::left(unwound)),
                Turn::Leave => break,
                Turn::On => {}
            }
        }
        Ok(Control::default())
    }

    async fn slot_text(&mut self, slot: &Slot) -> Result<Vec<u8>, Fault> {
        let tree = self.tree;
        let (Some(&first), Some(&last)) = (slot.parts.first(), slot.parts.last()) else {
            return Ok(Vec::new());
        };
        let end = slot
            .closer
            .map_or(tree.nodes[last].end, |closer| tree.nodes[closer].start)
            as usize;
        let mut text = Vec::new();
        let mut at = tree.nodes[first].start as usize;
        for &part in &slot.parts {
            let node = tree.nodes[part];
            text.extend_from_slice(&tree.source[at..node.start as usize]);
            if node.named {
                text.extend(self.expander().arith(part).await?);
            } else {
                text.extend_from_slice(&tree.source[node.start as usize..node.end as usize]);
            }
            at = node.end as usize;
        }
        text.extend_from_slice(&tree.source[at..end]);
        Ok(text)
    }

    async fn slot(&mut self, slot: &Option<Slot>, default: i64) -> Result<i64, Fault> {
        let Some(slot) = slot else {
            return Ok(default);
        };
        let text = self.slot_text(slot).await?;
        Writer::of(self.shell, Some(&mut *self.diagnostics)).arith(&text, false)
    }

    async fn counted(&mut self, slots: &[Option<Slot>; 3], body: usize) -> Result<Control, Fault> {
        self.slot(&slots[0], 0).await?;
        while !self.noexec() {
            if self.slot(&slots[1], 1).await? == 0 {
                break;
            }
            let ran = self.list(body, false).await?;
            match turn(&ran) {
                Turn::Up(unwound) => return Ok(Control::left(unwound)),
                Turn::Leave => break,
                Turn::On => {}
            }
            self.slot(&slots[2], 0).await?;
        }
        Ok(Control::default())
    }

    /// An expression's failure as the loop reports it, or the fault that
    /// goes on when it ends the shell.
    fn slot_refusal(&self, fault: Fault) -> Result<Control, Fault> {
        let voice = self.shell.vars.voice().to_vec();
        match fault {
            Fault::Arith(
                error @ arith::Error::Arith {
                    subscript: true, ..
                },
            ) => Err(Signal::arith(&voice, &error, "", false).into()),
            Fault::Arith(arith::Error::Readonly {
                name,
                subscript: false,
            })
            | Fault::Readonly {
                name,
                subscript: false,
            } => Ok(Control::refused(voiced(
                &voice,
                &format!("{name}: readonly variable\n"),
            ))),
            Fault::Readonly {
                name,
                subscript: true,
            }
            | Fault::Arith(arith::Error::Readonly {
                name,
                subscript: true,
            }) => Err(Signal::readonly(&voice, &name, true).into()),
            Fault::Arith(error @ arith::Error::Arith { .. }) => {
                let mut line = voiced(&voice, "((: ");
                line.extend(arith_line(&error));
                line.push(b'\n');
                Ok(Control::refused(line))
            }
            Fault::Hidden(name) => {
                let mut line = voice;
                line.extend(denied(&name));
                Ok(Control::refused(line))
            }
            fault => Err(fault),
        }
    }

    async fn case(&mut self, word: Vec<u8>, arms: Vec<Arm>) -> Result<Control, Fault> {
        let utf8 = self.shell.utf8();
        let mut fallthrough = false;
        for arm in arms {
            // An arm a `;;&` left can have turned extglob on for this one.
            let extglob = self.shell.shopt("extglob");
            let mut matched = fallthrough;
            for &node in &arm.patterns {
                if matched {
                    break;
                }
                let runs = self.expander().pattern_runs(node).await?;
                let mut compiled = Pattern::default();
                for (text, quoted) in &runs {
                    compiled.push(text, *quoted, utf8);
                }
                matched = pattern::matches(&word, &compiled, extglob, utf8);
            }
            if !matched {
                continue;
            }
            let ran = self.list(arm.body, false).await?;
            if ran.unwound != Unwound::None {
                return Ok(Control::left(ran.unwound));
            }
            fallthrough = arm.fall == Fall::Through;
            if ran.exiting || arm.fall == Fall::Stop {
                break;
            }
        }
        Ok(Control::default())
    }
}

/// Run a compound command, the host running each list it picks.
pub async fn run_construct<H: Host + Runs>(
    shell: &mut Shell,
    host: &mut H,
    tree: &Tree,
    diagnostics: &mut Vec<Diagnostic>,
    construct: Construct,
    statements: Vec<Option<Vec<(usize, usize)>>>,
) -> Result<Control, Fault> {
    let quick: Vec<Option<Vec<Quick>>> = statements
        .iter()
        .map(|nodes| nodes.as_deref().and_then(|nodes| quick_list(tree, nodes)))
        .collect();
    let framed = match construct {
        Construct::If { .. } => false,
        Construct::While { .. } => quick.iter().any(Option::is_some),
        _ => true,
    };
    let mut walk = Walk {
        shell,
        host,
        tree,
        diagnostics,
        quick: &quick,
        framed,
        turns: 0,
        pending: None,
        status: None,
    };
    let control = match construct {
        Construct::If {
            branches,
            otherwise,
        } => walk.conditional(branches, otherwise).await,
        Construct::While { test, body, until } => walk.repeat(test, body, until).await,
        Construct::For {
            variable,
            values,
            body,
        } => walk.each(&variable, values, body).await,
        Construct::CFor { slots, body } => match walk.counted(&slots, body).await {
            Err(fault) => walk.slot_refusal(fault),
            done => done,
        },
        Construct::Case { word, arms } => walk.case(word, arms).await,
    }?;
    Ok(Control {
        pending: walk.pending,
        status: walk.status,
        ..control
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Arc;

    use super::super::expand::Field;
    use super::super::expand::Substitution;
    use super::*;
    use crate::vars::Store;

    /// A host that answers each list from a script and records the order.
    struct Script {
        answers: VecDeque<Ran>,
        ran: Vec<(usize, bool)>,
        starts: Vec<usize>,
    }

    impl Host for Script {
        async fn substitute(
            &mut self,
            _shell: &mut Shell,
            _body: &[u8],
            _node: usize,
            _span: Option<(usize, usize)>,
            _read: Option<&[Field]>,
        ) -> Result<Substitution, Fault> {
            Err(Fault::Host("no substitution here"))
        }

        async fn process_substitution(
            &mut self,
            _shell: &mut Shell,
            _node: usize,
        ) -> Result<Vec<u8>, Fault> {
            Err(Fault::Host("no process substitution here"))
        }
    }

    impl Runs for Script {
        async fn run(&mut self, _shell: &mut Shell, run: ListRun) -> Result<Ran, Fault> {
            self.ran.push((run.list, run.test));
            self.starts.push(run.start);
            Ok(self.answers.pop_front().unwrap_or(ran(0)))
        }
    }

    fn ran(status: i32) -> Ran {
        Ran {
            status,
            unwound: Unwound::None,
            exiting: false,
        }
    }

    fn unwound(unwound: Unwound) -> Ran {
        Ran {
            status: 0,
            unwound,
            exiting: false,
        }
    }

    fn shell() -> Shell {
        Shell::new(Store::new(Arc::new(|| 1)))
    }

    fn drive(
        shell: &mut Shell,
        answers: Vec<Ran>,
        construct: Construct,
    ) -> (Control, Vec<(usize, bool)>) {
        let mut host = Script {
            answers: answers.into(),
            ran: Vec::new(),
            starts: Vec::new(),
        };
        let tree = crate::shell::parse(b"");
        let mut diagnostics = Vec::new();
        let control = {
            let done = std::pin::pin!(run_construct(
                shell,
                &mut host,
                &tree,
                &mut diagnostics,
                construct,
                Vec::new(),
            ));
            futures_now(done).unwrap()
        };
        (control, host.ran)
    }

    /// Run a construct over the statements a line parses to, each list its
    /// range of them, and answer what the host saw.
    fn drive_line(
        shell: &mut Shell,
        line: &[u8],
        lists: &[(usize, usize)],
        construct: Construct,
    ) -> (Control, Vec<usize>) {
        let tree = crate::shell::parse(line);
        let statements: Vec<usize> = tree.named_children(0).collect();
        let lists = lists
            .iter()
            .map(|&(from, to)| Some(statements[from..to].iter().map(|&node| (node, 1)).collect()))
            .collect();
        let mut host = Script {
            answers: VecDeque::new(),
            ran: Vec::new(),
            starts: Vec::new(),
        };
        let mut diagnostics = Vec::new();
        let control = {
            let done = std::pin::pin!(run_construct(
                shell,
                &mut host,
                &tree,
                &mut diagnostics,
                construct,
                lists,
            ));
            futures_now(done).unwrap()
        };
        (control, host.starts)
    }

    fn futures_now<T>(future: std::pin::Pin<&mut impl Future<Output = T>>) -> T {
        match future.poll(&mut std::task::Context::from_waker(std::task::Waker::noop())) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("the script host never waits"),
        }
    }

    #[test]
    fn if_runs_the_first_branch_whose_test_holds() {
        let construct = Construct::If {
            branches: vec![(0, 1), (2, 3)],
            otherwise: 4,
        };
        let (_, order) = drive(&mut shell(), vec![ran(1), ran(0)], construct.clone());
        assert_eq!(order, vec![(0, true), (2, true), (3, false)]);
        let (_, order) = drive(&mut shell(), vec![ran(1), ran(1)], construct);
        assert_eq!(order, vec![(0, true), (2, true), (4, false)]);
    }

    #[test]
    fn while_stops_on_a_failing_test_and_until_on_a_passing_one() {
        let until = Construct::While {
            test: 0,
            body: 1,
            until: true,
        };
        let (_, order) = drive(&mut shell(), vec![ran(1), ran(0), ran(0)], until);
        assert_eq!(order, vec![(0, true), (1, false), (0, true)]);
        let loops = Construct::While {
            test: 0,
            body: 1,
            until: false,
        };
        let (_, order) = drive(&mut shell(), vec![ran(1)], loops);
        assert_eq!(order, vec![(0, true)]);
    }

    #[test]
    fn a_deeper_break_goes_on_with_a_level_spent() {
        let construct = Construct::While {
            test: 0,
            body: 1,
            until: false,
        };
        let (control, _) = drive(
            &mut shell(),
            vec![ran(0), unwound(Unwound::Break(3))],
            construct.clone(),
        );
        assert_eq!(control.unwound, Unwound::Break(2));
        let (control, order) = drive(
            &mut shell(),
            vec![ran(0), unwound(Unwound::Continue(1)), ran(1)],
            construct,
        );
        assert_eq!(control.unwound, Unwound::None);
        assert_eq!(order.len(), 3);
    }

    #[test]
    fn an_if_passes_a_break_on_whole() {
        let construct = Construct::If {
            branches: vec![(0, 1)],
            otherwise: 2,
        };
        let (control, _) = drive(
            &mut shell(),
            vec![ran(0), unwound(Unwound::Break(1))],
            construct,
        );
        assert_eq!(control.unwound, Unwound::Break(1));
    }

    #[test]
    fn for_sets_its_variable_each_turn_and_keeps_the_last() {
        let mut shell = shell();
        let construct = Construct::For {
            variable: "x".into(),
            values: vec![b"a".to_vec(), b"b".to_vec()],
            body: 0,
        };
        let (_, order) = drive(&mut shell, vec![], construct);
        assert_eq!(order.len(), 2);
        assert_eq!(shell.vars.scalar("x"), Some(&b"b"[..]));
    }

    #[test]
    fn for_refuses_a_readonly_variable_before_its_first_turn() {
        let mut shell = shell();
        shell.vars.seed("x", Value::Scalar(b"1".to_vec()));
        Writer::of(&mut shell, None)
            .mark("x", Some(crate::vars::READONLY), true, true)
            .unwrap();
        let construct = Construct::For {
            variable: "x".into(),
            values: vec![b"a".to_vec()],
            body: 0,
        };
        let (control, order) = drive(&mut shell, vec![], construct);
        assert!(control.failed);
        assert_eq!(control.said, b"bash: x: readonly variable\n");
        assert!(order.is_empty());
    }

    #[test]
    fn exiting_stops_a_loop_after_its_body() {
        let construct = Construct::For {
            variable: "x".into(),
            values: vec![b"a".to_vec(), b"b".to_vec()],
            body: 0,
        };
        let stopping = Ran {
            exiting: true,
            ..ran(1)
        };
        let (_, order) = drive(&mut shell(), vec![stopping], construct);
        assert_eq!(order.len(), 1);
    }

    #[test]
    fn a_loop_of_arithmetic_runs_inside_it() {
        let mut shell = shell();
        let construct = Construct::While {
            test: 0,
            body: 1,
            until: false,
        };
        let (control, starts) = drive_line(
            &mut shell,
            b"((i<3)); ((i++))",
            &[(0, 1), (1, 2)],
            construct,
        );
        assert!(starts.is_empty());
        assert_eq!(shell.vars.scalar("i"), Some(&b"3"[..]));
        assert_eq!((control.pending, control.status), (Some(1), Some(0)));
    }

    #[test]
    fn a_statement_that_cannot_run_here_goes_to_the_host_once() {
        let mut shell = shell();
        let construct = Construct::For {
            variable: "v".to_owned(),
            values: vec![b"1".to_vec()],
            body: 0,
        };
        let (_, starts) = drive_line(&mut shell, b"((x++)); ((1/0))", &[(0, 2)], construct);
        assert_eq!(starts, vec![1]);
        assert_eq!(shell.vars.scalar("x"), Some(&b"1"[..]));
    }

    #[test]
    fn a_traced_shell_runs_every_list_on_the_host() {
        let mut shell = shell();
        shell.options.insert("xtrace".to_owned(), true);
        let construct = Construct::For {
            variable: "v".to_owned(),
            values: vec![b"1".to_vec()],
            body: 0,
        };
        let (_, starts) = drive_line(&mut shell, b"((x++))", &[(0, 1)], construct);
        assert_eq!(starts, vec![0]);
        assert_eq!(shell.vars.scalar("x"), None);
    }

    #[test]
    fn only_what_expands_quietly_is_quick() {
        let quick = |line: &[u8]| {
            let tree = crate::shell::parse(line);
            let nodes: Vec<(usize, usize)> = tree.named_children(0).map(|node| (node, 1)).collect();
            quick_list(&tree, &nodes).is_some()
        };
        assert!(quick(b"((i++)); x=$i; y=\"$a-b\"; z=$((i+1)); w=${v}"));
        for line in [
            &b"x=$(date)"[..],
            b"((i+=$(date)))",
            b"x=${y:-z}",
            b"z=$((i++))",
            b"PIPESTATUS=1",
            b"x+=1",
            b"a[0]=1",
            b"x=(1 2)",
            b"OPTIND=1",
            b"echo",
            b"x=1 &",
        ] {
            assert!(!quick(line), "{}", String::from_utf8_lossy(line));
        }
    }
}
