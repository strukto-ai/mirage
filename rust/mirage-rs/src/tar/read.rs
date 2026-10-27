//! `-t` and `-x`: the archive read a block at a time as GNU tar reads it.
//! A zero block ends it, and a second one is looked for after it; a block
//! that is no header is skipped past, with one line per run of them, to the
//! next header; a member whose data runs out ends it. Meta headers (GNU long
//! names, pax records) shape the member after them.

use std::collections::HashSet;

use serde::Deserialize;

use super::header::{self, BLOCK, Block, Kind, Member, Pax, Rows, padding};
use super::{
    Codec, Config, FAILED, FATAL, Mode, TRAILER, WINDOW, escaped, lines, open_failure, read,
};
use crate::Stream;
use crate::request::{Opening, Reply};
use crate::task::{File, Host};

/// The archive's input.
const ARCHIVE: u32 = 1;
/// The most a codec stream takes a feed.
const FEED: usize = 16 * 1024;
const NOT_TAR: &str = "tar: This does not look like a tar archive";
const SKIPPING: &str = "tar: Skipping to next header";
const UNEXPECTED_EOF: &str = "tar: Unexpected EOF in archive";
/// What a sparse member's holes are written from.
static ZEROS: [u8; WINDOW] = [0; WINDOW];

/// A compressor's failure as its stream reports it.
#[derive(Deserialize)]
struct Failure {
    reasons: Vec<String>,
    exit_code: i32,
}

impl Failure {
    /// The compressor's lines, its input named as stdin.
    fn lines(&self) -> Vec<u8> {
        self.reasons
            .iter()
            .flat_map(|reason| format!("{}\n", reason.replace("{}", "stdin")).into_bytes())
            .collect()
    }
}

/// The archive's bytes as the host sends them.
struct Raw<'h> {
    host: &'h Host,
    open: Option<(Vec<u8>, Opening)>,
    data: Vec<u8>,
    used: usize,
    ended: bool,
    /// The host's failure to read the archive.
    error: Option<Reply>,
}

impl Raw<'_> {
    fn unused(&self) -> &[u8] {
        &self.data[self.used..]
    }

    /// Read on until `want` bytes are unused or the input ends.
    async fn gather(&mut self, want: usize) {
        if self.used > 0 && self.used * 2 >= self.data.len() {
            self.data.drain(..self.used);
            self.used = 0;
        }
        while !self.ended && self.unused().len() < want {
            match read(self.host, ARCHIVE, self.open.take()).await {
                Ok((data, end)) => {
                    if self.data.is_empty() {
                        self.data = data;
                    } else {
                        self.data.extend_from_slice(&data);
                    }
                    self.ended = end;
                }
                Err(reply) => {
                    self.error = Some(*reply);
                    self.ended = true;
                }
            }
        }
    }
}

/// The archive's bytes as tar reads them, decoded when compressed.
struct Input<'h> {
    raw: Raw<'h>,
    codec: Option<Box<dyn Stream>>,
    finished: bool,
    buf: Vec<u8>,
    at: usize,
    /// The blocks read so far.
    taken: u64,
    failure: Option<Failure>,
}

