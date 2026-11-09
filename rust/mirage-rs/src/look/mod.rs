mod options;

use memchr::memchr;
use serde::Deserialize;

use crate::request::{Io, Opening, Reply, Request, read_failure};
use crate::{Stream, StreamError, parse_config};

/// The most a probe reads at once looking for the line it tests.
const PROBE: u64 = 4096;
/// The most of the file's start the first, plain read takes before it asks
/// the file's length: a file that ends within it is searched in memory.
const HEAD: u64 = 8 << 20;
/// The span the search reads whole and goes on in from memory once it is
/// down to this much, which costs less to read than its probes' round trips.
const HOLD: u64 = 1 << 20;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// The prefix and the files as typed, globs spread, each one character
    /// per byte.
    #[serde(deserialize_with = "crate::latin1_list")]
    operands: Vec<Vec<u8>>,
    fold: bool,
    /// -d: only letters, digits and blanks take part in the comparison.
    #[serde(default)]
    alphanum: bool,
    /// -t: the prefix ends just after the first of this character.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    terminate: Option<Vec<u8>>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config {
        operands,
        fold,
        alphanum,
        terminate,
    } = parse_config(config)?;
    let mut prefix = options::prefix(&operands)?.to_vec();
    if let Some(&stop) = terminate.as_deref().and_then(<[u8]>::first) {
        if let Some(at) = prefix.iter().position(|&b| b == stop) {
            prefix.truncate(at + 1);
        }
    }
    if alphanum {
        prefix.retain(|&b| compared(b));
    }
    let mut look = Look {
        prefix,
        fold,
        alphanum,
        name: operands.get(1).cloned().unwrap_or_else(|| b"-".to_vec()),
        io: Io::default(),
        stage: Stage::Scan,
        fd: 0,
        open: None,
        hosted: false,
        ended: true,
        length: None,
        front: 0,
        back: 0,
        at: 0,
        line: None,
        matched: 0,
        order: None,
        head: Vec::new(),
        held_at: 0,
        held: Vec::new(),
        found: false,
        stderr: Vec::new(),
    };
    if operands.len() > 1 {
        look.stage = Stage::Hold;
        look.read(Opening::Operand(1));
    } else {
        look.read(Opening::Name);
    }
    Ok(Box::new(look))
}

/// Whether -d compares this byte: a letter, a digit or a blank.
fn compared(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b' ' || byte == b'\t'
}

/// Where a line stands against the prefix: before it in the file's order,
/// starting with it, or past it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Order {
    Below,
    Match,
    Above,
}

#[derive(PartialEq, Eq)]
enum Stage {
    /// Reading a span of the file whole, the first time its start.
    Hold,
    /// The file's start did not end it: its length is asked for.
    Size,
    /// Reading from the middle of `front..back` to the first line that
    /// starts there.
    Probe,
    /// Reading the lines from `front` on.
    Scan,
    Done,
}

/// util-linux 2.41 look: on a file whose length the host knows, a binary
/// search over byte offsets, each probe testing the first line that starts
/// past the middle of what is left, then the lines from where it ends,
/// written while they start with the prefix and given up at the first that
/// sorts past it. Bytes compare unsigned, under `fold` ASCII letters as
/// lowercase, under `alphanum` skipping what -d does not compare. Standard
/// input, or a file whose length is unknown, is scanned from its start.
struct Look {
    prefix: Vec<u8>,
    fold: bool,
    alphanum: bool,
    /// The file as typed, or `-` for standard input.
    name: Vec<u8>,
    io: Io,
    stage: Stage,
    fd: u32,
    /// What the next read opens.
    open: Option<(Vec<u8>, Opening)>,
    /// The host holds the input being read open.
    hosted: bool,
    /// The input being read has ended, or none is open.
    ended: bool,
    /// The file's length, once the host has said it.
    length: Option<u64>,
    front: u64,
    back: u64,
    /// Where the next byte a probe reads stands in the file.
    at: u64,
    /// Where the line a probe tests starts, once it found one.
    line: Option<u64>,
    /// How much of the prefix the current line has matched.
    matched: usize,
    /// What the current line of a scan was found to be.
    order: Option<Order>,
    /// The start of the current line of a scan, while it is undecided.
    head: Vec<u8>,
    /// A span of the file read whole, from `held_at`: a read that starts in
    /// it is answered from here, and only what it asks past it goes to the
    /// host.
    held_at: u64,
    held: Vec<u8>,
    found: bool,
    stderr: Vec<u8>,
}

