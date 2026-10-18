use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use super::compile::{Atom, Program, has, is};
use super::{Key, Positions, Span};

fn append_span(spans: &mut Vec<Span>, (lo, hi): Span) {
    if lo >= hi {
        return;
    }
    if let Some(last) = spans.last_mut().filter(|last| lo <= last.1) {
        last.1 = last.1.max(hi);
        return;
    }
    spans.push((lo, hi));
}

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
struct StateSetId(usize);

#[derive(Eq, Ord, PartialEq, PartialOrd)]
struct RunKey {
    start: usize,
    end: usize,
    offset: usize,
    incoming: StateSetId,
}

#[derive(Default)]
struct TailCache {
    prefixes: BTreeMap<(StateSetId, usize), StateSetId>,
    runs: BTreeMap<RunKey, Key>,
}

impl TailCache {
    fn extend(&mut self, prefix: StateSetId, state: usize) -> StateSetId {
        let next = StateSetId(
            self.prefixes
                .len()
                .checked_add(1)
                .expect("glob state-set IDs exhausted"),
        );
        *self.prefixes.entry((prefix, state)).or_insert(next)
    }
}

struct Negative {
    end: usize,
    branch: usize,
    matched: BTreeMap<usize, usize>,
    answer: Option<Positions>,
    answer_index: usize,
    merging: Option<Span>,
    cursor: usize,
    scanning: bool,
    upper: usize,
}

enum Phase {
    Position,
    Initial {
        after: Option<usize>,
        incoming: Option<StateSetId>,
    },
    Active,
    Epsilon {
        state: usize,
        index: usize,
    },
    Bracket {
        state: usize,
        index: usize,
        found: bool,
    },
    Negative {
        state: usize,
        work: Negative,
    },
    Tail {
        spans: Positions,
        index: usize,
    },
}

struct Frame {
    key: Key,
    retain_runs: bool,
    position: usize,
    pending: BTreeMap<usize, BTreeSet<usize>>,
    seen: BTreeSet<usize>,
    active: Vec<usize>,
    scheduled: HashMap<usize, BTreeMap<usize, usize>>,
    accepted: Vec<Span>,
    phase: Phase,
    answer: Option<Positions>,
}

enum Progress {
    Continue,
    Need(Key),
    Done(Positions),
}

