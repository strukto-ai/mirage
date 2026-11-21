/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::borrow::Cow;

use crate::{HeaderValue, parsers::MessageStream};

struct ListParser<'x> {
    token_start: usize,
    token_end: usize,
    is_token_start: bool,
    tokens: Vec<Cow<'x, str>>,
    list: Vec<Cow<'x, str>>,
}

impl<'x> ListParser<'x> {
    fn add_token(&mut self, stream: &MessageStream<'x>, add_space: bool) {
        if self.token_start > 0 {
            if !self.tokens.is_empty() {
                self.tokens.push(" ".into());
            }
            self.tokens.push(String::from_utf8_lossy(
                &stream.data[self.token_start - 1..self.token_end],
            ));

            if add_space {
                self.tokens.push(" ".into());
            }

            self.token_start = 0;
            self.is_token_start = true;
        }
    }

    fn add_tokens_to_list(&mut self) {
        if !self.tokens.is_empty() {
            self.list.push(if self.tokens.len() == 1 {
                self.tokens.pop().unwrap()
            } else {
                let value = self.tokens.concat();
                self.tokens.clear();
                value.into()
            });
        }
    }
}

impl<'x> MessageStream<'x> {
    pub fn parse_comma_separared(&mut self) -> HeaderValue<'x> {
        let mut parser = ListParser {
            token_start: 0,
            token_end: 0,
            is_token_start: true,
            tokens: Vec::new(),
            list: Vec::new(),
        };

        while let Some(ch) = self.next() {
            match ch {
                b'\n' => {
                    parser.add_token(self, false);
                    if !self.try_next_is_space() {
                        parser.add_tokens_to_list();

                        return match parser.list.len() {
                            1 => HeaderValue::Text(parser.list.pop().unwrap()),
                            0 => HeaderValue::Empty,
                            _ => HeaderValue::TextList(parser.list),
                        };
                    } else {
                        continue;
                    }
                }
                b' ' | b'\t' => {
                    if !parser.is_token_start {
                        parser.is_token_start = true;
                    }
                    continue;
                }
                b'=' if parser.is_token_start && self.peek_char(b'?') => {
                    self.checkpoint();
                    if let Some(token) = self.decode_rfc2047() {
                        parser.add_token(self, true);
                        parser.tokens.push(token.into());
                        continue;
                    }
                    self.restore();
                }
                b',' => {
                    parser.add_token(self, false);
                    parser.add_tokens_to_list();
                    continue;
                }
                b'\r' => continue,
                _ => (),
            }

            if parser.is_token_start {
                parser.is_token_start = false;
            }

            if parser.token_start == 0 {
                parser.token_start = self.offset();
            }

            parser.token_end = self.offset();
        }

        HeaderValue::Empty
    }
}
#[cfg(test)]
mod tests {
    use crate::parsers::{MessageStream, fields::load_tests};

    #[test]
    fn parse_comma_separated_text() {
        for test in load_tests::<Vec<String>>("list.json") {
            assert_eq!(
                MessageStream::new(test.header.as_bytes())
                    .parse_comma_separared()
                    .unwrap_text_list(),
                test.expected,
                "failed for {:?}",
                test.header
            );
        }
    }
}
