/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::borrow::Cow;

use crate::parsers::MessageStream;

#[derive(PartialEq, Debug)]
enum QuotedPrintableState {
    None,
    Eq,
    Hex1,
}

pub fn quoted_printable_decode(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(bytes.len());

    let mut state = QuotedPrintableState::None;
    let mut hex1 = 0;
    let mut ws_count = 0;
    let mut crlf = b"\n".as_ref();

    for &ch in bytes {
        match ch {
            b'=' => {
                if let QuotedPrintableState::None = state {
                    state = QuotedPrintableState::Eq
                } else {
                    return None;
                }
            }
            b'\n' => {
                if QuotedPrintableState::Eq == state {
                    state = QuotedPrintableState::None;
                } else {
                    if ws_count > 0 {
                        buf.truncate(buf.len() - ws_count);
                    }
                    buf.extend_from_slice(crlf);
                }
                ws_count = 0;
            }
            b'\r' => {
                crlf = b"\r\n".as_ref();
            }
            _ => match state {
                QuotedPrintableState::None => {
                    if ch.is_ascii_whitespace() {
                        ws_count += 1;
                    } else {
                        ws_count = 0;
                    }
                    buf.push(ch);
                }
                QuotedPrintableState::Eq => {
                    hex1 = HEX_MAP[ch as usize];

                    if hex1 != -1 {
                        state = QuotedPrintableState::Hex1;
                    } else if !ch.is_ascii_whitespace() {
                        return None;
                    }
                }
                QuotedPrintableState::Hex1 => {
                    let hex2 = HEX_MAP[ch as usize];

                    state = QuotedPrintableState::None;
                    if hex2 != -1 {
                        buf.push(((hex1 as u8) << 4) | hex2 as u8);
                        ws_count = 0;
                    } else {
                        return None;
                    }
                }
            },
        }
    }

    buf.into()
}

#[inline(always)]
pub fn quoted_printable_decode_char(hex1: u8, hex2: u8) -> Option<u8> {
    let hex1 = HEX_MAP[hex1 as usize];
    let hex2 = HEX_MAP[hex2 as usize];

    (hex1 != -1 && hex2 != -1).then_some(((hex1 as u8) << 4) | hex2 as u8)
}

impl<'x> MessageStream<'x> {
    pub fn decode_quoted_printable_mime(&mut self, boundary: &[u8]) -> (usize, Cow<'x, [u8]>) {
        let mut buf = Vec::with_capacity(128);

        let mut state = QuotedPrintableState::None;
        let mut hex1 = 0;
        let mut last_ch = 0;
        let mut before_last_ch = 0;
        let mut ws_count = 0;
        let mut end_pos = self.offset();
        let mut crlf = b"\n".as_ref();

        self.checkpoint();

        while let Some(&ch) = self.next() {
            match ch {
                b'=' => {
                    if let QuotedPrintableState::None = state {
                        state = QuotedPrintableState::Eq
                    } else {
                        self.restore();
                        return (usize::MAX, b""[..].into());
                    }
                }
                b'\n' => {
                    end_pos = if last_ch == b'\r' {
                        self.offset() - 2
                    } else {
                        self.offset() - 1
                    };
                    if QuotedPrintableState::Eq == state {
                        state = QuotedPrintableState::None;
                    } else {
                        if ws_count > 0 {
                            buf.truncate(buf.len() - ws_count);
                        }
                        buf.extend_from_slice(crlf);
                    }
                    ws_count = 0;
                }
                b'\r' => {
                    crlf = b"\r\n".as_ref();
                }
                b'-' if !boundary.is_empty() && last_ch == b'-' && self.try_skip(boundary) => {
                    if before_last_ch == b'\n' {
                        buf.truncate(buf.len() - (crlf.len() + 1));
                    } else {
                        buf.truncate(buf.len() - 1);
                        end_pos = self.offset() - boundary.len() - 2;
                    }

                    return (end_pos, buf.into());
                }
                _ => match state {
                    QuotedPrintableState::None => {
                        if ch.is_ascii_whitespace() {
                            ws_count += 1;
                        } else {
                            ws_count = 0;
                        }
                        buf.push(ch);
                    }
                    QuotedPrintableState::Eq => {
                        hex1 = HEX_MAP[ch as usize];
                        if hex1 != -1 {
                            state = QuotedPrintableState::Hex1;
                        } else if !ch.is_ascii_whitespace() {
                            state = QuotedPrintableState::None;
                            buf.push(b'=');
                            buf.push(ch);
                            ws_count = 0;
                        }
                    }
                    QuotedPrintableState::Hex1 => {
                        let hex2 = HEX_MAP[ch as usize];

                        state = QuotedPrintableState::None;
                        if hex2 != -1 {
                            buf.push(((hex1 as u8) << 4) | hex2 as u8);
                            ws_count = 0;
                        } else {
                            buf.push(b'=');
                            buf.push(last_ch);
                            buf.push(ch);
                            ws_count = 0;
                        }
                    }
                },
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
            buf.into(),
        )
    }

    pub fn decode_quoted_printable_word(&mut self) -> Option<Vec<u8>> {
        let mut buf = Vec::with_capacity(64);

        let mut state = QuotedPrintableState::None;
        let mut hex1 = 0;

        while let Some(&ch) = self.next() {
            match ch {
                b'=' => {
                    if let QuotedPrintableState::None = state {
                        state = QuotedPrintableState::Eq
                    } else {
                        break;
                    }
                }
                b'?' => {
                    if let Some(b'=') = self.peek() {
                        self.next();
                        return buf.into();
                    } else {
                        buf.push(b'?');
                    }
                }
                b'\n' => {
                    if let Some(b' ' | b'\t') = self.peek() {
                        loop {
                            self.next();
                            if !self.peek_next_is_space() {
                                break;
                            }
                        }
                    } else {
                        break;
                    }
                }
                b'_' => {
                    buf.push(b' ');
                }
                b'\r' => (),
                _ => match state {
                    QuotedPrintableState::None => {
                        buf.push(ch);
                    }
                    QuotedPrintableState::Eq => {
                        hex1 = HEX_MAP[ch as usize];
                        if hex1 != -1 {
                            state = QuotedPrintableState::Hex1;
                        } else {
                            // Failed
                            break;
                        }
                    }
                    QuotedPrintableState::Hex1 => {
                        let hex2 = HEX_MAP[ch as usize];
                        state = QuotedPrintableState::None;
                        if hex2 != -1 {
                            buf.push(((hex1 as u8) << 4) | hex2 as u8);
                        } else {
                            // Failed
                            break;
                        }
                    }
                },
            }
        }

        None
    }
}

/*
 * Adapted from Daniel Lemire's source:
 * https://github.com/lemire/Code-used-on-Daniel-Lemire-s-blog/blob/master/2019/04/17/hexparse.cpp
 *
 */

pub static HEX_MAP: &[i8] = &[
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1, -1, -1, -1, -1, -1, -1, 10, 11, 12, 13, 14, 15, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 10,
    11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
];

#[cfg(test)]
mod tests {
    use crate::parsers::MessageStream;

