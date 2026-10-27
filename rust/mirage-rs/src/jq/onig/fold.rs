// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/unicode.c, src/regcomp.c, src/regexec.c, src/regparse.c. See licenses/third_party/oniguruma.txt.

use std::collections::BTreeMap;
use std::iter::once;
use std::sync::OnceLock;

use super::class::{self, Set};
use super::parse::{Node, seq};
use crate::generated::unicode_case_fold::FOLDS;

/// Each folding and the codes that fold to it (Oniguruma's unfold
/// tables), by folding; `multi` indexes the foldings of several codes by
/// length, then codes.
struct Tables {
    unfolds: Vec<(&'static [u32], Vec<u32>)>,
    multi: Vec<usize>,
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut by_key: BTreeMap<&'static [u32], Vec<u32>> = BTreeMap::new();
        for &(code, mapping) in FOLDS {
            by_key.entry(mapping).or_default().push(code);
        }
        let unfolds: Vec<(&'static [u32], Vec<u32>)> = by_key.into_iter().collect();
        let mut multi: Vec<usize> = (0..unfolds.len())
            .filter(|&i| unfolds[i].0.len() > 1)
            .collect();
        multi.sort_by_key(|&i| (unfolds[i].0.len(), unfolds[i].0));
        Tables { unfolds, multi }
    })
}

/// What `code` folds to, when it folds.
fn fold(code: u32) -> Option<&'static [u32]> {
    FOLDS
        .binary_search_by_key(&code, |&(c, _)| c)
        .ok()
        .map(|i| FOLDS[i].1)
}

/// The codes whose folding is exactly `key`, ascending.
fn unfolds(key: &[u32]) -> &'static [u32] {
    let tables = tables();
    match tables
        .unfolds
        .binary_search_by(|(known, _)| (*known).cmp(key))
    {
        Ok(i) => &tables.unfolds[i].1,
        Err(_) => &[],
    }
}

/// `code` folded when it folds to one code, else itself: what a key of
/// several characters is built from.
fn simple(code: u32) -> u32 {
    match fold(code) {
        Some(&[f]) => f,
        _ => code,
    }
}

/// `code` and the codes that fold to it.
fn siblings(code: u32) -> Vec<u32> {
    once(code).chain(unfolds(&[code]).iter().copied()).collect()
}

/// Every pick of one code from each set, in nested loop order.
fn combinations(sets: &[Vec<u32>]) -> Vec<Vec<u32>> {
    sets.iter().fold(vec![Vec::new()], |prefixes, set| {
        prefixes
            .iter()
            .flat_map(|prefix| {
                set.iter().map(move |&code| {
                    let mut pick = prefix.clone();
                    pick.push(code);
                    pick
                })
            })
            .collect()
    })
}

/// The sequences that match the start of `codes` ignoring case, the
/// original left out, and how many of its characters they cover: a key
/// of three characters wins over one of two, which wins over the first
/// character's own folding (unicode.c
/// onigenc_unicode_get_case_fold_codes_by_str).
fn string(codes: &[u32]) -> (usize, Vec<Vec<u32>>) {
    let keys: Vec<u32> = codes.iter().map(|&c| simple(c)).collect();
    for n in [3, 2] {
        if codes.len() < n {
            continue;
        }
        let whole = unfolds(&keys[..n]);
        if whole.is_empty() {
            continue;
        }
        let mut alts: Vec<Vec<u32>> = whole.iter().map(|&c| vec![c]).collect();
        let sets: Vec<Vec<u32>> = keys[..n].iter().map(|&k| siblings(k)).collect();
        alts.extend(
            combinations(&sets)
                .into_iter()
                .filter(|pick| pick[..] != codes[..n]),
        );
        return (n, alts);
    }
    let first = codes[0];
    let alts = match fold(first) {
        Some(&[f]) => once(f)
            .chain(unfolds(&[f]).iter().copied().filter(|&u| u != first))
            .map(|c| vec![c])
            .collect(),
        Some(mapping) => {
            let mut alts: Vec<Vec<u32>> = unfolds(mapping)
                .iter()
                .filter(|&&u| u != first)
                .map(|&u| vec![u])
                .collect();
            let sets: Vec<Vec<u32>> = mapping.iter().map(|&k| siblings(k)).collect();
            alts.extend(combinations(&sets));
            alts
        }
        None => unfolds(&[first]).iter().map(|&c| vec![c]).collect(),
    };
    (1, alts)
}

fn exact(codes: &[u32]) -> Node {
    seq(codes
        .iter()
        .filter_map(|&code| char::from_u32(code))
        .map(Node::Char)
        .collect())
}

/// The nodes a run of caseless literals matches (regcomp.c
/// unravel_case_fold_string): a class where every alternative is one
/// character, else the run and its alternatives in order. Inside a
/// look-behind each character folds to one character only.
fn run(chars: &[char], in_behind: bool) -> Vec<Node> {
    let codes: Vec<u32> = chars.iter().map(|&c| c as u32).collect();
    let mut out = Vec::new();
    let mut p = 0;
    while p < codes.len() {
        let window = if in_behind { 1 } else { 3 };
        let (n, mut alts) = string(&codes[p..(p + window).min(codes.len())]);
        if in_behind {
            alts.retain(|alt| alt.len() == 1);
        }
        if alts.is_empty() {
            out.push(Node::Char(chars[p]));
        } else if alts.iter().all(|alt| alt.len() == 1) {
            let members = once(codes[p]).chain(alts.iter().map(|alt| alt[0]));
            out.push(Node::Set(Box::new(class::codes(members))));
        } else {
            let mut branches = vec![exact(&codes[p..p + n])];
            branches.extend(alts.iter().map(|alt| exact(alt)));
            out.push(Node::Alt(branches));
        }
        p += n;
    }
    out
}

