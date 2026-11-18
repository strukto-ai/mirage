/// A gap past this many font sizes puts a space between two characters.
const SPACE: f32 = 0.1;
/// A gap past this many font sizes can split a line into two columns.
const COLUMN: f32 = 1.0;
/// A gap past this many font sizes that is no column breaks its line in
/// two.
const BREAK: f32 = 1.5;
/// Lines further apart than this many font sizes start a new block.
const LEADING: f32 = 3.4;
/// A line within this many font sizes of another can keep a gap in it
/// from being a column.
const NEIGHBOR: f32 = 1.5;
/// Two characters of one run sit within this many font sizes of one
/// baseline.
const BASELINE: f32 = 0.1;
/// A character drawn again within this many font sizes of itself is the
/// same character, overprinted for weight.
const OVERPRINT: f32 = 0.2;
/// In drawing order, a gap past this many font sizes of bare glyph width
/// puts a space between two characters.
const RAW_SPACE: f32 = 0.15;
/// Pages past this many blocks are read top to bottom without the
/// column rules, which compare every pair.
const ORDERED: usize = 400;

/// One drawn character, in the frame where its line runs left to right.
#[derive(Clone, Debug)]
pub(crate) struct Glyph {
    pub(crate) text: char,
    /// Where it starts along its line.
    pub(crate) x: f32,
    /// Its baseline, across the line, growing toward the line above.
    pub(crate) y: f32,
    /// How far it advances along the line, its spacing included.
    pub(crate) width: f32,
    /// Its own width, without character or word spacing.
    pub(crate) bare: f32,
    pub(crate) size: f32,
    /// Its reach above the baseline, positive.
    pub(crate) ascent: f32,
    /// Its reach below the baseline, positive.
    pub(crate) descent: f32,
    /// Its direction in quarter turns counterclockwise from the page's x
    /// axis, the nearest when it is diagonal.
    pub(crate) turn: u8,
    pub(crate) diagonal: bool,
}

impl Glyph {
    fn end(&self) -> f32 {
        self.x + self.width
    }

    /// Whether it is a drawn space, which only separates words.
    fn space(&self) -> bool {
        matches!(self.text, ' ' | '\t' | '\n' | '\r')
    }
}

/// How a page's text is put together.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Mode {
    /// Blocks in reading order, one blank line after each.
    Reading,
    /// Lines in the order the page draws them.
    Raw,
    /// Lines placed in columns as they stand on the page.
    Layout,
}

/// Characters drawn on one baseline, one after another.
#[derive(Clone, Debug)]
struct Run {
    glyphs: Vec<Glyph>,
}

impl Run {
    fn start(&self) -> f32 {
        self.glyphs[0].x
    }

    fn end(&self) -> f32 {
        self.glyphs.iter().map(Glyph::end).fold(f32::MIN, f32::max)
    }

    fn size(&self) -> f32 {
        self.glyphs.iter().map(|g| g.size).fold(0.0, f32::max)
    }

    fn baseline(&self) -> f32 {
        self.glyphs[0].y
    }

    fn top(&self) -> f32 {
        self.glyphs
            .iter()
            .map(|g| g.y + g.ascent)
            .fold(f32::MIN, f32::max)
    }

    fn bottom(&self) -> f32 {
        self.glyphs
            .iter()
            .map(|g| g.y - g.descent)
            .fold(f32::MAX, f32::min)
    }

    fn text(&self) -> String {
        self.glyphs.iter().map(|g| g.text).collect()
    }
}

/// A piece of one line between column gaps, broken into rows where a
/// wide gap that is no column stands.
#[derive(Clone, Debug)]
struct Segment {
    glyphs: Vec<Glyph>,
    /// The glyphs a new row starts at.
    breaks: Vec<usize>,
    baseline: f32,
    size: f32,
    start: f32,
    end: f32,
    top: f32,
    bottom: f32,
}

