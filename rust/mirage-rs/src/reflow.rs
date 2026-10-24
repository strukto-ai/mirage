use serde::Deserialize;

use crate::width::TAB_WIDTH;
use crate::{Stream, StreamError, parse_config};

const TAB: i64 = TAB_WIDTH as i64;
const DEFAULT_WIDTH: i64 = 75;

// GNU 9.7 lays a long paragraph out a piece at a time, a piece holding at
// most 998 words and 5000 bytes of word text. It sets the piece, prints its
// first lines, and carries the words of the rest into the next piece, whose
// first line is then also weighed against the line printed before it. A
// piece that fits on one line is printed whole; `resume` says how many
// lines of a longer one are carried.
const PIECE_WORDS: usize = 998;
const PIECE_BYTES: usize = 5000;

// What a layout costs, in hundredths of a squared column. The last line laid
// out is free and every other line pays the rest. These values reproduce GNU
// 9.7's choices over the probe corpus, ties going to the shorter line.
// EACH_LINE is paid per line, OFF_GOAL per squared column a line misses the
// goal by, and UNEVEN per squared column a line differs from the one after
// it. A line ending on a word that ends a sentence earns SENTENCE_END, one
// ending on . ? or ! that ends no sentence pays FALSE_STOP, one ending on any
// other punctuation earns MARK_END, and one starting on ( [ ` ' or " earns
// OPENER_START. FIRST_ALONE and LAST_ALONE, over the word's length plus two,
// are paid for ending a line on a sentence's first word or starting one on a
// sentence's last, the paragraph's last word included. LATER is, per line,
// how much a full piece would rather stop later than earlier.
const EACH_LINE: i64 = 4900;
const OFF_GOAL: i64 = 100;
const UNEVEN: i64 = 50;
const SENTENCE_END: i64 = -2500;
const FALSE_STOP: i64 = 360_000;
const MARK_END: i64 = -1600;
const OPENER_START: i64 = -1600;
const FIRST_ALONE: i64 = 40000;
const LAST_ALONE: i64 = 22500;
const LATER: i64 = 9;

const CLOSERS: &[u8] = b")]'\"";
const OPENERS: &[u8] = b"([`'\"";
const STOPS: &[u8] = b".?!";

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | 0x0B | 0x0C | b'\r')
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    width: Option<i64>,
    goal: Option<i64>,
    #[serde(deserialize_with = "crate::latin1_opt")]
    prefix: Option<Vec<u8>>,
    split_only: bool,
    tagged: bool,
    crown: bool,
    uniform: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config = parse_config::<Config>(config)?;
    // GNU 9.7 aims at 93.5% of the width, rounded down, and with only a
    // goal it allows ten columns past it.
    let (width, goal) = match (config.width, config.goal) {
        (None, Some(goal)) => (goal + 10, goal),
        (width, goal) => {
            let width = width.unwrap_or(DEFAULT_WIDTH);
            (width, goal.unwrap_or(width * 187 / 200))
        }
    };
    let typed = config.prefix.unwrap_or_default();
    // GNU 9.7 reads -p ' # ' as '#' at least one column in and followed by
    // at least one blank column; those spaces are not matched as typed, so
    // '\t#\tx' qualifies. A tab in a prefix is matched as typed and counted
    // as one column.
    let floor = typed.iter().take_while(|&&byte| byte == b' ').count();
    let core = &typed[floor..];
    let mark_len = core.len() - core.iter().rev().take_while(|&&byte| byte == b' ').count();
    Ok(Box::new(Layout {
        width,
        goal,
        floor: floor as i64,
        mark: core[..mark_len].to_vec(),
        trail: (core.len() - mark_len) as i64,
        prefixed: !typed.is_empty(),
        split: config.split_only,
        tagged: config.tagged,
        crown: config.crown,
        uniform: config.uniform,
        tabs: false,
        hung: 0,
        para: None,
        mode: Mode::Start,
        col: 0,
        tab: false,
        lead: 0,
        matched: None,
        word: Vec::new(),
        start: 0,
        after: None,
    }))
}

/// Blanks from column `col` up to `target`. Once the input has shown a
/// tab, GNU 9.7 writes tabs wherever they take fewer bytes than spaces:
/// column 7 to 9 stays two spaces, 7 to 16 becomes two tabs.
fn pad(out: &mut Vec<u8>, col: i64, target: i64, tabs: bool) {
    if tabs {
        let stops = target / TAB - col / TAB;
        let rest = target % TAB;
        if stops > 0 && stops + rest < target - col {
            out.extend(std::iter::repeat_n(b'\t', stops as usize));
            out.extend(std::iter::repeat_n(b' ', rest as usize));
            return;
        }
    }
    out.extend(std::iter::repeat_n(b' ', (target - col).max(0) as usize));
}

