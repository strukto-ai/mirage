// Ordered NFA execution adapted from regex-automata 0.4.7,
// src/nfa/thompson/pikevm.rs. Copyright (c) 2014 The Rust Project Developers.
// Licensed under MIT OR Apache-2.0. The license texts are retained in the
// repository's third-party license records.

use std::ops::Deref;

use grep_regex::{CompiledNfa, LiteralFilters, RegexMatcherBuilder};
use regex_automata::nfa::thompson::{NFA, State, WhichCaptures};
use regex_automata::util::prefilter::Prefilter;
use regex_automata::util::primitives::StateID;
use regex_automata::{PatternID, Span};
use serde::Serialize;

use crate::pcre::{self, Pcre};

use crate::StreamError;

#[derive(Clone, Copy, Debug)]
pub(crate) enum CaptureRequirement {
    WholeMatch,
    All,
}

struct SearchMemoryLimit(usize);

const SEARCH_MEMORY_LIMIT: SearchMemoryLimit = SearchMemoryLimit(64 * 1024 * 1024);

/// The backtracking steps of a -P search that weigh as much as one byte of
/// rg's work, so a search past every quick limit ends a step of it.
const PCRE_STEPS_PER_UNIT: usize = 16;

impl SearchMemoryLimit {
    fn check(&self, nfa: &NFA) -> Result<(), StreamError> {
        let states = nfa.states().len();
        let consuming = nfa
            .states()
            .iter()
            .filter(|state| {
                matches!(
                    state,
                    State::Match { .. }
                        | State::ByteRange { .. }
                        | State::Sparse(_)
                        | State::Dense(_)
                )
            })
            .count();
        let slots = nfa.group_info().slot_len();
        if Self::required_bytes(states, consuming, slots).is_some_and(|bytes| bytes <= self.0) {
            return Ok(());
        }
        Err(StreamError::new(format!(
            "regex search working memory exceeds the {} byte limit",
            self.0
        )))
    }

