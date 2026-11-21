/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::borrow::Cow;

use super::MessageStream;

impl<'x> MessageStream<'x> {
    pub fn seek_next_part(&mut self, boundary: &[u8]) -> bool {
        if !boundary.is_empty() {
            let mut last_ch = 0;

            self.checkpoint();

            while let Some(&ch) = self.next() {
                if ch == b'-' && last_ch == b'-' && self.try_skip(boundary) {
                    return true;
                }

                last_ch = ch;
            }

            self.restore();
        }

        false
    }

    pub fn seek_next_part_offset(&mut self, boundary: &[u8]) -> Option<usize> {
        let mut last_ch = b'\n';
        let mut offset_pos = self.offset();
        self.checkpoint();

        while let Some(&ch) = self.next() {
            if ch == b'\n' {
                offset_pos = if last_ch == b'\r' {
                    self.offset() - 2
                } else {
                    self.offset() - 1
                };
            } else if ch == b'-' && last_ch == b'-' && self.try_skip(boundary) {
                return offset_pos.into();
            }

            last_ch = ch;
        }

        self.restore();

        None
    }

    pub fn mime_part(&mut self, boundary: &[u8]) -> (usize, Cow<'x, [u8]>) {
        let mut last_ch = b'\n';
        let mut before_last_ch = 0;
        let start_pos = self.offset();
        let mut end_pos = self.offset();

        self.checkpoint();

        while let Some(&ch) = self.next() {
            if ch == b'\n' {
                end_pos = if last_ch == b'\r' {
                    self.offset() - 2
                } else {
                    self.offset() - 1
                };
            } else if ch == b'-'
                && !boundary.is_empty()
                && last_ch == b'-'
                && self.try_skip(boundary)
            {
                if before_last_ch != b'\n' {
                    end_pos = self.offset() - boundary.len() - 2;
                }
                return (end_pos, self.bytes(start_pos..end_pos).into());
            }

            before_last_ch = last_ch;
            last_ch = ch;
        }

        (
            if boundary.is_empty() {
                self.offset()
            } else {
                self.restore();
                usize::MAX
            },
            self.bytes(start_pos..self.len()).into(),
        )
    }

    pub fn seek_part_end(&mut self, boundary: Option<&[u8]>) -> (usize, bool) {
        let mut last_ch = b'\n';
        let mut before_last_ch = 0;
        let mut end_pos = self.offset();

        if let Some(boundary) = boundary {
            while let Some(&ch) = self.next() {
                if ch == b'\n' {
                    end_pos = if last_ch == b'\r' {
                        self.offset() - 2
                    } else {
                        self.offset() - 1
                    };
                } else if ch == b'-' && last_ch == b'-' && self.try_skip(boundary) {
                    if before_last_ch != b'\n' {
                        end_pos = self.offset() - boundary.len() - 2;
                    }
                    return (end_pos, true);
                }

                before_last_ch = last_ch;
                last_ch = ch;
            }

            (self.offset(), false)
        } else {
            self.seek_end();
            (self.offset(), true)
        }
    }

    pub fn is_multipart_end(&mut self) -> bool {
        self.checkpoint();

        match (self.next(), self.peek()) {
            (Some(b'\r'), Some(b'\n')) => {
                self.next();
                false
            }
            (Some(b'-'), Some(b'-')) => {
                self.next();
                true
            }
            (Some(b'\n'), _) => false,
            (Some(&a), _) if a.is_ascii_whitespace() => {
                self.skip_crlf();
                false
            }
            _ => {
                self.restore();
                false
            }
        }
    }

    #[inline(always)]
    pub fn skip_crlf(&mut self) {
        while let Some(ch) = self.peek() {
            match ch {
                b'\r' | b' ' | b'\t' => {
                    self.next();
                }
                b'\n' => {
                    self.next();
                    break;
                }
                _ => break,
            }
        }
    }
}
