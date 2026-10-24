use regex_automata::{Anchored, Input};

use super::backtrack::{Program, Scratch, Shape, unit_at};
use super::hir::Lower;
use super::parse::{self, Ast, Dialect, Unit};
use super::{Automata, Step, has_raw_byte};

pub(crate) struct Options {
    pub(crate) extended: bool,
    pub(crate) dialect: Dialect,
    pub(crate) ignore_case: bool,
    pub(crate) utf8: bool,
    /// sed's `M`: `^` and `$` match at each line's edges, and neither `.`
    /// nor a negated set matches a newline.
    pub(crate) multiline: bool,
    /// git grep's -w: no word character on either side of the match.
    pub(crate) word: bool,
}

/// Where a match and each of its groups lie, the whole match first; None
/// for a group that took no part in it.
pub(crate) type Spans = Vec<Option<(usize, usize)>>;

/// One POSIX expression over a whole subject, as regexec answers it: the
/// leftmost match and the longest there, its groups placed by the first
/// way of matching that text, trying a repetition's longer counts and an
/// alternation's earlier branches first, and never an iteration of `*`,
/// `+` or `{m,}` that consumes nothing. An optional iteration of `{m,n}`
/// may consume nothing, where regexec takes one through an empty branch
/// but not one that ends on an anchor (`(a|b|$){1,3}` against `ab`).
pub(crate) struct Posix {
    /// The text a pattern of literal units alone spells, found by a
    /// substring search: a long fixed interval (`a\{32767\}`) makes an
    /// automaton too large to run fast.
    literal: Option<Vec<u8>>,
    automata: Option<Automata>,
    program: Program,
    /// The program `test` runs when it reads the pattern otherwise: a
    /// search that asks for no groups lets each `$` read a newline the
    /// match consumes, in a pattern with groups too, unless a
    /// back-reference needs them.
    tester: Option<Program>,
    backrefs: bool,
    groups: usize,
    scratch: Scratch,
    utf8: bool,
    /// The bytes a match can start with, which a backward search alone
    /// tries; found on its first call.
    starts: Option<[bool; 256]>,
    /// The place whose backtracked attempt ran out of steps.
    suspended: Option<usize>,
}

