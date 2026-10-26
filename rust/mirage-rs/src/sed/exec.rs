use std::collections::{HashMap, HashSet, VecDeque};
use std::task::Poll;

use crate::regex::posix::{Posix, Spans};
use crate::request::{Opening, Reply, Request, WriteMode, bytes};

use super::io::{Failure, Feed, Input, Io, LIMIT, Line, LineReader, MAX_LEN, Notes, read_error};
use super::script::{Address, Command, Part, Program, Subst, Translit};
use super::text::{Refusal, convert, list, resolve, unit};

const STDOUT: &[u8] = b"/dev/stdout";
const STDERR: &[u8] = b"/dev/stderr";
/// The failures -i words as the read step.
const READ_FAILURES: [&str; 3] = ["EISDIR", "EFBIG", "EBADF"];
/// The failures -i exits 2 on (4 for a directory), every other 1.
const OPERAND_FAILURES: [&str; 5] = ["ENOENT", "EISDIR", "ENOTDIR", "EFBIG", "ELOOP"];
/// The conditions a line about a failed operand ends in the phrase of.
const OPERAND_CONDITIONS: [&str; 15] = [
    "EBADF",
    "ENOENT",
    "ENOTDIR",
    "EISDIR",
    "ELOOP",
    "EEXIST",
    "EROFS",
    "EACCES",
    "EPERM",
    "ENOTEMPTY",
    "ENOTSUP",
    "EXDEV",
    "EFBIG",
    "EPIPE",
    "STALE_WRITE",
];

/// How a script runs.
pub(super) struct Options {
    /// -n, or `#n`.
    pub(super) quiet: bool,
    /// -s, which -i implies.
    pub(super) separate: bool,
    pub(super) in_place: bool,
    /// -l.
    pub(super) line_length: i64,
    pub(super) utf8: bool,
    /// What a `w` file's name resolves against.
    pub(super) cwd: Vec<u8>,
}

/// Wait on a poll, returning from a step that cannot go on yet.
macro_rules! wait {
    ($poll:expr) => {
        match $poll {
            Poll::Ready(value) => value,
            Poll::Pending => return Ok(Poll::Pending),
        }
    };
}

/// What the append queue holds: text, or an `r` file by its place.
enum Append {
    Text(Vec<u8>),
    File(usize),
}

/// An `r` file on its way to the output.
struct Emit {
    fd: u32,
    file: usize,
    opened: bool,
    /// Whether a byte of it arrived: a failure before one is a file that
    /// does not open, which reads as empty.
    got: bool,
    ended: bool,
    waiting: bool,
    failed: Option<Failure>,
}

/// An `R` file's lines: read whole when the run starts (-s and -i) and
/// then read from where each input's reader is, streamed otherwise.
enum Lines {
    Whole(Vec<Vec<u8>>),
    At(usize),
    Stream(Box<LineReader>),
    Empty,
    Failed(Vec<u8>),
}

/// Where a `w` name writes.
#[derive(Clone, Copy)]
enum Target {
    Stdout,
    Stderr,
    File(usize),
}

/// A file `w` writes. GNU opens each spelling of a file (`w out`,
/// `w ./out`) as its own stream from offset 0, and the first opened is
/// flushed last: its bytes win, and a later spelling's show only past its
/// end. A later spelling's bytes wait in a host spool until the end, when
/// what lies past the spellings before it lands.
struct WFile {
    name: Vec<u8>,
    path: Vec<u8>,
    missing: bool,
    buf: Vec<u8>,
    /// The first spelling of the same file, for a later spelling.
    first: Option<usize>,
    failed: bool,
    spool: Option<u32>,
    /// The bytes this spelling has written, kept or not.
    produced: u64,
    /// What the host has been sent for the file under this name.
    sent: u64,
    writer: bool,
}

enum Phase {
    /// Emptying the `w` files, as GNU opens them when it compiles.
    Open,
    /// Reading each `R` file whole, under -s and -i.
    Snapshot(usize),
    Begin,
    /// -i: opening input `index` before its edit.
    EditOpen(usize),
    Take,
    Cycle,
    /// The cycle ended; what it queued goes out first.
    Ended {
        quit: bool,
    },
    /// -i: committing the edit.
    EditDone {
        index: usize,
        sent: bool,
    },
    Finish {
        sent: bool,
    },
    Done,
}

/// Runs a compiled script over its inputs as GNU sed 4.9 does, a bounded
/// number of steps per call, every file and input a request the host
/// serves.
pub(super) struct Machine {
    commands: Vec<Command>,
    regexes: Vec<Posix>,
    rfiles: Vec<Vec<u8>>,
    reader_files: Vec<Vec<u8>>,
    opts: Options,
    pub(super) io: Io,
    feed: Feed,
    notes: Notes,
    /// Under -i, each input's path.
    paths: Vec<Vec<u8>>,
    pub(super) out: Vec<u8>,
    edit: Vec<u8>,
    edit_path: Option<Vec<u8>>,
    edit_started: bool,
    edit_failed: bool,
    edit_err: Vec<u8>,
    edit_code: i32,
    edit_reader: Option<LineReader>,
    edited: HashSet<Vec<u8>>,
    main_missing: bool,
    stdout_missing: bool,
    err_out: Vec<u8>,
    err_missing: bool,
    targets: Vec<Target>,
    files: Vec<WFile>,
    writers: Vec<usize>,
    deferred: Vec<usize>,
    /// Whether `w` output waits for the end: under -i, and when the script
    /// reads files that may be the ones it writes.
    defer: bool,
    write_err: Vec<u8>,
    ps: Vec<u8>,
    newline: bool,
    hold: Vec<u8>,
    hold_newline: bool,
    line: u64,
    /// Each open range and, for `addr,+N`, the line it ends on.
    ranges: HashMap<usize, u64>,
    /// Line-number ranges that have started, which never start again.
    begun: HashSet<usize>,
    queue: Vec<Append>,
    /// What the queue holds, in bytes.
    queued: usize,
    emitting: VecDeque<Append>,
    emit: Option<Emit>,
    readers: HashMap<usize, Lines>,
    snapshots: Vec<Option<Lines>>,
    snapshot_reader: Option<(LineReader, Vec<Vec<u8>>)>,
    /// What the snapshots hold, in bytes.
    snapshotted: usize,
    replaced: bool,
    source: Option<usize>,
    last_regex: Option<usize>,
    quit: Option<i32>,
    panic: Option<i32>,
    pc: usize,
    /// Whether the command at `pc` took its address and waits to run on.
    applied: bool,
    stage: u8,
    phase: Phase,
    cancelled: bool,
    /// A run that ends before any input: a refused script, or -i
    /// without files.
    refused: Option<Refusal>,
}

