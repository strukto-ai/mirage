//! patch as GNU patch 2.8 applies a unified diff, as mirage models it:
//! the patch read whole as the run's input (`-`), each file section's
//! hunks placed with GNU's offsets and fuzz, and each file, its `.orig`
//! backup and its `.rej` rejects read and written whole through the host,
//! by the name the report gives them. Lines keep the newline they end
//! with, so a file's last line without one stays so, and a `\` line in
//! the patch marks the line before it as having none. The file a section
//! patches is picked among its names as GNU picks it, made with its
//! directories when the patch creates it, and removed with the
//! directories it empties when the patch deletes it. Standard input is
//! never a terminal here, so every question GNU would ask takes its
//! default.

mod apply;
mod parse;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::request::{Opening, Reply, Request, WriteMode, bytes, read_failure};
use crate::task::{self, Host};
use crate::{Stream, StreamError, parse_config};

use self::parse::{CUT, End, Move, Section, chomp};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// `-p`: the leading components dropped from the patch's names; with
    /// none given, each name is its basename.
    #[serde(deserialize_with = "crate::saturating_usize_opt")]
    strip: Option<usize>,
    /// `-R`: each hunk applied the other way round.
    reverse: bool,
    /// `-N`: a patch that reads as already applied is skipped unasked.
    forward: bool,
    /// ORIGFILE as typed: the one file every section patches, in place of
    /// the names the patch gives.
    #[serde(deserialize_with = "crate::latin1_opt")]
    file: Option<Vec<u8>>,
    /// `--dry-run`: each file checked as it would be patched, and nothing
    /// written.
    dry_run: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(task::spawn(|host| run(host, config)))
}

fn failed(reply: &Reply) -> bool {
    reply.error.is_some() || reply.errno.is_some() || reply.line.is_some()
}

/// The run's files on its host: each read whole, on a descriptor of its
/// own, and each written whole, unless the run only checks them.
struct Files {
    host: Host,
    fds: u32,
    dry_run: bool,
}

impl Files {
    async fn whole(&mut self, name: &[u8], opening: Opening) -> Result<Vec<u8>, Box<Reply>> {
        self.fds += 1;
        let fd = self.fds;
        let mut open = Some((name.to_vec(), opening));
        let mut data = Vec::new();
        loop {
            let least = u64::MAX;
            let read = Request::Read {
                fd,
                open: open.take(),
                least,
            };
            let (reply, mut chunk) = self.host.ask(read).await;
            if failed(&reply) {
                return Err(Box::new(reply));
            }
            data.append(&mut chunk);
            if reply.end {
                return Ok(data);
            }
        }
    }

    fn say(&self, parts: &[&[u8]]) {
        self.host
            .print(&[parts.concat().as_slice(), b"\n"].concat());
    }

    /// Ask the host to change a path; false, with the failure said, when it
    /// could not.
    async fn change(&self, request: Request, name: &[u8]) -> bool {
        if self.dry_run {
            return true;
        }
        let (reply, _) = self.host.ask(request).await;
        if failed(&reply) {
            self.host.warn(&read_failure(b"patch", name, &reply));
        }
        !failed(&reply)
    }

    /// Write a file whole; false, with the failure said, when the host
    /// could not.
    async fn write(&self, path: Vec<u8>, data: Vec<u8>) -> bool {
        let name = path.clone();
        let mode = WriteMode::Whole;
        self.change(Request::Write { path, mode, data }, &name)
            .await
    }

    /// Set a file's permission bits; false, with the failure said, when the
    /// host could not.
    async fn chmod(&self, name: &[u8], mode: u32) -> bool {
        let path = name.to_vec();
        let mode = mode & 0o7777;
        self.change(Request::Chmod { path, mode }, name).await
    }

    /// Make the directories a name needs, outermost first; false, with the
    /// failure said, when one could not be made.
    async fn make(&self, dirs: Vec<Vec<u8>>) -> bool {
        for dir in dirs {
            if !self
                .change(Request::Mkdir { path: dir.clone() }, &dir)
                .await
            {
                return false;
            }
        }
        true
    }

    /// Whether something stands at a name, as lstat would find it: a link
    /// that leads nowhere stands, and a `..` leads out of the name before
    /// it only when that stands as a directory.
    async fn stands(&self, name: &[u8]) -> bool {
        for (at, _) in name.iter().enumerate().filter(|&(_, &b)| b == b'/') {
            let (dir, rest) = name.split_at(at);
            let up = rest[1..].split(|&b| b == b'/').next() == Some(&b".."[..]);
            if up && !dir.is_empty() && self.host.stat(dir).await.as_deref() != Some("dir") {
                return false;
            }
        }
        self.host.stat(name).await.is_some()
    }

