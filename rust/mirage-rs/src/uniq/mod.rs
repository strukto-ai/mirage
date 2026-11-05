mod options;

use std::collections::VecDeque;

use serde::Deserialize;

use crate::records::{Records, Take};
use crate::{Stream, StreamError, parse_config};
use options::Keys;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Method {
    None,
    Prepend,
    Append,
    Separate,
    Both,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    count: bool,
    repeated: bool,
    unique: bool,
    /// `-f`, `-s` and `-w` and the operands as typed, `[name, value]` in
    /// the order typed, an operand named `""`, each value one character
    /// per byte.
    #[serde(default)]
    typed: Vec<(String, String)>,
    ignore_case: bool,
    all_repeated: Option<Method>,
    group: Option<Method>,
    zero_terminated: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(Box::new(Uniq {
        terminator: if config.zero_terminated { 0 } else { b'\n' },
        keys: options::keys(&config.typed)?,
        config,
        records: Records::default(),
        first: None,
        count: 0,
        groups: 0,
        repeated_groups: 0,
        phase: Phase::Read,
        current_key: (0, 0),
        first_key: (0, 0),
        output: VecDeque::new(),
        busy: false,
    }))
}

/// GNU uniq over bytes, in every locale: -f skips runs of blanks and the
/// non-blanks after each, -s and -w count bytes, and -i folds ASCII only.
struct Uniq {
    config: Config,
    keys: Keys,
    terminator: u8,
    records: Records,
    first: Option<Vec<u8>>,
    count: u64,
    groups: u64,
    repeated_groups: u64,
    phase: Phase,
    current_key: (usize, usize),
    first_key: (usize, usize),
    output: VecDeque<Output>,
    busy: bool,
}

const WORK: usize = 16384;

#[derive(Clone, Copy)]
enum Phase {
    Read,
    Key {
        at: usize,
        field: usize,
        blanks: bool,
    },
    Compare(usize),
    Close,
    Prepare,
    Copy(usize),
    Plan,
    Advance,
    Done,
}

#[derive(Clone, Copy)]
enum Source {
    First,
    Current,
}

enum Output {
    Bytes(Vec<u8>, usize),
    Record(Source, usize),
}

impl Uniq {
    fn record(&mut self, source: Source, count: u64) {
        if self.config.count {
            self.output
                .push_back(Output::Bytes(format!("{count:>7} ").into_bytes(), 0));
        }
        self.output.push_back(Output::Record(source, 0));
        self.blank();
    }

    fn blank(&mut self) {
        self.output
            .push_back(Output::Bytes(vec![self.terminator], 0));
    }

    fn close_group(&mut self) {
        if self.first.is_some()
            && self.config.all_repeated.is_none()
            && (self.config.count || self.config.unique)
            && !(self.config.repeated && self.count == 1)
            && !(self.config.unique && self.count > 1)
        {
            self.record(Source::First, self.count);
        }
    }

    fn plan(&mut self) {
        self.count += 1;
        if let Some(group) = self.config.group {
            if self.count == 1
                && (matches!(group, Method::Prepend | Method::Both) || self.groups > 1)
            {
                self.blank();
            }
            self.record(Source::Current, 1);
        } else if let Some(method) = self.config.all_repeated {
            if self.count == 2 {
                if method == Method::Prepend
                    || (method == Method::Separate && self.repeated_groups > 0)
                {
                    self.blank();
                }
                self.record(Source::First, 1);
            }
            if self.count >= 2 {
                self.record(Source::Current, 1);
            }
            if self.count == 2 {
                self.repeated_groups += 1;
            }
        } else if !(self.config.count || self.config.unique)
            && self.count == if self.config.repeated { 2 } else { 1 }
        {
            self.record(Source::First, 1);
        }
        self.phase = Phase::Advance;
    }

    fn emit(&mut self, out: &mut Vec<u8>, available: usize) {
        let item = self.output.pop_front().unwrap();
        let (data, at) = match &item {
            Output::Bytes(data, at) => (data.as_slice(), *at),
            Output::Record(Source::First, at) => (self.first.as_deref().unwrap(), *at),
            Output::Record(Source::Current, at) => {
                let Take::Record((data, _)) = self.records.peek_span(self.terminator) else {
                    unreachable!()
                };
                (data, *at)
            }
        };
        let end = data.len().min(at.saturating_add(available));
        out.extend_from_slice(&data[at..end]);
        if end < data.len() {
            self.output.push_front(match item {
                Output::Bytes(data, _) => Output::Bytes(data, end),
                Output::Record(source, _) => Output::Record(source, end),
            });
        }
    }