/// The expression an address or `s` uses: its own, or for the empty one
/// the last one used.
fn pick(last: &mut Option<usize>, regex: Option<usize>) -> Result<usize, Refusal> {
    match regex {
        Some(index) => {
            *last = Some(index);
            Ok(index)
        }
        None => last.ok_or_else(|| {
            Refusal::new(
                b"sed: -e expression #1, char 0: no previous regular expression\n".to_vec(),
                1,
            )
        }),
    }
}

fn put(buf: &mut Vec<u8>, missing: &mut bool, text: &[u8]) {
    if text.is_empty() {
        return;
    }
    if std::mem::take(missing) {
        buf.push(b'\n');
    }
    buf.extend_from_slice(text);
}

/// A line, or what a line lacked its newline: anything written after it
/// puts that newline first.
fn put_line(buf: &mut Vec<u8>, missing: &mut bool, text: &[u8], newline: bool) {
    if std::mem::take(missing) {
        buf.push(b'\n');
    }
    buf.extend_from_slice(text);
    if newline {
        buf.push(b'\n');
    } else {
        *missing = true;
    }
}

/// The status `q` and `Q` exit with: the low byte of their number, except
/// that -1 exits 0, as sed 4.9 does.
fn quit_code(number: Option<i64>) -> i32 {
    match number {
        None | Some(-1) => 0,
        Some(number) => (number & 0xFF) as i32,
    }
}

/// The replacement for one match, with `\U \L \u \l \E` applied.
fn expand(
    parts: &[Part],
    ps: &[u8],
    groups: &Spans,
    utf8: bool,
    out: &mut Vec<u8>,
) -> Result<(), Refusal> {
    let mut mode: Option<bool> = None;
    let mut pending: Option<bool> = None;
    let mut passed = 0;
    let mut converted = Vec::new();
    for part in parts {
        let text: &[u8] = match part {
            Part::Case(case) => {
                match case {
                    b'u' | b'l' => (pending, passed) = (Some(*case == b'u'), 0),
                    _ => {
                        pending = None;
                        mode = (*case != b'E').then_some(*case == b'U');
                    }
                }
                continue;
            }
            Part::Group(group) => match groups.get(*group).copied().flatten() {
                Some((start, end)) => &ps[start..end],
                None => b"",
            },
            Part::Text(text) => text,
        };
        // A case conversion is measured unit by unit as it grows.
        let text = match mode {
            Some(upper) => {
                converted.clear();
                if !convert(
                    text,
                    upper,
                    utf8,
                    &mut converted,
                    MAX_LEN.saturating_sub(out.len()),
                ) {
                    return Err(exhausted());
                }
                converted.as_slice()
            }
            None => text,
        };
        room(out.len(), text.len())?;
        match pending {
            Some(upper) if !text.is_empty() => {
                let len = unit(text, 0, utf8);
                if !convert(&text[..len], upper, utf8, out, MAX_LEN) {
                    return Err(exhausted());
                }
                room(out.len(), text.len() - len)?;
                out.extend_from_slice(&text[len..]);
                pending = None;
            }
            Some(_) => {
                passed += 1;
                if passed > 1 {
                    pending = None;
                }
            }
            None => out.extend_from_slice(text),
        }
    }
    Ok(())
}

fn exhausted() -> Refusal {
    Refusal::new(b"sed: memory exhausted\n".to_vec(), 1)
}

/// Whether a space of `len` bytes may take `more`.
fn room(len: usize, more: usize) -> Result<(), Refusal> {
    if len.saturating_add(more) > MAX_LEN {
        return Err(exhausted());
    }
    Ok(())
}

/// The pattern space after `s`, None when nothing was replaced. Each
/// match is replaced as it is found, so no list of them is held.
fn substitute(
    regex: &mut Posix,
    subst: &Subst,
    ps: &[u8],
    utf8: bool,
) -> Result<Option<Vec<u8>>, Refusal> {
    let skip = usize::try_from(subst.occurrence - 1).unwrap_or(usize::MAX);
    let (mut seen, mut at, mut replaced) = (0usize, 0, false);
    let mut out = Vec::with_capacity(ps.len());
    let mut failed = None;
    let mut visit = |groups: Spans| {
        seen += 1;
        if seen <= skip {
            return true;
        }
        let (start, end) = groups[0].unwrap_or((at, at));
        let expanded = room(out.len(), start - at).and_then(|()| {
            out.extend_from_slice(&ps[at..start]);
            expand(&subst.parts, ps, &groups, utf8, &mut out)
        });
        if let Err(refusal) = expanded {
            failed = Some(refusal);
            return false;
        }
        at = end;
        replaced = true;
        subst.global
    };
    if subst.global || subst.occurrence > 1 {
        regex.each(ps, &mut visit);
    } else if let Some(groups) = regex.search(ps, 0) {
        visit(groups);
    }
    if let Some(refusal) = failed {
        return Err(refusal);
    }
    if !replaced {
        return Ok(None);
    }
    room(out.len(), ps.len() - at)?;
    out.extend_from_slice(&ps[at..]);
    Ok(Some(out))
}

fn translate(table: &Translit, ps: &mut Vec<u8>, utf8: bool) -> Result<(), Refusal> {
    match table {
        Translit::Bytes(table) => {
            for byte in ps.iter_mut() {
                *byte = table[usize::from(*byte)];
            }
        }
        Translit::Chars(table) => {
            let mut out = Vec::with_capacity(ps.len());
            let mut at = 0;
            while at < ps.len() {
                let len = unit(ps, at, utf8);
                let piece = &ps[at..at + len];
                let mapped = table.get(piece).map_or(piece, Vec::as_slice);
                room(out.len(), mapped.len())?;
                out.extend_from_slice(mapped);
                at += len;
            }
            *ps = out;
        }
    }
    Ok(())
}

fn couldnt(what: &[u8], name: &[u8], text: &[u8]) -> Vec<u8> {
    [
        b"sed: couldn't ".as_slice(),
        what,
        b" ",
        name,
        b": ",
        text,
        b"\n",
    ]
    .concat()
}

/// The line sed gives an operand -i could not read or write, worded as
/// the read step when it is one; `bare` is what follows `sed: ` for a
/// failure no operand condition names.
fn operand_failure(name: &[u8], failure: &Failure, bare: &[u8]) -> Vec<u8> {
    let parts: [&[u8]; 4] = if !failure.names(&OPERAND_CONDITIONS) {
        [b"sed: ", bare, b"", b""]
    } else if name == b"-" {
        [b"sed: -: ", &failure.text, b"", b""]
    } else if failure.names(&READ_FAILURES) {
        return read_error(name, failure);
    } else {
        [b"sed: can't read ", name, b": ", &failure.text]
    };
    [parts.concat(), b"\n".to_vec()].concat()
}

