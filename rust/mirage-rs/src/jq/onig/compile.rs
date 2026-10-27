// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regcomp.c. See licenses/third_party/oniguruma.txt.

use super::class::Set;
use super::parse::{Anchor, Node};

const INVALID_LOOK_BEHIND: &str = "invalid pattern in look-behind";

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
    Jump(usize),
    Save(usize),
    Anchor(Anchor),
    Backref(Box<[usize]>, bool),
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
    /// Go on when a group is set, else at the second (or fail).
    Cond(Box<[usize]>, Option<usize>),
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
}

/// The fewest and most characters a node matches; None is unbounded.
type Len = (usize, Option<usize>);

fn add(a: Len, b: Len) -> Len {
    (
        a.0.saturating_add(b.0),
        a.1.zip(b.1).map(|(x, y)| x.saturating_add(y)),
    )
}

struct Compiler<'a> {
    insts: Vec<Inst>,
    sets: Vec<Set>,
    loops: Vec<Box<[usize]>>,
    /// Each group's length, for a backreference's.
    group_lens: &'a [Option<Len>],
}

pub(super) fn compile(mut node: Node, groups: usize) -> Result<Program, String> {
    let mut group_lens = vec![None; groups + 1];
    lens_of_groups(&node, &mut group_lens);
    prepare(&mut node, &group_lens)?;
    let mut compiler = Compiler {
        insts: Vec::new(),
        sets: Vec::new(),
        loops: Vec::new(),
        group_lens: &group_lens,
    };
    compiler.node(&node);
    compiler.insts.push(Inst::Match);
    Ok(Program {
        insts: compiler.insts,
        sets: compiler.sets,
        loops: compiler.loops,
        slots: 2 * (groups + 1),
    })
}

fn lens_of_groups(node: &Node, lens: &mut [Option<Len>]) {
    match node {
        Node::Group(index, body) => {
            lens[*index] = Some(len(body, &[]));
            lens_of_groups(body, lens);
        }
        Node::Seq(items) | Node::Alt(items) => {
            for item in items {
                lens_of_groups(item, lens);
            }
        }
        Node::Repeat { body, .. } | Node::Atomic(body) | Node::Look { body, .. } => {
            lens_of_groups(body, lens)
        }
        Node::Cond(_, Some((yes, no))) => {
            lens_of_groups(yes, lens);
            lens_of_groups(no, lens);
        }
        _ => {}
    }
}

/// How many characters `node` matches; a backreference to a group whose
/// length `groups` does not know is unbounded.
fn len(node: &Node, groups: &[Option<Len>]) -> Len {
    match node {
        Node::Empty | Node::Anchor(_) | Node::Look { .. } | Node::Keep => (0, Some(0)),
        Node::Char(_) | Node::Byte(_) | Node::Set(_) | Node::Any(_) => (1, Some(1)),
        Node::Newline => (1, Some(2)),
        Node::Seq(items) => items
            .iter()
            .fold((0, Some(0)), |acc, item| add(acc, len(item, groups))),
        Node::Alt(items) => {
            let lens: Vec<Len> = items.iter().map(|item| len(item, groups)).collect();
            let min = lens.iter().map(|l| l.0).min().unwrap_or(0);
            let max = lens.iter().try_fold(0, |acc, l| l.1.map(|m| acc.max(m)));
            (min, max)
        }
        Node::Group(_, body) | Node::Atomic(body) => len(body, groups),
        Node::Repeat { body, min, max, .. } => {
            let (lo, hi) = len(body, groups);
            (
                lo.saturating_mul(*min as usize),
                match (hi, max) {
                    (Some(0), _) => Some(0),
                    (Some(hi), Some(max)) => Some(hi.saturating_mul(*max as usize)),
                    _ => None,
                },
            )
        }
        Node::Backref(refs, _) => {
            let mut lens = refs.iter().map(|g| groups.get(*g).copied().flatten());
            match lens.next().flatten() {
                Some(first) if lens.all(|l| l == Some(first)) => first,
                _ => (0, None),
            }
        }
        Node::Cond(_, None) => (0, Some(0)),
        Node::Cond(_, Some((yes, no))) => {
            let (a, b) = (len(yes, groups), len(no, groups));
            (a.0.min(b.0), a.1.zip(b.1).map(|(x, y)| x.max(y)))
        }
    }
}

