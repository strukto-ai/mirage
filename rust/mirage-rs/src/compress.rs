use flate2::{Compress, Compression, Crc, Decompress, FlushCompress, FlushDecompress, Status};
use serde::{Deserialize, Serialize};

use crate::{Stream, StreamError, parse_config};

const INPUT: usize = 16 * 1024;
const OUTPUT: usize = 64 * 1024;
const EOF: &str = "\ngzip: {}: unexpected end of file";
const CORRUPT: &str = "\ngzip: {}: invalid compressed data--format violated";

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Format {
    Gzip,
    Raw,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Config {
    Encode {
        format: Format,
        #[serde(default = "default_level")]
        level: i32,
        #[serde(default)]
        name: String,
    },
    Decode {
        format: Format,
        #[serde(default)]
        test: bool,
        #[serde(default)]
        passthrough: bool,
    },
}

fn default_level() -> i32 {
    -1
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    match parse_config(config)? {
        Config::Encode {
            format,
            level,
            name,
        } => {
            if !(-1..=9).contains(&level) {
                return Err(StreamError::new("invalid compression level"));
            }
            Ok(Box::new(Encoder::new(format, level, name)))
        }
        Config::Decode {
            format,
            test,
            passthrough,
        } => Ok(Box::new(Decoder::new(format, test, passthrough))),
    }
}

#[derive(Serialize)]
struct Failure {
    reasons: Vec<String>,
    fatal: bool,
    exit_code: i32,
    keeps_output: bool,
    first_header: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Part {
    Fixed,
    ExtraLength,
    Extra(usize),
    Name,
    Comment,
    HeaderCrc,
    Body,
    Trailer,
    Padding,
    Copy,
    End,
}

struct Decoder {
    format: Format,
    test: bool,
    passthrough: bool,
    part: Part,
    fixed: Vec<u8>,
    flags: u8,
    header_crc: Crc,
    crc: Crc,
    held: Vec<u8>,
    inflater: Decompress,
    seen: bool,
    input: Vec<u8>,
    at: usize,
    again: bool,
    eof: bool,
    failure: Option<Failure>,
    reported: bool,
}

impl Decoder {
    fn new(format: Format, test: bool, passthrough: bool) -> Self {
        Self {
            format,
            test,
            passthrough,
            part: if format == Format::Gzip {
                Part::Fixed
            } else {
                Part::Body
            },
            fixed: Vec::with_capacity(10),
            flags: 0,
            header_crc: Crc::new(),
            crc: Crc::new(),
            held: Vec::with_capacity(32768),
            inflater: Decompress::new(false),
            seen: false,
            input: Vec::new(),
            at: 0,
            again: false,
            eof: false,
            failure: None,
            reported: false,
        }
    }

    fn refuse(&mut self, reason: String, exit_code: i32) {
        self.fail(vec![reason], false, exit_code, self.seen, !self.seen);
    }

    fn fail(
        &mut self,
        reasons: Vec<String>,
        fatal: bool,
        exit_code: i32,
        keeps_output: bool,
        first_header: bool,
    ) {
        self.failure = Some(Failure {
            reasons,
            fatal,
            exit_code,
            keeps_output,
            first_header,
        });
        self.part = Part::End;
    }

    fn fixed_bytes(&mut self, data: &[u8], size: usize, header: bool) -> usize {
        let count = (size - self.fixed.len()).min(data.len());
        self.fixed.extend_from_slice(&data[..count]);
        if header {
            self.header_crc.update(&data[..count]);
        }
        count
    }

    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let input = std::mem::take(&mut self.input);
        let result = self.process(&input, out);
        self.input = input;
        if self.at == self.input.len() || self.part == Part::End {
            self.input.clear();
            self.at = 0;
        }
        result
    }

    fn process(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        while self.part != Part::End {
            let data = &input[self.at..];
            if data.is_empty() && !self.again {
                let advances = match self.part {
                    Part::ExtraLength => self.flags & 4 == 0,
                    Part::Extra(0) => true,
                    Part::Name => self.flags & 8 == 0,
                    Part::Comment => self.flags & 16 == 0,
                    Part::HeaderCrc => self.flags & 2 == 0,
                    _ => false,
                };
                if !advances {
                    break;
                }
            }
            match self.part {
                Part::Fixed => {
                    if self.fixed.is_empty() && self.seen && !self.passthrough && data[0] == 0 {
                        self.part = Part::Padding;
                        continue;
                    }
                    let target = match self.fixed.len() {
                        0..=1 => 2,
                        2 => 3,
                        3 => 4,
                        _ => 10,
                    };
                    self.at += self.fixed_bytes(data, target, true);
                    if self.fixed.len() < target {
                        break;
                    }
                    if target == 2 && self.fixed != [0x1f, 0x8b] && self.fixed != [0x1f, 0x9e] {
                        if self.passthrough {
                            out.extend_from_slice(&self.fixed);
                            self.fixed.clear();
                            self.part = Part::Copy;
                            break;
                        }
                        self.refuse(
                            if self.seen {
                                "\ngzip: {}: decompression OK, trailing garbage ignored"
                            } else {
                                "\ngzip: {}: not in gzip format"
                            }
                            .into(),
                            if self.seen { 2 } else { 1 },
                        );
                    } else if target == 3 && self.fixed[2] != 8 {
                        self.refuse(
                            format!(
                                "gzip: {{}}: unknown method {} -- not supported",
                                self.fixed[2]
                            ),
                            1,
                        );
                    } else if target == 4 {
                        self.flags = self.fixed[3];
                        if self.flags & 0x20 != 0 {
                            self.refuse("gzip: {} is encrypted -- not supported".into(), 1);
                        } else if self.flags & 0xc0 != 0 {
                            self.refuse(
                                format!("gzip: {{}} has flags 0x{:x} -- not supported", self.flags),
                                1,
                            );
                        }
                    } else if target == 10 {
                        self.fixed.clear();
                        self.part = Part::ExtraLength;
                    }
                }
                Part::ExtraLength => {
                    if self.flags & 4 == 0 {
                        self.part = Part::Name;
                        continue;
                    }
                    self.at += self.fixed_bytes(data, 2, true);
                    if self.fixed.len() < 2 {
                        break;
                    }
                    self.part = Part::Extra(usize::from(u16::from_le_bytes([
                        self.fixed[0],
                        self.fixed[1],
                    ])));
                    self.fixed.clear();
                }
                Part::Extra(left) => {
                    let count = left.min(data.len());
                    self.header_crc.update(&data[..count]);
                    self.at += count;
                    self.part = if count == left {
                        Part::Name
                    } else {
                        Part::Extra(left - count)
                    };
                }
                Part::Name | Part::Comment => {
                    let flag = if self.part == Part::Name { 8 } else { 16 };
                    if self.flags & flag != 0 {
                        let end = memchr::memchr(0, data);
                        let count = end.map_or(data.len(), |i| i + 1);
                        self.header_crc.update(&data[..count]);
                        self.at += count;
                        if end.is_none() {
                            break;
                        }
                    }
                    self.part = if self.part == Part::Name {
                        Part::Comment
                    } else {
                        Part::HeaderCrc
                    };
                }
                Part::HeaderCrc => {
                    if self.flags & 2 != 0 {
                        self.at += self.fixed_bytes(data, 2, false);
                        if self.fixed.len() < 2 {
                            break;
                        }
                        let stored = u16::from_le_bytes([self.fixed[0], self.fixed[1]]);
                        let computed = self.header_crc.sum() as u16;
                        if stored != computed {
                            self.refuse(format!("gzip: {{}}: header checksum 0x{stored:04x} != computed checksum 0x{computed:04x}"), 1);
                            continue;
                        }
                        self.fixed.clear();
                    }
                    self.inflater.reset(false);
                    self.crc.reset();
                    self.part = Part::Body;
                }
                Part::Body => {
                    let mut output = [0; OUTPUT];
                    let limit = if self.format == Format::Raw {
                        INPUT
                    } else {
                        OUTPUT - self.held.len()
                    };
                    let before_in = self.inflater.total_in();
                    let before_out = self.inflater.total_out();
                    let status =
                        self.inflater
                            .decompress(data, &mut output[..limit], FlushDecompress::None);
                    let consumed = (self.inflater.total_in() - before_in) as usize;
                    let produced = (self.inflater.total_out() - before_out) as usize;
                    self.at += consumed;
                    self.crc.update(&output[..produced]);
                    if self.format == Format::Raw && status.is_ok() {
                        out.extend_from_slice(&output[..produced]);
                    } else if self.format == Format::Gzip {
                        self.held.extend_from_slice(&output[..produced]);
                        // gzip only flushes complete windows before a body format error.
                        let emit = if matches!(status, Ok(Status::StreamEnd)) {
                            self.held.len()
                        } else {
                            self.held.len() / 32768 * 32768
                        };
                        out.extend_from_slice(&self.held[..emit]);
                        self.held.drain(..emit);
                    }
                    self.again = produced == limit;
                    match status {
                        Err(error) => {
                            if self.format == Format::Raw {
                                self.part = Part::End;
                                return Err(StreamError::new(
                                    error.message().unwrap_or("invalid deflate stream"),
                                ));
                            }
                            self.fail(vec![CORRUPT.into()], true, 1, false, false);
                            self.held.clear();
                        }
                        Ok(Status::StreamEnd) => {
                            self.again = false;
                            self.part = if self.format == Format::Raw {
                                Part::End
                            } else {
                                Part::Trailer
                            };
                        }
                        _ => {}
                    }
                    if produced > 0 || !out.is_empty() {
                        return Ok(());
                    }
                    if consumed == 0 && self.part == Part::Body {
                        self.again = false;
                        break;
                    }
                }
                Part::Trailer => {
                    self.at += self.fixed_bytes(data, 8, false);
                    if self.fixed.len() < 8 {
                        break;
                    }
                    let mut reasons = Vec::new();
                    if u32::from_le_bytes(self.fixed[..4].try_into().expect("CRC"))
                        != self.crc.sum()
                    {
                        reasons.push("\ngzip: {}: invalid compressed data--crc error".into());
                    }
                    if u32::from_le_bytes(self.fixed[4..].try_into().expect("length"))
                        != self.crc.amount()
                    {
                        reasons.push("\ngzip: {}: invalid compressed data--length error".into());
                    }
                    if !reasons.is_empty() {
                        self.fail(reasons, !self.test, 1, true, false);
                        continue;
                    }
                    self.seen = true;
                    self.fixed.clear();
                    self.header_crc.reset();
                    self.part = Part::Fixed;
                }
                Part::Padding => {
                    self.at = input.len();
                    if data.iter().any(|b| *b != 0) {
                        self.refuse(
                            "\ngzip: {}: decompression OK, trailing garbage ignored".into(),
                            2,
                        );
                    }
                }
                Part::Copy => {
                    out.extend_from_slice(data);
                    self.at = input.len();
                    return Ok(());
                }
                Part::End => break,
            }
        }
        if self.eof && self.part != Part::End && !self.again && self.at == input.len() {
            if self.format == Format::Raw {
                self.part = Part::End;
                return Err(StreamError::new("truncated deflate stream"));
            }
            let boundary = self.part == Part::Fixed;
            if self.part == Part::Copy || (self.passthrough && boundary && self.fixed.len() < 2) {
                out.extend_from_slice(&self.fixed);
                self.fixed.clear();
                self.part = Part::End;
            } else if self.part == Part::Padding || (self.seen && boundary && self.fixed.is_empty())
            {
                self.part = Part::End;
            } else {
                out.append(&mut self.held);
                let header = matches!(
                    self.part,
                    Part::Fixed
                        | Part::ExtraLength
                        | Part::Extra(_)
                        | Part::Name
                        | Part::Comment
                        | Part::HeaderCrc
                );
                let whole = self.part == Part::Trailer || (self.seen && header);
                let first = !self.seen && header;
                if !self.seen && self.part == Part::Fixed && self.fixed == [0] {
                    self.refuse("\ngzip: {}: not in gzip format".into(), 1);
                } else {
                    self.fail(vec![EOF.into()], true, 1, whole, first);
                }
            }
        }
        Ok(())
    }
}

impl Stream for Decoder {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if input.len() > INPUT || self.busy() {
            return Err(StreamError::new(
                "compression input must be bounded and drained",
            ));
        }
        if self.part == Part::End {
            return Ok(());
        }
        self.input.extend_from_slice(input);
        self.step(out)
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.eof = true;
        self.step(out)
    }
    fn busy(&self) -> bool {
        self.part != Part::End && (self.at < self.input.len() || self.again || self.eof)
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out)
    }
    fn done(&self) -> bool {
        self.part == Part::End
    }
    fn status(&self) -> i32 {
        self.failure.as_ref().map_or(0, |f| f.exit_code)
    }
    fn take_stderr(&mut self, out: &mut Vec<u8>) {
        if let Some(failure) = self.failure.as_ref().filter(|_| !self.reported) {
            serde_json::to_writer(out, failure).expect("gzip failure serializes");
            self.reported = true;
        }
    }
}

