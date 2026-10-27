//! patch as GNU patch 2.8 applies a unified diff, as mirage models it:
//! the patch read whole as the run's input (`-`), each file section's
//! hunks placed with GNU's offsets and fuzz, and each file, its `.orig`
//! backup and its `.rej` rejects read and written whole through the host,
//! by the name the report gives them. Lines keep the newline they end
//! with, so a file's last line without one stays so, and a `\` line in
//! the patch marks the line before it as having none. Divergence: a patch
//! whose last line has no newline is read as if it had one (GNU notes it,
//! and refuses a last `+` line as malformed).

mod apply;
mod parse;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::request::{Opening, Reply, Request, WriteMode, bytes, read_failure};
use crate::task::{self, Host};
use crate::{Stream, StreamError, parse_config};

use self::parse::Section;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// `-p`: the leading components dropped from the patch's names.
    #[serde(deserialize_with = "crate::saturating_usize")]
    strip: usize,
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

    /// Write a file whole; false, with the failure said, when the host
    /// could not.
    async fn write(&self, path: Vec<u8>, data: Vec<u8>) -> bool {
        let name = path.clone();
        let mode = WriteMode::Whole;
        let (reply, _) = self.host.ask(Request::Write { path, mode, data }).await;
        if failed(&reply) {
            self.host.warn(&read_failure(b"patch", &name, &reply));
        }
        !failed(&reply)
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
    let mut patch = match files.whole(b"-", Opening::Name).await {
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
    if patch.last().is_some_and(|&last| last != b'\n') {
        patch.push(b'\n');
    }
    let lines = parse::lines(&patch);
    let sections = parse::sections(&lines, config.strip);
    if sections.is_empty() && !patch.is_empty() {
        files
            .host
            .warn(b"patch: **** Only garbage was found in the patch input.\n");
        return 2;
    }
    let mut done = Done::default();
    let mut status = 0;
    for section in &sections {
        let name = config.file.as_deref().unwrap_or(&section.target);
        match patch_file(&mut files, &config, section, name, &mut done).await {
            Some(true) => status = 1,
            Some(false) => {}
            None => return 1,
        }
    }
    status
}

/// Apply one section to its file, GNU patch's way: whether a hunk of it
/// was refused, None when a write failed. A file that does not match the
/// patch exactly is backed up to `.orig` the first time this run writes
/// it, and the hunks that did not go in are saved to `.rej`, after those
/// an earlier section of this run saved for it. A file that is not there
/// is not made unless a hunk applied, and a directory is refused whole.
async fn patch_file(
    files: &mut Files,
    config: &Config,
    section: &Section<'_>,
    name: &[u8],
    done: &mut Done,
) -> Option<bool> {
    let original = match files.whole(name, Opening::File).await {
        Ok(original) => Some(original),
        Err(reply) if reply.names(&["EISDIR"]) => {
            files.say(&[
                b"File ",
                name,
                b" is not a regular file -- refusing to patch",
            ]);
            let rejected = apply::as_tried(&section.hunks, config.reverse);
            return save_rejects(files, config, section, &rejected, "ignored", name, done)
                .await
                .then_some(true);
        }
        Err(_) => None,
    };
    files.say(&[b"patching file ", name]);
    let lines = parse::lines(original.as_deref().unwrap_or_default());
    let outcome = apply::section(&lines, &section.hunks, config.reverse, config.forward);
    for note in &outcome.notes {
        files.say(&[note.as_bytes()]);
    }
    if let Some(patched) = &outcome.lines {
        if !outcome.exact && !done.written.contains(name) {
            match &original {
                None => files.say(&[b"Cannot stat file ", name, b", skipping backup"]),
                Some(original) => {
                    let backup = [name, b".orig"].concat();
                    if !files.write(backup, original.clone()).await {
                        return None;
                    }
                }
            }
        }
        if original.is_some() || outcome.rejected.len() < section.hunks.len() {
            if !files.write(name.to_vec(), apply::text(patched)).await {
                return None;
            }
            done.written.insert(name.to_vec());
        }
    }
    if outcome.rejected.is_empty() {
        return Some(false);
    }
    let verb = if outcome.lines.is_none() {
        "ignored"
    } else {
        "FAILED"
    };
    save_rejects(files, config, section, &outcome.rejected, verb, name, done)
        .await
        .then_some(true)
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
