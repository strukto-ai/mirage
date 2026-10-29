// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regcomp.c. See licenses/third_party/oniguruma.txt.

use std::ops::Range;

use super::callout::Callout;
use super::class::Set;
use super::parse::{Anchor, Node, Parsed, Saved, Update};

const INVALID_LOOK_BEHIND: &str = "invalid pattern in look-behind";
const NEVER_ENDING_RECURSION: &str = "never ending recursion";

/// What one step of the subject a unit instruction takes.
#[derive(Debug)]
pub(super) enum Unit {
    Char(char),
    Byte(u8),
    Set(usize),
    /// `.`: anything but a newline.
    Any,
    /// `.` under `s`, and `\O`.
    AnyNl,
}

#[derive(Debug)]
pub(super) enum Inst {
    Unit(Unit),
    /// Go on at the first; on failure, at the second.
    Split(usize, usize),
    /// A split an atomic cut keeps (OP_PUSH_SUPER).
    SplitSuper(usize, usize),
    Jump(usize),
    Save(usize),
    /// A recursive group ends: its start is the one its own activation
    /// set, not a nested call's (OP_MEM_END_REC).
    SaveRec(usize),
    Anchor(Anchor),
    Backref {
        groups: Box<[usize]>,
        fold: bool,
        level: Option<i64>,
    },
    /// Go on when a group is set, else fail.
    Check {
        groups: Box<[usize]>,
        level: Option<i64>,
    },
    Keep,
    Newline,
    /// A loop begins: its count starts at zero.
    RepStart(usize),
    /// The head of a loop whose body follows.
    RepLoop {
        id: usize,
        min: u32,
        max: Option<u32>,
        greedy: bool,
        exit: usize,
    },
    /// The end of a loop body, which goes back to `head` unless the pass
    /// matched nothing and changed no group.
    RepEnd {
        id: usize,
        head: usize,
        min: u32,
    },
    /// A loop over one unit, which needs no state per pass.
    Star {
        unit: Unit,
        min: u32,
        max: Option<u32>,
        greedy: bool,
    },
    AtomicStart,
    AtomicEnd,
    /// A lookaround: lookbehind steps back its fixed length first; `exit`
    /// follows its `LookEnd`.
    LookStart {
        negate: bool,
        behind: Option<usize>,
        exit: usize,
    },
    LookEnd {
        negate: bool,
    },
    /// Enter a group's body at `addr`, to come back after this; the
    /// body's own loops are `loops`, which the call keeps apart from the
    /// caller's.
    Call {
        addr: usize,
        loops: Range<usize>,
    },
    Return,
    /// `\X`.
    TextSegment,
    SaveVal(Saved, usize),
    UpdateVar(Update),
    Callout(usize),
    Fail,
    Match,
}

pub(super) struct Program {
    pub(super) insts: Vec<Inst>,
    pub(super) sets: Vec<Set>,
    /// For each loop, the group slots whose change makes a pass that
    /// matched nothing count as progress.
    pub(super) loops: Vec<Box<[usize]>>,
    pub(super) slots: usize,
    pub(super) callouts: Vec<Callout>,
}

/// The fewest and most characters a node matches; None is unbounded.
type Len = (usize, Option<usize>);

fn add(a: Len, b: Len) -> Len {
    (
        a.0.saturating_add(b.0),
        a.1.zip(b.1).map(|(x, y)| x.saturating_add(y)),
    )
}

fn merge(a: Len, b: Len) -> Len {
    (a.0.min(b.0), a.1.zip(b.1).map(|(x, y)| x.max(y)))
}

/// What the compiler knows of the groups: each one's body length, and
/// which ones a call reaches.
struct Groups {
    lens: Vec<Option<Len>>,
    called: Vec<bool>,
    /// Which groups a call from their own body reaches.
    recursive: Vec<bool>,
}

struct Compiler<'a> {
    insts: Vec<Inst>,
    sets: Vec<Set>,
    loops: Vec<Box<[usize]>>,
    groups: &'a Groups,
    /// Where each called group's body begins, once compiled.
    addrs: Vec<Option<usize>>,
    /// Each call instruction and the group it enters.
    calls: Vec<(usize, usize)>,
    /// Each called group's loops, once compiled.
    ranges: Vec<Range<usize>>,
    /// Each group's body, for the slots a call changes.
    bodies: Vec<Option<&'a Node>>,
}

pub(super) fn compile(parsed: Parsed) -> Result<Program, String> {
    let Parsed {
        mut node,
        groups,
        callouts,
        ..
    } = parsed;
    let (called, recursive) = mark_calls(&mut node, groups)?;
    let mut bodies = vec![None; groups + 1];
    collect_bodies(&node, &mut bodies);
    let mut lens = vec![None; groups + 1];
    for g in 0..=groups {
        group_len(g, &bodies, &mut lens);
    }
    let info = Groups {
        lens,
        called,
        recursive,
    };
    prepare(&mut node, &info)?;
    let mut bodies = vec![None; groups + 1];
    collect_bodies(&node, &mut bodies);
    let mut compiler = Compiler {
        insts: Vec::new(),
        sets: Vec::new(),
        loops: Vec::new(),
        groups: &info,
        addrs: vec![None; groups + 1],
        calls: Vec::new(),
        ranges: vec![0..0; groups + 1],
        bodies,
    };
    compiler.node(&node);
    compiler.insts.push(Inst::Match);
    for (at, group) in compiler.calls {
        let addr =
            compiler.addrs[group].unwrap_or_else(|| unreachable!("a called group is compiled"));
        compiler.insts[at] = Inst::Call {
            addr,
            loops: compiler.ranges[group].clone(),
        };
    }
    Ok(Program {
        insts: compiler.insts,
        sets: compiler.sets,
        loops: compiler.loops,
        slots: 2 * (groups + 1),
        callouts,
    })
}