struct Encoder {
    format: Format,
    compressor: Compress,
    crc: Crc,
    header: Vec<u8>,
    header_at: usize,
    input: Vec<u8>,
    at: usize,
    eof: bool,
    ended: bool,
    again: bool,
}

impl Encoder {
    fn new(format: Format, level: i32, name: String) -> Self {
        let mut header = Vec::new();
        if format == Format::Gzip {
            header.extend_from_slice(&[
                0x1f,
                0x8b,
                8,
                if name.is_empty() { 0 } else { 8 },
                0,
                0,
                0,
                0,
                if level == 9 {
                    2
                } else if level == 1 {
                    4
                } else {
                    0
                },
                3,
            ]);
            if !name.is_empty() {
                header.extend_from_slice(name.as_bytes());
                header.push(0);
            }
        }
        Self {
            format,
            compressor: Compress::new(
                Compression::new(if level < 0 { 6 } else { level as u32 }),
                false,
            ),
            crc: Crc::new(),
            header,
            header_at: 0,
            input: Vec::new(),
            at: 0,
            eof: false,
            ended: false,
            again: false,
        }
    }
    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.header_at < self.header.len() {
            let end = (self.header_at + INPUT).min(self.header.len());
            out.extend_from_slice(&self.header[self.header_at..end]);
            self.header_at = end;
            return Ok(());
        }
        if self.ended {
            return Ok(());
        }
        let mut output = [0; INPUT];
        let before_in = self.compressor.total_in();
        let before_out = self.compressor.total_out();
        let status = self
            .compressor
            .compress(
                &self.input[self.at..],
                &mut output,
                if self.eof {
                    FlushCompress::Finish
                } else {
                    FlushCompress::None
                },
            )
            .map_err(|e| StreamError::new(e.to_string()))?;
        self.at += (self.compressor.total_in() - before_in) as usize;
        let produced = (self.compressor.total_out() - before_out) as usize;
        out.extend_from_slice(&output[..produced]);
        self.again = produced == INPUT;
        if self.at == self.input.len() {
            self.input.clear();
            self.at = 0;
        }
        if status == Status::StreamEnd {
            self.ended = true;
            self.again = false;
            if self.format == Format::Gzip {
                self.header = [
                    self.crc.sum().to_le_bytes(),
                    self.crc.amount().to_le_bytes(),
                ]
                .concat();
                self.header_at = 0;
            }
        }
        Ok(())
    }
}

