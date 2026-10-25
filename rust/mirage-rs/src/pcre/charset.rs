//! Character sets as inclusive code point ranges, the algebra a PCRE2
//! class needs, and the Unicode sets the translator names.
// The \h and \v lists are those of PCRE2 10.43 and 10.46 (BSD-3-Clause
// WITH PCRE2-exception; see licenses/third_party/pcre2.txt).

use std::sync::OnceLock;

use regex_syntax::ParserBuilder;
use regex_syntax::hir::{Class, ClassUnicode, ClassUnicodeRange, HirKind};

pub(crate) const MAX_CODE_POINT: u32 = 0x10FFFF;
const SURROGATES: (u32, u32) = (0xD800, 0xDFFF);

/// A set of code points: sorted, merged, inclusive ranges. Negation is
/// over the Unicode scalar values, so a surrogate is never a member of a
/// negated set.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CharSet {
    ranges: Vec<(u32, u32)>,
}

impl CharSet {
    pub(crate) fn of(ranges: &[(u32, u32)]) -> Self {
        let mut sorted: Vec<(u32, u32)> = ranges.iter().copied().filter(|(a, b)| a <= b).collect();
        sorted.sort_unstable();
        let mut merged: Vec<(u32, u32)> = Vec::with_capacity(sorted.len());
        for (low, high) in sorted {
            match merged.last_mut() {
                Some(last) if low <= last.1.saturating_add(1) => last.1 = last.1.max(high),
                _ => merged.push((low, high)),
            }
        }
        Self { ranges: merged }
    }

    pub(crate) fn chars(code_points: &[u32]) -> Self {
        let ranges: Vec<(u32, u32)> = code_points.iter().map(|&cp| (cp, cp)).collect();
        Self::of(&ranges)
    }

    pub(crate) fn ranges(&self) -> &[(u32, u32)] {
        &self.ranges
    }

    pub(crate) fn union(&self, other: &CharSet) -> CharSet {
        let mut all = self.ranges.clone();
        all.extend_from_slice(&other.ranges);
        Self::of(&all)
    }

    pub(crate) fn negate(&self) -> CharSet {
        let mut out = Vec::new();
        let mut low = 0u32;
        for &(start, end) in &self.ranges {
            if start > low {
                out.push((low, start - 1));
            }
            low = end.saturating_add(1);
        }
        if low <= MAX_CODE_POINT && self.ranges.last().is_none_or(|r| r.1 < MAX_CODE_POINT) {
            out.push((low, MAX_CODE_POINT));
        }
        Self { ranges: out }.minus_surrogates()
    }

    fn minus_surrogates(&self) -> CharSet {
        let mut out = Vec::new();
        for &(low, high) in &self.ranges {
            if high < SURROGATES.0 || low > SURROGATES.1 {
                out.push((low, high));
                continue;
            }
            if low < SURROGATES.0 {
                out.push((low, SURROGATES.0 - 1));
            }
            if high > SURROGATES.1 {
                out.push((SURROGATES.1 + 1, high));
            }
        }
        Self { ranges: out }
    }

    pub(crate) fn intersect(&self, other: &CharSet) -> CharSet {
        let mut out = Vec::new();
        let (mut i, mut j) = (0, 0);
        while i < self.ranges.len() && j < other.ranges.len() {
            let low = self.ranges[i].0.max(other.ranges[j].0);
            let high = self.ranges[i].1.min(other.ranges[j].1);
            if low <= high {
                out.push((low, high));
            }
            if self.ranges[i].1 < other.ranges[j].1 {
                i += 1;
            } else {
                j += 1;
            }
        }
        Self { ranges: out }
    }

    pub(crate) fn minus(&self, other: &CharSet) -> CharSet {
        let surrogates = self.intersect(&CharSet::of(&[SURROGATES]));
        self.intersect(&other.negate().union(&surrogates))
    }

