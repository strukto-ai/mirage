// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regexec.c. See licenses/third_party/oniguruma.txt.

mod class;
mod compile;
mod exec;
mod parse;
#[cfg(test)]
mod tests;

use self::compile::{Inst, Program, Unit};
use self::exec::{Best, Machine, Mode};
use self::parse::{Anchor, Flags};
use crate::regex::Step;

pub(crate) use self::exec::Region;

/// The ONIG_OPTION_* bits jq's modifier letters set.
#[derive(Clone, Copy, Default)]
pub(crate) struct Options {
    pub(crate) ignore_case: bool,
    pub(crate) extend: bool,
    /// ONIG_OPTION_MULTILINE: `.` matches a newline.
    pub(crate) dotall: bool,
    /// ONIG_OPTION_FIND_LONGEST.
    pub(crate) longest: bool,
    /// ONIG_OPTION_FIND_NOT_EMPTY.
    pub(crate) not_empty: bool,
}

/// A pattern in Oniguruma's ONIG_SYNTAX_PERL_NG over UTF-8, the dialect
/// jq's regex builtins compile with, with every group capturing
/// (ONIG_OPTION_CAPTURE_GROUP). Subexp calls, absent operators, callouts,
/// text segments (`\X`, `\y`), conditions that are no group reference,
/// backreferences with a level, case folding to several characters and
/// Unicode blocks are refused with an error.
pub(crate) struct Regex {
    program: Program,
    groups: usize,
    names: Vec<(String, Vec<usize>)>,
    options: Options,
    /// The byte every match starts with, when the pattern begins with a
    /// literal.
    first: Option<u8>,
    /// The anchor every match starts at, when the pattern begins with one.
    anchor: Option<Anchor>,
    /// When the pattern begins with a greedy `.*`, whether it crosses
    /// newlines: a match starts only where the search does or, when it
    /// does not, after a newline (Oniguruma's ANCR_ANYCHAR_INF).
    star: Option<bool>,
    /// The first byte of a character every match holds.
    required: Option<u8>,
}

fn first_byte(c: char) -> u8 {
    let mut buf = [0; 4];
    c.encode_utf8(&mut buf).as_bytes()[0]
}

impl Regex {
    /// Compiles `pattern`, or fails with Oniguruma's message.
    pub(crate) fn new(pattern: &str, options: Options) -> Result<Regex, String> {
        let flags = Flags {
            ignore_case: options.ignore_case,
            extend: options.extend,
            dotall: options.dotall,
            singleline: true,
        };
        let parsed = parse::parse(pattern, flags)?;
        let required = compile::required(&parsed.node).map(first_byte);
        let program = compile::compile(parsed.node, parsed.groups)?;
        let lead = program
            .insts
            .iter()
            .find(|inst| !matches!(inst, Inst::Save(_)));
        let first = match lead {
            Some(Inst::Unit(Unit::Char(c))) => Some(first_byte(*c)),
            _ => None,
        };
        let anchor = match lead {
            Some(Inst::Anchor(anchor @ (Anchor::BufStart | Anchor::SearchStart))) => Some(*anchor),
            _ => None,
        };
        // The leading `.*` shortcut skips start offsets an earlier attempt
        // already covered, which a backreference to the `.*` breaks.
        let backrefs = program
            .insts
            .iter()
            .any(|inst| matches!(inst, Inst::Backref(..)));
        let star = match lead {
            _ if backrefs => None,
            Some(Inst::Star {
                unit: unit @ (Unit::Any | Unit::AnyNl),
                max: None,
                greedy: true,
                ..
            }) => Some(matches!(unit, Unit::AnyNl)),
            _ => None,
        };
        Ok(Regex {
            program,
            groups: parsed.groups,
            names: parsed.names,
            options,
            first,
            anchor,
            star,
            required,
        })
    }

    /// The groups the pattern numbers, group 0 not counted.
    pub(crate) fn groups(&self) -> usize {
        self.groups
    }

    /// Each name and the groups it names.
    pub(crate) fn names(&self) -> &[(String, Vec<usize>)] {
        &self.names
    }
}

/// One onig_search: the leftmost match in a subject from `from` on (with
/// `l`, the longest anywhere), tried one start at a time and able to stop
/// between any two steps.
pub(crate) struct Search {
    from: usize,
    at: usize,
    active: bool,
    machine: Machine,
    best: Option<Best>,
    /// Where the required character was last found.
    seen: Option<usize>,
}

impl Search {
    pub(crate) fn new(from: usize) -> Search {
        Search {
            from,
            at: from,
            active: false,
            machine: Machine::default(),
            best: None,
            seen: None,
        }
    }

    /// Starts over from `from`, keeping the buffers.
    pub(crate) fn restart(&mut self, from: usize) {
        self.from = from;
        self.at = from;
        self.active = false;
        self.best = None;
    }

    /// Searches `hay` with `regex`, spending `budget`; out of it, the same
    /// call again resumes. An error is Oniguruma's message.
    pub(crate) fn run(
        &mut self,
        regex: &Regex,
        hay: &[u8],
        budget: &mut u64,
    ) -> Step<Result<Option<Region>, &'static str>> {
        let mode = Mode {
            from: self.from,
            not_empty: regex.options.not_empty,
            longest: regex.options.longest,
        };
        loop {
            if !self.active {
                if !self.next_start(regex, hay) {
                    return Step::Done(Ok(self.best.take().map(|best| best.region)));
                }
                self.machine.reset(&regex.program, self.at);
                self.active = true;
            }
            let found = self.machine.run(
                &regex.program,
                regex.groups,
                hay,
                &mode,
                &mut self.best,
                budget,
            );
            match found {
                Step::Paused => return Step::Paused,
                Step::Done(Err(err)) => return Step::Done(Err(err)),
                Step::Done(Ok(Some(region))) => {
                    self.active = false;
                    return Step::Done(Ok(Some(region)));
                }
                Step::Done(Ok(None)) => {
                    self.active = false;
                    self.at += exec::unit_at(hay, self.at).map_or(1, |(_, len)| len);
                }
            }
        }
    }

    /// Moves to the next start worth an attempt, false when none is left.
    fn next_start(&mut self, regex: &Regex, hay: &[u8]) -> bool {
        if self.at > hay.len() {
            return false;
        }
        match regex.anchor {
            Some(Anchor::BufStart) if self.at != 0 => return false,
            Some(Anchor::SearchStart) if self.at != self.from => return false,
            _ => {}
        }
        match regex.star {
            Some(true) if self.at != self.from => return false,
            Some(false) if self.at != self.from && hay[self.at - 1] != b'\n' => {
                match memchr::memchr(b'\n', &hay[self.at..]) {
                    Some(skip) => self.at += skip + 1,
                    None => return false,
                }
            }
            _ => {}
        }
        if let Some(byte) = regex.first {
            match memchr::memchr(byte, &hay[self.at..]) {
                Some(skip) => self.at += skip,
                None => return false,
            }
        }
        if let Some(byte) = regex.required {
            if self.seen.is_none_or(|seen| seen < self.at) {
                match memchr::memchr(byte, &hay[self.at..]) {
                    Some(skip) => self.seen = Some(self.at + skip),
                    None => return false,
                }
            }
        }
        true
    }
}
