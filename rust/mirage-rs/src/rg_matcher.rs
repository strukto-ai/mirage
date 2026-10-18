// Ordered NFA execution adapted from regex-automata 0.4.7,
// src/nfa/thompson/pikevm.rs. Copyright (c) 2014 The Rust Project Developers.
// Licensed under MIT OR Apache-2.0. The license texts are retained in the
// repository's third-party license records.

use std::ops::Deref;

use grep_regex::RegexMatcherBuilder;
use regex_automata::PatternID;
use regex_automata::nfa::thompson::{NFA, State};
use regex_automata::util::primitives::StateID;
use serde::Serialize;

use crate::StreamError;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Options {
    pub(crate) ignore_case: bool,
    pub(crate) smart_case: bool,
    pub(crate) unicode: bool,
    pub(crate) multiline: bool,
    pub(crate) dotall: bool,
    pub(crate) crlf: bool,
    pub(crate) whole_word: bool,
    pub(crate) line_regexp: bool,
    pub(crate) fixed: bool,
    pub(crate) null_data: bool,
    pub(crate) ban_nul: bool,
    pub(crate) regex_size_limit: Option<usize>,
    pub(crate) dfa_size_limit: Option<usize>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ignore_case: false,
            smart_case: false,
            unicode: true,
            multiline: false,
            dotall: false,
            crlf: false,
            whole_word: false,
            line_regexp: false,
            fixed: false,
            null_data: false,
            ban_nul: false,
            regex_size_limit: None,
            dfa_size_limit: None,
        }
    }
}

#[derive(Serialize)]
pub(crate) struct SearchHints {
    texts: Vec<String>,
    whole_word: bool,
    ignore_case: bool,
}

pub(crate) struct Program {
    nfa: NFA,
    multiline: bool,
    record_context: bool,
    pub(crate) required_terms: Option<SearchHints>,
}

impl Program {
    pub(crate) fn with_options(patterns: &[String], options: Options) -> Result<Self, StreamError> {
        if patterns.is_empty() {
            return Ok(Self {
                nfa: NFA::never_match(),
                required_terms: None,
                multiline: false,
                record_context: false,
            });
        }
        let mut builder = RegexMatcherBuilder::new();
        builder
            .multi_line(true)
            .case_insensitive(options.ignore_case)
            .case_smart(options.smart_case)
            .unicode(options.unicode)
            .fixed_strings(options.fixed)
            .whole_line(options.line_regexp)
            .word(options.whole_word);
        if options.multiline {
            builder.dot_matches_new_line(options.dotall);
            if options.crlf {
                builder.crlf(true).line_terminator(None);
            }
        } else {
            builder
                .line_terminator(Some(b'\n'))
                .dot_matches_new_line(false);
            if options.crlf {
                builder.crlf(true);
            }
            if options.null_data {
                builder.line_terminator(Some(0));
            }
        }
        if let Some(limit) = options.regex_size_limit {
            builder.size_limit(limit);
        }
        if let Some(limit) = options.dfa_size_limit {
            builder.dfa_size_limit(limit);
        }
        if options.ban_nul {
            builder.ban_byte(Some(0));
        }
        let (nfa, non_matching, required_terms) = builder.build_nfa(patterns).map_err(|err| {
            let mut message = err.to_string();
            if message.contains("the literal") && message.contains("not allowed") {
                message.push_str("\n\nConsider enabling multiline mode with the --multiline flag (or -U for short).\nWhen multiline mode is enabled, new line characters can be matched.");
            }
            if message.contains("look-around") || message.contains("backreferences are not supported") {
                message.push_str("\n\nConsider enabling PCRE2 with the --pcre2 flag, which can handle backreferences\nand look-around.");
            }
            if message.contains("pattern contains \"\\0\"") {
                message.push_str("\n\nConsider enabling text mode with the --text flag (or -a for short). Otherwise,\nbinary detection is enabled and matching a NUL byte is impossible.");
            }
            StreamError::new(message)
        })?;
        let terminator = if options.null_data { 0 } else { b'\n' };
        Ok(Self {
            nfa,
            multiline: options.multiline
                && (!non_matching.contains(terminator)
                    || options.null_data && !non_matching.contains(b'\n')),
            record_context: options.multiline
                && options.null_data
                && non_matching.contains(terminator)
                && !non_matching.contains(b'\n'),
            required_terms: required_terms.map(|(mut texts, whole_word)| {
                let folded = texts[0].to_ascii_lowercase();
                let ignore_case = texts.len() > 1
                    && folded.is_ascii()
                    && texts
                        .iter()
                        .all(|text| text.is_ascii() && text.eq_ignore_ascii_case(&folded));
                if ignore_case {
                    texts = vec![folded];
                }
                SearchHints {
                    texts,
                    whole_word,
                    ignore_case,
                }
            }),
        })
    }