    pub(crate) fn contains(&self, cp: u32) -> bool {
        self.ranges
            .binary_search_by(|&(start, end)| {
                if cp < start {
                    std::cmp::Ordering::Greater
                } else if cp > end {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }

    pub(crate) fn single(&self) -> Option<u32> {
        match self.ranges.as_slice() {
            [(low, high)] if low == high => Some(*low),
            _ => None,
        }
    }

    fn to_class(&self) -> ClassUnicode {
        ClassUnicode::new(self.ranges.iter().filter_map(|&(low, high)| {
            let low = char::from_u32(low).or_else(|| char::from_u32(SURROGATES.1 + 1))?;
            let high = char::from_u32(high).or_else(|| char::from_u32(SURROGATES.0 - 1))?;
            (low <= high).then(|| ClassUnicodeRange::new(low, high))
        }))
    }

    fn from_class(class: &ClassUnicode) -> CharSet {
        let ranges: Vec<(u32, u32)> = class
            .iter()
            .map(|range| (range.start() as u32, range.end() as u32))
            .collect();
        Self::of(&ranges)
    }
}

pub(crate) fn all() -> CharSet {
    CharSet::of(&[(0, MAX_CODE_POINT)]).minus_surrogates()
}

pub(crate) const ASCII_DIGIT: &[(u32, u32)] = &[(0x30, 0x39)];
pub(crate) const ASCII_WORD: &[(u32, u32)] =
    &[(0x30, 0x39), (0x41, 0x5A), (0x5F, 0x5F), (0x61, 0x7A)];
pub(crate) const ASCII_SPACE: &[(u32, u32)] = &[(0x09, 0x0D), (0x20, 0x20)];
/// PCRE2's `\h` and `\v`, its fixed horizontal and vertical space lists,
/// whose union is its UCP `\s` (U+180E stays in `\h`).
pub(crate) const PCRE_HSPACE: &[(u32, u32)] = &[
    (0x09, 0x09),
    (0x20, 0x20),
    (0xA0, 0xA0),
    (0x1680, 0x1680),
    (0x180E, 0x180E),
    (0x2000, 0x200A),
    (0x202F, 0x202F),
    (0x205F, 0x205F),
    (0x3000, 0x3000),
];
pub(crate) const PCRE_VSPACE: &[(u32, u32)] = &[(0x0A, 0x0D), (0x85, 0x85), (0x2028, 0x2029)];
pub(crate) const NEWLINE_SEQUENCE: &[(u32, u32)] = &[(0x0A, 0x0D), (0x85, 0x85), (0x2028, 0x2029)];
const GRAPH_EXCLUDED: &[(u32, u32)] = &[(0x061C, 0x061C), (0x180E, 0x180E), (0x2066, 0x2069)];

/// The POSIX classes in their ASCII reading (PCRE2 without UCP).
pub(crate) fn ascii_class(name: &str) -> Option<CharSet> {
    let ranges: &[(u32, u32)] = match name {
        "alnum" => &[(0x30, 0x39), (0x41, 0x5A), (0x61, 0x7A)],
        "alpha" => &[(0x41, 0x5A), (0x61, 0x7A)],
        "ascii" => &[(0, 0x7F)],
        "blank" => &[(0x09, 0x09), (0x20, 0x20)],
        "cntrl" => &[(0, 0x1F), (0x7F, 0x7F)],
        "digit" => ASCII_DIGIT,
        "graph" => &[(0x21, 0x7E)],
        "lower" => &[(0x61, 0x7A)],
        "print" => &[(0x20, 0x7E)],
        "punct" => &[(0x21, 0x2F), (0x3A, 0x40), (0x5B, 0x60), (0x7B, 0x7E)],
        "space" => ASCII_SPACE,
        "upper" => &[(0x41, 0x5A)],
        "word" => ASCII_WORD,
        "xdigit" => &[(0x30, 0x39), (0x41, 0x46), (0x61, 0x66)],
        _ => return None,
    };
    Some(CharSet::of(ranges))
}

const GROUPS: &[(&str, &[&str])] = &[
    ("L", &["Lu", "Ll", "Lt", "Lm", "Lo"]),
    ("LC", &["Lu", "Ll", "Lt"]),
    ("M", &["Mn", "Mc", "Me"]),
    ("N", &["Nd", "Nl", "No"]),
    ("P", &["Pc", "Pd", "Ps", "Pe", "Pi", "Pf", "Po"]),
    ("S", &["Sm", "Sc", "Sk", "So"]),
    ("Z", &["Zs", "Zl", "Zp"]),
    ("C", &["Cc", "Cf", "Cs", "Co", "Cn"]),
];

/// UAX #44's long names for the General_Category values.
const LONG_NAMES: &[(&str, &str)] = &[
    ("letter", "L"),
    ("casedletter", "LC"),
    ("uppercaseletter", "Lu"),
    ("lowercaseletter", "Ll"),
    ("titlecaseletter", "Lt"),
    ("modifierletter", "Lm"),
    ("otherletter", "Lo"),
    ("mark", "M"),
    ("combiningmark", "M"),
    ("nonspacingmark", "Mn"),
    ("spacingmark", "Mc"),
    ("enclosingmark", "Me"),
    ("number", "N"),
    ("decimalnumber", "Nd"),
    ("digit", "Nd"),
    ("letternumber", "Nl"),
    ("othernumber", "No"),
    ("punctuation", "P"),
    ("punct", "P"),
    ("connectorpunctuation", "Pc"),
    ("dashpunctuation", "Pd"),
    ("openpunctuation", "Ps"),
    ("closepunctuation", "Pe"),
    ("initialpunctuation", "Pi"),
    ("finalpunctuation", "Pf"),
    ("otherpunctuation", "Po"),
    ("symbol", "S"),
    ("mathsymbol", "Sm"),
    ("currencysymbol", "Sc"),
    ("modifiersymbol", "Sk"),
    ("othersymbol", "So"),
    ("separator", "Z"),
    ("spaceseparator", "Zs"),
    ("lineseparator", "Zl"),
    ("paragraphseparator", "Zp"),
    ("other", "C"),
    ("control", "Cc"),
    ("cntrl", "Cc"),
    ("format", "Cf"),
    ("surrogate", "Cs"),
    ("privateuse", "Co"),
    ("unassigned", "Cn"),
];

/// A property regex-syntax's Unicode tables answer, as a set.
fn unicode_table(name: &str) -> CharSet {
    let hir = ParserBuilder::new()
        .unicode(true)
        .utf8(false)
        .build()
        .parse(&format!("\\p{{{name}}}"))
        .expect("a General_Category regex-syntax knows");
    match hir.kind() {
        HirKind::Class(Class::Unicode(class)) => CharSet::from_class(class),
        _ => CharSet::default(),
    }
}

/// One General_Category value or group, by its short name.
pub(crate) fn category(name: &str) -> CharSet {
    unicode_table(name)
}

fn loose(name: &str) -> String {
    name.chars()
        .filter(|ch| !(ch.is_whitespace() || *ch == '_' || *ch == '-'))
        .collect::<String>()
        .to_lowercase()
}

/// A General_Category spelling as its short name: case, spaces,
/// underscores and hyphens are ignored, and a `gc=` or
/// `General_Category=` prefix is allowed.
fn canonical_category(name: &str) -> Option<&'static str> {
    let mut key = loose(name);
    for prefix in ["generalcategory=", "gc=", "generalcategory:", "gc:"] {
        if let Some(rest) = key.strip_prefix(prefix) {
            key = rest.to_string();
        }
    }
    for (group, members) in GROUPS {
        if key == group.to_lowercase() {
            return Some(group);
        }
        if let Some(member) = members.iter().find(|m| key == m.to_lowercase()) {
            return Some(member);
        }
    }
    LONG_NAMES
        .iter()
        .find(|(long, _)| *long == key)
        .map(|(_, short)| *short)
}

/// A Unicode property PCRE2 and mirage spell alike: General_Category
/// values and groups, `Any`, `ASCII` and `Assigned`, or None.
fn unicode_property(name: &str) -> Option<CharSet> {
    match loose(name).as_str() {
        "any" => return Some(all()),
        "ascii" => return Some(CharSet::of(&[(0, 0x7F)])),
        "assigned" => return Some(category("Cn").negate()),
        _ => {}
    }
    canonical_category(name).map(category)
}

/// PCRE2's UCP `\w`: letters, numbers, Mn and Pc (10.43).
pub(crate) fn pcre_word() -> &'static CharSet {
    static WORD: OnceLock<CharSet> = OnceLock::new();
    WORD.get_or_init(|| {
        category("L")
            .union(&category("N"))
            .union(&category("Mn"))
            .union(&category("Pc"))
    })
}

/// A `\p` name as PCRE2 reads it, or None.
pub(crate) fn pcre_property(name: &str) -> Option<CharSet> {
    match name {
        "L&" => Some(category("LC")),
        "Xan" => Some(category("L").union(&category("N"))),
        "Xsp" | "Xps" => Some(CharSet::of(PCRE_HSPACE).union(&CharSet::of(PCRE_VSPACE))),
        "Xwd" => Some(pcre_word().clone()),
        _ => unicode_property(name),
    }
}

/// One POSIX class, under UCP as PCRE2 maps it to properties.
pub(crate) fn posix_set(name: &str, unicode: bool) -> Option<CharSet> {
    let ascii = ascii_class(name)?;
    if !unicode || name == "ascii" || name == "xdigit" {
        return Some(ascii);
    }
    let union = |parts: &[&str]| {
        parts
            .iter()
            .fold(CharSet::default(), |acc, part| acc.union(&category(part)))
    };
    Some(match name {
        "alpha" => union(&["L"]),
        "alnum" => union(&["L", "N"]),
        "digit" => union(&["Nd"]),
        "lower" => union(&["Ll"]),
        "upper" => union(&["Lu"]),
        "cntrl" => union(&["Cc"]),
        "space" => CharSet::of(PCRE_HSPACE).union(&CharSet::of(PCRE_VSPACE)),
        "blank" => CharSet::of(PCRE_HSPACE),
        "word" => pcre_word().clone(),
        _ => {
            let excluded = CharSet::of(GRAPH_EXCLUDED);
            let graph = union(&["L", "M", "N", "P", "S", "Cf"]).minus(&excluded);
            match name {
                "graph" => graph,
                "print" => graph.union(&category("Zs")).minus(&excluded),
                _ => category("P").union(&category("S").intersect(&CharSet::of(&[(0, 0x7F)]))),
            }
        }
    })
}

/// A set closed under simple case folding; `ascii_only` folds only the
/// ASCII letters into each other.
pub(crate) fn fold(cs: &CharSet, ascii_only: bool) -> CharSet {
    if ascii_only {
        let upper = cs.intersect(&CharSet::of(&[(0x41, 0x5A)]));
        let lower = cs.intersect(&CharSet::of(&[(0x61, 0x7A)]));
        let raised: Vec<(u32, u32)> = upper
            .ranges()
            .iter()
            .map(|(a, b)| (a + 32, b + 32))
            .collect();
        let lowered: Vec<(u32, u32)> = lower
            .ranges()
            .iter()
            .map(|(a, b)| (a - 32, b - 32))
            .collect();
        return cs
            .union(&CharSet::of(&raised))
            .union(&CharSet::of(&lowered));
    }
    let mut class = cs.to_class();
    class.case_fold_simple();
    cs.union(&CharSet::from_class(&class))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negation_skips_the_surrogates() {
        let set = CharSet::chars(&[0x41]).negate();
        assert!(!set.contains(0xD800));
        assert!(set.contains(0x40) && set.contains(0x42) && !set.contains(0x41));
        assert!(set.contains(MAX_CODE_POINT));
    }

    #[test]
    fn folding_links_kelvin_to_k_only_under_unicode() {
        let k = CharSet::chars(&[u32::from('k')]);
        assert!(fold(&k, false).contains(0x212A));
        assert!(!fold(&k, true).contains(0x212A));
        assert!(fold(&k, true).contains(u32::from('K')));
    }

    #[test]
    fn categories_answer_loose_spellings() {
        assert_eq!(pcre_property("lu"), pcre_property("Uppercase_Letter"));
        assert!(pcre_property("Greek").is_none());
        assert!(pcre_property("L&").unwrap().contains(u32::from('a')));
    }
}
