use std::collections::VecDeque;

use serde::Deserialize;

use crate::task::{self, Host};
use crate::utf8::next_lossy;
use crate::width::{TAB_WIDTH, char_width, is_space};
use crate::{Stream, StreamError, parse_config};

const WIDTH: u64 = 80;
const WORK: usize = 4096;
const OUTPUT: usize = 16384;

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
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let width = match config.columns.as_deref() {
        Some(raw) if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) => {
            raw.bytes().fold(0u64, |n, b| {
                n.saturating_mul(10).saturating_add(u64::from(b - b'0'))
            })
        }
        _ => 0,
    };
    Ok(Box::new(Column {
        width: if width == 0 { WIDTH } else { width },
        inputs: config.inputs,
        config: Some(config),
        text: Vec::new(),
        input: 0,
        engine: None,
    }))
}

struct Column {
    config: Option<Config>,
    width: u64,
    text: Vec<u8>,
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

    async fn next_literal(&mut self, text: &str, separator: u8, meter: &mut Meter) -> Option<Cell> {
        while self.at < self.end {
            let mut stop = self.end.min(self.at.saturating_add(meter.work));
            while !text.is_char_boundary(stop) {
                stop += 1;
            }
            let delimiter =
                memchr::memchr(separator, &text.as_bytes()[self.at..stop]).map(|at| self.at + at);
            let end = delimiter.unwrap_or(stop);
            self.width += text[self.at..end]
                .chars()
                .map(|c| char_width(u32::from(c)))
                .sum::<u64>();
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
        text: &str,
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
        while let Some((c, used)) = next_lossy(text.as_bytes(), self.at, self.end) {
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
    async fn text(&mut self, text: &str, cell: Cell, meter: &mut Meter) {
        let mut at = cell.start;
        while at < cell.end {
            let end = cell.end.min(at.saturating_add(meter.work));
            self.raw(&text.as_bytes()[at..end]).await;
            meter.spend(end - at).await;
            at = end;
        }
    }
}

async fn decode(bytes: Vec<u8>, meter: &mut Meter) -> String {
    let mut text = String::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let end = bytes.len().min(at.saturating_add(meter.work));
        let valid = match std::str::from_utf8(&bytes[at..end]) {
            Ok(valid) => valid,
            Err(error) => std::str::from_utf8(&bytes[at..at + error.valid_up_to()]).unwrap(),
        };
        let used = if valid.is_empty() {
            let (c, used) = next_lossy(&bytes, at, bytes.len()).unwrap();
            text.push(c);
            used
        } else {
            text.push_str(valid);
            valid.len()
        };
        at += used;
        meter.spend(used).await;
    }
    text
}

async fn run(config: Config, width: u64, text: Vec<u8>, host: Host) -> i32 {
    let mut meter = Meter {
        host: host.clone(),
        work: WORK,
    };
    let text = decode(text, &mut meter).await;
    let mut entries = Vec::new();
    let (mut start, mut at, mut columns, mut nonblank) = (0, 0, 0, false);
    let mut widest = 0;
    while at < text.len() {
        if config.table && nonblank {
            let end = text.len().min(at.saturating_add(meter.work));
            let delimiter =
                memchr::memchr(b'\n', &text.as_bytes()[at..end]).map(|offset| at + offset);
            let stop = delimiter.map_or(end, |offset| offset + 1);
            if let Some(offset) = delimiter {
                entries.push(Cell {
                    start,
                    end: offset,
                    width: 0,
                });
                start = stop;
                nonblank = false;
            }
            let used = stop - at;
            at = stop;
            if meter.charge(used) {
                meter.pause().await;
            }
            continue;
        }
        let (c, used) = next_lossy(text.as_bytes(), at, text.len()).unwrap();
        if c == '\n' {
            if nonblank {
                entries.push(Cell {
                    start,
                    end: at,
                    width: columns,
                });
                widest = widest.max(columns);
            }
            start = at + used;
            columns = 0;
            nonblank = false;
        } else {
            if !config.table {
                columns += char_width(u32::from(c));
            }
            nonblank = nonblank || !is_space(u32::from(c));
        }
        at += used;
        if meter.charge(used) {
            meter.pause().await;
        }
    }
    if nonblank {
        entries.push(Cell {
            start,
            end: at,
            width: columns,
        });
        widest = widest.max(columns);
    }
    if entries.is_empty() {
        return 0;
    }
    let separator = config
        .separator
        .as_deref()
        .filter(|bytes| !bytes.is_empty())
        .map(Separator::new);
    let mut reader = Cells::default();
    let mut writer = Writer {
        host,
        bytes: Vec::with_capacity(OUTPUT),
    };
    if config.table {
        let mut widths: Vec<u64> = Vec::new();
        for row in &entries {
            reader.reset(*row);
            let mut index = 0;
            while let Some(cell) = reader.next(&text, separator.as_ref(), &mut meter).await {
                if widths.len() <= index {
                    widths.push(0);
                }
                widths[index] = widths[index].max(cell.width);
                index += 1;
                meter.spend(1).await;
            }
        }
        for row in entries {
            reader.reset(row);
            let mut index = 0;
            let mut current = reader.next(&text, separator.as_ref(), &mut meter).await;
            while let Some(cell) = current {
                let next = reader.next(&text, separator.as_ref(), &mut meter).await;
                if index > 0 {
                    writer.raw(&config.output_separator).await;
                }
                writer.text(&text, cell, &mut meter).await;
                if next.is_some() {
                    writer.repeat(b' ', widths[index] - cell.width).await;
                }
                current = next;
                index += 1;
                meter.spend(1).await;
            }
            writer.raw(b"\n").await;
        }
    } else {
        let stop = widest + TAB_WIDTH - widest % TAB_WIDTH;
        let across = usize::try_from((width / stop).max(1)).unwrap_or(usize::MAX);
        let rows = entries.len().div_ceil(across);
        for row in 0..rows {
            let (mut at, mut end) = (0, stop);
            for index in (row..entries.len()).step_by(rows) {
                let cell = entries[index];
                writer.text(&text, cell, &mut meter).await;
                at += cell.width;
                if index + rows >= entries.len() {
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
            let width = self.width;
            self.engine = Some(task::spawn(move |host| run(config, width, text, host)));
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

    #[test]
    fn a_table_pads_every_cell_but_a_rows_last() {
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
        assert_eq!(column(csv, &[b"a,,b\nlong,c\n"]), b"a   | |b\nlong|c\n");
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