impl Segment {
    fn new(glyphs: Vec<Glyph>, breaks: Vec<usize>, baseline: f32) -> Segment {
        let size = glyphs.iter().map(|g| g.size).fold(0.0, f32::max);
        let start = glyphs.iter().map(|g| g.x).fold(f32::MAX, f32::min);
        let end = glyphs.iter().map(Glyph::end).fold(f32::MIN, f32::max);
        let top = glyphs
            .iter()
            .map(|g| g.y + g.ascent)
            .fold(f32::MIN, f32::max);
        let bottom = glyphs
            .iter()
            .map(|g| g.y - g.descent)
            .fold(f32::MAX, f32::min);
        Segment {
            glyphs,
            breaks,
            baseline,
            size,
            start,
            end,
            top,
            bottom,
        }
    }

    /// Its rows' text.
    fn rows(&self) -> Vec<String> {
        let mut rows = Vec::new();
        let mut from = 0;
        for &at in self.breaks.iter().chain([&self.glyphs.len()]) {
            rows.push(words(&self.glyphs[from..at]));
            from = at;
        }
        rows
    }

    /// Its text on one row, a space at every break.
    fn text(&self) -> String {
        self.rows().join(" ")
    }
}

/// Lines stacked closely enough to read as one passage.
#[derive(Clone, Debug)]
struct Block {
    lines: Vec<Segment>,
    start: f32,
    end: f32,
    top: f32,
    bottom: f32,
    turn: (u8, bool),
}

impl Block {
    fn new(line: Segment, turn: (u8, bool)) -> Block {
        Block {
            start: line.start,
            end: line.end,
            top: line.top,
            bottom: line.bottom,
            lines: vec![line],
            turn,
        }
    }

    fn push(&mut self, line: Segment) {
        self.start = self.start.min(line.start);
        self.end = self.end.max(line.end);
        self.top = self.top.max(line.top);
        self.bottom = self.bottom.min(line.bottom);
        self.lines.push(line);
    }

    fn width(&self) -> f32 {
        self.end - self.start
    }

    /// Whether the two share a column: their spans meet over a good part
    /// of the narrower one's width.
    fn shares_column(&self, other: &Block) -> bool {
        let narrow = self.width().min(other.width()).max(1.0);
        self.end.min(other.end) - self.start.max(other.start) > 0.5 * narrow
    }

    /// Whether the two stand side by side, their heights meeting.
    fn level_with(&self, other: &Block) -> bool {
        self.top.min(other.top) - self.bottom.max(other.bottom) > 0.0
    }

    fn left_of(&self, other: &Block) -> bool {
        self.end <= other.start + 0.5
    }

    fn above(&self, other: &Block) -> bool {
        self.top > other.top
    }
}

/// The glyphs' text with a space wherever the gap before a glyph is one.
fn words(glyphs: &[Glyph]) -> String {
    let mut text = String::new();
    let mut prev: Option<&Glyph> = None;
    for g in glyphs {
        if let Some(p) = prev {
            if g.x - p.end() > SPACE * p.size.max(g.size) {
                text.push(' ');
            }
        }
        text.push(g.text);
        prev = Some(g);
    }
    text
}

/// Runs of glyphs on one baseline, in the order the page draws them; a
/// drawn space only separates them.
fn runs(glyphs: &[Glyph]) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    let mut current: Vec<Glyph> = Vec::new();
    for g in glyphs {
        if g.space() {
            continue;
        }
        if let Some(prev) = current.last() {
            let size = prev.size.max(g.size);
            let joins = prev.turn == g.turn
                && prev.diagonal == g.diagonal
                && (prev.y - g.y).abs() <= BASELINE * size
                && (prev.size - g.size).abs() <= 0.2 * size
                && g.x >= prev.end() - 0.5 * size
                && g.x - prev.end() <= COLUMN * size;
            if !joins {
                runs.push(Run {
                    glyphs: std::mem::take(&mut current),
                });
            } else if g.text == prev.text && (g.x - prev.x).abs() < OVERPRINT * size {
                continue;
            }
        }
        current.push(g.clone());
    }
    if !current.is_empty() {
        runs.push(Run { glyphs: current });
    }
    runs
}

/// A line under construction: the baseline and height of its largest run,
/// and every run on it.
struct Line {
    baseline: f32,
    top: f32,
    bottom: f32,
    size: f32,
    runs: Vec<Run>,
}