/// One word of a paragraph and how lines may break around it.
struct Term {
    chars: Vec<u8>,
    /// Columns to the next word when both share a line.
    gap: i64,
    ends_sentence: bool,
    /// Ends in . ? or ! without ending a sentence.
    false_stop: bool,
    marked: bool,
    opener: bool,
    /// Follows the end of a sentence.
    after_stop: bool,
}

impl Term {
    fn len(&self) -> i64 {
        self.chars.len() as i64
    }
}

/// What ending a line between `terms[k]` and the next word costs; `last`
/// says whether the last of `terms` ends the paragraph.
fn join_cost(terms: &[Term], k: usize, last: bool) -> i64 {
    let (left, right) = (&terms[k], &terms[k + 1]);
    let mut cost = 0;
    if left.ends_sentence {
        cost += SENTENCE_END;
    } else if left.false_stop {
        cost += FALSE_STOP;
    } else if left.marked {
        cost += MARK_END;
    } else if left.after_stop && k > 0 {
        // GNU 9.7 does not count a piece's first word as a sentence's.
        cost += FIRST_ALONE / (left.len() + 2);
    }
    if right.opener {
        cost += OPENER_START;
    } else if right.ends_sentence || (last && k + 2 == terms.len()) {
        cost += LAST_ALONE / (right.len() + 2);
    }
    cost
}

/// Where the lines of `terms` end, and what each line cost as laid out.
///
/// Working back from the last word, each word gets the cheapest way to lay
/// out everything from it on, and a line is weighed against the first line
/// of the remainder chosen after it. GNU 9.7 decides the same way, so a
/// layout found this way can differ from the cheapest overall. `before` is
/// the length of the line printed just before these words.
fn plan(
    terms: &[Term],
    (first_col, rest_col): (i64, i64),
    (width, goal): (i64, i64),
    before: Option<i64>,
    last: bool,
) -> (Vec<usize>, Vec<i64>) {
    let count = terms.len();
    let mut best = vec![0; count + 1];
    let mut stop = vec![count; count + 1];
    let mut reach = vec![0; count + 1];
    let joins: Vec<i64> = (0..count.saturating_sub(1))
        .map(|k| join_cost(terms, k, last))
        .collect();
    for start in (0..count).rev() {
        let mut length = if start == 0 { first_col } else { rest_col };
        for end in start + 1..=count {
            if end > start + 1 {
                length += terms[end - 2].gap;
            }
            length += terms[end - 1].len();
            if end > start + 1 && length >= width {
                break;
            }
            let mut cost = best[end];
            if end < count {
                cost += EACH_LINE + OFF_GOAL * (goal - length).pow(2);
                cost += joins[end - 1];
                if stop[end] < count {
                    cost += UNEVEN * (length - reach[end]).pow(2);
                }
            }
            if let Some(before) = before.filter(|_| start == 0) {
                cost += UNEVEN * (length - before).pow(2);
            }
            if end == start + 1 || cost < best[start] {
                best[start] = cost;
                stop[start] = end;
                reach[start] = length;
            }
        }
    }
    let mut ends = Vec::new();
    let mut costs = Vec::new();
    let mut at = 0;
    while at < count {
        costs.push(best[at] - best[stop[at]]);
        at = stop[at];
        ends.push(at);
    }
    (ends, costs)
}

/// Where a full piece stops printing: the word its kept lines start at.
///
/// GNU 9.7 keeps the lines from the one that weighs least as a first line:
/// its own cost without the break it ends on, but with the break before it,
/// the piece's last line counting as a perfect line, plus a little for
/// every line still after it. Ties go to the earlier line.
fn resume(terms: &[Term], ends: &[usize], costs: &[i64]) -> usize {
    let last = ends.len() - 1;
    let mut keep = ends[ends.len() - 2];
    let mut lowest = None;
    for line in 1..=last {
        let start = ends[line - 1];
        let mut weight = if line == last {
            EACH_LINE
        } else {
            costs[line] - join_cost(terms, ends[line] - 1, false)
        };
        weight += join_cost(terms, start - 1, false) + LATER * (last - line) as i64;
        if lowest.is_none_or(|lowest| weight < lowest) {
            lowest = Some(weight);
            keep = start;
        }
    }
    keep
}

