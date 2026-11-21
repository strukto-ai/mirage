/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::{iter::Peekable, ops::Range, slice::Iter};

pub mod fields;
pub mod header;
pub mod message;
pub mod mime;
pub mod preview;

pub struct MessageStream<'x> {
    data: &'x [u8],
    iter: Peekable<Iter<'x, u8>>,
    pos: usize,
    restore_pos: usize,
}

impl<'x> MessageStream<'x> {
    pub fn new(data: &'x [u8]) -> MessageStream<'x> {
        MessageStream {
            data,
            iter: data.iter().peekable(),
            pos: 0,
            restore_pos: 0,
        }
    }

    #[inline(always)]
    pub fn peek(&mut self) -> Option<&&u8> {
        self.iter.peek()
    }

    #[inline(always)]
    pub fn offset(&self) -> usize {
        std::cmp::min(self.pos, self.data.len())
    }

    #[inline(always)]
    pub fn remaining(&self) -> usize {
        self.data.len() - self.offset()
    }

    #[inline(always)]
    pub fn checkpoint(&mut self) {
        self.restore_pos = self.offset();
    }

    #[inline(always)]
    pub fn restore(&mut self) {
        self.iter = self.data[self.restore_pos..].iter().peekable();
        self.pos = self.restore_pos;
        self.restore_pos = 0;
    }

    #[inline(always)]
    pub fn reset(&mut self) {
        self.restore_pos = 0;
    }

    #[inline(always)]
    pub fn peek_bytes(&self, len: usize) -> Option<&[u8]> {
        let pos = self.offset();
        self.data.get(pos..pos + len)
    }

    #[inline(always)]
    pub fn peek_char(&mut self, ch: u8) -> bool {
        matches!(self.peek(), Some(&&ch_) if ch_ == ch)
    }

    #[inline(always)]
    pub fn skip_bytes(&mut self, len: usize) {
        self.pos += len;
        self.iter = self.data[self.pos..].iter().peekable();
    }

    #[inline(always)]
    pub fn try_skip(&mut self, bytes: &[u8]) -> bool {
        if self.peek_bytes(bytes.len()) == Some(bytes) {
            self.skip_bytes(bytes.len());
            true
        } else {
            false
        }
    }

    #[inline(always)]
    pub fn try_skip_char(&mut self, ch: u8) -> bool {
        if self.peek_char(ch) {
            self.next();
            true
        } else {
            false
        }
    }

    #[inline(always)]
    pub fn bytes(&self, range: Range<usize>) -> &'x [u8] {
        self.data.get(range).unwrap_or_default()
    }

    #[inline(always)]
    pub fn seek_end(&mut self) {
        self.pos = self.data.len();
        self.iter = [][..].iter().peekable();
    }

    #[inline(always)]
    pub fn next_is_space(&mut self) -> bool {
        matches!(self.next(), Some(b' ' | b'\t'))
    }

    #[inline(always)]
    pub fn peek_next_is_space(&mut self) -> bool {
        matches!(self.peek(), Some(b' ' | b'\t'))
    }

    #[inline(always)]
    pub fn try_next_is_space(&mut self) -> bool {
        if self.peek_next_is_space() {
            self.next();
            true
        } else {
            false
        }
    }

    #[allow(clippy::len_without_is_empty)]
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.data.len()
    }

    #[inline(always)]
    pub fn is_eof(&mut self) -> bool {
        self.iter.peek().is_none()
    }
}

impl<'x> Iterator for MessageStream<'x> {
    type Item = &'x u8;

    #[inline(always)]
    fn next(&mut self) -> Option<Self::Item> {
        self.pos += 1;
        self.iter.next()
    }
}
