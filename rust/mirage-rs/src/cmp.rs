use serde::Deserialize;

use crate::{Stream, StreamError, latin1_list, parse_config};

const INTMAX: u64 = i64::MAX as u64;
const WINDOW: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "latin1_list")]
    names: Vec<Vec<u8>>,
    piped: [bool; 2],
    skip: [u64; 2],
    limit: Option<u64>,
    #[serde(default)]
    silent: bool,
    #[serde(default)]
    verbose: bool,
    #[serde(default)]
    print_bytes: bool,
}

/// GNU cmp over two inputs fed side by side: each is skipped, cut at -n,
/// and compared in lock step, so without -l the reads stop at the first
/// difference. -l lists every one, its offset column sized by what each
/// file held, so its rows wait for both inputs to end.
struct Cmp {
    config: Config,
    skip: [u64; 2],
    held: [Vec<u8>; 2],
    ended: [bool; 2],
    taken: [u64; 2],
    compared: u64,
    lines: u64,
    last: Option<u8>,
    rows: Vec<(u64, u8, u8)>,
    row: usize,
    width: usize,
    decided: bool,
    status: i32,
    output: Vec<u8>,
    cursor: usize,
    stderr: Vec<u8>,
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    if config.names.len() != 2 {
        return Err(StreamError::new("cmp compares two inputs"));
    }
    let skip = config.skip;
    let decided = config.limit == Some(0);
    Ok(Box::new(Cmp {
        config,
        skip,
        held: [Vec::new(), Vec::new()],
        ended: [false; 2],
        taken: [0; 2],
        compared: 0,
        lines: 0,
        last: None,
        rows: Vec::new(),
        row: 0,
        width: 0,
        decided,
        status: 0,
        output: Vec::new(),
        cursor: 0,
        stderr: Vec::new(),
    }))
}

/// One byte the way `cmp -b` shows it: cat -v's alphabet, a tab as `^I`.
fn visible(byte: u8, out: &mut Vec<u8>) {
    let mut low = byte;
    if low >= 128 {
        out.extend_from_slice(b"M-");
        low -= 128;
    }
    match low {
        127 => out.extend_from_slice(b"^?"),
        0..32 => out.extend_from_slice(&[b'^', low + 64]),
        _ => out.push(low),
    }
}

fn newlines(data: &[u8]) -> u64 {
    memchr::memchr_iter(b'\n', data).count() as u64
}

impl Cmp {
    fn exhausted(&self, index: usize) -> bool {
        self.ended[index] || self.config.limit == Some(self.taken[index])
    }

    fn drained(&self, index: usize) -> bool {
        self.held[index].is_empty() && self.exhausted(index)
    }

    fn decide(&mut self, status: i32) {
        self.decided = true;
        self.status = status;
        for held in &mut self.held {
            held.clear();
        }
    }

    fn take(&mut self, index: usize, mut input: &[u8]) {
        let skipped = self.skip[index].min(input.len() as u64);
        self.skip[index] -= skipped;
        input = &input[skipped as usize..];
        if let Some(limit) = self.config.limit {
            input = &input[..(input.len() as u64).min(limit - self.taken[index]) as usize];
        }
        self.taken[index] += input.len() as u64;
        self.held[index].extend_from_slice(input);
    }

    /// GNU's `EOF on FILE` line for the shorter input: without -l it also
    /// names the line the input ended on, or inside.
    fn eof(&mut self, shorter: usize, held: u64) {
        let name = self.config.names[shorter].clone();
        self.stderr.extend_from_slice(b"cmp: EOF on ");
        self.stderr.extend_from_slice(&name);
        if held == 0 {
            self.stderr.extend_from_slice(b" which is empty\n");
            return;
        }
        self.stderr
            .extend_from_slice(format!(" after byte {held}").as_bytes());
        if !self.config.verbose {
            let line = if self.last == Some(b'\n') {
                format!(", line {}", self.lines)
            } else {
                format!(", in line {}", self.lines + 1)
            };
            self.stderr.extend_from_slice(line.as_bytes());
        }
        self.stderr.push(b'\n');
    }

    fn differ(&mut self, at: u64, line: u64, first: u8, second: u8) {
        let unit = if self.config.print_bytes {
            "byte"
        } else {
            "char"
        };
        let [one, two] = [&self.config.names[0], &self.config.names[1]];
        self.output.extend_from_slice(one);
        self.output.push(b' ');
        self.output.extend_from_slice(two);
        self.output
            .extend_from_slice(format!(" differ: {unit} {}, line {line}", at + 1).as_bytes());
        if self.config.print_bytes {
            self.output
                .extend_from_slice(format!(" is {first:>3o} ").as_bytes());
            visible(first, &mut self.output);
            self.output
                .extend_from_slice(format!(" {second:>3o} ").as_bytes());
            visible(second, &mut self.output);
        }
        self.output.push(b'\n');
    }

