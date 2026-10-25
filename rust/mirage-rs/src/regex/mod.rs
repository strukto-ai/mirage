mod backtrack;
mod class;
mod hir;
pub(crate) mod parse;
pub(crate) mod posix;
pub(crate) mod stream;

use regex_automata::nfa::thompson::{self, WhichCaptures};
use regex_automata::util::look::LookMatcher;
use regex_automata::{Anchored, Input, MatchKind, hybrid, meta};
use regex_syntax::hir::Hir;

use self::backtrack::{Program, Scratch, Shape, unit_at};
use self::hir::Lower;
use self::parse::{Ast, Dialect, TOO_BIG, Unit};
use crate::pcre::{self, Pcre};

/// What a search that may run out of steps comes back with.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step<T> {
    Done(T),
    /// Out of steps: the same call again resumes the search.
    Paused,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Syntax {
    Basic,
    Extended,
    Fixed,
    /// -P: one PCRE2 pattern.
    Perl,
}

/// What grep says of a -P pattern list longer than one.
const PERL_SINGLE: &str = "the -P option only supports a single pattern";

pub(crate) struct Options {
    pub(crate) syntax: Syntax,
    pub(crate) ignore_case: bool,
    pub(crate) utf8: bool,
    /// -w; -x outranks it.
    pub(crate) word: bool,
    pub(crate) line: bool,
    pub(crate) terminator: u8,
    /// The caller asks where matches end (-o), which takes a second
    /// automaton.
    pub(crate) extents: bool,
}

pub(crate) struct Automata {
    first: meta::Regex,
    cache: meta::Cache,
    longest: Option<(hybrid::dfa::DFA, hybrid::dfa::Cache)>,
}

/// The automata for the patterns they run and the backtracker for the
/// rest.
struct Engine {
    automata: Option<Automata>,
    programs: Vec<Program>,
    /// A search that ran out of steps: the program it stopped in, and the
    /// best match before it.
    resume: Option<(usize, Option<(usize, usize)>)>,
}

/// grep's basic, extended and fixed-string patterns, matched over records
/// of bytes or, under UTF-8, of characters. A record matches when any
/// pattern of the list does; where a match lies, for -o, is the leftmost
/// one and the longest there, across the whole list. A -P pattern is
/// PCRE2's, its matches leftmost-first.
pub(crate) struct Regex {
    matcher: Matcher,
    utf8: bool,
    /// A -P search gave up at the backtracking limit.
    exceeded: bool,
}

enum Matcher {
    Posix(Box<Engines>),
    Perl(Box<Pcre>),
}

/// The automata and backtracker grep's own dialects run on.
struct Engines {
    select: Engine,
    /// Where -o reads matches when that differs from selecting lines.
    extent: Option<Engine>,
    scratch: Scratch,
}

pub(crate) struct Compiled {
    pub(crate) regex: Regex,
    /// What GNU grep warns about the list, in order.
    pub(crate) warnings: Vec<&'static str>,
}

/// A byte that is no part of a character, which only a literal match of
/// that same byte may take; in a set one matches nothing.
pub(crate) fn has_raw_byte(ast: &Ast) -> bool {
    let raw = |unit: &Unit| matches!(unit, Unit::Byte(_));
    match ast {
        Ast::Unit(unit) => raw(unit),
        Ast::Group(_, inner) | Ast::Repeat(inner, _, _) => has_raw_byte(inner),
        Ast::Concat(items) | Ast::Alternate(items) => items.iter().any(has_raw_byte),
        _ => false,
    }
}

/// Whether `pos` falls inside a UTF-8 character of `hay`.
pub(crate) fn splits_char(hay: &[u8], pos: usize) -> bool {
    (pos.saturating_sub(3)..pos).any(|start| {
        unit_at(hay, start, hay.len(), true)
            .is_some_and(|(unit, len)| matches!(unit, Unit::Char(_)) && start + len > pos)
    })
}