fn collect_bodies<'a>(node: &'a Node, out: &mut [Option<&'a Node>]) {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if let Node::Group(index, body) = node {
            out[*index] = Some(body);
        }
        node.children(&mut stack);
    }
}

/// Each call's groups, and which groups a call outside `{0}` enters:
/// the targets of the calls in each group's subtree, closed over the
/// targets' own (recursive_call_check), which marks a call that its own
/// group's body reaches, then checks that none of them recurses without
/// consuming (infinite_recursive_call_check).
fn mark_calls(node: &mut Node, groups: usize) -> Result<(Vec<bool>, Vec<bool>), String> {
    let root = groups + 1;
    let mut calls_in: Vec<Vec<usize>> = vec![Vec::new(); groups + 2];
    let mut live: Vec<Vec<usize>> = vec![Vec::new(); groups + 2];
    collect_calls(node, root, &mut calls_in, &mut live);
    let mut called = vec![false; groups + 1];
    let mut entered = live[root].clone();
    while let Some(g) = entered.pop() {
        if !called[g] {
            called[g] = true;
            entered.extend(live[g].iter().copied());
        }
    }
    let mut target = vec![false; groups + 1];
    for &g in &calls_in[root] {
        target[g] = true;
    }
    let reach: Vec<Vec<u64>> = (0..=groups)
        .map(|g| {
            if target[g] {
                closure(g, &calls_in)
            } else {
                Vec::new()
            }
        })
        .collect();
    let mut chain = vec![root];
    flag_calls(node, &mut chain, &reach);
    let mut bodies = vec![None; groups + 1];
    collect_bodies(node, &mut bodies);
    let mut mins = vec![Min::Unknown; groups + 1];
    let mut on_path = vec![false; groups + 1];
    for g in 0..=groups {
        if !(called[g] && has(&reach[g], g)) {
            continue;
        }
        let Some(body) = bodies[g] else {
            continue;
        };
        on_path[g] = true;
        let mut walk = Walk {
            bodies: &bodies,
            mins: &mut mins,
            target: g,
            on_path: &mut on_path,
        };
        let found = walk.infinite(body, true);
        on_path[g] = false;
        if found.must || found.infinite {
            return Err(NEVER_ENDING_RECURSION.into());
        }
    }
    let recursive = (0..=groups).map(|g| has(&reach[g], g)).collect();
    Ok((called, recursive))
}

/// Records every call under the groups enclosing it, root included, and
/// in `live` the calls no `{0}` inside that group hides: a group a live
/// call enters runs its own live calls, wherever the group itself sits.
fn collect_calls(node: &Node, root: usize, calls_in: &mut [Vec<usize>], live: &mut [Vec<usize>]) {
    let mut chain = vec![(root, 0)];
    let mut stack = vec![(Some(node), 0)];
    while let Some((node, zeros)) = stack.pop() {
        let Some(node) = node else {
            chain.pop();
            continue;
        };
        match node {
            Node::Call(call) => {
                for &(enclosing, _) in &chain {
                    calls_in[enclosing].push(call.group);
                }
                for &(enclosing, entered_at) in chain.iter().rev() {
                    if entered_at != zeros {
                        break;
                    }
                    live[enclosing].push(call.group);
                }
            }
            Node::Group(index, body) => {
                chain.push((*index, zeros));
                stack.push((None, zeros));
                stack.push((Some(body), zeros));
            }
            Node::Repeat { body, max, .. } => {
                stack.push((Some(body), zeros + usize::from(*max == Some(0))))
            }
            node => {
                let mut children = Vec::new();
                node.children(&mut children);
                stack.extend(children.into_iter().map(|node| (Some(node), zeros)));
            }
        }
    }
}

/// The groups whose subtree a call from `from`'s subtree reaches, a bit
/// each.
fn closure(from: usize, calls_in: &[Vec<usize>]) -> Vec<u64> {
    let mut seen = vec![0; calls_in.len().div_ceil(64)];
    let mut stack = calls_in[from].clone();
    while let Some(g) = stack.pop() {
        if has(&seen, g) {
            continue;
        }
        seen[g / 64] |= 1 << (g % 64);
        stack.extend(calls_in[g].iter().copied());
    }
    seen
}

fn has(bits: &[u64], g: usize) -> bool {
    bits.get(g / 64)
        .is_some_and(|word| word & (1 << (g % 64)) != 0)
}

