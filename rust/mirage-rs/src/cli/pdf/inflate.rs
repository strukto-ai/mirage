use std::collections::HashMap;
use std::io::Read;

use flate2::{Decompress, FlushDecompress, Status};
use pdf_oxide::decoders::{
    Ascii85Decoder, AsciiHexDecoder, BrotliDecoder, FlateDecoder, LzwDecoder, RunLengthDecoder,
    StreamDecoder,
};
use pdf_oxide::object::Object;

use crate::request::Request;
use crate::task::Host;

const WINDOW: usize = 64 * 1024;
/// The most pdf_oxide's FlateDecode inflates before it gives up.
const MOST: u64 = 256 * 1024 * 1024;
/// The most a decoded stream may hold, and how many times its packed
/// bytes, before pdf_oxide drops it.
const MOST_KEPT: u64 = 100 * 1024 * 1024;
const RATIO: u64 = 100;
/// The widest code an LZW stream reads.
const LZW_BITS: u32 = 12;

/// What a stream inflated to.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Inflated {
    /// Its bytes, whole or up to where they stop short.
    Whole(Vec<u8>),
    /// Past what pdf_oxide keeps of one stream, so the reader drops it.
    Dropped,
    /// No zlib stream this reads, left to pdf_oxide's recovery.
    Broken,
}

/// A stream's filters by the names pdf_oxide gives them, the spellings
/// and abbreviations it accepts made whole.
pub(crate) fn filters(dict: &HashMap<String, Object>) -> Vec<String> {
    let named = |o: &Object| o.as_name().map(filter_name);
    match dict.get("Filter") {
        Some(Object::Array(list)) => list.iter().filter_map(named).collect(),
        Some(filter) => named(filter).into_iter().collect(),
        None => Vec::new(),
    }
}

fn filter_name(name: &str) -> String {
    let full = match name {
        "Fl" => "FlateDecode",
        "AHx" => "ASCIIHexDecode",
        "A85" => "ASCII85Decode",
        "LZW" => "LZWDecode",
        "RL" => "RunLengthDecode",
        _ => name,
    };
    let known = [
        "FlateDecode",
        "ASCIIHexDecode",
        "ASCII85Decode",
        "LZWDecode",
        "RunLengthDecode",
        "BrotliDecode",
    ];
    known
        .iter()
        .find(|k| k.eq_ignore_ascii_case(full))
        .map_or_else(|| full.to_string(), |k| (*k).to_string())
}

/// Whether a stream's only filter is FlateDecode.
pub(crate) fn flate_only(dict: &HashMap<String, Object>) -> bool {
    filters(dict) == ["FlateDecode"]
}

/// `packed` inflated a window at a time, the workspace asked after each
/// window whether `held` and the bytes so far still fit, so a stream that
/// would not is refused before it is whole, and dropped where pdf_oxide
/// drops a stream.
pub(crate) async fn inflate(host: &Host, packed: &[u8], held: u64) -> Inflated {
    if packed.is_empty() {
        return Inflated::Whole(Vec::new());
    }
    let mut z = Decompress::new(true);
    let mut window = vec![0u8; WINDOW];
    let mut out = Vec::new();
    let mut count = 0u64;
    loop {
        let (read, wrote) = (z.total_in(), z.total_out());
        let at = usize::try_from(read)
            .unwrap_or(packed.len())
            .min(packed.len());
        let status = z.decompress(&packed[at..], &mut window, FlushDecompress::None);
        let made = (z.total_out() - wrote) as usize;
        count += made as u64;
        if made > 0 {
            host.ask(Request::Memory { size: held + count }).await;
        }
        if count > MOST_KEPT || count / packed.len() as u64 > RATIO {
            return Inflated::Dropped;
        }
        out.extend_from_slice(&window[..made]);
        match status {
            Ok(Status::StreamEnd) => return Inflated::Whole(out),
            Ok(_) if made == 0 && z.total_in() == read => {
                return if at == packed.len() && count > 0 {
                    Inflated::Whole(out)
                } else {
                    Inflated::Broken
                };
            }
            Ok(_) => {}
            Err(_) => return Inflated::Broken,
        }
    }
}

