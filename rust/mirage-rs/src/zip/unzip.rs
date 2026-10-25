//! unzip as UnZip 6.00 runs it, as mirage models it: list (`-l`, `-v`,
//! zipinfo's `-Z`), test (`-t`), pipe (`-p`) or extract, over the members
//! the filespecs and `-x` leave.

use std::collections::HashSet;

use serde::Deserialize;

use super::listing::{self, Letters, Rows};
use super::{
    Decoded, Decoder, Directory, Entry, Fault, Spool, WINDOW, failed, failure_text, padded, say,
    wildcard,
};
use crate::request::{Opening, Reply, Request, WriteMode, bytes};
use crate::task::Host;

const NO_END: &str = "  End-of-central-directory signature not found.  Either this file is not
  a zipfile, or it constitutes one disk of a multi-part archive.  In the
  latter case the central directory and zipfile comment will be found on
  the last disk(s) of this archive.\n";
const CORRUPT: &str = "error [{}]:  start of central directory not found;
  zipfile corrupt.
  (please check that you have transferred or created the zipfile in the
  appropriate BINARY mode and that you have compiled UnZip properly)\n";
const REPLACE: &str = "replace {}? [y]es, [n]o, [A]ll, [N]one, [r]ename: ";
const REPLACE_EOF: &str = " NULL\n(EOF or read error, treating as \"[N]one\" ...)\n";
const SKIPPED_DOTDOT: &str = "warning:  skipped \"../\" path component(s) in {}\n";
const NO_ARCHIVE_EXIT: i32 = 9;
const CORRUPT_EXIT: i32 = 3;
const WARN_EXIT: i32 = 1;
/// An unmatched filespec, or a filter that leaves nothing.
const NO_MATCH_EXIT: i32 = 11;
/// A member's data that does not decode or check.
const ERROR_EXIT: i32 = 2;
/// A member that needs a password, which mirage cannot ask for.
const PASSWORD_EXIT: i32 = 5;
/// Members skipped for their method, and nothing worse.
const SKIPPED_EXIT: i32 = 81;
/// A member that could not be written.
const CREATE_EXIT: i32 = 50;
/// A directory of a member's chain that could not be made.
const CHECKDIR_EXIT: i32 = 2;
/// Where an answer to the replace prompt is read from.
const STDIN: u32 = 1;

/// The archive as typed and as the listings name it, the filespecs, `-d`
/// as typed and the directory extraction lands in, and the letters.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub(super) struct Config {
    #[serde(deserialize_with = "crate::latin1")]
    archive: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1")]
    shown: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1_list")]
    members: Vec<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1_list")]
    excludes: Vec<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1_opt")]
    dest: Option<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1")]
    base: Vec<u8>,
    l: bool,
    v: bool,
    t: bool,
    p: bool,
    #[serde(rename = "Z")]
    zipinfo: bool,
    #[serde(rename = "1")]
    names: bool,
    #[serde(rename = "2")]
    names_headers: bool,
    s: bool,
    m: bool,
    h: bool,
    q: bool,
    o: bool,
    n: bool,
    /// One entry, by its place in the directory, piped whole: how a host
    /// reads an archive it holds.
    pick: Option<usize>,
}

/// Info-ZIP's refusal of an archive it cannot open, and its exit.
fn refusal(config: &Config, fault: &Fault) -> (Vec<u8>, i32) {
    let archive = config.archive.as_slice();
    match fault {
        Fault::NoEnd => {
            let mut text = if config.p || config.zipinfo {
                say("[{}]\n", &[archive])
            } else {
                Vec::new()
            };
            text.extend_from_slice(NO_END.as_bytes());
            if !config.p {
                let prog: &[u8] = if config.zipinfo { b"zipinfo" } else { b"unzip" };
                let indent = vec![b' '; prog.len() + 3];
                text.extend(say(
                    "{}:  cannot find zipfile directory in one of {} or\n{}{}.zip, and cannot find {}.ZIP, period.\n",
                    &[prog, archive, &indent, archive, archive],
                ));
            }
            (text, NO_ARCHIVE_EXIT)
        }
        Fault::Corrupt => (say(CORRUPT, &[archive]), CORRUPT_EXIT),
        Fault::Read(text) => (say("unzip: {}: {}\n", &[archive, text]), NO_ARCHIVE_EXIT),
    }
}