    /// Both inputs ended: without -l they were equal; with it, the rows
    /// wait on the offset width the files' lengths give.
    fn ended_both(&mut self) {
        if !self.config.verbose {
            self.decide(0);
            return;
        }
        let [first, second] = self.taken;
        if self.rows.is_empty() && first == second {
            self.decide(0);
            return;
        }
        let most = (0..2)
            .filter(|index| !self.config.piped[*index])
            .map(|index| self.taken[index])
            .fold(self.config.limit.unwrap_or(INTMAX), u64::min);
        self.width = most.to_string().len();
        if first != second {
            let shorter = usize::from(second < first);
            self.eof(shorter, first.min(second));
        }
        self.decide(1);
    }

    fn process(&mut self) {
        while !self.decided {
            let (gone0, gone1) = (self.drained(0), self.drained(1));
            if gone0 && gone1 {
                self.ended_both();
                return;
            }
            if gone0 || gone1 {
                let other = usize::from(gone0);
                if self.config.verbose {
                    self.held[other].clear();
                    return;
                }
                if self.held[other].is_empty() {
                    return;
                }
                if !self.config.silent {
                    self.eof(1 - other, self.compared);
                }
                self.decide(1);
                return;
            }
            if self.held[0].is_empty() || self.held[1].is_empty() {
                return;
            }
            let count = self.held[0].len().min(self.held[1].len());
            let (a, b) = (&self.held[0][..count], &self.held[1][..count]);
            if self.config.verbose {
                for (at, (x, y)) in a.iter().zip(b).enumerate() {
                    if x != y {
                        self.rows.push((self.compared + at as u64 + 1, *x, *y));
                    }
                }
            } else if let Some(at) = a.iter().zip(b).position(|(x, y)| x != y) {
                if self.config.silent {
                    self.decide(1);
                    return;
                }
                let line = 1 + self.lines + newlines(&a[..at]);
                let (x, y) = (a[at], b[at]);
                self.differ(self.compared + at as u64, line, x, y);
                self.decide(1);
                return;
            }
            self.lines += newlines(a);
            self.last = a.last().copied();
            self.compared += count as u64;
            self.held[0].drain(..count);
            self.held[1].drain(..count);
        }
    }

    fn render(&mut self, out: &mut Vec<u8>) {
        let width = self.width;
        let start = out.len();
        while self.row < self.rows.len() && out.len() - start < WINDOW {
            let (offset, first, second) = self.rows[self.row];
            out.extend_from_slice(format!("{offset:>width$} {first:>3o}").as_bytes());
            if self.config.print_bytes {
                let at = out.len();
                out.push(b' ');
                visible(first, out);
                out.resize(at + 5.max(out.len() - at), b' ');
            }
            out.extend_from_slice(format!(" {second:>3o}").as_bytes());
            if self.config.print_bytes {
                out.push(b' ');
                visible(second, out);
            }
            out.push(b'\n');
            self.row += 1;
        }
    }
}