impl Frame {
    fn new(key: Key, retain_runs: bool) -> Self {
        Self {
            key,
            retain_runs,
            position: key.2,
            pending: BTreeMap::from([(key.2, BTreeSet::from([key.0]))]),
            seen: BTreeSet::new(),
            active: Vec::new(),
            scheduled: HashMap::new(),
            accepted: Vec::new(),
            phase: Phase::Position,
            answer: None,
        }
    }
    fn schedule(&mut self, state: usize, offset: usize) {
        if offset == self.position {
            if self.seen.insert(state) {
                self.active.push(state);
            }
        } else {
            self.pending.entry(offset).or_default().insert(state);
        }
    }
    fn step(
        &mut self,
        program: &Program,
        subject: &[u32],
        reverse: bool,
        period: bool,
        memo: &HashMap<Key, Positions>,
        tails: &mut TailCache,
    ) -> Progress {
        let size = subject.len();
        let character = |position: usize| {
            subject[if reverse {
                size - 1 - position
            } else {
                position
            }]
        };
        let phase = std::mem::replace(&mut self.phase, Phase::Active);
        match phase {
            Phase::Position => {
                let Some((position, seen)) = self.pending.pop_first() else {
                    return Progress::Done(Arc::new(std::mem::take(&mut self.accepted)));
                };
                if position > size {
                    return Progress::Done(Arc::new(std::mem::take(&mut self.accepted)));
                }
                self.position = position;
                self.seen = seen;
                self.active.clear();
                self.phase = Phase::Initial {
                    after: None,
                    incoming: (self.retain_runs && self.pending.is_empty())
                        .then_some(StateSetId::default()),
                };
            }
            Phase::Initial { after, incoming } => {
                let state = match after {
                    Some(state) if program.floors.contains(&state) => None,
                    Some(state) => self.seen.range(..state).next_back(),
                    None => self.seen.last(),
                };
                if let Some(&state) = state {
                    self.active.push(state);
                    self.phase = Phase::Initial {
                        after: Some(state),
                        incoming: incoming.map(|prefix| tails.extend(prefix, state)),
                    };
                } else if let Some(incoming) = incoming {
                    let run = *tails
                        .runs
                        .entry(RunKey {
                            start: self.key.0,
                            end: self.key.1,
                            offset: self.position,
                            incoming,
                        })
                        .or_insert(self.key);
                    if let Some(done) = memo.get(&run) {
                        self.phase = Phase::Tail {
                            spans: Arc::clone(done),
                            index: done.partition_point(|&(_, hi)| hi <= self.position),
                        };
                    }
                }
            }
            Phase::Active => {
                let Some(state) = self.active.pop() else {
                    self.phase = Phase::Position;
                    return Progress::Continue;
                };
                if state == self.key.1 {
                    append_span(&mut self.accepted, (self.position, self.position + 1));
                    return Progress::Continue;
                }
                if program.extglob && program.transitions.contains_key(&state) {
                    self.phase = Phase::Epsilon { state, index: 0 };
                    return Progress::Continue;
                }
                if let Some(group) = program
                    .groups
                    .get(&state)
                    .filter(|group| program.extglob && group.end <= self.key.1)
                {
                    let covered = self
                        .scheduled
                        .get(&group.end)
                        .and_then(|spans| spans.range(..=self.position + 1).next_back())
                        .is_some_and(|(_, &hi)| hi > size);
                    if (period && self.position == 0) || (self.seen.contains(&group.end) && covered)
                    {
                        return Progress::Continue;
                    }
                    self.phase = Phase::Negative {
                        state,
                        work: Negative {
                            end: group.end,
                            branch: 0,
                            matched: BTreeMap::new(),
                            answer: None,
                            answer_index: 0,
                            merging: None,
                            cursor: self.position,
                            scanning: false,
                            upper: 0,
                        },
                    };
                    return Progress::Continue;
                }
                let cp = program.units[state];
                let bracket = program.brackets.get(&state);
                let wildcard = has(cp, b"*?") || bracket.is_some();
                if period && self.position == 0 && wildcard {
                    return Progress::Continue;
                }
                if let Some(&last) = program.stars.get(&state) {
                    self.schedule(last, self.position);
                } else if is(cp, b'*') {
                    self.schedule(state + 1, self.position);
                    if self.position < size {
                        self.schedule(state, self.position + 1);
                    }
                } else if self.position < size {
                    if bracket.is_some() {
                        self.phase = Phase::Bracket {
                            state,
                            index: 0,
                            found: false,
                        };
                    } else if is(cp, b'?') || program.literal(cp) == character(self.position) {
                        self.schedule(state + 1, self.position + 1);
                    }
                }
            }
            Phase::Epsilon { state, index } => {
                if let Some(&target) = program.transitions[&state].get(index) {
                    self.schedule(target, self.position);
                    self.phase = Phase::Epsilon {
                        state,
                        index: index + 1,
                    };
                }
            }
            Phase::Bracket {
                state,
                index,
                mut found,
            } => {
                let bracket = &program.brackets[&state];
                if !bracket.valid {
                    return Progress::Continue;
                }
                if let Some(&atom) = bracket.atoms.get(index) {
                    let cp = character(self.position);
                    found |= match atom {
                        Atom::Literal(unit) => unit == cp,
                        Atom::Range(lo, hi) => lo <= cp && cp <= hi,
                        Atom::Class(class) => class.contains(cp),
                    };
                    self.phase = Phase::Bracket {
                        state,
                        index: index + 1,
                        found,
                    };
                } else if found != bracket.negate {
                    self.schedule(bracket.end, self.position + 1);
                }
            }
            Phase::Tail { spans, index } => {
                if let Some(&(lo, hi)) = spans.get(index) {
                    append_span(&mut self.accepted, (lo.max(self.position), hi));
                    self.phase = Phase::Tail {
                        spans,
                        index: index + 1,
                    };
                } else {
                    return Progress::Done(Arc::new(std::mem::take(&mut self.accepted)));
                }
            }
            Phase::Negative { state, mut work } => {
                if !work.scanning {
                    if let Some((mut lo, mut hi)) = work.merging.take() {
                        if let Some((&a, &b)) = work
                            .matched
                            .range(..=lo)
                            .next_back()
                            .filter(|entry| *entry.1 >= lo)
                        {
                            work.matched.remove(&a);
                            lo = a;
                            hi = hi.max(b);
                            work.merging = Some((lo, hi));
                        } else if let Some((&a, &b)) = work.matched.range(lo..=hi).next() {
                            work.matched.remove(&a);
                            work.merging = Some((lo, hi.max(b)));
                        } else {
                            work.matched.insert(lo, hi);
                        }
                    } else if let Some(answer) = &work.answer {
                        if let Some(&span) = answer.get(work.answer_index) {
                            work.merging = Some(span);
                            work.answer_index += 1;
                        } else {
                            work.answer = None;
                            work.answer_index = 0;
                            work.branch += 1;
                        }
                    } else if let Some(answer) = self.answer.take() {
                        work.answer = Some(answer);
                    } else if let Some(&(lo, hi)) = program.groups[&state].branches.get(work.branch)
                    {
                        let key = (lo, hi, self.position);
                        self.phase = Phase::Negative { state, work };
                        return Progress::Need(key);
                    } else {
                        work.scanning = true;
                    }
                } else if work.cursor <= size {
                    if work.upper > work.cursor {
                        let covered = self
                            .scheduled
                            .get(&work.end)
                            .and_then(|spans| spans.range(..=work.cursor).next_back())
                            .map(|(_, &hi)| hi);
                        if let Some(hi) = covered.filter(|&hi| hi > work.cursor) {
                            work.cursor = hi.min(work.upper);
                        } else {
                            let target = work.cursor;
                            self.schedule(work.end, target);
                            if target > self.position {
                                let spans = self.scheduled.entry(work.end).or_default();
                                let mut lo = target;
                                let mut hi = target + 1;
                                if let Some((&a, _)) = spans
                                    .range(..=target)
                                    .next_back()
                                    .filter(|entry| *entry.1 >= target)
                                {
                                    lo = a;
                                    spans.remove(&a);
                                }
                                if let Some((&a, &b)) = spans
                                    .range(target + 1..)
                                    .next()
                                    .filter(|entry| *entry.0 <= hi)
                                {
                                    hi = b;
                                    spans.remove(&a);
                                }
                                spans.insert(lo, hi);
                            }
                            work.cursor += 1;
                        }
                    } else if let Some((_, &hi)) = work
                        .matched
                        .range(..=work.cursor)
                        .next_back()
                        .filter(|entry| *entry.1 > work.cursor)
                    {
                        work.cursor = hi;
                    } else {
                        work.upper = work
                            .matched
                            .range(work.cursor..)
                            .next()
                            .map_or(size + 1, |(&lo, _)| lo);
                    }
                } else {
                    return Progress::Continue;
                }
                self.phase = Phase::Negative { state, work };
            }
        }
        Progress::Continue
    }
}

