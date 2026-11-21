/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use crate::{HeaderValue, parsers::MessageStream};

impl<'x> MessageStream<'x> {
    pub fn parse_raw(&mut self) -> HeaderValue<'x> {
        let mut token_start: usize = 0;
        let mut token_end: usize = 0;

        while let Some(ch) = self.next() {
            match ch {
                b'\n' => {
                    if !self.try_next_is_space() {
                        break;
                    } else {
                        continue;
                    }
                }
                b' ' | b'\t' | b'\r' => continue,
                _ => (),
            }

            if token_start == 0 {
                token_start = self.offset();
            }

            token_end = self.offset();
        }

        if token_start > 0 {
            HeaderValue::Text(String::from_utf8_lossy(
                self.bytes(token_start - 1..token_end),
            ))
        } else {
            HeaderValue::Empty
        }
    }

    pub fn parse_and_ignore(&mut self) {
        while let Some(&ch) = self.next() {
            if ch == b'\n' && !self.try_next_is_space() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{MessageParser, parsers::MessageStream};

    #[test]
    fn parse_raw_text() {
        let inputs = [
            ("Saying Hello\nMessage-Id", "Saying Hello"),
            ("Re: Saying Hello\r\n \r\nFrom:", "Re: Saying Hello"),
            (
                concat!(
                    " from x.y.test\n      by example.net\n      via TCP\n",
                    "      with ESMTP\n      id ABC12345\n      ",
                    "for <mary@example.net>;  21 Nov 1997 10:05:43 -0600\n"
                ),
                concat!(
                    "from x.y.test\n      by example.net\n      via TCP\n",
                    "      with ESMTP\n      id ABC12345\n      ",
                    "for <mary@example.net>;  21 Nov 1997 10:05:43 -0600"
                ),
            ),
            ("Re: Saying Hello", "Re: Saying Hello"), // No newline test
        ];

        for (input, expected) in inputs {
            assert_eq!(
                MessageStream::new(input.as_bytes())
                    .parse_raw()
                    .unwrap_text(),
                expected,
                "Failed for '{:?}'",
                input
            );
        }
    }

    #[test]
    fn ordered_raw_headers() {
        let input = br#"From: Art Vandelay <art@vandelay.com>
To: jane@example.com
Date: Sat, 20 Nov 2021 14:22:01 -0800
Subject: Why not both importing AND exporting? =?utf-8?b?4pi6?=
Content-Type: multipart/mixed; boundary="festivus";

Here's a message body.
"#;
        let message = MessageParser::default().parse(input).unwrap();
        let mut iter = message.headers_raw();
        assert_eq!(
            iter.next().unwrap(),
            ("From", " Art Vandelay <art@vandelay.com>\n")
        );
        assert_eq!(iter.next().unwrap(), ("To", " jane@example.com\n"));
        assert_eq!(
            iter.next().unwrap(),
            ("Date", " Sat, 20 Nov 2021 14:22:01 -0800\n")
        );
        assert_eq!(
            iter.next().unwrap(),
            (
                "Subject",
                " Why not both importing AND exporting? =?utf-8?b?4pi6?=\n"
            )
        );
        assert_eq!(
            iter.next().unwrap(),
            ("Content-Type", " multipart/mixed; boundary=\"festivus\";\n")
        );
    }
}