/// The status a failed operand exits with: 2, 4 for a directory, and 1
/// for a failure no operand condition of sed's names.
fn failure_code(failure: &Failure) -> i32 {
    if !failure.names(&OPERAND_FAILURES) {
        1
    } else if failure.names(&["EISDIR"]) {
        4
    } else {
        2
    }
}

impl Machine {
    pub(super) fn new(
        program: Program,
        opts: Options,
        inputs: Vec<Input>,
        paths: Vec<Vec<u8>>,
    ) -> Machine {
        let Program {
            commands,
            regexes,
            wfiles,
            rfiles,
            reader_files,
            quiet,
        } = program;
        let mut files: Vec<WFile> = Vec::new();
        let targets = wfiles
            .into_iter()
            .map(|name| {
                if name == STDOUT {
                    return Target::Stdout;
                }
                if name == STDERR {
                    return Target::Stderr;
                }
                let path = resolve(&name, &opts.cwd);
                let first = files.iter().position(|file| file.path == path);
                files.push(WFile {
                    name,
                    path,
                    missing: false,
                    buf: Vec::new(),
                    first,
                    failed: false,
                    spool: None,
                    produced: 0,
                    sent: 0,
                    writer: false,
                });
                Target::File(files.len() - 1)
            })
            .collect();
        let defer = opts.in_place || !rfiles.is_empty() || !reader_files.is_empty();
        let snapshots = reader_files.iter().map(|_| None).collect();
        let opts = Options {
            quiet: opts.quiet || quiet,
            separate: opts.separate || opts.in_place,
            ..opts
        };
        Machine {
            commands,
            regexes,
            rfiles,
            reader_files,
            opts,
            io: Io::default(),
            feed: Feed::new(inputs),
            notes: Notes::default(),
            paths,
            out: Vec::new(),
            edit: Vec::new(),
            edit_path: None,
            edit_started: false,
            edit_failed: false,
            edit_err: Vec::new(),
            edit_code: 0,
            edit_reader: None,
            edited: HashSet::new(),
            main_missing: false,
            stdout_missing: false,
            err_out: Vec::new(),
            err_missing: false,
            targets,
            files,
            writers: Vec::new(),
            deferred: Vec::new(),
            defer,
            write_err: Vec::new(),
            ps: Vec::new(),
            newline: true,
            hold: Vec::new(),
            hold_newline: true,
            line: 0,
            ranges: HashMap::new(),
            begun: HashSet::new(),
            queue: Vec::new(),
            queued: 0,
            emitting: VecDeque::new(),
            emit: None,
            readers: HashMap::new(),
            snapshots,
            snapshot_reader: None,
            snapshotted: 0,
            replaced: false,
            source: None,
            last_regex: None,
            quit: None,
            panic: None,
            pc: 0,
            applied: false,
            stage: 0,
            phase: Phase::Open,
            cancelled: false,
            refused: None,
        }
    }

    /// A script sed refused: the `w` files opened before the refusal are
    /// emptied, then it reports.
    pub(super) fn refusing(refusal: Refusal, wfiles: Vec<Vec<u8>>, cwd: Vec<u8>) -> Machine {
        let program = Program {
            wfiles,
            ..Program::default()
        };
        let opts = Options {
            quiet: false,
            separate: false,
            in_place: false,
            line_length: 0,
            utf8: false,
            cwd,
        };
        let mut machine = Machine::new(program, opts, Vec::new(), Vec::new());
        let mut message = refusal.message;
        message.push(b'\n');
        machine.refused = Some(Refusal::new(message, refusal.code));
        machine
    }

    pub(super) fn done(&self) -> bool {
        matches!(self.phase, Phase::Done)
    }

    pub(super) fn status(&self) -> i32 {
        if let Some(refused) = &self.refused {
            return refused.code;
        }
        let code = self
            .panic
            .or(self.notes.bad.then_some(2))
            .unwrap_or(self.quit.unwrap_or(0));
        if !self.opts.in_place {
            return if self.write_err.is_empty() { code } else { 4 };
        }
        if let Some(panic) = self.panic {
            return panic;
        }
        if !self.write_err.is_empty() || self.edit_code == 4 {
            return 4;
        }
        if self.edit_code != 0 {
            return self.edit_code;
        }
        code
    }

    /// What sed wrote to stderr: the run's own messages as they come, and
    /// once the run is over the `w` files it could not write. Under -i the
    /// files it could not edit go first, so the rest waits for the end.
    pub(super) fn take_stderr(&mut self, err: &mut Vec<u8>) {
        if !self.done() {
            if !self.opts.in_place {
                err.append(&mut self.notes.stderr);
            }
            return;
        }
        if let Some(refused) = &mut self.refused {
            err.append(&mut refused.message);
            return;
        }
        err.append(&mut self.edit_err);
        err.append(&mut self.notes.stderr);
        err.append(&mut self.write_err);
    }

    /// Stop reading, as when the output closes early: what was written to
    /// the `w` files still lands. Under -i the run goes on, since its
    /// output is the files it edits.
    pub(super) fn cancel(&mut self) -> bool {
        if self.done() {
            return false;
        }
        if !self.opts.in_place {
            self.io
                .requests
                .retain(|request| !matches!(request, Request::Read { .. }));
            self.cancelled = true;
        }
        true
    }

    /// Run up to `budget` steps, stopping early to wait on the host, once
    /// a window of output is ready, or at the end.
    pub(super) fn run(&mut self, budget: usize) {
        let mut steps = 0;
        while self.io.idle() && steps < budget && self.out.len() < LIMIT && !self.done() {
            steps += 1;
            if let Err(refusal) = self.step() {
                self.fail(refusal);
            }
            if self.edit.len() >= LIMIT {
                self.send_edit();
            }
        }
    }

    /// sed stops: the message goes to stderr, the edit in progress is
    /// dropped, and the `w` files are written out.
    fn fail(&mut self, refusal: Refusal) {
        self.notes.stderr.extend_from_slice(&refusal.message);
        self.panic = Some(refusal.code);
        self.emitting.clear();
        self.emit = None;
        if !matches!(self.phase, Phase::Finish { .. }) {
            self.phase = Phase::Finish { sent: false };
        }
    }

