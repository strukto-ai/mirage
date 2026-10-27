//! Where GNU patch 2.8 places a section's hunks in a file, and what it
//! reports and rejects doing it. Lines compare with the newline each ends
//! with, so a last line without one matches only a hunk line a `\` line
//! marks so.

use super::parse::{Hunk, Line};

/// The fuzz factor the manual gives as patch's default: a hunk may leave
/// up to this many of its outer context lines unmatched to be placed.
const FUZZ_FACTOR: i64 = 2;

/// What a hunk looks for in the file: its old side (context and removed
/// lines), the context lines before its first change and after its last,
/// and the line its header says the old side starts at. An empty old side
/// (`-3,0`) goes in after the line it names, so it claims the line after
/// that.
struct Needle<'a> {
    old: Vec<&'a [u8]>,
    lead: usize,
    trail: usize,
    claimed: i64,
}

fn needle<'a>(hunk: &Hunk<'a>) -> Needle<'a> {
    let context = |line: &&Line<'_>| line.kind == b' ';
    let lead = hunk.body.iter().take_while(context).count();
    let trail = hunk.body[lead..].iter().rev().take_while(context).count();
    let old: Vec<&[u8]> = hunk
        .body
        .iter()
        .filter(|line| line.kind != b'+')
        .map(|line| line.text)
        .collect();
    let claimed = hunk.old_start + i64::from(old.is_empty());
    Needle {
        old,
        lead,
        trail,
        claimed,
    }
}

/// The context lines still compared above and below at `fuzz`. Fuzz is
/// spent on the longer end first: a hunk with three lines of context above
/// its change and one below compares (3, 1) at fuzz 0, (2, 1) at fuzz 1
/// and (1, 1) at fuzz 2.
fn compared_at(needle: &Needle<'_>, fuzz: i64) -> (usize, usize) {
    let most = needle.lead.max(needle.trail) as i64 - fuzz;
    let keep = |side: usize| (side as i64).min(most).max(0) as usize;
    (keep(needle.lead), keep(needle.trail))
}

/// Whether the hunk's old side, starting at 0-based line `at`, is there,
/// reading only the context `compared` keeps. Lines left out above may
/// hang off the top of the file, but nothing may run past its end except
/// what is left out below. A hunk with less context at one end than at
/// the other was cut short by that end of the file, so while that still
/// holds it must meet it: a short bottom ends on the file's last line, and
/// a short top whose header names line 1 starts on the first. Such a hunk
/// is not found at all, rather than found out of order, where it would
/// reach back into what earlier hunks used up: one meeting the end must
/// start at or after `used`, and one meeting the start must make its first
/// change at or after it.
fn sits(
    lines: &[&[u8]],
    needle: &Needle<'_>,
    at: i64,
    compared: (usize, usize),
    used: i64,
) -> bool {
    let (above, below) = compared;
    let top = needle.lead - above;
    let stop = needle.old.len() - needle.trail + below;
    let len = lines.len() as i64;
    if at + stop as i64 > len || (top < stop && at + (top as i64) < 0) {
        return false;
    }
    if above > below && (at + needle.old.len() as i64 != len || at < used) {
        return false;
    }
    if above < below && needle.claimed <= 1 && (at != 0 || (needle.lead as i64) < used) {
        return false;
    }
    (top..stop).all(|index| lines[(at + index as i64) as usize] == needle.old[index])
}

/// The first line `found` takes, in the order GNU patch 2.8 tries a hunk.
/// From an expected line at or past `used` (the lines the hunks placed
/// before it used up) the search fans out: the expected line, one line
/// later, one earlier, two later and so on, so at equal distance the later
/// line wins, and it goes no higher than `used`. From an expected line
/// above `used` it reaches as far above the expected line as `used` is
/// below it, and tries that farthest line first, then `used`, then the
/// lines between them in file order, then the lines after `used`: with 20
/// lines used and a hunk expected at line 15 it tries 9, 21, 10, 11, ...,
/// 20, 22, ... (1-based). There, a hunk expected past the last line it
/// fits at (`last`) is not tried anywhere.
pub(super) fn search(
    expected: i64,
    used: i64,
    last: i64,
    mut found: impl FnMut(i64) -> bool,
) -> Option<i64> {
    if expected < used {
        if expected > last {
            return None;
        }
        let farthest = 2 * expected - used;
        return [farthest, used]
            .into_iter()
            .chain(farthest + 1..used.min(last + 1))
            .chain(used + 1..=last)
            .find(|&at| found(at));
    }
    if found(expected) {
        return Some(expected);
    }
    let mut step = 1;
    while expected + step <= last || expected - step >= used {
        if expected + step <= last && found(expected + step) {
            return Some(expected + step);
        }
        if expected - step >= used && found(expected - step) {
            return Some(expected - step);
        }
        step += 1;
    }
    None
}