impl Input<'_> {
    fn held(&self) -> usize {
        self.buf.len() - self.at
    }

    /// Bring more bytes into `buf`; false at the end of the input.
    async fn more(&mut self) -> bool {
        if self.at > 0 && self.at * 2 >= self.buf.len() {
            self.buf.drain(..self.at);
            self.at = 0;
        }
        let Some(codec) = self.codec.as_mut() else {
            self.raw.gather(1).await;
            if self.raw.unused().is_empty() {
                return false;
            }
            if self.held() == 0 && self.raw.used == 0 {
                std::mem::swap(&mut self.buf, &mut self.raw.data);
                self.at = 0;
                self.raw.data.clear();
            } else {
                self.buf.extend_from_slice(self.raw.unused());
                self.raw.used = self.raw.data.len();
            }
            return true;
        };
        let before = self.buf.len();
        while self.buf.len() == before && self.failure.is_none() {
            if codec.busy() {
                codec.drain(&mut self.buf).expect("a codec drains");
            } else if !self.raw.unused().is_empty() {
                let take = self.raw.unused().len().min(FEED);
                let used = self.raw.used;
                codec
                    .feed(&self.raw.data[used..used + take], &mut self.buf)
                    .expect("a codec takes a bounded feed");
                self.raw.used += take;
            } else if !self.raw.ended {
                self.raw.gather(1).await;
            } else if !std::mem::replace(&mut self.finished, true) {
                codec.finish(&mut self.buf).expect("a codec finishes");
            } else {
                break;
            }
            if codec.status() != 0 {
                let mut report = Vec::new();
                codec.take_stderr(&mut report);
                self.failure =
                    Some(serde_json::from_slice(&report).expect("a codec reports its failure"));
            }
        }
        self.buf.len() > before
    }

    /// Whether `n` bytes are held, reading on until they are.
    async fn fill(&mut self, n: usize) -> bool {
        while self.held() < n {
            if !self.more().await {
                return false;
            }
        }
        true
    }

    /// The next whole block; none at the end of the input.
    async fn block(&mut self) -> Option<Vec<u8>> {
        if !self.fill(BLOCK).await {
            return None;
        }
        self.at += BLOCK;
        self.taken += 1;
        Some(self.buf[self.at - BLOCK..self.at].to_vec())
    }

    /// A member's `size` bytes of data and the rest of its last block, as
    /// many whole blocks at a time as are at hand, each handed to `sink`,
    /// through `holes` for a sparse member; false when the input ends
    /// first, after the whole blocks it held.
    async fn copy(
        &mut self,
        size: u64,
        sink: &mut Sink<'_>,
        mut holes: Option<&mut Holes>,
    ) -> bool {
        let host = self.raw.host;
        let (mut left, mut blocks) = (size, size.saturating_add(padding(size) as u64));
        while blocks > 0 {
            if !self.fill(BLOCK).await {
                return false;
            }
            let have = ((self.held() / BLOCK * BLOCK) as u64).min(blocks);
            let data = have.min(left) as usize;
            let bytes = &self.buf[self.at..self.at + data];
            match holes.as_deref_mut() {
                Some(holes) => holes.take(host, sink, bytes).await,
                None => sink.take(host, bytes).await,
            }
            self.at += have as usize;
            self.taken += have / BLOCK as u64;
            (left, blocks) = (left - data as u64, blocks - have);
        }
        true
    }

    async fn skip(&mut self, size: u64) -> bool {
        self.copy(size, &mut Sink::Skip, None).await
    }

    /// A meta header's data whole; none when the input ends first.
    async fn whole(&mut self, size: u64) -> Option<Vec<u8>> {
        let mut data = Vec::new();
        self.copy(size, &mut Sink::Keep(&mut data), None)
            .await
            .then_some(data)
    }

    /// A member's data as the file it holds: a sparse member's runs at
    /// their offsets, with zeros before each, the file ending where the
    /// last run does.
    async fn data(&mut self, member: &Member, sink: &mut Sink<'_>) -> bool {
        let Some(sparse) = &member.sparse else {
            return self.copy(member.size, sink, None).await;
        };
        let end = sparse
            .runs
            .chunks_exact(2)
            .last()
            .map_or(0, |run| run[0] + run[1]);
        let mut holes = Holes {
            runs: sparse.runs.clone(),
            next: 0,
            left: 0,
            at: 0,
        };
        let whole = self.copy(member.size, sink, Some(&mut holes)).await;
        if whole {
            holes.zeros(self.raw.host, sink, end).await;
        }
        whole
    }

    /// The runs a pax 1.0 sparse member's data starts with, as decimal
    /// lines (their count, then each offset and length) padded to a whole
    /// block, taken off its `size`; none inside when a line is no number
    /// or they run past the data, none at all when the input ends first.
    async fn runs(&mut self, size: &mut u64) -> Option<Option<Vec<u64>>> {
        let (mut numbers, mut line) = (Vec::<u64>::new(), Vec::new());
        while *size >= BLOCK as u64 {
            let block = self.block().await?;
            *size -= BLOCK as u64;
            for &byte in &block {
                if byte != b'\n' {
                    line.push(byte);
                    continue;
                }
                let number = std::str::from_utf8(&line)
                    .ok()
                    .and_then(|line| line.parse().ok());
                let Some(number) = number else {
                    return Some(None);
                };
                numbers.push(number);
                line.clear();
                let want = numbers[0].checked_mul(2).and_then(|n| n.checked_add(1));
                if want == Some(numbers.len() as u64) {
                    numbers.remove(0);
                    return Some(Some(numbers));
                }
            }
        }
        Some(None)
    }
}