    fn step(&mut self) -> Result<(), Refusal> {
        let stopping = self.edit_failed || (self.cancelled && self.refused.is_none());
        if stopping && !matches!(self.phase, Phase::Open | Phase::Finish { .. } | Phase::Done) {
            self.emitting.clear();
            self.emit = None;
            self.phase = Phase::Finish { sent: false };
        }
        if self.emit.is_some() || !self.emitting.is_empty() {
            return self.emit_step();
        }
        match self.phase {
            Phase::Open => self.open_step(),
            Phase::Snapshot(index) => self.snapshot_step(index),
            Phase::Begin => {
                if !self.opts.in_place {
                    self.restart();
                    self.phase = Phase::Take;
                } else if self.feed.inputs.is_empty() {
                    self.refused = Some(Refusal::new(b"sed: no input files\n".to_vec(), 4));
                    self.phase = Phase::Done;
                } else {
                    self.phase = Phase::EditOpen(0);
                }
                Ok(())
            }
            Phase::EditOpen(index) => {
                self.edit_open(index);
                Ok(())
            }
            Phase::Take => {
                match self.take()? {
                    Poll::Pending => {}
                    Poll::Ready(None) => self.end_of_input(),
                    Poll::Ready(Some((text, newline))) => {
                        (self.ps, self.newline) = (text, newline);
                        (self.pc, self.stage, self.applied) = (0, 0, false);
                        self.phase = Phase::Cycle;
                    }
                }
                Ok(())
            }
            Phase::Cycle => self.command(),
            Phase::Ended { quit } => {
                self.boundary();
                if quit {
                    self.end_of_input();
                } else {
                    self.phase = Phase::Take;
                }
                Ok(())
            }
            Phase::EditDone { index, sent } => {
                self.edit_done(index, sent);
                Ok(())
            }
            Phase::Finish { sent } => {
                if sent {
                    self.boundary();
                    self.phase = Phase::Done;
                } else {
                    self.finish();
                    self.phase = Phase::Finish { sent: true };
                }
                Ok(())
            }
            Phase::Done => Ok(()),
        }
    }

    fn open_step(&mut self) -> Result<(), Refusal> {
        if self.stage == 0 {
            self.stage = 1;
            for index in 0..self.files.len() {
                let path = self.files[index].name.clone();
                self.io.push(Request::Write {
                    path,
                    mode: WriteMode::Truncate,
                    data: Vec::new(),
                });
            }
            return Ok(());
        }
        self.stage = 0;
        self.phase = if self.refused.is_some() {
            Phase::Done
        } else if self.opts.separate && !self.reader_files.is_empty() {
            Phase::Snapshot(0)
        } else {
            Phase::Begin
        };
        Ok(())
    }

    /// Read `R` file `index` whole: one that does not open reads as empty,
    /// any other failure is reported when the script gets to it.
    fn snapshot_step(&mut self, index: usize) -> Result<(), Refusal> {
        if index >= self.reader_files.len() {
            self.phase = Phase::Begin;
            return Ok(());
        }
        let (mut reader, mut lines) = match self.snapshot_reader.take() {
            Some(open) => open,
            None => (
                LineReader::new(
                    &mut self.io,
                    self.reader_files[index].clone(),
                    Opening::File,
                ),
                Vec::new(),
            ),
        };
        loop {
            match reader.line(&mut self.io) {
                Poll::Pending => {
                    self.snapshot_reader = Some((reader, lines));
                    return Ok(());
                }
                Poll::Ready(Ok(Some((mut text, newline)))) => {
                    if newline {
                        text.push(b'\n');
                    }
                    room(self.snapshotted, text.len())?;
                    self.snapshotted += text.len();
                    lines.push(text);
                }
                Poll::Ready(Ok(None)) => {
                    self.snapshots[index] = Some(Lines::Whole(lines));
                    break;
                }
                Poll::Ready(Err(failure)) => {
                    self.snapshotted -= lines.iter().map(Vec::len).sum::<usize>();
                    self.snapshots[index] = Some(if failure.unopened() {
                        Lines::Empty
                    } else {
                        Lines::Failed(read_error(&self.reader_files[index], &failure))
                    });
                    break;
                }
            }
        }
        self.phase = Phase::Snapshot(index + 1);
        Ok(())
    }

    /// -i: open input `index`; one that cannot be read is reported and
    /// passed over, and a directory ends the run.
    fn edit_open(&mut self, index: usize) {
        if self.quit.is_some() || self.panic.is_some() || index >= self.feed.inputs.len() {
            self.phase = Phase::Finish { sent: false };
            return;
        }
        let mut reader = match self.edit_reader.take() {
            Some(reader) => reader,
            None => {
                let input = &self.feed.inputs[index];
                LineReader::new(&mut self.io, input.name.clone(), input.opening)
            }
        };
        match reader.peek(&mut self.io) {
            Poll::Pending => self.edit_reader = Some(reader),
            Poll::Ready(Err(failure)) => {
                let name = &self.feed.inputs[index].name;
                if !failure.names(&OPERAND_CONDITIONS) {
                    // A failure that is no operand's own ends the run, as
                    // the edit's write does.
                    let line = operand_failure(name, &failure, &failure.text);
                    self.refused = Some(Refusal::new(line, failure_code(&failure)));
                    self.io.requests.clear();
                    self.phase = Phase::Done;
                    return;
                }
                let line = operand_failure(name, &failure, name);
                self.edit_err.extend_from_slice(&line);
                self.edit_code = self.edit_code.max(failure_code(&failure));
                self.phase = if failure.names(&["EISDIR"]) {
                    Phase::Finish { sent: false }
                } else {
                    Phase::EditOpen(index + 1)
                };
            }
            Poll::Ready(Ok(_)) => {
                let path = self.paths.get(index).cloned().unwrap_or_default();
                self.edited.insert(path.clone());
                self.edit_path = Some(path);
                self.edit_started = false;
                self.edit.clear();
                // The replacement opens before the edit reads on, so a
                // refused one is reported first.
                self.send_edit();
                self.main_missing = false;
                self.source = None;
                self.restart();
                self.feed.only(index, reader);
                self.phase = Phase::Take;
            }
        }
    }

    /// The inputs have ended, or `q` stopped: -i commits the edit.
    fn end_of_input(&mut self) {
        self.phase = match &self.edit_path {
            Some(_) => Phase::EditDone {
                index: self.feed.index.unwrap_or_default(),
                sent: false,
            },
            None => Phase::Finish { sent: false },
        };
    }

    fn send_edit(&mut self) {
        let Some(path) = &self.edit_path else {
            return;
        };
        let mode = if std::mem::replace(&mut self.edit_started, true) {
            WriteMode::Append
        } else {
            WriteMode::Replace
        };
        self.io.push(Request::Write {
            path: path.clone(),
            mode,
            data: std::mem::take(&mut self.edit),
        });
    }