    fn pump(&mut self, out: &mut Vec<u8>) {
        let limit = out.len().saturating_add(WORK);
        let mut work = WORK;
        while work > 0 && out.len() < limit {
            work -= 1;
            if !self.output.is_empty() {
                self.emit(out, limit - out.len());
                continue;
            }
            match self.phase {
                Phase::Read => match self.records.peek_span(self.terminator) {
                    Take::Wait => {
                        self.busy = false;
                        return;
                    }
                    Take::End => {
                        self.close_group();
                        if self.first.is_some()
                            && matches!(self.config.group, Some(Method::Append | Method::Both))
                        {
                            self.blank();
                        }
                        self.phase = Phase::Done;
                    }
                    Take::Record(_) => {
                        self.phase = Phase::Key {
                            at: 0,
                            field: 0,
                            blanks: true,
                        }
                    }
                },
                Phase::Key {
                    mut at,
                    mut field,
                    mut blanks,
                } => {
                    let Take::Record((line, _)) = self.records.peek_span(self.terminator) else {
                        unreachable!()
                    };
                    while at < line.len() && field < self.keys.skip_fields && work > 0 {
                        let blank = matches!(line[at], b' ' | b'\t');
                        if !blanks && blank {
                            field += 1;
                            blanks = true;
                            continue;
                        }
                        if !blank {
                            blanks = false;
                        }
                        at += 1;
                        work -= 1;
                    }
                    if at == line.len() || field == self.keys.skip_fields {
                        let start = at.saturating_add(self.keys.skip_chars).min(line.len());
                        let end = start
                            .saturating_add(self.keys.check_chars.unwrap_or(usize::MAX))
                            .min(line.len());
                        self.current_key = (start, end);
                        self.phase = if self.first.is_some()
                            && end - start == self.first_key.1 - self.first_key.0
                        {
                            Phase::Compare(0)
                        } else {
                            Phase::Close
                        };
                    } else {
                        self.phase = Phase::Key { at, field, blanks };
                    }
                }
                Phase::Compare(at) => {
                    let Take::Record((line, _)) = self.records.peek_span(self.terminator) else {
                        unreachable!()
                    };
                    let key = &line[self.current_key.0..self.current_key.1];
                    let before =
                        &self.first.as_deref().unwrap()[self.first_key.0..self.first_key.1];
                    let end = key.len().min(at.saturating_add(work));
                    let same = if self.config.ignore_case {
                        key[at..end].eq_ignore_ascii_case(&before[at..end])
                    } else {
                        key[at..end] == before[at..end]
                    };
                    work -= end - at;
                    self.phase = if !same {
                        Phase::Close
                    } else if end == key.len() {
                        Phase::Plan
                    } else {
                        Phase::Compare(end)
                    };
                }
                Phase::Close => {
                    self.close_group();
                    self.phase = Phase::Prepare;
                }
                Phase::Prepare => {
                    let Take::Record((line, _)) = self.records.peek_span(self.terminator) else {
                        unreachable!()
                    };
                    let first = self.first.get_or_insert_with(Vec::new);
                    if first.capacity() < line.len()
                        || first.capacity() > line.len().max(WORK).saturating_mul(2)
                    {
                        *first = Vec::with_capacity(line.len());
                    } else {
                        first.clear();
                    }
                    self.first_key = self.current_key;
                    self.count = 0;
                    self.groups += 1;
                    self.phase = Phase::Copy(0);
                }
                Phase::Copy(at) => {
                    let Take::Record((line, _)) = self.records.peek_span(self.terminator) else {
                        unreachable!()
                    };
                    let end = line.len().min(at.saturating_add(work));
                    self.first
                        .as_mut()
                        .unwrap()
                        .extend_from_slice(&line[at..end]);
                    work -= end - at;
                    self.phase = if end == line.len() {
                        Phase::Plan
                    } else {
                        Phase::Copy(end)
                    };
                }
                Phase::Plan => self.plan(),
                Phase::Advance => {
                    self.records.advance();
                    self.phase = Phase::Read;
                }
                Phase::Done => {
                    self.first = None;
                    self.busy = false;
                    return;
                }
            }
        }
        self.busy = true;
    }
}

