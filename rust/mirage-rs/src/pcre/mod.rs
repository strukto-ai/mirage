//! grep -P's and rg -P's matcher: a PCRE2 pattern translated for
//! fancy-regex, matched over bytes (PCRE2 without UTF) or over the UTF-8
//! characters of a record, an invalid byte matching nothing.

mod charset;
mod translate;

use std::sync::OnceLock;

use fancy_regex::{BytesMode, Regex, RegexBuilder, RuntimeError};

pub(crate) use translate::{Mode, PcreError};

/// The backtracking limits a search climbs: one that outgrows a limit runs
/// again under the next, so its caller can charge the work to within a
/// factor of sixteen. The last is PCRE2's default match limit, where a
/// search gives up.
const LIMITS: [usize; 5] = [1 << 8, 1 << 12, 1 << 16, 1 << 20, 10_000_000];

/// A search gave up: the backtracking limit, or the engine's stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Exceeded;

pub(crate) struct Pcre {
    source: String,
    /// The pattern built under each of `LIMITS`, the higher ones on first
    /// use.
    tiers: [OnceLock<Regex>; LIMITS.len()],
    /// A regular pattern every match of this one also matches, for the
    /// literals each match holds.
    pub(crate) regular: String,
    /// Whether a match can hold a NUL, so cross a `--null-data` record.
    pub(crate) matches_nul: bool,
    bytes: bool,
}

fn build(source: &str, bytes: bool, limit: usize) -> Result<Regex, fancy_regex::Error> {
    RegexBuilder::new(source)
        .bytes_mode(if bytes {
            BytesMode::Ascii
        } else {
            BytesMode::UnicodeBytes
        })
        .backtrack_limit(limit)
        .build()
}

/// The characters PCRE2 reads `pattern` as: one per byte without UTF,
/// else the UTF-8 characters (an invalid byte stands for itself).
pub(crate) fn pattern_chars(pattern: &[u8], bytes: bool) -> Vec<char> {
    if bytes {
        return pattern.iter().map(|&b| char::from(b)).collect();
    }
    String::from_utf8_lossy(pattern).chars().collect()
}

impl Pcre {
    pub(crate) fn new(pattern: &[char], mode: Mode) -> Result<Self, PcreError> {
        let translated = translate::translate(pattern, mode)?;
        let source = translate::source(&translated, mode.whole_line);
        let first = build(&source, mode.bytes, LIMITS[0]).map_err(|err| PcreError {
            message: format!("{err} is not supported in mirage"),
            offset: 0,
        })?;
        let tiers = [
            OnceLock::from(first),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
            OnceLock::new(),
        ];
        Ok(Self {
            source,
            tiers,
            regular: translated.regular,
            matches_nul: translated.nul,
            bytes: mode.bytes,
        })
    }

    fn tier(&self, tier: usize) -> &Regex {
        self.tiers[tier].get_or_init(|| {
            build(&self.source, self.bytes, LIMITS[tier]).expect("the pattern built once")
        })
    }

    /// Run `search` under each limit until one answers: its answer, and
    /// the most backtracking steps it can have taken.
    fn climb<T>(
        &self,
        mut search: impl FnMut(&Regex) -> Result<T, fancy_regex::Error>,
    ) -> (Result<T, Exceeded>, usize) {
        let last = LIMITS.len() - 1;
        for (tier, &limit) in LIMITS.iter().enumerate() {
            match search(self.tier(tier)) {
                Ok(found) => return (Ok(found), limit),
                Err(fancy_regex::Error::RuntimeError(RuntimeError::BacktrackLimitExceeded))
                    if tier < last => {}
                Err(err) => {
                    log_exceeded(&err);
                    return (Err(Exceeded), limit);
                }
            }
        }
        unreachable!("the last limit answers")
    }

    /// The leftmost match in `record` that starts at or after `at`, its
    /// start past any `\K`, and the most backtracking steps it took.
    pub(crate) fn find(
        &self,
        record: &[u8],
        at: usize,
    ) -> (Result<Option<(usize, usize)>, Exceeded>, usize) {
        self.climb(|regex| {
            regex
                .find_from_pos(record, at)
                .map(|found| found.map(|m| (m.start(), m.end())))
        })
    }

    /// Like `find`, with every group's span written to `groups` (group 0
    /// the whole match); false when nothing matches.
    pub(crate) fn captures(
        &self,
        record: &[u8],
        at: usize,
        groups: &mut Vec<Option<(usize, usize)>>,
    ) -> (Result<bool, Exceeded>, usize) {
        groups.clear();
        let count = self.group_count();
        self.climb(|regex| {
            regex
                .captures_from_pos(record, at)
                .map(|found| match found {
                    Some(found) => {
                        groups
                            .extend((0..count).map(|i| found.get(i).map(|m| (m.start(), m.end()))));
                        true
                    }
                    None => false,
                })
        })
    }

    /// The groups the pattern numbers, group 0 included.
    pub(crate) fn group_count(&self) -> usize {
        self.tier(0).captures_len()
    }

    /// Each named group and its number.
    pub(crate) fn capture_names(&self) -> impl Iterator<Item = (&str, usize)> {
        self.tier(0)
            .capture_names()
            .enumerate()
            .filter_map(|(index, name)| name.map(|name| (name, index)))
    }

    /// The length of the character at `pos`, for stepping past an empty
    /// match.
    pub(crate) fn unit_len(&self, record: &[u8], pos: usize) -> usize {
        if self.bytes {
            return 1;
        }
        match record.get(pos) {
            Some(&b) if b >= 0xC0 => {
                let len = if b >= 0xF0 {
                    4
                } else if b >= 0xE0 {
                    3
                } else {
                    2
                };
                let end = (pos + len).min(record.len());
                if std::str::from_utf8(&record[pos..end]).is_ok() {
                    len
                } else {
                    1
                }
            }
            _ => 1,
        }
    }
}

fn log_exceeded(err: &fancy_regex::Error) {
    debug_assert!(matches!(err, fancy_regex::Error::RuntimeError(_)), "{err}");
}

#[cfg(test)]
mod tests;