/// Checks every lookbehind and reduces its leading quantifiers, as
/// Oniguruma's tune_look_behind does.
fn prepare(node: &mut Node, groups: &[Option<Len>]) -> Result<(), String> {
    match node {
        Node::Look {
            behind: true,
            negate,
            body,
        } => {
            prepare(body, groups)?;
            behind(body, *negate, groups)
        }
        Node::Seq(items) | Node::Alt(items) => {
            items.iter_mut().try_for_each(|item| prepare(item, groups))
        }
        Node::Group(_, body)
        | Node::Repeat { body, .. }
        | Node::Atomic(body)
        | Node::Look { body, .. } => prepare(body, groups),
        Node::Cond(_, Some((yes, no))) => {
            prepare(yes, groups)?;
            prepare(no, groups)
        }
        _ => Ok(()),
    }
}

/// A lookbehind's body must match a fixed number of characters once its
/// leading quantifiers are reduced; it steps back that many.
fn behind(body: &mut Node, negate: bool, groups: &[Option<Len>]) -> Result<(), String> {
    if !allowed_in_behind(body, negate) {
        return Err(INVALID_LOOK_BEHIND.into());
    }
    if let Node::Alt(items) = &mut *body {
        items.iter_mut().for_each(reduce_leading);
    } else {
        reduce_leading(body);
    }
    if let Node::Alt(items) = body {
        let lens: Vec<Len> = items.iter().map(|item| len(item, groups)).collect();
        if lens.iter().any(|l| Some(l.0) != l.1) {
            return Err(INVALID_LOOK_BEHIND.into());
        }
        if lens.windows(2).any(|pair| pair[0] != pair[1]) {
            return Err(INVALID_LOOK_BEHIND.into());
        }
    }
    let (min, max) = len(body, groups);
    if max != Some(min) {
        return Err(INVALID_LOOK_BEHIND.into());
    }
    Ok(())
}

