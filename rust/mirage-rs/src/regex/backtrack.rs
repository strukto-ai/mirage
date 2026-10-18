use super::Step;
use super::parse::{Ast, Item, Look, Set, TOO_BIG, Unit};

/// The most instructions a program holds: an interval is written out.
const SIZE_LIMIT: usize = 1 << 20;

#[derive(Clone, Copy)]
enum Edge {
    Look(Look),
    /// -w: no word character before the match.
    NoWordBefore,
    /// -w: no word character after it.
    NoWordAfter,
}

enum Inst {
    Unit(Unit),
    Any,
    Set(usize),
    Edge(Edge),
    /// Try the first branch, then the second.
    Split(usize, usize),
    Jump(usize),
    /// Record the position in a register: a group's edge, or where a
    /// loop's iteration began.
    Save(usize),
    Backref(usize),
    /// Leave the loop, at the second index, once an iteration that began
    /// where the register holds has consumed nothing: what it captured
    /// stays (`(a?)*\1b` matches `b`).
    Progress(usize, usize),
    Match,
}

/// A pattern the automata cannot run: one with a back-reference, or under
/// UTF-8 one holding a byte that is no part of a character, which must not
/// match that byte inside a character. It is searched depth first over
/// every way it matches, one record at a time, a bounded number of steps
/// per call.
pub(crate) struct Program {
    insts: Vec<Inst>,
    sets: Vec<Set>,
    registers: usize,
    ignore_case: bool,
    utf8: bool,
}

#[derive(Default)]
pub(crate) struct Scratch {
    registers: Vec<Option<usize>>,
    undo: Vec<(usize, Option<usize>)>,
    stack: Vec<(usize, usize, usize)>,
    best: Option<usize>,
    /// The start position of a search that ran out of steps.
    paused: Option<usize>,
}

/// Whether an expression compiles to no instructions, so that repeating
/// it is no work either (`a{0}{32767}{32767}`).
fn silent(ast: &Ast) -> bool {
    match ast {
        Ast::Empty => true,
        Ast::Concat(items) => items.iter().all(silent),
        Ast::Repeat(inner, _, max) => *max == Some(0) || silent(inner),
        _ => false,
    }
}

fn groups(ast: &Ast) -> usize {
    match ast {
        Ast::Group(index, inner) => (*index).max(groups(inner)),
        Ast::Repeat(inner, _, _) => groups(inner),
        Ast::Concat(items) | Ast::Alternate(items) => items.iter().map(groups).max().unwrap_or(0),
        _ => 0,
    }
}

struct Compiler {
    insts: Vec<Inst>,
    sets: Vec<Set>,
    next_register: usize,
}

