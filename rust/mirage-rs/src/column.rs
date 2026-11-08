use std::collections::VecDeque;

use serde::Deserialize;

use crate::task::{self, Host};
use crate::utf8::next_lossy;
use crate::width::{TAB_WIDTH, char_width, is_space};
use crate::{Stream, StreamError, parse_config};

const WIDTH: u64 = 80;
const WORK: usize = 4096;
const OUTPUT: usize = 16384;
/// The most input column holds, with a row's cell for each line it lays
/// out across or a width for each column of a table: past it the run fails
/// as the real one does once memory runs out.
#[cfg(not(test))]
const MAX_HELD: usize = 1 << 30;
#[cfg(test)]
const MAX_HELD: usize = 1 << 18;
const OUT_OF_MEMORY: &[u8] = b"column: read failed: Cannot allocate memory";
/// The column a `-` or a 0 in a column list stands for: every one.
const ALL_COLUMNS: &[u8] = b"-";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    table: bool,
    #[serde(deserialize_with = "crate::latin1_opt")]
    separator: Option<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1")]
    output_separator: Vec<u8>,
    columns: Option<String>,
    inputs: usize,
    #[serde(default)]
    fillrows: bool,
    #[serde(default)]
    json: bool,
    #[serde(default)]
    maxout: bool,
    #[serde(default)]
    no_headings: bool,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    output_width: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    limit: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    names: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    table_name: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    right: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    hide: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    order: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    truncate: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    wrap: Option<Vec<u8>>,
    /// Each `--table-column` as typed, in order.
    /// Named only so an undefined column in it is refused: it changes
    /// nothing for a table that fits.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    noextreme: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_list")]
    column_specs: Vec<Vec<u8>>,
}

fn refusal(message: &str) -> StreamError {
    StreamError::refusal(format!("column: {message}").as_bytes(), 1)
}

/// A `--table-column`'s properties: only `name=`, `right`, `hidden`,
/// `trunc`, `wrap` and `json=number` change what column prints; the others
/// are taken and do nothing for a table that fits.
#[derive(Default)]
struct Spec {
    name: Option<Vec<u8>>,
    right: bool,
    hidden: bool,
    trunc: bool,
    wrap: bool,
    raw_json: bool,
}

fn spec(text: &[u8]) -> Spec {
    let mut out = Spec::default();
    for word in text.split(|b| *b == b',') {
        match word {
            b"right" => out.right = true,
            b"hidden" => out.hidden = true,
            b"trunc" => out.trunc = true,
            b"wrap" => out.wrap = true,
            b"json=number" => out.raw_json = true,
            _ => {
                if let Some(name) = word.strip_prefix(b"name=") {
                    out.name = (!name.is_empty()).then(|| name.to_vec());
                }
            }
        }
    }
    out
}

fn digits(raw: &[u8]) -> Option<u64> {
    (!raw.is_empty() && raw.iter().all(u8::is_ascii_digit))
        .then(|| std::str::from_utf8(raw).ok()?.parse().ok())
        .flatten()
}

/// What the options typed say before any input is read.
struct Checked {
    width: Option<u64>,
    limit: Option<usize>,
    specs: Vec<Spec>,
}

fn validated(config: &Config) -> Result<Checked, StreamError> {
    if config.fillrows && config.table {
        return Err(refusal("mutually exclusive arguments: --table --fillrows"));
    }
    if config.fillrows && config.json {
        return Err(refusal("mutually exclusive arguments: --json --fillrows"));
    }
    if !config.column_specs.is_empty() && config.names.is_some() {
        return Err(refusal(
            "mutually exclusive arguments: --table-column --table-columns",
        ));
    }
    let width = match &config.output_width {
        None => None,
        Some(raw) if raw == b"unlimited" => Some(0),
        Some(raw) => Some(digits(raw).ok_or_else(|| {
            refusal(&format!(
                "invalid columns argument: '{}'",
                String::from_utf8_lossy(raw)
            ))
        })?),
    };
    let limit = match &config.limit {
        None => None,
        Some(raw) => {
            let limit = digits(raw).ok_or_else(|| {
                refusal(&format!(
                    "invalid columns limit argument: '{}'",
                    String::from_utf8_lossy(raw)
                ))
            })?;
            if limit == 0 {
                return Err(refusal("columns limit must be greater than zero"));
            }
            Some(usize::try_from(limit).unwrap_or(usize::MAX))
        }
    };
    let needs_table = [
        &config.names,
        &config.table_name,
        &config.right,
        &config.hide,
        &config.order,
        &config.truncate,
        &config.wrap,
        &config.noextreme,
    ]
    .iter()
    .any(|option| option.is_some())
        || !config.column_specs.is_empty();
    if needs_table && !config.table && !config.json {
        return Err(refusal("option --table required for all --table-*"));
    }
    if config.json && config.names.is_none() && config.column_specs.is_empty() {
        return Err(refusal(
            "option --table-columns or --table-column required for --json",
        ));
    }
    let specs = config.column_specs.iter().map(|text| spec(text)).collect();
    Ok(Checked {
        width,
        limit,
        specs,
    })
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let mut config: Config = parse_config(config)?;
    let Checked {
        width: typed,
        limit,
        specs,
    } = validated(&config)?;
    config.table = config.table || config.json;
    let width = match config.columns.as_deref() {
        Some(raw) if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) => {
            raw.bytes().fold(0u64, |n, b| {
                n.saturating_mul(10).saturating_add(u64::from(b - b'0'))
            })
        }
        _ => 0,
    };
    Ok(Box::new(Column {
        width: typed.unwrap_or(if width == 0 { WIDTH } else { width }),
        limit,
        specs,
        inputs: config.inputs,
        config: Some(config),
        text: Vec::new(),
        rows: 0,
        input: 0,
        engine: None,
    }))
}

struct Column {
    config: Option<Config>,
    width: u64,
    limit: Option<usize>,
    specs: Vec<Spec>,
    text: Vec<u8>,
    rows: usize,
    input: usize,
    inputs: usize,
    engine: Option<Box<dyn Stream>>,
}

#[derive(Clone, Copy)]
struct Cell {
    start: usize,
    end: usize,
    width: u64,
}

struct Meter {
    host: Host,
    work: usize,
}
impl Meter {
    fn charge(&mut self, work: usize) -> bool {
        self.work = self.work.saturating_sub(work);
        self.work == 0
    }
    async fn pause(&mut self) {
        self.host.pause().await;
        self.work = WORK;
    }
    async fn spend(&mut self, work: usize) {
        if self.charge(work) {
            self.pause().await;
        }
    }
}