/// A zlib stream read a window at a time without keeping it, each window
/// handed to `each` and the workspace asked whether `held` and the bytes
/// so far still fit; its length, or None when it is no zlib stream or
/// breaks partway, where pdf_oxide may read other bytes in its place.
pub(crate) async fn scan(
    host: &Host,
    packed: &[u8],
    held: u64,
    each: &mut (dyn FnMut(&[u8]) + Send),
) -> Option<u64> {
    let mut zlib = Zlib::new(packed, true);
    let mut total = 0;
    while let Some(made) = zlib.next() {
        each(&zlib.window[..made as usize]);
        total += made;
        host.ask(Request::Memory { size: held + total }).await;
    }
    (!zlib.failed && total > 0).then_some(total)
}

/// What decoding `data` through `dict`'s filters comes to, as pdf_oxide
/// would decode it, the workspace asked as each window is counted
/// whether `held` and the bytes so far still fit. A decompressing filter
/// is counted here without keeping its bytes; one another filter follows
/// is then decoded by pdf_oxide, now known to fit; the ASCII filters,
/// which at most quadruple their input, are decoded by pdf_oxide. An
/// image filter ends the count: the text never decodes it.
pub(crate) async fn measure(
    host: &Host,
    dict: &HashMap<String, Object>,
    data: &[u8],
    held: u64,
) -> u64 {
    let chain = filters(dict);
    let mut current = data.to_vec();
    for (at, filter) in chain.iter().enumerate() {
        let decoder: Box<dyn StreamDecoder + Send> = match filter.as_str() {
            "ASCIIHexDecode" => Box::new(AsciiHexDecoder),
            "ASCII85Decode" => Box::new(Ascii85Decoder),
            "FlateDecode" => Box::new(FlateDecoder::default()),
            "LZWDecode" => Box::new(LzwDecoder),
            "RunLengthDecode" => Box::new(RunLengthDecoder),
            "BrotliDecode" => Box::new(BrotliDecoder),
            _ => break,
        };
        let base = if at == 0 {
            held
        } else {
            held + current.len() as u64
        };
        let counted = match filter.as_str() {
            "FlateDecode" => Some(flate(host, &current, base).await),
            "LZWDecode" => {
                let late = count(host, &mut Lzw::new(&current, 0), base).await;
                let early = count(host, &mut Lzw::new(&current, 1), base).await;
                Some(late.max(early))
            }
            "RunLengthDecode" => {
                let mut runs = RunLength {
                    input: &current,
                    at: 0,
                };
                Some(count(host, &mut runs, base).await)
            }
            "BrotliDecode" => Some(count(host, &mut Brotli::new(&current), base).await),
            _ => None,
        };
        if let Some(size) = counted.filter(|_| at + 1 == chain.len()) {
            return size;
        }
        let Ok(decoded) = decoder.decode(&current) else {
            return counted.unwrap_or(0).max(current.len() as u64);
        };
        if counted.is_none() {
            host.ask(Request::Memory {
                size: base + decoded.len() as u64,
            })
            .await;
        }
        current = decoded;
    }
    host.ask(Request::Memory {
        size: held + current.len() as u64,
    })
    .await;
    current.len() as u64
}

/// The most pdf_oxide's FlateDecode holds of `input`: the zlib stream it
/// reads first, or, when that fails before it yields, the largest of the
/// recoveries it then tries in turn: raw deflate from each of the first
/// twenty bytes, and zlib with a corrupt method fixed.
async fn flate(host: &Host, input: &[u8], held: u64) -> u64 {
    let mut zlib = Zlib::new(input, true);
    let size = count(host, &mut zlib, held).await;
    if zlib.ended || (!zlib.failed && size > 0) {
        return size;
    }
    let mut most = size;
    if input.len() >= 2 && input[0] & 0x0F != 8 {
        let mut fixed = input.to_vec();
        fixed[0] = (input[0] & 0xF0) | 0x08;
        most = most.max(count(host, &mut Zlib::new(&fixed, true), held).await);
    }
    for offset in 0..input.len().min(20) {
        let raw = count(host, &mut Zlib::new(&input[offset..], false), held).await;
        most = most.max(raw);
    }
    most
}

/// A decoder that counts what it would write, a window at a time.
trait Count {
    /// The bytes the next window comes to, or None once the stream ends
    /// or fails where the reader's decoder stops.
    fn next(&mut self) -> Option<u64>;
}

/// `counter` run to its end, the workspace asked after each window.
async fn count(host: &Host, counter: &mut (dyn Count + Send), held: u64) -> u64 {
    let mut total = 0;
    while let Some(made) = counter.next() {
        total += made;
        host.ask(Request::Memory { size: held + total }).await;
    }
    total
}

struct Zlib<'a> {
    input: &'a [u8],
    z: Decompress,
    window: Vec<u8>,
    /// Whether the stream reached its end marker.
    ended: bool,
    /// Whether its bytes broke the format.
    failed: bool,
}

