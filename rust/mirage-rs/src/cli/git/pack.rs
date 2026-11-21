//! A git packfile scanned as it arrives, for the index git writes beside
//! it, as `git index-pack` reads its input: each object's offset, where its
//! compressed bytes start and end, the CRC-32 of its whole entry and, for an
//! object stored whole, its id. A delta is listed with its base, an offset
//! or an id, since its own id needs the base's bytes, which the host reads
//! back from the stored pack. Nothing is held but one entry's header:
//! compressed data is inflated through a fixed window, hashed and dropped.
//!
//! One line per object, `offset data end crc kind base`, where `base` is
//! the object's id for kinds 1 to 4, the base's offset for an offset delta
//! (6) and the base's id for a reference delta (7); then, at the end, the
//! pack's checksum, once the trailer is checked against it.

use flate2::{Crc, Decompress, FlushDecompress, Status};
use serde::Deserialize;
use sha1::{Digest, Sha1};

use crate::{Stream, StreamError, parse_config};

const SIGNATURE: &[u8] = b"PACK";
const HEADER: usize = 12;
const ID: usize = 20;
const WINDOW: usize = 1 << 15;
const OFS_DELTA: u8 = 6;
const REF_DELTA: u8 = 7;
const KINDS: [&str; 4] = ["commit", "tree", "blob", "tag"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config {} = parse_config(config)?;
    Ok(Box::new(Scanner {
        held: Vec::new(),
        at: 0,
        pack: Sha1::new(),
        phase: Phase::Header,
        left: 0,
        current: None,
        window: vec![0; WINDOW],
    }))
}

#[derive(PartialEq)]
enum Phase {
    Header,
    Entry,
    Data,
    Trailer,
    Done,
}

enum Base {
    Whole,
    Offset(u64),
    Id([u8; ID]),
}

/// The entry being inflated.
struct Current {
    offset: u64,
    data: u64,
    kind: u8,
    size: u64,
    base: Base,
    crc: Crc,
    id: Option<Sha1>,
    z: Decompress,
}

struct Scanner {
    /// Input not consumed yet: at most one entry header and a chunk.
    held: Vec<u8>,
    /// The pack offset of `held[0]`.
    at: u64,
    /// Every byte ahead of the trailer.
    pack: Sha1,
    phase: Phase,
    /// Objects still to come.
    left: u32,
    current: Option<Box<Current>>,
    window: Vec<u8>,
}

fn hex(bytes: &[u8], out: &mut Vec<u8>) {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)]);
        out.push(DIGITS[usize::from(byte & 15)]);
    }
}

fn bad(offset: u64, why: &str) -> StreamError {
    StreamError::new(format!("pack has bad object at offset {offset}: {why}"))
}

/// One entry's header, as far as `rest` holds it: its length, kind, size
/// and base; `None` until all of it has arrived.
fn entry_header(rest: &[u8], offset: u64) -> Result<Option<(usize, u8, u64, Base)>, StreamError> {
    let Some(&first) = rest.first() else {
        return Ok(None);
    };
    let kind = (first >> 4) & 7;
    let mut size = u64::from(first & 15);
    let mut shift = 4;
    let mut at = 1;
    let mut byte = first;
    while byte & 0x80 != 0 {
        let Some(&next) = rest.get(at) else {
            return Ok(None);
        };
        if shift > 57 {
            return Err(bad(offset, "bad object header"));
        }
        size |= u64::from(next & 0x7f) << shift;
        shift += 7;
        at += 1;
        byte = next;
    }
    let base = match kind {
        1..=4 => Base::Whole,
        OFS_DELTA => {
            let Some(&first) = rest.get(at) else {
                return Ok(None);
            };
            at += 1;
            let mut back = u64::from(first & 0x7f);
            let mut byte = first;
            while byte & 0x80 != 0 {
                let Some(&next) = rest.get(at) else {
                    return Ok(None);
                };
                at += 1;
                back = back
                    .checked_add(1)
                    .and_then(|n| n.checked_mul(128))
                    .ok_or_else(|| bad(offset, "delta base offset is out of bound"))?
                    | u64::from(next & 0x7f);
                byte = next;
            }
            if back == 0 || back > offset {
                return Err(bad(offset, "delta base offset is out of bound"));
            }
            Base::Offset(offset - back)
        }
        REF_DELTA => {
            let Some(id) = rest.get(at..at + ID) else {
                return Ok(None);
            };
            at += ID;
            let mut base = [0; ID];
            base.copy_from_slice(id);
            Base::Id(base)
        }
        other => return Err(bad(offset, &format!("unknown object type {other}"))),
    };
    Ok(Some((at, kind, size, base)))
}

