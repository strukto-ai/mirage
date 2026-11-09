//! `-r`, `-u` and `--delete`: the archive read a member at a time and
//! written again as it is read, what `--delete` selects left out and what
//! `-r` and `-u` add put where its end marker stood. The file changes only
//! once the whole of it is written.

use std::collections::HashMap;

use super::create::{self, Output};
use super::header::{self, Block, Pax};
use super::read::{Input, Raw, Selection, trimmed};
use super::{Codec, Config, FAILED, FATAL, Mode, TRAILER, lines, open_failure};
use crate::request::{Opening, Request, WriteMode, failed};
use crate::task::Host;

/// The most data of one meta header a run holds.
const MAX_META: u64 = 1 << 30;

pub(super) async fn run(host: &Host, config: &Config) -> i32 {
    if config.abandon {
        host.warn(&lines(&config.notices));
        return config.status;
    }
    let delete = config.mode == Mode::Delete;
    let to_stdout = config.archive == b"-";
    let opening = if to_stdout {
        (b"-".to_vec(), Opening::Name)
    } else {
        (config.archive.clone(), Opening::Operand(1))
    };
    let mut raw = Raw::new(host, opening);
    raw.gather(6).await;
    let mut absent = false;
    if let Some(mut reply) = raw.error.take() {
        if config.probe
            && reply.names(&["ENOENT"])
            && host.stat(&config.archive).await.as_deref() == Some("dir")
        {
            reply.error = Some("Is a directory".into());
            reply.errno = Some("EISDIR".into());
        }
        if reply.names(&["EISDIR"]) {
            let name = &config.archive;
            let line = [b"tar: ", &name[..], b": Cannot read: Bad file descriptor"].concat();
            let rest: [&[u8]; 2] = [b"tar: At beginning of tape, quitting now", FATAL.as_bytes()];
            host.warn(&[lines(&[line.as_slice()]), lines(&rest)].concat());
            return FAILED;
        }
        if !reply.names(&["ENOENT"]) {
            host.warn(&open_failure(config, &reply, true));
            return FAILED;
        }
        absent = true;
    }
    if Codec::sniff(raw.unused()).is_some() {
        host.warn(format!("tar: Cannot update compressed archives\n{FATAL}\n").as_bytes());
        return FAILED;
    }
    let mut out = Output::new(host, (!to_stdout).then(|| config.output.clone()), None);
    let writes_file = !to_stdout && !(delete && absent);
    if writes_file {
        let (path, mode, data) = (config.output.clone(), WriteMode::Replace, Vec::new());
        let (reply, _) = host.ask(Request::Write { path, mode, data }).await;
        if failed(&reply) {
            host.warn(&open_failure(config, &reply, false));
            return FAILED;
        }
    }
    let mut input = Input::plain(raw);
    let mut selection = Selection::new(config);
    let mut notices: Vec<Vec<u8>> = Vec::new();
    let mut latest: HashMap<Vec<u8>, i64> = HashMap::new();
    let (mut skipping, mut corrupt, mut cut, mut marked) = (false, false, false, false);
    let mut meta: Vec<u8> = Vec::new();
    let (mut long_name, mut pax, mut global) = (None, Pax::default(), Pax::default());
    while let Some(block) = input.block().await {
        let index = input.taken();
        let (mut member, flag) = match header::decode(&block) {
            Block::Zero => {
                marked = true;
                break;
            }
            Block::Bad(said) => {
                notices.extend(said);
                if index == 1 {
                    notices.push(b"tar: This does not look like a tar archive".to_vec());
                }
                if !std::mem::replace(&mut skipping, true) {
                    notices.push(b"tar: Skipping to next header".to_vec());
                }
                corrupt = true;
                if !delete {
                    out.put(&block).await;
                }
                continue;
            }
            Block::Head(member, flag, said) => {
                corrupt |= !said.is_empty();
                notices.extend(said);
                (member, flag)
            }
        };
        skipping = false;
        if matches!(flag, b'L' | b'K' | b'x' | b'g') {
            if member.size > MAX_META {
                cut = true;
                break;
            }
            let Some(data) = input.whole(member.size).await else {
                cut = true;
                break;
            };
            meta.extend_from_slice(&block);
            meta.extend_from_slice(&data);
            meta.resize(meta.len() + header::padding(member.size), 0);
            let text = &data[..data.iter().position(|&b| b == 0).unwrap_or(data.len())];
            match flag {
                b'L' => long_name = Some(text.to_vec()),
                b'K' => {}
                b'x' => pax.read(&data),
                _ => global.read(&data),
            }
            continue;
        }
        let mut more = flag == b'S' && block[482] != 0;
        let mut head = block;
        while more {
            let Some(next) = input.block().await else {
                cut = true;
                break;
            };
            more = next[504] != 0;
            head.extend_from_slice(&next);
        }
        if cut {
            break;
        }
        member.name = long_name.take().unwrap_or(member.name);
        global.apply(&mut member);
        std::mem::take(&mut pax).apply(&mut member);
        let gone = delete && selection.hit(&member.name);
        if gone {
            meta.clear();
            if !input.skip(member.size).await {
                cut = true;
                break;
            }
            continue;
        }
        if config.mode == Mode::Update {
            latest.insert(trimmed(&member.name).to_vec(), member.mtime);
        }
        out.put(&std::mem::take(&mut meta)).await;
        out.put(&head).await;
        if !input.pass(member.size, &mut out).await {
            cut = true;
            break;
        }
    }
    if let Some(reply) = input.raw.error.take() {
        host.warn(&open_failure(config, &reply, true));
        return FAILED;
    }
    if cut {
        notices.push(b"tar: Unexpected EOF in archive".to_vec());
        notices.push(FATAL.into());
        host.warn(&lines(&notices));
        return FAILED;
    }
    if delete {
        let misses = selection.misses();
        let failed_run = corrupt || !misses.is_empty();
        for miss in &misses {
            notices.push([b"tar: ", &miss[..], b": Not found in archive"].concat());
        }
        // A list of what is left goes out unless the archive could not be
        // read through; one that was not there is left empty.
        if absent && !to_stdout {
            let path = config.output.clone();
            let (mode, data) = (WriteMode::Create, Vec::new());
            host.ask(Request::Write { path, mode, data }).await;
            let path = Some(config.output.clone());
            host.ask(Request::Flush { path }).await;
        } else if !corrupt {
            out.finish().await;
        }
        if failed_run {
            notices.push(TRAILER.into());
        }
        host.warn(&lines(&notices));
        if !corrupt {
            if let Some(reply) = &out.failure {
                host.warn(&open_failure(config, reply, false));
                return FAILED;
            }
        }
        return if failed_run { FAILED } else { 0 };
    }
    // What stands before the new members is left as it was, a short tail
    // included; the record pads only what is written after it.
    let tail = if marked { Vec::new() } else { input.rest() };
    out.put(&tail).await;
    if corrupt || !tail.is_empty() {
        out.reset_record();
    }
    let latest = (config.mode == Mode::Update).then_some(&latest);
    let mut written = create::members(&mut out, config, latest).await;
    written.notices.splice(0..0, notices);
    if corrupt {
        written.status = FAILED;
    }
    out.finish().await;
    create::report(host, config, &out, written, false)
}