    fn edit_done(&mut self, index: usize, sent: bool) {
        if !sent {
            if !self.edit.is_empty() || !self.edit_started {
                self.send_edit();
            }
            let path = self.edit_path.clone();
            self.io.push(Request::Flush { path });
            self.phase = Phase::EditDone { index, sent: true };
            return;
        }
        self.edit_path = None;
        self.boundary();
        self.phase = if self.quit.is_some() {
            Phase::Finish { sent: false }
        } else {
            Phase::EditOpen(index + 1)
        };
    }

    /// Between cycles: what `w /dev/stderr` wrote joins stderr.
    fn boundary(&mut self) {
        self.notes.stderr.append(&mut self.err_out);
    }

    /// A new input under -s or -i: line numbers, the hold space, ranges
    /// and `R` readers start over.
    fn restart(&mut self) {
        self.line = 0;
        self.hold.clear();
        self.hold_newline = true;
        self.ranges.clear();
        self.begun.clear();
        for (_, lines) in self.readers.drain() {
            if let Lines::Stream(reader) = lines {
                if reader.live() {
                    self.io.push(Request::Close { fd: reader.fd });
                }
            }
        }
        for (index, cmd) in self.commands.iter().enumerate() {
            if cmd.addr1 == Some(Address::Line(0)) && cmd.addr2.is_some() {
                self.ranges.insert(index, 0);
                self.begun.insert(index);
            }
        }
    }

    fn take(&mut self) -> Result<Poll<Option<Line>>, Refusal> {
        let (line, source) = match self.feed.read(&mut self.io, &mut self.notes) {
            Poll::Pending => return Ok(Poll::Pending),
            Poll::Ready(Err(message)) => return Err(Refusal::new(message, 4)),
            Poll::Ready(Ok(None)) => return Ok(Poll::Ready(None)),
            Poll::Ready(Ok(Some(got))) => got,
        };
        if self.source != Some(source) {
            if self.opts.separate && self.source.is_some() {
                self.restart();
            }
            self.source = Some(source);
        }
        self.line += 1;
        self.replaced = false;
        Ok(Poll::Ready(Some(line)))
    }

    fn is_last(&mut self) -> Poll<bool> {
        self.feed
            .more(self.opts.separate, &mut self.io, &mut self.notes)
            .map(|more| !more)
    }

    fn matches(&mut self, addr: Address) -> Result<Poll<bool>, Refusal> {
        let line = self.line;
        Ok(Poll::Ready(match addr {
            // `0r` is the one command line 0 addresses: it runs on the
            // first line, where the script reaches it.
            Address::Line(number) => line == number.max(1),
            Address::Last => wait!(self.is_last()),
            Address::Regex(regex) => {
                let index = pick(&mut self.last_regex, regex)?;
                self.regexes[index].test(&self.ps)
            }
            Address::Step(first, step) => line >= first && (line - first) % step == 0,
            Address::Plus(_) | Address::Multiple(_) => false,
        }))
    }

    fn in_range(
        &mut self,
        index: usize,
        first: Address,
        second: Address,
    ) -> Result<Poll<bool>, Refusal> {
        let line = self.line;
        if let Some(&end) = self.ranges.get(&index) {
            let close = match second {
                Address::Line(number) => {
                    if line >= number {
                        self.ranges.remove(&index);
                        return Ok(Poll::Ready(line == number));
                    }
                    false
                }
                Address::Plus(_) => line >= end,
                Address::Multiple(number) => number == 0 || line % number == 0,
                _ => wait!(self.matches(second)?),
            };
            if close {
                self.ranges.remove(&index);
            }
            return Ok(Poll::Ready(true));
        }
        if let Address::Line(number) = first {
            // A range from a line number starts on the first line at or
            // past it, so one an `n` read over still opens, unless its
            // numbered end has gone by; it starts only once.
            if self.begun.contains(&index) || line < number {
                return Ok(Poll::Ready(false));
            }
            if line > number && matches!(second, Address::Line(end) if line > end) {
                return Ok(Poll::Ready(false));
            }
        } else if !wait!(self.matches(first)?) {
            return Ok(Poll::Ready(false));
        }
        let opens = match second {
            Address::Line(number) => (number > line).then_some(0),
            // Counted in 64 bits, as sed counts, so the end can wrap.
            Address::Plus(number) => (number > 0).then(|| line.wrapping_add(number)),
            Address::Multiple(number) => (number > 0).then_some(0),
            // Unlike `addr1,~N`, a `first~step` end can be the line that
            // opens the range.
            Address::Step(..) | Address::Last => (!wait!(self.matches(second)?)).then_some(0),
            Address::Regex(_) => Some(0),
        };
        if let Some(end) = opens {
            self.ranges.insert(index, end);
        }
        if matches!(first, Address::Line(_)) {
            self.begun.insert(index);
        }
        Ok(Poll::Ready(true))
    }

    fn applies(&mut self, pc: usize) -> Result<Poll<bool>, Refusal> {
        let cmd = &self.commands[pc];
        let (first, second, negate) = (cmd.addr1, cmd.addr2, cmd.negate);
        let Some(first) = first else {
            return Ok(Poll::Ready(!negate));
        };
        let hit = match second {
            None => wait!(self.matches(first)?),
            Some(second) => wait!(self.in_range(pc, first, second)?),
        };
        Ok(Poll::Ready(hit != negate))
    }

    /// Move what was printed to `out`, without a copy when it is empty.
    pub(super) fn hand_on(&mut self, out: &mut Vec<u8>) {
        if out.is_empty() {
            std::mem::swap(out, &mut self.out);
        } else {
            out.append(&mut self.out);
        }
    }

    /// Where the script's own output goes, with room for `len` more bytes:
    /// an edit sends what it holds first rather than grow past a window.
    fn main(&mut self, len: usize) -> &mut Vec<u8> {
        if !self.opts.in_place {
            return &mut self.out;
        }
        if !self.edit.is_empty() && self.edit.len() + len >= LIMIT {
            self.send_edit();
        }
        if self.edit.capacity() == 0 {
            self.edit.reserve_exact(LIMIT.max(len + 1));
        }
        &mut self.edit
    }

    fn print(&mut self, text: &[u8]) {
        let mut missing = std::mem::take(&mut self.main_missing);
        put(self.main(text.len() + 1), &mut missing, text);
        self.main_missing = missing;
    }

    fn print_line(&mut self, text: &[u8], newline: bool) {
        let mut missing = std::mem::take(&mut self.main_missing);
        put_line(self.main(text.len() + 2), &mut missing, text, newline);
        self.main_missing = missing;
    }