/// The entries the filespecs and `-x` leave, and the patterns of each
/// that matched nothing. Each entry is charged to the first filespec that
/// matches it, so one shadowed by an earlier spec matches nothing; an
/// entry a filespec chose still counts for it when `-x` then drops it.
fn select<'e>(
    entries: &'e [Entry],
    members: &[Vec<u8>],
    excludes: &[Vec<u8>],
) -> (Vec<&'e Entry>, Vec<u8>, bool) {
    let mut hit = vec![false; members.len()];
    let mut excluded = vec![false; excludes.len()];
    let first =
        |specs: &[Vec<u8>], name: &[u8]| specs.iter().position(|p| wildcard(p, name, false));
    let mut selected = Vec::new();
    for entry in entries {
        if !members.is_empty() {
            let Some(at) = first(members, &entry.name) else {
                continue;
            };
            hit[at] = true;
        }
        match first(excludes, &entry.name) {
            Some(at) => excluded[at] = true,
            None => selected.push(entry),
        }
    }
    let unmatched = hit.contains(&false);
    let mut cautions = Vec::new();
    for (spec, _) in members.iter().zip(hit).filter(|(_, hit)| !hit) {
        cautions.extend(say("caution: filename not matched:  {}\n", &[spec]));
    }
    for (spec, _) in excludes.iter().zip(excluded).filter(|(_, hit)| !hit) {
        cautions.extend(say(
            "caution: excluded filename not matched:  {}\n",
            &[spec],
        ));
    }
    (selected, cautions, unmatched)
}

/// A mapped name: empty, `.` and `..` directory components dropped, a
/// final `.` or `..` made `_` or `__`, so no name climbs out of the root;
/// whether a `..` was dropped.
fn map_name(name: &[u8]) -> (Vec<u8>, bool) {
    let directory = name.ends_with(b"/");
    let body = name.strip_suffix(b"/").unwrap_or(name);
    let parts: Vec<&[u8]> = body.split(|&b| b == b'/').collect();
    let mut kept: Vec<&[u8]> = Vec::new();
    let mut skipped = false;
    for (index, &part) in parts.iter().enumerate() {
        let last = index == parts.len() - 1 && !directory;
        match part {
            b"" => {}
            b"." | b".." if !last => skipped |= part == b"..",
            b"." => kept.push(b"_"),
            b".." => kept.push(b"__"),
            _ => kept.push(part),
        }
    }
    let mut mapped = kept.join(&b'/');
    if directory && !mapped.is_empty() {
        mapped.push(b'/');
    }
    (mapped, skipped)
}

/// An answer as Info-ZIP echoes one it refuses.
fn response(answer: &[u8]) -> Vec<u8> {
    if answer.is_empty() {
        return b"{ENTER}".to_vec();
    }
    let mut out = Vec::new();
    for &byte in answer {
        match byte {
            0x7F => out.extend_from_slice(b"^?"),
            0..=0x1F => out.extend_from_slice(&[b'^', byte + 64]),
            _ => out.push(byte),
        }
    }
    out
}

fn parent(path: &[u8]) -> &[u8] {
    path.iter()
        .rposition(|&b| b == b'/')
        .map_or(b"", |at| &path[..at])
}

fn after_slashes(path: &[u8]) -> &[u8] {
    &path[path.iter().position(|&b| b != b'/').unwrap_or(path.len())..]
}

/// Whose words a member's damage is told in: `-q`'s, which `-p` shares,
/// `-t`'s testing line, or what follows extraction's line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Voice {
    Quiet,
    Testing,
    Extracting,
}

