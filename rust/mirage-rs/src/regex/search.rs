use regex_automata::hybrid::{LazyStateID, dfa};
use regex_automata::nfa::thompson::{self, WhichCaptures};
use regex_automata::util::look::LookMatcher;
use regex_automata::{Anchored, Input, MatchKind};
use regex_syntax::hir::Hir;

use super::{RecordScan, Step, parse::TOO_BIG, splits_char};

pub(super) struct Automata {
    first: (dfa::DFA, dfa::Cache),
    reverse: (dfa::DFA, dfa::Cache),
    pub(super) longest: Option<(dfa::DFA, dfa::Cache)>,
    nonempty: bool,
    cursor: Option<Search>,
}

#[derive(Clone, Copy)]
enum Phase {
    First,
    Reverse { end: usize },
    Longest { start: usize, end: usize },
}

struct Search {
    phase: Phase,
    scan: Scan,
    from: usize,
}

struct Scan {
    state: Option<LazyStateID>,
    at: usize,
    found: Option<usize>,
}

impl Scan {
    fn new(at: usize) -> Scan {
        Scan {
            state: None,
            at,
            found: None,
        }
    }

    fn run(
        &mut self,
        automaton: &mut (dfa::DFA, dfa::Cache),
        input: &Input<'_>,
        reverse: bool,
        budget: &mut u64,
    ) -> Result<Step<Option<usize>>, ()> {
        let (dfa, cache) = automaton;
        let mut state = match self.state {
            Some(state) => state,
            None => if reverse {
                dfa.start_state_reverse(cache, input)
            } else {
                dfa.start_state_forward(cache, input)
            }
            .map_err(|_| ())?,
        };
        loop {
            if *budget == 0 {
                self.state = Some(state);
                return Ok(Step::Paused);
            }
            *budget -= 1;
            let edge = if reverse {
                self.at == input.start()
            } else {
                self.at == input.end()
            };
            let byte = if reverse {
                self.at
                    .checked_sub(1)
                    .and_then(|at| input.haystack().get(at))
                    .copied()
            } else {
                input.haystack().get(self.at).copied()
            };
            state = match byte {
                Some(byte) => dfa.next_state(cache, state, byte),
                None => dfa.next_eoi_state(cache, state),
            }
            .map_err(|_| ())?;
            if state.is_quit() {
                return Err(());
            }
            if state.is_match() {
                self.found = Some(self.at);
            }
            if edge || state.is_dead() {
                return Ok(Step::Done(self.found));
            }
            if reverse {
                self.at -= 1;
            } else {
                self.at += 1;
            }
        }
    }
}

impl Automata {
    pub(super) fn new(hir: &Hir, terminator: u8) -> Result<Automata, &'static str> {
        let mut looks = LookMatcher::new();
        looks.set_line_terminator(terminator);
        let config = thompson::Config::new()
            .utf8(false)
            .which_captures(WhichCaptures::None)
            .look_matcher(looks);
        let nfa = thompson::Compiler::new()
            .configure(config.clone())
            .build_from_hir(hir)
            .map_err(|_| TOO_BIG)?;
        let first = dfa::DFA::builder()
            .configure(dfa::Config::new().match_kind(MatchKind::LeftmostFirst))
            .build_from_nfa(nfa.clone())
            .map_err(|_| TOO_BIG)?;
        let longest = dfa::DFA::builder()
            .configure(dfa::Config::new().match_kind(MatchKind::All))
            .build_from_nfa(nfa)
            .map_err(|_| TOO_BIG)?;
        let reverse_nfa = thompson::Compiler::new()
            .configure(config.reverse(true))
            .build_from_hir(hir)
            .map_err(|_| TOO_BIG)?;
        let reverse = dfa::DFA::builder()
            .configure(dfa::Config::new().match_kind(MatchKind::All))
            .build_from_nfa(reverse_nfa)
            .map_err(|_| TOO_BIG)?;
        Ok(Automata {
            first: {
                let cache = first.create_cache();
                (first, cache)
            },
            reverse: {
                let cache = reverse.create_cache();
                (reverse, cache)
            },
            longest: Some({
                let cache = longest.create_cache();
                (longest, cache)
            }),
            nonempty: hir.properties().minimum_len().is_some_and(|n| n > 0),
            cursor: None,
        })
    }

    pub(super) fn reset(&mut self) {
        self.cursor = None;
    }

    pub(super) fn record_scanner(&self) -> Option<RecordScan> {
        if !self.nonempty {
            return None;
        }
        let dfa = self.longest.as_ref()?.0.clone();
        let cache = dfa.create_cache();
        Some(RecordScan {
            dfa,
            cache,
            state: None,
            at: 0,
            anchored: false,
        })
    }

    pub(super) fn find(
        &mut self,
        hay: &[u8],
        from: usize,
        utf8: bool,
        budget: &mut u64,
    ) -> Result<Step<Option<(usize, usize)>>, ()> {
        if from > hay.len() {
            return Ok(Step::Done(None));
        }
        let mut search = self.cursor.take().unwrap_or(Search {
            phase: Phase::First,
            scan: Scan::new(from),
            from,
        });
        loop {
            let (automaton, input, reverse) = match search.phase {
                Phase::First => (
                    &mut self.first,
                    Input::new(hay).span(search.from..hay.len()),
                    false,
                ),
                Phase::Reverse { end } => (
                    &mut self.reverse,
                    Input::new(hay)
                        .span(search.from..end)
                        .anchored(Anchored::Yes),
                    true,
                ),
                Phase::Longest { start, .. } => (
                    self.longest.as_mut().ok_or(())?,
                    Input::new(hay)
                        .span(start..hay.len())
                        .anchored(Anchored::Yes),
                    false,
                ),
            };
            let found = match search.scan.run(automaton, &input, reverse, budget)? {
                Step::Paused => {
                    self.cursor = Some(search);
                    return Ok(Step::Paused);
                }
                Step::Done(found) => found,
            };
            match search.phase {
                Phase::First => {
                    let Some(end) = found else {
                        return Ok(Step::Done(None));
                    };
                    search.phase = Phase::Reverse { end };
                    search.scan = Scan::new(end);
                }
                Phase::Reverse { end } => {
                    let start = found.ok_or(())?;
                    if utf8 && start == end && splits_char(hay, start) {
                        search.from = start + 1;
                        search.phase = Phase::First;
                        search.scan = Scan::new(search.from);
                    } else {
                        search.phase = Phase::Longest { start, end };
                        search.scan = Scan::new(start);
                    }
                }
                Phase::Longest { start, end } => {
                    return Ok(Step::Done(Some((start, found.unwrap_or(end).max(end)))));
                }
            }
        }
    }
}
