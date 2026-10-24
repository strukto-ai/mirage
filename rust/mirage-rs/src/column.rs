use serde::Deserialize;

use crate::width::{TAB_WIDTH, char_width, is_space};
use crate::{Stream, StreamError, parse_config};

/// The width when `COLUMNS` names none: stdout is no terminal.
const WIDTH: u64 = 80;

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
    }))
}

/// util-linux column over every input read as one run of lines, a file's
/// last line ending where the next file begins. Lines that hold only
/// spaces are dropped, and text is measured in display columns after a
/// byte that is no part of a character reads as U+FFFD.
struct Column {
    config: Config,
    width: u64,
    text: Vec<u8>,
    input: usize,
}

fn text_width(text: &str) -> u64 {
    text.chars().map(|c| char_width(u32::from(c))).sum()
}

fn next_stop(column: u64) -> u64 {
    column + TAB_WIDTH - column % TAB_WIDTH
}

impl Column {
    /// The entries down the columns: each column is the widest entry
    /// rounded up to the next tab stop, as many as fit the width (at least
    /// one), and a gap is tabs to the next column's start.
    fn fill(&self, entries: &[&str], out: &mut Vec<u8>) {
        let widths: Vec<u64> = entries.iter().map(|e| text_width(e)).collect();
        let stop = next_stop(widths.iter().copied().max().unwrap_or(0));
        let across = usize::try_from((self.width / stop).max(1)).unwrap_or(usize::MAX);
        let rows = entries.len().div_ceil(across);
        for row in 0..rows {
            let (mut at, mut end) = (0, stop);
            for index in (row..entries.len()).step_by(rows) {
                out.extend_from_slice(entries[index].as_bytes());
                at += widths[index];
                if index + rows >= entries.len() {
                    break;
                }
                while next_stop(at) <= end {
                    out.push(b'\t');
                    at = next_stop(at);
                }
                end += stop;
            }
            out.push(b'\n');
        }
    }

    /// `-t`: each line's cells split at the separator, or at runs of blanks
    /// without one, and padded to their column's widest cell but the last.
    fn table(&self, entries: &[&str], out: &mut Vec<u8>) {
        let separator = self
            .config
            .separator
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(String::from_utf8_lossy);
        let rows: Vec<Vec<&str>> = entries
            .iter()
            .map(|line| match &separator {
                Some(separator) => line.split(separator.as_ref()).collect(),
                None => line.split([' ', '\t']).filter(|c| !c.is_empty()).collect(),
            })
            .collect();
        let mut widths = Vec::new();
        for row in &rows {
            widths.resize(widths.len().max(row.len()), 0);
            for (index, cell) in row.iter().enumerate() {
                widths[index] = widths[index].max(text_width(cell));
            }
        }
        for row in &rows {
            for (index, cell) in row.iter().enumerate() {
                if index > 0 {
                    out.extend_from_slice(&self.config.output_separator);
                }
                out.extend_from_slice(cell.as_bytes());
                if index + 1 < row.len() {
                    let pad = widths[index] - text_width(cell);
                    out.resize(out.len() + usize::try_from(pad).unwrap_or(0), b' ');
                }
            }
            out.push(b'\n');
        }
    }
}

impl Stream for Column {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(self.input, input, out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let text = String::from_utf8_lossy(&self.text);
        let mut entries: Vec<&str> = text.split('\n').collect();
        if entries.last() == Some(&"") {
            entries.pop();
        }
        entries.retain(|line| !line.chars().all(|c| is_space(u32::from(c))));
        if self.config.table {
            self.table(&entries, out);
        } else {
            self.fill(&entries, out);
        }
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        (self.input < self.config.inputs).then_some(self.input)
    }

    fn feed_input(&mut self, _: usize, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        self.text.extend_from_slice(input);
        Ok(())
    }

    fn end_input(&mut self, _: usize, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.text.last().is_some_and(|&b| b != b'\n') {
            self.text.push(b'\n');
        }
        self.input += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;

    const DEFAULTS: &str =
        r#"{"table":false,"separator":null,"output_separator":"  ","columns":null,"inputs":1}"#;

    fn column(options: &str, inputs: &[&[u8]]) -> Vec<u8> {
        let mut stream = open(config(DEFAULTS, options).as_bytes()).unwrap();
        let mut out = Vec::new();
        while let Some(index) = stream.wants() {
            stream.feed_input(index, inputs[index], &mut out).unwrap();
            stream.end_input(index, &mut out).unwrap();
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