impl Look {
    fn key(&self, byte: u8) -> u8 {
        if self.fold {
            byte.to_ascii_lowercase()
        } else {
            byte
        }
    }

    /// Compare the next bytes of the current line, none of them its end:
    /// the line's order once they decide it.
    fn compare(&mut self, bytes: &[u8]) -> Option<Order> {
        for &byte in bytes {
            if self.matched == self.prefix.len() {
                return Some(Order::Match);
            }
            if self.alphanum && !compared(byte) {
                continue;
            }
            let (got, want) = (self.key(byte), self.key(self.prefix[self.matched]));
            if got != want {
                return Some(if got < want {
                    Order::Below
                } else {
                    Order::Above
                });
            }
            self.matched += 1;
        }
        (self.matched == self.prefix.len()).then_some(Order::Match)
    }

    /// Start a read of the input.
    fn read(&mut self, opening: Opening) {
        self.fd = self.io.fd();
        self.open = Some((self.name.clone(), opening));
        self.ended = false;
    }

    /// Let go of the input being read.
    fn close(&mut self) {
        if self.hosted {
            self.io.push(Request::Close { fd: self.fd });
            self.hosted = false;
        }
        self.ended = true;
    }

    fn held_end(&self) -> u64 {
        self.held_at + self.held.len() as u64
    }

    /// Probe the middle of `front..back`, holding the span first once it is
    /// short, or scan from `front` once no line starts past the middle.
    fn halve(&mut self) {
        let middle = self.front + (self.back - self.front) / 2;
        if middle >= self.back {
            return self.scan_from();
        }
        let span = self.back - self.front;
        if span <= HOLD && (self.front < self.held_at || self.back > self.held_end()) {
            self.stage = Stage::Hold;
            self.held.clear();
            self.held_at = self.front;
            return self.read(Opening::Range(1, self.front, Some(span)));
        }
        self.stage = Stage::Probe;
        self.at = middle;
        self.line = None;
        self.matched = 0;
        self.read(Opening::Range(
            1,
            middle,
            Some(PROBE.min(self.back - middle)),
        ));
    }

    fn scan_from(&mut self) {
        if self.length.is_some_and(|length| self.front >= length) {
            self.stage = Stage::Done;
            return;
        }
        self.stage = Stage::Scan;
        self.read(Opening::Range(1, self.front, None));
    }

    /// Read on in a probe: past the line the middle falls in, then the
    /// line after it, up to `back`.
    fn probe(&mut self, mut data: &[u8]) {
        if self.line.is_none() {
            match memchr(b'\n', data) {
                Some(at) => {
                    let start = self.at + at as u64 + 1;
                    if start >= self.back {
                        self.close();
                        return self.scan_from();
                    }
                    self.line = Some(start);
                    self.at = start;
                    data = &data[at + 1..];
                }
                None => self.at += data.len() as u64,
            }
        }
        let Some(start) = self.line else {
            return self.next_probe(None);
        };
        let end = memchr(b'\n', data);
        let order = self.compare(&data[..end.unwrap_or(data.len())]);
        self.at += data.len() as u64;
        // A line that ends undecided is shorter than the prefix.
        let line_ended = end.is_some() || self.at >= self.back;
        let order = order.or(line_ended.then_some(Order::Below));
        let Some(order) = order else {
            return self.next_probe(Some(start));
        };
        self.close();
        if order == Order::Below {
            self.front = start;
        } else {
            self.back = start;
        }
        self.halve();
    }

    /// A probe's read has run out undecided: read on from where it ended,
    /// or, past `back`, no line starts in what is left.
    fn next_probe(&mut self, line: Option<u64>) {
        if !self.ended {
            return;
        }
        if self.at >= self.back {
            return self.scan_from();
        }
        self.read(Opening::Range(
            1,
            self.at,
            Some(PROBE.min(self.back - self.at)),
        ));
        self.line = line;
    }

