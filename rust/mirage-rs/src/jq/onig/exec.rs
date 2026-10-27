// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regexec.c. See licenses/third_party/oniguruma.txt.

use super::compile::{Inst, Program, Unit};
use super::parse::Anchor;
use super::{class, fold};
use crate::regex::Step;

const UNSET: usize = usize::MAX;

/// ONIG_DEFAULT_RETRY_LIMIT_IN_MATCH: the backtracks one match attempt
/// may take.
const RETRY_LIMIT: u64 = 10_000_000;

/// The backtrack entries one attempt may hold; Oniguruma's own stack is
/// unbounded.
const FRAME_LIMIT: usize = 1 << 22;

const RETRY_LIMIT_OVER: &str = "retry-limit-in-match over";
const STACK_LIMIT_OVER: &str = "match-stack limit over";

/// Each group's span in a match, group 0 the match itself.
pub(crate) type Region = Vec<Option<(usize, usize)>>;

/// The best match a longest-match search has seen.
pub(super) struct Best {
    pub(super) len: usize,
    pub(super) region: Region,
}

/// How a search runs: where it began (`\G`), and the `n` and `l`
/// options.
pub(super) struct Mode {
    pub(super) from: usize,
    pub(super) not_empty: bool,
    pub(super) longest: bool,
}

enum Frame {
    /// Resume at `pc` and `pos`.
    Alt {
        pc: usize,
        pos: usize,
    },
    Slot {
        slot: usize,
        old: usize,
    },
    Count {
        id: usize,
        count: u32,
        start: usize,
    },
    Snap {
        id: usize,
        old: Box<[usize]>,
    },
    Keep {
        old: usize,
    },
    /// An atomic group (`look` None) or a lookaround began at `pos`; a
    /// negative one whose body fails goes on at its exit.
    Mark {
        look: Option<(bool, usize)>,
        pos: usize,
    },
    /// A lazy loop's next pass, not yet tried.
    Enter {
        id: usize,
        body: usize,
        pos: usize,
    },
    /// A greedy unit loop that may give back units down to `min_pos`;
    /// `base` is where it began.
    StarBack {
        pc: usize,
        min_pos: usize,
        pos: usize,
        base: usize,
    },
    /// A lazy unit loop at `star` that may take one more unit.
    StarMore {
        star: usize,
        pos: usize,
        count: u32,
    },
}

impl Frame {
    /// Whether popping it puts state back, so a cut keeps it.
    fn restores(&self) -> bool {
        matches!(
            self,
            Frame::Slot { .. } | Frame::Count { .. } | Frame::Snap { .. } | Frame::Keep { .. }
        )
    }
}

/// One match attempt from one start, as Oniguruma's match_at runs it:
/// a backtracking machine whose whole state is here, so it can stop
/// between any two steps.
#[derive(Default)]
pub(super) struct Machine {
    pc: usize,
    pos: usize,
    origin: usize,
    keep: usize,
    slots: Vec<usize>,
    counts: Vec<u32>,
    starts: Vec<usize>,
    snaps: Vec<Box<[usize]>>,
    frames: Vec<Frame>,
    failing: bool,
    retries: u64,
    star: Option<Repeat>,
}

/// A greedy repeat that ran out of budget part-way through the input,
/// resumed when its instruction runs again.
#[derive(Clone, Copy)]
struct Repeat {
    pc: usize,
    base: usize,
    pos: usize,
    count: u32,
    min_pos: Option<usize>,
}

/// The code of the unit at `pos` and its length: a UTF-8 character, or a
/// byte that starts none (as a search begun inside a character meets).
pub(super) fn unit_at(hay: &[u8], pos: usize) -> Option<(u32, usize)> {
    let b = *hay.get(pos)?;
    let len = match b {
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    };
    if len == 1 || pos + len > hay.len() {
        return Some((u32::from(b), 1));
    }
    let mut code = u32::from(b) & (0x7F >> len);
    for &c in &hay[pos + 1..pos + len] {
        code = (code << 6) | (u32::from(c) & 0x3F);
    }
    Some((code, len))
}

fn continuation(b: u8) -> bool {
    (0x80..0xC0).contains(&b)
}

/// Where the character before `pos` starts.
fn char_before(hay: &[u8], pos: usize) -> Option<usize> {
    if pos == 0 {
        return None;
    }
    let mut p = pos - 1;
    while p > 0 && pos - p < 4 && continuation(hay[p]) {
        p -= 1;
    }
    Some(p)
}