/// What a member's damage says, naming it as Info-ZIP does: by member
/// name, or by the path extraction gave it.
fn damage(named: &[u8], expected: u32, verdict: &Decoded, voice: Voice) -> Vec<u8> {
    let name = padded(named, 22);
    let invalid = "  error:  invalid compressed data to {}";
    match verdict {
        Decoded::Sound => Vec::new(),
        Decoded::BadCrc(found) => {
            let crc = format!("bad CRC {found:08x}  (should be {expected:08x})\n");
            match voice {
                Voice::Quiet => say("{}  {}", &[&name, crc.as_bytes()]),
                Voice::Testing => say("    testing: {}   {}", &[&name, crc.as_bytes()]),
                Voice::Extracting => say(" {}", &[crc.as_bytes()]),
            }
        }
        Decoded::Invalid(verb) => {
            let invalid = say(invalid, &[verb.as_bytes()]);
            match voice {
                Voice::Quiet => say("{} {}\n", &[&invalid, named]),
                Voice::Testing => say("    testing: {}  \n{}\n", &[&name, &invalid]),
                Voice::Extracting => say("\n{}\n", &[&invalid]),
            }
        }
    }
}

struct Run<'h> {
    host: &'h Host,
    config: Config,
    spool: Spool<'h>,
    /// The worst a member's data came to, kept apart from the mode's own
    /// status: skipped methods count only when nothing else went wrong.
    damage: i32,
    skipped: usize,
}

impl Run<'_> {
    fn damaged(&mut self, status: i32) {
        self.damage = self.damage.max(status);
    }

    /// Info-ZIP's warning for a stored member whose two sizes disagree;
    /// the compressed size is the one read.
    fn sized(&mut self, entry: &Entry) -> Vec<u8> {
        if entry.method != 0 || entry.size == entry.csize {
            return Vec::new();
        }
        self.damaged(WARN_EXIT);
        let (size, csize) = (entry.size.to_string(), entry.csize.to_string());
        let warning = "{}:  ucsize {} <> csize {} for STORED entry\n         continuing with \"compressed\" size value\n";
        say(warning, &[&entry.name, size.as_bytes(), csize.as_bytes()])
    }

    /// Whether Info-ZIP skips this member, and what it says: a method
    /// mirage does not decode (in silence under `quiet`), or a password it
    /// cannot ask for.
    fn skips(&mut self, entry: &Entry, quiet: bool) -> Option<Vec<u8>> {
        let reason = if entry.flags & 1 != 0 {
            self.damaged(PASSWORD_EXIT);
            return Some(say(
                "   skipping: {}  unable to get password\n",
                &[&padded(&entry.name, 22)],
            ));
        } else if Decoder::new(entry).is_some() {
            return None;
        } else {
            match entry.method {
                2..=5 => "`reduce' method not supported".to_owned(),
                7 => "`tokenize' method not supported".to_owned(),
                10 => "`DCL implode' method not supported".to_owned(),
                14 => "`LZMA' method not supported".to_owned(),
                18 => "`IBM/Terse' method not supported".to_owned(),
                19 => "`IBM LZ77' method not supported".to_owned(),
                97 => "`WavPack' method not supported".to_owned(),
                98 => "`PPMd' method not supported".to_owned(),
                method => format!("unsupported compression method {method}"),
            }
        };
        self.skipped += 1;
        let shown = padded(&entry.name, 22);
        Some(if quiet {
            Vec::new()
        } else {
            say("   skipping: {}  {}\n", &[&shown, reason.as_bytes()])
        })
    }

    /// Decode an entry's data, handing `sink` each window.
    async fn decode<S: Sink>(&mut self, entry: &Entry, sink: &mut S) -> Decoded {
        let unreadable = Decoded::Invalid("inflate");
        let Some(mut decoder) = Decoder::new(entry) else {
            return unreadable;
        };
        let Ok(Some(start)) = self.spool.data_start(entry).await else {
            return unreadable;
        };
        let (mut at, end) = (start, start.saturating_add(entry.csize));
        let mut window = Vec::new();
        while at < end {
            let Ok(chunk) = self.spool.window(at, (end - at).min(WINDOW as u64)).await else {
                return unreadable;
            };
            if chunk.is_empty() {
                break;
            }
            at += chunk.len() as u64;
            let mut rest = chunk.as_slice();
            loop {
                rest = &rest[decoder.step(rest, &mut window)..];
                if !window.is_empty() && !sink.take(self.host, &window).await {
                    return Decoded::Sound;
                }
                if rest.is_empty() && !decoder.pending() {
                    break;
                }
            }
        }
        decoder.finish()
    }
}

/// Where a member's decoded bytes go; false stops the member.
trait Sink {
    async fn take(&mut self, host: &Host, window: &[u8]) -> bool;
}

