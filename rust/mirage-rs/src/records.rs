use std::collections::{BTreeMap, VecDeque};
use std::ops::Range;
use std::sync::Arc;

pub(crate) const STEP: usize = 16 * 1024;

#[derive(Default)]
pub(crate) struct Bytes {
    blocks: BTreeMap<usize, Vec<u8>>,
    len: usize,
}

impl Bytes {
    pub(crate) fn new(bytes: &[u8]) -> Self {
        let mut value = Self::default();
        value.extend(bytes);
        value
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn at(&self, offset: usize) -> u8 {
        self.blocks[&(offset / STEP)][offset % STEP]
    }

    pub(crate) fn slice(&self, offset: usize, count: usize) -> &[u8] {
        if count == 0 {
            return &[];
        }
        let block = &self.blocks[&(offset / STEP)];
        let start = offset % STEP;
        &block[start..block.len().min(start + count)]
    }

    pub(crate) fn extend(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let block = self
                .blocks
                .entry(self.len / STEP)
                .or_insert_with(|| Vec::with_capacity(bytes.len().min(STEP)));
            let count = bytes.len().min(STEP - block.len());
            block.extend_from_slice(&bytes[..count]);
            self.len += count;
            bytes = &bytes[count..];
        }
    }

    pub(crate) fn retire(&mut self, budget: &mut usize) -> bool {
        while *budget > 0 {
            let Some((_, block)) = self.blocks.pop_first() else {
                self.len = 0;
                return true;
            };
            *budget = budget.saturating_sub(block.len().max(1));
        }
        self.blocks.is_empty()
    }
}

pub(crate) fn scalar(bytes: &Bytes, offset: usize) -> (char, usize) {
    let first = bytes.at(offset);
    if first < 0x80 {
        return (char::from(first), 1);
    }
    let (size, lower, upper) = match first {
        0xc2..=0xdf => (2, 0x80, 0xbf),
        0xe0 => (3, 0xa0, 0xbf),
        0xed => (3, 0x80, 0x9f),
        0xe1..=0xef => (3, 0x80, 0xbf),
        0xf0 => (4, 0x90, 0xbf),
        0xf4 => (4, 0x80, 0x8f),
        0xf1..=0xf3 => (4, 0x80, 0xbf),
        _ => return ('\u{fffd}', 1),
    };
    let mut raw = [0; 4];
    raw[0] = first;
    for (index, slot) in raw.iter_mut().enumerate().take(size).skip(1) {
        if offset + index >= bytes.len() {
            return ('\u{fffd}', index);
        }
        let byte = bytes.at(offset + index);
        let valid = if index == 1 {
            (lower..=upper).contains(&byte)
        } else {
            (0x80..=0xbf).contains(&byte)
        };
        if !valid {
            return ('\u{fffd}', index);
        }
        *slot = byte;
    }
    (
        std::str::from_utf8(&raw[..size])
            .expect("validated scalar")
            .chars()
            .next()
            .expect("nonempty scalar"),
        size,
    )
}

#[derive(Clone)]
pub(crate) struct Piece {
    pub(crate) bytes: Arc<Bytes>,
    pub(crate) span: Range<usize>,
}

impl Piece {
    pub(crate) fn whole(bytes: Arc<Bytes>) -> Self {
        let end = bytes.len();
        Self {
            bytes,
            span: 0..end,
        }
    }

    pub(crate) fn slice(&self, offset: usize, count: usize) -> &[u8] {
        self.bytes.slice(
            self.span.start + offset,
            count.min(self.span.len() - offset),
        )
    }
}

#[derive(Default)]
pub(crate) struct Output {
    pieces: VecDeque<Piece>,
    offset: usize,
}

impl Output {
    pub(crate) fn push(&mut self, piece: Piece) {
        self.pieces.push_back(piece);
    }

    pub(crate) fn empty(&self) -> bool {
        self.pieces.is_empty()
    }

    pub(crate) fn write(&mut self, out: &mut Vec<u8>, budget: &mut usize) {
        while *budget > 0 {
            let Some(piece) = self.pieces.front() else {
                break;
            };
            let bytes = piece.slice(self.offset, *budget);
            let count = bytes.len();
            out.extend_from_slice(bytes);
            self.offset += count;
            *budget -= count.max(1).min(*budget);
            if self.offset == piece.span.len() {
                self.pieces.pop_front();
                self.offset = 0;
            }
        }
    }
}

#[derive(Default)]
pub(crate) struct Input {
    chunks: VecDeque<Vec<u8>>,
    offset: usize,
    record: Bytes,
    ended: bool,
}

pub(crate) enum Read {
    Record(Bytes),
    Waiting,
    Working,
    End,
}

impl Input {
    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.chunks.push_back(bytes.to_vec());
        }
    }

    pub(crate) fn end(&mut self) {
        self.ended = true;
    }

    pub(crate) fn cancel(&mut self) -> Bytes {
        self.chunks.clear();
        self.offset = 0;
        self.ended = true;
        std::mem::take(&mut self.record)
    }

    pub(crate) fn read(&mut self, terminator: u8, budget: &mut usize) -> Read {
        while *budget > 0 {
            let Some(chunk) = self.chunks.front() else {
                return if self.ended {
                    if self.record.len() == 0 {
                        Read::End
                    } else {
                        Read::Record(std::mem::take(&mut self.record))
                    }
                } else {
                    Read::Waiting
                };
            };
            let end = chunk.len().min(self.offset + *budget);
            let bytes = &chunk[self.offset..end];
            let found = memchr::memchr(terminator, bytes);
            let size = found.unwrap_or(bytes.len());
            self.record.extend(&bytes[..size]);
            let consumed = size + usize::from(found.is_some());
            self.offset += consumed;
            *budget -= consumed;
            if self.offset == chunk.len() {
                self.chunks.pop_front();
                self.offset = 0;
            }
            if found.is_some() {
                return Read::Record(std::mem::take(&mut self.record));
            }
        }
        Read::Working
    }
}