    /// The directories above a name that do not stand yet, outermost
    /// first; none when one of them stands as a file. A `.` or `..`
    /// component names no directory of its own to make, and a link that
    /// leads to nothing found is made through.
    async fn missing(&self, name: &[u8]) -> Option<Vec<Vec<u8>>> {
        let mut missing = Vec::new();
        for (at, _) in name.iter().enumerate().filter(|&(_, &b)| b == b'/') {
            let dir = &name[..at];
            let last = dir.rsplit(|&b| b == b'/').next().unwrap_or(dir);
            if matches!(last, b"" | b"." | b"..") {
                continue;
            }
            if missing.is_empty() {
                match self.host.stat(dir).await.as_deref() {
                    Some("dir") => continue,
                    Some("link") | None => {}
                    Some(_) => return None,
                }
            }
            missing.push(dir.to_vec());
        }
        Some(missing)
    }
}

/// What the run has done to its files so far: those it wrote, and each
/// `.rej`'s text, which a later section for the same file adds to.
#[derive(Default)]
struct Done {
    written: HashSet<Vec<u8>>,
    rejects: HashMap<Vec<u8>, Vec<u8>>,
}

async fn run(host: Host, config: Config) -> i32 {
    let mut files = Files {
        host,
        fds: 0,
        dry_run: config.dry_run,
    };
    let raw = match files.whole(b"-", Opening::Name).await {
        Ok(patch) => patch,
        Err(reply) => {
            let text = reply.error.as_deref().unwrap_or_default();
            let line = reply.line.as_deref().map_or_else(
                || [b"patch: **** read error : ", &bytes(text)[..], b"\n"].concat(),
                bytes,
            );
            files.host.warn(&line);
            return 2;
        }
    };
    let (patch, crlf) = parse::strip_crs(&raw, config.strip);
    let lines = parse::lines(&patch);
    let parsed = parse::sections(&lines, config.strip, &crlf);
    if parsed.sections.is_empty() && !patch.is_empty() {
        if parsed.cut {
            files.say(&[CUT.as_bytes()]);
        }
        files
            .host
            .warn(b"patch: **** Only garbage was found in the patch input.\n");
        return 2;
    }
    let mut done = Done::default();
    let mut status = 0;
    for section in &parsed.sections {
        match patch_file(&mut files, &config, &lines, section, &mut done).await {
            Ok(true) => status = 1,
            Ok(false) => {}
            Err(stop) => return stop,
        }
    }
    if parsed.cut {
        files.say(&[CUT.as_bytes()]);
    }
    status
}

/// The best of some names as GNU picks it: the first that has at once the
/// fewest components, the shortest basename and the shortest length of
/// them all, and none when no name has all three.
fn best<'n>(names: impl IntoIterator<Item = &'n Vec<u8>>) -> Option<Vec<u8>> {
    let rank = |name: &Vec<u8>| {
        let parts = name.split(|&b| b == b'/').filter(|part| !part.is_empty());
        let base = name.rsplit(|&b| b == b'/').next().map_or(0, <[u8]>::len);
        [parts.count(), base, name.len()]
    };
    let ranks: Vec<_> = names.into_iter().map(|name| (name, rank(name))).collect();
    let least: [usize; 3] =
        std::array::from_fn(|at| ranks.iter().map(|(_, rank)| rank[at]).min().unwrap_or(0));
    ranks
        .into_iter()
        .find(|(_, rank)| *rank == least)
        .map(|(name, _)| name.clone())
}

/// A name GNU refuses to touch: an absolute one, or one with a `..`.
fn dangerous(name: &[u8]) -> bool {
    name.starts_with(b"/") || name.split(|&b| b == b'/').any(|part| part == b"..")
}

/// The file a section patches by its own names, as GNU picks it: the
/// first choice that is not dangerous, each dangerous one said and left
/// out before choosing again; none when GNU would ask.
async fn pick(files: &Files, section: &Section<'_>, fresh: bool, deletes: bool) -> Option<Vec<u8>> {
    let mut names = section.names.clone();
    loop {
        let name = choose(files, &names, fresh, deletes).await?;
        if !dangerous(&name) {
            return Some(name);
        }
        files.say(&[b"Ignoring potentially dangerous file name ", &name]);
        names.retain(|other| *other != name);
    }
}