struct Separator {
    chars: Vec<char>,
    prefix: Vec<usize>,
    width: u64,
}
impl Separator {
    fn new(bytes: &[u8]) -> Self {
        let chars: Vec<char> = String::from_utf8_lossy(bytes).chars().collect();
        let mut prefix = vec![0; chars.len()];
        for at in 1..chars.len() {
            let mut before = prefix[at - 1];
            while before > 0 && chars[before] != chars[at] {
                before = prefix[before - 1];
            }
            if chars[before] == chars[at] {
                before += 1;
            }
            prefix[at] = before;
        }
        let width = chars.iter().map(|c| char_width(u32::from(*c))).sum();
        Self {
            chars,
            prefix,
            width,
        }
    }
}

#[derive(Default)]
struct Cells {
    at: usize,
    end: usize,
    start: usize,
    width: u64,
    active: bool,
    done: bool,
    matched: usize,
    starts: VecDeque<usize>,
}

impl Cells {
    fn reset(&mut self, row: Cell) {
        self.at = row.start;
        self.end = row.end;
        self.start = row.start;
        self.width = 0;
        self.active = false;
        self.done = false;
        self.matched = 0;
        self.starts.clear();
    }

    async fn next_literal(
        &mut self,
        text: &[u8],
        separator: u8,
        meter: &mut Meter,
    ) -> Option<Cell> {
        while self.at < self.end {
            let stop = boundary(text, self.at.saturating_add(meter.work), self.end);
            let delimiter = memchr::memchr(separator, &text[self.at..stop]).map(|at| self.at + at);
            let end = delimiter.unwrap_or(stop);
            self.width += width(&text[self.at..end]);
            let used = end - self.at;
            self.at = end;
            if meter.charge(used) {
                meter.pause().await;
            }
            if let Some(end) = delimiter {
                let cell = Cell {
                    start: self.start,
                    end,
                    width: self.width,
                };
                self.at += 1;
                self.start = self.at;
                self.width = 0;
                if meter.charge(1) {
                    meter.pause().await;
                }
                return Some(cell);
            }
        }
        self.done = true;
        Some(Cell {
            start: self.start,
            end: self.end,
            width: self.width,
        })
    }

    async fn next(
        &mut self,
        text: &[u8],
        separator: Option<&Separator>,
        meter: &mut Meter,
    ) -> Option<Cell> {
        if self.done {
            return None;
        }
        if let Some(separator) = separator
            .filter(|separator| separator.chars.len() == 1 && separator.chars[0].is_ascii())
        {
            return self
                .next_literal(text, separator.chars[0] as u8, meter)
                .await;
        }
        while let Some((c, used)) = next_lossy(text, self.at, self.end) {
            let start = self.at;
            self.at += used;
            if meter.charge(used) {
                meter.pause().await;
            }
            if let Some(separator) = separator {
                self.width += char_width(u32::from(c));
                self.starts.push_back(start);
                if self.starts.len() > separator.chars.len() {
                    self.starts.pop_front();
                }
                while self.matched > 0 && separator.chars[self.matched] != c {
                    self.matched = separator.prefix[self.matched - 1];
                    if meter.charge(1) {
                        meter.pause().await;
                    }
                }
                if separator.chars[self.matched] == c {
                    self.matched += 1;
                }
                if self.matched == separator.chars.len() {
                    let cell = Cell {
                        start: self.start,
                        end: *self.starts.front().unwrap(),
                        width: self.width - separator.width,
                    };
                    self.start = self.at;
                    self.width = 0;
                    self.matched = 0;
                    self.starts.clear();
                    return Some(cell);
                }
            } else if matches!(c, ' ' | '\t') {
                if self.active {
                    let cell = Cell {
                        start: self.start,
                        end: start,
                        width: self.width,
                    };
                    self.active = false;
                    self.width = 0;
                    return Some(cell);
                }
            } else {
                if !self.active {
                    self.start = start;
                    self.active = true;
                }
                self.width += char_width(u32::from(c));
            }
        }
        self.done = true;
        if separator.is_some() || self.active {
            Some(Cell {
                start: self.start,
                end: self.end,
                width: self.width,
            })
        } else {
            None
        }
    }
}

impl Cells {
    /// What is left of the row as one cell, the last `-l` allows: from the
    /// next cell's start to the end of the line, as typed.
    async fn rest(
        &mut self,
        text: &[u8],
        separator: Option<&Separator>,
        meter: &mut Meter,
    ) -> Option<Cell> {
        if self.done {
            return None;
        }
        self.done = true;
        if separator.is_some() {
            self.at = self.start;
        } else {
            while self.at < self.end && matches!(text[self.at], b' ' | b'\t') {
                self.at += 1;
            }
            if self.at == self.end && !self.active {
                return None;
            }
            if !self.active {
                self.start = self.at;
            }
        }
        let start = self.start;
        let cell = Cell {
            start,
            end: self.end,
            width: measured(text, start, self.end, meter).await,
        };
        Some(cell)
    }
}

/// The columns `text[start..end]` takes, a bounded window per turn.
async fn measured(text: &[u8], start: usize, end: usize, meter: &mut Meter) -> u64 {
    let (mut at, mut total) = (start, 0);
    while at < end {
        let stop = boundary(text, at.saturating_add(meter.work), end);
        total += width(&text[at..stop]);
        meter.spend(stop - at).await;
        at = stop;
    }
    total
}

struct Writer {
    host: Host,
    bytes: Vec<u8>,
}
impl Writer {
    async fn flush(&mut self) {
        if !self.bytes.is_empty() {
            self.host.print(&self.bytes);
            self.bytes.clear();
            self.host.pause().await;
        }
    }
    async fn raw(&mut self, bytes: &[u8]) {
        let mut at = 0;
        while at < bytes.len() {
            let end = bytes.len().min(at + OUTPUT - self.bytes.len());
            self.bytes.extend_from_slice(&bytes[at..end]);
            at = end;
            if self.bytes.len() == OUTPUT {
                self.flush().await;
            }
        }
    }
    async fn repeat(&mut self, byte: u8, mut count: u64) {
        while count > 0 {
            let keep = count.min((OUTPUT - self.bytes.len()) as u64) as usize;
            self.bytes.resize(self.bytes.len() + keep, byte);
            count -= keep as u64;
            if self.bytes.len() == OUTPUT {
                self.flush().await;
            }
        }
    }
    /// A cell as a JSON string's insides: valid text as it is, a control
    /// character escaped, and an invalid byte spelled out.
    async fn json(&mut self, text: &[u8], cell: Cell, meter: &mut Meter) {
        let mut at = cell.start;
        while at < cell.end {
            let end = boundary(text, at.saturating_add(meter.work), cell.end);
            for chunk in text[at..end].utf8_chunks() {
                for c in chunk.valid().chars() {
                    match c {
                        '"' => self.raw(b"\\\"").await,
                        '\\' => self.raw(b"\\\\").await,
                        '\u{8}' => self.raw(b"\\b").await,
                        '\u{c}' => self.raw(b"\\f").await,
                        '\n' => self.raw(b"\\n").await,
                        '\r' => self.raw(b"\\r").await,
                        '\t' => self.raw(b"\\t").await,
                        c if u32::from(c) < 0x20 => {
                            self.raw(format!("\\u{:04x}", u32::from(c)).as_bytes())
                                .await;
                        }
                        c => self.raw(c.encode_utf8(&mut [0; 4]).as_bytes()).await,
                    }
                }
                for byte in chunk.invalid() {
                    self.raw(format!("\\\\x{byte:02x}").as_bytes()).await;
                }
            }
            meter.spend(end - at).await;
            at = end;
        }
    }