    fn required_bytes(states: usize, consuming: usize, slots: usize) -> Option<usize> {
        let tables = states.checked_mul(2)?.checked_mul(
            std::mem::size_of::<StateID>()
                + std::mem::size_of::<u64>()
                + std::mem::size_of::<Vec<Option<usize>>>(),
        )?;
        let captures = consuming
            .checked_add(1)?
            .checked_mul(2)?
            .checked_mul(slots)?
            .checked_mul(std::mem::size_of::<Option<usize>>())?;
        let frames = states
            .checked_mul(2)?
            .checked_mul(std::mem::size_of::<Frame>())?;
        tables.checked_add(captures)?.checked_add(frames)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Options {
    pub(crate) capture_requirement: CaptureRequirement,
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
            capture_requirement: CaptureRequirement::All,
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
    filters: LiteralFilters,
    /// -P's matcher, which searches in place of the NFA.
    pcre: Option<Box<Pcre>>,
    /// The groups each -P match records: all of them, or the whole match.
    pcre_groups: usize,
    multiline: bool,
    cr_selects: bool,
    record_context: bool,
    pub(crate) required_terms: Option<SearchHints>,
}

impl Program {
    pub(crate) fn with_options(patterns: &[String], options: Options) -> Result<Self, StreamError> {
        if patterns.is_empty() {
            return Ok(Self {
                nfa: NFA::never_match(),
                filters: LiteralFilters::default(),
                pcre: None,
                pcre_groups: 0,
                required_terms: None,
                multiline: false,
                cr_selects: false,
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
        let captures = match options.capture_requirement {
            CaptureRequirement::WholeMatch => WhichCaptures::Implicit,
            CaptureRequirement::All => WhichCaptures::All,
        };
        let CompiledNfa {
            nfa,
            non_matching_bytes: non_matching,
            lookup_terms: required_terms,
            literal_filters: filters,
        } = builder.build_nfa(patterns, captures).map_err(|err| {
            let mut message = err.to_string();
            if message.contains("the literal") && message.contains("not allowed") {
                message.push_str("\n\nUse --multiline (-U) to match newline characters.");
            }
            if message.contains("look-around")
                || message.contains("backreferences are not supported")
            {
                message.push_str("\n\nUse --pcre2 (-P) for look-around and backreferences.");
            }
            if message.contains("pattern contains \"\\0\"") {
                message.push_str("\n\nMatching NUL requires --text (-a).");
            }
            StreamError::new(message)
        })?;
        SEARCH_MEMORY_LIMIT.check(&nfa)?;
        let terminator = if options.null_data { 0 } else { b'\n' };
        let multiline = options.multiline
            && (!non_matching.contains(terminator)
                || options.null_data && !non_matching.contains(b'\n'));
        Ok(Self {
            nfa,
            filters,
            pcre: None,
            pcre_groups: 0,
            multiline,
            cr_selects: options.multiline
                && !multiline
                && options.crlf
                && !options.null_data
                && !non_matching.contains(b'\r'),
            record_context: options.multiline
                && options.null_data
                && non_matching.contains(terminator)
                && !non_matching.contains(b'\n'),
            required_terms: required_terms.and_then(|(mut texts, whole_word)| {
                let mut ignore_case = false;
                if texts.iter().all(|text| text.is_ascii()) {
                    let mut folded = Vec::new();
                    for text in &texts {
                        let text = text.to_ascii_lowercase();
                        if !folded.contains(&text) {
                            folded.push(text);
                        }
                    }
                    if folded.len() < texts.len() {
                        texts = folded;
                        ignore_case = true;
                    }
                }
                if texts.len() > 16 {
                    return None;
                }
                Some(SearchHints {
                    texts,
                    whole_word,
                    ignore_case,
                })
            }),
        })
    }

    /// rg -P's program: the list handed to PCRE2 as ripgrep hands it,
    /// `(?:a)|(?:b)`, wrapped for -w and -x, so a refusal's offset counts
    /// into that string.
    pub(crate) fn pcre(patterns: &[String], options: Options) -> Result<Self, StreamError> {
        let joined = patterns
            .iter()
            .map(|pattern| format!("(?:{pattern})"))
            .collect::<Vec<_>>()
            .join("|");
        let display = if options.line_regexp {
            format!("(?m:^)(?:{joined})(?m:$)")
        } else if options.whole_word {
            format!("(?<!\\w)(?:{joined})(?!\\w)")
        } else {
            joined
        };
        let mode = pcre::Mode {
            unicode: options.unicode,
            bytes: !options.unicode,
            ignore_case: options.ignore_case,
            multi_line: options.null_data || options.multiline,
            dotall: options.dotall,
            crlf: options.crlf && options.multiline,
            whole_line: false,
        };
        let chars = pcre::pattern_chars(display.as_bytes(), mode.bytes);
        let compiled = Pcre::new(&chars, mode).map_err(|err| {
            let offset = if mode.bytes {
                err.offset
            } else {
                chars[..err.offset.min(chars.len())]
                    .iter()
                    .map(|ch| ch.len_utf8())
                    .sum()
            };
            StreamError::new(format!(
                "PCRE2: error compiling pattern at offset {offset}: {}",
                err.message
            ))
        })?;
        let pcre_groups = match options.capture_requirement {
            CaptureRequirement::All => compiled.group_count(),
            CaptureRequirement::WholeMatch => 1,
        };
        let required_terms =
            crate::regex::perl_needles(&compiled.regular, options.ignore_case, options.unicode)
                .and_then(|needles| {
                    let texts: Vec<String> = needles
                        .into_iter()
                        .map(|needle| String::from_utf8(needle).ok().filter(|t| t.len() >= 3))
                        .collect::<Option<_>>()?;
                    (texts.len() <= 16).then_some(SearchHints {
                        texts,
                        whole_word: false,
                        ignore_case: options.ignore_case,
                    })
                });
        let record_context = options.multiline && options.null_data && !compiled.matches_nul;
        Ok(Self {
            nfa: NFA::never_match(),
            filters: LiteralFilters::default(),
            pcre: Some(Box::new(compiled)),
            pcre_groups,
            multiline: options.multiline,
            cr_selects: false,
            record_context,
            required_terms,
        })
    }

    pub(crate) fn capture_index(&self, name: &str) -> Option<usize> {
        match &self.pcre {
            Some(pcre) => pcre
                .capture_names()
                .find(|(each, _)| *each == name)
                .map(|(_, index)| index),
            None => self.nfa.group_info().to_index(PatternID::ZERO, name),
        }
    }

    pub(crate) fn is_multiline(&self) -> bool {
        self.multiline
    }

    /// Whether PCRE2 searches: -P, or --engine auto past a refusal.
    pub(crate) fn runs_pcre(&self) -> bool {
        self.pcre.is_some()
    }

    pub(crate) fn uses_record_context(&self) -> bool {
        self.record_context
    }

    /// Whether a line's final CR can select it although no rendered match
    /// reaches it, as the upstream line search keeps the CRLF it trims when
    /// printing.
    pub(crate) fn cr_selects(&self) -> bool {
        self.cr_selects
    }

    pub(crate) fn capture_names(&self) -> Box<dyn Iterator<Item = (&str, usize)> + '_> {
        match &self.pcre {
            Some(pcre) => Box::new(pcre.capture_names()),
            None => Box::new(
                self.nfa
                    .group_info()
                    .pattern_names(PatternID::ZERO)
                    .enumerate()
                    .filter_map(|(index, name)| name.map(|name| (name, index))),
            ),
        }
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
    fn new() -> Self {
        Self {
            ids: Vec::new(),
            seen: Vec::new(),
            rows: Vec::new(),
            generation: 1,
        }
    }

    fn reserve(&mut self, len: usize) {
        self.ids.reserve_exact(len);
        self.seen.reserve_exact(len);
        self.rows.reserve_exact(len);
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
    Reject { cursor: usize },
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

enum Scan {
    Hit(usize),
    Continue(usize),
    Exhausted,
    UseExact,
}

fn scan_literals(
    filter: &Prefilter,
    haystack: &[u8],
    cursor: usize,
    budget: &mut usize,
    prefix: bool,
) -> Scan {
    let longest = filter.max_needle_len();
    if *budget < longest {
        return Scan::UseExact;
    }
    let end = haystack.len().min(cursor.saturating_add(*budget));
    let found = filter.find(haystack, Span::from(cursor..end));
    let safe_end = if end == haystack.len() {
        end
    } else {
        end - (longest - 1)
    };
    if let Some(found) =
        found.filter(|found| !prefix || end == haystack.len() || found.start < safe_end)
    {
        *budget -= end.min(found.start.saturating_add(longest)) - cursor;
        return Scan::Hit(found.start);
    }
    *budget -= end - cursor;
    if end == haystack.len() {
        Scan::Exhausted
    } else {
        Scan::Continue(safe_end)
    }
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
    /// Each group of the last -P match.
    groups: Vec<Option<(usize, usize)>>,
    /// A -P search gave up at the backtracking limit.
    exceeded: bool,
}

impl Search {
    fn new(program: &Program, haystack: Vec<u8>, all: bool) -> Self {
        Self {
            haystack,
            all,
            phase: Phase::Reject { cursor: 0 },
            from: 0,
            at: 0,
            current: States::new(),
            next: States::new(),
            start_slots: Vec::new(),
            closure: None,
            frames: Vec::new(),
            candidate: Vec::new(),
            has_candidate: false,
            last_end: None,
            building: None,
            group_count: if program.pcre.is_some() {
                program.pcre_groups
            } else {
                program.nfa.group_info().group_len(PatternID::ZERO)
            },
            matches: Growing::new(),
            captures: Growing::new(),
            groups: Vec::new(),
            exceeded: false,
        }
    }

    /// Whether a -P search gave up at the backtracking limit, which ends
    /// the input with PCRE2's error.
    pub(crate) fn exceeded(&self) -> bool {
        self.exceeded
    }

    /// One -P search per step of `budget`: each match the record holds, as
    /// ripgrep iterates them (an empty match right where the last one
    /// ended is skipped, and after an empty match the search resumes one
    /// character on), or only the first unless `all`.
    fn step_pcre(&mut self, pcre: &Pcre, budget: &mut usize) -> bool {
        while *budget > 0 && !matches!(self.phase, Phase::Done) {
            *budget -= 1;
            if self.at > self.haystack.len() {
                self.phase = Phase::Done;
                break;
            }
            let (found, steps) = if self.group_count > 1 {
                let (found, steps) = pcre.captures(&self.haystack, self.at, &mut self.groups);
                let found = found
                    .map(|found| found.then(|| self.groups[0].expect("a match spans group 0")));
                (found, steps)
            } else {
                pcre.find(&self.haystack, self.at)
            };
            *budget = budget.saturating_sub(steps / PCRE_STEPS_PER_UNIT);
            let (start, end) = match found {
                Ok(Some(span)) => span,
                Ok(None) => {
                    self.phase = Phase::Done;
                    break;
                }
                Err(pcre::Exceeded) => {
                    self.exceeded = true;
                    self.phase = Phase::Done;
                    break;
                }
            };
            let from = self.at;
            self.at = if end > start {
                end
            } else {
                end + pcre.unit_len(&self.haystack, end)
            };
            *budget = budget.saturating_sub(self.at.saturating_sub(from));
            if start == end && self.last_end == Some(end) {
                continue;
            }
            self.last_end = Some(end);
            self.matches.values.push(Match { start, end });
            if self.group_count > 1 {
                self.captures.values.extend(self.groups.iter().copied());
            } else {
                self.captures.values.push(Some((start, end)));
            }
            if !self.all {
                self.phase = Phase::Done;
            }
        }
        matches!(self.phase, Phase::Done)
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
    pub(crate) fn recycle_matches(&mut self, mut matches: Matches, byte_limit: usize) {
        debug_assert!(self.matches.values.is_empty());
        debug_assert!(self.captures.values.is_empty());
        debug_assert!(self.matches.previous.is_none());
        debug_assert!(self.captures.previous.is_none());
        debug_assert_eq!(matches.group_count, self.group_count);
        let capacity = matches
            .rows
            .capacity()
            .checked_mul(std::mem::size_of::<Match>())
            .and_then(|rows| {
                matches
                    .captures
                    .capacity()
                    .checked_mul(std::mem::size_of::<Capture>())
                    .and_then(|captures| rows.checked_add(captures))
            });
        if capacity.is_some_and(|bytes| bytes <= byte_limit) {
            matches.rows.clear();
            matches.captures.clear();
            self.matches.values = matches.rows;
            self.captures.values = matches.captures;
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
        self.exceeded = false;
        self.phase = Phase::Reject { cursor: 0 };
    }

    pub(crate) fn step(&mut self, program: &Program, budget: &mut usize) -> bool {
        if let Some(pcre) = &program.pcre {
            return self.step_pcre(pcre, budget);
        }
        while *budget > 0 && !matches!(self.phase, Phase::Done) {
            *budget -= 1;
            if let Phase::Reject { cursor } = self.phase {
                self.phase = match program
                    .filters
                    .required
                    .as_ref()
                    .map(|filter| scan_literals(filter, &self.haystack, cursor, budget, false))
                {
                    Some(Scan::Exhausted) => Phase::Done,
                    Some(Scan::Continue(cursor)) => Phase::Reject { cursor },
                    _ => Phase::InitializeStates,
                };
                continue;
            }
            let prefix = program.filters.prefix.as_ref().filter(|_| {
                matches!(self.phase, Phase::Byte)
                    && self.current.ids.is_empty()
                    && !self.has_candidate
                    && !program.nfa.is_always_start_anchored()
                    && self.at <= self.haystack.len()
            });
            if let Some(filter) = prefix {
                match scan_literals(filter, &self.haystack, self.at, budget, true) {
                    Scan::Hit(at) => self.at = at,
                    Scan::Continue(at) => {
                        self.at = at;
                        continue;
                    }
                    Scan::Exhausted => {
                        self.phase = Phase::Done;
                        continue;
                    }
                    Scan::UseExact => {}
                }
            }
            self.one(program);
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
            Phase::Reject { .. } => unreachable!("literal rejection is byte-budgeted by step"),
            Phase::InitializeStates => {
                if self.current.rows.is_empty() {
                    let states = program.nfa.states().len();
                    self.current.reserve(states);
                    self.next.reserve(states);
                    let slots = program.nfa.group_info().slot_len();
                    self.start_slots.reserve_exact(slots);
                    self.candidate.reserve_exact(slots);
                    self.frames.reserve_exact(states.saturating_mul(2));
                }
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
    fn returned_matches_keep_capture_shape_and_clear_previous_rows() {
        let program = rg_matcher::Program::with_options(
            &["(a)(b)?".to_owned()],
            rg_matcher::Options::default(),
        )
        .unwrap();
        let mut search = program.start(b"ab a".to_vec(), true);
        while !search.step(&program, &mut 7) {}
        let matches = search.take_matches();
        assert_eq!(matches.group_count, 3);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches.capture(0, 2), Some((1, 2)));
        assert_eq!(matches.capture(1, 2), None);
        search.recycle_matches(matches, 96 * 1024);
        search.reset(b"a ab".to_vec(), true);
        while !search.step(&program, &mut 1) {}
        let matches = search.take_matches();
        assert_eq!(matches.group_count, 3);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches.capture(0, 0), Some((0, 1)));
        assert_eq!(matches.capture(0, 1), Some((0, 1)));
        assert_eq!(matches.capture(0, 2), None);
        assert_eq!(matches.capture(1, 0), Some((2, 4)));
        assert_eq!(matches.capture(1, 1), Some((2, 3)));
        assert_eq!(matches.capture(1, 2), Some((3, 4)));
        search.recycle_matches(matches, 0);
        assert_eq!(search.matches.values.capacity(), 0);
        assert_eq!(search.captures.values.capacity(), 0);
        search.reset(b"z".to_vec(), true);
        while !search.step(&program, &mut 1) {}
        assert!(search.take_matches().is_empty());
    }

    #[test]
    fn returned_result_storage_uses_one_combined_capacity_limit() {
        let program =
            rg_matcher::Program::with_options(&["a".to_owned()], rg_matcher::Options::default())
                .unwrap();
        let mut search = program.start(b"a".to_vec(), false);
        while !search.step(&program, &mut 7) {}
        let mut matches = search.take_matches();
        matches.rows.reserve(4096);
        matches.captures.reserve(4096);
        let rows = matches.rows.capacity() * std::mem::size_of::<rg_matcher::Match>();
        let captures = matches.captures.capacity() * std::mem::size_of::<rg_matcher::Capture>();
        let limit = rows.max(captures);
        assert!(rows + captures > limit);
        search.recycle_matches(matches, limit);
        assert_eq!(search.matches.values.capacity(), 0);
        assert_eq!(search.captures.values.capacity(), 0);
    }

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
        let group_limit = match options.capture_requirement {
            rg_matcher::CaptureRequirement::WholeMatch => 1,
            rg_matcher::CaptureRequirement::All => usize::MAX,
        };
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
                    (0..caps.len().min(group_limit))
                        .map(|i| caps.get(i).map(|m| (m.start(), m.end())))
                        .collect::<Vec<_>>(),
                ));
                true
            })
            .unwrap();
        for disabled in [false, true] {
            let mut program = rg_matcher::Program::with_options(&sources, options).unwrap();
            if disabled {
                program.filters = grep_regex::LiteralFilters::default();
            }
            let mut search = program.start(hay.to_vec(), true);
            let mut steps = 0;
            while !search.step(&program, &mut { budget }) {
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
    }

    #[test]
    fn literal_filters_preserve_exact_search_across_windows() {
        let haystacks = [
            b"xxxabcdef b\n".to_vec(),
            [vec![b'x'; 16_381], b"abcdef b".to_vec()].concat(),
            b"event=123 user=user_0042 status=fail\nevent=456 status=ok\n".repeat(3),
            b"user=user_0001 status=fail\n".repeat(128),
            "needle é É K kneedle Kneedle\r\nfoo\r".as_bytes().to_vec(),
            b"\xffneedle\0needle\n".to_vec(),
            Vec::new(),
        ];
        for pattern in [
            "abcdef|b",
            "(abcdef|b)(x)?",
            r"event=[0-9]+.*status=fail",
            r"user=(user_[0-9]+).*status=fail",
            r"status=fail[^\n]*\nevent=",
            r"\b(needle)\b",
            r"(?-u:\xFF)needle",
            r"(?i:K|k)needle",
            r"^foo(?:bar)?$",
            r"(?:needle|)",
            r"\r",
        ] {
            for hay in &haystacks {
                for budget in [1, 7, 17, 16_384] {
                    compare(
                        &[pattern],
                        hay,
                        rg_matcher::Options {
                            multiline: true,
                            crlf: true,
                            ..rg_matcher::Options::default()
                        },
                        budget,
                    );
                }
            }
        }
    }

    #[test]
    fn prefix_scan_defers_hits_in_the_overlap_fringe() {
        let filter = regex_automata::util::prefilter::Prefilter::new(
            regex_automata::MatchKind::LeftmostFirst,
            &["abcdef", "b"],
        )
        .unwrap();
        let mut cursor = 0;
        loop {
            let mut budget = 6;
            match rg_matcher::scan_literals(&filter, b"xxxabcdef", cursor, &mut budget, true) {
                rg_matcher::Scan::Continue(next) => {
                    assert!(next > cursor);
                    cursor = next;
                }
                rg_matcher::Scan::Hit(at) => {
                    assert_eq!(at, 3);
                    break;
                }
                _ => panic!("the full prefix must remain reachable"),
            }
        }
    }

    #[test]
    fn short_poll_keeps_prefix_scanning_available_to_later_polls() {
        let program = rg_matcher::Program::with_options(
            &["needle".to_owned()],
            rg_matcher::Options::default(),
        )
        .unwrap();
        let mut haystack = vec![b'x'; 2 * 1024 * 1024];
        let start = haystack.len();
        haystack.extend_from_slice(b"needle");
        let mut search = program.start(haystack, true);
        let mut calls = 0;
        while !matches!(search.phase, rg_matcher::Phase::Byte) {
            assert!(!search.step(&program, &mut 1));
            calls += 1;
            assert!(calls < 100);
        }
        assert!(!search.step(&program, &mut 1));
        calls = 0;
        while !search.step(&program, &mut 16_384) {
            calls += 1;
            assert!(calls < 256, "later polls needed {calls} calls");
        }
        assert_eq!(
            search.matches(),
            [rg_matcher::Match {
                start,
                end: start + 6
            }]
        );
    }

    #[test]
    fn required_scan_is_bounded_and_precedes_scratch_initialization() {
        let program = rg_matcher::Program::with_options(
            &[r"event=[0-9]+.*status=fail".to_owned()],
            rg_matcher::Options::default(),
        )
        .unwrap();
        let filter = program.filters.required.as_ref().unwrap();
        assert_eq!(filter.max_needle_len(), b"status=fail".len());
        assert!(
            filter
                .find(b"event=1 status=ok", regex_automata::Span::from(0..17))
                .is_none()
        );
        let mut search = program.start(vec![b'x'; 128 * 1024], true);
        let mut polls = 0;
        loop {
            let mut budget = 16_384;
            let complete = search.step(&program, &mut budget);
            polls += 1;
            assert!(polls < 20);
            assert!(search.current.rows.is_empty());
            assert_eq!(search.current.rows.capacity(), 0);
            if complete {
                assert!(search.matches().is_empty());
                assert!(search.step(&program, &mut 0));
                break;
            }
            assert_eq!(budget, 0);
        }
        assert!(polls > 1);
        search.reset(b"event=1 status=fail".to_vec(), true);
        let mut budget = 16_384;
        assert!(search.step(&program, &mut budget));
        assert!(budget > 0);
        assert_eq!(search.matches().len(), 1);
    }

    #[test]
    fn optional_filters_respect_remaining_compilation_memory() {
        let mut accepted = 0;
        for pattern in ["needle", "abcdef|b", "(a|aa)+b?", r"(?i:needle)", ".*"] {
            for limit in [128, 1024, 4096, 64 * 1024, 1024 * 1024] {
                let Ok(program) = rg_matcher::Program::with_options(
                    &[pattern.to_owned()],
                    rg_matcher::Options {
                        regex_size_limit: Some(limit),
                        ..rg_matcher::Options::default()
                    },
                ) else {
                    continue;
                };
                accepted += 1;
                let bytes: usize = [&program.filters.prefix, &program.filters.required]
                    .into_iter()
                    .flatten()
                    .map(|filter| filter.memory_usage())
                    .sum();
                assert!(bytes <= 64 * 1024);
                assert!(bytes <= limit.saturating_sub(program.nfa.memory_usage()));
            }
        }
        assert!(accepted > 5);
    }

    #[test]
    fn hard_exact_search_remains_cooperative_when_required_literals_occur() {
        for multiline in [false, true] {
            let mut alternatives = (1..=16).map(|len| "a".repeat(len)).collect::<Vec<_>>();
            if multiline {
                alternatives.push(r"\n".to_owned());
            }
            let pattern = format!("^({})+b?$", alternatives.join("|"));
            let program = rg_matcher::Program::with_options(
                &[pattern],
                rg_matcher::Options {
                    multiline,
                    ..rg_matcher::Options::default()
                },
            )
            .unwrap();
            let haystack = [vec![b'a'; 4096], b"!\n".to_vec()].concat();
            let mut search = program.start(haystack, true);
            let mut budget = 16_384;
            assert!(!search.step(&program, &mut budget));
            assert_eq!(budget, 0);
            assert!(!search.current.rows.is_empty());
            while !search.step(&program, &mut 16_384) {}
            assert!(search.matches().is_empty());
        }
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
    fn differential_whole_match_compilation_preserves_priority() {
        for pattern in [
            "(a|ab)",
            "((a*)*)",
            "(a+)?b",
            "(?<letter>a|ab)(b)?",
            "(a?)(b?)",
            "(a|b)*",
            "(é|e)+",
        ] {
            for haystack in [b"".as_slice(), b"aab ab bba", "ééa e".as_bytes()] {
                for budget in [1, 17] {
                    compare(
                        &[pattern],
                        haystack,
                        rg_matcher::Options {
                            capture_requirement: rg_matcher::CaptureRequirement::WholeMatch,
                            ..rg_matcher::Options::default()
                        },
                        budget,
                    );
                }
            }
        }
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
        while !search.step(&program, &mut 1) {}
        assert_eq!(search.matches().len(), 1);
        search.take_matches();
        search.take_haystack();
        search.reset(b"baaa".to_vec(), false);
        while !search.step(&program, &mut 1) {}
        assert_eq!((search.matches()[0].start, search.matches()[0].end), (1, 4));
        let empty = rg_matcher::Program::with_options(&[], rg_matcher::Options::default()).unwrap();
        let mut search = empty.start(b"anything".to_vec(), true);
        while !search.step(&empty, &mut 1) {}
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
                    line_regexp: true,
                    ..Default::default()
                },
                Some((vec!["ada"], true, false)),
            ),
            (
                "ada",
                rg_matcher::Options {
                    whole_word: true,
                    line_regexp: true,
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
            (
                "alpha|bravo",
                rg_matcher::Options {
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["alpha", "bravo"], true, false)),
            ),
            (
                "xy",
                rg_matcher::Options {
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["xy"], true, false)),
            ),
            (
                "a|b",
                rg_matcher::Options {
                    line_regexp: true,
                    ..Default::default()
                },
                Some((vec!["a", "b"], true, false)),
            ),
            (
                "xy+",
                rg_matcher::Options {
                    whole_word: true,
                    ..Default::default()
                },
                None,
            ),
            ("xy", rg_matcher::Options::default(), None),
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
            while !search.step(&program, &mut 1) {}
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
    fn caseless_backend_hints_collapse_before_the_query_limit() {
        for (pattern, options, expected) in [
            (
                "alpha",
                rg_matcher::Options {
                    ignore_case: true,
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["alpha"], true)),
            ),
            (
                "alpha",
                rg_matcher::Options {
                    smart_case: true,
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["alpha"], true)),
            ),
            (
                "(?i:alpha)",
                rg_matcher::Options {
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["alpha"], true)),
            ),
            (
                "foobar",
                rg_matcher::Options {
                    ignore_case: true,
                    line_regexp: true,
                    ..Default::default()
                },
                Some((vec!["foobar"], true)),
            ),
            (
                "alpha.*bravo",
                rg_matcher::Options {
                    ignore_case: true,
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["alpha"], false)),
            ),
            (
                "alpha|bravo",
                rg_matcher::Options {
                    ignore_case: true,
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["alpha", "bravo"], true)),
            ),
            (
                "(?i:alpha)|bravo",
                rg_matcher::Options {
                    whole_word: true,
                    ..Default::default()
                },
                Some((vec!["alpha", "bravo"], true)),
            ),
            (
                "(?i:kilo)",
                rg_matcher::Options {
                    whole_word: true,
                    ..Default::default()
                },
                None,
            ),
            ("[ab]{5}", rg_matcher::Options::default(), None),
        ] {
            let program =
                rg_matcher::Program::with_options(&[pattern.to_owned()], options).unwrap();
            let hints = program
                .required_terms
                .map(|hints| (hints.texts, hints.whole_word, hints.ignore_case));
            let expected = expected
                .map(|(texts, word)| (texts.into_iter().map(str::to_owned).collect(), word, true));
            assert_eq!(hints, expected, "{pattern}");
        }
        let program = rg_matcher::Program::with_options(
            &["a".repeat(101)],
            rg_matcher::Options {
                ignore_case: true,
                whole_word: true,
                ..Default::default()
            },
        )
        .unwrap();
        let hints = program.required_terms.unwrap();
        assert!(!hints.whole_word);
        assert!(hints.ignore_case);
        assert!(hints.texts.iter().all(|text| text.len() < 101));
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
        assert!(error.message.contains("--text"));
        let error =
            rg_matcher::Program::with_options(&[r"\n".to_owned()], rg_matcher::Options::default())
                .err()
                .unwrap();
        assert!(error.message.contains("--multiline"));
        let error = rg_matcher::Program::with_options(
            &["(?=a)".to_owned()],
            rg_matcher::Options::default(),
        )
        .err()
        .unwrap();
        assert!(error.message.contains("--pcre2"));
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
        while !search.step(&program, &mut 4096) {}
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
            assert!(!search.step(&program, &mut 4096));
        }
        search.reset(b"x".to_vec(), true);
        while !search.step(&program, &mut 4096) {}
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
    fn crlf_line_search_selects_through_the_cr_it_trims() {
        let crlf = rg_matcher::Options {
            multiline: true,
            crlf: true,
            ..rg_matcher::Options::default()
        };
        let program = |pattern: &str, options| {
            rg_matcher::Program::with_options(&[pattern.to_owned()], options).unwrap()
        };
        assert!(program(r"\r", crlf).cr_selects());
        assert!(program(r"a\r", crlf).cr_selects());
        assert!(!program("a", crlf).cr_selects());
        assert!(!program(r"a\r?\nb", crlf).cr_selects());
        let plain = rg_matcher::Options {
            multiline: true,
            ..rg_matcher::Options::default()
        };
        assert!(!program(r"\r", plain).cr_selects());
    }

    #[test]
    fn large_capture_rows_pause_one_slot_at_a_time() {
        let pattern = "(a?)".repeat(400);
        let program =
            rg_matcher::Program::with_options(&[pattern], rg_matcher::Options::default()).unwrap();
        let mut search = program.start(b"a".to_vec(), false);
        let mut calls = 0;
        while !search.step(&program, &mut 1) {
            calls += 1;
            assert!(calls < 5_000_000);
        }
        assert!(calls > 400 * 400);
        assert_eq!(search.take_matches().group_count, 401);
    }

    #[test]
    fn whole_match_search_discards_ten_thousand_explicit_capture_slots() {
        let program = rg_matcher::Program::with_options(
            &["(a)".repeat(10_000)],
            rg_matcher::Options {
                capture_requirement: rg_matcher::CaptureRequirement::WholeMatch,
                ..rg_matcher::Options::default()
            },
        )
        .unwrap();
        assert_eq!(program.nfa.group_info().slot_len(), 2);
        assert!(
            rg_matcher::SearchMemoryLimit::required_bytes(
                program.nfa.states().len(),
                program.nfa.states().len(),
                program.nfa.group_info().slot_len(),
            )
            .unwrap()
                < 4 * 1024 * 1024
        );
    }

    #[test]
    fn capture_scratch_limit_checks_the_complete_product_before_searching() {
        let program = rg_matcher::Program::with_options(
            &["(a?)".repeat(400)],
            rg_matcher::Options::default(),
        )
        .unwrap();
        let states = program.nfa.states().len();
        let consuming = program
            .nfa
            .states()
            .iter()
            .filter(|state| {
                matches!(
                    state,
                    regex_automata::nfa::thompson::State::Match { .. }
                        | regex_automata::nfa::thompson::State::ByteRange { .. }
                        | regex_automata::nfa::thompson::State::Sparse(_)
                        | regex_automata::nfa::thompson::State::Dense(_)
                )
            })
            .count();
        let required = rg_matcher::SearchMemoryLimit::required_bytes(
            states,
            consuming,
            program.nfa.group_info().slot_len(),
        )
        .unwrap();
        assert!(
            rg_matcher::SearchMemoryLimit(required)
                .check(&program.nfa)
                .is_ok()
        );
        assert!(
            rg_matcher::SearchMemoryLimit(required - 1)
                .check(&program.nfa)
                .is_err()
        );
        assert!(rg_matcher::SearchMemoryLimit::required_bytes(usize::MAX, 1, 2).is_none());
        assert!(rg_matcher::SearchMemoryLimit::required_bytes(1, usize::MAX, 2).is_none());
        assert!(rg_matcher::SearchMemoryLimit::required_bytes(1, 1, usize::MAX).is_none());
        let error = rg_matcher::Program::with_options(
            &["(a)".repeat(10_000)],
            rg_matcher::Options::default(),
        )
        .err()
        .unwrap();
        assert!(error.message.contains("regex search working memory"));
    }
}