fn is_word_at(hay: &[u8], pos: usize) -> bool {
    unit_at(hay, pos).is_some_and(|(code, _)| class::contains(class::word(), code))
}

fn is_word_before(hay: &[u8], pos: usize) -> bool {
    char_before(hay, pos).is_some_and(|p| is_word_at(hay, p))
}

fn anchor(anchor: Anchor, hay: &[u8], pos: usize, from: usize) -> bool {
    let end = hay.len();
    match anchor {
        Anchor::BufStart => pos == 0,
        Anchor::BufEnd => pos == end,
        Anchor::SemiEnd => pos == end || (pos + 1 == end && hay[pos] == b'\n'),
        Anchor::LineStart => pos == 0 || (pos < end && hay[pos - 1] == b'\n'),
        Anchor::LineEnd => pos == end || hay[pos] == b'\n',
        Anchor::SearchStart => pos == from,
        Anchor::WordBoundary => is_word_before(hay, pos) != is_word_at(hay, pos),
        Anchor::NotWordBoundary => is_word_before(hay, pos) == is_word_at(hay, pos),
    }
}

/// Where `unit` matched at `pos` ends.
fn take(prog: &Program, unit: &Unit, hay: &[u8], pos: usize) -> Option<usize> {
    if let Unit::Byte(b) = unit {
        return (hay.get(pos) == Some(b)).then_some(pos + 1);
    }
    let (code, len) = unit_at(hay, pos)?;
    let ok = match unit {
        Unit::Char(c) => code == *c as u32,
        Unit::Set(set) => class::contains(&prog.sets[*set], code),
        Unit::Any => code != u32::from(b'\n'),
        Unit::AnyNl => true,
        Unit::Byte(_) => false,
    };
    ok.then_some(pos + len)
}

/// Where the unit a loop took before `pos` starts, the loop having begun
/// at `base`, perhaps inside a character.
fn unit_before(hay: &[u8], pos: usize, base: usize) -> usize {
    let mut head = base;
    while head < pos && continuation(hay[head]) {
        head += 1;
    }
    if pos <= head {
        return pos - 1;
    }
    let mut p = pos - 1;
    while p > head && continuation(hay[p]) {
        p -= 1;
    }
    p
}

/// `\R`'s length at `pos`.
fn newline(hay: &[u8], pos: usize) -> Option<usize> {
    if hay[pos..].starts_with(b"\r\n") {
        return Some(2);
    }
    let (code, len) = unit_at(hay, pos)?;
    matches!(code, 0x0A..=0x0D | 0x85 | 0x2028 | 0x2029).then_some(len)
}

/// Whether `hay[pos..]` begins with what `hay[start..end]` holds,
/// ignoring case when `fold`: where that ends. The caseless compare is
/// Oniguruma's string_cmp_ic: as many bytes as the capture, character
/// by character through each one's case folding.
fn backref(hay: &[u8], start: usize, end: usize, pos: usize, fold: bool) -> Option<usize> {
    let len = end - start;
    if hay.len() - pos < len {
        return None;
    }
    if !fold {
        return (hay[pos..pos + len] == hay[start..end]).then_some(pos + len);
    }
    let (mut s1, mut s2) = (start, pos);
    let end2 = pos + len;
    while s1 < end {
        let f1 = fold::case_fold(hay, &mut s1, end)?;
        let f2 = fold::case_fold(hay, &mut s2, end2)?;
        if f1.as_bytes() != f2.as_bytes() {
            return None;
        }
        if s2 >= end2 {
            if s1 < end {
                return None;
            }
            break;
        }
    }
    Some(s2)
}

enum Popped {
    /// Execution resumes at the machine's pc and pos.
    Resumed,
    /// State was put back; keep failing.
    Restored,
    /// Nothing is left to try.
    Exhausted,
}

impl Machine {
    /// Ready an attempt from `origin`.
    pub(super) fn reset(&mut self, prog: &Program, origin: usize) {
        self.pc = 0;
        self.pos = origin;
        self.origin = origin;
        self.keep = origin;
        self.star = None;
        self.slots.clear();
        self.slots.resize(prog.slots, UNSET);
        self.counts.clear();
        self.counts.resize(prog.loops.len(), 0);
        self.starts.clear();
        self.starts.resize(prog.loops.len(), UNSET);
        self.snaps.clear();
        self.snaps.extend(
            prog.loops
                .iter()
                .map(|slots| vec![UNSET; slots.len()].into()),
        );
        self.frames.clear();
        self.failing = false;
        self.retries = 0;
    }

