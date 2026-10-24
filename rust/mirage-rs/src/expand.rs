use serde::Deserialize;

use crate::width::TAB_WIDTH;
use crate::{Stream, StreamError, parse_config};

/// The output one call writes before it holds the rest for `drain`.
const OUTPUT: usize = 64 * 1024;

/// One resolved `-t` list: the explicit stops in typed order, `/N`'s
/// multiple past them and `+N`'s step from the last of them. All empty is
/// the default size 8.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Tabs {
    #[serde(deserialize_with = "stops")]
    stops: Vec<u64>,
    #[serde(deserialize_with = "crate::saturating_u64")]
    extend: u64,
    #[serde(deserialize_with = "crate::saturating_u64")]
    increment: u64,
}

fn stops<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<u64>, D::Error> {
    #[derive(Deserialize)]
    struct Stop(#[serde(deserialize_with = "crate::saturating_u64")] u64);
    Ok(Vec::<Stop>::deserialize(deserializer)?
        .into_iter()
        .map(|Stop(stop)| stop)
        .collect())
}

impl Tabs {
    /// The column a TAB in `column` pads to: the first stop past it, then
    /// `/N`'s next multiple, `+N`'s next step, one stop repeating as a
    /// size, several stops one blank at a time, none the default 8.
    fn next(&self, column: u64) -> u64 {
        if let Some(&stop) = self.stops.iter().find(|&&stop| stop > column) {
            return stop;
        }
        if self.extend != 0 {
            return column.saturating_add(self.extend - column % self.extend);
        }
        let last = self.stops.last().copied().unwrap_or(0);
        if let Some(steps) = (column - last).checked_div(self.increment) {
            return last.saturating_add(self.increment.saturating_mul(steps + 1));
        }
        match self.stops.as_slice() {
            [size] => column.saturating_add(size - column % size),
            [] => column + TAB_WIDTH - column % TAB_WIDTH,
            _ => column.saturating_add(1),
        }
    }

    /// Whether `column` is a tab stop, which the blanks before it may be
    /// joined into a TAB at. Past several explicit stops there is none.
    fn is_stop(&self, column: u64) -> bool {
        if column == 0 {
            return false;
        }
        let last = self.stops.last().copied().unwrap_or(0);
        if column <= last {
            return self.stops.contains(&column);
        }
        if self.extend != 0 {
            column % self.extend == 0
        } else if self.increment != 0 {
            (column - last) % self.increment == 0
        } else {
            match self.stops.as_slice() {
                [size] => column % size == 0,
                [] => column % TAB_WIDTH == 0,
                _ => false,
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpandConfig {
    tabs: Tabs,
    initial_only: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnexpandConfig {
    tabs: Tabs,
    all: bool,
}

pub(crate) fn open_expand(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config = parse_config::<ExpandConfig>(config)?;
    Ok(Box::new(Expand {
        tabs: config.tabs,
        initial_only: config.initial_only,
        column: 0,
        leading: true,
        pad: 0,
        input: Vec::new(),
        at: 0,
    }))
}

pub(crate) fn open_unexpand(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config = parse_config::<UnexpandConfig>(config)?;
    Ok(Box::new(Unexpand {
        tabs: config.tabs,
        all: config.all,
        column: 0,
        converting: true,
        leading: true,
        blanks: Vec::new(),
        run: 0,
        lone: None,
    }))
}

/// expand as GNU 9.7 expands, a byte a column: a TAB pads with blanks to
/// its stop, a backspace steps back one column (never past 0) and only a
/// newline starts the count again. With `initial_only` only the blanks
/// before a line's first other byte are expanded.
struct Expand {
    tabs: Tabs,
    initial_only: bool,
    column: u64,
    leading: bool,
    /// Blanks still owed for the last TAB.
    pad: u64,
    input: Vec<u8>,
    at: usize,
}

impl Expand {
    fn step(&mut self, out: &mut Vec<u8>) {
        let limit = out.len() + OUTPUT;
        loop {
            if self.pad > 0 {
                let room = (limit.saturating_sub(out.len()) as u64).min(self.pad);
                out.resize(out.len() + room as usize, b' ');
                self.pad -= room;
                if self.pad > 0 {
                    return;
                }
            }
            if out.len() >= limit {
                return;
            }
            let Some(&byte) = self.input.get(self.at) else {
                self.input.clear();
                self.at = 0;
                return;
            };
            self.at += 1;
            match byte {
                b'\t' if self.leading || !self.initial_only => {
                    let target = self.tabs.next(self.column);
                    self.pad = target - self.column;
                    self.column = target;
                }
                b'\n' => {
                    out.push(byte);
                    self.column = 0;
                    self.leading = true;
                }
                b'\x08' => {
                    out.push(byte);
                    self.column = self.column.saturating_sub(1);
                    self.leading = false;
                }
                _ => {
                    out.push(byte);
                    self.column = self.column.saturating_add(1);
                    self.leading &= byte == b' ';
                }
            }
        }
    }
}

impl Stream for Expand {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.busy() {
            return Err(StreamError::new("expand input must be drained"));
        }
        self.input.extend_from_slice(input);
        self.step(out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }

    fn busy(&self) -> bool {
        self.pad > 0 || self.at < self.input.len()
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }
}

/// unexpand as GNU 9.7 unexpands, a byte a column: the blanks that reach a
/// tab stop become one TAB, only a line's leading blanks unless `all`. A
/// lone space before a stop becomes one when it leads the line, follows
/// other blanks, or is followed by a blank with a stop still ahead; a blank
/// with none ahead ends the converting. A backspace steps back one column.
struct Unexpand {
    tabs: Tabs,
    all: bool,
    column: u64,
    converting: bool,
    leading: bool,
    /// The blanks read since the last stop.
    blanks: Vec<u8>,
    /// The blanks read since the last other byte.
    run: usize,
    /// A lone space reached a stop, and whether it becomes a TAB unless a
    /// blank decides it; the next byte settles it.
    lone: Option<bool>,
}

impl Tabs {
    /// Whether a tab stop lies past `column`.
    fn ahead(&self, column: u64) -> bool {
        self.extend != 0
            || self.increment != 0
            || self.stops.len() < 2
            || self.stops.last().is_some_and(|&last| last > column)
    }
}

impl Stream for Unexpand {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.reserve(input.len());
        for &byte in input {
            let blank = byte == b' ' || byte == b'\t';
            let converting = self.converting && blank && self.tabs.ahead(self.column);
            if let Some(tab) = self.lone.take() {
                let tab = if self.converting && blank {
                    converting
                } else {
                    tab
                };
                out.push(if tab { b'\t' } else { b' ' });
            }
            if converting {
                self.column = if byte == b'\t' {
                    self.tabs.next(self.column)
                } else {
                    self.column.saturating_add(1)
                };
                self.blanks.push(byte);
                self.run += 1;
                if self.tabs.is_stop(self.column) {
                    if self.blanks == b" " {
                        self.lone = Some(self.leading || self.run > 1);
                    } else {
                        out.push(b'\t');
                    }
                    self.blanks.clear();
                }
                continue;
            }
            out.append(&mut self.blanks);
            out.push(byte);
            if blank {
                self.converting = false;
                continue;
            }
            self.run = 0;
            match byte {
                b'\n' => {
                    self.column = 0;
                    self.converting = true;
                    self.leading = true;
                    continue;
                }
                b'\x08' => self.column = self.column.saturating_sub(1),
                _ => self.column = self.column.saturating_add(1),
            }
            self.converting &= self.all;
            self.leading = false;
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(tab) = self.lone.take() {
            out.push(if tab { b'\t' } else { b' ' });
        }
        out.append(&mut self.blanks);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::{open, run};

    fn tabs(stops: &[u64], extend: u64, increment: u64) -> Value {
        json!({"stops": stops, "extend": extend, "increment": increment})
    }

    fn splits(kind: &str, config: &Value, input: &[u8]) -> Vec<u8> {
        let config = config.to_string();
        let whole = run(kind, &config, &[input]).0;
        for split in 0..=input.len() {
            assert_eq!(
                run(kind, &config, &[&input[..split], &input[split..]]).0,
                whole
            );
        }
        whole
    }

    fn expand(tabs: Value, initial_only: bool, input: &[u8]) -> Vec<u8> {
        splits(
            "expand",
            &json!({"tabs": tabs, "initial_only": initial_only}),
            input,
        )
    }

    fn unexpand(tabs: Value, all: bool, input: &[u8]) -> Vec<u8> {
        splits("unexpand", &json!({"tabs": tabs, "all": all}), input)
    }

    #[test]
    fn expand_pads_to_each_kind_of_stop() {
        let input = b"a\tb\tc\td\te\n";
        assert_eq!(
            expand(tabs(&[], 0, 0), false, input),
            b"a       b       c       d       e\n"
        );
        assert_eq!(expand(tabs(&[3], 0, 0), false, input), b"a  b  c  d  e\n");
        assert_eq!(expand(tabs(&[2, 5], 0, 0), false, input), b"a b  c d e\n");
        assert_eq!(expand(tabs(&[2], 4, 0), false, input), b"a b c   d   e\n");
        assert_eq!(expand(tabs(&[2], 0, 4), false, input), b"a b   c   d   e\n");
        assert_eq!(
            expand(tabs(&[], 0, 0), false, b"a\r\x08\x08\tb\xc3\xa9\tc\n"),
            b"a\r\x08\x08        b\xc3\xa9     c\n"
        );
        assert_eq!(
            expand(tabs(&[1, 3], 0, 0), true, b"\ta\tb\n \tc\n"),
            b" a\tb\n   c\n"
        );
    }

    #[test]
    fn a_far_stop_pads_a_window_per_call() {
        let config = json!({"tabs": tabs(&[1 << 20], 0, 0), "initial_only": false}).to_string();
        let mut stream = open("expand", config.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed(b"\tx", &mut out).unwrap();
        assert!(out.len() <= 64 * 1024 && stream.busy());
        while stream.busy() {
            let mut window = Vec::new();
            stream.drain(&mut window).unwrap();
            assert!(window.len() <= 64 * 1024);
            out.extend(window);
        }
        assert_eq!(out.len(), (1 << 20) + 1);
    }

    #[test]
    fn unexpand_joins_blanks_that_reach_a_stop() {
        let eight = tabs(&[], 0, 0);
        assert_eq!(
            unexpand(eight.clone(), false, b"        a        b\n"),
            b"\ta        b\n"
        );
        assert_eq!(
            unexpand(eight.clone(), true, b"        a        b\n"),
            b"\ta\t b\n"
        );
        assert_eq!(
            unexpand(eight.clone(), true, b"abcdefg x\nabcdefg  x\n"),
            b"abcdefg x\nabcdefg\t x\n"
        );
        assert_eq!(
            unexpand(eight, false, b"\x08        a\n"),
            b"\x08        a\n"
        );
        let one = tabs(&[1], 0, 0);
        assert_eq!(unexpand(one.clone(), true, b" \rc\n"), b"\t\rc\n");
        assert_eq!(unexpand(one, true, b"\x08 \n"), b"\x08 \n");
        assert_eq!(
            unexpand(tabs(&[3, 7], 0, 0), true, b"   aaa \t\x08\n"),
            b"\taaa \t\x08\n"
        );
    }

    #[test]
    fn a_tab_goes_strictly_past_its_column() {
        let cases = [
            (tabs(&[], 0, 0), 0, 8),
            (tabs(&[], 0, 0), 3, 8),
            (tabs(&[], 0, 0), 8, 16),
            (tabs(&[3], 0, 0), 0, 3),
            (tabs(&[3], 0, 0), 3, 6),
            (tabs(&[5, 9], 0, 0), 0, 5),
            (tabs(&[5, 9], 0, 0), 5, 9),
            (tabs(&[5, 9], 0, 0), 9, 10),
            (tabs(&[5, 9], 0, 0), 20, 21),
            (tabs(&[], 4, 0), 0, 4),
            (tabs(&[], 4, 0), 4, 8),
            (tabs(&[], 0, 4), 0, 4),
            (tabs(&[], 0, 4), 5, 8),
            (tabs(&[2], 4, 0), 3, 4),
            (tabs(&[2], 4, 0), 5, 8),
            (tabs(&[2], 0, 4), 3, 6),
            (tabs(&[2], 0, 4), 7, 10),
        ];
        for (tabs, column, expected) in cases {
            let tabs: super::Tabs = serde_json::from_value(tabs).unwrap();
            assert_eq!(tabs.next(column), expected, "column {column}");
        }
    }
}