impl Line {
    /// How far a run's height meets the line's, as a share of the lower
    /// of the two.
    fn meets(&self, run: &Run) -> f32 {
        let met = self.top.min(run.top()) - self.bottom.max(run.bottom());
        let least = (self.top - self.bottom).min(run.top() - run.bottom());
        if least <= 0.0 { 0.0 } else { met / least }
    }

    /// Whether `run` draws again what the line already holds.
    fn repeats(&self, run: &Run) -> bool {
        let text = run.text();
        let size = run.size();
        self.runs.iter().any(|r| {
            (r.start() - run.start()).abs() < OVERPRINT * size
                && (r.baseline() - run.baseline()).abs() < OVERPRINT * size
                && r.text() == text
        })
    }

    /// Whether `run` covers ground a run of the line already covers.
    fn crowds(&self, run: &Run) -> bool {
        let slack = 0.3 * run.size();
        self.runs
            .iter()
            .any(|r| r.end().min(run.end()) - r.start().max(run.start()) > slack)
    }
}

/// One line of glyphs, left to right, with where its column-wide gaps
/// stand.
struct Row {
    glyphs: Vec<Glyph>,
    baseline: f32,
    size: f32,
    /// Each gap past a column's width: the glyph after it, its edges and
    /// whether it is wide enough to break a line.
    gaps: Vec<(usize, f32, f32, bool)>,
}

impl Row {
    /// The spans its text covers between its column-wide gaps.
    fn pieces(&self) -> Vec<(f32, f32)> {
        let mut pieces = Vec::new();
        let mut from = 0;
        for &(at, ..) in self
            .gaps
            .iter()
            .chain([&(self.glyphs.len(), 0.0, 0.0, false)])
        {
            let start = self.glyphs[from].x;
            let end = self.glyphs[from..at]
                .iter()
                .map(Glyph::end)
                .fold(f32::MIN, f32::max);
            pieces.push((start, end));
            from = at;
        }
        pieces
    }
}

/// One direction's runs gathered into lines, top to bottom.
fn rows(mut runs: Vec<Run>) -> Vec<Row> {
    runs.sort_by(|a, b| {
        b.baseline()
            .total_cmp(&a.baseline())
            .then(a.start().total_cmp(&b.start()))
    });
    let mut lines: Vec<Line> = Vec::new();
    for run in runs {
        let mut best: Option<(usize, f32)> = None;
        let mut repeated = false;
        for (i, line) in lines.iter().enumerate().rev() {
            if line.bottom > run.top() + 2.0 * line.size.max(run.size()) {
                break;
            }
            let met = line.meets(&run);
            if met < 0.5 {
                continue;
            }
            if line.repeats(&run) {
                repeated = true;
                break;
            }
            if !line.crowds(&run) && best.is_none_or(|(_, b)| met > b) {
                best = Some((i, met));
            }
        }
        if repeated {
            continue;
        }
        match best {
            Some((i, _)) => {
                let line = &mut lines[i];
                if run.size() > line.size {
                    line.size = run.size();
                    line.baseline = run.baseline();
                    line.top = run.top();
                    line.bottom = run.bottom();
                }
                line.runs.push(run);
            }
            None => lines.push(Line {
                baseline: run.baseline(),
                top: run.top(),
                bottom: run.bottom(),
                size: run.size(),
                runs: vec![run],
            }),
        }
    }
    lines.sort_by(|a, b| b.baseline.total_cmp(&a.baseline));
    lines
        .into_iter()
        .map(|line| {
            let mut glyphs: Vec<Glyph> = line.runs.into_iter().flat_map(|r| r.glyphs).collect();
            glyphs.sort_by(|a, b| a.x.total_cmp(&b.x));
            let mut gaps = Vec::new();
            for k in 1..glyphs.len() {
                let (p, g) = (&glyphs[k - 1], &glyphs[k]);
                let size = p.size.max(g.size);
                let gap = g.x - p.end();
                if gap > COLUMN * size {
                    gaps.push((k, p.end(), g.x, gap > BREAK * size));
                }
            }
            Row {
                glyphs,
                baseline: line.baseline,
                size: line.size,
                gaps,
            }
        })
        .collect()
}