    fn push(&mut self, frame: Frame) -> Result<(), &'static str> {
        if self.frames.len() >= FRAME_LIMIT {
            return Err(STACK_LIMIT_OVER);
        }
        self.frames.push(frame);
        Ok(())
    }

    fn save(&mut self, slot: usize, value: usize) -> Result<(), &'static str> {
        let old = self.slots[slot];
        self.push(Frame::Slot { slot, old })?;
        self.slots[slot] = value;
        Ok(())
    }

    fn retry(&mut self) -> Result<(), &'static str> {
        self.retries += 1;
        if self.retries > RETRY_LIMIT {
            return Err(RETRY_LIMIT_OVER);
        }
        Ok(())
    }

    /// Begin a pass of loop `id` at `body`.
    fn enter(&mut self, prog: &Program, id: usize, body: usize) -> Result<(), &'static str> {
        self.push(Frame::Count {
            id,
            count: self.counts[id],
            start: self.starts[id],
        })?;
        self.counts[id] += 1;
        self.starts[id] = self.pos;
        let watched = &prog.loops[id];
        if !watched.is_empty() {
            let now: Box<[usize]> = watched.iter().map(|&slot| self.slots[slot]).collect();
            let old = std::mem::replace(&mut self.snaps[id], now);
            self.push(Frame::Snap { id, old })?;
        }
        self.pc = body;
        Ok(())
    }

    fn pop(&mut self, prog: &Program, hay: &[u8]) -> Result<Popped, &'static str> {
        let Some(frame) = self.frames.pop() else {
            return Ok(Popped::Exhausted);
        };
        match frame {
            Frame::Alt { pc, pos } => {
                self.retry()?;
                self.pc = pc;
                self.pos = pos;
                return Ok(Popped::Resumed);
            }
            Frame::Slot { slot, old } => self.slots[slot] = old,
            Frame::Count { id, count, start } => {
                self.counts[id] = count;
                self.starts[id] = start;
            }
            Frame::Snap { id, old } => self.snaps[id] = old,
            Frame::Keep { old } => self.keep = old,
            Frame::Mark {
                look: Some((true, exit)),
                pos,
            } => {
                self.retry()?;
                self.pos = pos;
                self.pc = exit;
                return Ok(Popped::Resumed);
            }
            Frame::Mark { .. } => {}
            Frame::Enter { id, body, pos } => {
                self.retry()?;
                self.pos = pos;
                self.enter(prog, id, body)?;
                return Ok(Popped::Resumed);
            }
            Frame::StarBack {
                pc,
                min_pos,
                pos,
                base,
            } => {
                self.retry()?;
                let back = unit_before(hay, pos, base);
                if back > min_pos {
                    self.push(Frame::StarBack {
                        pc,
                        min_pos,
                        pos: back,
                        base,
                    })?;
                }
                self.pos = back;
                self.pc = pc;
                return Ok(Popped::Resumed);
            }
            Frame::StarMore { star, pos, count } => {
                let Inst::Star { unit, max, .. } = &prog.insts[star] else {
                    unreachable!("a lazy loop frame names its loop")
                };
                if max.is_none_or(|max| count < max) {
                    if let Some(next) = take(prog, unit, hay, pos) {
                        self.retry()?;
                        self.push(Frame::StarMore {
                            star,
                            pos: next,
                            count: count + 1,
                        })?;
                        self.pos = next;
                        self.pc = star + 1;
                        return Ok(Popped::Resumed);
                    }
                }
            }
        }
        Ok(Popped::Restored)
    }

    /// Ends the innermost atomic group or lookaround: drops what it left
    /// to try but keeps what puts state back. The mark is returned.
    fn cut(&mut self) -> Frame {
        let at = self
            .frames
            .iter()
            .rposition(|f| matches!(f, Frame::Mark { .. }))
            .unwrap_or_else(|| unreachable!("an atomic end has its mark"));
        let kept: Vec<Frame> = self
            .frames
            .drain(at + 1..)
            .filter(Frame::restores)
            .collect();
        let mark = self.frames.pop().unwrap_or_else(|| unreachable!());
        self.frames.extend(kept);
        mark
    }

    /// Ends the innermost lookaround, putting back all it changed.
    fn unwind(&mut self) {
        while let Some(frame) = self.frames.pop() {
            match frame {
                Frame::Mark { .. } => return,
                Frame::Slot { slot, old } => self.slots[slot] = old,
                Frame::Count { id, count, start } => {
                    self.counts[id] = count;
                    self.starts[id] = start;
                }
                Frame::Snap { id, old } => self.snaps[id] = old,
                Frame::Keep { old } => self.keep = old,
                _ => {}
            }
        }
    }

    fn region(&self, groups: usize) -> Region {
        let mut region = Vec::with_capacity(groups + 1);
        // A `\K` inside a lookahead can leave the start past the end the
        // lookahead put back; Oniguruma reports the match from the end.
        region.push(Some((self.keep.min(self.pos), self.pos)));
        for g in 1..=groups {
            let (start, end) = (self.slots[2 * g], self.slots[2 * g + 1]);
            region.push((start != UNSET && end != UNSET).then_some((start, end)));
        }
        region
    }

    fn set(&self, groups: &[usize]) -> bool {
        groups
            .iter()
            .any(|&g| self.slots[2 * g] != UNSET && self.slots[2 * g + 1] != UNSET)
    }

    /// Run the attempt until it matches, fails or spends `budget`. A
    /// longest-match search records each better match in `best` and goes
    /// on; it ends with None.
    pub(super) fn run(
        &mut self,
        prog: &Program,
        groups: usize,
        hay: &[u8],
        mode: &Mode,
        best: &mut Option<Best>,
        budget: &mut u64,
    ) -> Step<Result<Option<Region>, &'static str>> {
        loop {
            if *budget == 0 {
                return Step::Paused;
            }
            *budget -= 1;
            match self.step(prog, groups, hay, mode, best, budget) {
                Ok(None) => {}
                Ok(Some(found)) => return Step::Done(Ok(found)),
                Err(err) => return Step::Done(Err(err)),
            }
        }
    }

    /// One instruction, or one backtrack entry while failing.
    #[allow(clippy::type_complexity)]
    fn step(
        &mut self,
        prog: &Program,
        groups: usize,
        hay: &[u8],
        mode: &Mode,
        best: &mut Option<Best>,
        budget: &mut u64,
    ) -> Result<Option<Option<Region>>, &'static str> {
        if self.failing {
            match self.pop(prog, hay)? {
                Popped::Resumed => self.failing = false,
                Popped::Restored => {}
                Popped::Exhausted => return Ok(Some(None)),
            }
            return Ok(None);
        }
        let pc = self.pc;
        self.pc += 1;
        let ok = match &prog.insts[pc] {
            Inst::Unit(unit) => match take(prog, unit, hay, self.pos) {
                Some(next) => {
                    self.pos = next;
                    true
                }
                None => false,
            },
            Inst::Split(first, second) => {
                self.push(Frame::Alt {
                    pc: *second,
                    pos: self.pos,
                })?;
                self.pc = *first;
                true
            }
            Inst::Jump(to) => {
                self.pc = *to;
                true
            }
            Inst::Save(slot) => {
                self.save(*slot, self.pos)?;
                true
            }
            Inst::Anchor(kind) => anchor(*kind, hay, self.pos, mode.from),
            Inst::Backref(refs, fold) => {
                let mut matched = None;
                for &g in refs.iter().rev() {
                    let (start, end) = (self.slots[2 * g], self.slots[2 * g + 1]);
                    if start == UNSET || end == UNSET || start > end {
                        continue;
                    }
                    matched = backref(hay, start, end, self.pos, *fold);
                    if matched.is_some() {
                        break;
                    }
                }
                match matched {
                    Some(next) => {
                        // A backreference compares a whole capture in one
                        // step: charge it by the length it consumed.
                        *budget = budget.saturating_sub((next - self.pos) as u64);
                        self.pos = next;
                        true
                    }
                    None => false,
                }
            }
            Inst::Keep => {
                self.push(Frame::Keep { old: self.keep })?;
                self.keep = self.pos;
                true
            }
            Inst::Newline => match newline(hay, self.pos) {
                Some(len) => {
                    self.pos += len;
                    true
                }
                None => false,
            },
            Inst::RepStart(id) => {
                self.push(Frame::Count {
                    id: *id,
                    count: self.counts[*id],
                    start: self.starts[*id],
                })?;
                self.counts[*id] = 0;
                true
            }
            Inst::RepLoop {
                id,
                min,
                max,
                greedy,
                exit,
            } => {
                let count = self.counts[*id];
                if count < *min {
                    self.enter(prog, *id, pc + 1)?;
                } else if max.is_some_and(|max| count >= max) {
                    self.pc = *exit;
                } else if *greedy {
                    self.push(Frame::Alt {
                        pc: *exit,
                        pos: self.pos,
                    })?;
                    self.enter(prog, *id, pc + 1)?;
                } else {
                    self.push(Frame::Enter {
                        id: *id,
                        body: pc + 1,
                        pos: self.pos,
                    })?;
                    self.pc = *exit;
                }
                true
            }
            Inst::RepEnd { id, head, min } => {
                let empty = self.pos == self.starts[*id]
                    && prog.loops[*id]
                        .iter()
                        .zip(self.snaps[*id].iter())
                        .all(|(&slot, &old)| self.slots[slot] == old);
                if !(empty && self.counts[*id] >= *min) {
                    self.pc = *head;
                }
                true
            }
            Inst::Star {
                unit,
                min,
                max,
                greedy,
            } => {
                // Each unit taken costs a step; out of budget, the repeat
                // keeps its place and the instruction runs again. The step
                // that ran the instruction pays for its first unit, so a
                // budget of one still makes progress.
                let resumed = self.star.take().filter(|r| r.pc == pc);
                let base = resumed.map_or(self.pos, |r| r.base);
                let mut pos = resumed.map_or(self.pos, |r| r.pos);
                let mut count = resumed.map_or(0, |r| r.count);
                let mut min_pos = resumed.and_then(|r| r.min_pos);
                let mut ok = true;
                if min_pos.is_none() {
                    while count < *min {
                        match take(prog, unit, hay, pos) {
                            Some(next) => pos = next,
                            None => {
                                ok = false;
                                break;
                            }
                        }
                        count += 1;
                        if count < *min {
                            if *budget == 0 {
                                self.star = Some(Repeat {
                                    pc,
                                    base,
                                    pos,
                                    count,
                                    min_pos: None,
                                });
                                self.pc = pc;
                                return Ok(None);
                            }
                            *budget -= 1;
                        }
                    }
                    min_pos = Some(pos);
                }
                if ok && *greedy {
                    let min_pos = min_pos.unwrap_or(pos);
                    while max.is_none_or(|max| count < max) {
                        match take(prog, unit, hay, pos) {
                            Some(next) => pos = next,
                            None => break,
                        }
                        count += 1;
                        if *budget == 0 {
                            self.star = Some(Repeat {
                                pc,
                                base,
                                pos,
                                count,
                                min_pos: Some(min_pos),
                            });
                            self.pc = pc;
                            return Ok(None);
                        }
                        *budget -= 1;
                    }
                    if pos > min_pos {
                        self.push(Frame::StarBack {
                            pc: pc + 1,
                            min_pos,
                            pos,
                            base,
                        })?;
                    }
                } else if ok && max.is_none_or(|max| count < max) {
                    self.push(Frame::StarMore {
                        star: pc,
                        pos,
                        count,
                    })?;
                }
                self.pos = pos;
                ok
            }
            Inst::AtomicStart => {
                self.push(Frame::Mark {
                    look: None,
                    pos: self.pos,
                })?;
                true
            }
            Inst::AtomicEnd => {
                self.cut();
                true
            }
            Inst::LookStart {
                negate,
                behind,
                exit,
            } => {
                let mut start = self.pos;
                if let Some(back) = behind {
                    let mut stepped = true;
                    for _ in 0..*back {
                        match char_before(hay, start) {
                            Some(p) => start = p,
                            None => {
                                stepped = false;
                                break;
                            }
                        }
                    }
                    if !stepped {
                        if *negate {
                            self.pc = *exit;
                            return Ok(None);
                        }
                        return self.fail();
                    }
                }
                self.push(Frame::Mark {
                    look: Some((*negate, *exit)),
                    pos: self.pos,
                })?;
                self.pos = start;
                true
            }
            Inst::LookEnd { negate: false } => {
                if let Frame::Mark { pos, .. } = self.cut() {
                    self.pos = pos;
                }
                true
            }
            Inst::LookEnd { negate: true } => {
                self.unwind();
                false
            }
            Inst::Cond(refs, other) => {
                if !self.set(refs) {
                    match other {
                        Some(other) => self.pc = *other,
                        None => return self.fail(),
                    }
                }
                true
            }
            Inst::Fail => false,
            Inst::Match => {
                let len = self.pos - self.origin;
                if mode.not_empty && len == 0 {
                    false
                } else if mode.longest {
                    if best.as_ref().is_none_or(|b| len > b.len) {
                        *best = Some(Best {
                            len,
                            region: self.region(groups),
                        });
                    }
                    false
                } else {
                    return Ok(Some(Some(self.region(groups))));
                }
            }
        };
        if !ok {
            self.failing = true;
        }
        Ok(None)
    }

    fn fail(&mut self) -> Result<Option<Option<Region>>, &'static str> {
        self.failing = true;
        Ok(None)
    }
}
