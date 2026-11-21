/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::borrow::Cow;

use crate::{HeaderValue, parsers::MessageStream};
struct UnstructuredParser<'x> {
    token_start: usize,
    token_end: usize,
    tokens: Vec<Cow<'x, str>>,
    last_is_encoded: bool,
}

impl<'x> UnstructuredParser<'x> {
    fn add_token(&mut self, stream: &MessageStream<'x>) {
        if self.token_start > 0 {
            if !self.tokens.is_empty() {
                self.tokens.push(" ".into());
            }
            self.tokens.push(String::from_utf8_lossy(
                stream.bytes(self.token_start - 1..self.token_end),
            ));

            self.token_start = 0;
            self.last_is_encoded = false;
        }
    }

    fn add_rfc2047(&mut self, token: String) {
        if !self.last_is_encoded {
            self.tokens.push(" ".into());
        }
        self.tokens.push(token.into());
        self.last_is_encoded = true;
    }
}

impl<'x> MessageStream<'x> {
    pub fn parse_unstructured(&mut self) -> HeaderValue<'x> {
        let mut parser = UnstructuredParser {
            token_start: 0,
            token_end: 0,
            tokens: Vec::new(),
            last_is_encoded: true,
        };

        while let Some(ch) = self.next() {
            match ch {
                b'\n' => {
                    parser.add_token(self);

                    if !self.try_next_is_space() {
                        return match parser.tokens.len() {
                            1 => HeaderValue::Text(parser.tokens.pop().unwrap()),
                            0 => HeaderValue::Empty,
                            _ => HeaderValue::Text(parser.tokens.concat().into()),
                        };
                    } else {
                        continue;
                    }
                }
                b' ' | b'\t' | b'\r' => {
                    continue;
                }
                b'=' if self.peek_char(b'?') => {
                    self.checkpoint();
                    if let Some(token) = self.decode_rfc2047() {
                        parser.add_token(self);
                        parser.add_rfc2047(token);
                        continue;
                    }
                    self.restore();
                }
                _ => (),
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
    fn parse_unstructured() {
        for test in load_tests::<String>("unstructured.json") {
            assert_eq!(
                MessageStream::new(test.header.as_bytes())
                    .parse_unstructured()
                    .unwrap_text(),
                test.expected,
                "failed for {:?}",
                test.header
            );
        }
    }
}