    /// A cell's bytes, each invalid sequence written as U+FFFD.
    async fn text(&mut self, text: &[u8], cell: Cell, meter: &mut Meter) {
        let mut at = cell.start;
        while at < cell.end {
            let end = boundary(text, at.saturating_add(meter.work), cell.end);
            for chunk in text[at..end].utf8_chunks() {
                self.raw(chunk.valid().as_bytes()).await;
                if !chunk.invalid().is_empty() {
                    self.raw("\u{fffd}".as_bytes()).await;
                }
            }
            meter.spend(end - at).await;
            at = end;
        }
    }
}

/// The first place at or past `at`, and at most `end`, that starts a
/// lossy UTF-8 unit: no unit takes a byte that is not a continuation byte
/// past its first, and none is longer than four bytes, so a unit begun
/// before `at` ends within three bytes of it.
fn boundary(text: &[u8], at: usize, end: usize) -> usize {
    let mut at = at.min(end);
    let last = at.saturating_add(3).min(end);
    while at < last && matches!(text[at], 0x80..=0xbf) {
        at += 1;
    }
    at
}

/// The columns whole lossy units take, U+FFFD for each invalid sequence.
fn width(bytes: &[u8]) -> u64 {
    bytes
        .utf8_chunks()
        .map(|chunk| {
            let valid: u64 = chunk
                .valid()
                .chars()
                .map(|c| char_width(u32::from(c)))
                .sum();
            valid + u64::from(!chunk.invalid().is_empty()) * char_width(0xfffd)
        })
        .sum()
}

/// The lines that hold more than blanks, in order: an entry each, its
/// width counted unless `table` lays its cells out instead.
#[derive(Default)]
struct Lines {
    at: usize,
}

impl Lines {
    async fn next(&mut self, text: &[u8], table: bool, meter: &mut Meter) -> Option<Cell> {
        let (mut start, mut columns, mut nonblank) = (self.at, 0, false);
        while self.at < text.len() {
            if table && nonblank {
                let end = text.len().min(self.at.saturating_add(meter.work));
                let delimiter = memchr::memchr(b'\n', &text[self.at..end]).map(|at| self.at + at);
                let stop = delimiter.map_or(end, |at| at + 1);
                meter.spend(stop - self.at).await;
                self.at = stop;
                if let Some(end) = delimiter {
                    return Some(Cell {
                        start,
                        end,
                        width: 0,
                    });
                }
                continue;
            }
            let (c, used) = next_lossy(text, self.at, text.len()).unwrap();
            let at = self.at;
            self.at += used;
            meter.spend(used).await;
            if c == '\n' {
                if nonblank {
                    return Some(Cell {
                        start,
                        end: at,
                        width: columns,
                    });
                }
                start = self.at;
                columns = 0;
            } else {
                if !table {
                    columns += char_width(u32::from(c));
                }
                nonblank = nonblank || !is_space(u32::from(c));
            }
        }
        nonblank.then_some(Cell {
            start,
            end: text.len(),
            width: columns,
        })
    }
}

/// One column of a table: what its cells measure and how it prints.
#[derive(Default)]
struct Slot {
    name: Option<Vec<u8>>,
    width: u64,
    cells: u64,
    total: u64,
    squares: u128,
    right: bool,
    hidden: bool,
    trunc: bool,
    wrap: bool,
    raw_json: bool,
}

impl Slot {
    /// How far a column's widths stray from their mean, scaled to compare
    /// exactly: which of two equally wide columns takes the spare width.
    fn deviation(&self) -> f64 {
        if self.cells == 0 {
            return 0.0;
        }
        let cells = self.cells as f64;
        (self.squares as f64 / cells - (self.total as f64 / cells).powi(2)).max(0.0)
    }
}

/// The columns a list names, by position: a `-` alone or a 0 is every
/// column, a `-` among others every unnamed one, `N-M` a range, `-N` the
/// Nth from the end, digits a position, and anything else a name.
fn listed(list: &[u8], slots: &[Slot], every: bool) -> Result<Vec<usize>, Vec<u8>> {
    let all = || (0..slots.len()).collect::<Vec<usize>>();
    if list == ALL_COLUMNS && every {
        return Ok(all());
    }
    let undefined =
        |word: &[u8]| [b"column: undefined column name '".as_slice(), word, b"'"].concat();
    let mut out = Vec::new();
    for word in list.split(|b| *b == b',').filter(|word| !word.is_empty()) {
        if word == ALL_COLUMNS && every {
            out.extend((0..slots.len()).filter(|at| slots[*at].name.is_none()));
        } else if let Some(number) = digits(word) {
            match usize::try_from(number).unwrap_or(usize::MAX) {
                0 if every => out.extend(all()),
                at if (1..=slots.len()).contains(&at) => out.push(at - 1),
                _ => return Err(undefined(word)),
            }
        } else if let Some(back) = word.strip_prefix(b"-").and_then(digits) {
            let back = usize::try_from(back).unwrap_or(usize::MAX);
            if (1..=slots.len()).contains(&back) {
                out.push(slots.len() - back);
            }
        } else if let Some((low, high)) = range(word) {
            out.extend(
                (low..=high.min(slots.len()))
                    .filter(|at| *at > 0)
                    .map(|at| at - 1),
            );
        } else {
            let at = slots
                .iter()
                .position(|slot| slot.name.as_deref() == Some(word));
            out.push(at.ok_or_else(|| undefined(word))?);
        }
    }
    Ok(out)
}

fn range(word: &[u8]) -> Option<(usize, usize)> {
    let at = word.iter().position(|b| *b == b'-')?;
    let low = usize::try_from(digits(&word[..at])?).ok()?;
    let high = usize::try_from(digits(&word[at + 1..])?).ok()?;
    Some((low, high))
}

/// Take `excess` columns from `picks`, the widest first, none below one.
fn shrink(slots: &mut [Slot], picks: &[usize], excess: u64) {
    let room: u64 = picks
        .iter()
        .map(|at| slots[*at].width.saturating_sub(1))
        .sum();
    let need = excess.min(room);
    let taken = |slots: &[Slot], level: u64| -> u64 {
        picks
            .iter()
            .map(|at| slots[*at].width.saturating_sub(level))
            .sum()
    };
    let (mut low, mut high) = (
        1,
        picks.iter().map(|at| slots[*at].width).max().unwrap_or(1),
    );
    while low < high {
        let level = low + (high - low) / 2;
        if taken(slots, level) <= need {
            high = level;
        } else {
            low = level + 1;
        }
    }
    let mut left = need - taken(slots, low);
    for at in picks {
        slots[*at].width = slots[*at].width.min(low);
        if left > 0 && slots[*at].width == low && low > 1 {
            slots[*at].width -= 1;
            left -= 1;
        }
    }
}