/// A sparse member's data on its way to its sink: the runs it fills, each
/// an offset and a length, the bytes left of the current one and where in
/// the file it is.
struct Holes {
    runs: Vec<u64>,
    next: usize,
    left: u64,
    at: u64,
}

impl Holes {
    /// Zeros up to `end` in the file, passed over once the sink takes
    /// nothing.
    async fn zeros(&mut self, host: &Host, sink: &mut Sink<'_>, end: u64) {
        if matches!(sink, Sink::Skip) {
            self.at = self.at.max(end);
        }
        while self.at < end {
            let n = (end - self.at).min(WINDOW as u64);
            sink.take(host, &ZEROS[..n as usize]).await;
            self.at += n;
        }
    }

    /// Archived bytes, each run's after the hole before it; bytes past the
    /// last run are dropped.
    async fn take(&mut self, host: &Host, sink: &mut Sink<'_>, mut data: &[u8]) {
        while !data.is_empty() {
            if self.left == 0 {
                let Some(&[offset, length]) = self.runs.get(self.next..self.next + 2) else {
                    return;
                };
                self.next += 2;
                self.zeros(host, sink, offset).await;
                self.left = length;
                continue;
            }
            let n = self.left.min(data.len() as u64) as usize;
            sink.take(host, &data[..n]).await;
            (self.at, self.left, data) = (self.at + n as u64, self.left - n as u64, &data[n..]);
        }
    }
}

/// Where a member's data goes.
enum Sink<'a> {
    Skip,
    Keep(&'a mut Vec<u8>),
    Print,
    File(&'a mut File),
}

impl Sink<'_> {
    async fn take(&mut self, host: &Host, data: &[u8]) {
        match self {
            Sink::Skip => {}
            Sink::Keep(into) => into.extend_from_slice(data),
            Sink::Print => {
                host.print(data);
                host.pause().await;
            }
            Sink::File(file) => {
                if !file.take(host, data).await {
                    *self = Sink::Skip;
                }
            }
        }
    }
}

/// `name` without its trailing slashes.
fn trimmed(name: &[u8]) -> &[u8] {
    &name[..name.len() - name.iter().rev().take_while(|&&b| b == b'/').count()]
}

/// What GNU removes from a member's name before it uses it: everything
/// through its last `..` component, else its leading slashes.
fn prefix(name: &[u8]) -> &[u8] {
    let mut end = None;
    let mut at = 0;
    for part in name.split(|&b| b == b'/') {
        at += part.len();
        if part == b".." {
            end = Some((at + 1).min(name.len()));
        }
        at += 1;
    }
    end.map_or_else(
        || &name[..name.iter().take_while(|&&b| b == b'/').count()],
        |end| &name[..end],
    )
}

/// The run's state across members.
struct Run<'c, 'h> {
    config: &'c Config,
    host: &'h Host,
    /// Every stderr line so far, in the order GNU says them.
    notices: Vec<Vec<u8>>,
    removed: HashSet<Vec<u8>>,
    found: Vec<bool>,
    failed: bool,
    rows: Rows,
    made: HashSet<Vec<u8>>,
}

impl Run<'_, '_> {
    fn say(&mut self, line: impl Into<Vec<u8>>) {
        self.notices.push(line.into());
    }

    /// Say once a run each prefix a member's name loses.
    fn announce(&mut self, name: &[u8]) {
        let prefix = prefix(name);
        if !prefix.is_empty() && self.removed.insert(prefix.to_vec()) {
            let line = [b"tar: Removing leading `", prefix, b"' from member names"].concat();
            self.say(line);
        }
    }

