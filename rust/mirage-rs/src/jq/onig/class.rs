// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regparse.c and src/unicode.c. See licenses/third_party/oniguruma.txt.

use std::cmp::Ordering;
use std::sync::OnceLock;

use regex_syntax::ParserBuilder;
use regex_syntax::hir::{Class, ClassUnicode, ClassUnicodeRange, HirKind};

/// The characters a class, `\w` or a caseless literal matches.
pub(super) type Set = ClassUnicode;

/// Oniguruma's character types: `\d`, `\s`, the POSIX brackets and the
/// `\p{...}` names of the same words.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Ctype {
    Alnum,
    Alpha,
    Blank,
    Cntrl,
    Digit,
    Graph,
    Lower,
    Print,
    Punct,
    Space,
    Upper,
    Xdigit,
    Word,
    Ascii,
}

const CTYPES: [(&str, Ctype); 14] = [
    ("alnum", Ctype::Alnum),
    ("alpha", Ctype::Alpha),
    ("blank", Ctype::Blank),
    ("cntrl", Ctype::Cntrl),
    ("digit", Ctype::Digit),
    ("graph", Ctype::Graph),
    ("lower", Ctype::Lower),
    ("print", Ctype::Print),
    ("punct", Ctype::Punct),
    ("space", Ctype::Space),
    ("upper", Ctype::Upper),
    ("xdigit", Ctype::Xdigit),
    ("word", Ctype::Word),
    ("ascii", Ctype::Ascii),
];

/// A Unicode property regex-syntax resolves, as `\p{...}` spells it.
fn unicode(pattern: &str) -> Option<Set> {
    let hir = ParserBuilder::new().build().parse(pattern).ok()?;
    match hir.into_kind() {
        HirKind::Class(Class::Unicode(set)) => Some(set),
        _ => None,
    }
}

fn known(pattern: &str) -> Set {
    unicode(pattern).unwrap_or_else(|| unreachable!("regex-syntax knows {pattern}"))
}

pub(super) fn single(c: char) -> Set {
    range(c, c)
}

pub(super) fn range(from: char, to: char) -> Set {
    Set::new([ClassUnicodeRange::new(from, to)])
}

fn union(mut set: Set, other: &Set) -> Set {
    set.union(other);
    set
}

pub(super) fn negate(mut set: Set) -> Set {
    set.negate();
    set
}

/// The class holding `codes`, skipping any that is no character.
pub(super) fn codes(codes: impl IntoIterator<Item = u32>) -> Set {
    Set::new(
        codes
            .into_iter()
            .filter_map(char::from_u32)
            .map(|c| ClassUnicodeRange::new(c, c)),
    )
}

pub(super) fn contains(set: &Set, code: u32) -> bool {
    set.ranges()
        .binary_search_by(|r| {
            if (r.end() as u32) < code {
                Ordering::Less
            } else if (r.start() as u32) > code {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        })
        .is_ok()
}

/// `\w`, `\b`'s words and `\p{Word}`: `[[:word:]]` and the Latin-1
/// digits Oniguruma's single-byte table counts as word characters.
pub(super) fn word() -> &'static Set {
    static WORD: OnceLock<Set> = OnceLock::new();
    WORD.get_or_init(|| known(r"[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\xB2\xB3\xB9\xBC-\xBE]"))
}

/// A character type: as a POSIX bracket names it when `bracket`, else as
/// `\d`, `\s` or `\p{...}` do; the two differ in `punct` and `word`.
pub(super) fn ctype(ctype: Ctype, bracket: bool) -> &'static Set {
    static TABLES: [OnceLock<Set>; 15] = [const { OnceLock::new() }; 15];
    let graph = r"[^\p{White_Space}\p{Cc}\p{Cn}]";
    let (index, pattern) = match (ctype, bracket) {
        (Ctype::Alnum, _) => (0, r"[\p{Alphabetic}\p{Nd}]"),
        (Ctype::Alpha, _) => (1, r"\p{Alphabetic}"),
        (Ctype::Blank, _) => (2, r"[\p{Zs}\t]"),
        (Ctype::Cntrl, _) => (3, r"\p{Cc}"),
        (Ctype::Digit, _) => (4, r"\p{Nd}"),
        (Ctype::Graph, _) => (5, graph),
        (Ctype::Lower, _) => (6, r"\p{Lowercase}"),
        (Ctype::Print, _) => (7, graph),
        (Ctype::Punct, true) => (8, r"[\p{P}\p{S}]"),
        (Ctype::Punct, false) => (9, r"\p{P}"),
        (Ctype::Space, _) => (10, r"\p{White_Space}"),
        (Ctype::Upper, _) => (11, r"\p{Uppercase}"),
        (Ctype::Xdigit, _) => (12, r"[0-9A-Fa-f]"),
        (Ctype::Word, true) => (13, r"[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}]"),
        (Ctype::Word, false) => return word(),
        (Ctype::Ascii, _) => (14, r"[\x00-\x7F]"),
    };
    TABLES[index].get_or_init(|| {
        let set = known(pattern);
        if ctype == Ctype::Print {
            union(set, &known(r"\p{Zs}"))
        } else {
            set
        }
    })
}

/// What `\p{name}` matches: an error says whether the name is one
/// Oniguruma knows (a block) that this engine does not support.
pub(super) fn property(name: &str) -> Result<Set, bool> {
    if !name.is_ascii() {
        return Err(false);
    }
    let loose: String = name
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_'))
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if loose.is_empty() || !loose.chars().all(|c| c.is_ascii_alphanumeric() || c == '&') {
        return Err(false);
    }
    if let Some((_, ctype)) = CTYPES.iter().find(|(known, _)| *known == loose) {
        return Ok(ctype_set(*ctype));
    }
    let found = match loose.as_str() {
        "any" => Some(negate(Set::empty())),
        "assigned" => unicode(r"\P{Cn}"),
        "l&" => unicode(r"\p{LC}"),
        _ => unicode(&format!(r"\p{{gc={loose}}}"))
            .or_else(|| unicode(&format!(r"\p{{sc={loose}}}")))
            .or_else(|| unicode(&format!(r"\p{{{loose}}}"))),
    };
    found.ok_or(loose.starts_with("in"))
}

fn ctype_set(ctype: Ctype) -> Set {
    match ctype {
        Ctype::Word => word().clone(),
        ctype => self::ctype(ctype, false).clone(),
    }
}