/// The best of the names that stand, else, for a patch that creates its
/// file, the best of those that need the fewest new directories, else,
/// for one that deletes its file, the best of them.
async fn choose(files: &Files, names: &[Vec<u8>], fresh: bool, deletes: bool) -> Option<Vec<u8>> {
    let mut standing = Vec::new();
    for name in names {
        if files.stands(name).await {
            standing.push(name);
        }
    }
    if !standing.is_empty() {
        return best(standing);
    }
    if fresh {
        let mut fewest = Vec::new();
        let mut least = usize::MAX;
        for name in names {
            let missing = files
                .missing(name)
                .await
                .map_or(usize::MAX, |dirs| dirs.len());
            if missing < least {
                least = missing;
                fewest.clear();
            }
            if missing == least {
                fewest.push(name);
            }
        }
        return best(fewest);
    }
    if deletes {
        return best(names);
    }
    None
}

fn ignored(files: &Files, total: usize) {
    let plural = if total == 1 { "" } else { "s" };
    files.say(&[format!("{total} out of {total} hunk{plural} ignored").as_bytes()]);
}

/// GNU's question when no file is found, answered as a run without a
/// terminal answers it: the section is skipped.
fn ask(files: &Files, config: &Config, lines: &[&[u8]], section: &Section<'_>) {
    files.say(&[format!("can't find file to patch at input line {}", section.at).as_bytes()]);
    files.say(&[if config.strip.is_some() {
        b"Perhaps you used the wrong -p or --strip option?"
    } else {
        b"Perhaps you should have used the -p or --strip option?"
    }]);
    let rule = b"--------------------------";
    files.say(&[b"The text leading up to this was:\n", rule]);
    for line in &lines[section.leading.clone()] {
        files.say(&[b"|", chomp(line)]);
    }
    files.say(&[
        rule,
        b"\nFile to patch: \nSkip this patch? [y] \nSkipping patch.",
    ]);
}

/// GNU's refusal of a patch that would create a file that holds lines
/// already, or delete one that is not there.
fn refuse(files: &Files, config: &Config, name: &[u8], creates: bool) {
    let (verb, why) = if creates {
        (&b"create"[..], &b"already exists"[..])
    } else {
        (&b"delete"[..], &b"does not exist"[..])
    };
    let when = if config.reverse {
        &b", when reversed,"[..]
    } else {
        b""
    };
    files.say(&[
        b"The next patch",
        when,
        b" would ",
        verb,
        b" the file ",
        name,
        b",",
    ]);
    let (ask, after) = apply::question(config.reverse, config.forward);
    files.say(&[b"which ", why, b"!", ask.as_bytes()]);
    for line in after {
        files.say(&[line.as_bytes()]);
    }
}

/// Stop the run where the patch could not be read, as GNU does, even past
/// a section it skipped: status 2.
fn fatal(files: &Files, end: &End) -> Result<(), i32> {
    let End::Fatal(why, cut) = end else {
        return Ok(());
    };
    if *cut {
        files.say(&[CUT.as_bytes()]);
    }
    files
        .host
        .warn(&[b"patch: **** ", &why[..], b"\n"].concat());
    Err(2)
}

/// A section GNU skips whole: its hunks counted as ignored, unless the
/// patch turned out unreadable while they were read.
fn skip(files: &Files, section: &Section<'_>) -> Result<bool, i32> {
    fatal(files, &section.end)?;
    if !section.hunks.is_empty() {
        ignored(files, section.hunks.len());
    }
    Ok(true)
}