    /// Whether the operands select a member: one names it or a directory
    /// above it, and the first that does is found.
    fn select(&mut self, name: &[u8]) -> bool {
        if self.config.selectors.is_empty() {
            return true;
        }
        let name = trimmed(name);
        let hit = self.config.selectors.iter().position(|selector| {
            let base = trimmed(selector);
            name == base || (name.starts_with(base) && name.get(base.len()) == Some(&b'/'))
        });
        if let Some(index) = hit {
            self.found[index] = true;
        }
        hit.is_some()
    }

    /// The components a member extracts to, below the extraction root: its
    /// name without its leading slashes and `--strip-components` of it,
    /// `.` and empty components left out.
    fn parts(&self, name: &[u8]) -> Vec<Vec<u8>> {
        let name = &name[name.iter().take_while(|&&b| b == b'/').count()..];
        trimmed(name)
            .split(|&b| b == b'/')
            .skip(self.config.strip)
            .filter(|part| !part.is_empty() && *part != b".")
            .map(<[u8]>::to_vec)
            .collect()
    }

    /// One member, its data read past or taken; false when the input ended
    /// inside it.
    async fn member(&mut self, input: &mut Input<'_>, member: &Member) -> bool {
        let (config, host) = (self.config, self.host);
        if config.mode == Mode::List {
            let mut row = if config.verbose {
                self.rows.row(member)
            } else {
                escaped(&member.name)
            };
            row.push(b'\n');
            host.print(&row);
            return input.skip(member.size).await;
        }
        if member.name.split(|&b| b == b'/').any(|part| part == b"..") {
            let name = escaped(&member.name);
            self.say([b"tar: ", &name[..], b": Member name contains '..'"].concat());
            self.failed = true;
            return input.skip(member.size).await;
        }
        let parts = self.parts(&member.name);
        let shown = parts.join(&b'/');
        let path = [&config.base[..], b"/", &shown].concat();
        match member.kind {
            Kind::Dir if !config.to_stdout && !parts.is_empty() => {
                match host.ensure(&mut self.made, &path).await {
                    Ok(()) if config.verbose => {
                        host.print(&[&escaped(trimmed(&member.name))[..], b"/\n"].concat());
                    }
                    Ok(()) => {}
                    Err((_, text)) => {
                        self.say([b"tar: ", &shown[..], b": Cannot mkdir: ", &text].concat());
                        self.failed = true;
                    }
                }
                input.skip(member.size).await
            }
            Kind::File | Kind::Other(_) => {
                if let Kind::Other(flag) = member.kind {
                    let name = escaped(&member.name);
                    let tail = b"', extracted as normal file";
                    self.say(
                        [b"tar: ", &name[..], b": Unknown file type '", &[flag], tail].concat(),
                    );
                }
                if config.to_stdout {
                    if config.verbose {
                        self.say(escaped(&member.name));
                    }
                    let whole = input.data(member, &mut Sink::Print).await;
                    if !whole {
                        self.say(UNEXPECTED_EOF);
                    }
                    return whole;
                }
                if parts.is_empty() {
                    return input.skip(member.size).await;
                }
                let parent = &parts[..parts.len() - 1];
                if !parent.is_empty() {
                    let dir = [&config.base[..], b"/", &parent.join(&b'/')].concat();
                    if let Err((_, text)) = host.ensure(&mut self.made, &dir).await {
                        let up = parent.join(&b'/');
                        self.say([b"tar: ", &up[..], b": Cannot mkdir: ", &text].concat());
                        self.say(
                            [
                                b"tar: ",
                                &shown[..],
                                b": Cannot open: No such file or directory",
                            ]
                            .concat(),
                        );
                        self.failed = true;
                        return input.skip(member.size).await;
                    }
                }
                let mut file = File::new(path);
                let whole = input.data(member, &mut Sink::File(&mut file)).await;
                if file.failed.is_none() {
                    file.close(host).await;
                }
                match &file.failed {
                    Some(text) => {
                        self.say([b"tar: ", &shown[..], b": Cannot open: ", text].concat());
                        self.failed = true;
                    }
                    None if config.verbose => {
                        host.print(&[&escaped(&member.name)[..], b"\n"].concat());
                    }
                    None => {}
                }
                if !whole {
                    self.say(UNEXPECTED_EOF);
                }
                whole
            }
            // A link, a device or a fifo is workspace state no backend
            // holds, and a directory under -O lands nowhere.
            _ => input.skip(member.size).await,
        }
    }
}