impl Stream for Uniq {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.records.push(input);
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
    use crate::{config, run};

    #[test]
    fn giant_keys_copies_and_group_output_resume_in_bounded_steps() {
        let cases = [
            (
                r#"{"count":true,"typed":[["skip_fields","1"]]}"#,
                [
                    vec![b' '; WORK * 4],
                    b"x KEY\n".to_vec(),
                    vec![b' '; WORK * 4],
                    b"y KEY\n".to_vec(),
                ]
                .concat(),
                [
                    b"      2 ".to_vec(),
                    vec![b' '; WORK * 4],
                    b"x KEY\n".to_vec(),
                ]
                .concat(),
            ),
            (
                r#"{"ignore_case":true}"#,
                [
                    vec![b'a'; WORK * 8],
                    b"\n".to_vec(),
                    vec![b'A'; WORK * 8],
                    b"\n".to_vec(),
                ]
                .concat(),
                [vec![b'a'; WORK * 8], b"\n".to_vec()].concat(),
            ),
            (
                r#"{"count":true}"#,
                b"a\nb\n".repeat(WORK),
                b"      1 a\n      1 b\n".repeat(WORK),
            ),
        ];
        for (options, input, expected) in cases {
            let config = config(
                r#"{"count":false,"repeated":false,"unique":false,"typed":[],"ignore_case":false,"all_repeated":null,"group":null,"zero_terminated":false}"#,
                options,
            );
            let mut stream = open(config.as_bytes()).unwrap();
            let mut piece = Vec::new();
            stream.feed(&input, &mut piece).unwrap();
            assert!(piece.len() <= WORK);
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
                assert!(turns < 1000);
            }
            assert!(turns > 1);
            assert_eq!(out, expected);
        }
    }

    fn uniq(options: &str, input: &[u8]) -> Vec<u8> {
        let config = config(
            r#"{"count":false,"repeated":false,"unique":false,"typed":[],"ignore_case":false,"all_repeated":null,"group":null,"zero_terminated":false}"#,
            options,
        );
        let whole = run("uniq", &config, &[input]);
        for width in [1, 3] {
            let chunks: Vec<&[u8]> = input.chunks(width).collect();
            assert_eq!(run("uniq", &config, &chunks), whole, "width {width}");
        }
        assert!(whole.1.is_none());
        whole.0
    }

    #[test]
    fn keys_count_bytes_and_fold_ascii_only() {
        let folded = uniq(r#"{"ignore_case":true}"#, "é\nÉ\nA\na".as_bytes());
        assert_eq!(folded, "é\nÉ\nA\n".as_bytes());
        let skipped = uniq(r#"{"typed":[["skip_chars","1"]]}"#, "éa\nèa\n".as_bytes());
        assert_eq!(skipped, "éa\nèa\n".as_bytes());
        let fields = uniq(
            r#"{"typed":[["skip_fields","1"],["skip_chars","2"],["check_chars","2"]]}"#,
            b"x  abc\ny  abd\n",
        );
        assert_eq!(fields, b"x  abc\n");
        let blanks = uniq(
            r#"{"typed":[["skip_fields","1"],["check_chars"," +2"]]}"#,
            b"x  abc\ny\tabd\n",
        );
        assert_eq!(blanks, b"x  abc\ny\tabd\n");
    }

    #[test]
    fn counts_groups_and_repeats_follow_gnu_layout() {
        let input = b"a\na\nb\nc\nc\nc";
        assert_eq!(
            uniq(r#"{"count":true}"#, input),
            b"      2 a\n      1 b\n      3 c\n"
        );
        assert_eq!(uniq(r#"{"repeated":true}"#, input), b"a\nc\n");
        assert_eq!(uniq(r#"{"unique":true}"#, input), b"b\n");
        assert_eq!(uniq(r#"{"repeated":true,"unique":true}"#, input), b"");
        assert_eq!(
            uniq(r#"{"all_repeated":"separate"}"#, input),
            b"a\na\n\nc\nc\nc\n"
        );
        assert_eq!(uniq(r#"{"group":"both"}"#, b"a\na\nb"), b"\na\na\n\nb\n\n");
        assert_eq!(uniq(r#"{"group":"both"}"#, b""), b"");
        assert_eq!(uniq(r#"{"zero_terminated":true}"#, b"a\0a\0b"), b"a\0b\0");
    }
}