/// The rows each row's column-wide gaps are judged against: the nearest
/// one above and the nearest one below, each closer than a line and a
/// half.
fn beside_rows(rows: &[Row], i: usize) -> [Option<usize>; 2] {
    let me = &rows[i];
    let reach = |j: usize| {
        let other = &rows[j];
        let drop = (other.baseline - me.baseline).abs();
        drop > 0.6 * me.size.min(other.size) && drop <= NEIGHBOR * me.size.max(other.size)
    };
    let above = (0..i).rev().find(|&j| reach(j));
    let below = (i + 1..rows.len()).find(|&j| reach(j));
    [above, below]
}

/// The segments one direction's rows split into. A column-wide gap
/// splits its row in two unless a row beside it runs text across the gap
/// and none leaves the same gutter; such a gap breaks the line when wide.
fn segments(rows: &[Row]) -> Vec<Segment> {
    let mut out = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let near: Vec<&Row> = beside_rows(rows, i)
            .into_iter()
            .flatten()
            .map(|j| &rows[j])
            .collect();
        let mut splits = Vec::new();
        let mut breaks = Vec::new();
        for &(at, left, right, wide) in &row.gaps {
            let crossed = near.iter().any(|other| {
                other
                    .pieces()
                    .iter()
                    .any(|&(s, e)| e.min(right) - s.max(left) > 0.0)
            });
            let gutter = near.iter().any(|other| {
                other
                    .gaps
                    .iter()
                    .any(|&(_, l, r, _)| r.min(right) - l.max(left) > 0.0)
            });
            if !crossed || gutter {
                splits.push(at);
            } else if wide {
                breaks.push(at);
            }
        }
        let mut from = 0;
        for at in splits.into_iter().chain([row.glyphs.len()]) {
            let mine: Vec<usize> = breaks
                .iter()
                .filter(|&&b| b > from && b < at)
                .map(|&b| b - from)
                .collect();
            out.push(Segment::new(
                row.glyphs[from..at].to_vec(),
                mine,
                row.baseline,
            ));
            from = at;
        }
    }
    out
}

/// Whether two spans across the page meet.
fn spans_meet(a: (f32, f32), b: (f32, f32)) -> bool {
    a.1.min(b.1) - a.0.max(b.0) > 0.0
}

/// One direction's segments gathered into blocks, top to bottom: a line
/// joins the nearest block whose last line stands over it within reach,
/// one that shares its span first, and starts its own when it shares the
/// spans of two. A line that shares no such block's span joins one only
/// when no line anywhere above it shares its span and the block's column
/// does not go on beside it.
fn blocks(mut lines: Vec<Segment>, turn: (u8, bool)) -> Vec<Block> {
    lines.sort_by(|a, b| {
        b.baseline
            .total_cmp(&a.baseline)
            .then(a.start.total_cmp(&b.start))
    });
    let mut blocks: Vec<Block> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let span = (line.start, line.end);
        let mut best: Option<(usize, bool, f32, f32)> = None;
        let mut sharing: Vec<f32> = Vec::new();
        for (b, block) in blocks.iter().enumerate() {
            let last = &block.lines[block.lines.len() - 1];
            let drop = last.baseline - line.baseline;
            if drop <= 0.6 * line.size.min(last.size) || drop > LEADING * line.size.max(last.size) {
                continue;
            }
            let meets = spans_meet(span, (last.start, last.end));
            if meets {
                sharing.push(drop);
            }
            let apart = (last.start - line.end).max(line.start - last.end).max(0.0);
            let better = match best {
                None => true,
                Some((_, m, d, a)) => {
                    (meets && !m)
                        || (meets == m && (drop < d - 0.01 || (drop <= d + 0.01 && apart < a)))
                }
            };
            if better {
                best = Some((b, meets, drop, apart));
            }
        }
        let nearest = sharing.iter().copied().fold(f32::MAX, f32::min);
        if sharing
            .iter()
            .filter(|&&d| d <= nearest + 0.5 * line.size)
            .count()
            > 1
        {
            best = None;
        }
        let joined = match best {
            Some((b, true, _, _)) => Some(b),
            Some((b, false, _, _)) => {
                let last = &blocks[b].lines[blocks[b].lines.len() - 1];
                let under = lines[..i].iter().any(|other| {
                    other.baseline > line.baseline && spans_meet(span, (other.start, other.end))
                });
                let beside = lines.iter().any(|other| {
                    (other.baseline - line.baseline).abs() < 0.6 * line.size.min(other.size)
                        && spans_meet((last.start, last.end), (other.start, other.end))
                });
                (!under && !beside).then_some(b)
            }
            None => None,
        };
        match joined {
            Some(b) => blocks[b].push(line.clone()),
            None => blocks.push(Block::new(line.clone(), turn)),
        }
    }
    blocks
}

