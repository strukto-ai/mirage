use serde::Deserialize;

use crate::utf8::{Char, char_at};
use crate::width::{TAB_WIDTH, char_width, is_space};
use crate::{Stream, StreamError, parse_config};

/// What a line's width is counted in.
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Count {
    Columns,
    Characters,
    Bytes,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "crate::saturating_u64")]
    width: u64,
    spaces: bool,
    count: Count,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config = parse_config::<Config>(config)?;
    Ok(Box::new(Fold {
        width: config.width,
        spaces: config.spaces,
        count: config.count,
        line: Vec::new(),
        started: false,
        column: 0,
        last: 0,
        held: Vec::new(),
    }))
}

/// fold as GNU coreutils 9.10 folds in C.UTF-8 (debian:testing-slim; 9.7
/// has neither -c nor characters): a line is broken before the character
/// that would take it past `width`, unless nothing has been written to it
/// yet, and never inside a character, even counting bytes. A tab moves to
/// the next multiple of 8, a backspace one column back and a carriage
/// return to column 0, in columns and in characters alike; a byte that
/// starts no character, a control and a character that does not print
/// count one column, and a backspace steps back over the last printing
/// character's width. With `spaces` the break goes after the line's last
/// blank, and what follows it is counted again on the new line.
struct Fold {
    width: u64,
    spaces: bool,
    count: Count,
    /// The current line, kept only with `spaces`.
    line: Vec<u8>,
    started: bool,
    column: u64,
    /// The columns the last printing character took, which a backspace
    /// steps back over; GNU keeps it across lines.
    last: u64,
    /// The start of a character the input has not finished yet.
    held: Vec<u8>,
}

impl Fold {
    /// The column after a unit of `len` bytes, and the width a backspace
    /// then steps back. A backspace past column 0 wraps, which breaks the
    /// line before it. A recount of what a break carried over takes a byte
    /// that starts no character as no column.
    fn advance(
        &self,
        (column, last): (u64, u64),
        len: usize,
        cp: Option<u32>,
        recount: bool,
    ) -> (u64, u64) {
        let width = match (self.count, cp) {
            (Count::Bytes, _) => return (column + len as u64, last),
            (_, Some(0x09)) => return (column + TAB_WIDTH - column % TAB_WIDTH, last),
            (_, Some(0x08)) if column > 0 => return (column.wrapping_sub(last), last),
            (_, Some(0x08)) => return (0, last),
            (_, Some(0x0D)) => return (0, last),
            (Count::Columns, Some(cp)) => columns(cp),
            (Count::Columns, None) => u64::from(!recount),
            (Count::Characters, _) => 1,
        };
        (column + width, width)
    }

    fn take(&mut self, unit: &[u8], cp: Option<u32>, out: &mut Vec<u8>) {
        if unit == b"\n" {
            out.extend_from_slice(&self.line);
            out.push(b'\n');
            self.line.clear();
            self.started = false;
            self.column = 0;
            return;
        }
        loop {
            let (next, last) = self.advance((self.column, self.last), unit.len(), cp, false);
            if next <= self.width || !self.started {
                if self.spaces {
                    self.line.extend_from_slice(unit);
                } else {
                    out.extend_from_slice(unit);
                }
                self.started = true;
                (self.column, self.last) = (next, last);
                return;
            }
            if self.spaces {
                if let Some(blank) = self.last_blank() {
                    out.extend_from_slice(&self.line[..blank]);
                    out.push(b'\n');
                    self.line.drain(..blank);
                    self.started = !self.line.is_empty();
                    (self.column, self.last) = self.recount();
                    continue;
                }
                out.append(&mut self.line);
            }
            out.push(b'\n');
            self.started = false;
            self.column = 0;
        }
    }

    /// One past the line's last blank.
    fn last_blank(&self) -> Option<usize> {
        let mut found = None;
        self.units(&self.line, |at, unit, cp| {
            if cp.is_some_and(is_blank) {
                found = Some(at + unit.len());
            }
        });
        found
    }

    fn recount(&self) -> (u64, u64) {
        let mut state = (0, self.last);
        self.units(&self.line, |_, unit, cp| {
            state = self.advance(state, unit.len(), cp, true);
        });
        state
    }

    /// Each character of `bytes` with its offset, a byte that starts none
    /// on its own.
    fn units(&self, bytes: &[u8], mut each: impl FnMut(usize, &[u8], Option<u32>)) {
        let mut at = 0;
        while at < bytes.len() {
            let (len, cp) = match char_at(&bytes[at..]) {
                Char::Whole(len, cp) => (len, Some(cp)),
                Char::Partial | Char::Invalid => (1, None),
            };
            each(at, &bytes[at..at + len], cp);
            at += len;
        }
    }

    fn consume(&mut self, input: &[u8], eof: bool, out: &mut Vec<u8>) {
        let mut at = 0;
        while at < input.len() {
            let (len, cp) = match char_at(&input[at..]) {
                Char::Whole(len, cp) => (len, Some(cp)),
                Char::Partial if !eof => {
                    self.held.extend_from_slice(&input[at..]);
                    return;
                }
                Char::Partial | Char::Invalid => (1, None),
            };
            self.take(&input[at..at + len], cp, out);
            at += len;
        }
    }
}