/// Lines joined so far, and what is left of them to print.
struct Paragraph {
    /// Columns of blanks before the prefix, which every line must share.
    lead: i64,
    first_col: i64,
    rest_col: i64,
    lines: usize,
    terms: Vec<Term>,
    size: usize,
    /// Length of the last line printed, for the next piece's first line.
    last: Option<i64>,
    /// Whether the word before the next one ended a sentence.
    after_stop: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Reading a line's leading blanks, prefix and indent.
    Start,
    /// A line printed as it stands.
    Copy,
    /// A line whose words join a paragraph.
    Text,
}

/// fmt as GNU coreutils 9.7 reflows one input, a paragraph at a time. A
/// paragraph is printed once a line arrives that does not continue it; GNU
/// has read that line's leading blanks, prefix and indent by then, so a tab
/// among them already counts when the paragraph prints. Words are read as
/// they come, so a full piece prints before its line ends.
struct Layout {
    width: i64,
    goal: i64,
    floor: i64,
    mark: Vec<u8>,
    trail: i64,
    prefixed: bool,
    split: bool,
    tagged: bool,
    crown: bool,
    uniform: bool,
    tabs: bool,
    /// Where the last paragraph's later lines started; -t starts a one-line
    /// paragraph's from there.
    hung: i64,
    para: Option<Paragraph>,
    mode: Mode,
    /// The column read to, whether the blanks just read held a tab, the
    /// columns of blanks before the prefix and the bytes of the prefix
    /// matched.
    col: i64,
    tab: bool,
    lead: i64,
    matched: Option<usize>,
    /// The word being read, the column it starts in and the column after
    /// it, `None` while it goes on.
    word: Vec<u8>,
    start: i64,
    after: Option<i64>,
}

impl Layout {
    fn feed(&mut self, data: &[u8], out: &mut Vec<u8>) {
        let mut pos = 0;
        while pos < data.len() {
            match self.mode {
                Mode::Start => pos = self.head(data, pos, out),
                Mode::Text => pos = self.text(data, pos, out),
                Mode::Copy => {
                    let Some(newline) = memchr::memchr(b'\n', &data[pos..]) else {
                        out.extend_from_slice(&data[pos..]);
                        return;
                    };
                    out.extend_from_slice(&data[pos..pos + newline]);
                    self.end(true, out);
                    pos += newline + 1;
                }
            }
        }
    }

    fn finish(&mut self, out: &mut Vec<u8>) {
        if self.mode == Mode::Start && self.col != 0 {
            self.decide(true, false, out);
        }
        self.end(false, out);
        self.close(out);
    }

    /// Read a line's leading blanks, prefix and indent from `pos`, and
    /// return where reading stopped: at the line's text or past its end.
    fn head(&mut self, data: &[u8], mut pos: usize, out: &mut Vec<u8>) -> usize {
        while pos < data.len() {
            let byte = data[pos];
            if byte == b'\n' {
                self.decide(true, true, out);
                self.end(true, out);
                return pos + 1;
            }
            match self.matched {
                Some(matched) if matched < self.mark.len() => {
                    if byte != self.mark[matched] {
                        self.decide(false, false, out);
                        return pos;
                    }
                    self.matched = Some(matched + 1);
                    self.col += 1;
                }
                _ if byte == b' ' => self.col += 1,
                _ if byte == b'\t' => {
                    self.col += TAB - self.col % TAB;
                    self.tab = true;
                }
                None if !self.mark.is_empty() => {
                    self.lead = self.col;
                    self.matched = Some(0);
                    continue;
                }
                _ => {
                    self.decide(false, false, out);
                    return pos;
                }
            }
            pos += 1;
        }
        pos
    }