impl Scanner {
    /// Take what `rest` holds of the current phase; returns how many bytes
    /// it consumed and whether it made any progress.
    fn step(&mut self, rest: &[u8], out: &mut Vec<u8>) -> Result<(usize, bool), StreamError> {
        match self.phase {
            Phase::Header => {
                if rest.len() < HEADER {
                    return Ok((0, false));
                }
                if &rest[..4] != SIGNATURE {
                    return Err(StreamError::new("protocol error: bad pack header"));
                }
                let version = u32::from_be_bytes([rest[4], rest[5], rest[6], rest[7]]);
                if version != 2 && version != 3 {
                    return Err(StreamError::new(format!(
                        "pack version {version} unsupported"
                    )));
                }
                self.left = u32::from_be_bytes([rest[8], rest[9], rest[10], rest[11]]);
                self.pack.update(&rest[..HEADER]);
                self.phase = if self.left == 0 {
                    Phase::Trailer
                } else {
                    Phase::Entry
                };
                Ok((HEADER, true))
            }
            Phase::Entry => {
                let Some((length, kind, size, base)) = entry_header(rest, self.at)? else {
                    return Ok((0, false));
                };
                let mut crc = Crc::new();
                crc.update(&rest[..length]);
                self.pack.update(&rest[..length]);
                let id = (1..=4).contains(&kind).then(|| {
                    let mut id = Sha1::new();
                    id.update(format!("{} {size}\0", KINDS[usize::from(kind - 1)]).as_bytes());
                    id
                });
                self.current = Some(Box::new(Current {
                    offset: self.at,
                    data: self.at + length as u64,
                    kind,
                    size,
                    base,
                    crc,
                    id,
                    z: Decompress::new(true),
                }));
                self.phase = Phase::Data;
                Ok((length, true))
            }
            Phase::Data => {
                let Some(current) = self.current.as_mut() else {
                    return Err(StreamError::new("pack scanner lost its entry"));
                };
                let (was_in, was_out) = (current.z.total_in(), current.z.total_out());
                let status = current
                    .z
                    .decompress(rest, &mut self.window, FlushDecompress::None)
                    .map_err(|_| bad(current.offset, "inflate returned -3"))?;
                let took = usize::try_from(current.z.total_in() - was_in).unwrap_or(rest.len());
                let made = usize::try_from(current.z.total_out() - was_out).unwrap_or(0);
                if let Some(id) = current.id.as_mut() {
                    id.update(&self.window[..made]);
                }
                current.crc.update(&rest[..took]);
                self.pack.update(&rest[..took]);
                let wrote = current.z.total_out();
                if wrote > current.size || (status == Status::StreamEnd && wrote != current.size) {
                    return Err(bad(current.offset, "inflate returned 1"));
                }
                if status == Status::StreamEnd {
                    let end = self.at + took as u64;
                    let row = format!(
                        "{} {} {end} {} {} ",
                        current.offset,
                        current.data,
                        current.crc.sum(),
                        current.kind
                    );
                    out.extend_from_slice(row.as_bytes());
                    match &current.base {
                        Base::Whole => {
                            let id = current.id.take().map(Sha1::finalize).unwrap_or_default();
                            hex(&id, out);
                        }
                        Base::Offset(base) => out.extend_from_slice(base.to_string().as_bytes()),
                        Base::Id(base) => hex(base, out),
                    }
                    out.push(b'\n');
                    self.current = None;
                    self.left -= 1;
                    self.phase = if self.left == 0 {
                        Phase::Trailer
                    } else {
                        Phase::Entry
                    };
                    return Ok((took, true));
                }
                Ok((took, took > 0 || made > 0))
            }
            Phase::Trailer => {
                if rest.len() < ID {
                    return Ok((0, false));
                }
                let sum = self.pack.finalize_reset();
                if rest[..ID] != sum[..] {
                    return Err(StreamError::new("pack is corrupted (SHA1 mismatch)"));
                }
                hex(&sum, out);
                out.push(b'\n');
                self.phase = Phase::Done;
                Ok((ID, true))
            }
            Phase::Done => {
                if rest.is_empty() {
                    Ok((0, false))
                } else {
                    Err(StreamError::new("pack has junk at the end"))
                }
            }
        }
    }
}