/// Marks each call its own group's body reaches as recursive.
fn flag_calls(node: &mut Node, chain: &mut Vec<usize>, reach: &[Vec<u64>]) {
    let mut stack = vec![Some(node)];
    while let Some(node) = stack.pop() {
        let Some(node) = node else {
            chain.pop();
            continue;
        };
        match node {
            Node::Call(call) => {
                call.recursive = chain.iter().any(|&enclosing| {
                    enclosing == call.group || has(&reach[call.group], enclosing)
                });
            }
            Node::Group(index, body) => {
                chain.push(*index);
                stack.push(None);
                stack.push(Some(body));
            }
            node => {
                let mut children = Vec::new();
                node.children_mut(&mut children);
                stack.extend(children.into_iter().map(Some));
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Found {
    /// A call back to the group under check exists.
    exist: bool,
    /// Every path takes one.
    must: bool,
    /// One is reached without consuming anything.
    infinite: bool,
}

impl Found {
    fn or(self, other: Found) -> Found {
        Found {
            exist: self.exist || other.exist,
            must: self.must || other.must,
            infinite: self.infinite || other.infinite,
        }
    }
}

/// The recursion check of one group, with the groups on the path down
/// to the node at hand (MARK2), so no body is walked twice at once.
struct Walk<'a, 'm> {
    bodies: &'a [Option<&'a Node>],
    mins: &'m mut [Min],
    target: usize,
    on_path: &'m mut [bool],
}

/// A step of the recursion check: a node to check with whether nothing
/// has been consumed yet, or a node part way through, waiting on what its
/// last child found.
enum Visit<'a> {
    Node(&'a Node, bool),
    Seq {
        items: &'a [Node],
        next: usize,
        head: bool,
        found: Found,
    },
    Alt {
        items: &'a [Node],
        next: usize,
        head: bool,
        exist: bool,
        must: bool,
    },
    Repeat {
        min: u32,
    },
    /// A group's body is done: it leaves the path.
    Leave(usize),
    Cond {
        cond: &'a Node,
        then: &'a Node,
        otherwise: &'a Node,
        stage: u8,
        head: bool,
        found: Found,
    },
}

impl<'a> Walk<'a, '_> {
    /// infinite_recursive_call_check: `head` while nothing has been
    /// consumed on the way from the group's start. It walks an explicit
    /// stack, since a chain of calls runs as deep as the groups it
    /// passes, and stops at the first call back to the group with
    /// nothing consumed, which every caller hands up unchanged.
    fn infinite(&mut self, node: &'a Node, head: bool) -> Found {
        let mut stack = vec![Visit::Node(node, head)];
        let mut ret = Found::default();
        while let Some(visit) = stack.pop() {
            match visit {
                Visit::Node(node, head) => match node {
                    Node::Seq(items) => stack.push(Visit::Seq {
                        items,
                        next: 0,
                        head,
                        found: Found::default(),
                    }),
                    Node::Alt(items) | Node::Super(items) => stack.push(Visit::Alt {
                        items,
                        next: 0,
                        head,
                        exist: false,
                        must: true,
                    }),
                    Node::Repeat { max: Some(0), .. } => ret = Found::default(),
                    Node::Repeat { body, min, .. } => {
                        stack.push(Visit::Repeat { min: *min });
                        stack.push(Visit::Node(body, head));
                    }
                    Node::Look { body, .. } | Node::Atomic(body) | Node::Options(body) => {
                        stack.push(Visit::Node(body, head))
                    }
                    Node::Call(call) if call.group == self.target => {
                        if head {
                            return Found {
                                exist: true,
                                must: true,
                                infinite: true,
                            };
                        }
                        ret = Found {
                            exist: true,
                            must: true,
                            infinite: false,
                        };
                    }
                    Node::Call(call) => match self.bodies[call.group] {
                        Some(body) if !self.on_path[call.group] => {
                            self.on_path[call.group] = true;
                            stack.push(Visit::Leave(call.group));
                            stack.push(Visit::Node(body, head));
                        }
                        _ => ret = Found::default(),
                    },
                    Node::Group(index, body) => {
                        if self.on_path[*index] {
                            ret = Found::default();
                        } else {
                            self.on_path[*index] = true;
                            stack.push(Visit::Leave(*index));
                            stack.push(Visit::Node(body, head));
                        }
                    }
                    Node::Cond {
                        cond,
                        then,
                        otherwise,
                    } => stack.push(Visit::Cond {
                        cond,
                        then,
                        otherwise,
                        stage: 0,
                        head,
                        found: Found::default(),
                    }),
                    _ => ret = Found::default(),
                },
                Visit::Seq {
                    items,
                    next,
                    mut head,
                    mut found,
                } => {
                    if next > 0 {
                        found = found.or(ret);
                        if head && min_len(&items[next - 1], self.bodies, self.mins) != 0 {
                            head = false;
                        }
                    }
                    if next == items.len() {
                        ret = found;
                    } else {
                        stack.push(Visit::Seq {
                            items,
                            next: next + 1,
                            head,
                            found,
                        });
                        stack.push(Visit::Node(&items[next], head));
                    }
                }
                Visit::Alt {
                    items,
                    next,
                    head,
                    mut exist,
                    mut must,
                } => {
                    if next > 0 {
                        exist |= ret.exist;
                        must &= ret.must;
                    }
                    if next == items.len() {
                        ret = Found {
                            exist,
                            must,
                            infinite: false,
                        };
                    } else {
                        stack.push(Visit::Alt {
                            items,
                            next: next + 1,
                            head,
                            exist,
                            must,
                        });
                        stack.push(Visit::Node(&items[next], head));
                    }
                }
                Visit::Repeat { min } => {
                    if ret.must && min == 0 {
                        ret.must = false;
                    }
                }
                Visit::Leave(index) => self.on_path[index] = false,
                Visit::Cond {
                    cond,
                    then,
                    otherwise,
                    stage,
                    head,
                    mut found,
                } => {
                    let next = match stage {
                        0 => cond,
                        1 => {
                            found = ret;
                            then
                        }
                        2 => {
                            found = found.or(ret);
                            otherwise
                        }
                        _ => {
                            found.exist |= ret.exist;
                            if !ret.must {
                                found.must = false;
                            }
                            ret = found;
                            continue;
                        }
                    };
                    let consumed = stage == 1 && min_len(cond, self.bodies, self.mins) != 0;
                    stack.push(Visit::Cond {
                        cond,
                        then,
                        otherwise,
                        stage: stage + 1,
                        head,
                        found,
                    });
                    stack.push(Visit::Node(next, head && !consumed));
                }
            }
        }
        ret
    }
}

/// A group's shortest match while it is worked out: Oniguruma keeps it
/// on the group once known (FIXED_MIN), and a group reached again while
/// its own is pending counts nothing (MARK1).
#[derive(Clone, Copy)]
enum Min {
    Unknown,
    Pending,
    Known(usize),
}

/// node_min_byte_len in characters: a recursive call counts nothing, nor
/// does a backreference inside a group it names; any other counts the
/// shortest of its groups. It walks an explicit stack, since calls and
/// backreferences chain through as many groups as the pattern holds.
fn min_len(node: &Node, bodies: &[Option<&Node>], mins: &mut [Min]) -> usize {
    let mut tasks = vec![MinTask::Node(node)];
    let mut out: Vec<usize> = Vec::new();
    while let Some(task) = tasks.pop() {
        match task {
            MinTask::Known(group) => {
                mins[group] = Min::Known(out.last().copied().unwrap_or(0));
            }
            MinTask::Combine(node, count) => {
                let values = out.split_off(out.len() - count);
                out.push(match node {
                    Node::Seq(_) => values.iter().fold(0, |sum, v| sum.saturating_add(*v)),
                    Node::Repeat { min, .. } => values[0].saturating_mul(*min as usize),
                    Node::Cond { .. } => values[0].saturating_add(values[1]).min(values[2]),
                    _ => values.into_iter().min().unwrap_or(0),
                });
            }
            MinTask::Node(node) => match node {
                Node::Char(_)
                | Node::Caseless(_)
                | Node::Byte(_)
                | Node::Set(_)
                | Node::Any(_)
                | Node::Newline
                | Node::TextSegment => out.push(1),
                Node::Seq(items) | Node::Alt(items) | Node::Super(items) => {
                    tasks.push(MinTask::Combine(node, items.len()));
                    tasks.extend(items.iter().map(MinTask::Node));
                }
                Node::Repeat { body, .. } => {
                    tasks.push(MinTask::Combine(node, 1));
                    tasks.push(MinTask::Node(body));
                }
                Node::Group(_, body) | Node::Atomic(body) | Node::Options(body) => {
                    tasks.push(MinTask::Node(body))
                }
                Node::Call(call) if call.recursive => out.push(0),
                Node::Call(call) => group_min(call.group, bodies, mins, &mut tasks, &mut out),
                Node::Backref {
                    groups,
                    inside: false,
                    ..
                } => {
                    tasks.push(MinTask::Combine(node, groups.len()));
                    for &group in groups {
                        group_min(group, bodies, mins, &mut tasks, &mut out);
                    }
                }
                Node::Cond {
                    cond,
                    then,
                    otherwise,
                } => {
                    tasks.push(MinTask::Combine(node, 3));
                    tasks.extend([
                        MinTask::Node(otherwise),
                        MinTask::Node(then),
                        MinTask::Node(cond),
                    ]);
                }
                _ => out.push(0),
            },
        }
    }
    out.pop().unwrap_or(0)
}

enum MinTask<'a> {
    Node(&'a Node),
    Combine(&'a Node, usize),
    Known(usize),
}

/// A group's shortest match: known, nothing while pending, or worked out
/// next.
fn group_min<'a>(
    group: usize,
    bodies: &[Option<&'a Node>],
    mins: &mut [Min],
    tasks: &mut Vec<MinTask<'a>>,
    out: &mut Vec<usize>,
) {
    match (mins[group], bodies[group]) {
        (Min::Known(len), _) => out.push(len),
        (Min::Unknown, Some(body)) => {
            mins[group] = Min::Pending;
            tasks.push(MinTask::Known(group));
            tasks.push(MinTask::Node(body));
        }
        _ => out.push(0),
    }
}

/// Each group's length, a group entered again on the way counting as
/// unbounded.
fn group_len(index: usize, bodies: &[Option<&Node>], lens: &mut [Option<Len>]) -> Len {
    if let Some(known) = lens[index] {
        return known;
    }
    let Some(body) = bodies[index] else {
        return (0, None);
    };
    lens[index] = Some((0, None));
    let found = len(body, lens, bodies);
    lens[index] = Some(found);
    found
}

/// How many characters `node` matches; a backreference to a group whose
/// length is not known yet, or a recursive call, is unbounded.
fn len(node: &Node, lens: &mut [Option<Len>], bodies: &[Option<&Node>]) -> Len {
    enum Task<'a> {
        Node(&'a Node),
        Combine(&'a Node, usize),
        Group(usize),
    }
    let mut tasks = vec![Task::Node(node)];
    let mut out = Vec::new();
    while let Some(task) = tasks.pop() {
        match task {
            Task::Group(index) => lens[index] = out.last().copied(),
            Task::Combine(node, count) => {
                let values = out.split_off(out.len() - count);
                let value = match node {
                    Node::Seq(_) => values.into_iter().fold((0, Some(0)), add),
                    Node::Alt(_) | Node::Super(_) => {
                        values.into_iter().reduce(merge).unwrap_or((0, Some(0)))
                    }
                    Node::Repeat { min, max, .. } => {
                        let (lo, hi) = values[0];
                        (
                            lo.saturating_mul(*min as usize),
                            match (hi, max) {
                                (Some(0), _) => Some(0),
                                (Some(hi), Some(max)) => Some(hi.saturating_mul(*max as usize)),
                                _ => None,
                            },
                        )
                    }
                    Node::Cond { .. } => merge(add(values[0], values[1]), values[2]),
                    _ => unreachable!("a length combination"),
                };
                out.push(value);
            }
            Task::Node(node) => {
                let value = match node {
                    Node::Empty
                    | Node::Anchor(_)
                    | Node::Look { .. }
                    | Node::Keep
                    | Node::Check { .. }
                    | Node::Fail
                    | Node::SaveVal(..)
                    | Node::UpdateVar(..)
                    | Node::Callout(_) => (0, Some(0)),
                    Node::Char(_) | Node::Byte(_) | Node::Set(_) | Node::Any(_) => (1, Some(1)),
                    Node::Caseless(_) => unreachable!("unravelled before compiling"),
                    Node::Newline => (1, Some(2)),
                    Node::TextSegment => (1, None),
                    Node::Group(_, body) | Node::Atomic(body) | Node::Options(body) => {
                        tasks.push(Task::Node(body));
                        continue;
                    }
                    Node::Seq(items) | Node::Alt(items) | Node::Super(items) => {
                        tasks.push(Task::Combine(node, items.len()));
                        tasks.extend(items.iter().rev().map(Task::Node));
                        continue;
                    }
                    Node::Repeat { body, .. } => {
                        tasks.push(Task::Combine(node, 1));
                        tasks.push(Task::Node(body));
                        continue;
                    }
                    Node::Cond {
                        cond,
                        then,
                        otherwise,
                    } => {
                        tasks.push(Task::Combine(node, 3));
                        tasks.push(Task::Node(otherwise));
                        tasks.push(Task::Node(then));
                        tasks.push(Task::Node(cond));
                        continue;
                    }
                    Node::Backref { groups, level, .. } => {
                        let mut found = groups.iter().map(|g| lens.get(*g).copied().flatten());
                        match (level, found.next().flatten()) {
                            (None, Some(first)) if found.all(|l| l == Some(first)) => first,
                            _ => (0, None),
                        }
                    }
                    Node::Call(call) => {
                        if call.recursive {
                            (0, None)
                        } else if let Some(known) = lens[call.group] {
                            known
                        } else if let Some(Some(body)) = bodies.get(call.group) {
                            lens[call.group] = Some((0, None));
                            tasks.push(Task::Group(call.group));
                            tasks.push(Task::Node(body));
                            continue;
                        } else {
                            (0, None)
                        }
                    }
                };
                out.push(value);
            }
        }
    }
    out.pop().expect("the root length")
}

impl Groups {
    fn len(&self, node: &Node) -> Len {
        let mut lens = self.lens.clone();
        len(node, &mut lens, &[])
    }
}

/// Checks every lookbehind and reduces its leading quantifiers, as
/// Oniguruma's tune_look_behind does.
fn prepare(node: &mut Node, groups: &Groups) -> Result<(), String> {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if let Node::Look {
            behind: true,
            negate,
            body,
        } = node
        {
            prepare(body, groups)?;
            if behind(body, *negate, groups)? {
                *node = if *negate { Node::Fail } else { Node::Empty };
            }
        } else {
            node.children_mut(&mut stack);
        }
    }
    Ok(())
}

/// A lookbehind's body must match a fixed number of characters once its
/// leading quantifiers are reduced; it steps back that many. True when
/// the body surely matches nothing at its shortest and uses no group, so
/// the lookbehind always holds (tune_look_behind).
fn behind(body: &mut Node, negate: bool, groups: &Groups) -> Result<bool, String> {
    if !allowed_in_behind(body, negate) {
        return Err(INVALID_LOOK_BEHIND.into());
    }
    let (min, sure) = sure_min(body, groups);
    if min == 0 && sure && !uses_groups(body) {
        return Ok(true);
    }
    if let Node::Alt(items) = &mut *body {
        items.iter_mut().for_each(reduce_leading);
    } else {
        reduce_leading(body);
    }
    if let Node::Alt(items) = body {
        let lens: Vec<Len> = items.iter().map(|item| groups.len(item)).collect();
        if lens.iter().any(|l| Some(l.0) != l.1) {
            return Err(INVALID_LOOK_BEHIND.into());
        }
        if lens.windows(2).any(|pair| pair[0] != pair[1]) {
            return Err(INVALID_LOOK_BEHIND.into());
        }
    }
    let (min, max) = groups.len(body);
    if max != Some(min) {
        return Err(INVALID_LOOK_BEHIND.into());
    }
    Ok(false)
}

/// node_char_len's minimum and whether it is sure: an anchor, a group,
/// a call or a backreference of unfixed length leaves it unsure.
fn sure_min(node: &Node, groups: &Groups) -> (usize, bool) {
    match node {
        Node::Seq(items) => items.iter().fold((0, true), |(min, sure), item| {
            let (m, s) = sure_min(item, groups);
            (min.saturating_add(m), sure && s)
        }),
        Node::Alt(items) | Node::Super(items) => {
            let mut found: Option<(usize, bool)> = None;
            for item in items {
                let (m, s) = sure_min(item, groups);
                found = Some(match found {
                    None => (m, s),
                    Some((min, _)) if m < min => (m, s),
                    Some((min, sure)) if m == min => (min, sure || s),
                    Some(kept) => kept,
                });
            }
            found.unwrap_or((0, true))
        }
        Node::Repeat { body, min, .. } => {
            let (m, s) = sure_min(body, groups);
            (m.saturating_mul(*min as usize), s)
        }
        Node::Atomic(body) | Node::Options(body) => sure_min(body, groups),
        Node::Group(_, body) => (sure_min(body, groups).0, false),
        Node::Anchor(_) | Node::Check { .. } | Node::Look { .. } | Node::Keep => (0, false),
        Node::Call(_) | Node::TextSegment => (groups.len(node).0, false),
        Node::Backref { .. } => {
            let (min, max) = groups.len(node);
            (min, max == Some(min))
        }
        Node::Cond {
            cond,
            then,
            otherwise,
        } => {
            let (c, cs) = sure_min(cond, groups);
            let (t, ts) = sure_min(then, groups);
            let (o, os) = sure_min(otherwise, groups);
            let yes = (c.saturating_add(t), cs && ts);
            if o < yes.0 {
                (o, os)
            } else if o == yes.0 {
                (o, os || yes.1)
            } else {
                yes
            }
        }
        node => (groups.len(node).0, true),
    }
}

fn uses_groups(node: &Node) -> bool {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if matches!(
            node,
            Node::Group(..) | Node::Backref { .. } | Node::Check { .. } | Node::Call(_)
        ) {
            return true;
        }
        node.children(&mut stack);
    }
    false
}

/// A lookbehind holds no lookahead, no `\Z` or `\z`, no absent stopper,
/// and when negated no group.
fn allowed_in_behind(node: &Node, negate: bool) -> bool {
    match node {
        Node::Look { behind: false, .. } => false,
        Node::Look {
            behind: true,
            negate: inner,
            body,
        } => (!*inner || negate) && allowed_in_behind(body, negate),
        Node::Anchor(Anchor::SemiEnd | Anchor::BufEnd) => false,
        Node::UpdateVar(_, true) => false,
        Node::Group(_, body) => !negate && allowed_in_behind(body, negate),
        Node::Seq(items) | Node::Alt(items) | Node::Super(items) => {
            items.iter().all(|item| allowed_in_behind(item, negate))
        }
        Node::Repeat { body, .. } | Node::Atomic(body) | Node::Options(body) => {
            allowed_in_behind(body, negate)
        }
        Node::Cond {
            cond,
            then,
            otherwise,
        } => {
            allowed_in_behind(cond, negate)
                && allowed_in_behind(then, negate)
                && allowed_in_behind(otherwise, negate)
        }
        _ => true,
    }
}

/// A lookbehind's leading quantifiers over one unit or a backreference
/// match their minimum: `(?<=a+)` is `(?<=a)`.
fn reduce_leading(node: &mut Node) {
    let reduce = |node: &mut Node| -> bool {
        let Node::Repeat { body, min, max, .. } = node else {
            return false;
        };
        if !matches!(
            **body,
            Node::Char(_) | Node::Byte(_) | Node::Set(_) | Node::Any(_) | Node::Backref { .. }
        ) {
            return false;
        }
        *max = Some(*min);
        *min == 0
    };
    match node {
        Node::Seq(items) => {
            for item in items {
                if !reduce(item) {
                    break;
                }
            }
        }
        node => {
            reduce(node);
        }
    }
}

/// A character every match holds at or after its start: one on the path
/// a match must take, outside lookarounds.
pub(super) fn required(node: &Node) -> Option<char> {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        match node {
            Node::Char(c) => return Some(*c),
            Node::Seq(items) => stack.extend(items.iter().rev()),
            Node::Group(_, body) | Node::Atomic(body) | Node::Options(body) => stack.push(body),
            Node::Repeat { body, min, .. } if *min > 0 => stack.push(body),
            _ => {}
        }
    }
    None
}

/// Whether a call enters a group below `node`, so `{0}` still compiles it.
fn holds_called(node: &Node, called: &[bool]) -> bool {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if matches!(node, Node::Group(index, _) if called[*index]) {
            return true;
        }
        node.children(&mut stack);
    }
    false
}

