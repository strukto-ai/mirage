/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use super::DecodeWordFnc;
use crate::{decoders::charsets::map::charset_decoder, parsers::MessageStream};

enum Rfc2047State {
    Init,
    Charset,
    Encoding,
    Data,
}

impl MessageStream<'_> {
    pub fn decode_rfc2047(&mut self) -> Option<String> {
        let mut state = Rfc2047State::Init;

        let mut charset_start = 0;
        let mut charset_end = 0;
        let mut decode_fnc: Option<DecodeWordFnc<'_>> = None;

        while let Some(ch) = self.next() {
            match state {
                Rfc2047State::Init => {
                    if ch != &b'?' {
                        return None;
                    }
                    state = Rfc2047State::Charset;
                    charset_start = self.offset();
                    charset_end = self.offset();
                }
                Rfc2047State::Charset => match ch {
                    b'?' => {
                        if charset_end == charset_start {
                            charset_end = self.offset() - 1;
                        }
                        if (charset_end - charset_start) < 2 {
                            return None;
                        }
                        state = Rfc2047State::Encoding;
                    }
                    b'*' if charset_end == charset_start => {
                        charset_end = self.offset() - 1;
                    }
                    b'\n' => {
                        return None;
                    }
                    _ => (),
                },
                Rfc2047State::Encoding => {
                    match ch {
                        b'q' | b'Q' => {
                            decode_fnc = Some(MessageStream::decode_quoted_printable_word)
                        }
                        b'b' | b'B' => decode_fnc = Some(MessageStream::decode_base64_word),
                        _ => {
                            return None;
                        }
                    }
                    state = Rfc2047State::Data;
                }
                Rfc2047State::Data => {
                    if ch != &b'?' {
                        return None;
                    } else {
                        break;
                    }
                }
            }
        }

        if let Some(bytes) = decode_fnc.and_then(|fnc| fnc(self)) {
            if let Some(decoder) = charset_decoder(self.bytes(charset_start..charset_end)) {
                decoder(&bytes).into()
            } else {
                String::from_utf8(bytes)
                    .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
                    .into()
            }
        } else {
            None
        }
    }
}
#[cfg(test)]
mod tests {
    use crate::parsers::MessageStream;

    #[test]
    fn decode_rfc2047() {
        for (input, expected_result, _) in [
            (
                "?iso-8859-1?q?this=20is=20some=20text?=",
                "this is some text",
                true,
            ),
            (
                "?iso-8859-1?q?this is some text?=",
                "this is some text",
                true,
            ),
            ("?US-ASCII?Q?Keith_Moore?=", "Keith Moore", false),
            (
                "?iso_8859-1:1987?Q?Keld_J=F8rn_Simonsen?=",
                "Keld Jørn Simonsen",
                true,
            ),
            (
                "?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?=",
                "If you can read this yo",
                true,
            ),
            (
                "?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=",
                "u understand the example.",
                true,
            ),
            ("?ISO-8859-1?Q?Olle_J=E4rnefors?=", "Olle Järnefors", true),
            ("?iso-8859-1?Q?=805.4bn?=", "€5.4bn", true),
            (
                "?ISO-8859-1?Q?Patrik_F=E4ltstr=F6m?=",
                "Patrik Fältström",
                true,
            ),
            ("?ISO-8859-1*?Q?a?=", "a", true),
            ("?ISO-8859-1**?Q?a_b?=", "a b", true),
            (
                "?utf-8?b?VGjDrXMgw61zIHbDoWzDrWQgw5pURjg=?=",
                "Thís ís válíd ÚTF8",
                false,
            ),
            (
                "?utf-8*unknown?q?Th=C3=ADs_=C3=ADs_v=C3=A1l=C3=ADd_=C3=9ATF8?=",
                "Thís ís válíd ÚTF8",
                false,
            ),
            (
                "?Iso-8859-6?Q?=E5=D1=CD=C8=C7 =C8=C7=E4=D9=C7=E4=E5?=",
                "مرحبا بالعالم",
                true,
            ),
            (
                "?Iso-8859-6*arabic?b?5dHNyMcgyMfk2cfk5Q==?=",
                "مرحبا بالعالم",
                true,
            ),
            #[cfg(feature = "full_encoding")]
            (
                "?shift_jis?B?g26DjYFbgUWDj4Fbg4uDaA==?=",
                "ハロー・ワールド",
                true,
            ),
            #[cfg(feature = "full_encoding")]
            (
                "?iso-2022-jp?q?=1B$B%O%m!<!&%o!<%k%I=1B(B?=",
                "ハロー・ワールド",
                true,
            ),
        ] {
            match MessageStream::new(input.as_bytes()).decode_rfc2047() {
                Some(result) => {
                    //println!("Decoded '{}'", string);
                    assert_eq!(result, expected_result);
                }
                _ => panic!("Failed to decode '{}'", input),
            }
        }
    }
}