impl<'a> Zlib<'a> {
    fn new(input: &'a [u8], header: bool) -> Zlib<'a> {
        Zlib {
            input,
            z: Decompress::new(header),
            window: vec![0u8; WINDOW],
            ended: false,
            failed: false,
        }
    }
}

impl Count for Zlib<'_> {
    fn next(&mut self) -> Option<u64> {
        let at = usize::try_from(self.z.total_in())
            .ok()?
            .min(self.input.len());
        let wrote = self.z.total_out();
        if wrote >= MOST {
            return None;
        }
        let status = self
            .z
            .decompress(&self.input[at..], &mut self.window, FlushDecompress::None);
        let made = self.z.total_out() - wrote;
        match status {
            Ok(Status::StreamEnd) => self.ended = true,
            Err(_) => self.failed = true,
            Ok(_) => {}
        }
        (made > 0).then_some(made)
    }
}

/// LZW codes counted by the length each one writes, the code width
/// growing `early` codes before the table fills its width.
struct Lzw<'a> {
    input: &'a [u8],
    bit: usize,
    early: u32,
    width: u32,
    next: usize,
    previous: Option<usize>,
    lengths: Vec<u64>,
    done: bool,
}

impl<'a> Lzw<'a> {
    fn new(input: &'a [u8], early: u32) -> Lzw<'a> {
        let mut lzw = Lzw {
            input,
            bit: 0,
            early,
            width: 9,
            next: 258,
            previous: None,
            lengths: vec![0; 1 << LZW_BITS],
            done: false,
        };
        lzw.clear();
        lzw
    }

    fn clear(&mut self) {
        self.lengths[..256].fill(1);
        self.width = 9;
        self.next = 258;
        self.previous = None;
    }

    fn code(&mut self) -> Option<usize> {
        let end = self.bit + self.width as usize;
        if end > self.input.len() * 8 {
            return None;
        }
        let mut code = 0usize;
        for bit in self.bit..end {
            code = (code << 1) | usize::from(self.input[bit / 8] >> (7 - bit % 8) & 1);
        }
        self.bit = end;
        Some(code)
    }
}

impl Count for Lzw<'_> {
    fn next(&mut self) -> Option<u64> {
        let mut made = 0;
        while !self.done && made < WINDOW as u64 {
            if self.width < LZW_BITS && self.next as u64 + u64::from(self.early) == 1 << self.width
            {
                self.width += 1;
            }
            let Some(code) = self.code() else {
                self.done = true;
                break;
            };
            if code == 257 {
                self.done = true;
                break;
            }
            if code == 256 {
                self.clear();
                continue;
            }
            let length = match self.previous {
                _ if code < self.next => self.lengths[code],
                Some(previous) if code == self.next => self.lengths[previous] + 1,
                _ => {
                    self.done = true;
                    break;
                }
            };
            made += length;
            if let Some(previous) = self.previous {
                if self.next < 1 << LZW_BITS {
                    self.lengths[self.next] = self.lengths[previous] + 1;
                    self.next += 1;
                }
            }
            self.previous = Some(code);
        }
        (made > 0).then_some(made)
    }
}

/// RunLengthDecode counted run by run.
struct RunLength<'a> {
    input: &'a [u8],
    at: usize,
}

impl Count for RunLength<'_> {
    fn next(&mut self) -> Option<u64> {
        let mut made = 0;
        while made < WINDOW as u64 {
            let Some(&length) = self.input.get(self.at) else {
                break;
            };
            let (wrote, read) = match length {
                0..=127 => (usize::from(length) + 1, usize::from(length) + 2),
                128 => break,
                _ => (257 - usize::from(length), 2),
            };
            if self.at + read > self.input.len() {
                break;
            }
            self.at += read;
            made += wrote as u64;
        }
        (made > 0).then_some(made)
    }
}

struct Brotli<'a> {
    reader: brotli::Decompressor<&'a [u8]>,
    window: Vec<u8>,
}

impl<'a> Brotli<'a> {
    fn new(input: &'a [u8]) -> Brotli<'a> {
        Brotli {
            reader: brotli::Decompressor::new(input, 4096),
            window: vec![0u8; WINDOW],
        }
    }
}

impl Count for Brotli<'_> {
    fn next(&mut self) -> Option<u64> {
        match self.reader.read(&mut self.window) {
            Ok(made) if made > 0 => Some(made as u64),
            _ => None,
        }
    }
}
