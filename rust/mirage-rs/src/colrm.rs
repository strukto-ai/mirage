use serde::Deserialize;

use crate::{
    Stream, StreamError,
    constants::{OUTPUT, WORK},
    parse_config, quoted,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default, deserialize_with = "crate::latin1_list")]
    args: Vec<Vec<u8>>,
    utf8: bool,
}

enum Phase {
    Before(u64),
    Removing(u64),
    After,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { args, utf8 } = parse_config(config)?;
    let start = args
        .first()
        .map(|word| column(word, "first"))
        .transpose()?
        .unwrap_or(0);
    let stop = args.get(1).map(|word| column(word, "second")).transpose()?;
    Ok(Box::new(Colrm {
        start,
        stop,
        utf8,
        phase: Phase::Before(0),
        input: Vec::new(),
        at: 0,
        waiting: false,
        ended: false,
        padding: 0,
    }))
}

fn column(word: &[u8], which: &str) -> Result<u64, StreamError> {
    let bad = || format!("colrm: {which} argument: '{}'", quoted(word));
    if word.is_empty() || !word.iter().all(u8::is_ascii_digit) {
        return Err(StreamError::new(bad()));
    }
    word.iter()
        .try_fold(0u64, |n, b| {
            n.checked_mul(10)?
                .checked_add(u64::from(b - b'0'))
                .filter(|n| *n <= i64::MAX as u64)
        })
        .ok_or_else(|| StreamError::new(format!("{}: Numerical result out of range", bad())))
}

struct Colrm {
    start: u64,
    stop: Option<u64>,
    utf8: bool,
    phase: Phase,
    input: Vec<u8>,
    at: usize,
    waiting: bool,
    ended: bool,
    padding: u64,
}

impl Colrm {
    fn take(&mut self, first: u8) -> (u64, bool) {
        let (column, before) = match self.phase {
            Phase::After => return (0, true),
            Phase::Before(n) => (n, true),
            Phase::Removing(n) => (n, false),
        };
        let after = match first {
            b'\t' => (column + 8) / 8 * 8,
            b'\x08' => column.saturating_sub(1),
            _ => column + u64::from(first >= 32 && first != 127),
        };
        if before && after < self.start {
            self.phase = Phase::Before(after);
            return (0, true);
        }
        let padding = if before {
            self.start.saturating_sub(1).saturating_sub(column)
        } else {
            0
        };
        self.phase = Phase::Removing(after);
        let tail = if let Some(stop) = self.stop.filter(|stop| after >= *stop) {
            self.phase = Phase::After;
            after - stop
        } else {
            0
        };
        (padding + tail, false)
    }

    fn pump(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.waiting = false;
        let end = self.at.saturating_add(WORK).min(self.input.len());
        let limit = out.len().saturating_add(OUTPUT);
        while out.len() + 8 <= limit {
            if self.padding > 0 {
                let count = self.padding.min((limit - out.len()) as u64) as usize;
                out.resize(out.len() + count, b' ');
                self.padding -= count as u64;
                continue;
            }
            if self.at >= end {
                break;
            }
            let first = self.input[self.at];
            let size = if first < 128 {
                1
            } else if !self.utf8 {
                0
            } else {
                let wanted = match first {
                    0xc2..=0xdf => 2,
                    0xe0..=0xef => 3,
                    0xf0..=0xf4 => 4,
                    _ => 1,
                };
                let mut n = 1;
                while n < wanted
                    && self.at + n < self.input.len()
                    && (0x80..0xc0).contains(&self.input[self.at + n])
                {
                    n += 1;
                }
                if self.at + n == self.input.len() && n < wanted {
                    if self.ended {
                        self.at = self.input.len();
                    } else {
                        self.waiting = true;
                    }
                    break;
                }
                if std::str::from_utf8(&self.input[self.at..self.at + n]).is_ok() {
                    n
                } else {
                    0
                }
            };
            if size == 0 {
                return Err(StreamError::new(
                    "colrm: fgetwc() failed: Invalid or incomplete multibyte or wide character",
                ));
            }
            if first == b'\n' {
                self.phase = Phase::Before(0);
                out.push(first);
            } else {
                let (spaces, prints) = if self.start == 0 {
                    (0, true)
                } else {
                    self.take(first)
                };
                self.padding = spaces;
                if prints {
                    out.extend_from_slice(&self.input[self.at..self.at + size]);
                }
            }
            self.at += size;
        }
        Ok(())
    }
}

impl Stream for Colrm {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.input.drain(..self.at);
        self.at = 0;
        self.input.extend_from_slice(input);
        self.pump(out)
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.ended = true;
        self.pump(out)
    }
    fn busy(&self) -> bool {
        self.padding > 0 || !self.waiting && self.at < self.input.len()
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run;

    #[test]
    fn columns_and_utf8_survive_every_split() {
        let data = "ab\tc\x08def\né中🙂x\n".as_bytes();
        for split in 0..=data.len() {
            let (out, error) = run(
                "colrm",
                r#"{"args":["3","5"],"utf8":true}"#,
                &[&data[..split], &data[split..]],
            );
            assert_eq!(out, "ab   c\x08def\né中\n".as_bytes());
            assert!(error.is_none());
        }
    }

    #[test]
    fn invalid_and_unfinished_bytes_keep_partial_output() {
        let config = r#"{"args":["2"],"utf8":true}"#;
        let (out, error) = run("colrm", config, &[b"a\xc3", b"b"]);
        assert_eq!(out, b"a");
        assert!(error.is_some());
        assert_eq!(run("colrm", config, &[b"a\xc3"]).0, b"a");
        assert!(
            run("colrm", r#"{"args":[],"utf8":false}"#, &[b"x\xc3\xa9"])
                .1
                .is_some()
        );
    }

    #[test]
    fn operands_preserve_refusals_and_ignore_extra_words() {
        for (arg, suffix) in [
            ("x", ""),
            ("9223372036854775808", ": Numerical result out of range"),
        ] {
            let config = serde_json::json!({"args":[arg],"utf8":true}).to_string();
            let error = open(config.as_bytes()).err().expect("invalid operand");
            assert_eq!(
                error.message,
                format!("colrm: first argument: '{arg}'{suffix}")
            );
        }
        assert_eq!(
            run(
                "colrm",
                r#"{"args":["2","3","ignored"],"utf8":true}"#,
                &[b"abc\n"]
            )
            .0,
            b"a\n"
        );
        assert_eq!(
            run("colrm", r#"{"args":["0","2"],"utf8":true}"#, &[b"abc\n"]).0,
            b"abc\n"
        );
    }

    #[test]
    fn reversed_range_padding_yields_bounded_output() {
        let mut stream = open(br#"{"args":["70000","0"],"utf8":true}"#).unwrap();
        let mut piece = Vec::new();
        let mut output = Vec::new();
        stream.feed(&vec![b'a'; 70000], &mut piece).unwrap();
        loop {
            assert!(piece.len() <= OUTPUT);
            output.append(&mut piece);
            if !stream.busy() {
                break;
            }
            stream.drain(&mut piece).unwrap();
        }
        assert_eq!(&output[..69999], vec![b'a'; 69999]);
        assert_eq!(&output[69999..], vec![b' '; 70000]);
    }
}