/// Give the shown columns the spare width: an equal share each, then one
/// more to the widest, the most uneven first and the later before the
/// earlier.
fn enlarge(slots: &mut [Slot], shown: &[usize], spare: u64) {
    let count = shown.len() as u64;
    let share = spare / count;
    let mut order = shown.to_vec();
    order.sort_by(|a, b| {
        slots[*b]
            .width
            .cmp(&slots[*a].width)
            .then_with(|| slots[*b].deviation().total_cmp(&slots[*a].deviation()))
            .then_with(|| b.cmp(a))
    });
    for at in shown {
        slots[*at].width += share;
    }
    for at in order
        .iter()
        .take(usize::try_from(spare % count).unwrap_or(0))
    {
        slots[*at].width += 1;
    }
}

/// The longest start of `cell` that fits `limit` columns, a whole
/// character at a time, and what is left of it.
fn clip(text: &[u8], cell: Cell, limit: u64) -> (Cell, Option<Cell>) {
    let (mut at, mut used) = (cell.start, 0);
    while let Some((c, size)) = next_lossy(text, at, cell.end) {
        let wide = char_width(u32::from(c));
        if used + wide > limit {
            break;
        }
        used += wide;
        at += size;
    }
    if at == cell.start {
        return (
            Cell {
                end: at,
                width: 0,
                ..cell
            },
            None,
        );
    }
    let rest = (at < cell.end).then_some(Cell {
        start: at,
        end: cell.end,
        width: cell.width - used,
    });
    (
        Cell {
            end: at,
            width: used,
            ..cell
        },
        rest,
    )
}

const EMPTY: Cell = Cell {
    start: 0,
    end: 0,
    width: 0,
};

/// One row, a physical line per turn while a wrapped cell has more.
#[allow(clippy::too_many_arguments)]
async fn write_row(
    writer: &mut Writer,
    meter: &mut Meter,
    text: &[u8],
    slots: &[Slot],
    shown: &[usize],
    cells: &mut [Cell],
    separator: &[u8],
    maxout: bool,
) {
    loop {
        let mut more = false;
        for (position, at) in shown.iter().enumerate() {
            if position > 0 {
                writer.raw(separator).await;
            }
            let slot = &slots[*at];
            let cell = cells[*at];
            let (part, rest) = if cell.width > slot.width && (slot.trunc || slot.wrap) {
                clip(text, cell, slot.width)
            } else {
                (cell, None)
            };
            let kept = rest.filter(|_| slot.wrap);
            more = more || kept.is_some();
            cells[*at] = kept.unwrap_or(EMPTY);
            let last = position + 1 == shown.len();
            let pad = if last && !maxout && !slot.right {
                0
            } else {
                slot.width.saturating_sub(part.width)
            };
            if slot.right {
                writer.repeat(b' ', pad).await;
            }
            writer.text(text, part, meter).await;
            if !slot.right {
                writer.repeat(b' ', pad).await;
            }
            meter.spend(1).await;
        }
        writer.raw(b"\n").await;
        if !more {
            return;
        }
    }
}

/// Lay a table out, or print it as JSON. What it refuses is the message.
#[allow(clippy::too_many_arguments)]
async fn table(
    config: &Config,
    width: u64,
    limit: Option<usize>,
    specs: Vec<Spec>,
    text: &[u8],
    separator: Option<&Separator>,
    meter: &mut Meter,
    writer: &mut Writer,
) -> Result<(), Vec<u8>> {
    let mut named: Vec<Option<Vec<u8>>> = match &config.names {
        Some(names) => names
            .split(|b| *b == b',')
            .filter(|name| !name.is_empty())
            .map(|name| Some(name.to_vec()))
            .collect(),
        None => specs.iter().map(|spec| spec.name.clone()).collect(),
    };
    let header = config.names.is_some() || !specs.is_empty();
    let names = named.iter().filter(|name| name.is_some()).count();
    let mut slots: Vec<Slot> = Vec::new();
    let mut reader = Cells::default();
    let mut rows = Lines::default();
    let mut row = 0;
    while let Some(line) = rows.next(text, true, meter).await {
        reader.reset(line);
        let mut index = 0;
        loop {
            let cell = if limit == Some(index + 1) {
                reader.rest(text, separator, meter).await
            } else {
                reader.next(text, separator, meter).await
            };
            let Some(cell) = cell else {
                break;
            };
            if config.json && index >= names {
                return Err(format!(
                    "column: line {}: for JSON the name of the column {} is required",
                    row + 2,
                    index + 1
                )
                .into_bytes());
            }
            if slots.len() <= index {
                if (index + 1) * size_of::<Slot>() + text.len() > MAX_HELD {
                    return Err(OUT_OF_MEMORY.to_vec());
                }
                slots.push(Slot::default());
            }
            let slot = &mut slots[index];
            slot.width = slot.width.max(cell.width);
            slot.cells += 1;
            slot.total += cell.width;
            slot.squares += u128::from(cell.width) * u128::from(cell.width);
            index += 1;
            meter.spend(1).await;
        }
        row += 1;
    }
    if row == 0 {
        return Ok(());
    }
    while slots.len() < named.len() {
        slots.push(Slot::default());
    }
    named.resize(slots.len(), None);
    for ((slot, name), spec) in slots
        .iter_mut()
        .zip(named)
        .zip(specs.iter().map(Some).chain(std::iter::repeat(None)))
    {
        if let Some(name) = &name {
            if header && !config.no_headings {
                slot.width = slot.width.max(self::width(name));
            }
        }
        slot.name = name;
        if let Some(spec) = spec {
            slot.right = spec.right;
            slot.hidden = spec.hidden;
            slot.trunc = spec.trunc;
            slot.wrap = spec.wrap;
            slot.raw_json = spec.raw_json;
        }
    }
    let picks = |list: &Option<Vec<u8>>, slots: &[Slot]| match list {
        Some(list) => listed(list, slots, true),
        None => Ok(Vec::new()),
    };
    for at in picks(&config.right, &slots)? {
        slots[at].right = true;
    }
    for at in picks(&config.hide, &slots)? {
        slots[at].hidden = true;
    }
    for at in picks(&config.truncate, &slots)? {
        slots[at].trunc = true;
    }
    for at in picks(&config.wrap, &slots)? {
        slots[at].wrap = true;
    }
    picks(&config.noextreme, &slots)?;
    let mut order = match &config.order {
        Some(list) => listed(list, &slots, false)?,
        None => Vec::new(),
    };
    let mut seen = vec![false; slots.len()];
    order.retain(|at| !std::mem::replace(&mut seen[*at], true));
    order.extend((0..slots.len()).filter(|at| !seen[*at]));
    let shown: Vec<usize> = order.into_iter().filter(|at| !slots[*at].hidden).collect();
    let mut cells = vec![EMPTY; slots.len()];
    if config.json {
        return json_table(
            config, limit, text, separator, meter, writer, &slots, &shown, &mut cells,
        )
        .await;
    }
    let gap = self::width(&config.output_separator);
    if !shown.is_empty() && width > 0 {
        let used =
            shown.iter().map(|at| slots[*at].width).sum::<u64>() + gap * (shown.len() as u64 - 1);
        if used > width {
            let picks: Vec<usize> = shown
                .iter()
                .copied()
                .filter(|at| slots[*at].trunc || slots[*at].wrap)
                .collect();
            shrink(&mut slots, &picks, used - width);
        } else if config.maxout && used < width {
            enlarge(&mut slots, &shown, width - used);
        }
    }
    if header && !config.no_headings {
        let names: Vec<Option<Vec<u8>>> = slots.iter().map(|slot| slot.name.clone()).collect();
        let mut joined = Vec::new();
        let mut spans = vec![EMPTY; slots.len()];
        for (at, name) in names.iter().enumerate() {
            if let Some(name) = name {
                spans[at] = Cell {
                    start: joined.len(),
                    end: joined.len() + name.len(),
                    width: self::width(name),
                };
                joined.extend_from_slice(name);
            }
        }
        write_row(
            writer,
            meter,
            &joined,
            &slots,
            &shown,
            &mut spans,
            &config.output_separator,
            config.maxout,
        )
        .await;
    }
    let mut rows = Lines::default();
    while let Some(line) = rows.next(text, true, meter).await {
        read_row(&mut reader, line, limit, text, separator, meter, &mut cells).await;
        write_row(
            writer,
            meter,
            text,
            &slots,
            &shown,
            &mut cells,
            &config.output_separator,
            config.maxout,
        )
        .await;
    }
    Ok(())
}

