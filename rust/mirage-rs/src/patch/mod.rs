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

use self::parse::{CUT, End, Section, chomp};

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
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(task::spawn(|host| run(host, config)))
}

fn failed(reply: &Reply) -> bool {
    reply.error.is_some() || reply.errno.is_some() || reply.line.is_some()
}

/// The run's files on its host: each read whole, on a descriptor of its
/// own, and each written whole.
struct Files {
    host: Host,
    fds: u32,
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

    /// The directories above a name that do not stand yet, outermost
    /// first.
    async fn missing(&self, name: &[u8]) -> Vec<Vec<u8>> {
        let mut missing = Vec::new();
        for (at, _) in name.iter().enumerate().filter(|&(_, &b)| b == b'/') {
            let dir = &name[..at];
            if !dir.ends_with(b"/") && (!missing.is_empty() || self.host.stat(dir).await.is_none())
            {
                missing.push(dir.to_vec());
            }
        }
        missing
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
    let mut files = Files { host, fds: 0 };
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
    let (patch, crlf) = parse::strip_crs(&raw);
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

/// The file a section patches by its own names: the best of those that
/// stand, else, for a patch that creates its file, the best of those that
/// need the fewest new directories, else, for one that deletes its file,
/// the best of them; none when GNU would ask.
async fn pick(files: &Files, section: &Section<'_>, fresh: bool, deletes: bool) -> Option<Vec<u8>> {
    let mut standing = Vec::new();
    for name in &section.names {
        if files.host.stat(name).await.is_some() {
            standing.push(name);
        }
    }
    if !standing.is_empty() {
        return best(standing);
    }
    if fresh {
        let mut fewest = Vec::new();
        let mut least = usize::MAX;
        for name in &section.names {
            let missing = files.missing(name).await.len();
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
        return best(&section.names);
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
    files.say(&[b"The text leading up to this was:"]);
    files.say(&[b"--------------------------"]);
    for line in &lines[section.leading.clone()] {
        files.say(&[b"|", chomp(line)]);
    }
    files.say(&[b"--------------------------"]);
    files.say(&[b"File to patch: "]);
    files.say(&[b"Skip this patch? [y] "]);
    files.say(&[b"Skipping patch."]);
    ignored(files, section.hunks.len());
}

/// GNU's refusal of a patch that would create a file that holds lines
/// already, or delete one that is not there.
fn refuse(files: &Files, section: &Section<'_>, name: &[u8], creates: bool) {
    let (verb, why) = if creates {
        (&b"create"[..], &b"already exists"[..])
    } else {
        (&b"delete"[..], &b"does not exist"[..])
    };
    files.say(&[b"The next patch would ", verb, b" the file ", name, b","]);
    files.say(&[b"which ", why, b"!  Assume -R? [n] "]);
    files.say(&[b"Apply anyway? [n] "]);
    files.say(&[b"Skipping patch."]);
    ignored(files, section.hunks.len());
}

fn malformed(files: &Files, end: &End) -> Option<i32> {
    let End::Malformed(line, text, cut) = end else {
        return None;
    };
    if *cut {
        files.say(&[CUT.as_bytes()]);
    }
    let at = format!("patch: **** malformed patch at line {line}: ");
    files.host.warn(&[at.as_bytes(), text, b"\n"].concat());
    Some(2)
}

/// Apply one section to its file, GNU patch's way: whether a hunk of it
/// was refused, or the status to stop the run with when a write failed or
/// the patch is malformed. A file that does not match the patch exactly
/// is backed up to `.orig` the first time this run writes it, and the
/// hunks that did not go in are saved to `.rej`, after those an earlier
/// section of this run saved for it. A file that is not there is not made
/// unless a hunk applied, and a directory is refused whole.
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
    let (from, to) = if config.reverse {
        (section.new_null, section.old_null)
    } else {
        (section.old_null, section.new_null)
    };
    let (creates, deletes) = (from && !to, to && !from);
    let first = section.hunks.first().map(|hunk| hunk.tried(config.reverse));
    let fresh = creates || first.is_some_and(|hunk| hunk.old_start == 0 && hunk.sizes().0 == 0);
    let picked = match &config.file {
        Some(file) => Some(file.clone()),
        None => pick(files, section, fresh, deletes).await,
    };
    let Some(name) = picked else {
        ask(files, config, lines, section);
        return malformed(files, &section.end).map_or(Ok(true), Err);
    };
    let original = match files.whole(&name, Opening::File).await {
        Ok(original) => Some(original),
        Err(reply) if reply.names(&["EISDIR"]) => {
            files.say(&[
                b"File ",
                &name,
                b" is not a regular file -- refusing to patch",
            ]);
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
        refuse(files, section, &name, creates);
        return Ok(true);
    }
    files.say(&[b"patching file ", &name]);
    let text = parse::lines(original.as_deref().unwrap_or_default());
    let outcome = apply::section(&text, &section.hunks, config.reverse, config.forward);
    for note in &outcome.notes {
        files.say(&[note.as_bytes()]);
    }
    if let Some(stop) = malformed(files, &section.end) {
        return Err(stop);
    }
    let mut refused = false;
    if let Some(patched) = &outcome.lines {
        let patched = apply::text(patched);
        if deletes && patched.is_empty() {
            remove(files, &name, config.file.is_none()).await?;
        } else {
            if !outcome.exact && !done.written.contains(&name) {
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
            if original.is_some() || outcome.rejected.len() < section.hunks.len() {
                if original.is_none() {
                    for dir in files.missing(&name).await {
                        files.host.ask(Request::Mkdir { path: dir }).await;
                    }
                }
                if !files.write(name.clone(), patched).await {
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
/// directory above it that it leaves empty, as GNU does.
async fn remove(files: &Files, name: &[u8], parents: bool) -> Result<(), i32> {
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
        let path = dir.to_vec();
        if dir.is_empty() || failed(&files.host.ask(Request::Rmdir { path }).await.0) {
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
    let counts = format!(
        "{} out of {total} hunk{plural} {verb} -- saving rejects to file ",
        rejected.len()
    );
    files.say(&[counts.as_bytes(), name, b".rej"]);
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