/// A git rename or copy carried out, GNU's way, before its hunks: the file
/// it leaves for them, what the report says after its name, and, for a run
/// that only checks, the file the hunks are read from instead. A rename to
/// a name that stands already is taken as done; none when the patch names
/// no source and target or no source stands. Writing it or removing the
/// source failing stops the run with status 1.
async fn move_file(
    files: &mut Files,
    config: &Config,
    moved: &Move,
) -> Result<Option<(Vec<u8>, Vec<u8>, Option<Vec<u8>>)>, i32> {
    let (from, to) = if config.reverse {
        (&moved.to, &moved.from)
    } else {
        (&moved.from, &moved.to)
    };
    let (Some(from), Some(to)) = (from, to) else {
        return Ok(None);
    };
    let verb = if moved.copy {
        &b"copied"[..]
    } else {
        b"renamed"
    };
    if !moved.copy && files.stands(to).await {
        let note = [&b" (already "[..], verb, b" from ", from, b")"].concat();
        return Ok(Some((to.clone(), note, None)));
    }
    if !files.stands(from).await {
        return Ok(None);
    }
    let note = [&b" ("[..], verb, b" from ", from, b")"].concat();
    if files.dry_run {
        return Ok(Some((to.clone(), note, Some(from.clone()))));
    }
    let Ok(data) = files.whole(from, Opening::File).await else {
        return Ok(None);
    };
    let made = files.missing(to).await.unwrap_or_default();
    if !files.make(made).await || !files.write(to.clone(), data).await {
        return Err(1);
    }
    let path = from.clone();
    if !moved.copy && !files.change(Request::Unlink { path }, from).await {
        return Err(1);
    }
    Ok(Some((to.clone(), note, None)))
}

/// Apply one section to its file, GNU patch's way: whether a hunk of it
/// was refused, or the status to stop the run with when a write failed or
/// the patch is malformed. A file that does not match the patch exactly
/// is backed up to `.orig` the first time this run writes it, and the
/// hunks that did not go in are saved to `.rej`, after those an earlier
/// section of this run saved for it. A file that is not there is not made
/// unless a hunk applied, and a directory or a link is refused whole.
async fn patch_file(
    files: &mut Files,
    config: &Config,
    lines: &[&[u8]],
    section: &Section<'_>,
    done: &mut Done,
) -> Result<bool, i32> {
    if section.crlf {
        files.say(&[b"(Stripping trailing CRs from patch; use --binary to disable.)"]);
    }
    let git = section.git.clone().unwrap_or_default();
    if git.binary {
        let name = section.names.last().map_or(&b""[..], Vec::as_slice);
        files.say(&[b"File ", name, b": git binary diffs are not supported."]);
        return Ok(true);
    }
    let (from, to) = if config.reverse {
        (section.new_null, section.old_null)
    } else {
        (section.old_null, section.new_null)
    };
    let (creates, deletes) = (from && !to, to && !from);
    let first = section.hunks.first().map(|hunk| hunk.tried(config.reverse));
    let fresh = creates || first.is_some_and(|hunk| hunk.old_start == 0 && hunk.sizes().0 == 0);
    let mut how = Vec::new();
    let mut source = None;
    let picked = match (&git.moved, &config.file) {
        (Some(moved), _) => match move_file(files, config, moved).await? {
            Some((name, note, from)) => {
                (how, source) = (note, from);
                Some(name)
            }
            None => {
                let verb = if moved.copy { &b"copy"[..] } else { b"rename" };
                files.say(&[b"Cannot ", verb, b" file without two valid file names"]);
                return Ok(true);
            }
        },
        (None, Some(file)) => Some(file.clone()),
        (None, None) => pick(files, section, fresh, deletes).await,
    };
    let Some(name) = picked else {
        ask(files, config, lines, section);
        return skip(files, section);
    };
    let read = source.as_ref().unwrap_or(&name).clone();
    let original = match files.whole(&read, Opening::File).await {
        Ok(original) => Some(original),
        Err(reply) if reply.names(&["EISDIR", "ELOOP"]) => {
            files.say(&[
                b"File ",
                &name,
                b" is not a regular file -- refusing to patch",
            ]);
            fatal(files, &section.end)?;
            let rejected = apply::as_tried(&section.hunks, config.reverse);
            return save_rejects(files, config, section, &rejected, "ignored", &name, done)
                .await
                .then_some(true)
                .ok_or(1);
        }
        Err(_) => None,
    };
    if (creates && original.as_ref().is_some_and(|text| !text.is_empty()))
        || (deletes && original.is_none())
    {
        refuse(files, config, &name, creates);
        return skip(files, section);
    }
    let made = match original {
        Some(_) => Vec::new(),
        None => match files.missing(&name).await {
            Some(made) => made,
            None => {
                files.say(&[b"Invalid file name ", &name, b" -- skipping patch"]);
                fatal(files, &section.end)?;
                return Ok(true);
            }
        },
    };
    let verb = if config.dry_run {
        &b"checking file "[..]
    } else {
        b"patching file "
    };
    files.say(&[verb, &name, &how]);
    let text = parse::lines(original.as_deref().unwrap_or_default());
    let outcome = apply::section(&text, &section.hunks, config.reverse, config.forward);
    for note in &outcome.notes {
        files.say(&[note.as_bytes()]);
    }
    fatal(files, &section.end)?;
    let mut refused = false;
    let mut gone = false;
    if let Some(patched) = &outcome.lines {
        let patched = apply::text(patched);
        if !outcome.exact && !done.written.contains(&name) && !config.dry_run {
            match &original {
                None => files.say(&[b"Cannot stat file ", &name, b", skipping backup"]),
                Some(original) => {
                    let backup = [&name[..], b".orig"].concat();
                    if !files.write(backup, original.clone()).await {
                        return Err(1);
                    }
                }
            }
        }
        if deletes && patched.is_empty() {
            remove(files, &name, config.file.is_none()).await?;
            gone = true;
        } else {
            // A section with no hunks writes only the empty file it makes.
            let writes = if section.hunks.is_empty() {
                creates && original.is_none()
            } else {
                original.is_some() || outcome.rejected.len() < section.hunks.len()
            };
            if writes {
                if !files.make(made).await || !files.write(name.clone(), patched).await {
                    return Err(1);
                }
                done.written.insert(name.clone());
            }
            if deletes {
                files.say(&[
                    b"Not deleting file ",
                    &name,
                    b" as content differs from patch",
                ]);
                refused = true;
            }
        }
    }
    let mode = if config.reverse {
        git.old_mode
    } else {
        git.new_mode
    };
    if let Some(mode) = mode.filter(|_| !gone) {
        if !files.chmod(&name, mode).await {
            return Err(1);
        }
    }
    let cut = section.end == End::Cut;
    if cut {
        files.say(&[CUT.as_bytes()]);
    }
    if !outcome.rejected.is_empty() {
        let verb = if outcome.lines.is_none() {
            "ignored"
        } else {
            "FAILED"
        };
        if !save_rejects(files, config, section, &outcome.rejected, verb, &name, done).await {
            return Err(1);
        }
        refused = true;
    }
    if cut {
        files.say(&[CUT.as_bytes()]);
    }
    Ok(refused)
}

