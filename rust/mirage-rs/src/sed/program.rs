use std::collections::HashMap;

use crate::regex::posix::Posix;

/// One -e expression, or one -f file with the name its diagnostics give.
pub(super) struct Piece {
    pub(super) text: Vec<u8>,
    pub(super) file: Option<Vec<u8>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Address {
    Line(u64),
    Last,
    /// An expression by its place in the program's table, None for the
    /// empty one, which matches as the last expression used.
    Regex(Option<usize>),
    /// `first~step`, the step past zero.
    Step(u64, u64),
    /// `addr,+N`.
    Plus(u64),
    /// `addr,~N`.
    Multiple(u64),
}

impl Address {
    /// The number GNU checks against line 0.
    pub(super) fn number(self) -> u64 {
        match self {
            Address::Line(n) | Address::Step(n, _) | Address::Plus(n) | Address::Multiple(n) => n,
            Address::Last | Address::Regex(_) => 0,
        }
    }
}

/// A piece of an `s` replacement: text, a group (0 for the whole match),
/// or a case conversion (`L U l u E`).
pub(super) enum Part {
    Text(Vec<u8>),
    Group(usize),
    Case(u8),
}

pub(super) struct Subst {
    pub(super) regex: Option<usize>,
    pub(super) parts: Vec<Part>,
    pub(super) global: bool,
    pub(super) occurrence: u64,
    pub(super) print: bool,
    pub(super) wfile: Option<usize>,
}

/// `y`'s table: by byte, or by character under UTF-8.
pub(super) enum Translit {
    Bytes(Box<[u8; 256]>),
    Chars(HashMap<Vec<u8>, Vec<u8>>),
}

/// One command: its addresses, its letter and what it carries.
pub(super) struct Command {
    pub(super) name: u8,
    pub(super) addr1: Option<Address>,
    pub(super) addr2: Option<Address>,
    pub(super) negate: bool,
    /// `a`, `i` and `c`'s text, None when there is none at all.
    pub(super) text: Option<Vec<u8>>,
    pub(super) label: Vec<u8>,
    /// Where `b`, `t` and `T` jump; where `{` ends.
    pub(super) target: usize,
    /// The file `r`, `R`, `w` or `W` names, by its place in the
    /// program's list for that kind.
    pub(super) file: usize,
    pub(super) number: Option<i64>,
    pub(super) subst: Option<Box<Subst>>,
    pub(super) translit: Option<Translit>,
}

impl Command {
    /// Whether the command is addressed by line 0 alone (`0r`).
    pub(super) fn zero_line(&self) -> bool {
        self.addr1 == Some(Address::Line(0)) && self.addr2.is_none()
    }
}

/// A compiled script: its commands in order, its expressions, the files
/// its `w`, `r` and `R` commands name in the order they first appear, and
/// whether `#n` made it quiet.
#[derive(Default)]
pub(super) struct Program {
    pub(super) commands: Vec<Command>,
    pub(super) regexes: Vec<Posix>,
    pub(super) wfiles: Vec<Vec<u8>>,
    pub(super) rfiles: Vec<Vec<u8>>,
    pub(super) reader_files: Vec<Vec<u8>>,
    pub(super) quiet: bool,
    /// Under --debug, each command as it lists.
    pub(super) listing: Vec<Vec<u8>>,
}

/// An expression as --debug lists it: the text regcomp gets, and its
/// flags.
pub(super) struct Source {
    pub(super) text: Vec<u8>,
    pub(super) icase: bool,
    pub(super) multiline: bool,
}
