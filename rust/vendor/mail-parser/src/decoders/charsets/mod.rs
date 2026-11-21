/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

pub mod map;
pub mod multi_byte;
pub mod single_byte;
pub mod utf;

pub type DecoderFnc = fn(&[u8]) -> String;

#[cfg(test)]
mod tests {
    use super::map::charset_decoder;

    #[test]
    fn decode_charset() {
        let inputs = [
            ("iso-8859-1", b"\xe1\xe9\xed\xf3\xfa".to_vec(), "áéíóú"),
            ("iso-8859-1", b"\x805.4bn".to_vec(), "€5.4bn"),
            ("latin1", b"\x805.4bn".to_vec(), "€5.4bn"),
            ("iso88591", b"\x805.4bn".to_vec(), "€5.4bn"),
            ("us-ascii", b"\x805.4bn".to_vec(), "€5.4bn"),
            ("iso8859-5", b"\xbf\xe0\xd8\xd2\xd5\xe2, \xdc\xd8\xe0".to_vec(), "Привет, мир"),
            ("cp1252", b"\xa1El \xf1and\xfa comi\xf3 \xf1oquis!".to_vec(), "¡El ñandú comió ñoquis!"),
            ("iso-8859-5", b"\xbf\xe0\xd8\xd2\xd5\xe2, \xdc\xd8\xe0".to_vec(), "Привет, мир"),
            ("iso-8859-6", b"\xe5\xd1\xcd\xc8\xc7 \xc8\xc7\xe4\xd9\xc7\xe4\xe5".to_vec(),"مرحبا بالعالم"),
            ("iso-8859-7", b"\xc3\xe5\xe9\xdc \xf3\xef\xf5 \xca\xfc\xf3\xec\xe5".to_vec(),"Γειά σου Κόσμε"),
            ("iso-8859-8", b"\xf9\xec\xe5\xed \xf2\xe5\xec\xed".to_vec(),"שלום עולם"),
            ("iso-8859-11", b"\xc3\xcb\xd1\xca\xca\xd3\xcb\xc3\xd1\xba\xcd\xd1\xa1\xa2\xc3\xd0\xe4\xb7\xc2\xb7\xd5\xe8\xe3\xaa\xe9\xa1\xd1\xba\xa4\xcd\xc1\xbe\xd4\xc7\xe0\xb5\xcd\xc3\xec".to_vec(),"รหัสสำหรับอักขระไทยที่ใช้กับคอมพิวเตอร์"),
            ("windows-1250", b"Zelo rada grem v sla\x9a\xe8i\xe8arno".to_vec(),"Zelo rada grem v slaščičarno"),
            ("windows-1251", b"\xcf\xf0\xe8\xe2\xe5\xf2, \xec\xe8\xf0".to_vec(),"Привет, мир"),
            ("windows-1252", b"\xa1El \xf1and\xfa comi\xf3 \xf1oquis!".to_vec(),"¡El ñandú comió ñoquis!"),
            ("windows-1253", b"\xca\xf9\xe4\xe9\xea\xef\xdf \xd3\xf9\xea\xf1\xdc\xf4\xe7\xf2 \xf3\xf4\xef Rust".to_vec(),"Κωδικοί Σωκράτης στο Rust"),
            ("windows-1254", b"Kebab\xfdm\xfd baharatl\xfd yapma".to_vec(),"Kebabımı baharatlı yapma"),
            ("windows-1255", b"\xf9\xec\xe5\xed \xf2\xe5\xec\xed".to_vec(),"שלום עולם"),
            ("windows-1256", b"\xe3\xd1\xcd\xc8\xc7 \xc8\xc7\xe1\xda\xc7\xe1\xe3".to_vec(),"مرحبا بالعالم"),
            ("windows-1257", b"Mu h\xf5ljuk on angerjaid t\xe4is".to_vec(),"Mu hõljuk on angerjaid täis"),
            ("windows-1258", b"Xin ch\xe0o".to_vec(),"Xin chào"),
            ("macintosh", b"\x87\x8e\x92\x97\x9c".to_vec(),"áéíóú"),
            ("ibm850", b"\x9b\x9c\x9d\x9e".to_vec(),"ø£Ø×"),
            ("koi8-r", b"\xf0\xd2\xc9\xd7\xc5\xd4, \xcd\xc9\xd2".to_vec(),"Привет, мир"),
            ("koi8-u", b"\xf0\xd2\xc9\xd7\xa6\xd4 \xf3\xd7\xa6\xd4".to_vec(),"Привіт Світ"),
            ("utf-7", b"+ZYeB9FH6ckh5Pg-, 1980.".to_vec(),"文致出版社, 1980."),
            ("utf-16le", b"\xcf0\xed0\xfc0\xfb0\xef0\xfc0\xeb0\xc90".to_vec(),"ハロー・ワールド"),
            ("utf-16be", b"0\xcf0\xed0\xfc0\xfb0\xef0\xfc0\xeb0\xc9".to_vec(),"ハロー・ワールド"),
            ("utf-16", b"\xff\xfe\xe1\x00\xe9\x00\xed\x00\xf3\x00\xfa\x00".to_vec(),"áéíóú"), // Little endian
            ("utf-16", b"\xfe\xff\x00\xe1\x00\xe9\x00\xed\x00\xf3\x00\xfa".to_vec(),"áéíóú"), // Big endian

            #[cfg(feature = "full_encoding")]
            ("shift_jis", b"\x83n\x83\x8D\x81[\x81E\x83\x8F\x81[\x83\x8B\x83h".to_vec(),"ハロー・ワールド"),
            #[cfg(feature = "full_encoding")]
            ("big5", b"\xa7A\xa6n\xa1A\xa5@\xac\xc9".to_vec(),"你好，世界"),
            #[cfg(feature = "full_encoding")]
            ("euc-jp", b"\xa5\xcf\xa5\xed\xa1\xbc\xa1\xa6\xa5\xef\xa1\xbc\xa5\xeb\xa5\xc9".to_vec(),"ハロー・ワールド"),
            #[cfg(feature = "full_encoding")]
            ("euc-kr", b"\xbe\xc8\xb3\xe7\xc7\xcf\xbc\xbc\xbf\xe4 \xbc\xbc\xb0\xe8".to_vec(),"안녕하세요 세계"),
            #[cfg(feature = "full_encoding")]
            ("iso-2022-jp", b"\x1b$B%O%m!<!&%o!<%k%I\x1b(B".to_vec(),"ハロー・ワールド"),
            #[cfg(feature = "full_encoding")]
            ("gbk", b"\xc4\xe3\xba\xc3\xa3\xac\xca\xc0\xbd\xe7".to_vec(),"你好，世界"),
            #[cfg(feature = "full_encoding")]
            ("gb18030", b"\xc4\xe3\xba\xc3\xa3\xac\xca\xc0\xbd\xe7".to_vec(),"你好，世界"),
            #[cfg(feature = "full_encoding")]
            ("x-mac-cyrillic", b"\x8f\xf0\xe8\xe2\xe5\xf2".to_vec(),"Привет"),
            #[cfg(feature = "full_encoding")]
            ("x-user-defined", b"\x80\xff".to_vec(),"\u{f780}\u{f7ff}"),
            #[cfg(feature = "full_encoding")]
            ("iso-2022-kr", b"\x1b$)Cabcd".to_vec(),"\u{fffd}"),
            #[cfg(feature = "full_encoding")]
            ("hz-gb-2312", b"~{...~}".to_vec(),"\u{fffd}"),
            ];

        for input in inputs {
            let decoder = charset_decoder(input.0.as_bytes()).unwrap_or_else(|| {
                panic!("{}", ("Failed to find decoder for ".to_owned() + input.0))
            });

            assert_eq!(decoder(&input.1), input.2);
        }
    }
}
