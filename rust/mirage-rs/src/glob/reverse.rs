use std::collections::{BTreeSet, HashMap};

use super::compile::{Dialect, Program, has, quote};

#[derive(Clone, Copy)]
enum Token {
    Slice(usize, usize),
    One(u32),
    Open(u32),
}

enum Phase {
    IndexGroups,
    MarkBranches,
    Tokenize,
    Emit,
}

pub(super) struct Reverse {
    cursor: usize,
    tokens: Vec<Token>,
    pub(super) units: Vec<u32>,
    token: Option<Token>,
    inner: usize,
    openers: HashMap<usize, u32>,
    bars: BTreeSet<usize>,
    group_index: usize,
    branch_index: usize,
    group_keys: Vec<usize>,
    phase: Phase,
}

impl Reverse {
    pub(super) fn new() -> Self {
        Self {
            cursor: 0,
            tokens: Vec::new(),
            units: Vec::new(),
            token: None,
            inner: 0,
            openers: HashMap::new(),
            bars: BTreeSet::new(),
            group_index: 0,
            branch_index: 0,
            group_keys: Vec::new(),
            phase: Phase::IndexGroups,
        }
    }
    pub(super) fn step(&mut self, program: &Program) -> bool {
        match self.phase {
            Phase::IndexGroups => {
                if self.cursor < program.units.len() {
                    if program.extglob && program.groups.contains_key(&self.cursor) {
                        self.group_keys.push(self.cursor);
                    }
                    self.cursor += 1;
                } else {
                    self.cursor = 0;
                    self.phase = Phase::MarkBranches;
                }
            }
            Phase::MarkBranches => {
                if let Some(&open) = self.group_keys.get(self.group_index) {
                    let group = &program.groups[&open];
                    self.openers.insert(group.end - 1, program.units[open]);
                    if self.branch_index + 1 < group.branches.len() {
                        self.bars.insert(group.branches[self.branch_index].1);
                        self.branch_index += 1;
                    } else {
                        self.group_index += 1;
                        self.branch_index = 0;
                    }
                } else {
                    self.phase = Phase::Tokenize;
                }
            }
            Phase::Tokenize => {
                if self.cursor >= program.units.len() {
                    self.phase = Phase::Emit;
                    return false;
                }
                if program.extglob && program.groups.contains_key(&self.cursor) {
                    self.tokens.push(Token::One(u32::from(b')')));
                    self.cursor += 2;
                } else if let Some(bracket) = program.brackets.get(&self.cursor) {
                    self.tokens.push(Token::Slice(self.cursor, bracket.end));
                    self.cursor = bracket.end;
                } else {
                    let cp = program.units[self.cursor];
                    self.tokens
                        .push(if let Some(&operator) = self.openers.get(&self.cursor) {
                            Token::Open(operator)
                        } else {
                            Token::One(if !self.bars.contains(&self.cursor) && has(cp, b"[()|") {
                                if program.dialect == Dialect::Shell {
                                    quote(cp)
                                } else {
                                    0x11_0000 + cp
                                }
                            } else {
                                cp
                            })
                        });
                    self.cursor += 1;
                }
            }
            Phase::Emit => {
                if let Some(token) = self.token {
                    match token {
                        Token::One(cp) => {
                            self.units.push(cp);
                            self.token = None;
                        }
                        Token::Open(cp) => {
                            self.units
                                .push(if self.inner == 0 { cp } else { u32::from(b'(') });
                            self.inner += 1;
                            if self.inner == 2 {
                                self.token = None;
                            }
                        }
                        Token::Slice(lo, hi) => {
                            self.units.push(program.units[lo + self.inner]);
                            self.inner += 1;
                            if lo + self.inner == hi {
                                self.token = None;
                            }
                        }
                    }
                } else if let Some(token) = self.tokens.pop() {
                    self.token = Some(token);
                    self.inner = 0;
                } else {
                    return true;
                }
            }
        }
        false
    }
}
