use serde::Deserialize;

use crate::records::{Records, Take};
use crate::{Stream, StreamError, parse_config};

/// The most a call writes past the line it starts.
const OUTPUT: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "crate::latin1")]
    delimiters: Vec<u8>,
    serial: bool,
    zero_terminated: bool,
    /// The input each operand reads, every `-` reading standard input's.
    inputs: Vec<usize>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let sources = config.inputs.iter().max().map_or(0, |last| last + 1);
    Ok(Box::new(Paste {
        delimiters: delimiters(&config.delimiters),
        terminator: if config.zero_terminated { 0 } else { b'\n' },
        serial: config.serial,
        operands: config.inputs,
        sources: (0..sources).map(|_| Records::default()).collect(),
        at: 0,
        count: 0,
        row: Vec::new(),
        any: false,
        done: false,
        more: false,
    }))
}

/// The -d list, one delimiter per byte as GNU reads it: `\n`, `\t` and
/// `\\` stand for those bytes and `\0` for no delimiter, and any other
/// backslash is itself. An empty list is one empty delimiter.
fn delimiters(raw: &[u8]) -> Vec<Option<u8>> {
    let mut list = Vec::new();
    let mut at = 0;
    while at < raw.len() {
        let escaped = match (raw[at], raw.get(at + 1)) {
            (b'\\', Some(b'n')) => Some(Some(b'\n')),
            (b'\\', Some(b't')) => Some(Some(b'\t')),
            (b'\\', Some(b'\\')) => Some(Some(b'\\')),
            (b'\\', Some(b'0')) => Some(None),
            _ => None,
        };
        match escaped {
            Some(delimiter) => {
                list.push(delimiter);
                at += 2;
            }
            None => {
                list.push(Some(raw[at]));
                at += 1;
            }
        }
    }
    if list.is_empty() {
        list.push(None);
    }
    list
}

/// GNU paste, byte for byte: each output line joins one record from every
/// operand, an ended one giving an empty field, until all have ended; with
/// `serial` one operand's records make one line. The delimiters cycle and
/// start over on each line.
struct Paste {
    delimiters: Vec<Option<u8>>,
    terminator: u8,
    serial: bool,
    operands: Vec<usize>,
    sources: Vec<Records>,
    /// The operand whose record comes next.
    at: usize,
    /// The records on the current serial line.
    count: usize,
    /// The current line, held until every operand has given its field.
    row: Vec<u8>,
    any: bool,
    done: bool,
    /// A call stopped at its window with records left.
    more: bool,
}

impl Paste {
    fn pump(&mut self, out: &mut Vec<u8>) {
        let limit = out.len() + OUTPUT;
        self.more = false;
        while !self.done {
            if out.len() >= limit {
                self.more = true;
                return;
            }
            let Some(&source) = self.operands.get(self.at) else {
                self.done = true;
                return;
            };
            let take = self.sources[source].next(self.terminator);
            if matches!(take, Take::Wait) {
                return;
            }
            let field = if self.serial { self.count } else { self.at };
            let line = if self.serial {
                &mut *out
            } else {
                &mut self.row
            };
            if field > 0 && !(self.serial && matches!(take, Take::End)) {
                line.extend(self.delimiters[(field - 1) % self.delimiters.len()]);
            }
            match take {
                Take::Record(record) if self.serial => {
                    out.extend_from_slice(&record);
                    self.count += 1;
                }
                Take::End if self.serial => {
                    out.push(self.terminator);
                    self.at += 1;
                    self.count = 0;
                }
                take => {
                    if let Take::Record(record) = take {
                        self.row.extend_from_slice(&record);
                        self.any = true;
                    }
                    self.at += 1;
                    if self.at == self.operands.len() {
                        if !self.any {
                            self.done = true;
                            return;
                        }
                        out.append(&mut self.row);
                        out.push(self.terminator);
                        self.at = 0;
                        self.any = false;
                    }
                }
            }
        }
    }
}

impl Stream for Paste {
    fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("paste reads its inputs by index"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out);
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        let source = self.operands.get(self.at).copied();
        source.filter(|_| !self.done && !self.more)
    }

    fn busy(&self) -> bool {
        self.more
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out);
        Ok(())
    }

    fn feed_input(
        &mut self,
        source: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if let Some(records) = self.sources.get_mut(source) {
            records.push(input);
        }
        self.pump(out);
        Ok(())
    }

    fn end_input(&mut self, source: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(records) = self.sources.get_mut(source) {
            records.end();
        }
        self.pump(out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;

    fn paste(options: &str, inputs: &[&[u8]]) -> Vec<u8> {
        let defaults =
            r#"{"delimiters":"\t","serial":false,"zero_terminated":false,"inputs":[0,1]}"#;
        let mut stream = open(config(defaults, options).as_bytes()).unwrap();
        let mut at = vec![0; inputs.len()];
        let mut out = Vec::new();
        loop {
            while stream.busy() {
                stream.drain(&mut out).unwrap();
            }
            let Some(source) = stream.wants() else {
                break;
            };
            if at[source] == inputs[source].len() {
                stream.end_input(source, &mut out).unwrap();
            } else {
                let byte = &inputs[source][at[source]..at[source] + 1];
                stream.feed_input(source, byte, &mut out).unwrap();
                at[source] += 1;
            }
        }
        stream.finish(&mut out).unwrap();
        out
    }

    #[test]
    fn rows_join_a_record_from_each_operand() {
        assert_eq!(
            paste("{}", &[b"a\nb\nc", b"1\n\xff\n"]),
            b"a\t1\nb\t\xff\nc\t\n"
        );
        let three = r#"{"delimiters":"\\0,","inputs":[0,1,0]}"#;
        assert_eq!(paste(three, &[b"a\nb\nc\n", b"1\n"]), b"a1,b\nc,\n");
        let bytes = r#"{"delimiters":"Ã©","inputs":[0,1,0]}"#;
        assert_eq!(paste(bytes, &[b"a\nb\n", b"1\n"]), b"a\xc31\xa9b\n");
        let zero = r#"{"delimiters":",","zero_terminated":true}"#;
        assert_eq!(paste(zero, &[b"a\0b\0", b"1\0"]), b"a,1\0b,\0");
        assert_eq!(paste(r#"{"inputs":[0]}"#, &[b""]), b"");
    }

    #[test]
    fn many_ended_operands_write_a_window_per_call() {
        let inputs: Vec<usize> = (0..1_000).collect();
        let config = format!(
            r#"{{"delimiters":"\t","serial":false,"zero_terminated":false,"inputs":{inputs:?}}}"#
        );
        let mut stream = open(config.as_bytes()).unwrap();
        let mut total = 0;
        let mut fed = false;
        loop {
            let mut window = Vec::new();
            if stream.busy() {
                stream.drain(&mut window).unwrap();
            } else if let Some(source) = stream.wants() {
                if source == 0 && !fed {
                    stream.feed_input(0, &[b'\n'; 1_000], &mut window).unwrap();
                    fed = true;
                } else {
                    stream.end_input(source, &mut window).unwrap();
                }
            } else {
                break;
            }
            assert!(window.len() <= OUTPUT + 1_000);
            total += window.len();
        }
        assert_eq!(total, 1_000 * 1_000);
    }

    #[test]
    fn serial_lines_take_one_operand_each() {
        let serial = r#"{"serial":true,"delimiters":"\\n:","inputs":[0,1,0]}"#;
        assert_eq!(paste(serial, &[b"a\nb\nc\nd", b""]), b"a\nb:c\nd\n\n\n");
        assert_eq!(paste(r#"{"serial":true,"inputs":[]}"#, &[]), b"");
    }
}