    pub(crate) fn capture_index(&self, name: &str) -> Option<usize> {
        self.nfa.group_info().to_index(PatternID::ZERO, name)
    }

    pub(crate) fn is_multiline(&self) -> bool {
        self.multiline
    }

    pub(crate) fn uses_record_context(&self) -> bool {
        self.record_context
    }

    pub(crate) fn capture_names(&self) -> impl Iterator<Item = (&str, usize)> {
        self.nfa
            .group_info()
            .pattern_names(PatternID::ZERO)
            .enumerate()
            .filter_map(|(index, name)| name.map(|name| (name, index)))
    }

    pub(crate) fn start(&self, haystack: Vec<u8>, all: bool) -> Search {
        Search::new(self, haystack, all)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Match {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

type Capture = Option<(usize, usize)>;

pub(crate) struct Matches {
    rows: Vec<Match>,
    captures: Vec<Capture>,
    group_count: usize,
}

impl Matches {
    pub(crate) fn capture(&self, index: usize, group: usize) -> Capture {
        if group >= self.group_count {
            return None;
        }
        self.captures[index * self.group_count + group]
    }

    pub(crate) fn pop(&mut self) -> Option<Match> {
        self.rows.pop()
    }
}

impl Deref for Matches {
    type Target = [Match];

    fn deref(&self) -> &Self::Target {
        &self.rows
    }
}

struct Growing<T: Copy> {
    values: Vec<T>,
    previous: Option<Vec<T>>,
}

impl<T: Copy> Growing<T> {
    fn new() -> Self {
        Self {
            values: Vec::new(),
            previous: None,
        }
    }

    fn push(&mut self, value: T) -> bool {
        if let Some(previous) = &self.previous {
            if self.values.len() < previous.len() {
                self.values.push(previous[self.values.len()]);
            } else {
                self.previous = None;
            }
            return false;
        }
        if self.values.len() == self.values.capacity() {
            let capacity = self.values.len().saturating_mul(2).max(64);
            self.previous = Some(std::mem::replace(
                &mut self.values,
                Vec::with_capacity(capacity),
            ));
            return false;
        }
        self.values.push(value);
        true
    }

    fn clear(&mut self) {
        self.values.clear();
        self.previous = None;
    }

    fn take(&mut self) -> Vec<T> {
        debug_assert!(self.previous.is_none());
        std::mem::take(&mut self.values)
    }
}

struct States {
    ids: Vec<StateID>,
    seen: Vec<u64>,
    rows: Vec<Vec<Option<usize>>>,
    generation: u64,
}

impl States {
    fn new(len: usize) -> Self {
        Self {
            ids: Vec::with_capacity(len),
            seen: Vec::with_capacity(len),
            rows: Vec::with_capacity(len),
            generation: 1,
        }
    }

    fn initialize_one(&mut self) {
        self.seen.push(0);
        self.rows.push(Vec::new());
    }

    fn visit(&mut self, id: StateID) -> bool {
        let seen = &mut self.seen[id.as_usize()];
        if *seen == self.generation {
            return false;
        }
        *seen = self.generation;
        true
    }

    fn clear(&mut self) {
        self.ids.clear();
        self.generation = self
            .generation
            .checked_add(1)
            .expect("a search cannot visit 2^64 byte positions");
    }
}

#[derive(Clone, Copy)]
enum Destination {
    Current,
    Next,
}

#[derive(Clone, Copy)]
enum Origin {
    Start,
    Current(StateID),
}

enum Frame {
    Explore(StateID),
    Alternatives { state: StateID, index: usize },
    Restore { slot: usize, value: Option<usize> },
}

#[derive(Clone, Copy)]
enum Return {
    Threads(usize),
}

struct Closure {
    destination: Destination,
    origin: Origin,
    at: usize,
    stack: Vec<Frame>,
    copying: Option<(StateID, usize)>,
    resume: Return,
}

#[derive(Clone, Copy)]
enum Phase {
    InitializeStates,
    InitializeSlots,
    Byte,
    Closure,
    Threads(usize),
    Candidate { state: StateID, slot: usize },
    ByteDone,
    Emit { group: usize },
    Restart,
    Done,
}

pub(crate) struct Search {
    haystack: Vec<u8>,
    all: bool,
    phase: Phase,
    from: usize,
    at: usize,
    current: States,
    next: States,
    start_slots: Vec<Option<usize>>,
    closure: Option<Closure>,
    frames: Vec<Frame>,
    candidate: Vec<Option<usize>>,
    has_candidate: bool,
    last_end: Option<usize>,
    building: Option<Match>,
    group_count: usize,
    matches: Growing<Match>,
    captures: Growing<Capture>,
}

impl Search {
    fn new(program: &Program, haystack: Vec<u8>, all: bool) -> Self {
        let states = program.nfa.states().len();
        Self {
            haystack,
            all,
            phase: Phase::InitializeStates,
            from: 0,
            at: 0,
            current: States::new(states),
            next: States::new(states),
            start_slots: Vec::with_capacity(program.nfa.group_info().slot_len()),
            closure: None,
            frames: Vec::with_capacity(states.saturating_mul(2)),
            candidate: Vec::with_capacity(program.nfa.group_info().slot_len()),
            has_candidate: false,
            last_end: None,
            building: None,
            group_count: program.nfa.group_info().group_len(PatternID::ZERO),
            matches: Growing::new(),
            captures: Growing::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn matches(&self) -> &[Match] {
        &self.matches.values
    }
    pub(crate) fn take_matches(&mut self) -> Matches {
        Matches {
            rows: self.matches.take(),
            captures: self.captures.take(),
            group_count: self.group_count,
        }
    }
    #[cfg(test)]
    pub(crate) fn haystack(&self) -> &[u8] {
        &self.haystack
    }
    pub(crate) fn take_haystack(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.haystack)
    }

    pub(crate) fn reset(&mut self, haystack: Vec<u8>, all: bool) {
        self.haystack = haystack;
        self.all = all;
        self.from = 0;
        self.at = 0;
        self.current.clear();
        self.next.clear();
        self.has_candidate = false;
        self.last_end = None;
        self.building = None;
        self.matches.clear();
        self.captures.clear();
        self.phase = Phase::InitializeStates;
    }

    pub(crate) fn step(&mut self, program: &Program, budget: usize) -> bool {
        for _ in 0..budget {
            self.one(program);
            if matches!(self.phase, Phase::Done) {
                return true;
            }
        }
        matches!(self.phase, Phase::Done)
    }

    fn states_mut(&mut self, destination: Destination) -> &mut States {
        match destination {
            Destination::Current => &mut self.current,
            Destination::Next => &mut self.next,
        }
    }

    fn origin_value(&self, origin: Origin, slot: usize) -> Option<usize> {
        match origin {
            Origin::Start => self.start_slots[slot],
            Origin::Current(id) => self.current.rows[id.as_usize()][slot],
        }
    }

    fn set_origin(&mut self, origin: Origin, slot: usize, value: Option<usize>) {
        match origin {
            Origin::Start => self.start_slots[slot] = value,
            Origin::Current(id) => self.current.rows[id.as_usize()][slot] = value,
        }
    }

    fn close(
        &mut self,
        destination: Destination,
        origin: Origin,
        at: usize,
        id: StateID,
        resume: Return,
    ) {
        let mut stack = std::mem::take(&mut self.frames);
        stack.push(Frame::Explore(id));
        self.closure = Some(Closure {
            destination,
            origin,
            at,
            stack,
            copying: None,
            resume,
        });
        self.phase = Phase::Closure;
    }

    fn finish_match(&mut self) {
        if !self.has_candidate {
            self.phase = Phase::Done;
            return;
        }
        let start = self.candidate[0].expect("a matched NFA records its start");
        let end = self.candidate[1].expect("a matched NFA records its end");
        if start == end && self.last_end == Some(end) {
            self.from = end + 1;
            self.phase = Phase::Restart;
            return;
        }
        self.building = Some(Match { start, end });
        self.phase = Phase::Emit { group: 0 };
    }

    fn one(&mut self, program: &Program) {
        match self.phase {
            Phase::InitializeStates => {
                if self.current.rows.len() < program.nfa.states().len() {
                    self.current.initialize_one();
                    self.next.initialize_one();
                } else {
                    self.phase = Phase::InitializeSlots;
                }
            }
            Phase::InitializeSlots => {
                if self.start_slots.len() < program.nfa.group_info().slot_len() {
                    self.start_slots.push(None);
                } else if program.nfa.pattern_len() == 0 {
                    self.phase = Phase::Done;
                } else {
                    self.phase = Phase::Byte;
                }
            }
            Phase::Byte => {
                if self.at > self.haystack.len()
                    || self.current.ids.is_empty()
                        && (self.has_candidate
                            || program.nfa.is_always_start_anchored() && self.at > self.from)
                {
                    self.finish_match();
                } else if !self.has_candidate
                    && (!program.nfa.is_always_start_anchored() || self.at == self.from)
                {
                    self.close(
                        Destination::Current,
                        Origin::Start,
                        self.at,
                        program.nfa.start_anchored(),
                        Return::Threads(0),
                    );
                } else {
                    self.phase = Phase::Threads(0);
                }
            }
            Phase::Closure => self.closure_one(program),
            Phase::Threads(index) => {
                let Some(&id) = self.current.ids.get(index) else {
                    self.phase = Phase::ByteDone;
                    return;
                };
                let target = match program.nfa.state(id) {
                    State::ByteRange { trans } if trans.matches(&self.haystack, self.at) => {
                        Some(trans.next)
                    }
                    State::Sparse(trans) => trans.matches(&self.haystack, self.at),
                    State::Dense(trans) => trans.matches(&self.haystack, self.at),
                    State::Match { .. } => {
                        self.phase = Phase::Candidate { state: id, slot: 0 };
                        return;
                    }
                    _ => None,
                };
                if let Some(next) = target {
                    self.close(
                        Destination::Next,
                        Origin::Current(id),
                        self.at + 1,
                        next,
                        Return::Threads(index + 1),
                    );
                } else {
                    self.phase = Phase::Threads(index + 1);
                }
            }
            Phase::Candidate { state, slot } => {
                if slot < self.start_slots.len() {
                    let value = self.current.rows[state.as_usize()][slot];
                    if slot < self.candidate.len() {
                        self.candidate[slot] = value;
                    } else {
                        self.candidate.push(value);
                    }
                    self.phase = Phase::Candidate {
                        state,
                        slot: slot + 1,
                    };
                } else {
                    self.has_candidate = true;
                    self.phase = Phase::ByteDone;
                }
            }
            Phase::ByteDone => {
                std::mem::swap(&mut self.current, &mut self.next);
                self.next.clear();
                self.at += 1;
                self.phase = Phase::Byte;
            }
            Phase::Emit { group } => {
                if group < program.nfa.group_info().group_len(PatternID::ZERO) {
                    let slot = program
                        .nfa
                        .group_info()
                        .slot(PatternID::ZERO, group)
                        .unwrap();
                    let capture = self.candidate[slot].zip(self.candidate[slot + 1]);
                    if self.captures.push(capture) {
                        self.phase = Phase::Emit { group: group + 1 };
                    }
                } else {
                    let found = self.building.unwrap();
                    if !self.matches.push(found) {
                        return;
                    }
                    self.building = None;
                    self.last_end = Some(found.end);
                    self.from = if found.start == found.end {
                        found.end + 1
                    } else {
                        found.end
                    };
                    if self.all {
                        self.phase = Phase::Restart;
                    } else {
                        self.phase = Phase::Done;
                    }
                }
            }
            Phase::Restart => {
                if self.from > self.haystack.len() {
                    self.phase = Phase::Done;
                } else {
                    self.current.clear();
                    self.next.clear();
                    self.has_candidate = false;
                    self.at = self.from;
                    self.phase = Phase::Byte;
                }
            }
            Phase::Done => {}
        }
    }

    fn closure_one(&mut self, program: &Program) {
        let mut closure = self.closure.take().expect("closure phase owns its state");
        if let Some((id, slot)) = closure.copying {
            if slot < self.start_slots.len() {
                let value = self.origin_value(closure.origin, slot);
                let row = &mut self.states_mut(closure.destination).rows[id.as_usize()];
                if slot < row.len() {
                    row[slot] = value;
                } else {
                    row.push(value);
                }
                closure.copying = Some((id, slot + 1));
            } else {
                closure.copying = None;
            }
            self.closure = Some(closure);
            return;
        }
        let Some(frame) = closure.stack.pop() else {
            self.phase = match closure.resume {
                Return::Threads(index) => Phase::Threads(index),
            };
            self.frames = closure.stack;
            return;
        };
        match frame {
            Frame::Restore { slot, value } => self.set_origin(closure.origin, slot, value),
            Frame::Alternatives { state, index } => {
                if let State::Union { alternates } = program.nfa.state(state) {
                    if let Some(&next) = alternates.get(index) {
                        closure.stack.push(Frame::Alternatives {
                            state,
                            index: index + 1,
                        });
                        closure.stack.push(Frame::Explore(next));
                    }
                }
            }
            Frame::Explore(id) => {
                if self.states_mut(closure.destination).visit(id) {
                    match program.nfa.state(id) {
                        State::Fail => {}
                        State::Match { .. }
                        | State::ByteRange { .. }
                        | State::Sparse(_)
                        | State::Dense(_) => {
                            let states = self.states_mut(closure.destination);
                            states.ids.push(id);
                            let row = &mut states.rows[id.as_usize()];
                            if row.capacity() == 0 {
                                *row = Vec::with_capacity(program.nfa.group_info().slot_len());
                            }
                            closure.copying = Some((id, 0));
                        }
                        State::Look { look, next } => {
                            if program
                                .nfa
                                .look_matcher()
                                .matches(*look, &self.haystack, closure.at)
                            {
                                closure.stack.push(Frame::Explore(*next));
                            }
                        }
                        State::Union { alternates } => {
                            if let Some(&first) = alternates.first() {
                                closure.stack.push(Frame::Alternatives {
                                    state: id,
                                    index: 1,
                                });
                                closure.stack.push(Frame::Explore(first));
                            }
                        }
                        State::BinaryUnion { alt1, alt2 } => {
                            closure.stack.push(Frame::Explore(*alt2));
                            closure.stack.push(Frame::Explore(*alt1));
                        }
                        State::Capture { next, slot, .. } => {
                            let index = slot.as_usize();
                            let value = self.origin_value(closure.origin, index);
                            closure.stack.push(Frame::Restore { slot: index, value });
                            self.set_origin(closure.origin, index, Some(closure.at));
                            closure.stack.push(Frame::Explore(*next));
                        }
                    }
                }
            }
        }
        self.closure = Some(closure);
    }
}

#[cfg(test)]
mod tests {
    use crate::rg_matcher;
    use grep_matcher::{Captures, Matcher};
    use grep_regex::RegexMatcherBuilder;

    #[test]
    fn capture_cleanup_has_no_per_match_destructor() {
        assert!(!std::mem::needs_drop::<rg_matcher::Match>());
    }

    fn builder(options: rg_matcher::Options) -> RegexMatcherBuilder {
        let mut builder = RegexMatcherBuilder::new();
        builder
            .multi_line(true)
            .unicode(options.unicode)
            .case_insensitive(options.ignore_case)
            .case_smart(options.smart_case)
            .fixed_strings(options.fixed)
            .word(options.whole_word)
            .whole_line(options.line_regexp);
        if options.multiline {
            builder.dot_matches_new_line(options.dotall);
            if options.crlf {
                builder.crlf(true).line_terminator(None);
            }
        } else {
            builder
                .line_terminator(Some(b'\n'))
                .dot_matches_new_line(false);
            if options.crlf {
                builder.crlf(true);
            }
            if options.null_data {
                builder.line_terminator(Some(0));
            }
        }
        if let Some(limit) = options.regex_size_limit {
            builder.size_limit(limit);
        }
        if let Some(limit) = options.dfa_size_limit {
            builder.dfa_size_limit(limit);
        }
        if options.ban_nul {
            builder.ban_byte(Some(0));
        }
        builder
    }

    fn compare(patterns: &[&str], hay: &[u8], options: rg_matcher::Options, budget: usize) {
        let sources: Vec<String> = patterns.iter().map(|p| (*p).to_owned()).collect();
        let original = builder(options).build_many(patterns).unwrap();
        let mut captures = original.new_captures().unwrap();
        let mut expected = Vec::new();
        original
            .captures_iter(hay, &mut captures, |caps| {
                let found = caps.get(0).unwrap();
                expected.push((
                    rg_matcher::Match {
                        start: found.start(),
                        end: found.end(),
                    },
                    (0..caps.len())
                        .map(|i| caps.get(i).map(|m| (m.start(), m.end())))
                        .collect::<Vec<_>>(),
                ));
                true
            })
            .unwrap();
        let program = rg_matcher::Program::with_options(&sources, options).unwrap();
        let mut search = program.start(hay.to_vec(), true);
        let mut steps = 0;
        while !search.step(&program, budget) {
            steps += 1;
            assert!(
                steps < 20_000_000,
                "search stalled for {patterns:?}, {hay:?}"
            );
        }
        assert_eq!(
            search.matches(),
            expected.iter().map(|&(found, _)| found).collect::<Vec<_>>(),
            "patterns={patterns:?}, hay={hay:?}, options={options:?}"
        );
        let matches = search.take_matches();
        let actual = matches
            .iter()
            .enumerate()
            .map(|(index, &found)| {
                (
                    found,
                    (0..matches.group_count)
                        .map(|group| matches.capture(index, group))
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
        assert_eq!(search.haystack(), hay);
        assert_eq!(search.take_haystack(), hay);
    }

    #[test]
    fn differential_priority_captures_empty_and_bytes() {
        let patterns = [
            "a|ab",
            "ab|a",
            "(a|ab)(b)?",
            "(?P<x>a+)(?P<y>b*)",
            "a*?",
            "a*",
            "b*",
            "(?:a?)*",
            "((a*)*)",
            "(a?)(b?)",
            "",
            "(?:)",
            "^|$",
            "(a+)?b",
            "(a|b)*",
            "(?:ab|a)*b",
            "a.*b",
            "a.*?b",
            "[a-z]+",
            r"\b\w+\b",
            r"(?-u:\xFF+)",
            r"(?-u:.)",
            r"(é|e)+",
            r"[\p{L}\p{N}]+",
        ];
        let haystacks: &[&[u8]] = &[
            b"",
            b"a",
            b"ab",
            b"ababba",
            b"zzzz",
            b"bbb",
            b"aabbb",
            b"\xffab\xff",
            "éé a É ı İ".as_bytes(),
            b"a\r\nb\n",
            b"ab\0b",
        ];
        for pattern in patterns {
            for hay in haystacks {
                for budget in [1, 7, 1_000] {
                    compare(&[pattern], hay, rg_matcher::Options::default(), budget);
                }
            }
        }
    }

    #[test]
    fn differential_modes() {
        let options = rg_matcher::Options::default();
        for variant in [
            rg_matcher::Options {
                ignore_case: true,
                ..options
            },
            rg_matcher::Options {
                smart_case: true,
                ..options
            },
            rg_matcher::Options {
                unicode: false,
                ignore_case: true,
                ..options
            },
            rg_matcher::Options {
                whole_word: true,
                ..options
            },
            rg_matcher::Options {
                line_regexp: true,
                ..options
            },
            rg_matcher::Options {
                crlf: true,
                ..options
            },
            rg_matcher::Options {
                null_data: true,
                ..options
            },
            rg_matcher::Options {
                multiline: true,
                ..options
            },
            rg_matcher::Options {
                multiline: true,
                dotall: true,
                crlf: true,
                ..options
            },
        ] {
            for pattern in [
                "i", "s|k|i", "a|ab", "a.*b", "a.*?b", "^a", "b$", r"\w+", "(?:)",
            ] {
                let haystack = ["ı İ I i ſ K a\r\nab\nb\0a".as_bytes(), b"\xff"].concat();
                compare(&[pattern], &haystack, variant, 1);
            }
        }
        compare(&["a", "ab", "b"], b"abc ab a b", options, 1);
        compare(
            &["a.b", "i"],
            "a.b ı I".as_bytes(),
            rg_matcher::Options {
                fixed: true,
                ignore_case: true,
                ..options
            },
            1,
        );
    }

    #[test]
    fn names_empty_program_and_short_circuit() {
        let program = rg_matcher::Program::with_options(
            &["(?P<word>a+)(b)?".to_owned()],
            rg_matcher::Options::default(),
        )
        .unwrap();
        assert_eq!(program.capture_index("word"), Some(1));
        assert_eq!(program.capture_names().collect::<Vec<_>>(), [("word", 1)]);
        let mut search = program.start(b"aa ab aa".to_vec(), false);
        while !search.step(&program, 1) {}
        assert_eq!(search.matches().len(), 1);
        search.take_matches();
        search.take_haystack();
        search.reset(b"baaa".to_vec(), false);
        while !search.step(&program, 1) {}
        assert_eq!((search.matches()[0].start, search.matches()[0].end), (1, 4));
        let empty = rg_matcher::Program::with_options(&[], rg_matcher::Options::default()).unwrap();
        let mut search = empty.start(b"anything".to_vec(), true);
        while !search.step(&empty, 1) {}
        assert!(search.matches().is_empty());
    }

    #[test]
    fn backend_hints_are_conservative_and_keep_literal_word_searches() {
        for (pattern, options, expected) in [
            (
                "ada",
                rg_matcher::Options {
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["ada"], true, false)),
            ),
            (
                "ada",
                rg_matcher::Options {
                    ignore_case: true,
                    ..Default::default()
                },
                Some((vec!["ada"], false, true)),
            ),
            (
                "ada.*lovelace",
                rg_matcher::Options {
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["ada"], false, false)),
            ),
            (r"\p{Greek}+", rg_matcher::Options::default(), None),
        ] {
            let program =
                rg_matcher::Program::with_options(&[pattern.to_owned()], options).unwrap();
            let hints = program
                .required_terms
                .map(|hints| (hints.texts, hints.whole_word, hints.ignore_case));
            let expected = expected.map(|(texts, word, fold)| {
                (texts.into_iter().map(str::to_owned).collect(), word, fold)
            });
            assert_eq!(hints, expected, "{pattern}");
        }
        let program = rg_matcher::Program::with_options(
            &["a".repeat(101)],
            rg_matcher::Options {
                whole_word: true,
                ..Default::default()
            },
        )
        .unwrap();
        let hints = program.required_terms.unwrap();
        assert!(!hints.whole_word);
        assert!(hints.texts.iter().all(|text| text.len() <= 100));
        for pattern in ["fooa|barb", "foo[ab]+", "(?i:ada)", "^fooa$", "(?P<n>fooa)"] {
            let options = rg_matcher::Options::default();
            let program =
                rg_matcher::Program::with_options(&[pattern.to_owned()], options).unwrap();
            let mut search = program.start(b"fooa barb fooab ADA ada\n".to_vec(), true);
            while !search.step(&program, 1) {}
            if let Some(hints) = &program.required_terms {
                for found in search.matches() {
                    let text = &search.haystack()[found.start..found.end];
                    assert!(
                        hints.texts.iter().any(|term| {
                            text.get(..term.len()).is_some_and(|prefix| {
                                if hints.ignore_case {
                                    prefix.eq_ignore_ascii_case(term.as_bytes())
                                } else {
                                    prefix == term.as_bytes()
                                }
                            })
                        }),
                        "{pattern}"
                    );
                }
            }
        }
    }

    #[test]
    fn limits_and_refusals() {
        let options = rg_matcher::Options {
            regex_size_limit: Some(1),
            ..rg_matcher::Options::default()
        };
        let error = rg_matcher::Program::with_options(&["(a|b)*c".to_owned()], options)
            .err()
            .unwrap();
        assert_eq!(error.message, "compiled regex exceeds size limit of 1");
        compare(&["foo"], b"foo foobar", options, 1);
        let options = rg_matcher::Options {
            ban_nul: true,
            ..rg_matcher::Options::default()
        };
        let error = rg_matcher::Program::with_options(&[r"\x00".to_owned()], options)
            .err()
            .unwrap();
        assert!(error.message.contains("Consider enabling text mode"));
        let error =
            rg_matcher::Program::with_options(&[r"\n".to_owned()], rg_matcher::Options::default())
                .err()
                .unwrap();
        assert!(error.message.contains("Consider enabling multiline mode"));
    }

    #[test]
    fn differential_generated_repetitions_and_alternations() {
        let atoms = [
            "a", "b", ".", "é", "[ab]", "(?:)", "(a?)", "(?:a|ab)", "(?:ab|a)", "(?-u:.)", r"\b",
            "^", "$",
        ];
        let suffixes = ["", "?", "*", "+", "??", "*?", "+?", "{0,2}"];
        let mut state = 93_u32;
        let mut random = || {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            state as usize
        };
        for _ in 0..160 {
            let left = format!(
                "(?:{}{})",
                atoms[random() % atoms.len()],
                suffixes[random() % suffixes.len()]
            );
            let right = format!(
                "(?:{}{})",
                atoms[random() % atoms.len()],
                suffixes[random() % suffixes.len()]
            );
            for pattern in [
                format!("({left})({right})"),
                format!("{left}|{right}"),
                format!("({left}|{right})*?"),
            ] {
                for haystack in [
                    b"aababb".as_slice(),
                    b"\xffaba\x80",
                    "éab é".as_bytes(),
                    b"a\r\nb",
                ] {
                    compare(&[&pattern], haystack, rg_matcher::Options::default(), 3);
                }
            }
        }
    }

    #[test]
    fn many_empty_matches_assemble_in_order() {
        compare(
            &["(?:)"],
            &vec![b'a'; 2048],
            rg_matcher::Options::default(),
            7,
        );
    }

    #[test]
    fn flat_storage_growth_copies_one_value_per_step() {
        let mut storage = rg_matcher::Growing::new();
        for value in 0..1_000_000 {
            loop {
                let copying = storage.previous.is_some();
                let before = storage.values.len();
                if storage.push(value) {
                    assert!(!copying);
                    break;
                }
                if copying {
                    assert!(storage.values.len() - before <= 1);
                }
            }
        }
        assert_eq!(storage.take(), (0..1_000_000).collect::<Vec<_>>());
    }

    #[test]
    fn millions_of_empty_matches_keep_cleanup_flat() {
        assert!(!std::mem::needs_drop::<rg_matcher::Match>());
        assert!(!std::mem::needs_drop::<rg_matcher::Capture>());
        let program = rg_matcher::Program::with_options(
            &["(?<empty>)".to_owned()],
            rg_matcher::Options::default(),
        )
        .unwrap();
        let mut search = program.start(vec![b'a'; 1_000_000], true);
        while !search.step(&program, 4096) {}
        let mut matches = search.take_matches();
        assert_eq!(matches.len(), 1_000_001);
        assert_eq!(matches.captures.len(), 2_000_002);
        for index in [0, 500_000, 1_000_000] {
            assert_eq!(matches.capture(index, 0), Some((index, index)));
            assert_eq!(matches.capture(index, 1), Some((index, index)));
            assert_eq!(matches.capture(index, 2), None);
        }
        assert_eq!(matches.pop().unwrap().start, 1_000_000);
        drop(matches);
        search.reset(vec![b'a'; 1_000_000], true);
        while search
            .matches
            .previous
            .as_ref()
            .map_or(0, |values| values.len())
            < 524_288
        {
            assert!(!search.step(&program, 4096));
        }
        search.reset(b"x".to_vec(), true);
        while !search.step(&program, 4096) {}
        assert_eq!(search.take_matches().len(), 2);
    }

    #[test]
    fn multiline_strategy_uses_upstream_non_matching_bytes() {
        let options = rg_matcher::Options {
            multiline: true,
            ..rg_matcher::Options::default()
        };
        let line = rg_matcher::Program::with_options(&["a".to_owned()], options).unwrap();
        assert!(!line.is_multiline());
        let spanning = rg_matcher::Program::with_options(&["a\\nb".to_owned()], options).unwrap();
        assert!(spanning.is_multiline());
        let anchored = rg_matcher::Program::with_options(&[r"\Afoo".to_owned()], options).unwrap();
        assert!(anchored.is_multiline());
    }

    #[test]
    fn large_capture_rows_pause_one_slot_at_a_time() {
        let pattern = "(a?)".repeat(400);
        let program =
            rg_matcher::Program::with_options(&[pattern], rg_matcher::Options::default()).unwrap();
        let mut search = program.start(b"a".to_vec(), false);
        let mut calls = 0;
        while !search.step(&program, 1) {
            calls += 1;
            assert!(calls < 5_000_000);
        }
        assert!(calls > 400 * 400);
        assert_eq!(search.take_matches().group_count, 401);
    }
}