impl Posix {
    pub(crate) fn compile(pattern: &[u8], options: &Options) -> Result<Posix, &'static str> {
        let parsed = parse::parse(pattern, options.extended, options.utf8, options.dialect)?;
        Self::build(&parsed.ast, parsed.groups, options)
    }

    fn build(ast: &Ast, groups: usize, options: &Options) -> Result<Posix, &'static str> {
        let unicode_words = options.utf8 && options.dialect != Dialect::Grep;
        let shape = Shape {
            ignore_case: options.ignore_case,
            utf8: options.utf8,
            multiline: options.multiline,
            unicode_words,
            // awk's anchors hold at the subject's edges alone.
            consumed_newlines: !matches!(options.dialect, Dialect::Grep | Dialect::Awk)
                && !options.multiline,
            dot_skips_nul: options.dialect == Dialect::Posix,
        };
        // Placing groups, regexec holds every `$` of a pattern that has
        // any to the end of the subject: `b$.` matches across a line,
        // `(b$.)` and `b$.(a)` do not, unless only a yes or no is asked
        // and no back-reference reads a group (`(b)$.\1` never does).
        let backrefs = ast.has_backref();
        let crossing = groups > 0 && shape.consumed_newlines && !ast.anchors_at_edges();
        let held = crossing.then(|| ast.held_ends()).filter(|held| held != ast);
        let program = Program::new(held.as_ref().unwrap_or(ast), options.word, false, shape)?;
        let tester = match held {
            Some(_) if !backrefs => Some(Program::new(ast, options.word, false, shape)?),
            _ => None,
        };
        // The automata know ASCII's word characters only, match a stray
        // byte inside a character, and read an anchor by the subject alone.
        let automata = if backrefs
            || (options.utf8
                && (has_raw_byte(ast) || (unicode_words && (options.word || ast.has_word_look()))))
            || (shape.consumed_newlines && !ast.anchors_at_edges())
        {
            None
        } else {
            let lower = Lower {
                ignore_case: options.ignore_case,
                utf8: options.utf8,
                terminator: None,
                multiline: options.multiline,
                dot_skips_nul: shape.dot_skips_nul,
            };
            Some(Automata::new(
                &[lower.pattern(ast, options.word, false)],
                b'\n',
                true,
            )?)
        };
        // A raw byte under UTF-8 could be found inside a character, where
        // the matcher never looks.
        let literal = if options.ignore_case || options.word || (options.utf8 && has_raw_byte(ast))
        {
            None
        } else {
            fixed_text(ast).filter(|text| !text.is_empty())
        };
        Ok(Posix {
            literal,
            automata,
            program,
            tester,
            backrefs,
            groups,
            scratch: Scratch::default(),
            utf8: options.utf8,
            starts: None,
            suspended: None,
        })
    }

    pub(crate) fn groups(&self) -> usize {
        self.groups
    }

    /// Gives back what the last search grew past a small reserve.
    pub(crate) fn release(&mut self) {
        self.scratch.trim();
    }

    /// Where the leftmost-longest match at or after `at` lies.
    fn extent(&mut self, hay: &[u8], at: usize) -> Option<(usize, usize)> {
        let end = hay.len();
        if let Some(literal) = &self.literal {
            let found = memchr::memmem::find(hay.get(at..)?, literal)?;
            return Some((at + found, at + found + literal.len()));
        }
        if let Some(automata) = &mut self.automata {
            let (start, first_end) = automata.first(hay, at, end, self.utf8)?;
            if let Some(stop) = automata.longest_end(hay, start, end) {
                return Some((start, stop.max(first_end)));
            }
            return self.longest_at(hay, start).or(Some((start, first_end)));
        }
        self.longest_at(hay, at)
    }

    fn longest_at(&mut self, hay: &[u8], at: usize) -> Option<(usize, usize)> {
        let mut budget = u64::MAX;
        match self
            .program
            .find(hay, 0, hay.len(), at, true, &mut self.scratch, &mut budget)
        {
            Step::Done(found) => found,
            Step::Paused => None,
        }
    }

    /// The leftmost-longest match at or after `at`, a unit boundary.
    pub(crate) fn search(&mut self, hay: &[u8], at: usize) -> Option<Spans> {
        let (start, stop) = self.extent(hay, at)?;
        let mut budget = u64::MAX;
        let registers = self.program.captures(
            hay,
            0,
            hay.len(),
            start,
            stop,
            self.backrefs,
            &mut self.scratch,
            &mut budget,
        );
        let mut spans: Spans = vec![None; self.groups + 1];
        spans[0] = Some((start, stop));
        if let Some(registers) = registers {
            for (group, span) in spans.iter_mut().enumerate().skip(1) {
                if let (Some(from), Some(to)) = (
                    registers.get(2 * group).copied().flatten(),
                    registers.get(2 * group + 1).copied().flatten(),
                ) {
                    *span = Some((from, to.max(from)));
                }
            }
        }
        Some(spans)
    }

    /// Where the leftmost-longest match at or after `at` lies, its groups
    /// left unplaced.
    pub(crate) fn find(&mut self, hay: &[u8], at: usize) -> Option<(usize, usize)> {
        self.extent(hay, at)
    }

    /// The latest place in `from..to` a match starts, tried from `to`
    /// down, and where the longest match there ends, `hay` being the
    /// whole subject: tac's backward search. Each place tried and each
    /// step of a backtracked attempt spends `budget`; out of it, `Err`
    /// holds the place below which none has been, and an attempt cut short
    /// goes on where it stopped on the next call.
    pub(crate) fn latest(
        &mut self,
        hay: &[u8],
        from: usize,
        to: usize,
        budget: &mut u64,
    ) -> Result<Option<(usize, usize)>, usize> {
        if let Some(literal) = &self.literal {
            let stop = (to + literal.len() - 1).min(hay.len());
            let found = memchr::memmem::rfind(&hay[from..stop], literal);
            return Ok(found.map(|at| (from + at, from + at + literal.len())));
        }
        let starts = *self
            .starts
            .get_or_insert_with(|| first_bytes(&mut self.automata));
        let mut below = to;
        while let Some(at) = hay[from..below]
            .iter()
            .rposition(|&b| starts[usize::from(b)])
        {
            if *budget == 0 {
                return Err(below);
            }
            *budget -= 1;
            let place = from + at;
            if self.utf8 && super::splits_char(hay, place) {
                below = place;
                continue;
            }
            let resume = self.suspended.take() == Some(place);
            match self.anchored(hay, place, resume, budget) {
                Step::Paused => {
                    self.suspended = Some(place);
                    return Err(place + 1);
                }
                Step::Done(Some(stop)) => return Ok(Some((place, stop))),
                Step::Done(None) => below = place,
            }
        }
        Ok(None)
    }

    /// Where the longest match that starts at `at` ends.
    fn anchored(
        &mut self,
        hay: &[u8],
        at: usize,
        resume: bool,
        budget: &mut u64,
    ) -> Step<Option<usize>> {
        let automaton = self.automata.as_mut().and_then(|a| a.longest.as_mut());
        if let Some((dfa, cache)) = automaton.filter(|_| !resume) {
            let input = Input::new(hay).span(at..hay.len()).anchored(Anchored::Yes);
            if let Ok(found) = dfa.try_search_fwd(cache, &input) {
                return Step::Done(found.map(|end| end.offset()));
            }
        }
        self.program
            .longest_from(hay, at, resume, &mut self.scratch, budget)
    }

    /// Whether the pattern matches anywhere in `hay`, as sed's addresses
    /// ask.
    pub(crate) fn test(&mut self, hay: &[u8]) -> bool {
        let Some(tester) = &self.tester else {
            return self.extent(hay, 0).is_some();
        };
        let mut budget = u64::MAX;
        let found = tester.find(hay, 0, hay.len(), 0, false, &mut self.scratch, &mut budget);
        matches!(found, Step::Done(Some(_)))
    }

    /// Every match a global substitution replaces, as sed walks them: each
    /// search starts where the last match ended, an empty match right
    /// where one ended is passed over, and past an empty match the next
    /// search starts one unit on.
    pub(crate) fn all(&mut self, hay: &[u8]) -> Vec<Spans> {
        let mut out = Vec::new();
        self.each(hay, |found| {
            out.push(found);
            true
        });
        out
    }

    /// The matches `all` finds, each handed to `visit` as it is found,
    /// until `visit` answers false.
    pub(crate) fn each(&mut self, hay: &[u8], mut visit: impl FnMut(Spans) -> bool) {
        let mut at = 0;
        let mut previous = None;
        while at <= hay.len() {
            let Some(found) = self.search(hay, at) else {
                break;
            };
            let Some((start, stop)) = found[0] else {
                break;
            };
            if start == stop && previous == Some(start) {
                match unit_at(hay, start, hay.len(), self.utf8) {
                    Some((_, len)) => {
                        at = start + len;
                        continue;
                    }
                    None => break,
                }
            }
            if !visit(found) {
                break;
            }
            previous = Some(stop);
            at = if stop > start {
                stop
            } else {
                match unit_at(hay, stop, hay.len(), self.utf8) {
                    Some((_, len)) => stop + len,
                    None => break,
                }
            };
        }
    }

    /// How many times the pattern matches `hay` as git counts under
    /// `--pickaxe-regex` with REG_NEWLINE: a match stays in its line, each
    /// search resumes where the last match ended (a unit further after an
    /// empty one), and `^` never holds where it resumes. Each line is
    /// searched in place, so the count takes time in proportion to the
    /// text however many matches it holds.
    pub(crate) fn contains(&mut self, hay: &[u8]) -> usize {
        let len = hay.len();
        let (mut count, mut start, mut begin) = (0, 0, 0);
        // A line a search resumes at the start of, behind a NUL, where `^`
        // does not hold.
        let mut behind = Vec::new();
        while start < len && begin <= len {
            let end = memchr::memchr(b'\n', &hay[begin..]).map_or(len, |at| begin + at);
            let line = &hay[begin..end];
            while start <= end && start < len {
                let found = if count > 0 && start == begin {
                    behind.clear();
                    behind.push(0);
                    behind.extend_from_slice(line);
                    self.extent(&behind, 1)
                        .map(|(first, last)| (first + begin - 1, last + begin - 1))
                } else {
                    self.extent(line, start.saturating_sub(begin))
                        .map(|(first, last)| (first + begin, last + begin))
                };
                let Some((first, stop)) = found else {
                    break;
                };
                count += 1;
                start = stop;
                if first == stop && stop < len {
                    start += unit_at(hay, stop, len, self.utf8).map_or(1, |(_, width)| width);
                }
            }
            begin = end + 1;
        }
        count
    }
}