    /// Read on in a scan: each line skipped while it sorts before the
    /// prefix, written while it starts with it, and the scan given up at
    /// the first past it.
    fn scan(&mut self, mut data: &[u8], out: &mut Vec<u8>) {
        while !data.is_empty() && self.stage == Stage::Scan {
            let end = memchr(b'\n', data);
            let line = &data[..end.map_or(data.len(), |at| at + 1)];
            data = &data[line.len()..];
            if self.order.is_none() {
                let order = self.compare(&line[..line.len() - usize::from(end.is_some())]);
                let order = order.or(end.is_some().then_some(Order::Below));
                match order {
                    Some(Order::Match) => {
                        self.found = true;
                        out.append(&mut self.head);
                    }
                    Some(Order::Above) => self.stage = Stage::Done,
                    Some(Order::Below) if self.found => self.stage = Stage::Done,
                    Some(Order::Below) => {}
                    None => self.head.extend_from_slice(line),
                }
                if self.stage == Stage::Done {
                    break;
                }
                self.order = order;
            }
            if self.order == Some(Order::Match) {
                out.extend_from_slice(line);
            }
            if end.is_some() {
                self.order = None;
                self.matched = 0;
                self.head.clear();
            }
        }
        if self.stage == Stage::Done || self.ended {
            self.close();
            self.stage = Stage::Done;
        }
    }
}