    #[test]
    fn decode_quoted_printable() {
        for (encoded_str, expected_result) in [
            (
                concat!(
                    "J'interdis aux marchands de vanter trop leurs marchandises. ",
                    "Car ils se font=\nvite p=C3=A9dagogues et t'enseignent comme but ce ",
                    "qui n'est par essence qu=\n'un moyen, et te trompant ainsi sur la route ",
                    "=C3=A0 suivre les voil=C3=\n=A0 bient=C3=B4t qui te d=C3=A9gradent, car ",
                    "si leur musique est vulgaire il=\ns te fabriquent pour te la vendre une ",
                    "=C3=A2me vulgaire.\n=E2=80=94=E2=80=89Antoine de Saint-Exup=C3=A9ry, ",
                    "Citadelle (1948)"
                ),
                concat!(
                    "J'interdis aux marchands de vanter trop leurs marchandises. ",
                    "Car ils se fontvite pédagogues et t'enseignent comme but ce qui ",
                    "n'est par essence qu'un moyen, et te trompant ainsi sur la route ",
                    "à suivre les voilà bientôt qui te dégradent, car si leur musique ",
                    "est vulgaire ils te fabriquent pour te la vendre une âme vulgaire.\n",
                    "— Antoine de Saint-Exupéry, Citadelle (1948)"
                ),
            ),
            (
                "=E2=80=94=E2=80=89Antoine de Saint-Exup=C3=A9ry",
                "— Antoine de Saint-Exupéry",
            ),
            (
                concat!(
                    "Die Hasen klagten einst uber ihre Lage; \"wir ",
                    "leben\", sprach ein=\r\n Redner, \"in steter Furcht vor Menschen",
                    " und Tieren, eine Beute der Hunde,=\r\n der\n"
                ),
                concat!(
                    "Die Hasen klagten einst uber ihre Lage; \"wir leben\", ",
                    "sprach ein Redner, \"in steter Furcht vor Menschen und ",
                    "Tieren, eine Beute der Hunde, der\r\n"
                ),
            ),
            (
                concat!(
                    "hello  \r\nbar=\r\n\r\nfoo\t=\r\nbar\r\nfoo\t \t= \r\n=62\r\nfoo = ",
                    "\t\r\nbar\r\nfoo =\r\n=62\r\nfoo  \r\nbar=\r\n\r\nfoo_bar\r\n"
                ),
                "hello\r\nbar\r\nfoo\tbar\r\nfoo\t \tb\r\nfoo bar\r\nfoo b\r\nfoo\r\nbar\r\nfoo_bar\r\n",
            ),
            ("\n\n", "\n\n"),
        ] {
            assert_eq!(
                String::from_utf8(
                    super::quoted_printable_decode(encoded_str.as_bytes()).unwrap_or_default()
                )
                .unwrap(),
                expected_result,
                "Failed for {encoded_str:?}",
            );
        }
    }

