use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::Span;

const QUOTED: &[u8] = b"*?[@+!()|";

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Dialect {
    #[default]
    Shell,
    Python,
}

#[derive(Clone)]
pub(super) struct Group {
    pub(super) end: usize,
    pub(super) branches: Vec<Span>,
}

#[derive(Clone, Copy)]
pub(super) enum Atom {
    Literal(u32),
    Range(u32, u32),
    Class(Class),
}

impl Atom {
    pub(super) fn contains(self, cp: u32) -> bool {
        match self {
            Self::Literal(unit) => unit == cp,
            Self::Range(lo, hi) => lo <= cp && cp <= hi,
            Self::Class(class) => class.contains(cp),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum Class {
    Alpha,
    Digit,
    Alnum,
    Upper,
    Lower,
    Space,
    Blank,
    Punct,
    Print,
    Graph,
    Cntrl,
    Xdigit,
}

impl Class {
    fn named(name: &[u32]) -> Option<Self> {
        let choices: &[(&[u8], Self)] = &[
            (b"alpha", Self::Alpha),
            (b"digit", Self::Digit),
            (b"alnum", Self::Alnum),
            (b"upper", Self::Upper),
            (b"lower", Self::Lower),
            (b"space", Self::Space),
            (b"blank", Self::Blank),
            (b"punct", Self::Punct),
            (b"print", Self::Print),
            (b"graph", Self::Graph),
            (b"cntrl", Self::Cntrl),
            (b"xdigit", Self::Xdigit),
        ];
        choices.iter().find_map(|(text, class)| {
            (name.len() == text.len() && name.iter().zip(*text).all(|(&a, &b)| a == u32::from(b)))
                .then_some(*class)
        })
    }
    pub(super) fn contains(self, cp: u32) -> bool {
        let alpha = (65..=90).contains(&cp) || (97..=122).contains(&cp);
        let digit = (48..=57).contains(&cp);
        match self {
            Self::Alpha => alpha,
            Self::Digit => digit,
            Self::Alnum => alpha || digit,
            Self::Upper => (65..=90).contains(&cp),
            Self::Lower => (97..=122).contains(&cp),
            Self::Space => cp == 32 || (9..=13).contains(&cp),
            Self::Blank => cp == 32 || cp == 9,
            Self::Punct => (33..=126).contains(&cp) && !alpha && !digit,
            Self::Print => (32..=126).contains(&cp),
            Self::Graph => (33..=126).contains(&cp),
            Self::Cntrl => cp < 32 || cp == 127,
            Self::Xdigit => digit || (65..=70).contains(&cp) || (97..=102).contains(&cp),
        }
    }
}

pub(super) struct Bracket {
    pub(super) end: usize,
    pub(super) negate: bool,
    pub(super) valid: bool,
    pub(super) atoms: Vec<Atom>,
}
struct OpenGroup {
    open: usize,
    start: usize,
    depth: usize,
    pub(super) branches: Vec<Span>,
}
pub(super) struct Program {
    pub(super) units: Vec<u32>,
    pub(super) dialect: Dialect,
    pub(super) extglob: bool,
    pub(super) brackets: HashMap<usize, Bracket>,
    pub(super) groups: HashMap<usize, Group>,
    pub(super) transitions: HashMap<usize, Vec<usize>>,
    pub(super) stars: HashMap<usize, usize>,
    pub(super) floors: HashSet<usize>,
}
impl Program {
    pub(super) fn literal(&self, cp: u32) -> u32 {
        if (0x11_0000..=0x11_007f).contains(&cp) {
            cp - 0x11_0000
        } else if self.dialect == Dialect::Shell {
            unquote(cp)
        } else {
            cp
        }
    }
}
fn unquote(cp: u32) -> u32 {
    cp.checked_sub(0xfdd0)
        .and_then(|i| QUOTED.get(i as usize))
        .map_or(cp, |&c| u32::from(c))
}
pub(super) fn quote(cp: u32) -> u32 {
    QUOTED
        .iter()
        .position(|&c| u32::from(c) == cp)
        .map_or(cp, |i| 0xfdd0 + i as u32)
}
pub(super) fn is(cp: u32, byte: u8) -> bool {
    cp == u32::from(byte)
}
pub(super) fn has(cp: u32, bytes: &[u8]) -> bool {
    bytes.iter().any(|&b| is(cp, b))
}
pub(super) struct Compiler {
    pub(super) program: Program,
    index: usize,
    groups: Vec<OpenGroup>,
    closes: HashMap<usize, usize>,
    phase: CompilePhase,
}
enum CompilePhase {
    Scan,
    Bracket {
        open: usize,
        cursor: usize,
    },
    ClassClose {
        open: usize,
        cursor: usize,
        search: usize,
    },
    Atoms {
        open: usize,
        cursor: usize,
        bracket: Bracket,
    },
    Named {
        open: usize,
        cursor: usize,
        search: usize,
        bracket: Bracket,
    },
    Wire {
        open: usize,
        branch: usize,
    },
    Stars {
        cursor: usize,
        last: Option<usize>,
        outer: Option<usize>,
    },
    Done,
}
impl Compiler {
    pub(super) fn new(units: Vec<u32>, dialect: Dialect, extglob: bool) -> Self {
        Self {
            program: Program {
                units,
                dialect,
                extglob: extglob && dialect == Dialect::Shell,
                brackets: HashMap::new(),
                groups: HashMap::new(),
                transitions: HashMap::new(),
                stars: HashMap::new(),
                floors: HashSet::new(),
            },
            index: 0,
            groups: Vec::new(),
            closes: HashMap::new(),
            phase: CompilePhase::Scan,
        }
    }
    pub(super) fn done(&self) -> bool {
        matches!(self.phase, CompilePhase::Done)
    }
    pub(super) fn step(&mut self) {
        let phase = std::mem::replace(&mut self.phase, CompilePhase::Scan);
        let p = &self.program.units;
        match phase {
            CompilePhase::Done => self.phase = CompilePhase::Done,
            CompilePhase::Scan => {
                let Some(&cp) = p.get(self.index) else {
                    self.phase = CompilePhase::Stars {
                        cursor: p.len(),
                        last: None,
                        outer: None,
                    };
                    return;
                };
                if is(cp, b'[') {
                    let mut cursor = self.index + 1;
                    if p.get(cursor).is_some_and(|&c| {
                        is(c, b'!') || (self.program.dialect == Dialect::Shell && is(c, b'^'))
                    }) {
                        cursor += 1;
                    }
                    if p.get(cursor) == Some(&u32::from(b']')) {
                        cursor += 1;
                    }
                    self.phase = CompilePhase::Bracket {
                        open: self.index,
                        cursor,
                    };
                    return;
                }
                if self.program.dialect == Dialect::Shell
                    && has(cp, b"@?*+!")
                    && p.get(self.index + 1) == Some(&u32::from(b'('))
                {
                    self.groups.push(OpenGroup {
                        open: self.index,
                        start: self.index + 2,
                        depth: 0,
                        branches: Vec::new(),
                    });
                    self.index += 2;
                    return;
                }
                if let Some(frame) = self.groups.last_mut() {
                    if is(cp, b'(') {
                        frame.depth += 1;
                    } else if is(cp, b')') && frame.depth > 0 {
                        frame.depth -= 1;
                    } else if is(cp, b'|') && frame.depth == 0 {
                        frame.branches.push((frame.start, self.index));
                        frame.start = self.index + 1;
                    } else if is(cp, b')') {
                        let mut frame = self.groups.pop().expect("open group");
                        frame.branches.push((frame.start, self.index));
                        let open = frame.open;
                        self.closes.insert(self.index, open);
                        self.program.groups.insert(
                            open,
                            Group {
                                end: self.index + 1,
                                branches: frame.branches,
                            },
                        );
                        self.phase = CompilePhase::Wire { open, branch: 0 };
                    }
                }
                self.index += 1;
            }
            CompilePhase::Bracket { open, cursor } => {
                if cursor >= p.len() {
                    self.index = open + 1;
                    return;
                }
                if is(p[cursor], b']') {
                    let negate = p.get(open + 1).is_some_and(|&c| {
                        is(c, b'!') || (self.program.dialect == Dialect::Shell && is(c, b'^'))
                    });
                    self.phase = CompilePhase::Atoms {
                        open,
                        cursor: open + 1 + usize::from(negate),
                        bracket: Bracket {
                            end: cursor + 1,
                            negate,
                            valid: true,
                            atoms: Vec::new(),
                        },
                    };
                } else if self.program.dialect == Dialect::Shell
                    && is(p[cursor], b'[')
                    && p.get(cursor + 1) == Some(&u32::from(b':'))
                {
                    self.phase = CompilePhase::ClassClose {
                        open,
                        cursor,
                        search: cursor + 2,
                    };
                } else {
                    self.phase = CompilePhase::Bracket {
                        open,
                        cursor: cursor + 1,
                    };
                }
            }
            CompilePhase::ClassClose {
                open,
                cursor,
                search,
            } => {
                if search + 1 >= p.len() {
                    self.phase = CompilePhase::Bracket {
                        open,
                        cursor: cursor + 1,
                    };
                } else if is(p[search], b':') && is(p[search + 1], b']') {
                    self.phase = CompilePhase::Bracket {
                        open,
                        cursor: search + 2,
                    };
                } else {
                    self.phase = CompilePhase::ClassClose {
                        open,
                        cursor,
                        search: search + 1,
                    };
                }
            }
            CompilePhase::Atoms {
                open,
                cursor,
                mut bracket,
            } => {
                let stop = bracket.end - 1;
                if cursor >= stop {
                    if self.program.dialect == Dialect::Python && !bracket.negate {
                        match bracket.atoms.first().copied() {
                            Some(Atom::Literal(cp)) if is(cp, b'!') => {
                                bracket.atoms.swap_remove(0);
                                bracket.negate = true;
                            }
                            Some(Atom::Range(lo, hi)) if is(lo, b'!') => {
                                bracket.atoms[0] = Atom::Literal(u32::from(b'-'));
                                bracket.atoms.push(Atom::Literal(hi));
                                bracket.negate = true;
                            }
                            _ => {}
                        }
                    }
                    self.index = bracket.end;
                    self.program.brackets.insert(open, bracket);
                    return;
                }
                if self.program.dialect == Dialect::Shell
                    && is(p[cursor], b'[')
                    && p.get(cursor + 1) == Some(&u32::from(b':'))
                {
                    self.phase = CompilePhase::Named {
                        open,
                        cursor,
                        search: cursor + 2,
                        bracket,
                    };
                    return;
                }
                let lo = self.program.literal(p[cursor]);
                let range = cursor + 2 < stop
                    && is(p[cursor + 1], b'-')
                    && !(self.program.dialect == Dialect::Shell
                        && is(p[cursor + 2], b'[')
                        && p.get(cursor + 3) == Some(&u32::from(b':')));
                let next = if range {
                    let hi = self.program.literal(p[cursor + 2]);
                    if self.program.dialect != Dialect::Python || lo <= hi {
                        bracket.atoms.push(Atom::Range(lo, hi));
                    }
                    cursor + 3
                } else {
                    bracket.atoms.push(Atom::Literal(lo));
                    cursor + 1
                };
                self.phase = CompilePhase::Atoms {
                    open,
                    cursor: next,
                    bracket,
                };
            }
            CompilePhase::Named {
                open,
                cursor,
                search,
                mut bracket,
            } => {
                if search + 1 >= bracket.end - 1 {
                    bracket.atoms.push(Atom::Literal(u32::from(b'[')));
                    self.phase = CompilePhase::Atoms {
                        open,
                        cursor: cursor + 1,
                        bracket,
                    };
                } else if is(p[search], b':') && is(p[search + 1], b']') {
                    if let Some(class) = Class::named(&p[cursor + 2..search]) {
                        bracket.atoms.push(Atom::Class(class));
                    } else {
                        bracket.valid = false;
                    }
                    self.phase = CompilePhase::Atoms {
                        open,
                        cursor: search + 2,
                        bracket,
                    };
                } else {
                    self.phase = CompilePhase::Named {
                        open,
                        cursor,
                        search: search + 1,
                        bracket,
                    };
                }
            }
            CompilePhase::Wire { open, branch } => {
                let group = &self.program.groups[&open];
                let operator = p[open];
                if is(operator, b'!') {
                    return;
                }
                if let Some(&(start, stop)) = group.branches.get(branch) {
                    self.program
                        .transitions
                        .entry(open)
                        .or_default()
                        .push(start);
                    let targets = self.program.transitions.entry(stop).or_default();
                    targets.push(group.end);
                    if has(operator, b"*+") {
                        targets.push(open);
                    }
                    self.phase = CompilePhase::Wire {
                        open,
                        branch: branch + 1,
                    };
                } else if has(operator, b"*?") {
                    self.program
                        .transitions
                        .entry(open)
                        .or_default()
                        .push(group.end);
                }
            }
            CompilePhase::Stars {
                cursor,
                last,
                mut outer,
            } => {
                let Some(index) = cursor.checked_sub(1) else {
                    self.phase = CompilePhase::Done;
                    return;
                };
                if let Some(&open) = self.closes.get(&index).filter(|_| self.program.extglob) {
                    outer = Some(outer.map_or(open, |outer| outer.min(open)));
                }
                let plain = is(p[index], b'*')
                    && !(self.program.extglob && self.program.groups.contains_key(&index));
                if let Some(last) = last.filter(|_| plain) {
                    self.program.stars.insert(index, last);
                }
                if plain && outer.is_none() {
                    self.program.floors.insert(index);
                }
                self.phase = CompilePhase::Stars {
                    cursor: index,
                    last: plain.then(|| last.unwrap_or(index)),
                    outer: outer.filter(|&open| open != index),
                };
            }
        }
    }
}