    /// Settle what the line whose head was just read is: `bare` when it
    /// ended within its head, `ended` when in a newline.
    fn decide(&mut self, bare: bool, ended: bool, out: &mut Vec<u8>) {
        let (col, tab) = (self.col, self.tab);
        let lead = if !self.prefixed {
            if bare {
                self.interrupt(tab, out);
                out.push(b'\n');
                return;
            }
            0
        } else if self.mark.is_empty() {
            // A prefix of only spaces: GNU 9.7 wants that many columns of
            // leading blanks, and more than that on a line of nothing else.
            // It prints them as the prefix and the rest as indent.
            let floor = self.floor;
            if col < floor || (bare && col == floor) {
                self.interrupt(tab, out);
                if !bare {
                    pad(out, 0, col, self.tabs);
                    self.mode = Mode::Copy;
                } else if ended {
                    out.push(b'\n');
                }
                return;
            }
            if bare {
                self.interrupt(tab, out);
                pad(out, 0, floor, self.tabs);
                out.push(b'\n');
                return;
            }
            floor
        } else if self.matched.is_none_or(|matched| matched < self.mark.len()) {
            // Copied with its leading blanks rewritten; a line of only
            // blanks prints empty, and a last line without a newline stays
            // without.
            let matched = self.matched.unwrap_or(0);
            let lead = if matched > 0 { self.lead } else { col };
            self.interrupt(tab, out);
            if matched > 0 || !bare {
                pad(out, 0, lead, self.tabs);
                out.extend_from_slice(&self.mark[..matched]);
                self.mode = Mode::Copy;
            } else if ended {
                out.push(b'\n');
            }
            return;
        } else {
            let lead = self.lead;
            let after = lead + self.mark.len() as i64;
            if lead < self.floor || col - after < self.trail {
                // Copied too, but GNU 9.7 also rewrites the blanks it read
                // past the prefix, and ends a bare prefix with a newline.
                self.interrupt(tab, out);
                pad(out, 0, lead, self.tabs);
                out.extend_from_slice(&self.mark);
                if bare {
                    out.push(b'\n');
                    return;
                }
                pad(out, after, col, self.tabs);
                self.mode = Mode::Copy;
                return;
            }
            if bare {
                self.interrupt(tab, out);
                pad(out, 0, lead, self.tabs);
                out.extend_from_slice(&self.mark);
                out.push(b'\n');
                return;
            }
            lead
        };
        self.tabs |= tab;
        let mut para = self.para.take();
        let joined = para.as_mut().is_some_and(|para| {
            let joins = self.joins(para, lead, col);
            para.lines += usize::from(joins);
            joins
        });
        if !joined {
            self.para = para;
            self.close(out);
            para = Some(Paragraph {
                lead,
                first_col: col,
                rest_col: self.hang(col),
                lines: 1,
                terms: Vec::new(),
                size: 0,
                last: None,
                after_stop: false,
            });
        }
        self.para = para;
        self.mode = Mode::Text;
        self.tab = false;
    }

    /// Finish the input line being read, `ended` by a newline or not.
    fn end(&mut self, ended: bool, out: &mut Vec<u8>) {
        if self.mode == Mode::Copy && ended {
            out.push(b'\n');
        } else if self.mode == Mode::Text {
            self.finish_word(true, out);
        }
        self.mode = Mode::Start;
        self.col = 0;
        self.tab = false;
        self.matched = None;
    }

    /// End the paragraph before a line printed as it stands, whose blanks
    /// held a tab when `tab`.
    fn interrupt(&mut self, tab: bool, out: &mut Vec<u8>) {
        self.tabs |= tab;
        self.close(out);
    }

    /// Where a paragraph's later lines start until its second line says.
    ///
    /// Under -t alone, GNU 9.7 starts them where the last paragraph's later
    /// lines started, unless that is the first line's own indent: then in
    /// column 3 when that is column 0, and in column 0 otherwise.
    fn hang(&self, indent: i64) -> i64 {
        if !self.tagged || self.crown || self.split {
            indent
        } else if self.hung == indent {
            if indent == 0 { 3 } else { 0 }
        } else {
            self.hung
        }
    }

    /// Whether a line with these blanks continues `para`.
    fn joins(&self, para: &mut Paragraph, lead: i64, indent: i64) -> bool {
        if self.split || lead != para.lead {
            return false;
        }
        if para.lines > 1 {
            return indent == para.rest_col;
        }
        // The second line sets where all lines after the first start.
        if self.crown || (self.tagged && indent != para.first_col) {
            para.rest_col = indent;
            return true;
        }
        !self.tagged && indent == para.first_col
    }

    /// Read words from `pos` up to the line's end, and return where reading
    /// stopped. A word runs to the next space, tab, newline, vertical tab,
    /// form feed or carriage return; only spaces and tabs part it from the
    /// next, so 'a\rb' holds the words 'a' and '\rb'.
    fn text(&mut self, data: &[u8], mut pos: usize, out: &mut Vec<u8>) -> usize {
        while pos < data.len() {
            let byte = data[pos];
            if byte == b'\n' {
                self.end(true, out);
                return pos + 1;
            }
            if !self.word.is_empty() && self.after.is_none() {
                let stop = data[pos..]
                    .iter()
                    .position(|&byte| is_space(byte))
                    .map_or(data.len(), |at| pos + at);
                self.grow(&data[pos..stop], out);
                if stop < data.len() {
                    self.after = Some(self.col);
                }
                pos = stop;
                continue;
            }
            match byte {
                b' ' => self.col += 1,
                b'\t' => {
                    self.col += TAB - self.col % TAB;
                    self.tab = true;
                }
                _ => {
                    if !self.word.is_empty() {
                        self.finish_word(false, out);
                    }
                    self.start = self.col;
                    self.grow(&data[pos..pos + 1], out);
                }
            }
            pos += 1;
        }
        pos
    }

