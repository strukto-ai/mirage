//! An option's word read as one of its choices, as GNU's `argmatch` reads
//! it (coreutils 9.7): an exact word wins, otherwise every word the typed
//! one is a byte prefix of matches, and the match holds when those words
//! all name one value. Each choice is one value's spellings, its canonical
//! word first, so `--time=a` (`atime`, `access`) is one value and
//! `--time=c` (`ctime`, `creation`) two. The empty word is a prefix of
//! every word, so it is ambiguous whenever two values are offered.

use crate::{StreamError, quoted};

/// One value's spellings, its canonical word first.
pub(crate) type Choice = &'static [&'static str];

/// Why a word names no one choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unmatched {
    Ambiguous,
    Invalid,
}

/// The canonical word of the one choice `raw` names.
pub(crate) fn matched(raw: &[u8], choices: &[Choice]) -> Result<&'static str, Unmatched> {
    if let Some(choice) = choices
        .iter()
        .find(|words| words.iter().any(|word| word.as_bytes() == raw))
    {
        return Ok(choice[0]);
    }
    let mut prefixed = choices
        .iter()
        .filter(|words| words.iter().any(|word| word.as_bytes().starts_with(raw)));
    match (prefixed.next(), prefixed.next()) {
        (Some(choice), None) => Ok(choice[0]),
        (Some(_), Some(_)) => Err(Unmatched::Ambiguous),
        (None, _) => Err(Unmatched::Invalid),
    }
}

/// The refusal's first line: `cmd: invalid argument 'x' for '--time'`.
pub(crate) fn line(command: &str, option: &str, raw: &[u8], why: Unmatched) -> String {
    let kind = match why {
        Unmatched::Ambiguous => "ambiguous",
        Unmatched::Invalid => "invalid",
    };
    format!(
        "{command}: {kind} argument '{}' for '{option}'",
        quoted(raw)
    )
}

/// `Valid arguments are:`, one line per choice, its spellings quoted.
pub(crate) fn listed(choices: &[Choice]) -> String {
    choices
        .iter()
        .fold("Valid arguments are:".to_owned(), |mut block, words| {
            let words: Vec<String> = words.iter().map(|word| format!("'{word}'")).collect();
            block.push_str("\n  - ");
            block.push_str(&words.join(", "));
            block
        })
}

/// `raw` read as one of `choices`, or argmatch's refusal: the line, the
/// valid choices and the help hint, with `status`.
pub(crate) fn choose(
    command: &str,
    option: &str,
    raw: &[u8],
    choices: &[Choice],
    status: i32,
) -> Result<&'static str, StreamError> {
    matched(raw, choices).map_err(|why| {
        let refused = format!(
            "{}\n{}\nTry '{command} --help' for more information.",
            line(command, option, raw, why),
            listed(choices)
        );
        StreamError::refusal(refused.as_bytes(), status)
    })
}

#[cfg(test)]
mod tests {
    use super::{Choice, Unmatched, choose, matched};

    const TIME: &[Choice] = &[
        &["atime", "access", "use"],
        &["ctime", "status"],
        &["mtime", "modification"],
        &["birth", "creation"],
    ];
    const SORT: &[Choice] = &[&["none"], &["name"], &["size"]];

    #[test]
    fn an_exact_word_wins_over_a_longer_one() {
        let shells: &[Choice] = &[&["shell"], &["shell-always"]];
        assert_eq!(matched(b"shell", shells), Ok("shell"));
        assert_eq!(matched(b"status", TIME), Ok("ctime"));
    }

    #[test]
    fn a_prefix_names_the_one_value_its_words_share() {
        assert_eq!(matched(b"a", TIME), Ok("atime"));
        assert_eq!(matched(b"mod", TIME), Ok("mtime"));
        assert_eq!(matched(b"c", TIME), Err(Unmatched::Ambiguous));
        assert_eq!(matched(b"n", SORT), Err(Unmatched::Ambiguous));
        assert_eq!(matched(b"", SORT), Err(Unmatched::Ambiguous));
        assert_eq!(matched(b"", &[&["only", "one"]]), Ok("only"));
        assert_eq!(matched(b"NON", SORT), Err(Unmatched::Invalid));
        assert_eq!(matched(b"nonex", SORT), Err(Unmatched::Invalid));
    }

    #[test]
    fn the_refusal_lists_each_value_on_its_line_and_escapes_the_word() {
        let err = choose("ls", "--time", "x\u{e9}".as_bytes(), TIME, 1).expect_err("refused");
        assert_eq!(err.status, 1);
        assert_eq!(
            String::from_utf8(err.stderr()).expect("ascii"),
            "ls: invalid argument 'x\\303\\251' for '--time'\n\
             Valid arguments are:\n  \
             - 'atime', 'access', 'use'\n  \
             - 'ctime', 'status'\n  \
             - 'mtime', 'modification'\n  \
             - 'birth', 'creation'\n\
             Try 'ls --help' for more information."
        );
    }
}
