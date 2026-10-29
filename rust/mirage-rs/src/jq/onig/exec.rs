// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regexec.c. See licenses/third_party/oniguruma.txt.

use std::ops::Range;

use super::callout::{Outcome, State};
use super::compile::{Inst, Program, Unit};
use super::parse::{Anchor, Saved, Update};
use super::{class, fold};
use crate::regex::Step;
use crate::rg_grapheme::Grapheme;

const UNSET: usize = usize::MAX;

/// ONIG_DEFAULT_RETRY_LIMIT_IN_MATCH: the backtracks one match attempt
/// may take.
const RETRY_LIMIT: u64 = 10_000_000;

/// The backtrack entries one attempt may hold; Oniguruma's own stack is
/// unbounded.
const FRAME_LIMIT: usize = 1 << 22;

/// ONIG_DEFAULT_SUBEXP_CALL_MAX_NEST_LEVEL: a call this deep fails.
const CALL_NEST_LIMIT: usize = 20;

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

/// The loops' state: each one's pass count, where the pass began, and
/// the group slots at its start.
#[derive(Clone, Default)]
struct Loops {
    counts: Vec<u32>,
    starts: Vec<usize>,
    snaps: Vec<Box<[usize]>>,
}

impl Loops {
    fn copy(&self, ids: Range<usize>) -> Loops {
        Loops {
            counts: self.counts[ids.clone()].to_vec(),
            starts: self.starts[ids.clone()].to_vec(),
            snaps: self.snaps[ids].to_vec(),
        }
    }

    /// Trades the loops `ids` names with `other`, which holds only those.
    fn swap(&mut self, ids: Range<usize>, other: &mut Loops) {
        self.counts[ids.clone()].swap_with_slice(&mut other.counts);
        self.starts[ids.clone()].swap_with_slice(&mut other.starts);
        self.snaps[ids].swap_with_slice(&mut other.snaps);
    }
}

/// A call not yet returned from: where it goes back to, and the loops of
/// the called group as the other side of the call has them.
struct Active {
    ret: usize,
    ids: Range<usize>,
    loops: Loops,
}

enum Frame {
    /// Resume at `pc` and `pos`.
    Alt {
        pc: usize,
        pos: usize,
    },
    /// An alternative an atomic cut keeps.
    SuperAlt {
        pc: usize,
        pos: usize,
    },
    /// A group slot changed from `old` to `value`.
    Slot {
        slot: usize,
        old: usize,
        value: usize,
    },
    /// A recursive group's start set back to its activation's at the
    /// end, undone with that end as a MEM_END entry undoes it; the scans
    /// that pair starts with ends pass over it.
    Start {
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
    /// A call began; its return is the top of `Machine::active`.
    Call,
    /// A call returned, holding the callee's loops to go back into it.
    Return(Active),
    SaveVal {
        kind: Saved,
        id: usize,
        value: usize,
    },
    /// A callout to run again as backtracking passes it.
    Callout(usize),
}

impl Frame {
    /// Whether an atomic cut keeps it: it puts state back, or Oniguruma
    /// never voids its kind.
    fn kept(&self) -> bool {
        !matches!(
            self,
            Frame::Alt { .. }
                | Frame::Mark { .. }
                | Frame::Enter { .. }
                | Frame::StarBack { .. }
                | Frame::StarMore { .. }
        )
    }
}

/// Which positions of the subject start an extended grapheme cluster.
struct Breaks {
    bits: Vec<u64>,
    at: usize,
    cursor: Option<Grapheme>,
    scanned: Option<usize>,
}

impl Breaks {
    fn new(bytes: usize) -> Breaks {
        let mut bits = Vec::with_capacity(bytes / 64 + 1);
        bits.push(1);
        Breaks {
            bits,
            at: 0,
            cursor: None,
            scanned: None,
        }
    }

