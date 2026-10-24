use serde::Deserialize;
use serde_json::json;

use crate::regex::parse::Dialect;
use crate::regex::posix::{Options, Posix};
use crate::{Stream, StreamError, parse_config};

/// The fewest input bytes one request reads.
const BLOCK: u64 = 1 << 16;
/// The most places a regular expression is tried at, and steps a
/// backtracked attempt takes, per call.
const STEPS: u64 = 1 << 16;
/// The most of one record a regular expression is searched in: GNU holds
/// the record it searches and runs out of memory past what it can get.
#[cfg(not(test))]
const MAX_HELD: u64 = 1 << 30;
#[cfg(test)]
const MAX_HELD: u64 = 1 << 20;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    separator: Option<Vec<u8>>,
    before: bool,
    regex: bool,
    utf8: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    size: u64,
}

enum Separator {
    Bytes(Vec<u8>),
    Regex(Box<Posix>),
}

/// What the stream asks of its host: input bytes `offset..offset + size`
/// read back (`read`), or written to the output (`emit`).
#[derive(Clone, Copy)]
struct Ask {
    op: &'static str,
    offset: u64,
    size: u64,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config = parse_config::<Config>(config)?;
    let separator = match config.separator {
        None => Separator::Bytes(b"\n".to_vec()),
        Some(text) if text.is_empty() && config.regex => {
            return Err(StreamError::new("tac: separator cannot be empty"));
        }
        // GNU's separator is a C string, and an empty one is its NUL.
        Some(text) if text.is_empty() => Separator::Bytes(vec![0]),
        Some(text) if config.regex => {
            let options = Options {
                extended: false,
                dialect: Dialect::Emacs,
                ignore_case: false,
                utf8: config.utf8,
                multiline: true,
                word: false,
            };
            let posix = Posix::compile(&text, &options)
                .map_err(|err| StreamError::new(format!("tac: {err}")))?;
            Separator::Regex(Box::new(posix))
        }
        Some(text) => Separator::Bytes(text),
    };
    Ok(Box::new(Tac {
        separator,
        before: config.before,
        utf8: config.utf8,
        start: 0,
        held: Vec::new(),
        end: 0,
        limit: 0,
        tried: 0,
        ask: None,
        asked: None,
        done: true,
        status: 0,
        stderr: Vec::new(),
    }))
}

/// GNU tac 9.7: each input's records in reverse order, a separator ending
/// each one, or with `before` starting it. The input is searched from its
/// end, as tac reads a file backward: each separator is the latest that
/// starts below the one found before it and ends by that one's start, so
/// `aa` splits `xaaay` as `xaaa|y`, and a regular expression is matched
/// against the input cut there, so `b$` finds both of `abb`. The host
/// holds the input: the stream reads it a block at a time and has the
/// host write a record longer than what it holds. One divergence: GNU
/// reads 8 KiB blocks that start at multiples of 8 KiB, and its `^`, `\b`,
/// `\<` and `` \` `` also hold at each block's start; here they hold where
/// the input says.
struct Tac {
    separator: Separator,
    before: bool,
    utf8: bool,
    /// Where in the input `held` starts.
    start: u64,
    held: Vec<u8>,
    /// The end of the record whose start is searched for.
    end: u64,
    /// Where the next separator must end by: the last one's start.
    limit: u64,
    /// Below `limit`, the place a regular expression has been tried down
    /// to.
    tried: u64,
    ask: Option<Ask>,
    /// The request taken, until the host answers it.
    asked: Option<Ask>,
    /// The input is reversed, or none has begun.
    done: bool,
    status: i32,
    stderr: Vec<u8>,
}

