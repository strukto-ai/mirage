use serde::Deserialize;

use crate::width::{TAB_WIDTH, char_width, is_space};
use crate::{Stream, StreamError, parse_config};

/// The width when `COLUMNS` names none: stdout is no terminal.
const WIDTH: u64 = 80;
/// The most a call writes past the row it starts.
const OUTPUT: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    table: bool,
    #[serde(deserialize_with = "crate::latin1_opt")]
    separator: Option<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1")]
    output_separator: Vec<u8>,
    /// `COLUMNS` as the environment holds it.
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
        config,
        text: Vec::new(),
        input: 0,
        layout: None,
    }))
}

/// util-linux column over every input read as one run of lines, a file's
/// last line ending where the next file begins. Lines that hold only
/// spaces are dropped, and text is measured in display columns after a
/// byte that is no part of a character reads as U+FFFD. Once the last
/// input ends, a call writes rows until `OUTPUT` bytes have been written.
struct Column {
    config: Config,
    width: u64,
    text: Vec<u8>,
    input: usize,
    layout: Option<Layout>,
}

/// The entries as ranges of the text, the widths they are laid out by
/// (each entry's, or each table column's), and the row writing has reached.
struct Layout {
    text: String,
    entries: Vec<(usize, usize)>,
    widths: Vec<u64>,
    separator: Option<String>,
    /// The column stop entries are filled to.
    stop: u64,
    rows: usize,
    row: usize,
}

fn text_width(text: &str) -> u64 {
    text.chars().map(|c| char_width(u32::from(c))).sum()
}

fn next_stop(column: u64) -> u64 {
    column + TAB_WIDTH - column % TAB_WIDTH
}

/// A `-t` line's cells: split at the separator, or at runs of blanks.
fn cells<'a>(line: &'a str, separator: Option<&'a str>) -> Box<dyn Iterator<Item = &'a str> + 'a> {
    match separator {
        Some(separator) => Box::new(line.split(separator)),
        None => Box::new(line.split([' ', '\t']).filter(|cell| !cell.is_empty())),
    }
}

impl Column {
    fn lay_out(&mut self) {
        let bytes = std::mem::take(&mut self.text);
        let text = String::from_utf8(bytes)
            .unwrap_or_else(|err| String::from_utf8_lossy(err.as_bytes()).into_owned());
        let mut entries = Vec::new();
        let mut start = 0;
        for end in text
            .match_indices('\n')
            .map(|(at, _)| at)
            .chain([text.len()])
        {
            if !text[start..end].chars().all(|c| is_space(u32::from(c))) {
                entries.push((start, end));
            }
            start = end + 1;
        }
        let separator = (self.config.separator.as_deref())
            .filter(|separator| !separator.is_empty())
            .map(|separator| String::from_utf8_lossy(separator).into_owned());
        let mut widths = Vec::new();
        let (mut stop, mut rows) = (0, entries.len());
        if self.config.table {
            for &(start, end) in &entries {
                for (index, cell) in cells(&text[start..end], separator.as_deref()).enumerate() {
                    widths.resize(widths.len().max(index + 1), 0);
                    widths[index] = widths[index].max(text_width(cell));
                }
            }
        } else {
            widths = entries
                .iter()
                .map(|&(start, end)| text_width(&text[start..end]))
                .collect();
            stop = next_stop(widths.iter().copied().max().unwrap_or(0));
            let across = usize::try_from((self.width / stop).max(1)).unwrap_or(usize::MAX);
            rows = entries.len().div_ceil(across);
        }
        self.layout = Some(Layout {
            text,
            entries,
            widths,
            separator,
            stop,
            rows,
            row: 0,
        });
    }

    fn step(&mut self, out: &mut Vec<u8>) {
        let Some(layout) = &mut self.layout else {
            return;
        };
        let limit = out.len() + OUTPUT;
        while layout.row < layout.rows && out.len() < limit {
            if self.config.table {
                layout.table_row(&self.config.output_separator, out);
            } else {
                layout.fill_row(out);
            }
            out.push(b'\n');
            layout.row += 1;
        }
    }
}

impl Layout {
    /// The entries down the columns: each column is the widest entry
    /// rounded up to the next tab stop, as many as fit the width (at least
    /// one), and a gap is tabs to the next column's start.
    fn fill_row(&self, out: &mut Vec<u8>) {
        let (mut at, mut end) = (0, self.stop);
        for index in (self.row..self.entries.len()).step_by(self.rows) {
            let (start, stop) = self.entries[index];
            out.extend_from_slice(&self.text.as_bytes()[start..stop]);
            at += self.widths[index];
            if index + self.rows >= self.entries.len() {
                break;
            }
            while next_stop(at) <= end {
                out.push(b'\t');
                at = next_stop(at);
            }
            end += self.stop;
        }
    }

    /// `-t`: each cell padded to its column's widest cell, but the last.
    fn table_row(&self, separator: &[u8], out: &mut Vec<u8>) {
        let (start, end) = self.entries[self.row];
        let mut row = cells(&self.text[start..end], self.separator.as_deref()).peekable();
        let mut index = 0;
        while let Some(cell) = row.next() {
            if index > 0 {
                out.extend_from_slice(separator);
            }
            out.extend_from_slice(cell.as_bytes());
            if row.peek().is_some() {
                let pad = self.widths[index] - text_width(cell);
                out.resize(out.len() + usize::try_from(pad).unwrap_or(0), b' ');
            }
            index += 1;
        }
    }
}

impl Stream for Column {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(self.input, input, out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.layout.is_none() {
            self.lay_out();
        }
        self.step(out);
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        (self.input < self.config.inputs).then_some(self.input)
    }

    fn feed_input(&mut self, _: usize, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        self.text.extend_from_slice(input);
        Ok(())
    }

    fn end_input(&mut self, _: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.text.last().is_some_and(|&b| b != b'\n') {
            self.text.push(b'\n');
        }
        self.input += 1;
        if self.input == self.config.inputs {
            self.finish(out)?;
        }
        Ok(())
    }

    fn busy(&self) -> bool {
        self.layout
            .as_ref()
            .is_some_and(|layout| layout.row < layout.rows)
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
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
            assert!(window.len() <= OUTPUT + 100_004);
            total += window.len();
        }
        assert!(out.len() <= OUTPUT + 100_004);
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
}
