/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::{HeaderValue, parsers::MessageStream};

impl<'x> MessageStream<'x> {
    pub fn parse_id(&mut self) -> HeaderValue<'x> {
        let mut token_start: usize = 0;
        let mut token_end: usize = 0;
        let mut token_invalid_start: usize = 0; // Handle broken clients
        let mut token_invalid_end: usize = 0; // Handle broken clients
        let mut is_id_part = false;
        let mut ids = Vec::new();

        while let Some(&ch) = self.next() {
            match ch {
                b'\n' => {
                    if !self.try_next_is_space() {
                        return match ids.len() {
                            1 => HeaderValue::Text(ids.pop().unwrap()),
                            0 => {
                                if token_invalid_start > 0 {
                                    HeaderValue::Text(String::from_utf8_lossy(
                                        self.bytes(token_invalid_start - 1..token_invalid_end),
                                    ))
                                } else {
                                    HeaderValue::Empty
                                }
                            }
                            _ => HeaderValue::TextList(ids),
                        };
                    } else {
                        continue;
                    }
                }
                b'<' => {
                    is_id_part = true;
                    continue;
                }
                b'>' => {
                    is_id_part = false;
                    if token_start > 0 {
                        ids.push(String::from_utf8_lossy(
                            self.bytes(token_start - 1..token_end),
                        ));
                        token_start = 0;
                    } else {
                        continue;
                    }
                }
                b' ' | b'\t' | b'\r' => continue,
                _ => {}
            }
            if is_id_part {
                if token_start == 0 {
                    token_start = self.offset();
                }
                token_end = self.offset();
            } else {
                if token_invalid_start == 0 {
                    token_invalid_start = self.offset();
                }
                token_invalid_end = self.offset();
            }
        }

        HeaderValue::Empty
    }
}
#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use crate::parsers::{MessageStream, fields::load_tests};

    #[test]
    fn parse_message_ids() {
        for test in load_tests::<Option<Vec<Cow<'static, str>>>>("id.json") {
            assert_eq!(
                MessageStream::new(test.header.as_bytes())
                    .parse_id()
                    .into_text_list(),
                test.expected,
                "failed for {:?}",
                test.header
            );
        }
    }
}