impl Tac {
    /// Write records until the input is done, the host is needed, or the
    /// tries a call may spend are spent.
    fn run(&mut self, out: &mut Vec<u8>) {
        let mut budget = STEPS;
        while !self.done && self.ask.is_none() {
            match self.find(&mut budget) {
                Err(()) => return,
                Ok(Some((first, last))) => {
                    let from = if self.before { first } else { last };
                    let end = std::mem::replace(&mut self.end, from);
                    (self.limit, self.tried) = (first, first);
                    self.write(from, end, out);
                }
                Ok(None) if self.start == 0 => {
                    let end = std::mem::replace(&mut self.end, 0);
                    self.done = true;
                    self.write(0, end, out);
                }
                Ok(None) => self.read_more(),
            }
        }
    }

    /// The latest separator below `limit` in what is held.
    fn find(&mut self, budget: &mut u64) -> Result<Option<(u64, u64)>, ()> {
        let start = self.start;
        let span = |at: usize, len: usize| (start + at as u64, start + (at + len) as u64);
        let top = usize::try_from(self.limit - start).unwrap_or(usize::MAX);
        match &mut self.separator {
            Separator::Bytes(text) => {
                let hay = &self.held[..top.min(self.held.len())];
                Ok(memchr::memmem::rfind(hay, text).map(|at| span(at, text.len())))
            }
            Separator::Regex(posix) => {
                // A place is tried with the character before it held: a
                // byte, or under UTF-8 as many as one may take.
                let context = match (start, self.utf8) {
                    (0, _) => 0,
                    (_, false) => 1,
                    (_, true) => 4,
                };
                let low = start + context;
                if self.tried <= low {
                    return Ok(None);
                }
                let tried = usize::try_from(self.tried - start).unwrap_or(usize::MAX);
                let found = posix.latest(&self.held[..top], (low - start) as usize, tried, budget);
                match found {
                    Ok(found) => {
                        self.tried = low;
                        Ok(found.map(|(first, last)| span(first, last - first)))
                    }
                    Err(at) => {
                        self.tried = start + at as u64;
                        Err(())
                    }
                }
            }
        }
    }

    /// Write `from..to`, from what is held when it holds it all, and drop
    /// what is held past `from`.
    fn write(&mut self, from: u64, to: u64, out: &mut Vec<u8>) {
        let held_to = self.start + self.held.len() as u64;
        if from < to && to <= held_to {
            out.extend_from_slice(
                &self.held[(from - self.start) as usize..(to - self.start) as usize],
            );
        } else if from < to {
            let (op, offset, size) = ("emit", from, to - from);
            self.ask = Some(Ask { op, offset, size });
        }
        self.held.truncate((from - self.start) as usize);
    }

    /// Ask for the block before what is held, keeping of it what a
    /// separator across the two needs, and a short record's tail.
    fn read_more(&mut self) {
        let below = self.limit - self.start;
        let keep = match &self.separator {
            Separator::Bytes(text) => below.min(text.len() as u64 - 1),
            Separator::Regex(_) => below,
        };
        let pending = self.end - self.start;
        let keep = if pending <= BLOCK {
            keep.max(pending)
        } else {
            keep
        };
        self.held
            .truncate(usize::try_from(keep).unwrap_or(usize::MAX));
        let size = BLOCK.max(self.held.len() as u64).min(self.start);
        if matches!(self.separator, Separator::Regex(_)) && below + size > MAX_HELD {
            self.stderr.extend_from_slice(b"tac: memory exhausted\n");
            self.status = 1;
            self.done = true;
            return;
        }
        let (op, offset) = ("read", self.start - size);
        self.ask = Some(Ask { op, offset, size });
    }
}