    fn get(&mut self, hay: &[u8], pos: usize, budget: &mut u64) -> Option<bool> {
        while self.at < pos {
            let end = match self.scanned {
                Some(end) => end,
                None => {
                    let cursor = self
                        .cursor
                        .get_or_insert_with(|| Grapheme::new(hay, self.at, hay.len()));
                    let allowance = usize::try_from((*budget).max(1)).unwrap_or(usize::MAX);
                    let mut remaining = allowance;
                    let end = cursor.step(hay, &mut remaining);
                    *budget = budget.saturating_sub((allowance - remaining) as u64);
                    let end = end?;
                    self.scanned = Some(end);
                    self.cursor = None;
                    end
                }
            };
            let words = end / 64 + 1;
            let grow = (words - self.bits.len())
                .min(usize::try_from((*budget).max(1)).unwrap_or(usize::MAX));
            self.bits.resize(self.bits.len() + grow, 0);
            *budget = budget.saturating_sub(grow as u64);
            if self.bits.len() < words {
                return None;
            }
            self.bits[end / 64] |= 1 << (end % 64);
            self.at = end;
            self.scanned = None;
            if self.at < pos && *budget == 0 {
                return None;
            }
        }
        Some(self.bits[pos / 64] & (1 << (pos % 64)) != 0)
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
    /// Where the subject ends for the attempt, which the absent operator
    /// moves back (right_range).
    right: usize,
    slots: Vec<usize>,
    loops: Loops,
    frames: Vec<Frame>,
    failing: bool,
    retries: u64,
    star: Option<Repeat>,
    /// The calls entered and not returned from, the innermost last.
    active: Vec<Active>,
    /// Callout state, which lasts a search.
    pub(super) callouts: State,
    /// The subject's cluster starts, found on the first `\y` or `\X`.
    breaks: Option<Breaks>,
    segment: Option<usize>,
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
        Anchor::TextSegmentBoundary | Anchor::NotTextSegmentBoundary => {
            unreachable!("a text segment boundary needs the cluster table")
        }
    }
}

/// Where `unit` matched at `pos` ends, within `right`.
fn take(prog: &Program, unit: &Unit, hay: &[u8], pos: usize, right: usize) -> Option<usize> {
    if let Unit::Byte(b) = unit {
        return (pos < right && hay.get(pos) == Some(b)).then_some(pos + 1);
    }
    let (code, len) = unit_at(hay, pos)?;
    if pos + len > right {
        return None;
    }
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

/// `\R`'s length at `pos`, within `right`.
fn newline(hay: &[u8], pos: usize, right: usize) -> Option<usize> {
    if pos + 2 <= right && hay[pos..].starts_with(b"\r\n") {
        return Some(2);
    }
    let (code, len) = unit_at(hay, pos)?;
    (pos + len <= right && matches!(code, 0x0A..=0x0D | 0x85 | 0x2028 | 0x2029)).then_some(len)
}

/// Whether `hay[pos..]` begins with what `hay[start..end]` holds,
/// ignoring case when `fold`: where that ends. The caseless compare is
/// Oniguruma's string_cmp_ic: as many bytes as the capture, character
/// by character through each one's case folding.
fn backref(
    hay: &[u8],
    start: usize,
    end: usize,
    pos: usize,
    right: usize,
    fold: bool,
) -> Option<usize> {
    let len = end - start;
    if right.saturating_sub(pos) < len {
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
    pub(super) fn reset(&mut self, prog: &Program, origin: usize, end: usize) {
        self.pc = 0;
        self.pos = origin;
        self.origin = origin;
        self.keep = origin;
        self.right = end;
        self.star = None;
        self.slots.clear();
        self.slots.resize(prog.slots, UNSET);
        self.loops.counts.clear();
        self.loops.counts.resize(prog.loops.len(), 0);
        self.loops.starts.clear();
        self.loops.starts.resize(prog.loops.len(), UNSET);
        self.loops.snaps.clear();
        self.loops.snaps.extend(
            prog.loops
                .iter()
                .map(|slots| vec![UNSET; slots.len()].into()),
        );
        self.frames.clear();
        self.segment = None;
        self.failing = false;
        self.retries = 0;
        self.active.clear();
        self.callouts.attempt += 1;
        if self.callouts.data.len() != prog.callouts.len() {
            self.callouts.data = vec![Default::default(); prog.callouts.len()];
        }
    }

    /// Forgets what a search kept: callout data and `(*SKIP)`.
    pub(super) fn new_search(&mut self) {
        self.callouts = State::default();
    }

    /// Where `(*SKIP)` moved the next start to.
    pub(super) fn skip(&self) -> usize {
        self.callouts.skip
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
        self.push(Frame::Slot { slot, old, value })?;
        self.slots[slot] = value;
        Ok(())
    }

    /// Backtracks past a call: the caller's loops come back.
    fn uncall(&mut self) {
        let Some(mut active) = self.active.pop() else {
            unreachable!("a call frame has its call")
        };
        self.loops.swap(active.ids.clone(), &mut active.loops);
    }

    /// Backtracks past a return, back into the callee as it left.
    fn unreturn(&mut self, mut active: Active) {
        self.loops.swap(active.ids.clone(), &mut active.loops);
        self.active.push(active);
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
            count: self.loops.counts[id],
            start: self.loops.starts[id],
        })?;
        self.loops.counts[id] += 1;
        self.loops.starts[id] = self.pos;
        let watched = &prog.loops[id];
        if !watched.is_empty() {
            let now: Box<[usize]> = watched.iter().map(|&slot| self.slots[slot]).collect();
            let old = std::mem::replace(&mut self.loops.snaps[id], now);
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
            Frame::Alt { pc, pos } | Frame::SuperAlt { pc, pos } => {
                self.retry()?;
                self.pc = pc;
                self.pos = pos;
                return Ok(Popped::Resumed);
            }
            Frame::Slot { slot, old, .. } | Frame::Start { slot, old } => self.slots[slot] = old,
            Frame::Count { id, count, start } => {
                self.loops.counts[id] = count;
                self.loops.starts[id] = start;
            }
            Frame::Snap { id, old } => self.loops.snaps[id] = old,
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
                    if let Some(next) = take(prog, unit, hay, pos, self.right) {
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
            Frame::Call => self.uncall(),
            Frame::Return(active) => self.unreturn(active),
            Frame::SaveVal { .. } => {}
            Frame::Callout(num) => match self.callouts.run(&prog.callouts, num, self.pos, true) {
                Outcome::Success | Outcome::Fail => {}
                Outcome::Mismatch => return Ok(Popped::Exhausted),
                Outcome::Error(message) => return Err(message),
            },
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
        let kept: Vec<Frame> = self.frames.drain(at + 1..).filter(Frame::kept).collect();
        let mark = self.frames.pop().unwrap_or_else(|| unreachable!());
        self.frames.extend(kept);
        mark
    }

    /// Ends the innermost lookaround, putting back all it changed.
    fn unwind(&mut self) {
        while let Some(frame) = self.frames.pop() {
            match frame {
                Frame::Mark { .. } => return,
                Frame::Slot { slot, old, .. } | Frame::Start { slot, old } => {
                    self.slots[slot] = old
                }
                Frame::Count { id, count, start } => {
                    self.loops.counts[id] = count;
                    self.loops.starts[id] = start;
                }
                Frame::Snap { id, old } => self.loops.snaps[id] = old,
                Frame::Keep { old } => self.keep = old,
                Frame::Call => self.uncall(),
                Frame::Return(active) => self.unreturn(active),
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

    /// Walks the frames from the top, counting the call level each one
    /// sits at: the current call is level 0, its callers below, calls
    /// returned from above.
    fn levelled(&self) -> impl Iterator<Item = (i64, &Frame)> {
        let mut level = 0i64;
        self.frames.iter().rev().map(move |frame| {
            let at = level;
            match frame {
                Frame::Call => level -= 1,
                Frame::Return(_) => level += 1,
                _ => {}
            }
            (at, frame)
        })
    }

    /// backref_match_at_nested_level: where the capture one of `groups`
    /// holds at call level `nest` ends when it matches at `pos`.
    fn backref_at_level(
        &self,
        hay: &[u8],
        groups: &[usize],
        nest: i64,
        pos: usize,
        fold: bool,
    ) -> Option<usize> {
        let mut end = None;
        for (level, frame) in self.levelled() {
            let Frame::Slot { slot, value, .. } = frame else {
                continue;
            };
            if level != nest || !groups.contains(&(slot / 2)) {
                continue;
            }
            if slot % 2 == 1 {
                end = Some(*value);
            } else if let Some(end) = end {
                return backref(hay, *value, end, pos, self.right, fold);
            }
        }
        None
    }

    /// backref_check_at_nested_level: whether one of `groups` closed at
    /// call level `nest`.
    fn set_at_level(&self, groups: &[usize], nest: i64) -> bool {
        self.levelled().any(|(level, frame)| {
            matches!(frame, Frame::Slot { slot, .. } if level == nest && slot % 2 == 1 && groups.contains(&(slot / 2)))
        })
    }

    /// The last value a SAVE_VAL of `kind` and `id` kept at the current
    /// call level.
    fn saved(&self, kind: Saved, id: usize) -> Option<usize> {
        self.levelled().find_map(|(level, frame)| match frame {
            Frame::SaveVal {
                kind: k,
                id: i,
                value,
            } if level == 0 && *k == kind && *i == id => Some(*value),
            _ => None,
        })
    }

    /// Whether `pos` starts an extended grapheme cluster
    /// (onigenc_egcb_is_break_position); inside a character it is read
    /// against the byte there, as Oniguruma decodes it.
    fn is_break(&mut self, hay: &[u8], pos: usize, budget: &mut u64) -> Option<bool> {
        if pos == 0 || pos >= hay.len() {
            return Some(true);
        }
        let breaks = self.breaks.get_or_insert_with(|| Breaks::new(hay.len()));
        if breaks.get(hay, pos, budget)? {
            return Some(true);
        }
        if !continuation(hay[pos]) {
            return Some(false);
        }
        let Some(prev) = char_before(hay, pos) else {
            return Some(true);
        };
        let Some((from, _)) = unit_at(hay, prev) else {
            return Some(true);
        };
        let (Some(from), Some(to)) = (char::from_u32(from), char::from_u32(u32::from(hay[pos])))
        else {
            return Some(true);
        };
        let mut pair = String::new();
        pair.push(from);
        pair.push(to);
        let mut cursor = Grapheme::new(pair.as_bytes(), 0, pair.len());
        Some(cursor.step(pair.as_bytes(), &mut 9) == Some(from.len_utf8()))
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
            Inst::Unit(unit) => match take(prog, unit, hay, self.pos, self.right) {
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
            Inst::SplitSuper(first, second) => {
                self.push(Frame::SuperAlt {
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
            Inst::SaveRec(index) => {
                // The start this activation set is the one that pairs
                // with this end, as STACK_GET_MEM_START finds it.
                let start = 2 * index;
                let mut level = 0;
                let mut found = None;
                for frame in self.frames.iter().rev() {
                    let Frame::Slot { slot, value, .. } = frame else {
                        continue;
                    };
                    if *slot == start + 1 {
                        level += 1;
                    } else if *slot == start {
                        if level == 0 {
                            found = Some(*value);
                            break;
                        }
                        level -= 1;
                    }
                }
                if let Some(value) = found {
                    let old = self.slots[start];
                    self.push(Frame::Start { slot: start, old })?;
                    self.slots[start] = value;
                }
                self.save(start + 1, self.pos)?;
                true
            }
            Inst::Anchor(kind @ (Anchor::TextSegmentBoundary | Anchor::NotTextSegmentBoundary)) => {
                let Some(is_break) = self.is_break(hay, self.pos, budget) else {
                    self.pc = pc;
                    return Ok(None);
                };
                (*kind == Anchor::TextSegmentBoundary) == is_break
            }
            Inst::Anchor(kind) => anchor(*kind, hay, self.pos, mode.from),
            Inst::Backref {
                groups: refs,
                fold,
                level,
            } => {
                let matched = match level {
                    Some(level) => self.backref_at_level(hay, refs, *level, self.pos, *fold),
                    None => refs.iter().rev().find_map(|&g| {
                        let (start, end) = (self.slots[2 * g], self.slots[2 * g + 1]);
                        if start == UNSET || end == UNSET || start > end {
                            return None;
                        }
                        backref(hay, start, end, self.pos, self.right, *fold)
                    }),
                };
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
            Inst::Check {
                groups: refs,
                level,
            } => match level {
                Some(level) => self.set_at_level(refs, *level),
                None => self.set(refs),
            },
            Inst::Keep => {
                self.push(Frame::Keep { old: self.keep })?;
                self.keep = self.pos;
                true
            }
            Inst::Newline => match newline(hay, self.pos, self.right) {
                Some(len) => {
                    self.pos += len;
                    true
                }
                None => false,
            },
            Inst::RepStart(id) => {
                self.push(Frame::Count {
                    id: *id,
                    count: self.loops.counts[*id],
                    start: self.loops.starts[*id],
                })?;
                self.loops.counts[*id] = 0;
                true
            }
            Inst::RepLoop {
                id,
                min,
                max,
                greedy,
                exit,
            } => {
                let count = self.loops.counts[*id];
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
                let empty = self.pos == self.loops.starts[*id]
                    && prog.loops[*id]
                        .iter()
                        .zip(self.loops.snaps[*id].iter())
                        .all(|(&slot, &old)| self.slots[slot] == old);
                if !(empty && self.loops.counts[*id] >= *min) {
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
                        match take(prog, unit, hay, pos, self.right) {
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
                        match take(prog, unit, hay, pos, self.right) {
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
            Inst::Call { addr, loops } => {
                if self.active.len() == CALL_NEST_LIMIT {
                    false
                } else {
                    self.push(Frame::Call)?;
                    self.active.push(Active {
                        ret: self.pc,
                        ids: loops.clone(),
                        loops: self.loops.copy(loops.clone()),
                    });
                    self.pc = *addr;
                    true
                }
            }
            Inst::Return => {
                let Some(mut active) = self.active.pop() else {
                    unreachable!("a return has its call")
                };
                self.loops.swap(active.ids.clone(), &mut active.loops);
                self.pc = active.ret;
                self.push(Frame::Return(active))?;
                true
            }
            Inst::TextSegment => {
                let next = self
                    .segment
                    .take()
                    .or_else(|| take(prog, &Unit::AnyNl, hay, self.pos, self.right));
                match next {
                    Some(mut next) => {
                        loop {
                            match self.is_break(hay, next, budget) {
                                Some(true) => break,
                                None => {
                                    self.segment = Some(next);
                                    self.pc = pc;
                                    return Ok(None);
                                }
                                Some(false) => {}
                            }
                            match take(prog, &Unit::AnyNl, hay, next, self.right) {
                                Some(further) => next = further,
                                None => break,
                            }
                            if *budget == 0 {
                                self.segment = Some(next);
                                self.pc = pc;
                                return Ok(None);
                            }
                            *budget -= 1;
                        }
                        self.pos = next;
                        true
                    }
                    None => false,
                }
            }
            Inst::SaveVal(kind, id) => {
                let value = match kind {
                    Saved::Pos => self.pos,
                    Saved::Right => self.right,
                };
                self.push(Frame::SaveVal {
                    kind: *kind,
                    id: *id,
                    value,
                })?;
                true
            }
            Inst::UpdateVar(update) => {
                match update {
                    Update::RightFromPos(id) => {
                        if let Some(value) = self.saved(Saved::Pos, *id) {
                            self.right = value;
                        }
                    }
                    Update::RightFromRight(id) => {
                        if let Some(value) = self.saved(Saved::Right, *id) {
                            self.right = value;
                        }
                    }
                    Update::PosFromPos(id) => {
                        if let Some(value) = self.saved(Saved::Pos, *id) {
                            self.pos = value;
                        }
                    }
                    Update::RightInit => self.right = hay.len(),
                }
                true
            }
            Inst::Callout(num) => {
                let callout = &prog.callouts[*num];
                let mut ok = true;
                if callout.in_progress() {
                    match self.callouts.run(&prog.callouts, *num, self.pos, false) {
                        Outcome::Success => {}
                        Outcome::Fail => ok = false,
                        Outcome::Mismatch => return Ok(Some(None)),
                        Outcome::Error(message) => return Err(message),
                    }
                }
                if ok && callout.in_retraction() {
                    self.push(Frame::Callout(*num))?;
                }
                ok
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