/// `items` with every nested sequence spliced in, as Oniguruma's
/// parse_branch splices a `(?:...)` list into its parent.
fn splice(items: Vec<Node>) -> Vec<Node> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Node::Seq(inner) => out.extend(splice(inner)),
            item => out.push(item),
        }
    }
    out
}

fn flush(out: &mut Vec<Node>, chars: &mut Vec<char>, in_behind: bool) {
    if !chars.is_empty() {
        out.extend(run(chars, in_behind));
        chars.clear();
    }
}

/// Rewrites every caseless literal into what it matches: consecutive
/// ones in a sequence fold together as one string, anything else bounds
/// a run.
pub(super) fn unravel(node: Node, in_behind: bool) -> Node {
    match node {
        Node::Caseless(c) => seq(run(&[c], in_behind)),
        Node::Seq(items) => {
            let mut out = Vec::new();
            let mut chars = Vec::new();
            for item in splice(items) {
                match item {
                    Node::Caseless(c) => chars.push(c),
                    item => {
                        flush(&mut out, &mut chars, in_behind);
                        out.push(unravel(item, in_behind));
                    }
                }
            }
            flush(&mut out, &mut chars, in_behind);
            seq(out)
        }
        Node::Alt(items) => Node::Alt(
            items
                .into_iter()
                .map(|item| unravel(item, in_behind))
                .collect(),
        ),
        Node::Group(index, body) => Node::Group(index, Box::new(unravel(*body, in_behind))),
        Node::Repeat {
            body,
            min,
            max,
            greedy,
        } => Node::Repeat {
            body: Box::new(unravel(*body, in_behind)),
            min,
            max,
            greedy,
        },
        Node::Atomic(body) => Node::Atomic(Box::new(unravel(*body, in_behind))),
        Node::Options(body) => Node::Options(Box::new(unravel(*body, in_behind))),
        Node::Look {
            behind,
            negate,
            body,
        } => Node::Look {
            behind,
            negate,
            body: Box::new(unravel(*body, in_behind || behind)),
        },
        Node::Cond(groups, Some((yes, no))) => Node::Cond(
            groups,
            Some((
                Box::new(unravel(*yes, in_behind)),
                Box::new(unravel(*no, in_behind)),
            )),
        ),
        node => node,
    }
}

/// `set` closed under folding to one character: a class holding any
/// member of an equivalence class holds all of it (regparse.c
/// i_apply_case_fold).
pub(super) fn close(mut set: Set) -> Set {
    let mut added = Vec::new();
    for (key, sources) in &tables().unfolds {
        let members: Vec<u32> = match **key {
            [f] => once(f).chain(sources.iter().copied()).collect(),
            _ => sources.clone(),
        };
        if members.iter().any(|&code| class::contains(&set, code)) {
            added.extend(members);
        }
    }
    set.union(&class::codes(added));
    set
}

/// The strings a class matches besides its characters: for every folding
/// to several characters one of whose sources is in `set`, that folding,
/// each character of it with its own case variants.
pub(super) fn alternatives(set: &Set) -> Vec<Node> {
    let tables = tables();
    tables
        .multi
        .iter()
        .map(|&i| &tables.unfolds[i])
        .filter(|(_, sources)| sources.iter().any(|&code| class::contains(set, code)))
        .map(|(mapping, _)| {
            Node::Seq(
                mapping
                    .iter()
                    .map(|&code| {
                        let variants = unfolds(&[code]);
                        if variants.is_empty() {
                            exact(&[code])
                        } else {
                            Node::Set(Box::new(class::codes(
                                once(code).chain(variants.iter().copied()),
                            )))
                        }
                    })
                    .collect(),
            )
        })
        .collect()
}

/// A character's case folding in UTF-8, as a backreference compares it.
pub(super) struct Folded {
    bytes: [u8; 12],
    len: usize,
}

impl Folded {
    pub(super) fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

/// The folding of the character at `p` in `hay`, read up to `end`, and
/// moves `p` past the character's declared length (utf8.c mbc_to_code,
/// unicode.c onigenc_unicode_mbc_case_fold): a character `end` cuts
/// decodes from the bytes before it; one that does not fold is its own
/// bytes, or None when they run past `hay`.
pub(super) fn case_fold(hay: &[u8], p: &mut usize, end: usize) -> Option<Folded> {
    let start = *p;
    let lead = hay[start];
    let declared = match lead {
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    };
    let avail = declared.min(end - start);
    *p += declared;
    let code = if avail > 1 {
        hay[start + 1..start + avail]
            .iter()
            .fold(u32::from(lead) & ((1 << (7 - avail)) - 1), |code, &b| {
                (code << 6) | (u32::from(b) & 0x3F)
            })
    } else {
        u32::from(lead)
    };
    let mut folded = Folded {
        bytes: [0; 12],
        len: 0,
    };
    match fold(code) {
        Some(mapping) => {
            for &c in mapping {
                let ch = char::from_u32(c)?;
                let len = ch.encode_utf8(&mut folded.bytes[folded.len..]).len();
                folded.len += len;
            }
        }
        None => {
            let raw = hay.get(start..start + declared)?;
            folded.bytes[..declared].copy_from_slice(raw);
            folded.len = declared;
        }
    }
    Some(folded)
}