    /// Add `chars` to the word being read. GNU 9.7 prints a piece as soon
    /// as the word overflows it, before reading the rest of the word or the
    /// blanks after it.
    fn grow(&mut self, chars: &[u8], out: &mut Vec<u8>) {
        self.word.extend_from_slice(chars);
        self.col += chars.len() as i64;
        let mut para = self.para.take().expect("a paragraph");
        while para.size + self.word.len() > PIECE_BYTES {
            if !para.terms.is_empty() {
                self.flush(&mut para, self.start, out);
                continue;
            }
            // A word filling a whole piece: GNU 9.7 prints as much of it as
            // a piece holds, with no indent and no newline, and goes on with
            // the rest of it as a word of its own, in the column the word
            // started in.
            out.extend(self.word.drain(..PIECE_BYTES));
            self.col -= PIECE_BYTES as i64;
        }
        self.para = Some(para);
    }

    /// Add the word just read, and the blanks after it, to the paragraph;
    /// `last` when the word ends its line.
    fn finish_word(&mut self, last: bool, out: &mut Vec<u8>) {
        let mut para = self.para.take().expect("a paragraph");
        let chars = std::mem::take(&mut self.word);
        let after = *self.after.get_or_insert(self.col);
        let mut gap = self.col - after;
        let core_len = chars.len()
            - chars
                .iter()
                .rev()
                .take_while(|byte| CLOSERS.contains(byte))
                .count();
        let stop = core_len > 0 && STOPS.contains(&chars[core_len - 1]);
        let ends = stop && (last || gap >= 2);
        if last || self.uniform {
            gap = if ends { 2 } else { 1 };
        }
        if para.terms.len() >= PIECE_WORDS {
            // GNU 9.7 has read this word's trailing blanks by then.
            self.tabs |= self.tab;
            self.flush(&mut para, self.col, out);
        }
        para.size += chars.len();
        para.terms.push(Term {
            gap,
            ends_sentence: ends,
            false_stop: stop && !ends,
            marked: chars.last().is_some_and(u8::is_ascii_punctuation),
            opener: OPENERS.contains(&chars[0]),
            after_stop: para.after_stop,
            chars,
        });
        para.after_stop = ends;
        self.para = Some(para);
        self.tabs |= self.tab;
        self.tab = false;
        self.after = None;
    }

    /// Print a full piece of `para`. Under -c or -t, GNU 9.7 then starts the
    /// paragraph's later lines, whatever its second line said, in the input
    /// column `col` it has read to.
    fn flush(&mut self, para: &mut Paragraph, col: i64, out: &mut Vec<u8>) {
        if (self.crown || self.tagged) && !self.split {
            para.rest_col = col;
        }
        self.settle(para, false, out);
    }

    fn close(&mut self, out: &mut Vec<u8>) {
        let Some(mut para) = self.para.take() else {
            return;
        };
        if para.lines == 1 && !self.split {
            // A paragraph of one line, its later indent settled now: -c
            // takes the first line's, -t keeps the one it has unless that is
            // the first line's own.
            if self.crown {
                para.rest_col = para.first_col;
            } else if self.tagged && para.rest_col == para.first_col {
                para.rest_col = if para.first_col == 0 { 3 } else { 0 };
            }
        }
        self.settle(&mut para, true, out);
        self.hung = para.rest_col;
    }

    /// Print what `para` holds, but for the lines a full piece carries;
    /// `last` when the paragraph has ended.
    fn settle(&self, para: &mut Paragraph, last: bool, out: &mut Vec<u8>) {
        if para.terms.is_empty() {
            return;
        }
        // GNU 9.7 starts every piece's first line in the first line's column.
        let (ends, costs) = plan(
            &para.terms,
            (para.first_col, para.rest_col),
            (self.width, self.goal),
            para.last,
            last,
        );
        let keep = if last || ends.len() == 1 {
            0
        } else {
            resume(&para.terms, &ends, &costs)
        };
        let mut start = 0;
        for &end in &ends {
            if keep > 0 && end > keep {
                break;
            }
            let col = if start > 0 {
                para.rest_col
            } else {
                para.first_col
            };
            para.last = Some(self.print(para, start, end, col, out));
            start = end;
        }
        para.terms
            .drain(..if keep > 0 { keep } else { para.terms.len() });
        para.size = para.terms.iter().map(|term| term.chars.len()).sum();
    }