impl Stream for Scanner {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut held = std::mem::take(&mut self.held);
        held.extend_from_slice(input);
        let mut used = 0;
        let result = loop {
            match self.step(&held[used..], out) {
                Ok((took, moved)) => {
                    used += took;
                    self.at += took as u64;
                    if !moved {
                        break Ok(());
                    }
                }
                Err(err) => break Err(err),
            }
        };
        held.drain(..used);
        self.held = held;
        result
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed(&[], out)?;
        if self.phase == Phase::Done {
            Ok(())
        } else {
            Err(StreamError::new("early EOF"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::ZlibEncoder;

    use super::*;
    use crate::run;

    fn deflated(data: &[u8]) -> Vec<u8> {
        let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
        z.write_all(data).expect("deflates");
        z.finish().expect("deflates")
    }

    fn entry_head(kind: u8, size: usize) -> Vec<u8> {
        let mut size = size as u64;
        let mut first = (kind << 4) | (size & 15) as u8;
        size >>= 4;
        let mut out = Vec::new();
        while size > 0 {
            out.push(first | 0x80);
            first = (size & 0x7f) as u8;
            size >>= 7;
        }
        out.push(first);
        out
    }

    fn hexed(bytes: &[u8]) -> String {
        let mut out = Vec::new();
        hex(bytes, &mut out);
        String::from_utf8(out).expect("hex")
    }

    /// A pack of a blob, an offset delta on it and a big blob, with
    /// the lines the scanner should print for it.
    fn sample() -> (Vec<u8>, String) {
        let small = b"hello\n".to_vec();
        let big: Vec<u8> = (0..70_000u32).map(|n| (n % 251) as u8).collect();
        let delta = vec![6, 7, 0x91, 0, 6, 1, b'!'];
        let mut pack = b"PACK\0\0\0\x02\0\0\0\x03".to_vec();
        let mut lines = String::new();
        for (kind, body, base) in [
            (3u8, &small, None),
            (OFS_DELTA, &delta, Some(12u64)),
            (3, &big, None),
        ] {
            let offset = pack.len() as u64;
            let mut entry = entry_head(kind, body.len());
            if let Some(base) = base {
                let back = offset - base;
                assert!(back < 128);
                entry.push(back as u8);
            }
            let data = offset + entry.len() as u64;
            entry.extend(deflated(body));
            let mut crc = Crc::new();
            crc.update(&entry);
            pack.extend(&entry);
            let tail = match base {
                Some(base) => base.to_string(),
                None => {
                    let mut id = Sha1::new();
                    id.update(format!("blob {}\0", body.len()).as_bytes());
                    id.update(body);
                    hexed(&id.finalize())
                }
            };
            lines += &format!(
                "{offset} {data} {} {} {kind} {tail}\n",
                pack.len(),
                crc.sum()
            );
        }
        let sum = Sha1::digest(&pack);
        pack.extend_from_slice(&sum);
        lines += &format!("{}\n", hexed(&sum));
        (pack, lines)
    }

    #[test]
    fn lists_each_object_and_the_checksum() {
        let (pack, lines) = sample();
        let (out, err) = run("git_pack", "{}", &[&pack]);
        assert!(err.is_none(), "{:?}", err.map(|e| e.message));
        assert_eq!(String::from_utf8(out).expect("text"), lines);
    }

    #[test]
    fn reads_the_same_a_byte_at_a_time() {
        let (pack, lines) = sample();
        let bytes: Vec<&[u8]> = pack.chunks(1).collect();
        let (out, err) = run("git_pack", "{}", &bytes);
        assert!(err.is_none());
        assert_eq!(String::from_utf8(out).expect("text"), lines);
    }

    #[test]
    fn a_reference_delta_names_its_base() {
        let mut pack = b"PACK\0\0\0\x02\0\0\0\x01".to_vec();
        let mut entry = entry_head(REF_DELTA, 3);
        entry.extend([0xab; ID]);
        entry.extend(deflated(b"abc"));
        let mut crc = Crc::new();
        crc.update(&entry);
        pack.extend(&entry);
        let end = pack.len();
        let sum = Sha1::digest(&pack);
        pack.extend_from_slice(&sum);
        let (out, err) = run("git_pack", "{}", &[&pack]);
        assert!(err.is_none());
        let text = String::from_utf8(out).expect("text");
        let first = text.lines().next().expect("a line");
        assert_eq!(
            first,
            format!("12 33 {end} {} 7 {}", crc.sum(), "ab".repeat(ID))
        );
    }

    #[test]
    fn an_empty_pack_is_its_checksum() {
        let mut pack = b"PACK\0\0\0\x02\0\0\0\0".to_vec();
        let sum = Sha1::digest(&pack);
        pack.extend_from_slice(&sum);
        let (out, err) = run("git_pack", "{}", &[&pack]);
        assert!(err.is_none());
        assert_eq!(
            String::from_utf8(out).expect("text"),
            format!("{}\n", hexed(&sum))
        );
    }

    #[test]
    fn refuses_a_short_pack() {
        let (pack, _) = sample();
        let (_, err) = run("git_pack", "{}", &[&pack[..pack.len() - 5]]);
        assert_eq!(err.expect("refused").message, "early EOF");
    }

    #[test]
    fn refuses_a_bad_checksum() {
        let (mut pack, _) = sample();
        let last = pack.len() - 1;
        pack[last] ^= 1;
        let (_, err) = run("git_pack", "{}", &[&pack]);
        assert_eq!(
            err.expect("refused").message,
            "pack is corrupted (SHA1 mismatch)"
        );
    }

    #[test]
    fn refuses_junk_after_the_trailer() {
        let (mut pack, _) = sample();
        pack.push(0);
        let (_, err) = run("git_pack", "{}", &[&pack]);
        assert_eq!(err.expect("refused").message, "pack has junk at the end");
    }

    #[test]
    fn refuses_an_unknown_kind_and_a_bad_header() {
        let pack = b"PACK\0\0\0\x02\0\0\0\x01\x50".to_vec();
        let (_, err) = run("git_pack", "{}", &[&pack]);
        assert_eq!(
            err.expect("refused").message,
            "pack has bad object at offset 12: unknown object type 5"
        );
        let (_, err) = run("git_pack", "{}", &[b"PACX\0\0\0\x02\0\0\0\x01"]);
        assert_eq!(
            err.expect("refused").message,
            "protocol error: bad pack header"
        );
    }

    #[test]
    fn refuses_data_that_does_not_inflate() {
        let mut pack = b"PACK\0\0\0\x02\0\0\0\x01".to_vec();
        pack.extend(entry_head(3, 4));
        pack.extend(b"\x00\x01\x02\x03\x04\x05");
        let (_, err) = run("git_pack", "{}", &[&pack]);
        assert_eq!(
            err.expect("refused").message,
            "pack has bad object at offset 12: inflate returned -3"
        );
    }
}