impl Stream for Look {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("look reads its input through requests"))
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn status(&self) -> i32 {
        i32::from(!self.found)
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }

    fn busy(&self) -> bool {
        let Some((_, Opening::Range(_, skip, _))) = &self.open else {
            return false;
        };
        matches!(self.stage, Stage::Probe | Stage::Scan)
            && *skip >= self.held_at
            && *skip < self.held_end()
    }

    /// Answer the read asked for from the span held, leaving what it asks
    /// past the span to the host.
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let Some((name, Opening::Range(operand, skip, size))) = self.open.take() else {
            return Ok(());
        };
        let from = usize::try_from(skip - self.held_at).unwrap_or(usize::MAX);
        let to = size
            .and_then(|size| usize::try_from(size).ok())
            .map_or(self.held.len(), |size| {
                from.saturating_add(size).min(self.held.len())
            });
        let rest = size.map(|size| size - (to - from) as u64);
        let past = self.held_end();
        self.ended = rest == Some(0) || self.length.is_none_or(|length| past >= length);
        let data = self.held[from..to].to_vec();
        match self.stage {
            Stage::Probe => self.probe(&data),
            _ => self.scan(&data, out),
        }
        if !self.ended && self.open.is_none() {
            self.open = Some((name, Opening::Range(operand, past, rest)));
        }
        Ok(())
    }

    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        if self.io.idle() && !self.busy() && self.stage != Stage::Done && !self.ended {
            let open = self.open.take();
            self.hosted |= open.is_some();
            self.io.push(Request::Read {
                fd: self.fd,
                open,
                least: if self.length.is_none() && self.stage == Stage::Hold {
                    HOLD
                } else {
                    0
                },
            });
        }
        self.io.take(data)
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let Some(request) = self.io.in_flight.take() else {
            return Err(StreamError::new("no request is waiting"));
        };
        let reply = Reply::decode(reply).map_err(StreamError::new)?;
        if let Some(fatal) = reply.fatal {
            return Err(StreamError::new(fatal));
        }
        if !matches!(request, Request::Read { .. }) {
            return Ok(());
        }
        self.ended = reply.end || reply.error.is_some();
        self.hosted &= !self.ended;
        if reply.error.is_some() {
            self.stderr
                .extend(read_failure(b"look", &self.name, &reply));
            self.found = false;
            self.stage = Stage::Done;
            return Ok(());
        }
        match self.stage {
            Stage::Hold => {
                self.held.extend_from_slice(data);
                let held = self.held.len() as u64;
                if self.length.is_none() && self.ended {
                    self.length = Some(held);
                    self.back = held;
                }
                if self.length.is_none() && held >= HEAD {
                    self.close();
                    self.stage = Stage::Size;
                    self.read(Opening::Range(1, 0, Some(0)));
                } else if self.ended {
                    self.halve();
                }
            }
            Stage::Size if reply.skipped.is_some() => {
                self.length = Some(reply.size);
                self.back = reply.size;
                self.halve();
            }
            // A host that cannot range the file reads it from its start.
            Stage::Size => {
                self.held.clear();
                self.stage = Stage::Scan;
                self.scan(data, out);
            }
            Stage::Probe => self.probe(data),
            Stage::Scan => self.scan(data, out),
            Stage::Done => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::host::{Fault, Host};
    use crate::open;

    const WORDS: &str = "a b\nab\na-b c\nab-c\nabc\nabz\nb x\n";

    /// look over `file` as a file the host can range, then as standard
    /// input, read `chunk` bytes at a time: its output, its status and the
    /// bytes the host sent.
    fn look(config: serde_json::Value, file: &str, chunk: usize) -> [(String, i32, usize); 2] {
        let mut runs = Vec::new();
        for (files, stdin, operands) in [
            (vec![("f", file)], "", json!([config["prefix"], "f"])),
            (vec![], file, json!([config["prefix"]])),
        ] {
            let mut config = config.clone();
            config["operands"] = operands;
            config.as_object_mut().expect("an object").remove("prefix");
            let mut stream = open("look", config.to_string().as_bytes()).expect("opens");
            let mut host = Host::with(&files, stdin);
            host.chunk = Some(chunk);
            let status = host.drive(stream.as_mut());
            runs.push((
                String::from_utf8_lossy(&host.out).into_owned(),
                status,
                host.sent,
            ));
        }
        [runs[0].clone(), runs[1].clone()]
    }

    fn found(config: serde_json::Value, file: &str) -> String {
        let [file_run, stdin_run] = look(config, file, 3);
        assert_eq!(file_run.0, stdin_run.0);
        file_run.0
    }

    #[test]
    fn alphanum_compares_letters_digits_and_blanks_only() {
        let config = |prefix| json!({"prefix": prefix, "fold": false, "alphanum": true});
        assert_eq!(found(config("a-b"), WORDS), "ab\na-b c\nab-c\nabc\nabz\n");
        assert_eq!(found(config("a b"), WORDS), "a b\n");
    }

    #[test]
    fn terminate_ends_the_prefix_before_alphanum_reads_it() {
        let config = |prefix, alphanum, stop| json!({"prefix": prefix, "fold": false, "alphanum": alphanum, "terminate": stop});
        assert_eq!(found(config("ab-zz", false, "-"), WORDS), "ab-c\n");
        assert_eq!(
            found(config("a-bz", true, "-"), WORDS),
            "a b\nab\na-b c\nab-c\nabc\nabz\n"
        );
        // WORDS is unsorted past `ab`, so the search keeps the later half.
        let [file, stdin] = look(config("ab", false, "xy"), WORDS, 3);
        assert_eq!(
            (file.0.as_str(), stdin.0.as_str()),
            ("ab-c\nabc\nabz\n", "ab\n")
        );
    }

    #[test]
    fn a_file_is_searched_where_standard_input_is_scanned() {
        // Unsorted, so the halves a search keeps decide what it finds.
        let config = |prefix| json!({"prefix": prefix, "fold": false});
        let [file, stdin] = look(config("b"), "a1\na2\nb1\na3\nb2\nc\nd\ne\nf\ng\nh\n", 3);
        assert_eq!((file.0.as_str(), file.1), ("b2\n", 0));
        assert_eq!((stdin.0.as_str(), stdin.1), ("b1\n", 0));
        let [file, stdin] = look(config("a"), "b\na\nab\nc\n", 3);
        assert_eq!((file.0.as_str(), file.1), ("", 1));
        assert_eq!((stdin.0.as_str(), stdin.1), ("", 1));
        // Folded letters sort as lowercase, past `_`.
        let folded = json!({"prefix": "_", "fold": true});
        assert_eq!(found(folded, "_x\nZx\nax\n"), "_x\n");
    }

    #[test]
    fn a_read_that_fails_after_a_match_fails_the_run() {
        // The run passes the 8 MiB the search holds, then its read fails.
        let words = "a\n".repeat(9 << 20);
        let config = json!({"operands": ["a", "f"], "fold": false});
        let mut stream = open("look", config.to_string().as_bytes()).expect("opens");
        let mut host = Host::with(&[("f", &words)], "");
        host.chunk = Some(1 << 16);
        host.faults.insert(
            "f".to_owned(),
            Fault {
                after: 9 << 20,
                errno: "EIO",
                text: "Input/output error",
            },
        );
        assert_eq!(host.drive(stream.as_mut()), 1);
        assert!(!host.out.is_empty());
        assert_eq!(
            String::from_utf8_lossy(&host.err),
            "look: f: Input/output error\n"
        );
    }

    #[test]
    fn a_search_reads_the_lines_it_tests_and_the_run_it_writes() {
        let words: String = (0..4_000_000).map(|n| format!("{n:08}\n")).collect();
        let config = json!({"prefix": "0399999", "fold": false});
        let [file, stdin] = look(config, &words, 1 << 16);
        let run: String = (3_999_990..4_000_000)
            .map(|n| format!("{n:08}\n"))
            .collect();
        assert_eq!(
            (file.0.as_str(), stdin.0.as_str()),
            (run.as_str(), run.as_str())
        );
        assert!(file.2 < 12 << 20, "searched {} bytes", file.2);
        assert!(stdin.2 > 30 << 20, "scanned {} bytes", stdin.2);
    }
}