/// Whether `search` ever tries line `at`.
pub(super) fn is_tried(at: i64, expected: i64, used: i64, last: i64) -> bool {
    if expected < used {
        let farthest = 2 * expected - used;
        return expected <= last
            && (at == farthest
                || at == used
                || (farthest < at && at < used.min(last + 1))
                || (used < at && at <= last));
    }
    at == expected || (expected < at && at <= last) || (used <= at && at < expected)
}

/// The 0-based line the hunk is found at with `fuzz`, or None. A hunk with
/// no old side is not looked for: it goes where it is expected. One held
/// to an end of the file (see `sits`) is tried at that one line, if the
/// search would reach it, instead of at every line the search tries. One
/// that lands on the line before the first, line 0, is taken as not found
/// at all, though one landing higher still is found there (GNU: `-0,0`
/// expected one line up fails plainly, expected two lines up it fails as
/// misordered).
fn seek(lines: &[&[u8]], needle: &Needle<'_>, fuzz: i64, expected: i64, used: i64) -> Option<i64> {
    let mut found = Some(expected);
    if !needle.old.is_empty() {
        let compared = compared_at(needle, fuzz);
        let (above, below) = compared;
        let last = lines.len() as i64 - (needle.old.len() - needle.trail + below) as i64;
        let edge = if above > below {
            Some(lines.len() as i64 - needle.old.len() as i64)
        } else if above < below && needle.claimed <= 1 {
            Some(0)
        } else {
            None
        };
        let sits = |at| sits(lines, needle, at, compared, used);
        found = match edge {
            None => search(expected, used, last, sits),
            Some(edge) => (is_tried(edge, expected, used, last) && sits(edge)).then_some(edge),
        };
    }
    found.filter(|&at| at != -1)
}

/// The fuzz levels worth trying, each one comparing less than the last.
fn fuzz_steps(needle: &Needle<'_>) -> Vec<i64> {
    let mut steps: Vec<i64> = Vec::new();
    for fuzz in 0..=FUZZ_FACTOR {
        let seen = steps.last().map(|&last| compared_at(needle, last));
        if seen != Some(compared_at(needle, fuzz)) {
            steps.push(fuzz);
        }
    }
    steps
}

/// Write the hunk's changes, placed at 0-based line `at`, onto `out`, and
/// return the line after the last one it changed. Only the part from its
/// first change to its last is written: the context around it stays in
/// the file, where a later hunk may still read it, and context between
/// changes is copied from the file rather than from the patch.
fn emit<'a>(
    lines: &[&'a [u8]],
    hunk: &Hunk<'a>,
    needle: &Needle<'_>,
    at: i64,
    out: &mut Vec<&'a [u8]>,
) -> i64 {
    let mut source = at + needle.lead as i64;
    for line in &hunk.body[needle.lead..hunk.body.len() - needle.trail] {
        match line.kind {
            b'+' => {
                out.push(line.text);
                continue;
            }
            b' ' => out.push(lines[source as usize]),
            _ => {}
        }
        source += 1;
    }
    source
}

fn placed_note(ordinal: usize, line: i64, fuzz: i64, moved: i64) -> String {
    let mut text = format!("Hunk #{ordinal} succeeded at {line}");
    if fuzz != 0 {
        text += &format!(" with fuzz {fuzz}");
    }
    if moved != 0 {
        let plural = if moved == 1 { "" } else { "s" };
        text += &format!(" (offset {moved} line{plural})");
    }
    text + "."
}

/// GNU's lines for a patch that reads as the other direction. Standard
/// input is never a terminal here, so every question is answered with its
/// default and the file is skipped.
fn reversed_notes(reverse: bool, forward: bool) -> Vec<String> {
    let seen = if reverse {
        "Unreversed patch detected!"
    } else {
        "Reversed (or previously applied) patch detected!"
    };
    if forward {
        return vec![format!("{seen}  Skipping patch.")];
    }
    let ask = if reverse { "Ignore" } else { "Assume" };
    vec![
        format!("{seen}  {ask} -R? [n] "),
        "Apply anyway? [n] ".to_owned(),
        "Skipping patch.".to_owned(),
    ]
}

/// The section's hunks as they are tried (`-R` swaps them), for a reject
/// file, each with no lines added before it.
pub(super) fn as_tried<'a>(hunks: &[Hunk<'a>], reverse: bool) -> Vec<(Hunk<'a>, i64)> {
    hunks.iter().map(|hunk| (hunk.tried(reverse), 0)).collect()
}

/// What applying one section did: the patched lines (None when skipped),
/// the lines GNU prints after `patching file`, the hunks for the reject
/// file as tried, each with the lines the hunks placed before it added,
/// and whether every hunk applied where it said with no fuzz.
pub(super) struct Outcome<'a> {
    pub(super) lines: Option<Vec<&'a [u8]>>,
    pub(super) notes: Vec<String>,
    pub(super) rejected: Vec<(Hunk<'a>, i64)>,
    pub(super) exact: bool,
}

