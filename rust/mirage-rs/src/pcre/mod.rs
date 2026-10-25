//! grep -P's and rg -P's matcher: a PCRE2 pattern translated for
//! fancy-regex, matched over bytes (PCRE2 without UTF) or over the UTF-8
//! characters of a record, an invalid byte matching nothing.

mod charset;
mod translate;

use fancy_regex::{BytesMode, Regex, RegexBuilder};

pub(crate) use translate::{Mode, PcreError};

/// How many backtracking steps one search may take before it gives up,
/// PCRE2's default match limit.
const BACKTRACK_LIMIT: usize = 10_000_000;

/// A search gave up: the backtracking limit, or the engine's stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Exceeded;

pub(crate) struct Pcre {
    regex: Regex,
    /// A regular pattern every match of this one also matches, for the
    /// literals each match holds.
    pub(crate) regular: String,
    bytes: bool,
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
        let regex = RegexBuilder::new(&source)
            .bytes_mode(if mode.bytes {
                BytesMode::Ascii
            } else {
                BytesMode::UnicodeBytes
            })
            .backtrack_limit(BACKTRACK_LIMIT)
            .build()
            .map_err(|err| PcreError {
                message: format!("{err} is not supported in mirage"),
                offset: 0,
            })?;
        Ok(Self {
            regex,
            regular: translated.regular,
            bytes: mode.bytes,
        })
    }

    /// The leftmost match in `record` that starts at or after `at`, its
    /// start past any `\K`.
    pub(crate) fn find(
        &self,
        record: &[u8],
        at: usize,
    ) -> Result<Option<(usize, usize)>, Exceeded> {
        match self.regex.find_from_pos(record, at) {
            Ok(found) => Ok(found.map(|m| (m.start(), m.end()))),
            Err(err) => {
                log_exceeded(&err);
                Err(Exceeded)
            }
        }
    }

    /// Like `find`, with every group's span written to `groups` (group 0
    /// the whole match); false when nothing matches.
    pub(crate) fn captures(
        &self,
        record: &[u8],
        at: usize,
        groups: &mut Vec<Option<(usize, usize)>>,
    ) -> Result<bool, Exceeded> {
        groups.clear();
        match self.regex.captures_from_pos(record, at) {
            Ok(Some(found)) => {
                groups.extend(
                    (0..self.group_count()).map(|i| found.get(i).map(|m| (m.start(), m.end()))),
                );
                Ok(true)
            }
            Ok(None) => Ok(false),
            Err(err) => {
                log_exceeded(&err);
                Err(Exceeded)
            }
        }
    }

    /// The groups the pattern numbers, group 0 included.
    pub(crate) fn group_count(&self) -> usize {
        self.regex.captures_len()
    }

    /// Each named group and its number.
    pub(crate) fn capture_names(&self) -> impl Iterator<Item = (&str, usize)> {
        self.regex
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