/// `-t`: nowhere.
struct Discard;

impl Sink for Discard {
    async fn take(&mut self, _: &Host, _: &[u8]) -> bool {
        true
    }
}

/// `-p`: the output, the host taking each window before the next.
struct Print;

impl Sink for Print {
    async fn take(&mut self, host: &Host, window: &[u8]) -> bool {
        host.print(window);
        host.pause().await;
        true
    }
}

/// An extracted file: its first window held, so a file of one window is
/// written whole by one request, a longer one streamed a window at a time;
/// the failure that stopped it.
struct File {
    path: Vec<u8>,
    held: Option<Vec<u8>>,
    created: bool,
    failed: Option<Vec<u8>>,
}

impl File {
    async fn ask(&mut self, host: &Host, request: Request) -> bool {
        let (reply, _) = host.ask(request).await;
        if failed(&reply) {
            self.failed = Some(failure_text(&reply));
        }
        self.failed.is_none()
    }

    async fn send(&mut self, host: &Host, mode: WriteMode, data: Vec<u8>) -> bool {
        let path = self.path.clone();
        self.ask(host, Request::Write { path, mode, data }).await
    }

    /// Write what is held, the file whole when nothing was sent, and commit
    /// it.
    async fn close(&mut self, host: &Host) {
        let held = self.held.take().unwrap_or_default();
        if !self.created {
            self.send(host, WriteMode::Whole, held).await;
        } else if self.send(host, WriteMode::Append, held).await {
            let path = Some(self.path.clone());
            self.ask(host, Request::Flush { path }).await;
        }
    }
}

impl Sink for File {
    async fn take(&mut self, host: &Host, window: &[u8]) -> bool {
        let Some(held) = self.held.replace(window.to_vec()) else {
            return true;
        };
        let mode = if std::mem::replace(&mut self.created, true) {
            WriteMode::Append
        } else {
            WriteMode::Create
        };
        self.send(host, mode, held).await
    }
}

pub(super) async fn run(host: Host, config: Config) -> i32 {
    let open = (config.archive.clone(), Opening::Operand(1));
    let spool = super::ARCHIVE;
    let (reply, _) = host.ask(Request::Fill { spool, open }).await;
    if failed(&reply) {
        host.warn(&read_failure(&config.archive, &reply));
        return NO_ARCHIVE_EXIT;
    }
    let mut spool = Spool::new(&host, spool, reply.size);
    let directory = match spool.directory(false).await {
        Ok(directory) => directory,
        Err(fault) => {
            let (text, status) = refusal(&config, &fault);
            host.warn(&text);
            return status;
        }
    };
    // A mode that writes nothing says so about -d first.
    if config.o && config.n {
        host.warn(b"caution:  both -n and -o specified; ignoring -o\n");
    }
    if config.dest.is_some() && (config.zipinfo || config.t || config.p || config.l || config.v) {
        host.warn(b"caution:  not extracting; -d ignored\n");
    }
    // Bytes before the archive, or missing from it, shift every offset:
    // a warning, on stdout under -t, and the run goes on.
    let archive = config.archive.as_slice();
    let (warning, floor) = match directory.slack {
        0 => (Vec::new(), 0),
        slack if slack < 0 => (
            say(
                "error [{}]:  missing {} bytes in zipfile\n  (attempting to process anyway)\n",
                &[archive, (-slack).to_string().as_bytes()],
            ),
            2,
        ),
        slack => (
            say(
                "warning [{}]:  {} extra byte{} at beginning or within zipfile\n  (attempting to process anyway)\n",
                &[
                    archive,
                    slack.to_string().as_bytes(),
                    if slack == 1 { b"" } else { b"s" },
                ],
            ),
            WARN_EXIT,
        ),
    };
    let on_stdout = config.t && !config.zipinfo;
    if !on_stdout {
        host.warn(&warning);
    }
    let mut run = Run {
        host: &host,
        config,
        spool,
        damage: 0,
        skipped: 0,
    };
    let warning = if on_stdout { warning } else { Vec::new() };
    let status = mode(&mut run, &directory, warning).await;
    match (status.max(floor).max(run.damage), run.skipped) {
        (0, 0) => 0,
        (0, _) => SKIPPED_EXIT,
        (worst, _) => worst,
    }
}

