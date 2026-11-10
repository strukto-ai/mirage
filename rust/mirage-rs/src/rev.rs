use serde::Deserialize;

use crate::records::{Records, Take};
use crate::utf8::previous_lossy as previous;
use crate::{Stream, StreamError, constants::WORK, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// -0: NUL ends a line instead of a newline.
    #[serde(default)]
    zero: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(Box::new(Rev {
        records: Records::default(),
        remaining: None,
        busy: false,
        terminator: if config.zero { 0 } else { b'\n' },
    }))
}

/// util-linux rev: each line's characters in reverse order, its newline
/// kept where it was. A byte that is no part of a UTF-8 character reads
/// as U+FFFD, one per maximal invalid run, as the hosts always decoded it.
struct Rev {
    /// The start of a line the input has not ended yet.
    records: Records,
    remaining: Option<usize>,
    busy: bool,
    terminator: u8,
}

impl Rev {
    fn pump(&mut self, out: &mut Vec<u8>) {
        let limit = out.len().saturating_add(WORK);
        while out.len() < limit {
            let Take::Record((line, terminated)) = self.records.peek_span(self.terminator) else {
                self.busy = false;
                return;
            };
            let remaining = self.remaining.get_or_insert(line.len());
            let start = remaining.saturating_sub(limit - out.len());
            if line[start..*remaining].is_ascii() {
                out.extend(line[start..*remaining].iter().rev());
                *remaining = start;
            } else {
                while *remaining > 0 && out.len() + 4 <= limit {
                    let (start, unit) = previous(line, *remaining);
                    out.extend_from_slice(unit);
                    *remaining = start;
                }
            }
            if *remaining != 0 || out.len() == limit {
                self.busy = true;
                return;
            }
            if terminated {
                out.push(self.terminator);
            }
            self.remaining = None;
            self.records.advance();
        }
        self.busy = true;
    }
}

impl Stream for Rev {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.records.push(input).map_err(|_| {
            StreamError::refusal(b"rev: cannot allocate 4 bytes: Cannot allocate memory", 1)
        })?;
        self.pump(out);
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.records.end();
        self.pump(out);
        Ok(())
    }

    fn busy(&self) -> bool {
        self.busy
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run;

    #[test]
    fn each_line_reverses_by_character() {
        let chunks: [&[u8]; 3] = [b"abc\nh\xc3", b"\xa9llo\n\n", b"no newline"];
        assert_eq!(
            run("rev", "{}", &chunks).0,
            b"cba\noll\xc3\xa9h\n\nenilwen on"
        );
        assert_eq!(
            run("rev", "{}", &[b"a\xffb\xe2\x82\n"]).0,
            "\u{FFFD}b\u{FFFD}a\n".as_bytes()
        );
    }

    #[test]
    fn zero_ends_a_line_at_nul() {
        let chunks: [&[u8]; 2] = [b"ab\ncd\0e", b"f\0g"];
        assert_eq!(run("rev", r#"{"zero": true}"#, &chunks).0, b"dc\nba\0fe\0g");
    }

    #[test]
    fn backward_units_preserve_lossy_utf8_grouping() {
        let check = |line: &[u8]| {
            let mut reversed = Vec::new();
            let mut end = line.len();
            while end > 0 {
                let (start, unit) = previous(line, end);
                reversed.extend_from_slice(unit);
                end = start;
            }
            let expected: String = String::from_utf8_lossy(line).chars().rev().collect();
            assert_eq!(reversed, expected.as_bytes(), "{line:x?}");
        };
        for first in 0..=255 {
            for second in 0..=255 {
                check(&[first, second]);
            }
        }
        let bytes = [
            0, 65, 0x80, 0x90, 0xa0, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xe2, 0xed, 0xef, 0xf0, 0xf4,
            0xf5, 0xff,
        ];
        for a in bytes {
            for b in bytes {
                for c in bytes {
                    for d in bytes {
                        check(&[a, b, c, d]);
                    }
                }
            }
        }
    }

    #[test]
    fn giant_unicode_records_and_many_short_records_have_bounded_output() {
        for input in [
            "a".repeat(WORK * 8),
            "é\u{fffd}".repeat(WORK),
            "x\n".repeat(WORK * 8),
        ] {
            let mut stream = open(b"{}").unwrap();
            let mut piece = Vec::new();
            stream.feed(input.as_bytes(), &mut piece).unwrap();
            let mut out = piece.clone();
            piece.clear();
            stream.finish(&mut piece).unwrap();
            assert!(piece.len() <= WORK);
            out.extend_from_slice(&piece);
            let mut turns = 0;
            while stream.busy() {
                piece.clear();
                stream.drain(&mut piece).unwrap();
                assert!(piece.len() <= WORK);
                out.extend_from_slice(&piece);
                turns += 1;
                assert!(turns < 100);
            }
            assert!(turns > 1);
            let expected = input
                .split_inclusive('\n')
                .map(|line| {
                    let text = line.strip_suffix('\n').unwrap_or(line);
                    let mut reversed: String = text.chars().rev().collect();
                    if line.ends_with('\n') {
                        reversed.push('\n');
                    }
                    reversed
                })
                .collect::<String>();
            assert_eq!(out, expected.as_bytes());
        }
    }
}