    #[test]
    fn decode_quoted_printable_mime() {
        for (encoded_str, expected_result) in [
            (
                "<meta content=\"text/html; charset=utf-8\"> h=C3=B6\n--boundary",
                "<meta content=\"text/html; charset=utf-8\"> hö",
            ),
            ("first=AZ second\n--boundary", "first=AZ second"),
            (
                "=E2=80=94=E2=80=89Antoine de Saint-Exup=C3=A9ry\n--boundary",
                "— Antoine de Saint-Exupéry",
            ),
            (
                "=E2=80=94=E2=80=89Antoine de Saint-Exup=C3=A9ry\n--\n--boundary",
                "— Antoine de Saint-Exupéry\n--",
            ),
            (
                "=E2=80=94=E2=80=89Antoine de Saint-Exup=C3=A9ry=\n--\n--boundary",
                "— Antoine de Saint-Exupéry--",
            ),
            (
                concat!(
                    "J'interdis aux marchands de vanter trop leurs marchandises. ",
                    "Car ils se font=\nvite p=C3=A9dagogues et t'enseignent comme but ce ",
                    "qui n'est par essence qu=\n'un moyen, et te trompant ainsi sur la route ",
                    "=C3=A0 suivre les voil=C3=\n=A0 bient=C3=B4t qui te d=C3=A9gradent, car ",
                    "si leur musique est vulgaire il=\ns te fabriquent pour te la vendre une ",
                    "=C3=A2me vulgaire.\n=E2=80=94=E2=80=89Antoine de Saint-Exup=C3=A9ry, ",
                    "Citadelle (1948)\r\n--boundary--"
                ),
                concat!(
                    "J'interdis aux marchands de vanter trop leurs marchandises. ",
                    "Car ils se fontvite pédagogues et t'enseignent comme but ce qui ",
                    "n'est par essence qu'un moyen, et te trompant ainsi sur la route ",
                    "à suivre les voilà bientôt qui te dégradent, car si leur musique ",
                    "est vulgaire ils te fabriquent pour te la vendre une âme vulgaire.\n",
                    "— Antoine de Saint-Exupéry, Citadelle (1948)"
                ),
            ),
            (
                "=E2=80=94=E2=80=89Antoine de Saint-Exup=C3=A9ry\n--\n--boundary",
                "— Antoine de Saint-Exupéry\n--",
            ),
            (
                concat!(
                    "Die Hasen klagten einst uber ihre Lage; \"wir ",
                    "leben\", sprach ein=\r\n Redner, \"in steter Furcht vor Menschen",
                    " und Tieren, eine Beute der Hunde,=\r\n der\r\n\r\n--boundary \n"
                ),
                concat!(
                    "Die Hasen klagten einst uber ihre Lage; \"wir leben\", ",
                    "sprach ein Redner, \"in steter Furcht vor Menschen und ",
                    "Tieren, eine Beute der Hunde, der\r\n"
                ),
            ),
            (
                concat!(
                    "hello  \r\nbar=\r\n\r\nfoo\t=\r\nbar\r\nfoo\t \t= \r\n=62\r\nfoo = ",
                    "\t\r\nbar\r\nfoo =\r\n=62\r\nfoo  \r\nbar=\r\n\r\nfoo_bar\r\n\r\n--boundary"
                ),
                "hello\r\nbar\r\nfoo\tbar\r\nfoo\t \tb\r\nfoo bar\r\nfoo b\r\nfoo\r\nbar\r\nfoo_bar\r\n",
            ),
        ] {
            let mut s = MessageStream::new(encoded_str.as_bytes());
            let (bytes_read, result) = s.decode_quoted_printable_mime(b"boundary");
            assert_ne!(bytes_read, usize::MAX);
            assert_eq!(
                std::str::from_utf8(result.as_ref()).unwrap(),
                expected_result,
                "Failed for {encoded_str:?}",
            );
        }
    }

    #[test]
    fn decode_quoted_printable_word() {
        for (encoded_str, expected_result) in [
            ("this=20is=20some=20text?=", "this is some text"),
            ("this=20is=20\n  some=20text?=", "this is some text"),
            ("this is some text?=", "this is some text"),
            ("Keith_Moore?=", "Keith Moore"),
            ("=2=123?=", ""),
            ("= 20?=", ""),
            ("=====?=", ""),
            ("=20=20=XX?=", ""),
            ("=AX?=", ""),
            ("=\n=\n==?=", ""),
            ("=\r=1z?=", ""),
            ("=|?=", ""),
            ("????????=", "???????"),
            ("\n\n", ""),
        ] {
            let mut s = MessageStream::new(encoded_str.as_bytes());

            assert_eq!(
                s.decode_quoted_printable_word().unwrap_or_default(),
                expected_result.as_bytes(),
                "Failed for {encoded_str:?}",
            );
        }
    }
}