/// Apply one section's hunks to a file's lines, as GNU patch does. Each
/// hunk is looked for where its header and the hunks before it point, at
/// fuzz 0 and then with more of its outer context left out; one found
/// nowhere is rejected. A hunk found where its change would land on lines
/// an earlier hunk already changed is rejected too, and no further fuzz is
/// tried for it. When the first hunk is not found but reads at that same
/// fuzz the other way round, the file is skipped as already applied (or
/// reversed). Lines are reported in the patched file's numbering.
pub(super) fn section<'a>(
    lines: &[&'a [u8]],
    hunks: &[Hunk<'a>],
    reverse: bool,
    forward: bool,
) -> Outcome<'a> {
    let mut out = Vec::with_capacity(lines.len());
    let mut notes = Vec::new();
    let mut rejected = Vec::new();
    let mut exact = true;
    let (mut used, mut shift, mut grown) = (0i64, 0i64, 0i64);
    for (index, given) in hunks.iter().enumerate() {
        let ordinal = index + 1;
        let hunk = given.tried(reverse);
        let want = needle(&hunk);
        let other = (ordinal == 1).then(|| needle(&hunk.swapped()));
        let expected = want.claimed - 1 + shift;
        let mut placed = None;
        for fuzz in fuzz_steps(&want) {
            if let Some(at) = seek(lines, &want, fuzz, expected, used) {
                placed = Some((at, fuzz));
                break;
            }
            if let Some(other) = &other {
                if seek(lines, other, fuzz, other.claimed - 1, 0).is_some() {
                    return Outcome {
                        lines: None,
                        notes: reversed_notes(reverse, forward),
                        rejected: as_tried(hunks, reverse),
                        exact: false,
                    };
                }
            }
        }
        let Some((at, fuzz)) = placed.filter(|&(at, _)| at + want.lead as i64 >= used) else {
            let line = match placed {
                Some((at, _)) => {
                    notes.push("misordered hunks! output would be garbled".to_owned());
                    shift = at + 1 - want.claimed;
                    at + 1
                }
                None => want.claimed,
            };
            notes.push(format!("Hunk #{ordinal} FAILED at {}.", line + grown));
            rejected.push((hunk, grown));
            exact = false;
            continue;
        };
        shift = at + 1 - want.claimed;
        if fuzz != 0 || shift != 0 {
            notes.push(placed_note(ordinal, at + 1 + grown, fuzz, shift));
            exact = false;
        }
        out.extend_from_slice(window(lines, used, at + want.lead as i64));
        used = emit(lines, &hunk, &want, at, &mut out);
        let (old, new) = hunk.sizes();
        grown += new - old;
    }
    out.extend_from_slice(window(lines, used, lines.len() as i64));
    Outcome {
        lines: Some(out),
        notes,
        rejected,
        exact,
    }
}

/// The file's lines from `from` to `to`, as far as the file goes: a hunk
/// with no old side goes where it is expected, past the end or not.
fn window<'s, 'a>(lines: &'s [&'a [u8]], from: i64, to: i64) -> &'s [&'a [u8]] {
    let clamp = |at: i64| usize::try_from(at.max(0)).map_or(lines.len(), |at| at.min(lines.len()));
    &lines[clamp(from)..clamp(to).max(clamp(from))]
}

fn span(start: i64, count: i64) -> String {
    if count == 1 {
        start.to_string()
    } else {
        format!("{start},{count}")
    }
}

/// A hunk as GNU writes it back to a reject file: the `@@` line moved by
/// `grown` (the lines the hunks placed before it added), and each run of
/// changes listing its removed lines before its added ones, every line as
/// the patch ended it.
pub(super) fn reject(hunk: &Hunk<'_>, grown: i64, out: &mut Vec<u8>) {
    let (old, new) = hunk.sizes();
    let old = span(hunk.old_start + grown, old);
    let new = span(hunk.new_start + grown, new);
    out.extend_from_slice(format!("@@ -{old} +{new} @@").as_bytes());
    out.extend_from_slice(hunk.note);
    out.push(b'\n');
    let mut added: Vec<&Line<'_>> = Vec::new();
    let put = |line: &Line<'_>, out: &mut Vec<u8>| {
        out.push(line.kind);
        out.extend_from_slice(line.text);
    };
    for line in &hunk.body {
        if line.kind == b'+' {
            added.push(line);
            continue;
        }
        if line.kind == b' ' {
            for line in added.drain(..) {
                put(line, out);
            }
        }
        put(line, out);
    }
    for line in added {
        put(line, out);
    }
}
