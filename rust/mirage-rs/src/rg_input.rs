use std::collections::VecDeque;

use encoding_rs::{CoderResult, Decoder, Encoding, UTF_8};
use memchr::memchr;

use crate::StreamError;

const BLOCK: usize = 64 * 1024;

pub(crate) fn encoding(label: &str) -> Option<&'static Encoding> {
    Encoding::for_label_no_replacement(label.as_bytes())
}

struct Decode {
    named: Option<&'static Encoding>,
    decoder: Option<Decoder>,
    head: Vec<u8>,
    sniff: bool,
}

impl Decode {
    fn new(label: &str) -> Result<Self, StreamError> {
        let named = match label {
            "auto" | "none" => None,
            _ => Some(
                encoding(label)
                    .ok_or_else(|| StreamError::new(format!("unknown encoding: {label}")))?,
            ),
        };
        Ok(Self {
            named,
            decoder: None,
            head: Vec::new(),
            sniff: label != "none",
        })
    }

    fn feed(&mut self, data: &[u8], last: bool) -> Vec<u8> {
        let mut data = data;
        let mut head = Vec::new();
        if self.sniff {
            self.head.extend_from_slice(data);
            if self.head.len() < 3 && !last {
                return Vec::new();
            }
            head = std::mem::take(&mut self.head);
            data = &head;
            if let Some((bom, size)) = Encoding::for_bom(data) {
                data = &data[size..];
                if bom != UTF_8 {
                    self.named = Some(bom);
                }
            }
            self.decoder = self.named.map(Encoding::new_decoder_with_bom_removal);
            self.sniff = false;
        }
        let Some(decoder) = &mut self.decoder else {
            return data.to_vec();
        };
        let mut out = vec![
            0;
            decoder
                .max_utf8_buffer_length(data.len())
                .expect("bounded rg input")
        ];
        let (result, read, written, _) = decoder.decode_to_utf8(data, &mut out, last);
        debug_assert_eq!(result, CoderResult::InputEmpty);
        debug_assert_eq!(read, data.len());
        out.truncate(written);
        drop(head);
        out
    }
}

pub(crate) struct Read {
    pub(crate) data: Vec<u8>,
    pub(crate) position: usize,
    pub(crate) nul: Option<u64>,
    pub(crate) converted: bool,
    pub(crate) skipped: bool,
}

/// The first file read fills 64 KiB; a walked file grows that window to
/// the first newline. Pipes probe each available read without waiting.
/// Offsets refer to decoded UTF-8, as in ripgrep 14.1.1.
pub(crate) struct Haystack {
    decoder: Decode,
    mode: String,
    filling: bool,
    held: Vec<u8>,
    newline: Option<usize>,
    position: u64,
    nul: Option<u64>,
    pub(crate) ready: VecDeque<Read>,
    pub(crate) stopped: bool,
}

impl Haystack {
    pub(crate) fn new(mode: &str, label: &str, pipe: bool) -> Result<Self, StreamError> {
        if !matches!(mode, "" | "text" | "convert" | "note" | "quit") {
            return Err(StreamError::new("unknown rg binary mode"));
        }
        Ok(Self {
            decoder: Decode::new(label)?,
            mode: mode.to_owned(),
            filling: !pipe && !matches!(mode, "" | "text"),
            held: Vec::new(),
            newline: None,
            position: 0,
            nul: None,
            ready: VecDeque::new(),
            stopped: false,
        })
    }

    pub(crate) fn feed(&mut self, data: &[u8], last: bool) {
        if self.stopped {
            return;
        }
        let decoded = self.decoder.feed(data, last);
        if self.filling {
            if self.newline.is_none() {
                self.newline = memchr(b'\n', &decoded).map(|at| self.held.len() + at);
            }
            let nul = memchr(0, &decoded).map(|at| self.held.len() + at);
            self.held.extend_from_slice(&decoded);
            let end = if self.mode == "quit" {
                self.newline.map(|at| (at / BLOCK + 1) * BLOCK)
            } else {
                Some(BLOCK)
            };
            if self.mode == "quit" && nul.is_some_and(|at| end.is_none_or(|end| at < end)) {
                self.nul = nul.map(|at| at as u64);
                self.stopped = true;
                self.held.clear();
                self.ready.push_back(Read {
                    data: Vec::new(),
                    position: 0,
                    nul: self.nul,
                    converted: false,
                    skipped: true,
                });
                return;
            }
            if !last && end.is_none_or(|end| self.held.len() < end) {
                return;
            }
            self.filling = false;
            let mut held = std::mem::take(&mut self.held);
            let end = end.unwrap_or(held.len()).min(held.len());
            let tail = held.split_off(end);
            self.probe(held, self.mode == "quit");
            for block in tail.chunks(BLOCK) {
                self.probe(block.to_vec(), false);
            }
        } else {
            for block in decoded.chunks(BLOCK) {
                self.probe(block.to_vec(), false);
            }
        }
    }