#[derive(Default)]
pub(super) struct Evaluator {
    frames: Vec<Frame>,
    memo: HashMap<Key, Positions>,
    tails: TailCache,
    pub(super) answer: Option<Positions>,
}

impl Evaluator {
    pub(super) fn start(&mut self, key: Key, retain_runs: bool) {
        self.answer = self.memo.get(&key).cloned();
        if self.answer.is_none() {
            self.frames.push(Frame::new(key, retain_runs));
        }
    }
    pub(super) fn step(&mut self, program: &Program, subject: &[u32], reverse: bool, period: bool) {
        let Some(mut frame) = self.frames.pop() else {
            return;
        };
        match frame.step(
            program,
            subject,
            reverse,
            period,
            &self.memo,
            &mut self.tails,
        ) {
            Progress::Continue => self.frames.push(frame),
            Progress::Need(key) => {
                if let Some(answer) = self.memo.get(&key) {
                    frame.answer = Some(Arc::clone(answer));
                    self.frames.push(frame);
                } else {
                    self.frames.push(frame);
                    self.frames.push(Frame::new(key, true));
                }
            }
            Progress::Done(answer) => {
                self.memo.insert(frame.key, Arc::clone(&answer));
                if let Some(parent) = self.frames.last_mut() {
                    parent.answer = Some(answer);
                } else {
                    self.answer = Some(answer);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::glob::compile::{Compiler, Dialect};

    #[test]
    fn boolean_match_retains_bounded_run_history() {
        let mut compiler = Compiler::new(vec![u32::from(b'*')], Dialect::Shell, false);
        while !compiler.done() {
            compiler.step();
        }
        let subject = vec![u32::from(b'a'); 32_768];
        let mut evaluator = Evaluator::default();
        evaluator.start((0, 1, 0), false);
        while evaluator.answer.is_none() {
            evaluator.step(&compiler.program, &subject, false, false);
        }
        assert_eq!(
            evaluator.answer.as_deref().unwrap().last(),
            Some(&(0, subject.len() + 1))
        );
        assert!(
            evaluator.tails.runs.len() <= 1,
            "a single boolean match retained {} run histories",
            evaluator.tails.runs.len()
        );
    }
}