/// The most bytes a fixed text is spelled out to.
const FIXED_LIMIT: usize = 1 << 20;

/// The bytes an expression of literal units, groups and fixed counts
/// matches, when that is all it is.
fn fixed_text(ast: &Ast) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    spell(ast, &mut out).then_some(out)
}

fn spell(ast: &Ast, out: &mut Vec<u8>) -> bool {
    match ast {
        Ast::Empty => true,
        Ast::Unit(Unit::Char(c)) => {
            out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
            true
        }
        Ast::Unit(Unit::Byte(b)) => {
            out.push(*b);
            true
        }
        Ast::Group(_, inner) => spell(inner, out),
        Ast::Concat(items) => items.iter().all(|item| spell(item, out)),
        Ast::Repeat(inner, min, Some(max)) if min == max => {
            let mut once = Vec::new();
            if !spell(inner, &mut once) {
                return false;
            }
            let count = usize::try_from(*min).unwrap_or(usize::MAX);
            if once.len().saturating_mul(count) + out.len() > FIXED_LIMIT {
                return false;
            }
            for _ in 0..count {
                out.extend_from_slice(&once);
            }
            true
        }
        _ => false,
    }
}

/// What every match of an expression consumes: `literal` when the text is
/// fixed, the literal text it always starts and ends with, and `needles`,
/// one of which it always contains (none known when empty).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Required {
    literal: Option<Vec<u8>>,
    prefix: Vec<u8>,
    suffix: Vec<u8>,
    needles: Vec<Vec<u8>>,
}