    fn probe(&mut self, mut data: Vec<u8>, checked: bool) {
        if self.stopped || data.is_empty() {
            return;
        }
        if !matches!(self.mode.as_str(), "" | "text") {
            let at = if checked { None } else { memchr(0, &data) };
            if self.position == 0 {
                self.nul = at.map(|at| at as u64);
            }
            if at.is_some() && self.mode == "quit" {
                self.stopped = true;
                self.ready.push_back(Read {
                    data: Vec::new(),
                    position: 0,
                    nul: self.nul,
                    converted: false,
                    skipped: self.position == 0,
                });
                return;
            }
        }
        self.position += data.len() as u64;
        let converted = self.mode == "convert" && self.nul.is_some();
        if converted {
            for byte in &mut data {
                if *byte == 0 {
                    *byte = b'\n';
                }
            }
        }
        self.ready.push_back(Read {
            data,
            position: 0,
            nul: self.nul,
            converted,
            skipped: false,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{Decode, Haystack, encoding};

    #[test]
    fn encoding_labels_use_the_whatwg_registry_without_replacement() {
        for (label, name) in [
            ("latin1", "windows-1252"),
            (" UTF-8 ", "UTF-8"),
            ("\tutf-16\n", "UTF-16LE"),
            ("SJIS", "Shift_JIS"),
            ("x-user-defined", "x-user-defined"),
        ] {
            assert_eq!(encoding(label).unwrap().name(), name);
        }
        for label in [
            "utf16le",
            "replacement",
            "iso-2022-kr",
            "",
            "Koi8-r",
            "constructor",
        ] {
            assert!(encoding(label).is_none());
        }
    }

    #[test]
    fn decoding_and_bom_precedence_survive_every_split() {
        let cases: &[(&str, &[u8], &[u8])] = &[
            ("auto", b"\xef\xbb\xbfcaf\xe9", b"caf\xe9"),
            ("auto", b"\xff\xfeh\x00i\x00", b"hi"),
            ("windows-1252", b"\xef\xbb\xbfcaf\xe9", "café".as_bytes()),
            ("UTF-16LE", b"\xfe\xff\x00h", b"h"),
            ("UTF-8", b"\xef\xbb\xbf\xef\xbb\xbfhi", b"hi"),
            ("auto", b"\xef\xbb\xbf\xef\xbb\xbfhi", b"\xef\xbb\xbfhi"),
            ("UTF-8", b"caf\xe9", "caf�".as_bytes()),
            ("windows-1252", b"\x80\x81\xe9", "€\u{81}é".as_bytes()),
            ("ISO-8859-16", b"\xa1", "Ą".as_bytes()),
            (
                "x-user-defined",
                b"a\x80\xff",
                "a\u{f780}\u{f7ff}".as_bytes(),
            ),
            ("Shift_JIS", b"\x93\xfa", "日".as_bytes()),
            ("UTF-16LE", b"h\x00i\x00z", "hi�".as_bytes()),
            ("none", b"\xef\xbb\xbfhi", b"\xef\xbb\xbfhi"),
        ];
        for &(label, data, want) in cases {
            for split in 0..=data.len() {
                let mut decoder = Decode::new(label).unwrap();
                let mut out = decoder.feed(&data[..split], false);
                out.extend(decoder.feed(&data[split..], false));
                out.extend(decoder.feed(b"", true));
                assert_eq!(out, want, "{label}, split {split}");
            }
        }
    }

    #[test]
    fn walked_file_stops_at_nul_while_growing_its_first_read() {
        let mut input = Haystack::new("quit", "none", false).unwrap();
        input.feed(&vec![b'x'; 10000], false);
        assert!(input.ready.is_empty());
        input.feed(b"\0", false);
        assert!(input.stopped);
        let read = input.ready.pop_front().unwrap();
        assert!(read.skipped);
        assert_eq!(read.nul, Some(10000));
    }

    #[test]
    fn walked_file_grows_to_the_first_newline_but_pipe_does_not_wait() {
        let mut input = Haystack::new("quit", "none", false).unwrap();
        for _ in 0..20 {
            input.feed(&vec![b'y'; 8192], false);
            assert!(input.ready.is_empty());
        }
        input.feed(b"\nz\n", true);
        assert_eq!(input.ready.pop_front().unwrap().data.len(), 163843);
        let mut pipe = Haystack::new("quit", "none", true).unwrap();
        pipe.feed(b"needle\n", false);
        assert_eq!(pipe.ready.pop_front().unwrap().data, b"needle\n");
    }
}
