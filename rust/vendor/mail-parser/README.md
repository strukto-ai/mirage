# mail-parser

[![crates.io](https://img.shields.io/crates/v/mail-parser)](https://crates.io/crates/mail-parser)
[![build](https://github.com/stalwartlabs/mail-parser/actions/workflows/rust.yml/badge.svg)](https://github.com/stalwartlabs/mail-parser/actions/workflows/rust.yml)
[![docs.rs](https://img.shields.io/docsrs/mail-parser)](https://docs.rs/mail-parser)
[![crates.io](https://img.shields.io/crates/l/mail-parser)](http://www.apache.org/licenses/LICENSE-2.0)

_mail-parser_ is an **e-mail parsing library** written in Rust that fully conforms to the Internet Message Format standard (_RFC 5322_), the
Multipurpose Internet Mail Extensions (MIME; _RFC 2045 - 2049_) as well as many other [internet messaging RFCs](#conformed-rfcs).

It also supports decoding messages in [41 different character sets](#supported-character-sets) including obsolete formats such as UTF-7.
All Unicode (UTF-\*) and single-byte character sets are handled internally by the library while support for legacy multi-byte encodings of Chinese
and Japanese languages such as BIG5 or ISO-2022-JP is provided by the optional dependency [encoding_rs](https://crates.io/crates/encoding_rs).

In general, this library abides by the Postel's law or [Robustness Principle](https://en.wikipedia.org/wiki/Robustness_principle) which
states that an implementation must be conservative in its sending behavior and liberal in its receiving behavior. This means that
_mail-parser_ will make a best effort to parse non-conformant e-mail messages as long as these do not deviate too much from the standard.

Unlike other e-mail parsing libraries that return nested representations of the different MIME parts in a message, this library
conforms to [RFC 8621, Section 4.1.4](https://datatracker.ietf.org/doc/html/rfc8621#section-4.1.4) and provides a more human-friendly
representation of the message contents consisting of just text body parts, html body parts and attachments. Additionally, conversion to/from
HTML and plain text inline body parts is done automatically when the _alternative_ version is missing.

Performance and memory safety were two important factors while designing _mail-parser_:

- **Zero-copy**: Practically all strings returned by this library are `Cow<str>` references to the input raw message.
- **High performance Base64 decoding** based on Chromium's decoder ([the fastest non-SIMD decoder](https://github.com/lemire/fastbase64)).
- **Fast parsing** of message header fields, character set names and HTML entities using [perfect hashing](https://en.wikipedia.org/wiki/Perfect_hash_function).
- Written in **100% safe** Rust with no external dependencies.
- Every function in the library has been [fuzzed](#testing-fuzzing--benchmarking) and thoroughly [tested with MIRI](#testing-fuzzing--benchmarking).
- **Battle-tested** with millions of real-world e-mail messages dating from 1995 until today.
- Used in production environments worldwide by [Stalwart Mail Server](https://github.com/stalwartlabs/mail-server).

## Usage Example

```rust
    let input = br#"From: Art Vandelay <art@vandelay.com> (Vandelay Industries)
To: "Colleagues": "James Smythe" <james@vandelay.com>; Friends:
    jane@example.com, =?UTF-8?Q?John_Sm=C3=AEth?= <john@example.com>;
Date: Sat, 20 Nov 2021 14:22:01 -0800
Subject: Why not both importing AND exporting? =?utf-8?b?4pi6?=
Content-Type: multipart/mixed; boundary="festivus";

--festivus
Content-Type: text/html; charset="us-ascii"
Content-Transfer-Encoding: base64

PGh0bWw+PHA+SSB3YXMgdGhpbmtpbmcgYWJvdXQgcXVpdHRpbmcgdGhlICZsZHF1bztle
HBvcnRpbmcmcmRxdW87IHRvIGZvY3VzIGp1c3Qgb24gdGhlICZsZHF1bztpbXBvcnRpbm
cmcmRxdW87LDwvcD48cD5idXQgdGhlbiBJIHRob3VnaHQsIHdoeSBub3QgZG8gYm90aD8
gJiN4MjYzQTs8L3A+PC9odG1sPg==
--festivus
Content-Type: message/rfc822

From: "Cosmo Kramer" <kramer@kramerica.com>
Subject: Exporting my book about coffee tables
Content-Type: multipart/mixed; boundary="giddyup";

--giddyup
Content-Type: text/plain; charset="utf-16"
Content-Transfer-Encoding: quoted-printable

=FF=FE=0C!5=D8"=DD5=D8)=DD5=D8-=DD =005=D8*=DD5=D8"=DD =005=D8"=
=DD5=D85=DD5=D8-=DD5=D8,=DD5=D8/=DD5=D81=DD =005=D8*=DD5=D86=DD =
=005=D8=1F=DD5=D8,=DD5=D8,=DD5=D8(=DD =005=D8-=DD5=D8)=DD5=D8"=
=DD5=D8=1E=DD5=D80=DD5=D8"=DD!=00
--giddyup
Content-Type: image/gif; name*1="about "; name*0="Book ";
              name*2*=utf-8''%e2%98%95 tables.gif
Content-Transfer-Encoding: Base64
Content-Disposition: attachment

R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7
--giddyup--
--festivus--
"#;

    let message = MessageParser::default().parse(input).unwrap();

    // Parses addresses (including comments), lists and groups
    assert_eq!(
        message.from().unwrap().first().unwrap(),
        &Addr::new(
            "Art Vandelay (Vandelay Industries)".into(),
            "art@vandelay.com"
        )
    );

    assert_eq!(
        message.to().unwrap().as_group().unwrap(),
        &[
            Group::new(
                "Colleagues",
                vec![Addr::new("James Smythe".into(), "james@vandelay.com")]
            ),
            Group::new(
                "Friends",
                vec![
                    Addr::new(None, "jane@example.com"),
                    Addr::new("John Smîth".into(), "john@example.com"),
                ]
            )
        ]
    );

    assert_eq!(
        message.date().unwrap().to_rfc3339(),
        "2021-11-20T14:22:01-08:00"
    );

    // RFC2047 support for encoded text in message readers
    assert_eq!(
        message.subject().unwrap(),
        "Why not both importing AND exporting? ☺"
    );

    // HTML and text body parts are returned conforming to RFC8621, Section 4.1.4
    assert_eq!(
        message.body_html(0).unwrap(),
        concat!(
            "<html><p>I was thinking about quitting the &ldquo;exporting&rdquo; to ",
            "focus just on the &ldquo;importing&rdquo;,</p><p>but then I thought,",
            " why not do both? &#x263A;</p></html>"
        )
    );

    // HTML parts are converted to plain text (and viceversa) when missing
    assert_eq!(
        message.body_text(0).unwrap(),
        concat!(
            "I was thinking about quitting the “exporting” to focus just on the",
            " “importing”,\nbut then I thought, why not do both? ☺\n"
        )
    );

    // Supports nested messages as well as multipart/digest
    let nested_message = message
        .attachment(0)
        .unwrap()
        .message();
        .unwrap();

    assert_eq!(
        nested_message.subject().unwrap(),
        "Exporting my book about coffee tables"
    );

    // Handles UTF-* as well as many legacy encodings
    assert_eq!(
        nested_message.body_text(0).unwrap(),
        "ℌ𝔢𝔩𝔭 𝔪𝔢 𝔢𝔵𝔭𝔬𝔯𝔱 𝔪𝔶 𝔟𝔬𝔬𝔨 𝔭𝔩𝔢𝔞𝔰𝔢!"
    );
    assert_eq!(
        nested_message.body_html(0).unwrap(),
        "<html><body>ℌ𝔢𝔩𝔭 𝔪𝔢 𝔢𝔵𝔭𝔬𝔯𝔱 𝔪𝔶 𝔟𝔬𝔬𝔨 𝔭𝔩𝔢𝔞𝔰𝔢!</body></html>"
    );

    let nested_attachment = nested_message.attachment(0).unwrap();

    assert_eq!(nested_attachment.len(), 42);

    // Full RFC2231 support for continuations and character sets
    assert_eq!(
        nested_attachment.attachment_name().unwrap(),
        "Book about ☕ tables.gif"
    );

    // Integrates with Serde
    println!("{}", serde_json::to_string_pretty(&message).unwrap());
```

More examples available under the [examples](examples) directory. Please note that this library does not support building e-mail messages as this functionality is provided separately by the [`mail-builder`](https://crates.io/crates/mail-builder) crate.

## Testing, Fuzzing & Benchmarking

To run the testsuite:

```bash
 $ cargo test --all-features
```

or, to run the testsuite with MIRI:

```bash
 $ cargo +nightly miri test --all-features
```

To fuzz the library with `cargo-fuzz`:

```bash
 $ cargo +nightly fuzz run mail_parser
```

and, to run the benchmarks:

```bash
 $ cargo +nightly bench --all-features
```

## Conformed RFCs

- [RFC 822 - Standard for ARPA Internet Text Messages](https://datatracker.ietf.org/doc/html/rfc822)
- [RFC 5322 - Internet Message Format](https://datatracker.ietf.org/doc/html/rfc5322)
- [RFC 2045 - Multipurpose Internet Mail Extensions (MIME) Part One: Format of Internet Message Bodies](https://datatracker.ietf.org/doc/html/rfc2045)
- [RFC 2046 - Multipurpose Internet Mail Extensions (MIME) Part Two: Media Types](https://datatracker.ietf.org/doc/html/rfc2046)
- [RFC 2047 - MIME (Multipurpose Internet Mail Extensions) Part Three: Message Header Extensions for Non-ASCII Text](https://datatracker.ietf.org/doc/html/rfc2047)
- [RFC 2048 - Multipurpose Internet Mail Extensions (MIME) Part Four: Registration Procedures](https://datatracker.ietf.org/doc/html/rfc2048)
- [RFC 2049 - Multipurpose Internet Mail Extensions (MIME) Part Five: Conformance Criteria and Examples](https://datatracker.ietf.org/doc/html/rfc2049)
- [RFC 2231 - MIME Parameter Value and Encoded Word Extensions: Character Sets, Languages, and Continuations](https://datatracker.ietf.org/doc/html/rfc2231)
- [RFC 2557 - MIME Encapsulation of Aggregate Documents, such as HTML (MHTML)](https://datatracker.ietf.org/doc/html/rfc2557)
- [RFC 2183 - Communicating Presentation Information in Internet Messages: The Content-Disposition Header Field](https://datatracker.ietf.org/doc/html/rfc2183)
- [RFC 2392 - Content-ID and Message-ID Uniform Resource Locators](https://datatracker.ietf.org/doc/html/rfc2392)
- [RFC 3282 - Content Language Headers](https://datatracker.ietf.org/doc/html/rfc3282)
- [RFC 6532 - Internationalized Email Headers](https://datatracker.ietf.org/doc/html/rfc6532)
- [RFC 2152 - UTF-7 - A Mail-Safe Transformation Format of Unicode](https://datatracker.ietf.org/doc/html/rfc2152)
- [RFC 2369 - The Use of URLs as Meta-Syntax for Core Mail List Commands and their Transport through Message Header Fields](https://datatracker.ietf.org/doc/html/rfc2369)
- [RFC 2919 - List-Id: A Structured Field and Namespace for the Identification of Mailing Lists](https://datatracker.ietf.org/doc/html/rfc2919)
- [RFC 3339 - Date and Time on the Internet: Timestamps](https://datatracker.ietf.org/doc/html/rfc3339)
- [RFC 8621 - The JSON Meta Application Protocol (JMAP) for Mail (Section 4.1.4)](https://datatracker.ietf.org/doc/html/rfc8621#section-4.1.4)
- [RFC 5957 - Internet Message Access Protocol - SORT and THREAD Extensions (Section 2.1)](https://datatracker.ietf.org/doc/html/rfc5256#section-2.1)

## Supported Character Sets

- UTF-8
- UTF-16, UTF-16BE, UTF-16LE
- UTF-7
- US-ASCII
- ISO-8859-1
- ISO-8859-2
- ISO-8859-3
- ISO-8859-4
- ISO-8859-5
- ISO-8859-6
- ISO-8859-7
- ISO-8859-8
- ISO-8859-9
- ISO-8859-10
- ISO-8859-13
- ISO-8859-14
- ISO-8859-15
- ISO-8859-16
- CP1250
- CP1251
- CP1252
- CP1253
- CP1254
- CP1255
- CP1256
- CP1257
- CP1258
- KOI8-R
- KOI8_U
- MACINTOSH
- IBM850
- TIS-620

Supported character sets via the optional dependency [encoding_rs](https://crates.io/crates/encoding_rs):

- SHIFT_JIS
- BIG5
- EUC-JP
- EUC-KR
- GB18030
- GBK
- ISO-2022-JP
- WINDOWS-874
- IBM-866

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

## Copyright

Copyright (C) 2020, Stalwart Labs LLC