/// Whether block `a` reads before block `b`: one over the other in a
/// shared column reads top first; side by side, the left one first; and a
/// block under one column reads before the column to its right.
fn before(blocks: &[Block], beside: &[Vec<usize>], a: usize, b: usize) -> bool {
    let (x, y) = (&blocks[a], &blocks[b]);
    if x.turn != y.turn {
        return x.turn < y.turn;
    }
    if x.shares_column(y) {
        return x.above(y);
    }
    if !x.left_of(y) {
        return false;
    }
    if x.level_with(y) {
        return true;
    }
    beside[b]
        .iter()
        .any(|&c| blocks[c].above(x) && blocks[c].shares_column(x))
}

/// The blocks in reading order.
fn reading_order(blocks: &[Block]) -> Vec<usize> {
    let n = blocks.len();
    let rank = |i: usize, j: usize| {
        let (a, b) = (&blocks[i], &blocks[j]);
        a.turn
            .cmp(&b.turn)
            .then(b.top.total_cmp(&a.top))
            .then(a.start.total_cmp(&b.start))
    };
    if n > ORDERED {
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|&i, &j| rank(i, j));
        return order;
    }
    let beside: Vec<Vec<usize>> = (0..n)
        .map(|b| {
            (0..n)
                .filter(|&c| {
                    c != b
                        && blocks[c].turn == blocks[b].turn
                        && blocks[c].level_with(&blocks[b])
                        && blocks[c].left_of(&blocks[b])
                })
                .collect()
        })
        .collect();
    let after: Vec<Vec<usize>> = (0..n)
        .map(|a| {
            (0..n)
                .filter(|&b| {
                    a != b && before(blocks, &beside, a, b) && !before(blocks, &beside, b, a)
                })
                .collect()
        })
        .collect();
    let mut waits = vec![0usize; n];
    for &b in after.iter().flatten() {
        waits[b] += 1;
    }
    let mut done = vec![false; n];
    let mut order = Vec::with_capacity(n);
    while order.len() < n {
        let pick = (0..n)
            .filter(|&i| !done[i] && waits[i] == 0)
            .min_by(|&i, &j| rank(i, j))
            .or_else(|| (0..n).filter(|&i| !done[i]).min_by(|&i, &j| rank(i, j)));
        let Some(i) = pick else { break };
        done[i] = true;
        order.push(i);
        for &b in &after[i] {
            waits[b] = waits[b].saturating_sub(1);
        }
    }
    order
}

/// The directions a page's glyphs run in, upright first.
fn turns(glyphs: &[Glyph], nodiag: bool) -> Vec<(u8, bool)> {
    let mut turns: Vec<(u8, bool)> = glyphs
        .iter()
        .filter(|g| !g.space() && !(nodiag && g.diagonal))
        .map(|g| (g.turn, g.diagonal))
        .collect();
    turns.sort_unstable();
    turns.dedup();
    turns
}

/// Each direction's rows, upright first.
fn page_rows(glyphs: &[Glyph], nodiag: bool) -> Vec<((u8, bool), Vec<Row>)> {
    turns(glyphs, nodiag)
        .into_iter()
        .map(|turn| {
            let mine: Vec<Glyph> = glyphs
                .iter()
                .filter(|g| (g.turn, g.diagonal) == turn)
                .cloned()
                .collect();
            (turn, rows(runs(&mine)))
        })
        .collect()
}

fn hyphen(c: char) -> bool {
    c == '-' || c == '\u{ad}'
}