impl<'a> Compiler<'a> {
    fn emit(&mut self, inst: Inst) -> usize {
        self.insts.push(inst);
        self.insts.len() - 1
    }

    fn here(&self) -> usize {
        self.insts.len()
    }

    fn unit(&mut self, node: &Node) -> Option<Unit> {
        Some(match node {
            Node::Char(c) => Unit::Char(*c),
            Node::Byte(b) => Unit::Byte(*b),
            Node::Any(false) => Unit::Any,
            Node::Any(true) => Unit::AnyNl,
            Node::Set(set) => {
                self.sets.push((**set).clone());
                Unit::Set(self.sets.len() - 1)
            }
            Node::Options(body) => return self.unit(body),
            _ => return None,
        })
    }

    /// The slots of the groups `node` holds, those a call enters too.
    fn group_slots(&self, node: &'a Node, seen: &mut Vec<usize>, out: &mut Vec<usize>) {
        let mut stack = vec![node];
        while let Some(node) = stack.pop() {
            match node {
                Node::Group(index, body) => {
                    out.extend([2 * index, 2 * index + 1]);
                    stack.push(body);
                }
                Node::Call(call) => {
                    if seen.contains(&call.group) {
                        continue;
                    }
                    seen.push(call.group);
                    if let Some(body) = self.bodies[call.group] {
                        if call.group != 0 {
                            out.extend([2 * call.group, 2 * call.group + 1]);
                        }
                        stack.push(body);
                    }
                }
                node => node.children(&mut stack),
            }
        }
    }