    fn write_line(&mut self, target: usize, text: &[u8], newline: bool) -> Result<(), Refusal> {
        match self.targets[target] {
            Target::Stdout => put_line(&mut self.out, &mut self.stdout_missing, text, newline),
            Target::Stderr => {
                room(self.notes.stderr.len() + self.err_out.len(), text.len() + 1)?;
                put_line(&mut self.err_out, &mut self.err_missing, text, newline);
                // A loop that never ends its cycle still hands stderr on.
                if self.err_out.len() >= LIMIT {
                    self.boundary();
                }
            }
            Target::File(file) => {
                let out = &mut self.files[file];
                put_line(&mut out.buf, &mut out.missing, text, newline);
                if out.buf.len() >= LIMIT {
                    self.route(file);
                }
            }
        }
        Ok(())
    }

    /// Queue an append, as long as the queue fits.
    fn enqueue(&mut self, entry: Append) -> Result<(), Refusal> {
        let len = std::mem::size_of::<Append>()
            + match &entry {
                Append::Text(text) => text.len(),
                Append::File(_) => 0,
            };
        room(self.queued, len)?;
        self.queued += len;
        self.queue.push(entry);
        Ok(())
    }

    /// Hand on what a `w` file holds: dropped once the file failed or -i
    /// edited it, spooled by the host until the end for a later spelling or
    /// when output waits, and sent otherwise.
    fn route(&mut self, index: usize) {
        let data = std::mem::take(&mut self.files[index].buf);
        let file = &self.files[index];
        if data.is_empty() || file.failed || self.edited.contains(&file.path) {
            return;
        }
        let later = file.first.is_some();
        self.files[index].produced += data.len() as u64;
        if !later && !self.defer {
            self.send(index, WriteMode::Append, data);
            return;
        }
        let fd = match self.files[index].spool {
            Some(fd) => fd,
            None => {
                let fd = self.io.fd();
                self.files[index].spool = Some(fd);
                if !later {
                    self.deferred.push(index);
                }
                fd
            }
        };
        self.io.push(Request::Spool { fd, data });
    }

    fn send(&mut self, index: usize, mode: WriteMode, data: Vec<u8>) {
        let file = &mut self.files[index];
        file.sent += data.len() as u64;
        if !std::mem::replace(&mut file.writer, true) {
            self.writers.push(index);
        }
        self.io.push(Request::Write {
            path: file.name.clone(),
            mode,
            data,
        });
    }

    /// The end of the run: every `w` file's output goes out, each later
    /// spelling's tail lands past what the spellings before it wrote, and
    /// each file is committed.
    fn finish(&mut self) {
        for index in 0..self.files.len() {
            self.route(index);
        }
        for index in std::mem::take(&mut self.deferred) {
            let file = &self.files[index];
            if let Some(fd) = file.spool.filter(|_| !self.edited.contains(&file.path)) {
                let produced = file.produced;
                self.send(index, WriteMode::Spool { fd, skip: 0 }, Vec::new());
                self.files[index].sent = produced;
            }
        }
        for index in 0..self.files.len() {
            let Some(first) = self.files[index].first else {
                continue;
            };
            let head = &self.files[first];
            if head.failed || self.edited.contains(&head.path) {
                continue;
            }
            let skip = head.sent;
            let file = &self.files[index];
            if let Some(fd) = file.spool.filter(|_| file.produced > skip) {
                let produced = file.produced;
                self.send(first, WriteMode::Spool { fd, skip }, Vec::new());
                self.files[first].sent = produced;
            }
        }
        for &index in &self.writers {
            self.io.push(Request::Flush {
                path: Some(self.files[index].name.clone()),
            });
        }
    }

    /// The next line of an `R` file, its newline kept.
    fn reader_line(&mut self, index: usize) -> Result<Poll<Option<Vec<u8>>>, Refusal> {
        if !self.readers.contains_key(&index) {
            let lines = match self.snapshots[index].as_ref() {
                Some(Lines::Whole(_)) => Lines::At(0),
                Some(Lines::Failed(message)) => return Err(Refusal::new(message.clone(), 4)),
                Some(_) => Lines::Empty,
                None if self.opts.separate => Lines::Empty,
                None => Lines::Stream(Box::new(LineReader::new(
                    &mut self.io,
                    self.reader_files[index].clone(),
                    Opening::File,
                ))),
            };
            self.readers.insert(index, lines);
        }
        let lines = self.readers.get_mut(&index).expect("inserted above");
        let reader = match lines {
            Lines::At(at) => {
                let line = match &self.snapshots[index] {
                    Some(Lines::Whole(whole)) => whole.get(*at).cloned(),
                    _ => None,
                };
                *at += 1;
                return Ok(Poll::Ready(line));
            }
            Lines::Stream(reader) => reader,
            _ => return Ok(Poll::Ready(None)),
        };
        match reader.line(&mut self.io) {
            Poll::Pending => Ok(Poll::Pending),
            Poll::Ready(Ok(Some((mut text, newline)))) => {
                if newline {
                    text.push(b'\n');
                }
                Ok(Poll::Ready(Some(text)))
            }
            Poll::Ready(Ok(None)) => Ok(Poll::Ready(None)),
            Poll::Ready(Err(failure)) => {
                let started = reader.started;
                *lines = Lines::Empty;
                if !failure.unopened() || started {
                    return Err(Refusal::new(
                        read_error(&self.reader_files[index], &failure),
                        4,
                    ));
                }
                Ok(Poll::Ready(None))
            }
        }
    }

    /// Queue what the cycle appended for the output.
    fn dump(&mut self) {
        self.queued = 0;
        self.emitting.extend(self.queue.drain(..));
    }

    /// One step of what goes out from the append queue: text, or an `r`
    /// file streamed through as it arrives.
    fn emit_step(&mut self) -> Result<(), Refusal> {
        let Some(emit) = &mut self.emit else {
            match self.emitting.front() {
                Some(Append::Text(text)) => {
                    let text = text.clone();
                    self.print(&text);
                    self.emitting.pop_front();
                }
                Some(Append::File(file)) => {
                    self.emit = Some(Emit {
                        fd: self.io.fd(),
                        file: *file,
                        opened: false,
                        got: false,
                        ended: false,
                        waiting: false,
                        failed: None,
                    });
                }
                None => {}
            }
            return Ok(());
        };
        if let Some(failure) = emit.failed.take() {
            let name = &self.rfiles[emit.file];
            if emit.got || !failure.unopened() {
                return Err(Refusal::new(read_error(name, &failure), 4));
            }
            emit.ended = true;
        }
        if emit.ended {
            self.emit = None;
            self.emitting.pop_front();
            return Ok(());
        }
        if !std::mem::replace(&mut emit.waiting, true) {
            let open = (!std::mem::replace(&mut emit.opened, true))
                .then(|| (self.rfiles[emit.file].clone(), Opening::File));
            self.io.push(Request::Read {
                fd: emit.fd,
                open,
                least: 0,
            });
        }
        Ok(())
    }