impl Compiler {
    fn push(&mut self, inst: Inst) -> Result<usize, &'static str> {
        if self.insts.len() >= SIZE_LIMIT {
            return Err(TOO_BIG);
        }
        self.insts.push(inst);
        Ok(self.insts.len() - 1)
    }

    fn emit(&mut self, ast: &Ast) -> Result<(), &'static str> {
        match ast {
            Ast::Empty => {}
            Ast::Unit(unit) => {
                self.push(Inst::Unit(*unit))?;
            }
            Ast::Any => {
                self.push(Inst::Any)?;
            }
            Ast::Set(set) => {
                self.sets.push(set.clone());
                self.push(Inst::Set(self.sets.len() - 1))?;
            }
            Ast::Look(look) => {
                self.push(Inst::Edge(Edge::Look(*look)))?;
            }
            Ast::Group(index, inner) => {
                self.push(Inst::Save(2 * index))?;
                self.emit(inner)?;
                self.push(Inst::Save(2 * index + 1))?;
            }
            Ast::Backref(index) => {
                self.push(Inst::Backref(*index))?;
            }
            Ast::Concat(items) => {
                for item in items {
                    self.emit(item)?;
                }
            }
            Ast::Alternate(items) => {
                let mut exits = Vec::new();
                for (at, item) in items.iter().enumerate() {
                    if at + 1 == items.len() {
                        self.emit(item)?;
                        break;
                    }
                    let split = self.push(Inst::Split(0, 0))?;
                    self.emit(item)?;
                    exits.push(self.push(Inst::Jump(0))?);
                    self.insts[split] = Inst::Split(split + 1, self.insts.len());
                }
                let end = self.insts.len();
                for exit in exits {
                    self.insts[exit] = Inst::Jump(end);
                }
            }
            Ast::Repeat(..) if silent(ast) => {}
            Ast::Repeat(inner, min, max) => {
                for _ in 0..*min {
                    self.emit(inner)?;
                }
                match max {
                    None => {
                        let register = self.next_register;
                        self.next_register += 1;
                        let split = self.push(Inst::Split(0, 0))?;
                        self.push(Inst::Save(register))?;
                        self.emit(inner)?;
                        let progress = self.push(Inst::Progress(register, 0))?;
                        self.push(Inst::Jump(split))?;
                        let end = self.insts.len();
                        self.insts[split] = Inst::Split(split + 1, end);
                        self.insts[progress] = Inst::Progress(register, end);
                    }
                    Some(max) => {
                        let mut splits = Vec::new();
                        for _ in *min..*max {
                            splits.push(self.push(Inst::Split(0, 0))?);
                            self.emit(inner)?;
                        }
                        let end = self.insts.len();
                        for split in splits {
                            self.insts[split] = Inst::Split(split + 1, end);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

fn word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The unit at `pos` of a record ending at `end`, and its length.
pub(crate) fn unit_at(hay: &[u8], pos: usize, end: usize, utf8: bool) -> Option<(Unit, usize)> {
    let &b = hay[..end].get(pos)?;
    if !utf8 {
        return Some((Unit::Byte(b), 1));
    }
    if b.is_ascii() {
        return Some((Unit::Char(char::from(b)), 1));
    }
    let len = match b {
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return Some((Unit::Byte(b), 1)),
    };
    let decoded = hay[..end]
        .get(pos..pos + len)
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|text| text.chars().next());
    Some(decoded.map_or((Unit::Byte(b), 1), |c| (Unit::Char(c), len)))
}

fn same_kind(a: Unit, b: Unit) -> bool {
    matches!(
        (a, b),
        (Unit::Char(_), Unit::Char(_)) | (Unit::Byte(_), Unit::Byte(_))
    )
}

fn other_case(unit: Unit) -> Option<Unit> {
    let b = unit.ascii().filter(u8::is_ascii_alphabetic)? ^ 0x20;
    Some(match unit {
        Unit::Char(_) => Unit::Char(char::from(b)),
        Unit::Byte(_) => Unit::Byte(b),
    })
}

impl Program {
    pub(crate) fn new(
        ast: &Ast,
        word: bool,
        line: bool,
        ignore_case: bool,
        utf8: bool,
    ) -> Result<Program, &'static str> {
        let slots = 2 * (groups(ast) + 1);
        let mut compiler = Compiler {
            insts: Vec::new(),
            sets: Vec::new(),
            next_register: slots,
        };
        if line {
            compiler.push(Inst::Edge(Edge::Look(Look::Start)))?;
        } else if word {
            compiler.push(Inst::Edge(Edge::NoWordBefore))?;
        }
        compiler.emit(ast)?;
        if line {
            compiler.push(Inst::Edge(Edge::Look(Look::End)))?;
        } else if word {
            compiler.push(Inst::Edge(Edge::NoWordAfter))?;
        }
        compiler.push(Inst::Match)?;
        Ok(Program {
            insts: compiler.insts,
            sets: compiler.sets,
            registers: compiler.next_register,
            ignore_case,
            utf8,
        })
    }

    fn same(&self, got: Unit, want: Unit) -> bool {
        got == want || (self.ignore_case && other_case(got) == Some(want))
    }

    fn member(&self, set: &Set, got: Unit) -> bool {
        set.items.iter().any(|item| match *item {
            Item::Unit(Unit::Byte(_)) if self.utf8 => false,
            Item::Unit(unit) => unit == got,
            Item::Range(low, high) => {
                same_kind(low, got) && (low.ordinal()..=high.ordinal()).contains(&got.ordinal())
            }
            Item::Class(class) => got.ascii().is_some_and(|b| {
                class
                    .ranges()
                    .iter()
                    .any(|&(low, high)| (low..=high).contains(&b))
            }),
        })
    }

    fn in_set(&self, set: &Set, got: Unit) -> bool {
        let hit = self.member(set, got)
            || (self.ignore_case && other_case(got).is_some_and(|other| self.member(set, other)));
        if !set.negated {
            return hit;
        }
        // A negated set matches characters only.
        !hit && !(self.utf8 && matches!(got, Unit::Byte(_)))
    }

    /// Whether `pos` falls between two units of the record, not inside a
    /// character.
    fn boundary(&self, hay: &[u8], begin: usize, pos: usize, end: usize) -> bool {
        if !self.utf8 || pos == end {
            return true;
        }
        let from = pos.saturating_sub(3).max(begin);
        (from..pos)
            .all(|start| unit_at(hay, start, end, true).is_none_or(|(_, len)| start + len <= pos))
    }

    fn edge(hay: &[u8], begin: usize, pos: usize, end: usize, edge: Edge) -> bool {
        let before = pos > begin && word_byte(hay[pos - 1]);
        let after = pos < end && word_byte(hay[pos]);
        match edge {
            Edge::Look(Look::Start) => pos == begin,
            Edge::Look(Look::End) => pos == end,
            Edge::Look(Look::Word) => before != after,
            Edge::Look(Look::NotWord) => before == after,
            Edge::Look(Look::WordStart) => !before && after,
            Edge::Look(Look::WordEnd) => before && !after,
            Edge::NoWordBefore => !before,
            Edge::NoWordAfter => !after,
        }
    }

    /// The end of a match starting at `start` in the record
    /// `hay[begin..end]`: the longest one when `longest`, else the first
    /// found. Each instruction costs a step of `budget`; out of steps, the
    /// search keeps its place in `scratch` and a call with `resume` goes on
    /// from there.
    #[allow(clippy::too_many_arguments)]
    fn run(
        &self,
        hay: &[u8],
        begin: usize,
        end: usize,
        start: usize,
        longest: bool,
        scratch: &mut Scratch,
        budget: &mut u64,
        resume: bool,
    ) -> Step<Option<usize>> {
        let Scratch {
            registers,
            undo,
            stack,
            best: kept,
            ..
        } = scratch;
        if !resume {
            registers.clear();
            registers.resize(self.registers, None);
            undo.clear();
            stack.clear();
            stack.push((0, start, 0));
            *kept = None;
        }
        let mut best = *kept;
        while let Some((mut pc, mut pos, mark)) = stack.pop() {
            while undo.len() > mark {
                if let Some((register, value)) = undo.pop() {
                    registers[register] = value;
                }
            }
            loop {
                if *budget == 0 {
                    stack.push((pc, pos, undo.len()));
                    *kept = best;
                    return Step::Paused;
                }
                *budget -= 1;
                match self.insts[pc] {
                    Inst::Match => {
                        if best.is_none_or(|best| pos > best) {
                            best = Some(pos);
                        }
                        if !longest || pos == end {
                            return Step::Done(best);
                        }
                        break;
                    }
                    Inst::Unit(want) => match unit_at(hay, pos, end, self.utf8) {
                        Some((got, len)) if self.same(got, want) => {
                            pos += len;
                            pc += 1;
                        }
                        _ => break,
                    },
                    Inst::Any => match unit_at(hay, pos, end, self.utf8) {
                        Some((Unit::Byte(_), _)) if self.utf8 => break,
                        Some((_, len)) => {
                            pos += len;
                            pc += 1;
                        }
                        None => break,
                    },
                    Inst::Set(index) => match unit_at(hay, pos, end, self.utf8) {
                        Some((got, len)) if self.in_set(&self.sets[index], got) => {
                            pos += len;
                            pc += 1;
                        }
                        _ => break,
                    },
                    Inst::Edge(edge) => {
                        if !Self::edge(hay, begin, pos, end, edge) {
                            break;
                        }
                        pc += 1;
                    }
                    Inst::Split(first, second) => {
                        stack.push((second, pos, undo.len()));
                        pc = first;
                    }
                    Inst::Jump(to) => pc = to,
                    Inst::Save(register) => {
                        undo.push((register, registers[register]));
                        registers[register] = Some(pos);
                        pc += 1;
                    }
                    Inst::Progress(register, exit) => {
                        pc = if registers[register] == Some(pos) {
                            exit
                        } else {
                            pc + 1
                        };
                    }
                    Inst::Backref(group) => {
                        let (Some(from), Some(to)) =
                            (registers[2 * group], registers[2 * group + 1])
                        else {
                            break;
                        };
                        let text = &hay[from..to.max(from)];
                        let Some(here) = hay[..end].get(pos..pos + text.len()) else {
                            break;
                        };
                        let same = if self.ignore_case {
                            here.eq_ignore_ascii_case(text)
                        } else {
                            here == text
                        };
                        if !same || !self.boundary(hay, begin, pos + text.len(), end) {
                            break;
                        }
                        pos += text.len();
                        pc += 1;
                    }
                }
            }
        }
        Step::Done(best)
    }

    /// The leftmost match in the record `hay[begin..end]` starting at or
    /// after `at`, a unit boundary: its start, and its longest end when
    /// `longest`. A search that runs out of `budget` resumes when called
    /// again with the same arguments.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn find(
        &self,
        hay: &[u8],
        begin: usize,
        end: usize,
        at: usize,
        longest: bool,
        scratch: &mut Scratch,
        budget: &mut u64,
    ) -> Step<Option<(usize, usize)>> {
        let (mut pos, mut resume) = match scratch.paused.take() {
            Some(pos) => (pos, true),
            None => (at, false),
        };
        loop {
            match self.run(hay, begin, end, pos, longest, scratch, budget, resume) {
                Step::Paused => {
                    scratch.paused = Some(pos);
                    return Step::Paused;
                }
                Step::Done(Some(stop)) => return Step::Done(Some((pos, stop))),
                Step::Done(None) => {}
            }
            resume = false;
            let Some((_, len)) = unit_at(hay, pos, end, self.utf8) else {
                return Step::Done(None);
            };
            pos += len;
        }
    }
}