impl Automata {
    pub(crate) fn new(
        hirs: &[Hir],
        terminator: u8,
        extents: bool,
    ) -> Result<Automata, &'static str> {
        let first = meta::Builder::new()
            .configure(
                meta::Config::new()
                    .match_kind(MatchKind::LeftmostFirst)
                    .utf8_empty(false)
                    .line_terminator(terminator)
                    .which_captures(WhichCaptures::Implicit),
            )
            .build_many_from_hir(hirs)
            .map_err(|_| TOO_BIG)?;
        let longest = if extents {
            let mut looks = LookMatcher::new();
            looks.set_line_terminator(terminator);
            let nfa = thompson::Compiler::new()
                .configure(
                    thompson::Config::new()
                        .utf8(false)
                        .which_captures(WhichCaptures::None)
                        .look_matcher(looks),
                )
                .build_many_from_hir(hirs)
                .map_err(|_| TOO_BIG)?;
            let dfa = hybrid::dfa::DFA::builder()
                .configure(hybrid::dfa::Config::new().match_kind(MatchKind::All))
                .build_from_nfa(nfa)
                .map_err(|_| TOO_BIG)?;
            let cache = dfa.create_cache();
            Some((dfa, cache))
        } else {
            None
        };
        let cache = first.create_cache();
        Ok(Automata {
            first,
            cache,
            longest,
        })
    }

    /// The leftmost match in `hay[from..to]`, never an empty one inside a
    /// character.
    pub(crate) fn first(
        &mut self,
        hay: &[u8],
        mut from: usize,
        to: usize,
        utf8: bool,
    ) -> Option<(usize, usize)> {
        loop {
            let found = self
                .first
                .search_with(&mut self.cache, &Input::new(hay).span(from..to))?;
            if !(utf8 && found.is_empty() && splits_char(hay, found.start())) {
                return Some((found.start(), found.end()));
            }
            from = found.start() + 1;
        }
    }

    /// Where the longest match starting at `start` ends.
    fn longest(&mut self, hay: &[u8], start: usize, to: usize, first_end: usize) -> usize {
        self.longest_end(hay, start, to)
            .map_or(first_end, |end| end.max(first_end))
    }

    /// Where the longest match starting at `start` ends, or None when the
    /// automaton gave up.
    pub(crate) fn longest_end(&mut self, hay: &[u8], start: usize, to: usize) -> Option<usize> {
        let (dfa, cache) = self.longest.as_mut()?;
        let input = Input::new(hay).span(start..to).anchored(Anchored::Yes);
        match dfa.try_search_fwd(cache, &input) {
            Ok(Some(end)) => Some(end.offset()),
            _ => None,
        }
    }
}