impl Stream for Tac {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("tac reads its input through requests"))
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.done = true;
        self.held = Vec::new();
        Ok(())
    }

    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let Input { size } = parse_config(config)?;
        (self.start, self.end, self.limit, self.tried) = (size, size, size, size);
        self.held.clear();
        (self.ask, self.asked) = (None, None);
        self.done = size == 0;
        Ok(())
    }

    fn busy(&self) -> bool {
        !self.done && self.ask.is_none() && self.asked.is_none()
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.run(out);
        Ok(())
    }

    fn status(&self) -> i32 {
        self.status
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }

    fn request(&mut self, _data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let ask = self.ask.take()?;
        self.asked = Some(ask);
        let Ask { op, offset, size } = ask;
        serde_json::to_vec(&json!({"op": op, "offset": offset, "size": size})).ok()
    }

    fn respond(
        &mut self,
        _reply: &[u8],
        data: &[u8],
        _out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        match self.asked.take() {
            Some(Ask {
                op: "read",
                offset,
                size,
            }) if data.len() as u64 == size => {
                let mut held = Vec::with_capacity(data.len() + self.held.len());
                held.extend_from_slice(data);
                held.append(&mut self.held);
                (self.held, self.start) = (held, offset);
                Ok(())
            }
            Some(Ask { op: "emit", .. }) => Ok(()),
            _ => Err(StreamError::new("tac: the host answered no request")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_HELD, open};

    #[test]
    fn a_regex_searches_no_more_than_it_may_hold() {
        let config = br#"{"separator":"q","before":false,"regex":true,"utf8":false}"#;
        let mut stream = open(config).expect("opens");
        let size = format!(r#"{{"size":{}}}"#, 3 * MAX_HELD);
        stream.begin(size.as_bytes()).expect("begins");
        let mut out = Vec::new();
        loop {
            while stream.busy() {
                stream.drain(&mut out).expect("drains");
            }
            let Some(header) = stream.request(&mut Vec::new()) else {
                break;
            };
            let ask: serde_json::Value = serde_json::from_slice(&header).expect("json");
            let block = vec![b'z'; ask["size"].as_u64().expect("size") as usize];
            stream.respond(b"{}", &block, &mut out).expect("reads");
        }
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        assert_eq!((out.len(), stream.status()), (0, 1));
        assert_eq!(err, b"tac: memory exhausted\n");
    }

    #[test]
    fn a_backtracked_attempt_goes_on_over_calls() {
        let separator = r#""\\(a+\\)+\\1b\\|x""#;
        let config =
            format!(r#"{{"separator":{separator},"before":false,"regex":true,"utf8":false}}"#);
        let mut stream = open(config.as_bytes()).expect("opens");
        let mut input = b"x".to_vec();
        input.extend([b'a'; 20]);
        stream.begin(br#"{"size":21}"#).expect("begins");
        let mut out = Vec::new();
        stream.drain(&mut out).expect("drains");
        stream.request(&mut Vec::new()).expect("reads");
        stream.respond(b"{}", &input, &mut out).expect("reads");
        let mut calls = 0;
        while stream.busy() {
            stream.drain(&mut out).expect("drains");
            calls += 1;
        }
        assert!(calls > 1, "{calls}");
        assert_eq!(out, [&input[1..], b"x"].concat());
    }

    #[test]
    fn a_place_waits_for_the_whole_character_before_it() {
        let config = br#"{"separator":"\\<a","before":false,"regex":true,"utf8":true}"#;
        let mut stream = open(config).expect("opens");
        let input = ["éa".as_bytes(), &[b'!'; 65_534]].concat();
        let size = format!(r#"{{"size":{}}}"#, input.len());
        stream.begin(size.as_bytes()).expect("begins");
        let mut out = Vec::new();
        loop {
            while stream.busy() {
                stream.drain(&mut out).expect("drains");
            }
            let Some(header) = stream.request(&mut Vec::new()) else {
                break;
            };
            let ask: serde_json::Value = serde_json::from_slice(&header).expect("json");
            let offset = ask["offset"].as_u64().expect("offset") as usize;
            let window = &input[offset..offset + ask["size"].as_u64().expect("size") as usize];
            if ask["op"] == "emit" {
                out.extend_from_slice(window);
                stream.respond(b"{}", b"", &mut out).expect("emits");
            } else {
                stream.respond(b"{}", window, &mut out).expect("reads");
            }
        }
        assert_eq!(out, input);
    }
}
