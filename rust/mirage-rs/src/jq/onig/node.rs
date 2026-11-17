// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regparse.c. See licenses/third_party/oniguruma.txt.

use super::class::Set;

#[derive(Debug)]
pub(super) enum Node {
    Empty,
    Char(char),
    /// A literal read under ignore-case, which `fold::unravel` rewrites
    /// before the tree is compiled.
    Caseless(char),
    /// A byte `\xHH` names that starts no character.
    Byte(u8),
    Set(Box<Set>),
    /// `.`: with true, a newline too.
    Any(bool),
    Seq(Vec<Node>),
    Alt(Vec<Node>),
    /// An alternation whose branches survive an atomic cut (Oniguruma's
    /// ND_ST_SUPER), from the absent stopper and range clear.
    Super(Vec<Node>),
    Group(usize, Box<Node>),
    Repeat {
        body: Box<Node>,
        min: u32,
        max: Option<u32>,
        greedy: bool,
    },
    Atomic(Box<Node>),
    /// `(?i:...)`: its own node, so a caseless run never joins across it.
    Options(Box<Node>),
    Look {
        behind: bool,
        negate: bool,
        body: Box<Node>,
    },
    Anchor(Anchor),
    /// The groups a reference may match, the last tried first, whether it
    /// ignores case, its recursion level (`\k<n+l>`) and whether it sits
    /// inside a group it names (Oniguruma's ND_ST_RECURSION).
    Backref {
        groups: Vec<usize>,
        fold: bool,
        level: Option<i64>,
        inside: bool,
    },
    /// `(?(n)...)`'s test: whether a group is set, at a level.
    Check {
        groups: Vec<usize>,
        level: Option<i64>,
    },
    /// `(?(cond)yes|no)`.
    Cond {
        cond: Box<Node>,
        then: Box<Node>,
        otherwise: Box<Node>,
    },
    /// `\K`.
    Keep,
    /// `\R`.
    Newline,
    Call(Call),
    /// `\X`.
    TextSegment,
    Fail,
    SaveVal(Saved, usize),
    /// The flag marks the absent stopper's update, which a look-behind
    /// refuses (ABSENT_WITH_SIDE_EFFECTS).
    UpdateVar(Update, bool),
    /// An entry of `Parsed::callouts`.
    Callout(usize),
}

impl Node {
    pub(super) fn children<'a>(&'a self, stack: &mut Vec<&'a Node>) {
        match self {
            Node::Seq(items) | Node::Alt(items) | Node::Super(items) => {
                stack.extend(items.iter().rev())
            }
            Node::Group(_, body)
            | Node::Repeat { body, .. }
            | Node::Atomic(body)
            | Node::Options(body)
            | Node::Look { body, .. } => stack.push(body),
            Node::Cond {
                cond,
                then,
                otherwise,
            } => {
                stack.push(otherwise);
                stack.push(then);
                stack.push(cond);
            }
            _ => {}
        }
    }

    pub(super) fn children_mut<'a>(&'a mut self, stack: &mut Vec<&'a mut Node>) {
        match self {
            Node::Seq(items) | Node::Alt(items) | Node::Super(items) => {
                stack.extend(items.iter_mut().rev())
            }
            Node::Group(_, body)
            | Node::Repeat { body, .. }
            | Node::Atomic(body)
            | Node::Options(body)
            | Node::Look { body, .. } => stack.push(body),
            Node::Cond {
                cond,
                then,
                otherwise,
            } => {
                stack.push(otherwise);
                stack.push(then);
                stack.push(cond);
            }
            _ => {}
        }
    }
}

pub(super) fn seq(mut items: Vec<Node>) -> Node {
    match items.len() {
        0 => Node::Empty,
        1 => items.pop().unwrap_or(Node::Empty),
        _ => Node::Seq(items),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Anchor {
    /// `\A`.
    BufStart,
    /// `\z`.
    BufEnd,
    /// `\Z`: the end, or before a newline that ends the subject.
    SemiEnd,
    LineStart,
    LineEnd,
    /// `\G`: where the search began.
    SearchStart,
    WordBoundary,
    NotWordBoundary,
    /// `\y`: an extended grapheme cluster boundary.
    TextSegmentBoundary,
    /// `\Y`.
    NotTextSegmentBoundary,
}

/// A subexp call, resolved to its group once every group is known.
#[derive(Debug)]
pub(super) struct Call {
    pub(super) group: usize,
    /// The text between the brackets, for an error.
    pub(super) text: String,
    pub(super) by_name: bool,
    /// Whether the call is reachable from its own group's body, so its
    /// length is unknown (Oniguruma's ND_ST_RECURSION on a call).
    pub(super) recursive: bool,
}

/// What a SAVE_VAL gimmick keeps on the stack.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Saved {
    /// The current position.
    Pos,
    /// The right range the absent operator narrows.
    Right,
}

/// An UPDATE_VAR gimmick.
#[derive(Clone, Copy, Debug)]
pub(super) enum Update {
    /// The right range becomes the position a SAVE_VAL of that id kept.
    RightFromPos(usize),
    /// The right range becomes what a SAVE_VAL of that id kept.
    RightFromRight(usize),
    /// The position becomes what a SAVE_VAL of that id kept.
    PosFromPos(usize),
    /// The right range becomes the end of the subject.
    RightInit,
}