fn read_failure(archive: &[u8], reply: &Reply) -> Vec<u8> {
    match &reply.line {
        Some(text) => bytes(text),
        None => say("unzip: {}: {}\n", &[archive, &failure_text(reply)]),
    }
}

/// One mode over the opened archive. Every filespec and `-x` pattern that
/// matched nothing is reported, and a filter that leaves nothing exits 11.
async fn mode(run: &mut Run<'_>, directory: &Directory, warning: Vec<u8>) -> i32 {
    if let Some(entry) = run.config.pick.and_then(|at| directory.entries.get(at)) {
        pipe(run, entry).await;
        return 0;
    }
    let config = &run.config;
    let (selected, cautions, unmatched) =
        select(&directory.entries, &config.members, &config.excludes);
    let filtered = !config.members.is_empty() || !config.excludes.is_empty();
    let nothing = if filtered && selected.is_empty() {
        NO_MATCH_EXIT
    } else {
        0
    };
    let mut out = Vec::new();
    if config.zipinfo {
        let letters = Letters {
            names: config.names,
            names_headers: config.names_headers,
            long: config.l,
            medium: config.m,
            short: config.s,
            header: config.h,
            totals: config.t,
        };
        let (rows, header, totals) = listing::layout(letters, filtered);
        if header {
            let count = directory.entries.len() as u64;
            listing::header(&config.shown, run.spool.size, count, &mut out);
        }
        for entry in &selected {
            match rows {
                Rows::None => {}
                Rows::Names => out.extend(say("{}\n", &[&entry.name])),
                rows => listing::row(entry, rows, &mut out),
            }
        }
        if totals {
            listing::totals(&selected, &mut out);
        }
        run.host.print(&out);
        run.host.warn(&cautions);
        return nothing;
    }
    // -l lists only when neither -t nor -p asks for another mode, and -v
    // widens it into the verbose table; neither prints a caution.
    if (config.l || config.v) && !(config.t || config.p) {
        if config.v {
            listing::verbose(
                &config.shown,
                &selected,
                config.q,
                &directory.comment,
                &mut out,
            );
        } else {
            listing::short_list(&selected, &mut out);
        }
        run.host.print(&out);
        return nothing;
    }
    if config.t {
        return test(run, &selected, filtered, unmatched, cautions, warning).await;
    }
    let status = if unmatched { NO_MATCH_EXIT } else { nothing };
    if !config.p {
        return extract(run, &selected, status, &cautions).await;
    }
    run.host.warn(&cautions);
    for entry in selected.iter().filter(|e| !e.is_dir()) {
        pipe(run, entry).await;
    }
    status
}

/// `-t`: an unmatched filespec ends the test before any member is read.
async fn test(
    run: &mut Run<'_>,
    selected: &[&Entry],
    filtered: bool,
    unmatched: bool,
    cautions: Vec<u8>,
    warning: Vec<u8>,
) -> i32 {
    let archive = run.config.archive.clone();
    let quiet = run.config.q;
    if !quiet {
        run.host.print(&say("Archive:  {}\n", &[&archive]));
    }
    run.host.print(&warning);
    if unmatched || (filtered && selected.is_empty()) {
        run.host.print(&cautions);
        run.host.print(&say(
            if unmatched {
                "At least one error was detected in {}.\n"
            } else {
                "Caution:  zero files tested in {}.\n"
            },
            &[&archive],
        ));
        return NO_MATCH_EXIT;
    }
    let mut tested = 0;
    let mut out = Vec::new();
    for entry in selected {
        let verdict = if entry.is_dir() {
            Decoded::Sound
        } else if let Some(text) = run.skips(entry, quiet) {
            out.extend(text);
            continue;
        } else {
            out.extend(run.sized(entry));
            run.decode(entry, &mut Discard).await
        };
        tested += 1;
        match verdict {
            Decoded::Sound if !quiet => {
                out.extend(say("    testing: {}   OK\n", &[&padded(&entry.name, 22)]));
            }
            Decoded::Sound => {}
            _ => {
                run.damaged(ERROR_EXIT);
                let voice = if quiet { Voice::Quiet } else { Voice::Testing };
                out.extend(damage(&entry.name, entry.crc, &verdict, voice));
            }
        }
    }
    let skipped = run.skipped;
    out.extend(cautions);
    out.extend(if run.damage > WARN_EXIT {
        say("At least one error was detected in {}.\n", &[&archive])
    } else if run.damage == WARN_EXIT {
        say(
            "At least one warning-error was detected in {}.\n",
            &[&archive],
        )
    } else if tested == 0 {
        say("Caution:  zero files tested in {}.\n", &[&archive])
    } else if filtered || skipped > 0 {
        let plural: &[u8] = if tested == 1 { b"" } else { b"s" };
        let count = tested.to_string();
        say(
            "No errors detected in {} for the {} file{} tested.\n",
            &[&archive, count.as_bytes(), plural],
        )
    } else {
        say(
            "No errors detected in compressed data of {}.\n",
            &[&archive],
        )
    });
    if skipped > 0 {
        let plural: &[u8] = if skipped == 1 { b"" } else { b"s" };
        let count = skipped.to_string();
        out.extend(say(
            "{} file{} skipped because of unsupported compression or encoding.\n",
            &[count.as_bytes(), plural],
        ));
    }
    run.host.print(&out);
    0
}