/// The most needles an alternation keeps before it knows none.
const NEEDLE_LIMIT: usize = 64;

fn strength(needles: &[Vec<u8>]) -> usize {
    needles.iter().map(Vec::len).min().unwrap_or(0)
}

impl Required {
    fn unknown() -> Required {
        Required {
            literal: None,
            prefix: Vec::new(),
            suffix: Vec::new(),
            needles: Vec::new(),
        }
    }

    fn literal(text: Vec<u8>) -> Required {
        let needles = if text.is_empty() {
            Vec::new()
        } else {
            vec![text.clone()]
        };
        Required {
            prefix: text.clone(),
            suffix: text.clone(),
            literal: Some(text),
            needles,
        }
    }

    /// `self` then `next`: the literal text across where they meet is a
    /// needle as well as either side's.
    fn then(self, next: Required) -> Required {
        if let (Some(left), Some(right)) = (&self.literal, &next.literal) {
            return Required::literal([left.as_slice(), right.as_slice()].concat());
        }
        let joined = [self.suffix.as_slice(), next.prefix.as_slice()].concat();
        let mut needles = self.needles;
        if strength(&next.needles) > strength(&needles) {
            needles = next.needles;
        }
        if !joined.is_empty() && joined.len() > strength(&needles) {
            needles = vec![joined];
        }
        let prefix = match &self.literal {
            Some(left) => [left.as_slice(), next.prefix.as_slice()].concat(),
            None => self.prefix,
        };
        let suffix = match &next.literal {
            Some(right) => [self.suffix.as_slice(), right.as_slice()].concat(),
            None => next.suffix,
        };
        Required {
            literal: None,
            prefix,
            suffix,
            needles,
        }
    }