/// A page's text in reading order: each block's lines, a line ending in
/// a hyphen joined to the next, and a blank line after every block.
fn reading(glyphs: &[Glyph], nodiag: bool) -> String {
    let mut all: Vec<Block> = Vec::new();
    for (turn, rows) in page_rows(glyphs, nodiag) {
        all.extend(blocks(segments(&rows), turn));
    }
    let mut out = String::new();
    for i in reading_order(&all) {
        let lines: Vec<String> = all[i].lines.iter().flat_map(Segment::rows).collect();
        for (k, text) in lines.iter().enumerate() {
            match text.chars().last() {
                Some(c) if hyphen(c) && k + 1 < lines.len() => {
                    out.push_str(&text[..text.len() - c.len_utf8()]);
                }
                _ => {
                    out.push_str(text);
                    out.push('\n');
                }
            }
        }
        out.push('\n');
    }
    out
}

/// A page's text in drawing order: a new line wherever the next glyph
/// leaves the baseline or steps back.
fn raw(glyphs: &[Glyph], nodiag: bool) -> String {
    let mut out = String::new();
    let mut prev: Option<&Glyph> = None;
    for g in glyphs {
        if (nodiag && g.diagonal) || g.space() {
            continue;
        }
        if let Some(p) = prev {
            let size = p.size.max(g.size);
            let same = p.turn == g.turn
                && p.diagonal == g.diagonal
                && (p.y - g.y).abs() <= 0.5 * size
                && g.x >= p.end() - 0.5 * size;
            if !same {
                out.push('\n');
            } else if g.x - (p.x + p.bare) > RAW_SPACE * size {
                out.push(' ');
            }
        }
        out.push(g.text);
        prev = Some(g);
    }
    if prev.is_some() {
        out.push('\n');
    }
    out
}

/// A gutter wider than this many columns, empty on every row of a placed
/// page, narrows to it.
const GUTTER: usize = 3;
/// The most blank lines a placed page puts between two of its lines.
const BLANKS: i64 = 4;
/// The farthest column a piece is placed at before the gutters narrow,
/// low enough that adding a page's text to it fits a 32-bit `usize`.
const FARTHEST: f32 = (1u32 << 30) as f32;

/// A page's text placed as it stands: a blank line for each further
/// height of a line's smallest type down to the next line, up to
/// `BLANKS`, and each piece at the column its place across the page maps
/// to.
fn layout(glyphs: &[Glyph], nodiag: bool) -> String {
    let placed: Vec<Glyph> = glyphs.iter().filter(|g| g.x.is_finite()).cloned().collect();
    let mut pieces: Vec<Segment> = Vec::new();
    for (_, rows) in page_rows(&placed, nodiag) {
        for row in &rows {
            let mut from = 0;
            for at in row.gaps.iter().map(|g| g.0).chain([row.glyphs.len()]) {
                pieces.push(Segment::new(
                    row.glyphs[from..at].to_vec(),
                    Vec::new(),
                    row.baseline,
                ));
                from = at;
            }
        }
    }
    if pieces.is_empty() {
        return String::new();
    }
    let texts: Vec<String> = pieces.iter().map(Segment::text).collect();
    let mut order: Vec<usize> = (0..pieces.len()).collect();
    order.sort_by(|&a, &b| {
        pieces[b]
            .baseline
            .total_cmp(&pieces[a].baseline)
            .then(pieces[a].start.total_cmp(&pieces[b].start))
    });
    let mut lines: Vec<(f32, f32, Vec<usize>)> = Vec::new();
    for i in order {
        let piece = &pieces[i];
        match lines.last_mut() {
            Some((base, size, items))
                if (*base - piece.baseline).abs() <= 0.5 * size.min(piece.size) =>
            {
                items.push(i);
                *size = size.max(piece.size);
            }
            _ => lines.push((piece.baseline, piece.size, vec![i])),
        }
    }
    let columns = columns(&pieces, &texts, &lines);
    let mut out = String::new();
    let mut prev: Option<(f32, f32)> = None;
    for (base, _, items) in &lines {
        if let Some((up, unit)) = prev {
            let blank = ((up - base) / unit.max(1.0)).floor() as i64 - 1;
            for _ in 0..blank.clamp(0, BLANKS) {
                out.push('\n');
            }
        }
        let mut at = 0usize;
        for &i in items {
            let col = columns[i];
            if col > at {
                out.extend(std::iter::repeat_n(' ', col - at));
                at = col;
            }
            at += texts[i].chars().count();
            out.push_str(&texts[i]);
        }
        out.push('\n');
        let least = items
            .iter()
            .map(|&i| pieces[i].size)
            .fold(f32::MAX, f32::min);
        prev = Some((*base, least));
    }
    out
}