/// `-p`: one member's bytes to the output; what went wrong on stderr in
/// `-q`'s words.
async fn pipe(run: &mut Run<'_>, entry: &Entry) {
    if let Some(text) = run.skips(entry, true) {
        run.host.warn(&text);
        return;
    }
    let warning = run.sized(entry);
    run.host.warn(&warning);
    let verdict = run.decode(entry, &mut Print).await;
    if !matches!(verdict, Decoded::Sound) {
        run.damaged(ERROR_EXIT);
        run.host
            .warn(&damage(&entry.name, entry.crc, &verdict, Voice::Quiet));
    }
}

/// Extraction's state: the directories made, the files written, the
/// replace prompt's standing answers and its input.
struct Extract {
    base: Vec<u8>,
    typed: Vec<u8>,
    made: HashSet<Vec<u8>>,
    written: HashSet<Vec<u8>>,
    replace_all: bool,
    skip_all: bool,
    answers: Vec<u8>,
    answered: bool,
    ended: bool,
    checkdir_failed: bool,
    create_failed: bool,
    /// The run's status before a checkdir or create failure overrides it.
    code: i32,
}

async fn stat(host: &Host, path: &[u8]) -> Option<String> {
    let path = path.to_vec();
    host.ask(Request::Stat { path }).await.0.kind
}

/// Make a directory's chain top-down, each level once a run, skipping
/// what stands; the level that failed and why.
async fn ensure(
    host: &Host,
    made: &mut HashSet<Vec<u8>>,
    dir: &[u8],
) -> Result<(), (Vec<u8>, Vec<u8>)> {
    let mut level = Vec::new();
    for part in dir.split(|&b| b == b'/').filter(|p| !p.is_empty()) {
        level.push(b'/');
        level.extend_from_slice(part);
        if made.contains(&level) {
            continue;
        }
        if stat(host, &level).await.as_deref() != Some("dir") {
            let path = level.clone();
            let (reply, _) = host.ask(Request::Mkdir { path }).await;
            if failed(&reply) {
                return Err((level, failure_text(&reply)));
            }
        }
        made.insert(level.clone());
    }
    Ok(())
}

impl Extract {
    fn raise(&mut self, status: i32) {
        self.code = self.code.max(status);
    }

    /// A path as the listing spells it: under `-d` as typed, else bare.
    fn shown(&self, path: &[u8]) -> Vec<u8> {
        let rel = after_slashes(path.get(self.base.len()..).unwrap_or_default());
        if self.typed.is_empty() {
            return rel.to_vec();
        }
        let typed = self.typed.as_slice();
        let end = typed.len() - typed.iter().rev().take_while(|&&b| b == b'/').count();
        say("{}/{}", &[&typed[..end], rel])
    }