    fn or(self, other: Required) -> Required {
        if self.literal.is_some() && self.literal == other.literal {
            return self;
        }
        if self.needles.is_empty() || other.needles.is_empty() {
            return Required::unknown();
        }
        let mut needles = self.needles;
        for needle in other.needles {
            if !needles.contains(&needle) {
                needles.push(needle);
            }
        }
        if needles.len() > NEEDLE_LIMIT {
            return Required::unknown();
        }
        Required {
            needles,
            ..Required::unknown()
        }
    }
}

fn required(ast: &Ast, fold: bool) -> Required {
    match ast {
        Ast::Empty | Ast::Look(_) => Required::literal(Vec::new()),
        Ast::Unit(unit) => match unit.ascii() {
            Some(b) => Required::literal(vec![if fold { b.to_ascii_lowercase() } else { b }]),
            None => Required::unknown(),
        },
        Ast::Any | Ast::Set(_) | Ast::Backref(_) => Required::unknown(),
        Ast::Group(_, inner) => required(inner, fold),
        Ast::Repeat(inner, min, max) => {
            if *min == 1 && *max == Some(1) {
                required(inner, fold)
            } else if *min >= 1 {
                let inner = required(inner, fold);
                Required {
                    literal: None,
                    prefix: inner.prefix,
                    suffix: inner.suffix,
                    needles: inner.needles,
                }
            } else {
                Required::unknown()
            }
        }
        Ast::Concat(items) => items
            .iter()
            .map(|item| required(item, fold))
            .reduce(Required::then)
            .unwrap_or_else(|| Required::literal(Vec::new())),
        Ast::Alternate(items) => items
            .iter()
            .map(|item| required(item, fold))
            .reduce(Required::or)
            .unwrap_or_else(Required::unknown),
    }
}

/// Whether every unit of the expression is printable ASCII, the only text
/// a mount's search is asked for.
fn printable(ast: &Ast) -> bool {
    !ast.any_unit(&|unit| !unit.ascii().is_some_and(|b| (b' '..=b'~').contains(&b)))
}

/// The bytes the forward automaton takes a first step on, after the
/// subject's start, a newline, a word byte or another byte: every one
/// when there is no automaton or it gives up.
fn first_bytes(automata: &mut Option<Automata>) -> [bool; 256] {
    let mut set = [true; 256];
    let Some((dfa, cache)) = automata.as_mut().and_then(|a| a.longest.as_mut()) else {
        return set;
    };
    for byte in 0..=u8::MAX {
        set[usize::from(byte)] = [&b""[..], b"\n", b"a", b" "].iter().any(|before| {
            let hay = [before, &[byte][..]].concat();
            let input = Input::new(&hay)
                .span(before.len()..hay.len())
                .anchored(Anchored::Yes);
            let start = dfa.start_state_forward(cache, &input).ok();
            let next = start.and_then(|state| dfa.next_state(cache, state, byte).ok());
            next.is_none_or(|state| !state.is_dead())
        });
    }
    set
}