    /// Print one line of `para` and return its length as laid out. A -t
    /// indent left of the prefix's end counts as given, though the text then
    /// starts right after the prefix.
    fn print(
        &self,
        para: &Paragraph,
        start: usize,
        end: usize,
        col: i64,
        out: &mut Vec<u8>,
    ) -> i64 {
        let mut here = 0;
        if self.prefixed {
            pad(out, 0, para.lead, self.tabs);
            out.extend_from_slice(&self.mark);
            here = para.lead + self.mark.len() as i64;
        }
        pad(out, here, col, self.tabs);
        here = here.max(col);
        let mut length = col;
        for k in start..end {
            let term = &para.terms[k];
            if k > start {
                let gap = para.terms[k - 1].gap;
                pad(out, here, here + gap, self.tabs);
                here += gap;
                length += gap;
            }
            out.extend_from_slice(&term.chars);
            here += term.len();
            length += term.len();
        }
        out.push(b'\n');
        length
    }
}

impl Stream for Layout {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        Layout::feed(self, input, out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        Layout::finish(self, out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::run;

    fn fmt(flags: Value, input: &[u8]) -> Vec<u8> {
        let mut config = json!({
            "width": null,
            "goal": null,
            "prefix": null,
            "split_only": false,
            "tagged": false,
            "crown": false,
            "uniform": false,
        });
        for (key, value) in flags.as_object().expect("flags") {
            config[key] = value.clone();
        }
        let (output, error) = run("fmt", &config.to_string(), &[input]);
        assert_eq!(error, None);
        output
    }

    // Every expectation is what GNU coreutils 9.7 fmt printed for the same
    // input and flags.
    #[test]
    fn layouts_match_gnu() {
        let cases: &[(&str, Value, &[u8], &[u8])] = &[
            ("cost_line_and_goal", json!({"width": 10, "goal": 0}), b"e, efaadg (edb\n", b"e,\nefaadg\n(edb\n"),
            ("cost_uneven", json!({"width": 11}), b"(fd. ae. (af gjhfhj,\n", b"(fd.\nae. (af\ngjhfhj,\n"),
            ("cost_sentence_end", json!({"width": 18, "goal": 10}), b"ghiad, (dhccdi.  (g.\n", b"ghiad,\n(dhccdi.  (g.\n"),
            ("cost_mark_end", json!({"width": 10}), b"fij (f, fe, (jecgg.\n", b"fij\n(f, fe,\n(jecgg.\n"),
            ("cost_opener_start", json!({"width": 9}), b"jh, ejhj (j.  b df,\n", b"jh,\nejhj (j.\nb df,\n"),
            ("cost_first_alone", json!({"width": 13}), b"h fj.  acchc dcfiaa.  jj hie (iifcc (ebbja jhcc\n", b"h fj.  acchc\ndcfiaa.\njj hie\n(iifcc\n(ebbja jhcc\n"),
            ("cost_last_alone", json!({"width": 9, "goal": 9}), b"dc jggg hc,\n", b"dc\njggg hc,\n"),
            ("cost_false_stop_tie_goes_to_the_shorter_line", json!({"width": 63, "goal": 0}), b"aaaa. bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ccccccc\n", b"aaaa.\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ccccccc\n"),
            ("cost_false_stop_outweighs_a_long_line", json!({"width": 64, "goal": 0}), b"aaaa. bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccc\n", b"aaaa. bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ncccccccc\n"),
            ("short_last_word_kept_with_another", json!({"width": 10}), b"aaaa bbbb cc\n", b"aaaa\nbbbb cc\n"),
            ("two_words_stay_under_the_width", json!({"width": 10}), b"aaaa bbbbb\n", b"aaaa\nbbbbb\n"),
            ("remainder_weighs_the_line_after", json!({"width": 33, "goal": 13}), b"dgmvxmkm knkgnmgs bmdmfkrnsj pqfknn hbcf dwqhc nbxp sfnfwpn\n", b"dgmvxmkm knkgnmgs\nbmdmfkrnsj\npqfknn hbcf dwqhc nbxp sfnfwpn\n"),
            ("default_goal_rounds_down", json!({"width": 107}), b"h gdahefd bebdaad aahb ed agabfc haf db bcdec ahgaede gahfa acababh b hfcfb gge edf bcag bcafhga gafhf ghad eb gdgcaff ebhbg bfbahc ga bbgca bab heebad b afcbd dh gefgf gbgdg cghcgcc h hhcced fd egedeae gdcf fh\n", b"h gdahefd bebdaad aahb ed agabfc haf db bcdec ahgaede gahfa acababh b hfcfb gge edf bcag bcafhga gafhf\nghad eb gdgcaff ebhbg bfbahc ga bbgca bab heebad b afcbd dh gefgf gbgdg cghcgcc h hhcced fd egedeae\ngdcf fh\n"),
            ("goal_alone_allows_ten_more", json!({"goal": 20}), b"aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii\n", b"aaaa bbbb cccc dddd\neeee ffff gggg hhhh iiii\n"),
            ("zero_width_puts_a_word_per_line", json!({"width": 0}), b"one two three\n", b"one\ntwo\nthree\n"),
            ("tab_not_shorter", json!({}), b"abcdefg  h\tx\n", b"abcdefg  h\tx\n"),
            ("tab_shorter", json!({}), b"abcdef  h\tx\n", b"abcdef\th\tx\n"),
            ("tab_in_next_indent_counts", json!({}), b"abc     d\n\ta\nabc     d\n", b"abc\td\n\ta\nabc\td\n"),
            ("tab_later_in_next_line_does_not", json!({}), b"abc     d\n  x\ty\n", b"abc     d\n  x\ty\n"),
            ("gap_keeps_its_typed_columns", json!({}), b"abc     d\nx\ty\n", b"abc\td x\t  y\n"),
            ("carriage_return_starts_a_word", json!({"width": 8}), b"aaaa\rbbbb cccc\n", b"aaaa\n\rbbbb\ncccc\n"),
            ("width_counts_bytes", json!({"width": 9}), b"\xc3\xa9\xc3\xa9 bbbb\n", b"\xc3\xa9\xc3\xa9\nbbbb\n"),
            ("closing_quote_keeps_a_sentence_end", json!({"uniform": true}), b"x end.)  next\n", b"x end.)  next\n"),
            ("closing_brace_does_not", json!({"uniform": true}), b"x end.}  next\n", b"x end.} next\n"),
            ("tab_gap_ends_a_sentence_from_two_columns", json!({"uniform": true}), b"abcde.\tnext\nabcdef.\tnext\n", b"abcde.\tnext abcdef. next\n"),
            ("prefix_spaces_are_floors", json!({"prefix": " # ", "width": 10}), b"# aaa bbb ccc\n # aaa bbb ccc\n\t# aaa bbb ccc\n #aaa bbb ccc\n", b"# aaa bbb ccc\n # aaa\n # bbb\n # ccc\n\t# aaa\n\t# bbb\n\t# ccc\n #aaa bbb ccc\n"),
            ("prefix_tab_matches_as_typed", json!({"prefix": "#\t", "width": 10}), b"#\taaa bbb ccc\n# aaa bbb ccc\n", b"#\taaa\n#\tbbb ccc\n# aaa bbb ccc\n"),
            ("prefix_copy_rewrites_blanks_past_it", json!({"prefix": " # "}), b"\tq\n#        x\n", b"\tq\n#\t x\n"),
            ("prefix_lines_share_their_lead", json!({"prefix": "#"}), b" #  a\n #  b\n  # c\n", b" #  a b\n  # c\n"),
            ("prefix_only_line_prints_bare", json!({"prefix": "# "}), b"# \n#   \n  #  a b\n", b"#\n#\n  #  a b\n"),
            ("copied_last_line_stays_without", json!({"prefix": "#"}), b"#a\n  x  ", b"#a\n  x  "),
            ("space_prefix_wants_its_columns", json!({"prefix": "  ", "width": 10}), b"  aaa bbb ccc\n aaa bbb\n    aaa bbb ccc\n  \n   \n\taaa bbb ccc\n", b"  aaa\n  bbb ccc\n aaa bbb\n    aaa\n    bbb\n    ccc\n\n  \n  \taaa\n  \tbbb\n  \tccc\n"),
            ("bare_prefix_last_line_gets_one", json!({"prefix": "  #"}), b"#", b"#\n"),
            ("blank_last_line_gets_one", json!({}), b"a\n   ", b"a\n\n"),
            ("tagged_one_line_hangs_three", json!({"tagged": true, "width": 8}), b"aaa bbb ccc\n", b"aaa bbb\n   ccc\n"),
            ("tagged_one_line_keeps_the_last_hang", json!({"tagged": true, "width": 12}), b"  a\n    b\n\n    xx yy zz ww\n\n    pp qq rr ss\n", b"  a b\n\n    xx yy\nzz ww\n\n    pp qq\nrr ss\n"),
            ("tagged_hang_left_of_the_prefix", json!({"tagged": true, "width": 10, "prefix": "#"}), b"#xx aaaa bbbb\n", b"#xx\n#aaaa bbbb\n"),
            ("crown_one_line_keeps_its_indent", json!({"crown": true, "width": 8}), b"aaa bbb ccc\n", b"aaa\nbbb ccc\n"),
            ("crown_wins_over_tagged", json!({"crown": true, "tagged": true}), b"a b\nc d\ne f\n", b"a b c d e f\n"),
            ("split_keeps_each_line_and_its_indent", json!({"split_only": true, "width": 6}), b"  aaa bbb ccc\nddd eee\n", b"  aaa\n  bbb\n  ccc\nddd\neee\n"),
        ];
        for (name, flags, input, expected) in cases {
            assert_eq!(fmt(flags.clone(), input), *expected, "{name}");
        }
    }

    #[test]
    fn input_split_anywhere_gives_the_same_output() {
        let data = b"#  one two.  three\n# four\tfive six seven eight nine ten\n\n#x\n";
        let config = json!({
            "width": 12, "goal": null, "prefix": "#", "split_only": false,
            "tagged": false, "crown": false, "uniform": false,
        })
        .to_string();
        let whole = run("fmt", &config, &[data]).0;
        let bytes: Vec<&[u8]> = data.chunks(1).collect();
        assert_eq!(run("fmt", &config, &bytes).0, whole);
    }

    fn lcg_words(seed: u64, count: usize) -> Vec<Vec<u8>> {
        let mut x = seed;
        let mut next = || {
            x = (x * 1_103_515_245 + 12345) % 2_147_483_648;
            x
        };
        (0..count)
            .map(|_| {
                let letters = 2 + (next() >> 16) % 7;
                (0..letters)
                    .map(|_| b"abcdefgh"[((next() >> 16) % 8) as usize])
                    .collect()
            })
            .collect()
    }

    fn words_per_line(out: &[u8]) -> String {
        let text = String::from_utf8_lossy(out);
        let mut lines: Vec<&str> = text.split('\n').collect();
        lines.pop();
        lines
            .iter()
            .map(|line| line.split_whitespace().count().to_string())
            .collect()
    }

    fn words(words: &[Vec<u8>]) -> Vec<u8> {
        let mut data = words.join(&b' ');
        data.push(b'\n');
        data
    }

    #[test]
    fn a_piece_holds_998_words() {
        let out = fmt(json!({}), &words(&vec![b"a".to_vec(); 999]));
        assert_eq!(
            words_per_line(&out),
            "35".repeat(11) + &"36".repeat(17) + "2"
        );
    }

    #[test]
    fn a_piece_holds_5000_bytes_of_words() {
        // Word text reaching exactly 5000 bytes, then a one-byte word.
        let pool = lcg_words(157, 2000);
        let mut list: Vec<Vec<u8>> = Vec::new();
        let mut size = 0;
        while size < 4990 {
            list.push(pool[list.len()].clone());
            size += list[list.len() - 1].len();
        }
        let rest = pool[list.len()..list.len() + 40].to_vec();
        list.push(vec![b'q'; 5000 - size]);
        list.push(b"x".to_vec());
        list.extend(rest);
        assert_eq!(
            words_per_line(&fmt(json!({"width": 40}), &words(&list))),
            "567669678666667766655675565664767676666756546755677555776775755667\
             666665867687585566667667667665677875565767766575676655766776566667\
             6575977566766666677668765577657785753"
        );
    }

    #[test]
    fn a_piece_weighs_its_first_line_against_the_last_printed() {
        let list: Vec<Vec<u8>> = (0..1300)
            .map(|i| {
                (0..1 + i * 5 % 9)
                    .map(|j| b"abcdefgh"[(i * 7 + j) % 8])
                    .collect()
            })
            .collect();
        assert_eq!(
            words_per_line(&fmt(json!({"width": 40}), &words(&list))),
            "7".to_owned()
                + &"6".repeat(162)
                + "7"
                + &"6".repeat(3)
                + "5"
                + &"6".repeat(46)
                + "762"
        );
    }

    #[test]
    fn a_piece_of_998_words_has_read_the_next_words_blanks() {
        // The tab after the 999th word is read before the first piece prints.
        let mut data = b"        ".to_vec();
        data.extend(vec![&b"abcd"[..]; 999].join(&b' '));
        data.push(b'\t');
        data.extend(vec![&b"abcd"[..]; 101].join(&b' '));
        data.push(b'\n');
        let out = fmt(json!({"width": 40}), &data);
        let lines: Vec<&[u8]> = out.split(|&byte| byte == b'\n').collect();
        assert_eq!(lines.len(), 185);
        assert!(lines[..184].iter().all(|line| line.starts_with(b"\t")));
    }
}
