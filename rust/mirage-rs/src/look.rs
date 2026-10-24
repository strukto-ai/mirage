use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "crate::latin1")]
    prefix: Vec<u8>,
    fold: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { prefix, fold } = parse_config(config)?;
    Ok(Box::new(Look {
        prefix,
        fold,
        head: Vec::new(),
        line: Line::Head,
    }))
}

/// Where the current line stands against the prefix.
#[derive(PartialEq)]
enum Line {
    /// Its start is still being compared.
    Head,
    Copy,
    Skip,
}

/// util-linux 2.41 look over its input line by line: a line that starts
/// with the prefix, under `fold` with ASCII letters compared without case,
/// is written as it stands, a last line without its newline too.
struct Look {
    prefix: Vec<u8>,
    fold: bool,
    /// The start of the current line, as long as it matches the prefix.
    head: Vec<u8>,
    line: Line,
}

impl Stream for Look {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut rest = input;
        while !rest.is_empty() {
            if self.line == Line::Head {
                let want = &self.prefix[self.head.len()..];
                let take = want.len().min(rest.len());
                let same = |(a, b): (&u8, &u8)| {
                    *a != b'\n' && (a == b || (self.fold && a.eq_ignore_ascii_case(b)))
                };
                let matched = rest[..take]
                    .iter()
                    .zip(want)
                    .take_while(|&pair| same(pair))
                    .count();
                if matched < take {
                    self.head.clear();
                    self.line = Line::Skip;
                } else if take == want.len() {
                    out.append(&mut self.head);
                    self.line = Line::Copy;
                } else {
                    self.head.extend_from_slice(rest);
                    return Ok(());
                }
            }
            let end = memchr::memchr(b'\n', rest).map_or(rest.len(), |at| at + 1);
            if self.line == Line::Copy {
                out.extend_from_slice(&rest[..end]);
            }
            if rest[end - 1] == b'\n' {
                self.line = Line::Head;
            }
            rest = &rest[end..];
        }
        Ok(())
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.head.clear();
        self.line = Line::Head;
        Ok(())
    }
}