    fn command(&mut self) -> Result<(), Refusal> {
        let pc = self.pc;
        let Some(cmd) = self.commands.get(pc) else {
            if !self.opts.quiet {
                let ps = std::mem::take(&mut self.ps);
                self.print_line(&ps, self.newline);
                self.ps = ps;
            }
            self.dump();
            self.phase = Phase::Ended { quit: false };
            return Ok(());
        };
        let name = cmd.name;
        if !self.applied {
            match self.applies(pc)? {
                Poll::Pending => return Ok(()),
                Poll::Ready(false) => {
                    let cmd = &self.commands[pc];
                    self.pc = if name == b'{' { cmd.target + 1 } else { pc + 1 };
                    return Ok(());
                }
                Poll::Ready(true) => self.applied = true,
            }
        }
        self.pc = pc + 1;
        match self.execute(pc, name)? {
            // It runs again from its stage once the host answers.
            Poll::Pending => self.pc = pc,
            Poll::Ready(()) => (self.applied, self.stage) = (false, 0),
        }
        Ok(())
    }

    /// End the cycle: what it queued goes out, then the next line, or the
    /// end when `quit`.
    fn end_cycle(&mut self, quit: bool) {
        self.dump();
        self.phase = Phase::Ended { quit };
    }

    fn first_line(&self) -> (usize, bool) {
        match memchr::memchr(b'\n', &self.ps) {
            Some(cut) => (cut, true),
            None => (self.ps.len(), self.newline),
        }
    }

    /// Run command `pc`, its address taken; `Pending` to run it again
    /// from `stage` once the host answers.
    fn execute(&mut self, pc: usize, name: u8) -> Result<Poll<()>, Refusal> {
        let printing = !self.opts.quiet;
        match name {
            b'{' | b'}' | b':' => {}
            b'p' => {
                let ps = std::mem::take(&mut self.ps);
                self.print_line(&ps, self.newline);
                self.ps = ps;
            }
            b's' => {
                let subst = self.commands[pc]
                    .subst
                    .as_deref()
                    .expect("s has a substitution");
                let index = pick(&mut self.last_regex, subst.regex)?;
                let regex = &mut self.regexes[index];
                if subst.regex.is_none() {
                    // An empty expression's groups are known only now.
                    let wanted = subst
                        .parts
                        .iter()
                        .filter_map(|part| match part {
                            Part::Group(group) => Some(*group),
                            _ => None,
                        })
                        .max()
                        .unwrap_or(0);
                    if wanted > regex.groups() {
                        return Err(Refusal::new(
                            format!(
                                "sed: -e expression #1, char 0: invalid reference \\{wanted} on `s' command's RHS\n"
                            )
                            .into_bytes(),
                            1,
                        ));
                    }
                }
                if let Some(result) = substitute(regex, subst, &self.ps, self.opts.utf8)? {
                    let (print, wfile) = (subst.print, subst.wfile);
                    self.ps = result;
                    self.replaced = true;
                    let ps = std::mem::take(&mut self.ps);
                    if print {
                        self.print_line(&ps, self.newline);
                    }
                    let written = match wfile {
                        Some(wfile) => self.write_line(wfile, &ps, self.newline),
                        None => Ok(()),
                    };
                    self.ps = ps;
                    written?;
                }
            }
            b'd' => self.end_cycle(false),
            b'D' => match memchr::memchr(b'\n', &self.ps) {
                // The cycle restarts without reading, and the appends wait
                // for the line it ends on.
                Some(cut) => {
                    self.ps.drain(..=cut);
                    self.boundary();
                    self.pc = 0;
                }
                None => self.end_cycle(false),
            },
            b'b' | b't' | b'T' => {
                let jump = match name {
                    b'b' => true,
                    b't' => std::mem::take(&mut self.replaced),
                    _ => !std::mem::take(&mut self.replaced),
                };
                if jump {
                    self.pc = self.commands[pc].target;
                }
            }
            b'n' => {
                if self.stage == 0 {
                    // GNU prints and appends whether or not a line follows.
                    if printing {
                        let ps = std::mem::take(&mut self.ps);
                        self.print_line(&ps, self.newline);
                        self.ps = ps;
                    }
                    self.dump();
                    self.stage = 1;
                    return Ok(Poll::Pending);
                }
                if !wait!(self.next_line(false)?) {
                    self.phase = Phase::Ended { quit: false };
                }
            }
            b'N' => {
                if self.stage == 0 {
                    if wait!(self.is_last()) {
                        self.pc = self.commands.len();
                        return Ok(Poll::Ready(()));
                    }
                    self.dump();
                    self.stage = 1;
                    return Ok(Poll::Pending);
                }
                if !wait!(self.next_line(true)?) {
                    self.pc = self.commands.len();
                    return Ok(Poll::Ready(()));
                }
            }
            b'a' => {
                if let Some(text) = &self.commands[pc].text {
                    let text = text.clone();
                    self.enqueue(Append::Text(text))?;
                }
            }
            b'i' => {
                if let Some(text) = self.commands[pc].text.clone() {
                    self.print(&text);
                }
            }
            b'c' => {
                let cmd = &self.commands[pc];
                let ranged = cmd.addr2.is_some() && !cmd.negate;
                if !ranged || !self.ranges.contains_key(&pc) {
                    if let Some(text) = cmd.text.clone() {
                        self.print(&text);
                    }
                }
                self.end_cycle(false);
            }
            b'=' => {
                let text = format!("{}\n", self.line);
                self.print(text.as_bytes());
            }
            b'L' => {
                return Err(Refusal::new(
                    b"sed: INTERNAL ERROR: Bad cmd L\n".to_vec(),
                    4,
                ));
            }
            b'l' => {
                let width = self.commands[pc].number.unwrap_or(self.opts.line_length);
                let text = list(&self.ps, width, MAX_LEN).ok_or_else(exhausted)?;
                self.print(&text);
            }
            b'q' => {
                // `q` ends what it prints with a newline the input lacked.
                if printing {
                    let ps = std::mem::take(&mut self.ps);
                    self.print_line(&ps, true);
                    self.ps = ps;
                }
                self.quit = Some(quit_code(self.commands[pc].number));
                self.end_cycle(true);
            }
            b'Q' => {
                self.queue.clear();
                self.queued = 0;
                self.quit = Some(quit_code(self.commands[pc].number));
                self.end_cycle(true);
            }
            b'r' => {
                let cmd = &self.commands[pc];
                if !cmd.zero_line() {
                    let file = cmd.file;
                    self.enqueue(Append::File(file))?;
                } else if self.stage == 0 {
                    // `0r` writes its file where it runs, ahead of the line.
                    self.emitting.push_back(Append::File(cmd.file));
                    self.stage = 1;
                    return Ok(Poll::Pending);
                }
            }
            b'R' => {
                let file = self.commands[pc].file;
                if let Some(text) = wait!(self.reader_line(file)?) {
                    self.enqueue(Append::Text(text))?;
                }
            }
            b'w' => {
                let ps = std::mem::take(&mut self.ps);
                let written = self.write_line(self.commands[pc].file, &ps, self.newline);
                self.ps = ps;
                written?;
            }
            b'W' | b'P' => {
                let (cut, newline) = self.first_line();
                let ps = std::mem::take(&mut self.ps);
                let written = if name == b'W' {
                    self.write_line(self.commands[pc].file, &ps[..cut], newline)
                } else {
                    self.print_line(&ps[..cut], newline);
                    Ok(())
                };
                self.ps = ps;
                written?;
            }
            b'h' => {
                self.hold.clone_from(&self.ps);
                self.hold_newline = self.newline;
            }
            b'H' => {
                room(self.hold.len(), 1 + self.ps.len())?;
                self.hold.push(b'\n');
                self.hold.extend_from_slice(&self.ps);
                self.hold_newline = self.newline;
            }
            b'g' => {
                self.ps.clone_from(&self.hold);
                self.newline = self.hold_newline;
            }
            b'G' => {
                room(self.ps.len(), 1 + self.hold.len())?;
                self.ps.push(b'\n');
                self.ps.extend_from_slice(&self.hold);
                self.newline = self.hold_newline;
            }
            b'x' => {
                std::mem::swap(&mut self.ps, &mut self.hold);
                std::mem::swap(&mut self.newline, &mut self.hold_newline);
            }
            b'y' => {
                let table = self.commands[pc].translit.as_ref().expect("y has a table");
                translate(table, &mut self.ps, self.opts.utf8)?;
            }
            b'z' => self.ps.clear(),
            b'F' => {
                // The input opened last, which a look-ahead may have moved
                // past the line's own.
                let mut text = self.feed.name().to_vec();
                text.push(b'\n');
                self.print(&text);
            }
            _ => {}
        }
        Ok(Poll::Ready(()))
    }