/// Printable ASCII texts one of which every line any of `asts` matches
/// holds, lowercase under `fold`; None when no such set is known, or when
/// a pattern spells any other unit. Under a UTF-8 locale's case folding a
/// non-ASCII letter matches `k` (the Kelvin sign) or `s` (`ſ`), so a
/// needle holding `i`, `k` or `s` gives none.
pub(crate) fn needles(asts: &[&Ast], fold: bool, utf8: bool) -> Option<Vec<Vec<u8>>> {
    if !asts.iter().all(|ast| printable(ast)) {
        return None;
    }
    let found = asts
        .iter()
        .map(|ast| required(ast, fold))
        .reduce(Required::or)?
        .needles;
    if found.is_empty() {
        return None;
    }
    if fold
        && utf8
        && found
            .iter()
            .any(|needle| needle.iter().any(|b| matches!(b, b'i' | b'k' | b's')))
    {
        return None;
    }
    Some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile(pattern: &str, extended: bool, flags: &str) -> Posix {
        let options = Options {
            extended,
            dialect: Dialect::Sed,
            ignore_case: flags.contains('i'),
            utf8: flags.contains('u'),
            multiline: flags.contains('m'),
            word: flags.contains('w'),
        };
        Posix::compile(pattern.as_bytes(), &options).expect("compiles")
    }

    /// The match and its groups as text, `-` for a group with no part.
    fn groups(pattern: &str, subject: &str) -> Vec<String> {
        let mut regex = compile(pattern, true, "");
        let spans = regex.search(subject.as_bytes(), 0).expect("matches");
        spans
            .iter()
            .map(|span| span.map_or("-".to_owned(), |(a, b)| subject[a..b].to_owned()))
            .collect()
    }

    #[test]
    fn a_search_without_automata_takes_time_in_proportion_to_the_text() {
        // `\b` under UTF-8 turns the automata off; every split of the `a`s
        // into `a` and `aa` reaches the same states.
        let mut regex = compile("\\b(a|aa)*", true, "u");
        assert!(regex.automata.is_none());
        let subject = format!("{}!", "a".repeat(5000));
        let spans = regex.search(subject.as_bytes(), 0).expect("matches");
        assert_eq!(spans[0], Some((0, 5000)));
    }

    #[test]
    fn contains_counts_as_git_pickaxe_does() {
        let count =
            |pattern: &str, text: &str| compile(pattern, true, "m").contains(text.as_bytes());
        assert_eq!(count("^$", "a\n\nb\n"), 2);
        assert_eq!(count("^$", "a\n\n\n\nc\n"), 3);
        assert_eq!(count("b*", "a\n\n\nc\n"), 6);
        assert_eq!(count("^", "ab\nab\nab"), 3);
        assert_eq!(count("a", &"a".repeat(1 << 16)), 1 << 16);
        let mut regex = compile("x*", true, "um");
        assert_eq!(regex.contains("😀😀".as_bytes()), 2);
    }

    #[test]
    fn groups_take_the_first_way_to_the_longest_match() {
        assert_eq!(groups("(a|ab)(bc|c)", "abc"), ["abc", "a", "bc"]);
        assert_eq!(groups("(ab|a)(bc|c)", "abc"), ["abc", "ab", "c"]);
        assert_eq!(groups("(a?)((ab)?)", "ab"), ["ab", "", "ab", "ab"]);
        assert_eq!(groups("(a|ab)*", "abab"), ["abab", "ab"]);
        assert_eq!(groups("(a*)(ab)*(b*)", "aabab"), ["aabab", "a", "ab", ""]);
        assert_eq!(groups("x*(a|xa)*", "xaxa"), ["xaxa", "xa"]);
    }

    #[test]
    fn an_iteration_that_consumes_nothing_is_never_taken() {
        assert_eq!(groups("(a*)+", "aa"), ["aa", "aa"]);
        assert_eq!(groups("(a?)*", "aa"), ["aa", "a"]);
        assert_eq!(groups("(|a)+", "aa"), ["aa", "a"]);
        assert_eq!(groups("(a*)+", "b"), ["", ""]);
        assert_eq!(groups("((a)|b)*", "ab"), ["ab", "b", "a"]);
    }

    #[test]
    fn a_global_walk_passes_over_an_empty_match_where_one_ended() {
        let mut regex = compile("a*", true, "");
        let starts: Vec<_> = regex
            .all(b"baaac")
            .iter()
            .map(|spans| spans[0].unwrap())
            .collect();
        assert_eq!(starts, [(0, 0), (1, 4), (5, 5)]);
        let mut regex = compile("b*", true, "");
        assert_eq!(regex.all(b"abc").len(), 3);
    }

    #[test]
    fn a_dollar_reads_a_newline_unless_groups_are_placed() {
        let found = |pattern: &str| compile(pattern, true, "").search(b"b\na", 0);
        assert_eq!(found("b$.").unwrap()[0], Some((0, 2)));
        for pattern in ["(b$.)", "b$.(a)", "(b)$.", "(b$|x)."] {
            assert_eq!(found(pattern), None, "{pattern}");
            assert!(compile(pattern, true, "").test(b"b\na"), "{pattern}");
        }
        assert!(!compile("(b$)a", true, "").test(b"b\na"));
        assert!(!compile("(b)$.\\1", true, "").test(b"b\nb"));
        assert!(!compile("(a|b)$.\\1", true, "").test(b"b\nb"));
    }

    #[test]
    fn a_class_that_takes_a_newline_finds_no_match_that_is_not_there() {
        let mut regex = compile("\\w[^x]*[ab][a-]", true, "");
        assert_eq!(regex.search(b"aaxcx", 0), None);
        assert_eq!(groups("\\w[^x]*[ab][a-]", "xaab-"), ["xaab-"]);
    }

    #[test]
    fn multiline_anchors_and_newlines() {
        let mut regex = compile("^b", false, "");
        assert!(regex.search(b"a\nb", 0).is_none());
        let mut regex = compile("^b", false, "m");
        assert_eq!(regex.search(b"a\nb", 0).unwrap()[0], Some((2, 3)));
        let mut regex = compile("a.b", false, "");
        assert!(regex.search(b"a\nb", 0).is_some());
        let mut regex = compile("a.b", false, "m");
        assert!(regex.search(b"a\nb", 0).is_none());
        let mut regex = compile("\\`b", false, "m");
        assert!(regex.search(b"a\nb", 0).is_none());
    }

    #[test]
    fn words_need_no_word_character_beside_the_match() {
        let mut regex = compile("ab|abc", true, "w");
        assert_eq!(regex.search(b"abcd abc", 0).unwrap()[0], Some((5, 8)));
        let mut regex = compile("é", false, "uw");
        assert_eq!(regex.search("aé é".as_bytes(), 0).unwrap()[0], Some((4, 6)));
    }

    #[test]
    fn back_references_and_case() {
        let mut regex = compile("\\(a*\\)b\\1", false, "");
        assert_eq!(regex.search(b"xaabaa", 0).unwrap()[0], Some((1, 6)));
        let mut regex = compile("é", false, "ui");
        assert!(regex.search("É".as_bytes(), 0).is_some());
        let mut regex = compile("\\(é\\)\\1", false, "ui");
        assert!(regex.search("éÉ".as_bytes(), 0).is_some());
        let mut regex = compile("\\bé", false, "u");
        assert!(regex.search("aé é".as_bytes(), 0).unwrap()[0] == Some((4, 6)));
    }

    #[test]
    fn a_fixed_text_is_found_by_its_bytes() {
        let mut regex = compile("a\\{3\\}\\(b\\)", false, "");
        assert_eq!(
            regex.search(b"xaaab", 0),
            Some(vec![Some((1, 5)), Some((4, 5))])
        );
        let long = "a".repeat(32767);
        let mut regex = compile("a\\{32767\\}", false, "");
        assert_eq!(
            regex.search(long.as_bytes(), 0),
            Some(vec![Some((0, 32767))])
        );
    }

    #[test]
    fn needles_every_match_holds() {
        let needles_of = |pattern: &str, fold: bool| {
            let parsed = parse::parse(pattern.as_bytes(), true, false, Dialect::Grep).unwrap();
            needles(&[&parsed.ast], fold, false)
        };
        assert_eq!(needles_of("foo.*bar", false), Some(vec![b"foo".to_vec()]));
        assert_eq!(
            needles_of("(abc|xyz)1", false),
            Some(vec![b"abc".to_vec(), b"xyz".to_vec()])
        );
        assert_eq!(needles_of("a*", false), None);
        assert_eq!(needles_of("ABC", true), Some(vec![b"abc".to_vec()]));
        assert_eq!(
            needles_of("conn.*refused", false),
            Some(vec![b"refused".to_vec()])
        );
        assert_eq!(needles_of("ab+cd", false), Some(vec![b"bcd".to_vec()]));
        assert_eq!(needles_of("café", false), None);
    }
}
