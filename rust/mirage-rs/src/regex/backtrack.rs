use super::Step;
use super::class::{Members, same_letter, word_char};
use super::parse::{Ast, Look, TOO_BIG, Unit};

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
    /// A set, `.` under multi-line matching, or a caseless literal.
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
    sets: Vec<Members>,
    registers: usize,
    /// The register that holds the last place a `$` matched before a
    /// newline, which the match must go past.
    beyond: usize,
    /// The registers groups take: two per group, the match itself first.
    slots: usize,
    /// Whether a back-reference makes a state depend on more than its
    /// place and instruction.
    backrefs: bool,
    shape: Shape,
}

/// How a program reads its subject.
#[derive(Clone, Copy, Default)]
pub(crate) struct Shape {
    pub(crate) ignore_case: bool,
    pub(crate) utf8: bool,
    /// `^` and `$` match at each line's edges, and neither `.` nor a
    /// negated set matches a newline.
    pub(crate) multiline: bool,
    /// Under UTF-8, word characters are `[[:alnum:]_]` by Unicode rather
    /// than ASCII's.
    pub(crate) unicode_words: bool,
    /// regcomp's anchors without multi-line matching: `^` also matches
    /// after a newline the match has consumed, and `$` before one it goes
    /// on to consume.
    pub(crate) consumed_newlines: bool,
    /// `.` leaves out the NUL byte, as regcomp's syntax has it.
    pub(crate) dot_skips_nul: bool,
}

/// Where a search stands: the record, where the match began, and where
/// it must end when that is known.
#[derive(Clone, Copy)]
struct Bounds {
    begin: usize,
    end: usize,
    start: usize,
    stop: Option<usize>,
}

#[derive(Default)]
pub(crate) struct Scratch {
    registers: Vec<Option<usize>>,
    undo: Vec<(usize, Option<usize>)>,
    stack: Vec<(usize, usize, usize)>,
    best: Option<usize>,
    /// The start position of a search that ran out of steps.
    paused: Option<usize>,
    /// The states a capture search has been through, one bit each.
    visited: Vec<u64>,
    /// The states a leftmost search has failed from: two bits per place
    /// from `seen_from` on and instruction, one for each answer to whether
    /// a `$` before a newline holds the match at that place. The first
    /// `seen_used` words are the ones to clear.
    seen: Vec<u64>,
    seen_from: usize,
    seen_used: usize,
    /// Whether the search in progress remembers its states.
    remember: bool,
}

/// The most states a capture search remembers, as bits; a longer match is
/// searched without that memory.
const VISITED_LIMIT: usize = 1 << 26;

/// The most elements a scratch buffer keeps between searches.
const KEPT: usize = 1 << 12;

impl Scratch {
    /// Gives back what a search grew past `KEPT`, so a cached pattern does
    /// not hold on to the largest input it saw.
    pub(crate) fn trim(&mut self) {
        trim(&mut self.registers);
        trim(&mut self.undo);
        trim(&mut self.stack);
        trim(&mut self.visited);
        trim(&mut self.seen);
        self.seen_used = self.seen_used.min(self.seen.len());
    }
}

fn trim<T>(buffer: &mut Vec<T>) {
    if buffer.capacity() > KEPT {
        buffer.clear();
        buffer.shrink_to(KEPT);
    }
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
    sets: Vec<Members>,
    next_register: usize,
    shape: Shape,
}