impl Stream for Encoder {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if input.len() > INPUT || !self.input.is_empty() || self.again || self.eof {
            return Err(StreamError::new(
                "compression input must be bounded and drained",
            ));
        }
        self.crc.update(input);
        self.input.extend_from_slice(input);
        self.step(out)
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.eof = true;
        self.step(out)
    }
    fn busy(&self) -> bool {
        self.header_at < self.header.len()
            || !self.input.is_empty()
            || self.again
            || (self.eof && !self.ended)
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELLO: &[u8] = &[
        31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 203, 72, 205, 201, 201, 231, 2, 0, 32, 48, 58, 54, 6, 0,
        0, 0,
    ];

    fn decode(
        data: &[u8],
        width: usize,
        test: bool,
        passthrough: bool,
    ) -> (Vec<u8>, Option<Failure>) {
        let mut decoder = Decoder::new(Format::Gzip, test, passthrough);
        let mut result = Vec::new();
        for input in data.chunks(width) {
            let mut out = Vec::new();
            decoder.feed(input, &mut out).unwrap();
            assert!(out.len() <= OUTPUT);
            result.extend(out);
            while decoder.busy() {
                let mut out = Vec::new();
                decoder.drain(&mut out).unwrap();
                assert!(out.len() <= OUTPUT);
                result.extend(out);
            }
            assert!(decoder.fixed.len() <= 10);
            assert!(decoder.input.len() <= INPUT);
            if decoder.done() {
                break;
            }
        }
        decoder.finish(&mut result).unwrap();
        (result, decoder.failure)
    }

    #[test]
    fn member_boundaries_and_failures_do_not_depend_on_chunks() {
        for width in 1..=HELLO.len() * 2 + 3 {
            let both = [HELLO, HELLO].concat();
            let (out, failure) = decode(&both, width, false, false);
            assert_eq!(out, b"hello\nhello\n");
            assert!(failure.is_none());
            let (out, failure) = decode(&[HELLO, b"junk"].concat(), width, false, false);
            assert_eq!(out, b"hello\n");
            let failure = failure.unwrap();
            assert_eq!(failure.exit_code, 2);
            assert!(!failure.fatal);
            assert!(failure.keeps_output);
            let (_, failure) = decode(&[HELLO, b"x"].concat(), width, false, false);
            assert_eq!(failure.unwrap().reasons, [EOF]);
            let (out, failure) = decode(&[HELLO, b"\0\0"].concat(), width, false, false);
            assert_eq!(out, b"hello\n");
            assert!(failure.is_none());
        }
    }

    #[test]
    fn every_truncation_retains_the_same_metadata_at_every_split() {
        for end in 0..HELLO.len() {
            let (expected, failure) = decode(&HELLO[..end], INPUT, false, false);
            let failure = serde_json::to_vec(&failure).unwrap();
            for width in 1..=HELLO.len() {
                let (out, actual) = decode(&HELLO[..end], width, false, false);
                assert_eq!(out, expected, "end {end}, width {width}");
                assert_eq!(
                    serde_json::to_vec(&actual).unwrap(),
                    failure,
                    "end {end}, width {width}"
                );
            }
        }
    }

    #[test]
    fn long_optional_headers_keep_only_fixed_fields() {
        let mut decoder = Decoder::new(Format::Gzip, false, false);
        let mut head = HELLO[..10].to_vec();
        head[3] = 0x1a;
        let mut header_crc = Crc::new();
        header_crc.update(&head);
        decoder.feed(&head, &mut Vec::new()).unwrap();
        for _ in 0..1024 {
            let chunk = [b'x'; INPUT];
            header_crc.update(&chunk);
            decoder.feed(&chunk, &mut Vec::new()).unwrap();
            assert!(decoder.input.is_empty());
            assert!(decoder.fixed.is_empty());
        }
        header_crc.update(b"\0comment\0");
        let tail = [
            b"\0comment\0".as_slice(),
            &(header_crc.sum() as u16).to_le_bytes(),
            &HELLO[10..],
        ]
        .concat();
        let mut out = Vec::new();
        decoder.feed(&tail, &mut out).unwrap();
        while decoder.busy() {
            decoder.drain(&mut out).unwrap();
        }
        decoder.finish(&mut out).unwrap();
        assert_eq!(out, b"hello\n");
        assert!(decoder.failure.is_none());
    }

    #[test]
    fn trailer_failures_retain_body_and_report_crc_before_length() {
        let broken = [&HELLO[..HELLO.len() - 8], &[0; 8]].concat();
        for width in 1..=broken.len() {
            for test in [false, true] {
                let (out, failure) = decode(&broken, width, test, false);
                assert_eq!(out, b"hello\n");
                let failure = failure.unwrap();
                assert_eq!(failure.reasons.len(), 2);
                assert!(failure.reasons[0].ends_with("crc error"));
                assert!(failure.reasons[1].ends_with("length error"));
                assert_eq!(failure.fatal, !test);
                assert!(failure.keeps_output);
            }
        }
    }

    #[test]
    fn encoding_and_expansion_are_bounded_at_each_call() {
        let plain = vec![b'x'; OUTPUT * 100];
        let mut encoder = Encoder::new(Format::Gzip, 9, "name".into());
        let mut encoded = Vec::new();
        for data in plain.chunks(INPUT) {
            let mut out = Vec::new();
            encoder.feed(data, &mut out).unwrap();
            assert!(out.len() <= INPUT);
            encoded.extend(out);
            while encoder.busy() {
                let mut out = Vec::new();
                encoder.drain(&mut out).unwrap();
                assert!(out.len() <= INPUT);
                encoded.extend(out);
            }
        }
        encoder.finish(&mut encoded).unwrap();
        while encoder.busy() {
            let mut out = Vec::new();
            encoder.drain(&mut out).unwrap();
            assert!(out.len() <= INPUT);
            encoded.extend(out);
        }
        let (out, failure) = decode(&encoded, INPUT, false, false);
        assert_eq!(out, plain);
        assert!(failure.is_none());
        let mut decoder = Decoder::new(Format::Gzip, false, false);
        assert!(decoder.feed(&[0; INPUT + 1], &mut Vec::new()).is_err());
    }

    #[test]
    fn passthrough_keeps_malformed_bytes_at_member_boundaries() {
        for data in [b"".as_slice(), b"\xff", b"\xff\xfe\0"] {
            for prefix in [b"".as_slice(), HELLO] {
                for width in 1..=7 {
                    let (out, failure) = decode(&[prefix, data].concat(), width, false, true);
                    assert_eq!(
                        out,
                        [
                            if prefix.is_empty() {
                                b"".as_slice()
                            } else {
                                b"hello\n"
                            },
                            data
                        ]
                        .concat()
                    );
                    assert!(failure.is_none());
                }
            }
        }
    }

    #[test]
    fn a_zero_output_member_end_does_not_spend_the_next_members_output_budget() {
        use std::io::Write;
        let first = vec![b'A'; 1000];
        let mut crc = Crc::new();
        crc.update(&first);
        let prefix = [&HELLO[..10], &[0, 232, 3, 23, 252], first.as_slice()].concat();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&vec![b'B'; 100000]).unwrap();
        let second = encoder.finish().unwrap();
        let tail = [
            &[1, 0, 0, 255, 255],
            crc.sum().to_le_bytes().as_slice(),
            crc.amount().to_le_bytes().as_slice(),
            second.as_slice(),
        ]
        .concat();
        let mut decoder = Decoder::new(Format::Gzip, false, false);
        let mut out = Vec::new();
        decoder.feed(&prefix, &mut out).unwrap();
        assert!(out.is_empty());
        decoder.feed(&tail, &mut out).unwrap();
        assert!(out.len() <= OUTPUT);
        let mut result = out;
        while decoder.busy() {
            let mut out = Vec::new();
            decoder.drain(&mut out).unwrap();
            assert!(out.len() <= OUTPUT);
            result.extend(out);
        }
        decoder.finish(&mut result).unwrap();
        assert_eq!(result, [first, vec![b'B'; 100000]].concat());
        assert!(decoder.failure.is_none());
    }

    #[test]
    fn invalid_distances_and_block_types_are_format_errors() {
        for body in [b"\x03\x02\x00".as_slice(), b"\x07"] {
            let (out, failure) = decode(&[&HELLO[..10], body].concat(), 1, false, false);
            assert!(out.is_empty());
            assert_eq!(failure.unwrap().reasons, [CORRUPT]);
        }
        let body = [0, 6, 0, 249, 255, b'h', b'e', b'l', b'l', b'o', 10, 7];
        let mut decoder = Decoder::new(Format::Raw, false, false);
        let mut out = Vec::new();
        assert!(decoder.feed(&body, &mut out).is_err());
        assert!(out.is_empty());
    }

    #[test]
    fn terminal_metadata_is_taken_once_and_status_stays_failed() {
        let mut decoder = Decoder::new(Format::Gzip, false, false);
        decoder.feed(b"not gzip", &mut Vec::new()).unwrap();
        let mut record = Vec::new();
        decoder.take_stderr(&mut record);
        let failure: serde_json::Value = serde_json::from_slice(&record).unwrap();
        assert_eq!(failure["exit_code"], 1);
        record.clear();
        decoder.take_stderr(&mut record);
        assert!(record.is_empty());
        assert_eq!(decoder.status(), 1);
        assert!(decoder.done());
    }
}