impl Stream for Cmp {
    fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("use indexed inputs"))
    }

    fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.decided {
            return Err(StreamError::new("cmp needs both inputs to end"));
        }
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        if self.decided {
            return None;
        }
        (0..2).find(|index| self.held[*index].is_empty() && !self.exhausted(*index))
    }

    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        _: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if index > 1 || self.ended[index] {
            return Err(StreamError::new("invalid or ended input"));
        }
        if !self.decided {
            self.take(index, input);
            self.process();
        }
        Ok(())
    }

    fn end_input(&mut self, index: usize, _: &mut Vec<u8>) -> Result<(), StreamError> {
        if index > 1 || self.ended[index] {
            return Err(StreamError::new("invalid or ended input"));
        }
        self.ended[index] = true;
        self.process();
        Ok(())
    }

    fn busy(&self) -> bool {
        self.cursor < self.output.len() || (self.decided && self.row < self.rows.len())
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.cursor < self.output.len() {
            out.extend_from_slice(&self.output[self.cursor..]);
            self.cursor = self.output.len();
        } else if self.decided {
            self.render(out);
        }
        Ok(())
    }

    fn status(&self) -> i32 {
        self.status
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        if self.decided {
            err.append(&mut self.stderr);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Run {
        out: String,
        err: String,
        status: i32,
        pulls: [usize; 2],
    }

    fn run(flags: &str, inputs: [&[&[u8]]; 2]) -> Run {
        let mut config = serde_json::json!({
            "names": ["one", "two"], "piped": [false, false], "skip": [0, 0], "limit": null,
        });
        let flags: serde_json::Value = serde_json::from_str(&format!("{{{flags}}}")).unwrap();
        for (key, value) in flags.as_object().unwrap() {
            config[key] = value.clone();
        }
        let mut stream = open(config.to_string().as_bytes()).unwrap();
        let mut out = Vec::new();
        let mut pulls = [0; 2];
        while let Some(index) = stream.wants() {
            let chunk = inputs[index].get(pulls[index]);
            pulls[index] += 1;
            match chunk {
                Some(chunk) => stream.feed_input(index, chunk, &mut out).unwrap(),
                None => stream.end_input(index, &mut out).unwrap(),
            }
            while stream.busy() {
                stream.drain(&mut out).unwrap();
            }
        }
        stream.finish(&mut out).unwrap();
        while stream.busy() {
            stream.drain(&mut out).unwrap();
        }
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        Run {
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
            status: stream.status(),
            pulls,
        }
    }

    #[test]
    fn b_shows_a_byte_the_cat_v_way() {
        for (byte, shown) in [
            (b'b', "b"),
            (9, "^I"),
            (1, "^A"),
            (127, "^?"),
            (0xc3, "M-C"),
            (0xa9, "M-)"),
            (0x80, "M-^@"),
        ] {
            let mut out = Vec::new();
            visible(byte, &mut out);
            assert_eq!(out, shown.as_bytes());
        }
    }

    #[test]
    fn a_difference_stops_both_reads() {
        let got = run(
            "",
            [&[b"ab\nc", b"d", b"never"], &[b"ab", b"\ncX", b"never"]],
        );
        assert_eq!(got.out, "one two differ: char 5, line 2\n");
        assert_eq!((got.status, got.pulls), (1, [2, 2]));
        let got = run(r#""print_bytes":true"#, [&[b"a\x81"], &[b"a\t"]]);
        assert_eq!(
            got.out,
            "one two differ: byte 2, line 1 is 201 M-^A  11 ^I\n"
        );
        assert_eq!(run(r#""silent":true"#, [&[b"ab"], &[b"aX"]]).out, "");
    }

    #[test]
    fn the_shorter_input_ends_the_compare_in_cmps_words() {
        for (first, second, said) in [
            (
                &[b"ab".as_slice(), b"\n"][..],
                &[b"a".as_slice(), b"b\nmore"][..],
                "after byte 3, line 1",
            ),
            (&[b"ab", b"c"], &[b"abcd"], "after byte 3, in line 1"),
            (&[], &[b"x"], "which is empty"),
        ] {
            let got = run("", [first, second]);
            assert_eq!((got.out.as_str(), got.status), ("", 1));
            assert_eq!(got.err, format!("cmp: EOF on one {said}\n"));
        }
        let got = run(r#""silent":true"#, [&[b"ab"], &[b"abc"]]);
        assert_eq!((got.err.as_str(), got.status), ("", 1));
        assert_eq!(run("", [&[b"same"], &[b"sa", b"me"]]).status, 0);
    }

    #[test]
    fn skips_and_the_limit_cut_each_input() {
        let got = run(r#""skip":[1,0]"#, [&[b"x", b"hello\n"], &[b"hello\n"]]);
        assert_eq!(got.status, 0);
        let got = run(r#""limit":3"#, [&[b"abcX"], &[b"abcY", b"never"]]);
        assert_eq!((got.status, got.pulls), (0, [1, 1]));
        assert_eq!(run(r#""limit":0"#, [&[b"a"], &[b"b"]]).pulls, [0, 0]);
    }

    #[test]
    fn l_lists_every_difference_padded_to_the_files_lengths() {
        let got = run(
            r#""verbose":true"#,
            [&[b"abcdefghijkl"], &[b"aXcdefghijYlong"]],
        );
        assert_eq!(got.out, " 2 142 130\n11 153 131\n");
        assert_eq!(got.err, "cmp: EOF on one after byte 12\n");
        let got = run(
            r#""verbose":true,"print_bytes":true"#,
            [&[b"a\x81z"], &[b"a\tz"]],
        );
        assert_eq!(got.out, "2 201 M-^A  11 ^I\n");
        let got = run(
            r#""piped":[true,true],"limit":1000,"verbose":true"#,
            [&[b"ab"], &[b"aX"]],
        );
        assert_eq!(got.out, "   2 142 130\n");
        assert_eq!(run(r#""verbose":true"#, [&[b"same"], &[b"same"]]).status, 0);
    }
}
