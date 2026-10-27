//! A unified diff read into the file sections GNU patch 2.8 applies, each
//! line held with the newline it ends with.

/// One line of a hunk: `b' '`, `b'-'` or `b'+'`, and its text with the
/// newline it ends with, which a `\` line after it takes away.
#[derive(Clone, Copy)]
pub(super) struct Line<'a> {
    pub(super) kind: u8,
    pub(super) text: &'a [u8],
}

/// One `@@` hunk: where its header says each side starts, what the header
/// carries after the closing `@@`, and its lines.
#[derive(Clone)]
pub(super) struct Hunk<'a> {
    pub(super) old_start: i64,
    pub(super) new_start: i64,
    pub(super) note: &'a [u8],
    pub(super) body: Vec<Line<'a>>,
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

/// One file's part of a patch: what its reject file's `---` and `+++`
/// lines say, the file it patches by its headers, `-p` applied, and its
/// hunks in order.
pub(super) struct Section<'a> {
    pub(super) old_label: Vec<u8>,
    pub(super) new_label: Vec<u8>,
    pub(super) target: Vec<u8>,
    pub(super) hunks: Vec<Hunk<'a>>,
}

/// The values a header number takes at most, so the placement arithmetic
/// on one never overflows.
const NUMBER: i64 = 1 << 48;

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

fn chomp(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\n").unwrap_or(line)
}

/// A patch name with `-p` leading components dropped, GNU's way: a run of
/// slashes is one separator, and a name with fewer components than `-p`
/// drops leaves no name at all.
fn strip_name(name: &[u8], strip: usize) -> Option<&[u8]> {
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

/// A `---`/`+++` line's name, and what a reject file says for it: the file
/// as `-p` leaves it (`/dev/null` when it leaves nothing) and the timestamp
/// the header carried.
fn label(line: &[u8], strip: usize) -> (&[u8], Vec<u8>) {
    let rest = &chomp(line)[4..];
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
    let name = &name[start..end];
    let stripped = if name == b"/dev/null" {
        None
    } else {
        strip_name(name, strip)
    };
    (name, [stripped.unwrap_or(b"/dev/null"), stamp].concat())
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

/// The hunks that start at `lines[index]`, and the index after them. A
/// hunk ends when its header's line counts are used up, as GNU reads it,
/// so a removed line that reads `-- x` is never taken for the next file's
/// header.
fn hunks<'a>(lines: &[&'a [u8]], mut index: usize) -> (Vec<Hunk<'a>>, usize) {
    let mut hunks = Vec::new();
    while let Some(&line) = lines.get(index) {
        let Some((old_start, mut old_left, new_start, mut new_left, note)) = header(line) else {
            break;
        };
        let mut body = Vec::new();
        index += 1;
        while let Some(&line) = lines.get(index) {
            if old_left <= 0 && new_left <= 0 {
                break;
            }
            match line[0] {
                b' ' | b'\n' => {
                    old_left -= 1;
                    new_left -= 1;
                }
                b'-' => old_left -= 1,
                b'+' => new_left -= 1,
                b'\\' => {
                    unterminate(&mut body);
                    index += 1;
                    continue;
                }
                _ => break,
            }
            let (kind, text) = match line[0] {
                b'\n' => (b' ', line),
                kind => (kind, &line[1..]),
            };
            body.push(Line { kind, text });
            index += 1;
        }
        while lines.get(index).is_some_and(|line| line[0] == b'\\') {
            unterminate(&mut body);
            index += 1;
        }
        hunks.push(Hunk {
            old_start,
            new_start,
            note,
            body,
        });
    }
    (hunks, index)
}

/// The patch's file sections in the order it gives them; a pair of headers
/// with no hunk after them gives none. Two sections may name one file, and
/// each is applied in turn, as GNU does; a section is never folded into
/// another by its name.
pub(super) fn sections<'a>(lines: &[&'a [u8]], strip: usize) -> Vec<Section<'a>> {
    let mut sections = Vec::new();
    let mut old_label = b"/dev/null".to_vec();
    let mut index = 0;
    while let Some(&line) = lines.get(index) {
        index += 1;
        if line.starts_with(b"--- ") {
            old_label = label(line, strip).1;
            continue;
        }
        if !line.starts_with(b"+++ ") {
            continue;
        }
        let (new_name, new_label) = label(line, strip);
        let (hunks, next) = hunks(lines, index);
        index = next;
        let target = strip_name(new_name, strip).unwrap_or_else(|| {
            let cut = memchr::memrchr(b'/', new_name).map_or(0, |at| at + 1);
            &new_name[cut..]
        });
        let old_label = std::mem::replace(&mut old_label, b"/dev/null".to_vec());
        if !hunks.is_empty() {
            sections.push(Section {
                old_label,
                new_label,
                target: trim_slashes(target).to_vec(),
                hunks,
            });
        }
    }
    sections
}