impl Engine {
    fn new(asts: &[&Ast], options: &Options, extents: bool) -> Result<Engine, &'static str> {
        let word = options.word && !options.line;
        let lower = Lower {
            ignore_case: options.ignore_case,
            utf8: options.utf8,
            terminator: Some(options.terminator),
            multiline: false,
            dot_skips_nul: false,
        };
        // Under UTF-8 a word is made of the locale's letters and digits, which
        // the automata's word checks do not read: -w and the word anchors go
        // to the backtracker, as they do for sed.
        let shape = Shape {
            ignore_case: options.ignore_case,
            utf8: options.utf8,
            multiline: false,
            unicode_words: options.utf8,
            consumed_newlines: false,
            dot_skips_nul: false,
        };
        let mut hirs = Vec::new();
        let mut programs = Vec::new();
        for &ast in asts {
            if ast.has_backref()
                || (options.utf8 && (has_raw_byte(ast) || word || ast.has_word_look()))
            {
                programs.push(Program::new(ast, word, options.line, shape)?);
            } else {
                hirs.push(lower.pattern(ast, word, options.line));
            }
        }
        let automata = if hirs.is_empty() {
            None
        } else {
            Some(Automata::new(&hirs, options.terminator, extents)?)
        };
        Ok(Engine {
            automata,
            programs,
            resume: None,
        })
    }

    /// Where the backtracked programs start, after the automata's answer:
    /// the first program and the best match so far, or where a paused
    /// search left off.
    fn resumed(
        &mut self,
        automata: impl FnOnce(&mut Automata) -> Option<(usize, usize)>,
    ) -> (usize, Option<(usize, usize)>) {
        match self.resume.take() {
            Some(resume) => resume,
            None => (0, self.automata.as_mut().and_then(automata)),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn find(
        &mut self,
        hay: &[u8],
        from: usize,
        to: usize,
        utf8: bool,
        scratch: &mut Scratch,
        budget: &mut u64,
    ) -> Step<Option<usize>> {
        let (first, mut best) = self.resumed(|automata| automata.first(hay, from, to, utf8));
        for (index, program) in self.programs.iter().enumerate().skip(first) {
            match program.find(hay, from, to, from, false, scratch, budget) {
                Step::Paused => {
                    self.resume = Some((index, best));
                    return Step::Paused;
                }
                Step::Done(Some(found)) => {
                    if best.is_none_or(|(start, _)| found.0 < start) {
                        best = Some(found);
                    }
                }
                Step::Done(None) => {}
            }
        }
        Step::Done(best.map(|(start, _)| start))
    }

    /// Whether the record `hay[from..to]` holds a match: the first pattern
    /// that matches answers, so a slow one need not run.
    fn any(
        &mut self,
        hay: &[u8],
        from: usize,
        to: usize,
        utf8: bool,
        scratch: &mut Scratch,
        budget: &mut u64,
    ) -> Step<bool> {
        let first = match self.resume.take() {
            Some((index, _)) => index,
            None if self
                .automata
                .as_mut()
                .is_some_and(|automata| automata.first(hay, from, to, utf8).is_some()) =>
            {
                return Step::Done(true);
            }
            None => 0,
        };
        for (index, program) in self.programs.iter().enumerate().skip(first) {
            match program.find(hay, from, to, from, false, scratch, budget) {
                Step::Paused => {
                    self.resume = Some((index, None));
                    return Step::Paused;
                }
                Step::Done(Some(_)) => return Step::Done(true),
                Step::Done(None) => {}
            }
        }
        Step::Done(false)
    }

    #[allow(clippy::too_many_arguments)]
    fn extent(
        &mut self,
        hay: &[u8],
        begin: usize,
        at: usize,
        to: usize,
        utf8: bool,
        scratch: &mut Scratch,
        budget: &mut u64,
    ) -> Step<Option<(usize, usize)>> {
        let (first, mut best) = self.resumed(|automata| {
            let (start, end) = automata.first(hay, at, to, utf8)?;
            Some((start, automata.longest(hay, start, to, end)))
        });
        for (index, program) in self.programs.iter().enumerate().skip(first) {
            let (start, end) = match program.find(hay, begin, to, at, true, scratch, budget) {
                Step::Paused => {
                    self.resume = Some((index, best));
                    return Step::Paused;
                }
                Step::Done(Some(found)) => found,
                Step::Done(None) => continue,
            };
            best = match best {
                Some((first, last)) if first < start => Some((first, last)),
                Some((first, last)) if first == start => Some((first, last.max(end))),
                _ => Some((start, end)),
            };
        }
        Step::Done(best)
    }
}

impl Regex {
    pub(crate) fn compile(patterns: &[Vec<u8>], options: &Options) -> Result<Compiled, String> {
        if options.syntax == Syntax::Perl && !patterns.is_empty() {
            return Self::perl(patterns, options);
        }
        let mut selects = Vec::new();
        let mut extents = Vec::new();
        let mut warnings = Vec::new();
        for pattern in patterns {
            match options.syntax {
                Syntax::Fixed => {
                    selects.push(parse::literal(pattern, options.utf8));
                    extents.push(None);
                }
                syntax => {
                    let parsed = parse::parse(
                        pattern,
                        syntax == Syntax::Extended,
                        options.utf8,
                        Dialect::Grep,
                    )?;
                    warnings.extend(parsed.warnings);
                    selects.push(parsed.ast);
                    extents.push(parsed.extents);
                }
            }
        }
        let differs = options.extents && extents.iter().any(Option::is_some);
        let select_asts: Vec<&Ast> = selects.iter().collect();
        let select = Engine::new(&select_asts, options, options.extents && !differs)?;
        let extent = if differs {
            let asts: Vec<&Ast> = selects
                .iter()
                .zip(&extents)
                .map(|(select, extent)| extent.as_ref().unwrap_or(select))
                .collect();
            Some(Engine::new(&asts, options, true)?)
        } else {
            None
        };
        Ok(Compiled {
            regex: Regex {
                matcher: Matcher::Posix(Box::new(Engines {
                    select,
                    extent,
                    scratch: Scratch::default(),
                })),
                utf8: options.utf8,
                exceeded: false,
            },
            warnings,
        })
    }

    /// grep -P's one pattern, wrapped for -w as GNU grep wraps it (so a
    /// refusal's offset counts the wrapper), and spanning the record for -x.
    fn perl(patterns: &[Vec<u8>], options: &Options) -> Result<Compiled, String> {
        let [pattern] = patterns else {
            return Err(PERL_SINGLE.to_string());
        };
        let bytes = !options.utf8;
        let mut chars = pcre::pattern_chars(pattern, bytes);
        if options.word && !options.line {
            chars = "(?<!\\w)(?:"
                .chars()
                .chain(chars)
                .chain(")(?!\\w)".chars())
                .collect();
        }
        let mode = pcre::Mode {
            bytes,
            ignore_case: options.ignore_case,
            whole_line: options.line,
            ..pcre::Mode::default()
        };
        let compiled = Pcre::new(&chars, mode).map_err(|err| err.message)?;
        Ok(Compiled {
            regex: Regex {
                matcher: Matcher::Perl(Box::new(compiled)),
                utf8: options.utf8,
                exceeded: false,
            },
            warnings: Vec::new(),
        })
    }

    /// Whether one search may span many records: the backtracker and a -P
    /// pattern take one at a time.
    pub(crate) fn spans_records(&self) -> bool {
        match &self.matcher {
            Matcher::Posix(posix) => posix.select.programs.is_empty(),
            Matcher::Perl(_) => false,
        }
    }

    /// Where the leftmost match in `hay[from..to]` starts; `hay[to]` is the
    /// terminator of the last record searched, and `from` starts a record.
    /// With a backtracked pattern the span is one record, and the search
    /// spends `budget`; out of it, the same call again resumes.
    pub(crate) fn find(
        &mut self,
        hay: &[u8],
        from: usize,
        to: usize,
        budget: &mut u64,
    ) -> Step<Option<usize>> {
        match &mut self.matcher {
            Matcher::Posix(posix) => {
                let Engines {
                    select, scratch, ..
                } = posix.as_mut();
                select.find(hay, from, to, self.utf8, scratch, budget)
            }
            Matcher::Perl(pcre) => {
                match perl_extent(pcre, &mut self.exceeded, hay, from, from, to, budget) {
                    Step::Done(found) => Step::Done(found.map(|(start, _)| start)),
                    Step::Paused => Step::Paused,
                }
            }
        }
    }

    /// Whether the one record `hay[from..to]` matches, spending `budget`
    /// as `find` does.
    pub(crate) fn matches(
        &mut self,
        hay: &[u8],
        from: usize,
        to: usize,
        budget: &mut u64,
    ) -> Step<bool> {
        match &mut self.matcher {
            Matcher::Posix(posix) => {
                let Engines {
                    select, scratch, ..
                } = posix.as_mut();
                select.any(hay, from, to, self.utf8, scratch, budget)
            }
            Matcher::Perl(pcre) => {
                match perl_extent(pcre, &mut self.exceeded, hay, from, from, to, budget) {
                    Step::Done(found) => Step::Done(found.is_some()),
                    Step::Paused => Step::Paused,
                }
            }
        }
    }

    /// The leftmost-longest match in the record `hay[begin..to]` that
    /// starts at or after `at`, spending `budget` as `find` does; a -P
    /// pattern's is the leftmost-first, its start past any `\K`.
    pub(crate) fn extent(
        &mut self,
        hay: &[u8],
        begin: usize,
        at: usize,
        to: usize,
        budget: &mut u64,
    ) -> Step<Option<(usize, usize)>> {
        match &mut self.matcher {
            Matcher::Posix(posix) => {
                let Engines {
                    select,
                    extent,
                    scratch,
                } = posix.as_mut();
                let engine = extent.as_mut().unwrap_or(select);
                engine.extent(hay, begin, at, to, self.utf8, scratch, budget)
            }
            Matcher::Perl(pcre) => {
                perl_extent(pcre, &mut self.exceeded, hay, begin, at, to, budget)
            }
        }
    }

    /// Whether a -P search gave up at the backtracking limit since the
    /// last call; the input ends there, as GNU grep's does.
    pub(crate) fn exceeded(&mut self) -> bool {
        std::mem::take(&mut self.exceeded)
    }

    /// A -P pattern's regular approximation, which its needles come from.
    pub(crate) fn perl_regular(&self) -> Option<&str> {
        match &self.matcher {
            Matcher::Perl(pcre) => Some(&pcre.regular),
            Matcher::Posix(_) => None,
        }
    }

    /// The length of the unit at `pos`, for stepping past an empty match.
    pub(crate) fn unit_len(&self, hay: &[u8], pos: usize, to: usize) -> usize {
        match &self.matcher {
            Matcher::Perl(pcre) => pcre.unit_len(&hay[..to], pos),
            Matcher::Posix(_) => unit_at(hay, pos, to, self.utf8).map_or(1, |(_, len)| len),
        }
    }
}

/// A -P pattern's needles, from the extended expression every match of it
/// also matches.
pub(crate) fn perl_needles(regular: &str, ignore_case: bool, utf8: bool) -> Option<Vec<Vec<u8>>> {
    let parsed = parse::parse(regular.as_bytes(), true, utf8, Dialect::Grep).ok()?;
    posix::needles(&[&parsed.ast], ignore_case, utf8)
}

/// A -P pattern's leftmost match in the record `hay[begin..to]` at or after
/// `at`. A search is one step of `budget` however long it runs; one that
/// gives up at the backtracking limit sets `exceeded` and finds nothing.
fn perl_extent(
    pcre: &Pcre,
    exceeded: &mut bool,
    hay: &[u8],
    begin: usize,
    at: usize,
    to: usize,
    budget: &mut u64,
) -> Step<Option<(usize, usize)>> {
    if *budget == 0 {
        return Step::Paused;
    }
    *budget -= 1;
    match pcre.find(&hay[begin..to], at - begin) {
        Ok(found) => Step::Done(found.map(|(start, end)| (begin + start, begin + end))),
        Err(pcre::Exceeded) => {
            *exceeded = true;
            Step::Done(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile(patterns: &[&str], syntax: Syntax, flags: &str) -> Regex {
        let options = Options {
            syntax,
            ignore_case: flags.contains('i'),
            utf8: flags.contains('u'),
            word: flags.contains('w'),
            line: flags.contains('x'),
            terminator: b'\n',
            extents: true,
        };
        let patterns: Vec<Vec<u8>> = patterns.iter().map(|p| p.as_bytes().to_vec()).collect();
        Regex::compile(&patterns, &options).expect("compiles").regex
    }

    fn unlimited() -> u64 {
        u64::MAX
    }

    fn done<T>(step: Step<T>) -> T {
        match step {
            Step::Done(value) => value,
            Step::Paused => panic!("an unlimited search paused"),
        }
    }

    /// Every match -o prints in `line`.
    fn matches(regex: &mut Regex, line: &str) -> Vec<String> {
        let hay = format!("{line}\n").into_bytes();
        let to = hay.len() - 1;
        let mut at = 0;
        let mut out = Vec::new();
        while at <= to {
            let Some((start, end)) = done(regex.extent(&hay, 0, at, to, &mut unlimited())) else {
                break;
            };
            if end > start {
                out.push(String::from_utf8_lossy(&hay[start..end]).into_owned());
                at = end;
            } else {
                at = start + regex.unit_len(&hay, start, to);
            }
        }
        out
    }

    #[test]
    fn matches_are_leftmost_then_longest() {
        let mut regex = compile(&["ab|abcd"], Syntax::Extended, "");
        assert_eq!(matches(&mut regex, "abcd"), ["abcd"]);
        let mut regex = compile(&["(a|ab)(c|bcd)"], Syntax::Extended, "");
        assert_eq!(matches(&mut regex, "abcd"), ["abcd"]);
        let mut regex = compile(&["b", "abc"], Syntax::Basic, "");
        assert_eq!(matches(&mut regex, "xabc b"), ["abc", "b"]);
    }

    #[test]
    fn back_references_take_the_longest_match() {
        let mut regex = compile(&["\\(a*\\)\\1"], Syntax::Basic, "");
        assert_eq!(matches(&mut regex, "aaaa"), ["aaaa"]);
        let mut regex = compile(&["(a)(b|\\1)"], Syntax::Extended, "");
        assert_eq!(matches(&mut regex, "aa ab"), ["aa", "ab"]);
        let mut regex = compile(&["(A)\\1"], Syntax::Extended, "i");
        assert_eq!(matches(&mut regex, "aA"), ["aA"]);
    }

    #[test]
    fn a_search_spans_records_without_crossing_them() {
        let mut regex = compile(&["b$"], Syntax::Basic, "");
        let hay = b"ab\nb\nc\n";
        assert_eq!(done(regex.find(hay, 0, 6, &mut unlimited())), Some(1));
        assert_eq!(done(regex.find(hay, 3, 6, &mut unlimited())), Some(3));
        let mut regex = compile(&["a[^x]b"], Syntax::Basic, "");
        assert_eq!(done(regex.find(b"a\nb\n", 0, 3, &mut unlimited())), None);
        let mut regex = compile(&["^$"], Syntax::Basic, "");
        assert_eq!(done(regex.find(b"a\nb\n", 0, 3, &mut unlimited())), None);
    }

    #[test]
    fn words_need_no_word_character_beside_the_match() {
        let mut regex = compile(&["@"], Syntax::Extended, "w");
        assert_eq!(matches(&mut regex, " @ "), ["@"]);
        assert!(matches(&mut regex, "a@b").is_empty());
        let mut regex = compile(&["ab|abcd"], Syntax::Extended, "w");
        assert_eq!(matches(&mut regex, "abcd x"), ["abcd"]);
    }

    #[test]
    fn utf8_matches_characters_and_never_a_stray_byte() {
        let mut regex = compile(&["x.y"], Syntax::Extended, "u");
        assert_eq!(matches(&mut regex, "xéy"), ["xéy"]);
        let mut regex = compile(&["a.b"], Syntax::Extended, "u");
        let hay = b"a\xffb\n";
        assert_eq!(done(regex.find(hay, 0, 3, &mut unlimited())), None);
        let mut regex = compile(&["a.b"], Syntax::Extended, "");
        assert_eq!(done(regex.find(hay, 0, 3, &mut unlimited())), Some(0));
        // Case folds by Unicode, as GNU does in C.UTF-8.
        let mut regex = compile(&["É"], Syntax::Extended, "ui");
        assert_eq!(matches(&mut regex, "é"), ["é"]);
        let mut regex = compile(&["[[:alpha:]]"], Syntax::Extended, "u");
        assert_eq!(matches(&mut regex, "-é-"), ["é"]);
    }

    #[test]
    fn a_stray_byte_in_the_pattern_matches_only_itself() {
        let options = Options {
            syntax: Syntax::Fixed,
            ignore_case: false,
            utf8: true,
            word: false,
            line: false,
            terminator: b'\n',
            extents: true,
        };
        let mut regex = Regex::compile(&[vec![0xA9]], &options)
            .expect("compiles")
            .regex;
        assert_eq!(
            done(regex.find("é\n".as_bytes(), 0, 2, &mut unlimited())),
            None
        );
        assert_eq!(
            done(regex.find(b"a\xa9\n", 0, 2, &mut unlimited())),
            Some(1)
        );
    }

    #[test]
    fn backtracked_patterns_keep_grep_semantics() {
        // `\w` takes the underscore in the C locale too.
        let mut regex = compile(&["^(\\w)\\1$"], Syntax::Extended, "");
        assert_eq!(matches(&mut regex, "__"), ["__"]);
        // An empty iteration ends the loop and keeps its capture.
        let mut regex = compile(&["^(a?)*\\1b$"], Syntax::Extended, "");
        for line in ["b", "ab", "aab"] {
            assert_eq!(matches(&mut regex, line), [line]);
        }
        // A body that compiles to nothing is not written out again.
        compile(&["a{0}{32767}{32767}{32767}(b)\\1"], Syntax::Extended, "");
    }

    #[test]
    fn nesting_is_refused_past_the_limit() {
        let options = Options {
            syntax: Syntax::Extended,
            ignore_case: false,
            utf8: false,
            word: false,
            line: false,
            terminator: b'\n',
            extents: true,
        };
        let deep = |n: usize| format!("{}a{}", "(".repeat(n), ")".repeat(n)).into_bytes();
        assert!(Regex::compile(&[deep(100)], &options).is_ok());
        assert_eq!(
            Regex::compile(&[deep(20000)], &options).err(),
            Some(parse::STACK_OVERFLOW.to_string())
        );
        let stars = format!("a{}", "*".repeat(100_000)).into_bytes();
        assert_eq!(
            Regex::compile(&[stars], &options).err(),
            Some(parse::STACK_OVERFLOW.to_string())
        );
    }
}