/// The codec the archive is read through, or the run's refusal: bzip2 and
/// xz refuse an input without their magic (bzip2 an empty one aside), and
/// standard input cannot be read again through a compressor its magic
/// names but the line did not.
fn codec(config: &Config, first: &[u8]) -> Result<Option<Codec>, Vec<u8>> {
    let refused = |line: &str, status: i32| {
        format!("{line}\ntar: Child returned status {status}\n{FATAL}\n").into_bytes()
    };
    match config.codec {
        Some(Codec::Bzip2) if !first.starts_with(b"BZh") && !first.is_empty() => {
            Err(refused("bzip2: (stdin) is not a bzip2 file.", 2))
        }
        Some(Codec::Xz) if !first.starts_with(Codec::Xz.magic()) => {
            Err(refused("xz: (stdin): File format not recognized", 1))
        }
        Some(codec) => Ok(Some(codec)),
        None => match Codec::sniff(first) {
            Some(codec) if config.archive == b"-" => Err(format!(
                "tar: Archive is compressed. Use {} option\n{FATAL}\n",
                codec.letter()
            )
            .into_bytes()),
            found => Ok(found),
        },
    }
}

pub(super) async fn run(host: &Host, config: &Config) -> i32 {
    let opening = if config.archive == b"-" {
        (b"-".to_vec(), Opening::Name)
    } else {
        (config.archive.clone(), Opening::Operand(1))
    };
    let mut raw = Raw {
        host,
        open: Some(opening),
        data: Vec::new(),
        used: 0,
        ended: false,
        error: None,
    };
    raw.gather(6).await;
    if let Some(mut reply) = raw.error.take() {
        // A backend that keys files alone has no file where a directory is.
        if config.probe
            && reply.names(&["ENOENT"])
            && host.stat(&config.archive).await.as_deref() == Some("dir")
        {
            reply.error = Some("Is a directory".into());
            reply.errno = Some("EISDIR".into());
        }
        host.warn(&open_failure(config, &reply, true));
        return FAILED;
    }
    let codec = match codec(config, raw.unused()) {
        Ok(codec) => codec,
        Err(text) => {
            host.warn(&text);
            return FAILED;
        }
    };
    let mut input = Input {
        raw,
        codec: codec.map(|codec| codec.open("decode")),
        finished: false,
        buf: Vec::new(),
        at: 0,
        taken: 0,
        failure: None,
    };
    let mut run = Run {
        config,
        host,
        notices: Vec::new(),
        removed: HashSet::new(),
        found: vec![false; config.selectors.len()],
        failed: false,
        rows: Rows::default(),
        made: HashSet::new(),
    };
    let (mut skipping, mut selected, mut cut) = (false, false, false);
    let (mut long_name, mut long_link) = (None, None);
    let (mut pax, mut global) = (Pax::default(), Pax::default());
    while let Some(block) = input.block().await {
        let index = input.taken;
        let (mut member, flag) = match header::decode(&block) {
            Block::Zero => {
                let next = input.block().await;
                if !next.is_some_and(|block| block.iter().all(|&b| b == 0)) {
                    run.say(format!("tar: A lone zero block at {index}"));
                }
                break;
            }
            Block::Bad(lines) => {
                run.notices.extend(lines);
                if index == 1 {
                    run.say(NOT_TAR);
                }
                if !std::mem::replace(&mut skipping, true) {
                    run.say(SKIPPING);
                }
                run.failed = true;
                continue;
            }
            Block::Head(member, flag, lines) => {
                run.failed |= !lines.is_empty();
                run.notices.extend(lines);
                (member, flag)
            }
        };
        skipping = false;
        if matches!(flag, b'L' | b'K' | b'x' | b'g') {
            let Some(data) = input.whole(member.size).await else {
                cut = true;
                break;
            };
            let text = data[..data.iter().position(|&b| b == 0).unwrap_or(data.len())].to_vec();
            match flag {
                b'L' => long_name = Some(text),
                b'K' => long_link = Some(text),
                b'x' => pax.read(&data),
                _ => global.read(&data),
            }
            continue;
        }
        // GNU's sparse header goes on in blocks of 21 entries, each saying
        // whether another follows.
        let mut more = flag == b'S' && block[482] != 0;
        while more {
            let Some(next) = input.block().await else {
                cut = true;
                break;
            };
            if let Some(sparse) = member.sparse.as_mut() {
                sparse.runs.extend(header::runs(&next[..504]));
            }
            more = next[504] != 0;
        }
        if cut {
            break;
        }
        member.name = long_name.take().unwrap_or(member.name);
        member.target = long_link.take().unwrap_or(member.target);
        global.apply(&mut member);
        std::mem::take(&mut pax).apply(&mut member);
        let mut sound = true;
        if let Some(sparse) = member.sparse.as_mut().filter(|sparse| sparse.inline) {
            let Some(runs) = input.runs(&mut member.size).await else {
                cut = true;
                break;
            };
            sound = runs.is_some();
            sparse.runs = runs.unwrap_or_default();
        }
        if let Some(sparse) = member
            .sparse
            .as_mut()
            .filter(|sparse| !sound || !sparse.sound())
        {
            let name = escaped(&member.name);
            run.say([b"tar: ", &name[..], b": malformed sparse archive member"].concat());
            run.failed = true;
            sparse.runs.clear();
        }
        if member.kind == Kind::File && member.name.ends_with(b"/") {
            member.kind = Kind::Dir;
        }
        run.announce(&member.name);
        if !run.select(&member.name) {
            if input.skip(member.size).await {
                continue;
            }
            cut = true;
            break;
        }
        if !std::mem::replace(&mut selected, true) && !config.refusal.is_empty() {
            host.warn(&lines(&config.refusal));
            return FAILED;
        }
        if !run.member(&mut input, &member).await {
            cut = true;
            break;
        }
    }
    if input.taken == 0 && input.failure.is_none() && input.raw.error.is_none() {
        run.say(NOT_TAR);
        run.failed = true;
    }
    if !cut && input.codec.is_some() {
        // The compressor's verdict needs the whole of its input.
        while input.more().await {
            input.at = input.buf.len();
        }
    }
    if let Some(reply) = input.raw.error.take() {
        host.warn(&open_failure(config, &reply, true));
        return FAILED;
    }
    let lead = input
        .failure
        .as_ref()
        .map(Failure::lines)
        .unwrap_or_default();
    if cut {
        host.warn(&[lead, lines(&run.notices), lines(&[UNEXPECTED_EOF, FATAL])].concat());
        return FAILED;
    }
    if let Some(failure) = &input.failure {
        let status = format!("tar: Child returned status {}", failure.exit_code);
        host.warn(&[lead, lines(&run.notices), lines(&[status.as_str(), FATAL])].concat());
        return FAILED;
    }
    let misses: Vec<&Vec<u8>> = config
        .selectors
        .iter()
        .zip(&run.found)
        .filter(|(_, found)| !**found)
        .map(|(selector, _)| selector)
        .collect();
    if misses
        .iter()
        .any(|miss| miss.iter().any(|b| b"*?[\\".contains(b)))
    {
        run.say("tar: Pattern matching characters used in file names");
        run.say("tar: Use --wildcards to enable pattern matching, or --no-wildcards to suppress this warning");
    }
    for miss in &misses {
        run.say([b"tar: ", &miss[..], b": Not found in archive"].concat());
    }
    let failed = run.failed || !misses.is_empty();
    if failed {
        run.say(TRAILER);
    }
    host.warn(&lines(&run.notices));
    if failed { FAILED } else { 0 }
}
