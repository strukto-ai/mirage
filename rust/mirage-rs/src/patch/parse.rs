//! A unified diff read into the file sections GNU patch 2.8 applies, each
//! line held with the newline it ends with.

use std::borrow::Cow;
use std::collections::HashSet;
use std::ops::Range;

/// One line of a hunk: `b' '`, `b'-'` or `b'+'`, and its text with the
/// newline it ends with, which a `\` line after it takes away.
#[derive(Clone, Copy)]
pub(super) struct Line<'a> {
    pub(super) kind: u8,
    pub(super) text: &'a [u8],
}

/// One `@@` hunk: where its header says each side starts, what the header
/// carries after the closing `@@`, its lines, and whether the patch ended
/// in the middle of a line while it was read, which GNU says before the
/// hunk's own line.
#[derive(Clone)]
pub(super) struct Hunk<'a> {
    pub(super) old_start: i64,
    pub(super) new_start: i64,
    pub(super) note: &'a [u8],
    pub(super) body: Vec<Line<'a>>,
    pub(super) cut: bool,
}

impl<'a> Hunk<'a> {
    /// The hunk the other way round, as `-R` reads it.
    pub(super) fn swapped(&self) -> Hunk<'a> {
        let flip = |line: &Line<'a>| Line {
            kind: match line.kind {
                b'-' => b'+',
                b'+' => b'-',
                kind => kind,
            },
            text: line.text,
        };
        Hunk {
            old_start: self.new_start,
            new_start: self.old_start,
            note: self.note,
            body: self.body.iter().map(flip).collect(),
            cut: self.cut,
        }
    }

    /// The hunk as it is tried: swapped under `-R`.
    pub(super) fn tried(&self, reverse: bool) -> Hunk<'a> {
        if reverse {
            self.swapped()
        } else {
            self.clone()
        }
    }

    /// Its old and new sides' line counts.
    pub(super) fn sizes(&self) -> (i64, i64) {
        let count = |skip: u8| self.body.iter().filter(|line| line.kind != skip).count() as i64;
        (count(b'+'), count(b'-'))
    }
}

/// How reading a section's hunks ended: at a line that is no hunk's, at a
/// last line the patch left without a newline right after them (GNU reads
/// it twice, and says so each time), or at a patch no hunk can be read
/// from, which ends the run (GNU's words for why, and whether the patch
/// ended in the middle of a line first).
#[derive(Clone, PartialEq, Debug)]
pub(super) enum End {
    Done,
    Cut,
    Fatal(Vec<u8>, bool),
}

/// A rename or copy a git header asks for, between the names of its
/// `diff --git` line as `-p` leaves them, none for a name it strips away:
/// GNU reads no other names for it, whatever its `rename` or `copy` lines
/// say.
#[derive(Clone)]
pub(super) struct Move {
    pub(super) copy: bool,
    pub(super) from: Option<Vec<u8>>,
    pub(super) to: Option<Vec<u8>>,
}

/// What a git diff's extended header asks beyond its hunks: a rename or
/// copy, the modes before and after, and whether it carries a binary
/// patch, which GNU does not apply.
#[derive(Clone, Default)]
pub(super) struct Git {
    pub(super) moved: Option<Move>,
    pub(super) old_mode: Option<u32>,
    pub(super) new_mode: Option<u32>,
    pub(super) binary: bool,
}

/// One file's part of a patch: what its reject file's `---` and `+++`
/// lines say; the names GNU picks the file among, in its order (old, new,
/// then `Index:` when both of those are left out), `-p` applied and a name
/// it strips away or `/dev/null` left out; which header names `/dev/null`;
/// the lines since the last section and the first hunk's line number,
/// which GNU shows when it finds no file; whether its CRs were stripped;
/// its hunks in order, how reading them ended, and its git header.
pub(super) struct Section<'a> {
    pub(super) old_label: Vec<u8>,
    pub(super) new_label: Vec<u8>,
    pub(super) names: Vec<Vec<u8>>,
    pub(super) old_null: bool,
    pub(super) new_null: bool,
    pub(super) leading: Range<usize>,
    pub(super) at: usize,
    pub(super) crlf: bool,
    pub(super) hunks: Vec<Hunk<'a>>,
    pub(super) end: End,
    pub(super) git: Option<Git>,
}