/// One line's cells, by column; the columns it does not reach are empty.
async fn read_row(
    reader: &mut Cells,
    line: Cell,
    limit: Option<usize>,
    text: &[u8],
    separator: Option<&Separator>,
    meter: &mut Meter,
    cells: &mut [Cell],
) {
    reader.reset(line);
    cells.fill(EMPTY);
    let mut index = 0;
    loop {
        let cell = if limit == Some(index + 1) {
            reader.rest(text, separator, meter).await
        } else {
            reader.next(text, separator, meter).await
        };
        let Some(cell) = cell else {
            return;
        };
        cells[index] = cell;
        index += 1;
    }
}

/// The table as JSON: one object a row, an empty cell a null.
#[allow(clippy::too_many_arguments)]
async fn json_table(
    config: &Config,
    limit: Option<usize>,
    text: &[u8],
    separator: Option<&Separator>,
    meter: &mut Meter,
    writer: &mut Writer,
    slots: &[Slot],
    shown: &[usize],
    cells: &mut [Cell],
) -> Result<(), Vec<u8>> {
    let keys: Vec<Vec<u8>> = slots
        .iter()
        .map(|slot| {
            String::from_utf8_lossy(slot.name.as_deref().unwrap_or_default())
                .to_lowercase()
                .into_bytes()
        })
        .collect();
    let name = config.table_name.as_deref().unwrap_or(b"table");
    writer.raw(b"{\n   \"").await;
    let span = Cell {
        start: 0,
        end: name.len(),
        width: 0,
    };
    writer.json(name, span, meter).await;
    writer.raw(b"\": [\n      {\n").await;
    let mut rows = Lines::default();
    let mut first = true;
    while let Some(line) = rows.next(text, true, meter).await {
        read_row(
            &mut Cells::default(),
            line,
            limit,
            text,
            separator,
            meter,
            cells,
        )
        .await;
        if !std::mem::replace(&mut first, false) {
            writer.raw(b"\n      },{\n").await;
        }
        for (position, at) in shown.iter().enumerate() {
            if position > 0 {
                writer.raw(b",\n").await;
            }
            writer.raw(b"         \"").await;
            let span = Cell {
                start: 0,
                end: keys[*at].len(),
                width: 0,
            };
            writer.json(&keys[*at], span, meter).await;
            writer.raw(b"\": ").await;
            let cell = cells[*at];
            if cell.start == cell.end {
                writer.raw(b"null").await;
            } else if slots[*at].raw_json {
                writer.text(text, cell, meter).await;
            } else {
                writer.raw(b"\"").await;
                writer.json(text, cell, meter).await;
                writer.raw(b"\"").await;
            }
            meter.spend(1).await;
        }
    }
    writer.raw(b"\n      }\n   ]\n}\n").await;
    Ok(())
}

/// One line of entries at tab stops `stop` columns apart.
async fn lay_out(
    writer: &mut Writer,
    meter: &mut Meter,
    text: &[u8],
    line: impl Iterator<Item = Cell>,
    stop: u64,
) {
    let mut line = line.peekable();
    let (mut at, mut end) = (0, stop);
    while let Some(cell) = line.next() {
        writer.text(text, cell, meter).await;
        at += cell.width;
        if line.peek().is_none() {
            break;
        }
        let tabs = end.saturating_sub(at).div_ceil(TAB_WIDTH);
        writer.repeat(b'\t', tabs).await;
        if tabs > 0 {
            at = end;
        }
        end += stop;
        meter.spend(1).await;
    }
    writer.raw(b"\n").await;
}

/// Lay `text` out, exiting 1 with what it refuses as the message, or none
/// when a table's widths would pass `MAX_HELD`.
async fn run(
    config: Config,
    width: u64,
    limit: Option<usize>,
    specs: Vec<Spec>,
    text: Vec<u8>,
    host: Host,
) -> i32 {
    let mut meter = Meter {
        host: host.clone(),
        work: WORK,
    };
    let mut entries = Vec::new();
    let mut widest = 0;
    if !config.table {
        let mut lines = Lines::default();
        while let Some(entry) = lines.next(&text, false, &mut meter).await {
            widest = widest.max(entry.width);
            entries.push(entry);
        }
        if entries.is_empty() {
            return 0;
        }
    }
    let separator = config
        .separator
        .as_deref()
        .filter(|bytes| !bytes.is_empty())
        .map(Separator::new);
    let mut writer = Writer {
        host: host.clone(),
        bytes: Vec::with_capacity(OUTPUT),
    };
    if config.table {
        let laid = table(
            &config,
            width,
            limit,
            specs,
            &text,
            separator.as_ref(),
            &mut meter,
            &mut writer,
        )
        .await;
        if let Err(message) = laid {
            if message != OUT_OF_MEMORY {
                host.warn(&message);
            }
            return 1;
        }
    } else {
        let stop = widest + TAB_WIDTH - widest % TAB_WIDTH;
        let across = usize::try_from((width / stop).max(1)).unwrap_or(usize::MAX);
        if config.fillrows {
            for line in entries.chunks(across) {
                lay_out(&mut writer, &mut meter, &text, line.iter().copied(), stop).await;
            }
        } else {
            let rows = entries.len().div_ceil(across);
            for row in 0..rows {
                let line = entries[row..].iter().step_by(rows).copied();
                lay_out(&mut writer, &mut meter, &text, line, stop).await;
            }
        }
    }
    writer.flush().await;
    0
}