    /// The next line of the replace prompt's input, without its newline;
    /// None once it is used up.
    async fn answer(&mut self, host: &Host) -> Option<Vec<u8>> {
        loop {
            if let Some(at) = self.answers.iter().position(|&b| b == b'\n') {
                let mut answer: Vec<u8> = self.answers.drain(..=at).collect();
                answer.pop();
                return Some(answer);
            }
            if self.ended {
                return (!self.answers.is_empty()).then(|| std::mem::take(&mut self.answers));
            }
            let open = (!std::mem::replace(&mut self.answered, true))
                .then(|| (b"-".to_vec(), Opening::Name));
            let (fd, least) = (STDIN, 0);
            let (reply, data) = host.ask(Request::Read { fd, open, least }).await;
            self.ended = reply.end || failed(&reply);
            self.answers.extend_from_slice(&data);
        }
    }

    /// Where a file entry goes when a file may hold its name: Info-ZIP asks
    /// first, unless `-o` or an `A` said to replace and `-n` or an `N` said
    /// never to; the end of input answers `N`; `r` names another file under
    /// the root, asked about in its turn.
    async fn destination(&mut self, run: &mut Run<'_>, mut path: Vec<u8>) -> Option<Vec<u8>> {
        let host = run.host;
        loop {
            // Two members can map to one path, so what this run wrote counts
            // as there without a stat.
            if self.replace_all
                || (!self.written.contains(&path) && stat(host, &path).await.is_none())
            {
                return Some(path);
            }
            if self.skip_all {
                return None;
            }
            let prompt = say(REPLACE, &[&self.shown(&path)]);
            let Some(answer) = self.answer(host).await else {
                host.warn(&[prompt.as_slice(), REPLACE_EOF.as_bytes()].concat());
                self.skip_all = true;
                self.raise(WARN_EXIT);
                return None;
            };
            host.warn(&prompt);
            match answer.first() {
                Some(b'y' | b'Y') => return Some(path),
                Some(b'n') => return None,
                Some(b'A') => {
                    self.replace_all = true;
                    return Some(path);
                }
                Some(b'N') => {
                    self.skip_all = true;
                    return None;
                }
                Some(b'r' | b'R') => {
                    let mut name = Some(Vec::new());
                    while name.as_ref().is_some_and(Vec::is_empty) {
                        host.warn(b"new name: ");
                        name = self.answer(host).await;
                    }
                    // Info-ZIP puts an absolute new name under the working
                    // directory; here every name stays under the root.
                    let Some(typed) = name else {
                        continue;
                    };
                    let (renamed, skipped) = map_name(after_slashes(&typed));
                    if skipped {
                        self.raise(WARN_EXIT);
                        if !run.config.q {
                            host.print(&say(SKIPPED_DOTDOT, &[&typed]));
                        }
                    }
                    if !renamed.is_empty() && !renamed.ends_with(b"/") {
                        path = say("{}/{}", &[&self.base, &renamed]);
                    }
                }
                _ => host.warn(&say(
                    "error:  invalid response [{}]\n",
                    &[&response(&answer)],
                )),
            }
        }
    }

    /// Info-ZIP's report of a chain it could not make: the first level
    /// below the root that is a file, or the level whose mkdir failed.
    async fn checkdir(
        &mut self,
        host: &Host,
        chain: &[u8],
        failure: (Vec<u8>, Vec<u8>),
        member: &[u8],
    ) {
        self.checkdir_failed = true;
        let mut level = self.base.clone();
        let mut blocker = None;
        for part in chain
            .get(level.len()..)
            .unwrap_or_default()
            .split(|&b| b == b'/')
            .filter(|p| !p.is_empty())
        {
            level.push(b'/');
            level.extend_from_slice(part);
            match stat(host, &level).await.as_deref() {
                Some("dir") => continue,
                Some(_) => blocker = Some(level),
                None => {}
            }
            break;
        }
        let tail = say("                 unable to process {}.\n", &[member]);
        let (level, text) = failure;
        host.warn(&match blocker {
            Some(blocker) => say(
                "checkdir error:  {} exists but is not directory\n{}",
                &[&self.shown(&blocker), &tail],
            ),
            None => say(
                "checkdir error:  cannot create {}\n                 {}\n{}",
                &[&self.shown(&level), &text, &tail],
            ),
        });
    }
}