/// A patch's sections, and whether a last line it left without a newline
/// was reached between sections, which GNU says once at the end.
pub(super) struct Patch<'a> {
    pub(super) sections: Vec<Section<'a>>,
    pub(super) cut: bool,
}

/// The values a header number takes at most, so the placement arithmetic
/// on one never overflows.
const NUMBER: i64 = 1 << 48;

/// A line GNU makes up where the patch ends inside a hunk: blank context.
const BLANK: &[u8] = b" \n";

/// What GNU says each time it reads a last line left without a newline.
pub(super) const CUT: &str = "patch unexpectedly ends in middle of line";

/// A patch's or a file's lines, each with the newline it ends with; the
/// last may have none.
pub(super) fn lines(text: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut start = 0;
    for end in memchr::memchr_iter(b'\n', text) {
        lines.push(&text[start..=end]);
        start = end + 1;
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// The patch with GNU's CRs stripped, and the lines whose `+++` header
/// asked for it. A section whose `+++` header ends in CRLF is read with
/// the CR taken off every line of it that ends so, up to the next
/// section; the sections are those a first reading finds, so a hunk line
/// that only reads like a header changes nothing.
pub(super) fn strip_crs(patch: &[u8], strip: Option<usize>) -> (Cow<'_, [u8]>, HashSet<usize>) {
    let mut crlf = HashSet::new();
    let lines = lines(patch);
    let asks = |line: &&[u8]| line.starts_with(b"+++ ") && line.ends_with(b"\r\n");
    if !lines.iter().any(asks) {
        return (Cow::Borrowed(patch), crlf);
    }
    let first = sections(&lines, strip, &crlf);
    let mut stripped = vec![false; lines.len()];
    for (at, section) in first.sections.iter().enumerate() {
        if section.crlf {
            let next = first.sections.get(at + 1);
            let end = next.map_or(lines.len(), |next| next.leading.start);
            stripped[section.at - 2..end].fill(true);
            crlf.insert(section.at - 2);
        }
    }
    let mut out = Vec::with_capacity(patch.len());
    for (line, strip) in lines.into_iter().zip(stripped) {
        match line.strip_suffix(b"\r\n") {
            Some(body) if strip => {
                out.extend_from_slice(body);
                out.push(b'\n');
            }
            _ => out.extend_from_slice(line),
        }
    }
    (Cow::Owned(out), crlf)
}

pub(super) fn chomp(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\n").unwrap_or(line)
}

/// A patch name with `-p` leading components dropped, GNU's way: a run of
/// slashes is one separator, and a name with fewer components than `-p`
/// drops leaves no name at all. With no `-p` the name is its basename.
fn strip_name(name: &[u8], strip: Option<usize>) -> Option<&[u8]> {
    let Some(strip) = strip else {
        let cut = memchr::memrchr(b'/', name).map_or(0, |at| at + 1);
        return Some(&name[cut..]);
    };
    let mut rest = name;
    for _ in 0..strip {
        let cut = memchr::memchr(b'/', rest)?;
        rest = trim_slashes(&rest[cut..]);
    }
    Some(rest)
}

fn trim_slashes(name: &[u8]) -> &[u8] {
    let skip = name.iter().take_while(|&&b| b == b'/').count();
    &name[skip..]
}

/// A header line's name with the blanks around it gone, and the timestamp
/// after a tab.
fn name_and_stamp(rest: &[u8]) -> (&[u8], &[u8]) {
    let rest = chomp(rest);
    let (name, stamp) = match memchr::memchr(b'\t', rest) {
        Some(tab) => rest.split_at(tab),
        None => (rest, &b""[..]),
    };
    let blank = |b: &u8| b" \t\n\x0b\x0c\r".contains(b);
    let start = name.iter().position(|b| !blank(b)).unwrap_or(name.len());
    let end = name
        .iter()
        .rposition(|b| !blank(b))
        .map_or(start, |at| at + 1);
    (&name[start..end], stamp)
}

/// A name as a candidate for the file: `-p` applied, none for `/dev/null`
/// or a name `-p` strips away.
fn candidate(name: &[u8], strip: Option<usize>) -> Option<Vec<u8>> {
    if name == b"/dev/null" {
        return None;
    }
    let name = strip_name(name, strip)?;
    (!name.is_empty()).then(|| name.to_vec())
}

/// One side of a file's header: its candidate name, what a reject file
/// says for it (the file as `-p` leaves it, `/dev/null` when it leaves
/// nothing, then the timestamp), and whether it names `/dev/null`.
struct Side {
    name: Option<Vec<u8>>,
    label: Vec<u8>,
    null: bool,
}

impl Side {
    fn read(line: &[u8], strip: Option<usize>) -> Side {
        let (name, stamp) = name_and_stamp(&line[4..]);
        let stripped = if name == b"/dev/null" {
            None
        } else {
            strip_name(name, strip)
        };
        Side {
            name: candidate(name, strip),
            label: [stripped.unwrap_or(b"/dev/null"), stamp].concat(),
            null: name == b"/dev/null",
        }
    }

    fn none() -> Side {
        Side {
            name: None,
            label: b"/dev/null".to_vec(),
            null: false,
        }
    }
}

fn number(digits: &[u8]) -> Option<(i64, &[u8])> {
    let len = digits.iter().take_while(|b| b.is_ascii_digit()).count();
    let value = digits[..len].iter().fold(0i64, |value, &digit| {
        (value * 10 + i64::from(digit - b'0')).min(NUMBER)
    });
    (len > 0).then_some((value, &digits[len..]))
}

/// A side of a hunk header, `N` or `N,COUNT`; a count left out is 1.
fn side(text: &[u8]) -> Option<(i64, i64, &[u8])> {
    let (start, rest) = number(text)?;
    match rest.strip_prefix(b",") {
        Some(rest) => number(rest).map(|(count, rest)| (start, count, rest)),
        None => Some((start, 1, rest)),
    }
}

/// A `@@ -A,B +C,D @@` line's starts and counts, and what follows it.
fn header(line: &[u8]) -> Option<(i64, i64, i64, i64, &[u8])> {
    let (old_start, old_count, rest) = side(line.strip_prefix(b"@@ -")?)?;
    let (new_start, new_count, rest) = side(rest.strip_prefix(b" +")?)?;
    let note = chomp(rest.strip_prefix(b" @@")?);
    Some((old_start, old_count, new_start, new_count, note))
}

/// Take the newline from the line before a `\` line.
fn unterminate(body: &mut [Line<'_>]) {
    if let Some(last) = body.last_mut() {
        last.text = chomp(last.text);
    }
}

fn malformed(line: usize, text: &[u8], cut: bool) -> End {
    let at = format!("malformed patch at line {line}: ");
    End::Fatal([at.as_bytes(), text].concat(), cut)
}

/// The hunks that start at `lines[index]`, the index after them, and how
/// they ended. A hunk ends when its header's line counts are used up, as
/// GNU reads it, so a removed line that reads `-- x` is never taken for
/// the next file's header, and a line past a side's count is malformed.
/// Where the patch ends first, a hunk still wanting more than three new
/// lines is cut off; otherwise one with a change whose sides want as many
/// is filled with blank context, and any other is malformed. `cut` is
/// whether a last line without a newline was left off the end of `lines`,
/// and `crlf` whether a CRLF line is still to be read as its LF.
fn hunks<'a>(
    lines: &[&'a [u8]],
    mut index: usize,
    cut: bool,
    crlf: bool,
) -> (Vec<Hunk<'a>>, usize, End) {
    let mut hunks = Vec::new();
    while let Some(&line) = lines.get(index) {
        let Some((old_start, mut old_left, new_start, mut new_left, note)) = header(line) else {
            return (hunks, index, End::Done);
        };
        let mut hunk = Hunk {
            old_start,
            new_start,
            note,
            body: Vec::new(),
            cut: false,
        };
        let mut last = index + 1;
        index += 1;
        while old_left > 0 || new_left > 0 {
            let Some(&line) = lines.get(index) else {
                if new_left > 3 {
                    let end = End::Fatal(b"unexpected end of file in patch".to_vec(), cut);
                    return (hunks, index, end);
                }
                if old_left != new_left || hunk.body.iter().all(|line| line.kind == b' ') {
                    return (hunks, index, malformed(last, BLANK, cut));
                }
                hunk.cut = cut;
                for _ in 0..old_left {
                    hunk.body.push(Line {
                        kind: b' ',
                        text: &BLANK[1..],
                    });
                }
                hunks.push(hunk);
                return (hunks, index, End::Done);
            };
            let kind = if crlf && line == b"\r\n" {
                b'\n'
            } else {
                line[0]
            };
            match kind {
                b' ' | b'\n' if old_left > 0 && new_left > 0 => {
                    old_left -= 1;
                    new_left -= 1;
                }
                b'-' if old_left > 0 => old_left -= 1,
                b'+' if new_left > 0 => new_left -= 1,
                b'\\' if !hunk.body.is_empty() => {
                    unterminate(&mut hunk.body);
                    index += 1;
                    continue;
                }
                _ => return (hunks, index, malformed(index + 1, line, false)),
            }
            let (kind, text) = match kind {
                b'\n' => (b' ', line),
                kind => (kind, &line[1..]),
            };
            hunk.body.push(Line { kind, text });
            index += 1;
            last = index;
        }
        while lines.get(index).is_some_and(|line| line[0] == b'\\') {
            unterminate(&mut hunk.body);
            index += 1;
        }
        hunks.push(hunk);
        if cut && index == lines.len() {
            return (hunks, index, End::Cut);
        }
    }
    (hunks, index, End::Done)
}

/// A `diff --git` header being read: its two names as `-p` leaves them,
/// what its extended lines ask, which of them create or delete the file,
/// and the line after the last of them.
struct GitHead {
    old: Option<Vec<u8>>,
    new: Option<Vec<u8>>,
    git: Git,
    creates: bool,
    deletes: bool,
    end: usize,
}

/// A `diff --git a/x b/y` line's two names, as GNU reads them: the line
/// must hold just two words, so a name with a blank in it leaves none.
fn git_names(rest: &[u8]) -> Option<(&[u8], &[u8])> {
    let mut words = chomp(rest)
        .split(|&b| b == b' ')
        .filter(|word| !word.is_empty());
    match (words.next(), words.next(), words.next()) {
        (Some(old), Some(new), None) => Some((old, new)),
        _ => None,
    }
}

/// A mode as git writes it, in octal.
fn mode(text: &[u8]) -> Option<u32> {
    std::str::from_utf8(chomp(text))
        .ok()
        .and_then(|digits| u32::from_str_radix(digits.trim(), 8).ok())
}

impl GitHead {
    fn read(rest: &[u8], strip: Option<usize>, end: usize) -> GitHead {
        let names = git_names(rest);
        let side = |name: &[u8]| candidate(name, strip);
        GitHead {
            old: names.and_then(|(old, _)| side(old)),
            new: names.and_then(|(_, new)| side(new)),
            git: Git::default(),
            creates: false,
            deletes: false,
            end,
        }
    }

    /// Take one extended header line; false for a line that is none.
    fn take(&mut self, line: &[u8]) -> bool {
        let moved = |copy| Move {
            copy,
            from: self.old.clone(),
            to: self.new.clone(),
        };
        if let Some(rest) = line.strip_prefix(b"old mode ") {
            self.git.old_mode = mode(rest);
        } else if let Some(rest) = line.strip_prefix(b"new mode ") {
            self.git.new_mode = mode(rest);
        } else if let Some(rest) = line.strip_prefix(b"new file mode ") {
            self.git.new_mode = mode(rest);
            self.creates = true;
        } else if let Some(rest) = line.strip_prefix(b"deleted file mode ") {
            self.git.old_mode = mode(rest);
            self.deletes = true;
        } else if line.starts_with(b"rename from ") || line.starts_with(b"rename to ") {
            self.git.moved = Some(moved(false));
        } else if line.starts_with(b"copy from ") || line.starts_with(b"copy to ") {
            self.git.moved = Some(moved(true));
        } else if chomp(line) == b"GIT binary patch" {
            self.git.binary = true;
        } else if !(line.starts_with(b"index ")
            || line.starts_with(b"similarity index ")
            || line.starts_with(b"dissimilarity index ")
            || line.starts_with(b"Binary files "))
        {
            return false;
        }
        self.end += 1;
        true
    }

    /// The section a header with no hunks of its own stands for.
    fn section<'a>(self, since: usize) -> Section<'a> {
        let names: Vec<_> = self.old.into_iter().chain(self.new).collect();
        let label = names.last().cloned().unwrap_or_default();
        Section {
            old_label: label.clone(),
            new_label: label,
            names,
            old_null: self.creates,
            new_null: self.deletes,
            leading: since..self.end,
            at: self.end,
            crlf: false,
            hunks: Vec::new(),
            end: End::Done,
            git: Some(self.git),
        }
    }
}

/// The patch's file sections in the order it gives them; a pair of headers
/// with no hunk after them gives none, but a `diff --git` header does: a
/// rename, a copy, a mode change, a binary patch or an empty file made or
/// deleted needs no hunk. Two sections may name one file, and
/// each is applied in turn, as GNU does; a section is never folded into
/// another by its name. A last line the patch left without a newline is
/// read as no line at all, as GNU reads it, and reading stops at the first
/// malformed section. `crlf` holds the `+++` lines whose section had its
/// CRs stripped.
pub(super) fn sections<'a>(
    lines: &[&'a [u8]],
    strip: Option<usize>,
    crlf: &HashSet<usize>,
) -> Patch<'a> {
    let cut = lines.last().is_some_and(|line| !line.ends_with(b"\n"));
    let lines = &lines[..lines.len() - usize::from(cut)];
    let mut sections = Vec::new();
    let mut old = Side::none();
    let mut index_name = None;
    let mut git: Option<GitHead> = None;
    let mut since = 0;
    let mut index = 0;
    let mut read = false;
    while let Some(&line) = lines.get(index) {
        index += 1;
        if let Some(rest) = line.strip_prefix(b"diff --git ") {
            if let Some(head) = git.take() {
                let end = head.end;
                sections.push(head.section(since));
                since = end;
            }
            git = Some(GitHead::read(rest, strip, index));
            continue;
        }
        if let Some(head) = git.as_mut() {
            if head.take(line) {
                continue;
            }
            if !(line.starts_with(b"--- ") || line.starts_with(b"+++ ")) {
                let head = git.take().expect("a git header");
                let end = head.end;
                sections.push(head.section(since));
                since = end;
            }
        }
        if line.starts_with(b"--- ") {
            old = Side::read(line, strip);
            continue;
        }
        if let Some(rest) = line.strip_prefix(b"Index: ") {
            index_name = candidate(name_and_stamp(rest).0, strip);
            continue;
        }
        if !line.starts_with(b"+++ ") {
            continue;
        }
        let new = Side::read(line, strip);
        let asked = crlf.contains(&(index - 1)) || line.ends_with(b"\r\n");
        let (hunks, next, end) = hunks(lines, index, cut, asked);
        let first = index;
        index = next;
        read = read || matches!(end, End::Cut) || hunks.last().is_some_and(|hunk| hunk.cut);
        let old = std::mem::replace(&mut old, Side::none());
        let index_name = index_name.take();
        let head = git.take();
        let fatal = matches!(end, End::Fatal(..));
        if hunks.is_empty() && !fatal {
            continue;
        }
        let mut names: Vec<Vec<u8>> = old.name.into_iter().chain(new.name).collect();
        if names.is_empty() {
            names.extend(index_name);
        }
        sections.push(Section {
            old_label: old.label,
            new_label: new.label,
            names,
            old_null: old.null,
            new_null: new.null,
            leading: since..first,
            at: first + 1,
            crlf: asked,
            hunks,
            end,
            git: head.map(|head| head.git),
        });
        since = index;
        if fatal {
            return Patch {
                sections,
                cut: false,
            };
        }
    }
    if let Some(head) = git {
        sections.push(head.section(since));
    }
    Patch {
        sections,
        cut: cut && !read,
    }
}