    fn node(&mut self, node: &'a Node) {
        enum Task<'a> {
            Node(&'a Node),
            Emit(Inst),
            Jump(usize),
            Look {
                start: usize,
                behind: Option<usize>,
                negate: bool,
            },
            /// A called group's end; its loops begin at `loops`.
            Group {
                index: usize,
                jump: usize,
                loops: usize,
            },
            Alt {
                items: &'a [Node],
                keep: bool,
                jumps: Vec<usize>,
            },
            AltNext {
                items: &'a [Node],
                keep: bool,
                jumps: Vec<usize>,
                split: usize,
            },
            AltEnd(Vec<usize>),
            Optional {
                split: usize,
                greedy: bool,
            },
            Repeat {
                id: usize,
                head: usize,
                min: u32,
                max: Option<u32>,
                greedy: bool,
            },
            CondThen {
                split: usize,
                then: &'a Node,
                otherwise: &'a Node,
            },
            CondElse {
                split: usize,
                otherwise: &'a Node,
            },
        }
        let mut tasks = vec![Task::Node(node)];
        while let Some(task) = tasks.pop() {
            match task {
                Task::Emit(inst) => {
                    self.emit(inst);
                }
                Task::Jump(at) => self.insts[at] = Inst::Jump(self.here()),
                Task::Look {
                    start,
                    behind,
                    negate,
                } => {
                    self.emit(Inst::LookEnd { negate });
                    self.insts[start] = Inst::LookStart {
                        negate,
                        behind,
                        exit: self.here(),
                    };
                }
                Task::Group { index, jump, loops } => {
                    self.ranges[index] = loops..self.loops.len();
                    if index != 0 {
                        self.emit(if self.groups.recursive[index] {
                            Inst::SaveRec(index)
                        } else {
                            Inst::Save(2 * index + 1)
                        });
                    }
                    self.emit(Inst::Return);
                    self.insts[jump] = Inst::Jump(self.here());
                }
                Task::Alt { items, keep, jumps } => match items.split_first() {
                    None => {
                        self.emit(Inst::Fail);
                    }
                    Some((item, [])) => {
                        tasks.push(Task::AltEnd(jumps));
                        tasks.push(Task::Node(item));
                    }
                    Some((item, rest)) => {
                        let split = self.emit(Inst::Fail);
                        tasks.push(Task::AltNext {
                            items: rest,
                            keep,
                            jumps,
                            split,
                        });
                        tasks.push(Task::Node(item));
                    }
                },
                Task::AltNext {
                    items,
                    keep,
                    mut jumps,
                    split,
                } => {
                    jumps.push(self.emit(Inst::Jump(0)));
                    let next = self.here();
                    self.insts[split] = if keep {
                        Inst::SplitSuper(split + 1, next)
                    } else {
                        Inst::Split(split + 1, next)
                    };
                    tasks.push(Task::Alt { items, keep, jumps });
                }
                Task::AltEnd(jumps) => {
                    let end = self.here();
                    for jump in jumps {
                        self.insts[jump] = Inst::Jump(end);
                    }
                }
                Task::Optional { split, greedy } => {
                    let end = self.here();
                    self.insts[split] = if greedy {
                        Inst::Split(split + 1, end)
                    } else {
                        Inst::Split(end, split + 1)
                    };
                }
                Task::Repeat {
                    id,
                    head,
                    min,
                    max,
                    greedy,
                } => {
                    self.emit(Inst::RepEnd { id, head, min });
                    self.insts[head] = Inst::RepLoop {
                        id,
                        min,
                        max,
                        greedy,
                        exit: self.here(),
                    };
                }
                Task::CondThen {
                    split,
                    then,
                    otherwise,
                } => {
                    self.emit(Inst::AtomicEnd);
                    tasks.push(Task::CondElse { split, otherwise });
                    tasks.push(Task::Node(then));
                }
                Task::CondElse { split, otherwise } => {
                    let jump = self.emit(Inst::Jump(0));
                    self.insts[split] = Inst::Split(split + 1, self.here());
                    self.emit(Inst::AtomicEnd);
                    tasks.push(Task::Jump(jump));
                    tasks.push(Task::Node(otherwise));
                }
                Task::Node(node) => match node {
                    Node::Empty => {}
                    Node::Char(_) | Node::Byte(_) | Node::Set(_) | Node::Any(_) => {
                        if let Some(unit) = self.unit(node) {
                            self.emit(Inst::Unit(unit));
                        }
                    }
                    Node::Caseless(_) => unreachable!("unravelled before compiling"),
                    Node::Seq(items) => tasks.extend(items.iter().rev().map(Task::Node)),
                    Node::Alt(items) | Node::Super(items) => tasks.push(Task::Alt {
                        items,
                        keep: matches!(node, Node::Super(_)),
                        jumps: Vec::new(),
                    }),
                    Node::Group(index, body) => {
                        if !self.groups.called[*index] {
                            self.emit(Inst::Save(2 * index));
                            tasks.push(Task::Emit(Inst::Save(2 * index + 1)));
                        } else {
                            let call = self.emit(Inst::Fail);
                            let jump = self.emit(Inst::Jump(0));
                            self.addrs[*index] = Some(self.here());
                            self.calls.push((call, *index));
                            if *index != 0 {
                                self.emit(Inst::Save(2 * index));
                            }
                            tasks.push(Task::Group {
                                index: *index,
                                jump,
                                loops: self.loops.len(),
                            });
                        }
                        tasks.push(Task::Node(body));
                    }
                    Node::Repeat {
                        body,
                        min,
                        max,
                        greedy,
                    } => {
                        if *max == Some(0) {
                            if holds_called(body, &self.groups.called) {
                                let jump = self.emit(Inst::Jump(0));
                                tasks.push(Task::Jump(jump));
                                tasks.push(Task::Node(body));
                            }
                        } else if let Some(unit) = self.unit(body) {
                            self.emit(Inst::Star {
                                unit,
                                min: *min,
                                max: *max,
                                greedy: *greedy,
                            });
                        } else if *min == 0 && *max == Some(1) {
                            let split = self.emit(Inst::Split(0, 0));
                            tasks.push(Task::Optional {
                                split,
                                greedy: *greedy,
                            });
                            tasks.push(Task::Node(body));
                        } else {
                            let id = self.loops.len();
                            let mut slots = Vec::new();
                            if self.groups.len(body).0 == 0 {
                                self.group_slots(body, &mut Vec::new(), &mut slots);
                            }
                            self.loops.push(slots.into_boxed_slice());
                            self.emit(Inst::RepStart(id));
                            let head = self.emit(Inst::Fail);
                            tasks.push(Task::Repeat {
                                id,
                                head,
                                min: *min,
                                max: *max,
                                greedy: *greedy,
                            });
                            tasks.push(Task::Node(body));
                        }
                    }
                    Node::Atomic(body) => {
                        self.emit(Inst::AtomicStart);
                        tasks.push(Task::Emit(Inst::AtomicEnd));
                        tasks.push(Task::Node(body));
                    }
                    Node::Options(body) => tasks.push(Task::Node(body)),
                    Node::Look {
                        behind,
                        negate,
                        body,
                    } => {
                        let behind = behind.then(|| self.groups.len(body).0);
                        let start = self.emit(Inst::Fail);
                        tasks.push(Task::Look {
                            start,
                            behind,
                            negate: *negate,
                        });
                        tasks.push(Task::Node(body));
                    }
                    Node::Anchor(anchor) => {
                        self.emit(Inst::Anchor(*anchor));
                    }
                    Node::Backref {
                        groups,
                        fold,
                        level,
                        ..
                    } => {
                        self.emit(Inst::Backref {
                            groups: groups.clone().into_boxed_slice(),
                            fold: *fold,
                            level: *level,
                        });
                    }
                    Node::Check { groups, level } => {
                        self.emit(Inst::Check {
                            groups: groups.clone().into_boxed_slice(),
                            level: *level,
                        });
                    }
                    Node::Cond {
                        cond,
                        then,
                        otherwise,
                    } => {
                        self.emit(Inst::AtomicStart);
                        let split = self.emit(Inst::Fail);
                        tasks.push(Task::CondThen {
                            split,
                            then,
                            otherwise,
                        });
                        tasks.push(Task::Node(cond));
                    }
                    Node::Keep => {
                        self.emit(Inst::Keep);
                    }
                    Node::Newline => {
                        self.emit(Inst::Newline);
                    }
                    Node::Call(call) => {
                        let at = self.emit(Inst::Fail);
                        self.calls.push((at, call.group));
                    }
                    Node::TextSegment => {
                        self.emit(Inst::TextSegment);
                    }
                    Node::Fail => {
                        self.emit(Inst::Fail);
                    }
                    Node::SaveVal(kind, id) => {
                        self.emit(Inst::SaveVal(*kind, *id));
                    }
                    Node::UpdateVar(update, _) => {
                        self.emit(Inst::UpdateVar(*update));
                    }
                    Node::Callout(index) => {
                        self.emit(Inst::Callout(*index));
                    }
                },
            }
        }
    }
}