async fn extract(run: &mut Run<'_>, selected: &[&Entry], status: i32, cautions: &[u8]) -> i32 {
    let host = run.host;
    let config = &run.config;
    let quiet = config.q;
    let mut state = Extract {
        base: config.base.clone(),
        typed: config.dest.clone().unwrap_or_default(),
        made: HashSet::new(),
        written: HashSet::new(),
        replace_all: config.o && !config.n,
        skip_all: config.n,
        answers: Vec::new(),
        answered: false,
        ended: false,
        checkdir_failed: false,
        create_failed: false,
        code: status,
    };
    if !quiet {
        host.print(&say("Archive:  {}\n", &[&config.archive]));
    }
    if config.dest.is_some() {
        let base = state.base.clone();
        if let Err((_, text)) = ensure(host, &mut state.made, &base).await {
            let line = "checkdir:  cannot create extraction directory: {}\n           {}\n";
            host.warn(&say(line, &[&state.typed, &text]));
            return CHECKDIR_EXIT;
        }
    }
    host.warn(cautions);
    for entry in selected {
        let name = after_slashes(&entry.name);
        if name.len() < entry.name.len() {
            host.warn(&say(
                "warning:  stripped absolute path spec from {}\n",
                &[&entry.name],
            ));
            state.raise(WARN_EXIT);
        }
        let (mapped, skipped) = map_name(name);
        if skipped {
            state.raise(WARN_EXIT);
            if !quiet {
                host.print(&say(SKIPPED_DOTDOT, &[name]));
            }
        }
        if mapped.is_empty() {
            if !name.ends_with(b"/") {
                host.warn(b"mapname:  conversion of  failed\n");
                state.raise(2);
            }
            continue;
        }
        let out_path = say(
            "{}/{}",
            &[&state.base, mapped.strip_suffix(b"/").unwrap_or(&mapped)],
        );
        let is_dir = entry.is_dir();
        let chain = if is_dir {
            out_path.clone()
        } else {
            parent(&out_path).to_vec()
        };
        // A directory entry is the only record an empty directory leaves.
        let existed = is_dir && stat(host, &out_path).await.is_some();
        if !chain.is_empty() {
            if let Err(failure) = ensure(host, &mut state.made, &chain).await {
                state.checkdir(host, &chain, failure, &entry.name).await;
                continue;
            }
        }
        if is_dir {
            if !quiet && !existed {
                host.print(&say("   creating: {}/\n", &[&state.shown(&out_path)]));
            }
            continue;
        }
        if let Some(text) = run.skips(entry, quiet) {
            host.warn(&text);
            continue;
        }
        let Some(target) = state.destination(run, out_path.clone()).await else {
            continue;
        };
        let renamed_dir = parent(&target).to_vec();
        if target != out_path && renamed_dir != chain {
            if let Err(failure) = ensure(host, &mut state.made, &renamed_dir).await {
                state
                    .checkdir(host, &renamed_dir, failure, &entry.name)
                    .await;
                continue;
            }
        }
        let mut file = File {
            path: target.clone(),
            held: None,
            created: false,
            failed: None,
        };
        let warning = run.sized(entry);
        host.warn(&warning);
        let verdict = run.decode(entry, &mut file).await;
        if file.failed.is_none() {
            file.close(host).await;
        }
        let shown = state.shown(&target);
        if let Some(text) = &file.failed {
            // -o unlinks a file already there before it writes, so a refusal
            // of that is its own verb.
            let verb: &[u8] = if stat(host, &target).await.is_some() {
                b"delete old"
            } else {
                b"create"
            };
            state.create_failed = true;
            host.warn(&say(
                "error:  cannot {} {}\n        {}\n",
                &[verb, &shown, text],
            ));
            continue;
        }
        state.written.insert(target);
        if !quiet {
            let verb: &[u8] = if entry.method == 0 {
                b" extracting"
            } else {
                b"  inflating"
            };
            host.print(&say("{}: {}  \n", &[verb, &padded(&shown, 22)]));
        }
        if !matches!(verdict, Decoded::Sound) {
            run.damaged(ERROR_EXIT);
            let voice = if quiet {
                Voice::Quiet
            } else {
                Voice::Extracting
            };
            host.warn(&damage(&shown, entry.crc, &verdict, voice));
        }
    }
    if state.create_failed {
        CREATE_EXIT
    } else if state.checkdir_failed {
        CHECKDIR_EXIT
    } else {
        state.code
    }
}