/// A lookbehind holds no lookahead, no `\Z` or `\z`, and when negated no
/// group.
fn allowed_in_behind(node: &Node, negate: bool) -> bool {
    match node {
        Node::Look { behind: false, .. } => false,
        Node::Look {
            behind: true,
            negate: inner,
            body,
        } => (!*inner || negate) && allowed_in_behind(body, negate),
        Node::Anchor(Anchor::SemiEnd | Anchor::BufEnd) => false,
        Node::Group(_, body) => !negate && allowed_in_behind(body, negate),
        Node::Seq(items) | Node::Alt(items) => {
            items.iter().all(|item| allowed_in_behind(item, negate))
        }
        Node::Repeat { body, .. } | Node::Atomic(body) => allowed_in_behind(body, negate),
        Node::Cond(_, Some((yes, no))) => {
            allowed_in_behind(yes, negate) && allowed_in_behind(no, negate)
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
            Node::Char(_) | Node::Byte(_) | Node::Set(_) | Node::Any(_) | Node::Backref(..)
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
    match node {
        Node::Char(c) => Some(*c),
        Node::Seq(items) => items.iter().find_map(required),
        Node::Group(_, body) | Node::Atomic(body) => required(body),
        Node::Repeat { body, min, .. } if *min > 0 => required(body),
        _ => None,
    }
}

/// The slots of the groups `node` holds.
fn group_slots(node: &Node, out: &mut Vec<usize>) {
    match node {
        Node::Group(index, body) => {
            out.extend([2 * index, 2 * index + 1]);
            group_slots(body, out);
        }
        Node::Seq(items) | Node::Alt(items) => {
            for item in items {
                group_slots(item, out);
            }
        }
        Node::Repeat { body, .. } | Node::Atomic(body) | Node::Look { body, .. } => {
            group_slots(body, out)
        }
        Node::Cond(_, Some((yes, no))) => {
            group_slots(yes, out);
            group_slots(no, out);
        }
        _ => {}
    }
}

impl Compiler<'_> {
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
            _ => return None,
        })
    }

    fn node(&mut self, node: &Node) {
        match node {
            Node::Empty => {}
            Node::Char(_) | Node::Byte(_) | Node::Set(_) | Node::Any(_) => {
                if let Some(unit) = self.unit(node) {
                    self.emit(Inst::Unit(unit));
                }
            }
            Node::Seq(items) => items.iter().for_each(|item| self.node(item)),
            Node::Alt(items) if items.is_empty() => {
                self.emit(Inst::Fail);
            }
            Node::Alt(items) => {
                let mut jumps = Vec::new();
                for (i, item) in items.iter().enumerate() {
                    if i + 1 == items.len() {
                        self.node(item);
                        break;
                    }
                    let split = self.emit(Inst::Split(0, 0));
                    self.node(item);
                    jumps.push(self.emit(Inst::Jump(0)));
                    let next = self.here();
                    self.insts[split] = Inst::Split(split + 1, next);
                }
                let end = self.here();
                for jump in jumps {
                    self.insts[jump] = Inst::Jump(end);
                }
            }
            Node::Group(index, body) => {
                self.emit(Inst::Save(2 * index));
                self.node(body);
                self.emit(Inst::Save(2 * index + 1));
            }
            Node::Repeat {
                body,
                min,
                max,
                greedy,
            } => self.repeat(body, *min, *max, *greedy),
            Node::Atomic(body) => {
                self.emit(Inst::AtomicStart);
                self.node(body);
                self.emit(Inst::AtomicEnd);
            }
            Node::Look {
                behind,
                negate,
                body,
            } => {
                let fixed = if *behind {
                    Some(len(body, self.group_lens).0)
                } else {
                    None
                };
                let start = self.emit(Inst::Fail);
                self.node(body);
                self.emit(Inst::LookEnd { negate: *negate });
                let exit = self.here();
                self.insts[start] = Inst::LookStart {
                    negate: *negate,
                    behind: fixed,
                    exit,
                };
            }
            Node::Anchor(anchor) => {
                self.emit(Inst::Anchor(*anchor));
            }
            Node::Backref(groups, fold) => {
                self.emit(Inst::Backref(groups.clone().into_boxed_slice(), *fold));
            }
            Node::Cond(groups, None) => {
                self.emit(Inst::Cond(groups.clone().into_boxed_slice(), None));
            }
            Node::Cond(groups, Some((yes, no))) => {
                let cond = self.emit(Inst::Fail);
                self.node(yes);
                let jump = self.emit(Inst::Jump(0));
                let other = self.here();
                self.node(no);
                let end = self.here();
                self.insts[cond] = Inst::Cond(groups.clone().into_boxed_slice(), Some(other));
                self.insts[jump] = Inst::Jump(end);
            }
            Node::Keep => {
                self.emit(Inst::Keep);
            }
            Node::Newline => {
                self.emit(Inst::Newline);
            }
        }
    }

    fn repeat(&mut self, body: &Node, min: u32, max: Option<u32>, greedy: bool) {
        if max == Some(0) {
            return;
        }
        if let Some(unit) = self.unit(body) {
            self.emit(Inst::Star {
                unit,
                min,
                max,
                greedy,
            });
            return;
        }
        if min == 0 && max == Some(1) {
            let split = self.emit(Inst::Split(0, 0));
            self.node(body);
            let end = self.here();
            self.insts[split] = if greedy {
                Inst::Split(split + 1, end)
            } else {
                Inst::Split(end, split + 1)
            };
            return;
        }
        let id = self.loops.len();
        let mut slots = Vec::new();
        if len(body, self.group_lens).0 == 0 {
            group_slots(body, &mut slots);
        }
        self.loops.push(slots.into_boxed_slice());
        self.emit(Inst::RepStart(id));
        let head = self.emit(Inst::Fail);
        self.node(body);
        self.emit(Inst::RepEnd { id, head, min });
        let exit = self.here();
        self.insts[head] = Inst::RepLoop {
            id,
            min,
            max,
            greedy,
            exit,
        };
    }
}
