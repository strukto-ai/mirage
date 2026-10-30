use blake2::Blake2bVarCore;
use blake2::digest::Output;
use blake2::digest::block_api::{Buffer, UpdateCore, VariableOutputCore};
use md5::Md5;
use serde::Deserialize;
use sha1::Sha1;
use sha2::{Digest, Sha224, Sha256, Sha384, Sha512};

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    algorithm: String,
    #[serde(default)]
    check_lines: bool,
    /// BLAKE2b's digest length in bits, a multiple of 8 up to 512.
    #[serde(default = "full_length")]
    length: usize,
}

fn full_length() -> usize {
    512
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let hasher = match config.algorithm.as_str() {
        "md5" => Hasher::Md5(Md5::new()),
        "sha1" => Hasher::Sha1(Sha1::new()),
        "sha224" => Hasher::Sha224(Sha224::new()),
        "sha256" => Hasher::Sha256(Sha256::new()),
        "sha384" => Hasher::Sha384(Sha384::new()),
        "sha512" => Hasher::Sha512(Sha512::new()),
        "blake2b" if config.length % 8 == 0 => {
            let bytes = config.length / 8;
            let core = Blake2bVarCore::new(bytes)
                .map_err(|_| StreamError::new(format!("bad digest length: {}", config.length)))?;
            Hasher::Blake2b(Box::new((core, Buffer::<Blake2bVarCore>::default(), bytes)))
        }
        other => return Err(StreamError::new(format!("unknown digest: {other}"))),
    };
    if config.check_lines {
        return Ok(Box::new(CheckLines {
            algorithm: config.algorithm,
            records: crate::records::Records::default(),
            line: 0,
            busy: false,
        }));
    }
    Ok(Box::new(hasher))
}

/// The lowercase hex digest of everything fed, written on finish.
enum Hasher {
    Md5(Md5),
    Sha1(Sha1),
    Sha224(Sha224),
    Sha256(Sha256),
    Sha384(Sha384),
    Sha512(Sha512),
    /// BLAKE2b at a length set at run time, its pending partial block and
    /// its length in bytes.
    Blake2b(Box<(Blake2bVarCore, Buffer<Blake2bVarCore>, usize)>),
}

fn hex(digest: &[u8], out: &mut Vec<u8>) {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        out.push(DIGITS[usize::from(byte >> 4)]);
        out.push(DIGITS[usize::from(byte & 15)]);
    }
}

impl Stream for Hasher {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        match self {
            Self::Md5(h) => h.update(input),
            Self::Sha1(h) => h.update(input),
            Self::Sha224(h) => h.update(input),
            Self::Sha256(h) => h.update(input),
            Self::Sha384(h) => h.update(input),
            Self::Sha512(h) => h.update(input),
            Self::Blake2b(state) => {
                let (core, buffer, _) = &mut **state;
                buffer.digest_blocks(input, |blocks| core.update_blocks(blocks));
            }
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        match self {
            Self::Md5(h) => hex(&h.finalize_reset(), out),
            Self::Sha1(h) => hex(&h.finalize_reset(), out),
            Self::Sha224(h) => hex(&h.finalize_reset(), out),
            Self::Sha256(h) => hex(&h.finalize_reset(), out),
            Self::Sha384(h) => hex(&h.finalize_reset(), out),
            Self::Sha512(h) => hex(&h.finalize_reset(), out),
            Self::Blake2b(state) => {
                let (core, buffer, bytes) = &mut **state;
                let mut digest = Output::<Blake2bVarCore>::default();
                core.finalize_variable_core(buffer, &mut digest);
                hex(&digest[..*bytes], out);
            }
        }
        Ok(())
    }
}

/// Checksum-list grammar, shared by both hosts. Paths stay on the host,
/// which hashes through the same dispatcher as any other file read.
struct CheckLines {
    algorithm: String,
    records: crate::records::Records,
    line: u64,
    busy: bool,
}

fn check_line(line: &str, algorithm: &str) -> Option<(String, String, String)> {
    let mut named_bits = None;
    let tagged = line.split_once(" (").and_then(|(tag, rest)| {
        if algorithm == "blake2b" {
            named_bits = Some(if tag == "BLAKE2b" {
                512
            } else {
                let bits = tag.strip_prefix("BLAKE2b-")?;
                if bits.is_empty() || !bits.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                bits.parse::<usize>().ok()?
            });
        } else if tag != algorithm.to_ascii_uppercase() {
            return None;
        }
        let (name, digest) = rest.rsplit_once(") = ")?;
        Some((digest, name))
    });
    let (digest, name) = tagged.or_else(|| {
        named_bits = None;
        let (digest, rest) = line.split_once(' ')?;
        let name = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('*'))?;
        Some((digest, name))
    })?;
    if digest.is_empty() || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bits = digest.len() * 4;
    let named = if algorithm == "blake2b" {
        if bits % 8 != 0 || bits > 512 || named_bits.is_some_and(|n| n != bits) {
            return None;
        }
        if bits == 512 {
            algorithm.to_owned()
        } else {
            format!("blake2b-{bits}")
        }
    } else {
        let expected = match algorithm {
            "md5" => 128,
            "sha1" => 160,
            "sha224" => 224,
            "sha256" => 256,
            "sha384" => 384,
            "sha512" => 512,
            _ => return None,
        };
        if bits != expected {
            return None;
        }
        algorithm.to_owned()
    };
    Some((digest.to_ascii_lowercase(), name.to_owned(), named))
}

impl CheckLines {
    fn pump(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let start = out.len();
        self.busy = true;
        while out.len() - start < 64 * 1024 {
            let crate::records::Take::Record(line) = self.records.next_span(b'\n') else {
                self.busy = false;
                break;
            };
            self.line += 1;
            let line = String::from_utf8_lossy(line);
            if line.trim().is_empty() {
                continue;
            }
            let record = serde_json::json!({"line": self.line, "parsed": check_line(&line, &self.algorithm)});
            serde_json::to_writer(&mut *out, &record)
                .map_err(|err| StreamError::new(err.to_string()))?;
            out.push(b'\n');
        }
        Ok(())
    }
}
impl Stream for CheckLines {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.records.push(input);
        self.pump(out)
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.records.end();
        self.pump(out)
    }
    fn busy(&self) -> bool {
        self.busy
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out)
    }
}

#[cfg(test)]
mod tests {
    use crate::run;

    #[test]
    fn hashes_known_vectors() {
        let cases = [
            ("md5", "900150983cd24fb0d6963f7d28e17f72"),
            ("sha1", "a9993e364706816aba3e25717850c26c9cd0d89d"),
            (
                "sha224",
                "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7",
            ),
            (
                "sha256",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
        ];
        for (algorithm, expected) in cases {
            let config = format!(r#"{{"algorithm":"{algorithm}"}}"#);
            assert_eq!(
                run("digest", &config, &[b"a", b"bc"]).0,
                expected.as_bytes()
            );
        }
    }

    #[test]
    fn blake2b_takes_its_length_in_bits() {
        let cases = [
            (
                512,
                "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
            ),
            (
                256,
                "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
            ),
            (8, "6b"),
        ];
        for (length, expected) in cases {
            let config = format!(r#"{{"algorithm":"blake2b","length":{length}}}"#);
            let chunks: [&[u8]; 3] = [b"a", &[b'b'; 0], b"bc"];
            assert_eq!(run("digest", &config, &chunks).0, expected.as_bytes());
        }
    }
}
