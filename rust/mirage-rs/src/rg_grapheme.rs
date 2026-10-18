// Forward grapheme processing and DFA data adapted from bstr 1.10.0.
// https://github.com/BurntSushi/bstr/tree/1.10.0/src/unicode
// Licensed under MIT. See licenses/third_party/ripgrep.txt.
use std::sync::OnceLock;

use regex_automata::dfa::{Automaton, sparse::DFA};
use regex_automata::util::primitives::StateID;
use regex_automata::{Anchored, Input};

/// The forward grapheme DFA is from bstr 1.10.0, which ripgrep 14.1.1 pins.
/// Its MIT copyright and license notice accompanies the serialized tables.
fn dfa() -> &'static DFA<&'static [u8]> {
    static DFA: OnceLock<DFA<&'static [u8]>> = OnceLock::new();
    DFA.get_or_init(|| {
        #[cfg(target_endian = "little")]
        let bytes = include_bytes!("generated/rg_grapheme.littleendian.dfa").as_slice();
        #[cfg(target_endian = "big")]
        let bytes = include_bytes!("generated/rg_grapheme.bigendian.dfa").as_slice();
        regex_automata::dfa::sparse::DFA::from_bytes(bytes)
            .expect("valid grapheme DFA")
            .0
    })
}

pub(crate) struct Grapheme {
    start: usize,
    at: usize,
    end: usize,
    state: StateID,
    matched: Option<usize>,
    done: bool,
}

impl Grapheme {
    pub(crate) fn new(bytes: &[u8], start: usize, end: usize) -> Self {
        let input = Input::new(&bytes[start..end]).anchored(Anchored::Yes);
        let state = dfa()
            .start_state_forward(&input)
            .expect("grapheme DFA starts");
        Self {
            start,
            at: start,
            end,
            state,
            matched: None,
            done: false,
        }
    }

    pub(crate) fn step(&mut self, bytes: &[u8], budget: &mut usize) -> Option<usize> {
        if self.done {
            return self.matched;
        }
        let dfa = dfa();
        while self.at < self.end && *budget > 0 {
            self.state = dfa.next_state(self.state, bytes[self.at]);
            *budget -= 1;
            if dfa.is_match_state(self.state) {
                self.matched = Some(self.at);
            }
            if dfa.is_dead_state(self.state) {
                return Some(self.finish(bytes));
            }
            self.at += 1;
        }
        if self.at == self.end && *budget > 0 {
            self.state = dfa.next_eoi_state(self.state);
            *budget -= 1;
            if dfa.is_match_state(self.state) {
                self.matched = Some(self.end);
            }
            return Some(self.finish(bytes));
        }
        None
    }

    fn finish(&mut self, bytes: &[u8]) -> usize {
        self.done = true;
        let end = self.matched.unwrap_or_else(|| {
            let piece = &bytes[self.start..self.end.min(self.start + 4)];
            let len = match std::str::from_utf8(piece) {
                Ok(text) => text.chars().next().map_or(0, char::len_utf8),
                Err(error) if error.valid_up_to() > 0 => error.valid_up_to(),
                Err(error) => error.error_len().unwrap_or(piece.len()),
            };
            self.start + len.max(1)
        });
        self.matched = Some(end);
        end
    }
}

#[cfg(test)]
mod tests {
    use super::Grapheme;

    #[test]
    fn resumes_inside_one_combining_cluster() {
        let bytes = "e\u{301}\u{301}x".as_bytes();
        let mut cursor = Grapheme::new(bytes, 0, bytes.len());
        let end = loop {
            if let Some(end) = cursor.step(bytes, &mut 1) {
                break end;
            }
        };
        assert_eq!(end, 5);
    }

    #[test]
    fn invalid_sequences_consume_the_same_bytes_as_the_reference() {
        let bytes = &[0xe2, 0x82, b'x'];
        let mut cursor = Grapheme::new(bytes, 0, bytes.len());
        assert_eq!(cursor.step(bytes, &mut 100), Some(2));
    }
}