    /// `n` and `N` past their first stage: whether a line follows, and if
    /// so read it in, appended after a newline when `append`.
    fn next_line(&mut self, append: bool) -> Result<Poll<bool>, Refusal> {
        if self.stage == 1 {
            if !append
                && !wait!(
                    self.feed
                        .more(self.opts.separate, &mut self.io, &mut self.notes)
                )
            {
                return Ok(Poll::Ready(false));
            }
            self.stage = 2;
        }
        let Some((text, newline)) = wait!(self.take()?) else {
            return Ok(Poll::Ready(false));
        };
        if append {
            room(self.ps.len(), 1 + text.len())?;
            self.ps.push(b'\n');
            self.ps.extend_from_slice(&text);
        } else {
            self.ps = text;
        }
        self.newline = newline;
        Ok(Poll::Ready(true))
    }

    /// Take the host's answer to the request in flight.
    pub(super) fn answer(&mut self, reply: &[u8], data: &[u8]) -> Result<(), String> {
        let reply = Reply::decode(reply)?;
        let Some(request) = self.io.in_flight.take() else {
            return Err("no request is waiting".into());
        };
        if let Some(fatal) = &reply.fatal {
            self.notes.stderr.extend_from_slice(b"sed: ");
            self.notes.stderr.extend_from_slice(&bytes(fatal));
            self.notes.stderr.push(b'\n');
            self.panic = Some(4);
            self.io.requests.clear();
            self.phase = Phase::Done;
            return Ok(());
        }
        match request {
            Request::Read { fd, .. } => self.answer_read(fd, reply, data),
            Request::Write { path, .. } | Request::Flush { path: Some(path) } => {
                let Some(error) = &reply.error else {
                    return Ok(());
                };
                let text = bytes(error);
                if self.edit_path.as_ref() == Some(&path) {
                    if !std::mem::replace(&mut self.edit_failed, true) {
                        let name = &self.feed.inputs[self.feed.index.unwrap_or_default()].name;
                        let failure = Failure::from(reply);
                        if failure.names(&["STALE_WRITE"]) {
                            self.edit_err
                                .extend_from_slice(&couldnt(b"edit", name, &text));
                            self.edit_code = 4;
                        } else {
                            // Any other failure to write the edit ends the
                            // run there, nothing else committed.
                            let line = operand_failure(name, &failure, &text);
                            self.refused = Some(Refusal::new(line, failure_code(&failure)));
                            self.io.requests.clear();
                            self.phase = Phase::Done;
                        }
                    }
                    return Ok(());
                }
                let opening = matches!(self.phase, Phase::Open);
                let Some(file) = self.files.iter_mut().find(|file| file.name == path) else {
                    return Ok(());
                };
                let message = couldnt(b"open file", &file.name, &text);
                if opening {
                    self.io.requests.clear();
                    self.refused = Some(Refusal::new(message, 4));
                } else if !std::mem::replace(&mut file.failed, true) {
                    self.write_err.extend_from_slice(&message);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn answer_read(&mut self, fd: u32, reply: Reply, data: &[u8]) {
        if let Some(emit) = self.emit.as_mut().filter(|emit| emit.fd == fd) {
            emit.waiting = false;
            if reply.error.is_some() {
                emit.failed = Some(Failure::from(reply));
            } else if reply.end {
                emit.ended = true;
            } else if !data.is_empty() {
                if std::mem::replace(&mut emit.got, true) {
                    self.main(data.len()).extend_from_slice(data);
                } else {
                    self.print(data);
                }
            }
            return;
        }
        let reader = [
            self.feed.reader.as_mut(),
            self.edit_reader.as_mut(),
            self.snapshot_reader.as_mut().map(|(reader, _)| reader),
        ]
        .into_iter()
        .flatten()
        .find(|reader| reader.fd == fd);
        if let Some(reader) = reader {
            reader.answer(reply, data);
            return;
        }
        for lines in self.readers.values_mut() {
            if let Lines::Stream(reader) = lines {
                if reader.fd == fd {
                    reader.answer(reply, data);
                    return;
                }
            }
        }
    }
}