impl Stream for Column {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(self.input, input, out)
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.engine.is_none() {
            let config = self.config.take().unwrap();
            let text = std::mem::take(&mut self.text);
            let (width, limit) = (self.width, self.limit);
            let specs = std::mem::take(&mut self.specs);
            self.engine = Some(task::spawn(move |host| {
                run(config, width, limit, specs, text, host)
            }));
        }
        self.drain(out)
    }
    fn wants(&self) -> Option<usize> {
        (self.engine.is_none() && self.input < self.inputs).then_some(self.input)
    }
    fn feed_input(&mut self, _: usize, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.engine.is_some() && !input.is_empty() {
            return Err(StreamError::new("column input has ended"));
        }
        if self.config.as_ref().is_some_and(|config| !config.table) {
            self.rows += memchr::memchr_iter(b'\n', input).count();
        }
        let held = self
            .rows
            .saturating_mul(size_of::<Cell>())
            .saturating_add(self.text.len() + input.len());
        if held > MAX_HELD {
            self.text = Vec::new();
            return Err(StreamError::refusal(OUT_OF_MEMORY, 1));
        }
        self.text.extend_from_slice(input);
        Ok(())
    }
    fn end_input(&mut self, _: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.text.last().is_some_and(|b| *b != b'\n') {
            self.text.push(b'\n');
        }
        self.input += 1;
        if self.input == self.inputs {
            self.finish(out)?;
        }
        Ok(())
    }
    fn busy(&self) -> bool {
        self.engine.as_ref().is_some_and(|engine| engine.busy())
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(engine) = &mut self.engine {
            engine.drain(out)?;
            if !engine.busy() && engine.status() != 0 {
                let mut message = Vec::new();
                engine.take_stderr(&mut message);
                self.engine = None;
                if message.is_empty() {
                    message.extend_from_slice(OUT_OF_MEMORY);
                }
                return Err(StreamError::refusal(&message, 1));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config, drain_all};

    const DEFAULTS: &str =
        r#"{"table":false,"separator":null,"output_separator":"  ","columns":null,"inputs":1}"#;

    fn column(options: &str, inputs: &[&[u8]]) -> Vec<u8> {
        let mut stream = open(config(DEFAULTS, options).as_bytes()).unwrap();
        let mut out = Vec::new();
        while let Some(index) = stream.wants() {
            stream.feed_input(index, inputs[index], &mut out).unwrap();
            stream.end_input(index, &mut out).unwrap();
            drain_all(stream.as_mut(), &mut out);
        }
        stream.finish(&mut out).unwrap();
        out
    }

    #[test]
    fn output_windows_keep_characters_and_lossy_sequences_together() {
        let mut input = b"a".to_vec();
        input.extend("😀".repeat(WORK + 7).as_bytes());
        input.extend([0xf0, 0x9f]);
        input.extend(b",x\n");
        let mut expected = String::from_utf8_lossy(&input[..input.len() - 3])
            .into_owned()
            .into_bytes();
        expected.extend(b"  x\n");
        assert_eq!(
            column(r#"{"table":true,"separator":","}"#, &[&input]),
            expected
        );
    }

    #[test]
    fn entries_fill_down_tab_stop_columns() {
        let seq: Vec<u8> = (1..=5)
            .flat_map(|n| format!("{n}\n").into_bytes())
            .collect();
        assert_eq!(column(r#"{"columns":"16"}"#, &[&seq]), b"1\t4\n2\t5\n3\n");
        assert_eq!(column(r#"{"columns":"15"}"#, &[&seq]), b"1\n2\n3\n4\n5\n");
        assert_eq!(column(r#"{"columns":"0"}"#, &[b"a\n\n   \nb\n"]), b"a\tb\n");
        assert_eq!(
            column(r#"{"columns":"12"}"#, &[b"abcdefgh\nx\n"]),
            b"abcdefgh\nx\n"
        );
        assert_eq!(column("{}", &[b""]), b"");
    }

    #[test]
    fn a_wide_column_is_written_a_window_of_rows_per_call() {
        let mut text = "x".repeat(100_000).into_bytes();
        text.extend(b" b\n");
        text.extend(b"a b\n".repeat(999));
        let mut stream = open(config(DEFAULTS, r#"{"table":true}"#).as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed_input(0, &text, &mut out).unwrap();
        stream.end_input(0, &mut out).unwrap();
        let mut total = out.len();
        while stream.busy() {
            let mut window = Vec::new();
            stream.drain(&mut window).unwrap();
            assert!(window.len() <= OUTPUT);
            total += window.len();
        }
        assert!(out.len() <= OUTPUT);
        assert_eq!(total, 1_000 * 100_004);
    }

    const THREE: &[u8] = b"name age city\nalice 30 paris\nbob 4 rome\n";

    fn refused(options: &str) -> String {
        match open(config(DEFAULTS, options).as_bytes()) {
            Err(error) => String::from_utf8_lossy(&error.stderr()).into_owned(),
            Ok(_) => panic!("{options} was taken"),
        }
    }

    fn failed(options: &str, input: &[u8]) -> Vec<u8> {
        let mut stream = open(config(DEFAULTS, options).as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed_input(0, input, &mut out).unwrap();
        let mut result = stream.end_input(0, &mut out);
        while result.is_ok() && stream.busy() {
            result = stream.drain(&mut out);
        }
        assert!(out.is_empty());
        result.expect_err("refused").stderr()
    }

    #[test]
    fn named_columns_head_the_table_and_a_short_list_leaves_one_blank() {
        assert_eq!(
            column(r#"{"table":true,"names":"A,B,C"}"#, &[THREE]),
            b"A      B    C\nname   age  city\nalice  30   paris\nbob    4    rome\n"
        );
        assert_eq!(
            column(r#"{"table":true,"names":"A,B"}"#, &[THREE]),
            b"A      B    \nname   age  city\nalice  30   paris\nbob    4    rome\n"
        );
        assert_eq!(
            column(r#"{"table":true,"names":"A,B,C,D"}"#, &[b"a b c\n"]),
            b"A  B  C  D\na  b  c  \n"
        );
        assert_eq!(
            column(
                r#"{"table":true,"names":"A,B,C","no_headings":true}"#,
                &[b"a b c\n"]
            ),
            b"a  b  c\n"
        );
    }

    #[test]
    fn a_list_names_columns_by_name_position_range_or_all() {
        let right = |list: &str| {
            let options = format!(r#"{{"table":true,"right":"{list}"}}"#);
            column(&options, &[b"aaa b c\nd eee fff\n"])
        };
        assert_eq!(right("2"), b"aaa    b  c\nd    eee  fff\n");
        assert_eq!(right("-1"), b"aaa  b      c\nd    eee  fff\n");
        assert_eq!(right("1-2"), b"aaa    b  c\n  d  eee  fff\n");
        for all in ["-", "0", "1,-"] {
            assert_eq!(right(all), b"aaa    b    c\n  d  eee  fff\n", "{all}");
        }
        for nothing in ["", ","] {
            assert_eq!(right(nothing), b"aaa  b    c\nd    eee  fff\n", "{nothing}");
        }
        assert_eq!(
            column(
                r#"{"table":true,"names":"2,1,x","right":"2"}"#,
                &[b"aa b c\n"]
            ),
            b"2   1  x\naa  b  c\n"
        );
        assert_eq!(
            failed(r#"{"table":true,"right":"9"}"#, b"a b\n"),
            b"column: undefined column name '9'"
        );
        assert_eq!(
            failed(r#"{"table":true,"noextreme":"X"}"#, b"a b\n"),
            b"column: undefined column name 'X'"
        );
    }

    #[test]
    fn hidden_columns_go_and_the_order_lists_the_first_ones() {
        assert_eq!(
            column(
                r#"{"table":true,"names":"A,B,C","hide":"B"}"#,
                &[b"a b c\n"]
            ),
            b"A  C\na  c\n"
        );
        assert_eq!(
            column(r#"{"table":true,"hide":"-"}"#, &[b"a b\nc d\n"]),
            b"\n\n"
        );
        assert_eq!(
            column(r#"{"table":true,"order":"3"}"#, &[b"a b c\n"]),
            b"c  a  b\n"
        );
        assert_eq!(
            failed(r#"{"table":true,"order":"0"}"#, b"a b\n"),
            b"column: undefined column name '0'"
        );
    }

    #[test]
    fn a_limit_keeps_the_rest_of_the_line_as_typed() {
        assert_eq!(
            column(r#"{"table":true,"limit":"2"}"#, &[b"a  b   c\n\n1\n"]),
            b"a  b   c\n1  \n"
        );
        assert_eq!(
            column(
                r#"{"table":true,"limit":"2","separator":" "}"#,
                &[b"a  b   c\n"]
            ),
            b"a   b   c\n"
        );
        assert_eq!(
            column(r#"{"table":true,"limit":"1"}"#, &[b"a b  c\nd\n"]),
            b"a b  c\nd\n"
        );
    }

    #[test]
    fn json_lowers_its_keys_and_writes_an_empty_cell_as_null() {
        assert_eq!(
            String::from_utf8(column(
                r#"{"table":false,"json":true,"names":"A B,C,d","table_name":"t"}"#,
                &[b"x y z\n\n1\n"]
            ))
            .unwrap(),
            "{\n   \"t\": [\n      {\n         \"a b\": \"x\",\n         \"c\": \"y\",\n         \
             \"d\": \"z\"\n      },{\n         \"a b\": \"1\",\n         \"c\": null,\n         \
             \"d\": null\n      }\n   ]\n}\n"
        );
        assert_eq!(
            String::from_utf8(column(
                "{\"json\":true,\"names\":\"A\",\"separator\":\"\\t\"}",
                &[b"q\"u\\e\x01\xffz\n"]
            ))
            .unwrap(),
            "{\n   \"table\": [\n      {\n         \"a\": \"q\\\"u\\\\e\\u0001\\\\xffz\"\n      }\n   ]\n}\n"
        );
        assert_eq!(column(r#"{"json":true,"names":"A"}"#, &[b""]), b"");
    }

    #[test]
    fn json_refuses_a_cell_with_no_name() {
        for (input, line) in [
            (b"a b c\n".as_slice(), 2),
            (b"a\nb c d\n".as_slice(), 3),
            (b"a\n\nb c d\n".as_slice(), 3),
        ] {
            assert_eq!(
                failed(r#"{"json":true,"names":"A,B"}"#, input),
                format!("column: line {line}: for JSON the name of the column 3 is required")
                    .into_bytes()
            );
        }
    }

    #[test]
    fn maxout_spreads_the_spare_width_and_pads_the_last_column() {
        let wide = |width: u32| {
            let options = format!(r#"{{"table":true,"maxout":true,"output_width":"{width}"}}"#);
            column(&options, &[b"name age city\nalice 30 paris\nbob 4 rome\n"])
        };
        assert_eq!(
            wide(17),
            b"name   age  city \nalice  30   paris\nbob    4    rome \n"
        );
        assert_eq!(
            wide(18),
            b"name    age  city \nalice   30   paris\nbob     4    rome \n"
        );
        assert_eq!(
            wide(19),
            b"name    age  city  \nalice   30   paris \nbob     4    rome  \n"
        );
        assert_eq!(
            column(
                r#"{"table":true,"maxout":true,"output_width":"15"}"#,
                &[b"x y z w v\n"]
            ),
            b"x  y  z  w   v \n"
        );
    }

    #[test]
    fn a_table_too_wide_shrinks_only_the_columns_marked_to() {
        let input = b"id wwwwwwwwwwwwwwwwwwww end\n1 s ok\n";
        assert_eq!(
            column(r#"{"table":true,"output_width":"15"}"#, &[input]),
            b"id  wwwwwwwwwwwwwwwwwwww  end\n1   s                     ok\n"
        );
        assert_eq!(
            column(
                r#"{"table":true,"output_width":"15","truncate":"2"}"#,
                &[input]
            ),
            b"id  wwwwww  end\n1   s       ok\n"
        );
        assert_eq!(
            column(r#"{"table":true,"output_width":"15","wrap":"2"}"#, &[input]),
            b"id  wwwwww  end\n    wwwwww  \n    wwwwww  \n    ww      \n1   s       ok\n"
        );
        let no_truncation = r#"{"table":true,"output_width":"0","truncate":"2"}"#;
        assert_eq!(
            column(no_truncation, &[input]),
            b"id  wwwwwwwwwwwwwwwwwwww  end\n1   s                     ok\n"
        );
    }

    #[test]
    fn a_truncated_cell_ends_on_a_whole_character() {
        let (kept, rest) = clip(
            "\u{65e5}\u{672c}\u{8a9e}".as_bytes(),
            Cell {
                start: 0,
                end: 9,
                width: 6,
            },
            3,
        );
        assert_eq!((kept.end, kept.width), (3, 2));
        assert_eq!(rest.map(|cell| (cell.start, cell.width)), Some((3, 4)));
    }

    #[test]
    fn entries_fill_across_with_fillrows() {
        let seq = b"a\nb\nc\nd\ne\n";
        assert_eq!(
            column(r#"{"fillrows":true,"output_width":"16"}"#, &[seq]),
            b"a\tb\nc\td\ne\n"
        );
        assert_eq!(
            column(r#"{"output_width":"16"}"#, &[seq]),
            b"a\td\nb\te\nc\n"
        );
        for width in ["0", "unlimited", "1"] {
            let options = format!(r#"{{"output_width":"{width}"}}"#);
            assert_eq!(column(&options, &[b"a\nb\n"]), b"a\nb\n", "{width}");
        }
    }

    #[test]
    fn column_properties_name_and_mark_a_column() {
        assert_eq!(
            column(
                r#"{"table":true,"column_specs":["name=X,right","name=Y,bogus"]}"#,
                &[b"aa b c\n"]
            ),
            b" X  Y  \naa  b  c\n"
        );
        assert_eq!(
            column(
                r#"{"table":true,"column_specs":["name=X,hidden","name=Y"]}"#,
                &[b"a b\n"]
            ),
            b"Y\nb\n"
        );
        assert_eq!(
            String::from_utf8(column(
                r#"{"json":true,"column_specs":["name=N,json=number"]}"#,
                &[b"30\n"]
            ))
            .unwrap(),
            "{\n   \"table\": [\n      {\n         \"n\": 30\n      }\n   ]\n}\n"
        );
    }

    #[test]
    fn options_are_refused_before_any_input() {
        for (options, want) in [
            (
                r#"{"output_width":"abc"}"#,
                "column: invalid columns argument: 'abc'",
            ),
            (
                r#"{"table":true,"limit":"x"}"#,
                "column: invalid columns limit argument: 'x'",
            ),
            (
                r#"{"table":true,"limit":"0"}"#,
                "column: columns limit must be greater than zero",
            ),
            (
                r#"{"table":true,"fillrows":true}"#,
                "column: mutually exclusive arguments: --table --fillrows",
            ),
            (
                r#"{"json":true,"fillrows":true,"names":"A"}"#,
                "column: mutually exclusive arguments: --json --fillrows",
            ),
            (
                r#"{"table":true,"names":"A","column_specs":["name=B"]}"#,
                "column: mutually exclusive arguments: --table-column --table-columns",
            ),
            (
                r#"{"json":true}"#,
                "column: option --table-columns or --table-column required for --json",
            ),
            (
                r#"{"names":"A"}"#,
                "column: option --table required for all --table-*",
            ),
            (
                r#"{"noextreme":"1"}"#,
                "column: option --table required for all --table-*",
            ),
        ] {
            assert_eq!(refused(options), want, "{options}");
        }
    }

    #[test]
    fn a_table_pads_every_column_but_its_last() {
        let table = r#"{"table":true,"inputs":2}"#;
        assert_eq!(
            column(table, &[b"a 1", b"long \t2\n\n"]),
            b"a     1\nlong  2\n"
        );
        let wide = "\u{65e5}\u{672c} x\na y\n".as_bytes();
        assert_eq!(
            column(r#"{"table":true}"#, &[wide]),
            "\u{65e5}\u{672c}  x\na     y\n".as_bytes()
        );
        let csv = r#"{"table":true,"separator":",","output_separator":"|"}"#;
        assert_eq!(column(csv, &[b"a,,b\nlong,c\n"]), b"a   | |b\nlong|c|\n");
        assert_eq!(
            column(r#"{"table":true}"#, &[b"a\x0bb c\n"]),
            b"a\x0bb  c\n"
        );
    }

    #[test]
    fn separators_match_decoded_units_and_file_boundaries_end_partial_characters() {
        assert_eq!(
            column(
                r#"{"table":true,"separator":"aba","output_separator":"|"}"#,
                &[b"ababa\nlongabaX\n"]
            ),
            b"    |ba\nlong|X\n"
        );
        assert_eq!(
            column(
                r#"{"table":true,"separator":"\u00ff","output_separator":"|"}"#,
                &[b"a\xffb\nlong\xffc\n"]
            ),
            b"a   |b\nlong|c\n"
        );
        assert_eq!(
            column(r#"{"table":true,"inputs":2}"#, &[b"h\xc3", b"\xa9"]),
            "h\u{fffd}\n\u{fffd}\n".as_bytes()
        );
    }

    #[test]
    fn input_past_what_column_holds_fails_as_memory_runs_out() {
        let refused = StreamError::refusal(OUT_OF_MEMORY, 1);
        for (options, input) in [
            (r#"{"table":true}"#, vec![b'x'; MAX_HELD + 1]),
            ("{}", b"a\n".repeat(MAX_HELD / (size_of::<Cell>() + 2) + 1)),
        ] {
            let mut stream = open(config(DEFAULTS, options).as_bytes()).unwrap();
            let mut out = Vec::new();
            let fed = input
                .chunks(1024)
                .try_for_each(|chunk| stream.feed(chunk, &mut out));
            assert_eq!(fed, Err(refused.clone()), "{options}");
            assert!(out.is_empty());
        }
        let table = b"a b\n".repeat(MAX_HELD / 8);
        assert_eq!(
            column(r#"{"table":true}"#, &[&table]),
            b"a  b\n".repeat(MAX_HELD / 8)
        );
        let wide = b"a,".repeat(MAX_HELD / 8);
        let mut stream =
            open(config(DEFAULTS, r#"{"table":true,"separator":","}"#).as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed_input(0, &wide, &mut out).unwrap();
        let mut result = stream.end_input(0, &mut out);
        while result.is_ok() && stream.busy() {
            result = stream.drain(&mut out);
        }
        assert_eq!(result, Err(refused));
        assert!(out.is_empty());
    }

    #[test]
    fn a_window_ends_within_three_bytes_of_its_work() {
        let emoji = "😀😀".as_bytes();
        assert_eq!(boundary(emoji, 1, emoji.len()), 4);
        assert_eq!(boundary(emoji, 3, emoji.len()), 4);
        let stray = [0x80; 3 * WORK];
        assert_eq!(boundary(&stray, 10, stray.len()), 13);
        assert_eq!(boundary(&stray, stray.len() - 1, stray.len()), stray.len());
        let input = [&stray[..], b",x\n"].concat();
        let expected = ["\u{fffd}".repeat(stray.len()), "  x\n".to_owned()].concat();
        assert_eq!(
            column(r#"{"table":true,"separator":","}"#, &[&input]),
            expected.as_bytes()
        );
    }

    #[test]
    fn row_and_width_preparation_yield_before_output() {
        let mut stream = open(config(DEFAULTS, r#"{"table":true}"#).as_bytes()).unwrap();
        let input = b"long x\na y\n".repeat(WORK);
        let mut out = Vec::new();
        stream.feed(&input, &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        assert!(out.is_empty());
        assert!(stream.busy());
        let (mut empty_turns, mut turns) = (0, 0);
        while stream.busy() {
            let mut piece = Vec::new();
            stream.drain(&mut piece).unwrap();
            assert!(piece.len() <= OUTPUT);
            if piece.is_empty() {
                empty_turns += 1;
            }
            out.extend_from_slice(&piece);
            turns += 1;
            assert!(turns < 10000);
        }
        assert!(empty_turns > 10);
        assert_eq!(out, b"long  x\na     y\n".repeat(WORK));
    }
}