impl Compiler {
    fn push(&mut self, inst: Inst) -> Result<usize, &'static str> {
        if self.insts.len() >= SIZE_LIMIT {
            return Err(TOO_BIG);
        }
        self.insts.push(inst);
        Ok(self.insts.len() - 1)
    }

    fn set(&mut self, members: Members) -> Result<(), &'static str> {
        self.sets.push(members);
        self.push(Inst::Set(self.sets.len() - 1))?;
        Ok(())
    }

    fn emit(&mut self, ast: &Ast) -> Result<(), &'static str> {
        match ast {
            Ast::Empty => {}
            Ast::Unit(unit) => {
                let folds = self.shape.ignore_case
                    && match unit {
                        Unit::Char(c) => c.is_alphabetic(),
                        Unit::Byte(b) => b.is_ascii_alphabetic(),
                    };
                if folds {
                    self.set(Members::folded(*unit, self.shape.utf8))?;
                } else {
                    self.push(Inst::Unit(*unit))?;
                }
            }
            Ast::Any if self.shape.multiline || self.shape.dot_skips_nul => {
                let mut members = Members::any(self.shape.utf8);
                if self.shape.multiline {
                    members.without(b'\n');
                }
                if self.shape.dot_skips_nul {
                    members.without(0);
                }
                self.set(members)?;
            }
            Ast::Any => {
                self.push(Inst::Any)?;
            }
            Ast::Set(set) => {
                let mut members = Members::of(set, self.shape.utf8, self.shape.ignore_case);
                if self.shape.multiline && set.negated && set.bracket {
                    members.without(b'\n');
                }
                self.set(members)?;
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

/// The unit that ends at `pos` of a record starting at `begin`.
fn unit_before(hay: &[u8], begin: usize, pos: usize, utf8: bool) -> Option<Unit> {
    if pos <= begin {
        return None;
    }
    if utf8 {
        for start in pos.saturating_sub(4).max(begin)..pos {
            if let Some((unit, len)) = unit_at(hay, start, pos, true) {
                if start + len == pos && matches!(unit, Unit::Char(_)) {
                    return Some(unit);
                }
            }
        }
    }
    Some(Unit::Byte(hay[pos - 1]))
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

/// Whether two stretches of a subject spell the same text, letters in
/// either case when `ignore_case`.
fn same_text(a: &[u8], b: &[u8], ignore_case: bool, utf8: bool) -> bool {
    if a == b {
        return true;
    }
    if !ignore_case {
        return false;
    }
    if !utf8 {
        return a.eq_ignore_ascii_case(b);
    }
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (Some((x, xl)), Some((y, yl))) =
            (unit_at(a, i, a.len(), true), unit_at(b, j, b.len(), true))
        else {
            return false;
        };
        let same = match (x, y) {
            (Unit::Char(x), Unit::Char(y)) => same_letter(x, y),
            (x, y) => x == y,
        };
        if !same {
            return false;
        }
        i += xl;
        j += yl;
    }
    i == a.len() && j == b.len()
}

impl Program {
    pub(crate) fn new(
        ast: &Ast,
        word: bool,
        line: bool,
        shape: Shape,
    ) -> Result<Program, &'static str> {
        let slots = 2 * (groups(ast) + 1);
        let mut compiler = Compiler {
            insts: Vec::new(),
            sets: Vec::new(),
            next_register: slots,
            shape,
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
        let backrefs = compiler
            .insts
            .iter()
            .any(|inst| matches!(inst, Inst::Backref(_)));
        Ok(Program {
            insts: compiler.insts,
            sets: compiler.sets,
            registers: compiler.next_register + 1,
            beyond: compiler.next_register,
            slots,
            backrefs,
            shape,
        })
    }

    /// Whether `pos` falls between two units of the record, not inside a
    /// character.
    fn boundary(&self, hay: &[u8], begin: usize, pos: usize, end: usize) -> bool {
        if !self.shape.utf8 || pos == end {
            return true;
        }
        let from = pos.saturating_sub(3).max(begin);
        (from..pos)
            .all(|start| unit_at(hay, start, end, true).is_none_or(|(_, len)| start + len <= pos))
    }

    fn is_word(&self, unit: Option<Unit>) -> bool {
        match unit {
            Some(Unit::Char(c)) if self.shape.unicode_words => word_char(c),
            Some(unit) => unit.ascii().is_some_and(word_byte),
            None => false,
        }
    }

    fn edge(&self, hay: &[u8], at: Bounds, pos: usize, edge: Edge) -> Option<bool> {
        let Bounds {
            begin,
            end,
            start,
            stop,
        } = at;
        let utf8 = self.shape.utf8;
        let before = self.is_word(unit_before(hay, begin, pos, utf8));
        let after = self.is_word(unit_at(hay, pos, end, utf8).map(|(unit, _)| unit));
        let multiline = self.shape.multiline;
        let consumed = self.shape.consumed_newlines;
        Some(match edge {
            Edge::Look(Look::Start) => {
                pos == begin || (hay[pos - 1] == b'\n' && (multiline || (consumed && pos > start)))
            }
            Edge::Look(Look::End) => {
                if pos == end || (multiline && hay[pos] == b'\n') {
                    true
                } else if consumed && hay[pos] == b'\n' {
                    // Only if the match goes on past this newline.
                    return stop.map(|stop| pos < stop);
                } else {
                    false
                }
            }
            Edge::Look(Look::GroupedEnd) => pos == end || (multiline && hay[pos] == b'\n'),
            Edge::Look(Look::SubjectStart) => pos == begin,
            Edge::Look(Look::SubjectEnd) => pos == end,
            Edge::Look(Look::Word) => before != after,
            Edge::Look(Look::NotWord) => before == after,
            Edge::Look(Look::WordStart) => !before && after,
            Edge::Look(Look::WordEnd) => before && !after,
            Edge::NoWordBefore => !before,
            Edge::NoWordAfter => !after,
        })
    }

    /// One instruction at `pos`: the next state, or None when this path
    /// fails there. A `Split` pushes its second branch; a `Match` is the
    /// caller's to judge.
    #[allow(clippy::too_many_arguments)]
    fn step(
        &self,
        hay: &[u8],
        at: Bounds,
        pc: usize,
        pos: usize,
        registers: &mut [Option<usize>],
        undo: &mut Vec<(usize, Option<usize>)>,
        stack: &mut Vec<(usize, usize, usize)>,
        progress: bool,
    ) -> Option<(usize, usize)> {
        let utf8 = self.shape.utf8;
        let Bounds { begin, end, .. } = at;
        match self.insts[pc] {
            Inst::Match => None,
            Inst::Unit(want) => match unit_at(hay, pos, end, utf8) {
                Some((got, len)) if got == want => Some((pc + 1, pos + len)),
                _ => None,
            },
            Inst::Any => match unit_at(hay, pos, end, utf8) {
                Some((Unit::Byte(_), _)) if utf8 => None,
                Some((_, len)) => Some((pc + 1, pos + len)),
                None => None,
            },
            Inst::Set(index) => match unit_at(hay, pos, end, utf8) {
                Some((got, len)) if self.sets[index].contains(got) => Some((pc + 1, pos + len)),
                _ => None,
            },
            Inst::Edge(edge) => match self.edge(hay, at, pos, edge) {
                Some(true) => Some((pc + 1, pos)),
                Some(false) => None,
                // A `$` before a newline: the match must end past it.
                None => {
                    undo.push((self.beyond, registers[self.beyond]));
                    registers[self.beyond] = Some(pos);
                    Some((pc + 1, pos))
                }
            },
            Inst::Split(first, second) => {
                stack.push((second, pos, undo.len()));
                Some((first, pos))
            }
            Inst::Jump(to) => Some((to, pos)),
            Inst::Save(register) => {
                undo.push((register, registers[register]));
                registers[register] = Some(pos);
                Some((pc + 1, pos))
            }
            Inst::Progress(register, exit) => {
                if progress && registers[register] == Some(pos) {
                    Some((exit, pos))
                } else {
                    Some((pc + 1, pos))
                }
            }
            Inst::Backref(group) => {
                let (Some(from), Some(to)) = (registers[2 * group], registers[2 * group + 1])
                else {
                    return None;
                };
                let text = &hay[from..to.max(from)];
                // Under -i in a UTF-8 locale a letter's other case may take
                // other bytes, so the text spans as many characters.
                let stop = if self.shape.ignore_case && utf8 {
                    let mut at = pos;
                    let mut i = 0;
                    while i < text.len() {
                        let (_, want) = unit_at(text, i, text.len(), true)?;
                        let (_, len) = unit_at(hay, at, end, true)?;
                        i += want;
                        at += len;
                    }
                    at
                } else {
                    pos + text.len()
                };
                let here = hay[..end].get(pos..stop)?;
                if !same_text(here, text, self.shape.ignore_case, utf8) {
                    return None;
                }
                if !self.boundary(hay, begin, stop, end) {
                    return None;
                }
                Some((pc + 1, stop))
            }
        }
    }

    /// The end of a match starting at `start` in the record
    /// `hay[begin..end]`: the longest one when `longest`, else the first
    /// found. Each instruction costs a step of `budget`; out of steps, the
    /// search keeps its place in `scratch` and a call with `resume` goes on
    /// from there. A search that remembers its states passes over one it
    /// has been through, so it takes time in proportion to the text, and
    /// an iteration that consumes nothing then leads only to a state
    /// already seen.
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
            seen,
            seen_from,
            seen_used,
            remember,
            ..
        } = scratch;
        let remember = *remember;
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
                if remember {
                    let held = usize::from(registers[self.beyond] == Some(pos));
                    let bit = (((pos - *seen_from) * self.insts.len() + pc) << 1) | held;
                    let (word, mask) = (bit / 64, 1u64 << (bit % 64));
                    if word >= seen.len() {
                        seen.resize(word + 1, 0);
                    }
                    if seen[word] & mask != 0 {
                        break;
                    }
                    seen[word] |= mask;
                    *seen_used = (*seen_used).max(word + 1);
                }
                if let Inst::Match = self.insts[pc] {
                    if registers[self.beyond].is_some_and(|beyond| pos <= beyond) {
                        break;
                    }
                    if best.is_none_or(|best| pos > best) {
                        best = Some(pos);
                    }
                    if !longest || pos == end {
                        return Step::Done(best);
                    }
                    break;
                }
                let at = Bounds {
                    begin,
                    end,
                    start,
                    stop: None,
                };
                match self.step(hay, at, pc, pos, registers, undo, stack, !remember) {
                    Some((next, at)) => (pc, pos) = (next, at),
                    None => break,
                }
            }
        }
        Step::Done(best)
    }

    /// Where each group of the match `hay[start..stop]` lies: the first
    /// way the pattern matches exactly that text, trying a repetition's
    /// longer counts and an alternation's earlier branches first. Without
    /// back-references the search remembers every state it has failed
    /// from, so it takes time in proportion to the text, and an iteration
    /// that consumes nothing is never taken; with them it spends `budget`
    /// as `run` does.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn captures(
        &self,
        hay: &[u8],
        begin: usize,
        end: usize,
        start: usize,
        stop: usize,
        backrefs: bool,
        scratch: &mut Scratch,
        budget: &mut u64,
    ) -> Option<Vec<Option<usize>>> {
        let Scratch {
            registers,
            undo,
            stack,
            visited,
            ..
        } = scratch;
        registers.clear();
        registers.resize(self.registers, None);
        undo.clear();
        stack.clear();
        stack.push((0, start, 0));
        let width = stop - start + 1;
        let remember = !backrefs && self.insts.len().saturating_mul(width) <= VISITED_LIMIT;
        if remember {
            visited.clear();
            visited.resize((self.insts.len() * width).div_ceil(64), 0);
        }
        while let Some((mut pc, mut pos, mark)) = stack.pop() {
            while undo.len() > mark {
                if let Some((register, value)) = undo.pop() {
                    registers[register] = value;
                }
            }
            loop {
                if pos > stop {
                    break;
                }
                if remember {
                    let bit = pc * width + (pos - start);
                    let (word, mask) = (bit / 64, 1u64 << (bit % 64));
                    if visited[word] & mask != 0 {
                        break;
                    }
                    visited[word] |= mask;
                } else {
                    if *budget == 0 {
                        return None;
                    }
                    *budget -= 1;
                }
                if let Inst::Match = self.insts[pc] {
                    if pos == stop {
                        let mut found = registers[..self.slots].to_vec();
                        found[0] = Some(start);
                        found[1] = Some(stop);
                        return Some(found);
                    }
                    break;
                }
                let at = Bounds {
                    begin,
                    end,
                    start,
                    stop: Some(stop),
                };
                match self.step(hay, at, pc, pos, registers, undo, stack, !remember) {
                    Some((next, at)) => (pc, pos) = (next, at),
                    None => break,
                }
            }
        }
        None
    }

    /// The leftmost match in the record `hay[begin..end]` starting at or
    /// after `at`, a unit boundary: its start, and its longest end when
    /// `longest`. A search that runs out of `budget` resumes when called
    /// again with the same arguments. Without back-references the states
    /// it has failed from stay failed across start places, since a later
    /// start only narrows what `^` takes; with them it spends `budget`
    /// alone.
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
        if !resume {
            self.fresh(end, at, scratch);
        }
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
            let Some((_, len)) = unit_at(hay, pos, end, self.shape.utf8) else {
                return Step::Done(None);
            };
            pos += len;
        }
    }

    /// Where the longest match that starts at `start` ends, the subject
    /// being `hay` whole.
    pub(crate) fn longest_from(
        &self,
        hay: &[u8],
        start: usize,
        scratch: &mut Scratch,
    ) -> Option<usize> {
        self.fresh(hay.len(), start, scratch);
        let mut budget = u64::MAX;
        match self.run(hay, 0, hay.len(), start, true, scratch, &mut budget, false) {
            Step::Done(found) => found,
            Step::Paused => None,
        }
    }

    /// Forget the states an earlier search failed from, for one starting
    /// at `at` in a record ending at `end`.
    fn fresh(&self, end: usize, at: usize, scratch: &mut Scratch) {
        let width = end.saturating_sub(at) + 1;
        scratch.remember = !self.backrefs
            && self.insts.len().saturating_mul(width).saturating_mul(2) <= VISITED_LIMIT;
        let used = scratch.seen_used.min(scratch.seen.len());
        scratch.seen[..used].fill(0);
        scratch.seen_used = 0;
        scratch.seen_from = at;
    }
}