/// The columns a character takes: what it prints in, or one for one that
/// does not print.
fn columns(cp: u32) -> u64 {
    match cp {
        0x00..=0x1F | 0x7F..=0x9F | 0x2028 | 0x2029 => 1,
        0x11_0000.. => 1,
        _ => char_width(cp),
    }
}

/// A blank: a space or a tab, or another space that does not end a line.
fn is_blank(cp: u32) -> bool {
    !matches!(cp, 0x0A..=0x0D | 0x2028 | 0x2029) && is_space(cp)
}

impl Stream for Fold {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.held.is_empty() {
            self.consume(input, false, out);
        } else {
            let mut joined = std::mem::take(&mut self.held);
            joined.extend_from_slice(input);
            self.consume(&joined, false, out);
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let held = std::mem::take(&mut self.held);
        self.consume(&held, true, out);
        out.append(&mut self.line);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::run;

    fn fold(input: &[u8], width: u64, spaces: bool, count: &str) -> Vec<u8> {
        let config = json!({"width": width, "spaces": spaces, "count": count}).to_string();
        let whole = run("fold", &config, &[input]).0;
        for split in 0..=input.len() {
            let (output, error) = run("fold", &config, &[&input[..split], &input[split..]]);
            assert_eq!(error, None);
            assert_eq!(output, whole, "split {split}");
        }
        whole
    }

    #[test]
    fn columns_follow_tabs_backspaces_and_returns() {
        assert_eq!(
            fold(b"a\tbcdefghijk\n", 10, false, "columns"),
            b"a\tbc\ndefghijk\n"
        );
        assert_eq!(
            fold(b"abcd\x08xyzwvu\n", 5, false, "columns"),
            b"abcd\x08xy\nzwvu\n"
        );
        assert_eq!(
            fold(b"abcdef\rghij\n", 4, false, "columns"),
            b"abcd\nef\rghij\n"
        );
        assert_eq!(fold(b"\tab\n", 3, false, "columns"), b"\t\nab\n");
        assert_eq!(
            fold(b"a\r\xe4\xb8\xad\n", 1, false, "columns"),
            b"a\r\n\xe4\xb8\xad\n"
        );
        assert_eq!(fold(b"a\tbcdef\n", 3, false, "bytes"), b"a\tb\ncde\nf\n");
        assert_eq!(fold(b"abcdefg", 3, false, "columns"), b"abc\ndef\ng");
    }

    #[test]
    fn characters_take_their_print_width_or_one() {
        let wide = b"\xe4\xb8\xad\xe6\x96\x87\xe5\xad\x97\n";
        assert_eq!(
            fold(wide, 3, false, "columns"),
            b"\xe4\xb8\xad\n\xe6\x96\x87\n\xe5\xad\x97\n"
        );
        assert_eq!(fold(wide, 3, false, "characters"), wide);
        assert_eq!(
            fold(wide, 3, false, "bytes"),
            b"\xe4\xb8\xad\n\xe6\x96\x87\n\xe5\xad\x97\n"
        );
        let combining = b"e\xcc\x81e\xcc\x81e\xcc\x81\n";
        assert_eq!(
            fold(combining, 2, false, "columns"),
            b"e\xcc\x81e\xcc\x81\ne\xcc\x81\n"
        );
        assert_eq!(
            fold(b"a\x01b\x02c\n", 2, false, "columns"),
            b"a\x01\nb\x02\nc\n"
        );
        assert_eq!(
            fold(b"ab\xe4\xb8cd\n", 3, false, "columns"),
            b"ab\xe4\n\xb8cd\n"
        );
        assert_eq!(fold(b"abc\xc3", 2, false, "columns"), b"ab\nc\xc3");
        assert_eq!(
            fold(b"a\xe2\x80\x8bb\xe2\x80\x8bc\n", 2, false, "columns"),
            b"a\xe2\x80\x8bb\xe2\x80\x8b\nc\n"
        );
    }

    #[test]
    fn spaces_break_after_the_last_blank() {
        assert_eq!(
            fold(b"ab cd\tefghijklmnop\n", 10, true, "columns"),
            b"ab cd\t\nefghijklmn\nop\n"
        );
        assert_eq!(fold(b" abcdefgh\n", 4, true, "columns"), b" \nabcd\nefgh\n");
        assert_eq!(
            fold(b"ab      cd\n", 4, true, "columns"),
            b"ab  \n    \ncd\n"
        );
        assert_eq!(
            fold(b"a b\t\tc\n", 4, true, "columns"),
            b"a \nb\n\t\n\t\nc\n"
        );
        assert_eq!(
            fold(b"a b\x08\x08cdefg\n", 4, true, "columns"),
            b"a \nb\x08\x08cdef\ng\n"
        );
        assert_eq!(
            fold(b"ab\xe3\x80\x80cdef\n", 5, true, "columns"),
            b"ab\xe3\x80\x80\ncdef\n"
        );
        assert_eq!(
            fold(b"ab\xc2\xa0cdef\n", 4, true, "columns"),
            b"ab\xc2\xa0c\ndef\n"
        );
        assert_eq!(
            fold(
                b"\xc3\xa9\xc3\xa9 \xc3\xa9\xc3\xa9\xc3\xa9\n",
                4,
                true,
                "bytes"
            ),
            b"\xc3\xa9\xc3\xa9\n \n\xc3\xa9\xc3\xa9\n\xc3\xa9\n"
        );
    }
}