/// Delete a file the patch emptied, and, for a name the patch gave, each
/// directory above it that it leaves empty, as GNU does; a `.` names no
/// directory of the name's own, and a `..` ends the walk.
async fn remove(files: &Files, name: &[u8], parents: bool) -> Result<(), i32> {
    if files.dry_run {
        return Ok(());
    }
    let path = name.to_vec();
    if !files.change(Request::Unlink { path }, name).await {
        return Err(1);
    }
    if !parents {
        return Ok(());
    }
    let mut dir = name;
    while let Some(at) = memchr::memrchr(b'/', dir) {
        dir = &dir[..at];
        match dir.rsplit(|&b| b == b'/').next().unwrap_or(dir) {
            b"" | b"." => continue,
            b".." => break,
            _ => {}
        }
        let path = dir.to_vec();
        if failed(&files.host.ask(Request::Rmdir { path }).await.0) {
            break;
        }
    }
    Ok(())
}

/// Write the hunks that did not go in to `.rej`, and say so; false when
/// the write failed. A file patched by several sections of one patch keeps
/// one `.rej`: each section's rejects follow the last, under their own
/// names, which `-R` swaps as it did the hunks.
async fn save_rejects(
    files: &Files,
    config: &Config,
    section: &Section<'_>,
    rejected: &[(parse::Hunk<'_>, i64)],
    verb: &str,
    name: &[u8],
    done: &mut Done,
) -> bool {
    let total = section.hunks.len();
    let plural = if total == 1 { "" } else { "s" };
    let counts = format!("{} out of {total} hunk{plural} {verb}", rejected.len());
    if files.dry_run {
        files.say(&[counts.as_bytes()]);
        return true;
    }
    files.say(&[
        counts.as_bytes(),
        b" -- saving rejects to file ",
        name,
        b".rej",
    ]);
    let (first, second) = if config.reverse {
        (&section.new_label, &section.old_label)
    } else {
        (&section.old_label, &section.new_label)
    };
    let path = [name, b".rej"].concat();
    let text = done.rejects.entry(path.clone()).or_default();
    for (lead, label) in [(b"--- ", first), (b"+++ ", second)] {
        text.extend_from_slice(lead);
        text.extend_from_slice(label);
        text.push(b'\n');
    }
    for (hunk, grown) in rejected {
        apply::reject(hunk, *grown, text);
    }
    let text = text.clone();
    files.write(path, text).await
}