/// The column each piece starts at: its place across the page in half
/// the page's usual font size, at most `FARTHEST`, pushed past the piece
/// before it on its own line, then every gutter empty on all lines
/// narrowed to `GUTTER`, worked out from the pieces' spans so that memory
/// follows the text rather than how far apart it is drawn.
fn columns(pieces: &[Segment], texts: &[String], lines: &[(f32, f32, Vec<usize>)]) -> Vec<usize> {
    let mut sizes: Vec<(f32, usize)> = pieces
        .iter()
        .zip(texts)
        .map(|(p, t)| (p.size, t.chars().count()))
        .collect();
    sizes.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total: usize = sizes.iter().map(|s| s.1).sum();
    let mut seen = 0;
    let mut usual = sizes[0].0;
    for (size, n) in &sizes {
        seen += n;
        if 2 * seen >= total {
            usual = *size;
            break;
        }
    }
    let pitch = (0.5 * usual).max(1.0);
    let left = pieces.iter().map(|p| p.start).fold(f32::MAX, f32::min);
    let mut col = vec![0usize; pieces.len()];
    for (_, _, items) in lines {
        let mut end = 0usize;
        for (k, &i) in items.iter().enumerate() {
            let at = ((pieces[i].start - left) / pitch).round().clamp(0.0, FARTHEST) as usize;
            let gap = if k == 0 { 0 } else { 1 };
            col[i] = at.max(end + gap);
            end = col[i] + texts[i].chars().count();
        }
    }
    let mut spans: Vec<(usize, usize)> = col
        .iter()
        .zip(texts)
        .map(|(&c, text)| (c, c + text.chars().count()))
        .collect();
    spans.sort_unstable();
    let mut cuts: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
    let mut cut = 0usize;
    let mut reach: Option<usize> = None;
    for (from, to) in spans {
        if let Some(reach) = reach {
            cut += from.saturating_sub(reach + GUTTER);
        }
        cuts.push((from, cut));
        reach = Some(reach.map_or(to, |reach| reach.max(to)));
    }
    col.iter()
        .map(|&c| c - cuts[cuts.partition_point(|&(from, _)| from <= c) - 1].1)
        .collect()
}

/// A page's text in the given mode.
pub(crate) fn page(glyphs: &[Glyph], mode: Mode, nodiag: bool) -> String {
    match mode {
        Mode::Reading => reading(glyphs, nodiag),
        Mode::Raw => raw(glyphs, nodiag),
        Mode::Layout => layout(glyphs, nodiag),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, x: f32) -> Vec<Glyph> {
        text.chars()
            .enumerate()
            .map(|(i, text)| Glyph {
                text,
                x: x + 6.0 * i as f32,
                y: 720.0,
                width: 6.0,
                bare: 6.0,
                size: 12.0,
                ascent: 9.0,
                descent: 3.0,
                turn: 0,
                diagonal: false,
            })
            .collect()
    }

    #[test]
    fn layout_places_a_glyph_at_any_distance_in_memory_for_its_text() {
        for (x, line) in [
            (1e15, "Left   x\n"),
            (-1e15, "x   Left\n"),
            (1e38, "Left   x\n"),
            (-1e38, "x   Left\n"),
            (f32::INFINITY, "Left\n"),
            (f32::NEG_INFINITY, "Left\n"),
            (f32::NAN, "Left\n"),
        ] {
            let glyphs = [word("Left", 72.0), word("x", x)].concat();
            assert_eq!(page(&glyphs, Mode::Layout, false), line, "x={x}");
        }
    }

    #[test]
    fn a_gutter_narrows_only_where_no_line_has_text() {
        let mut below = [word("x", 84.0), word("y", 192.0)].concat();
        for glyph in &mut below {
            glyph.y = 700.0;
        }
        let glyphs = [word("ABCDEFGHIJKLMNOP", 72.0), below].concat();
        assert_eq!(
            page(&glyphs, Mode::Layout, false),
            format!("ABCDEFGHIJKLMNOP\n  x{}y\n", " ".repeat(16))
        );
    }
}
