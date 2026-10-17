use md5::Md5;
use serde::Deserialize;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    algorithm: String,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let hasher = match config.algorithm.as_str() {
        "md5" => Hasher::Md5(Md5::new()),
        "sha1" => Hasher::Sha1(Sha1::new()),
        "sha256" => Hasher::Sha256(Sha256::new()),
        "sha384" => Hasher::Sha384(Sha384::new()),
        "sha512" => Hasher::Sha512(Sha512::new()),
        other => return Err(StreamError::new(format!("unknown digest: {other}"))),
    };
    Ok(Box::new(hasher))
}

/// The lowercase hex digest of everything fed, written on finish.
enum Hasher {
    Md5(Md5),
    Sha1(Sha1),
    Sha256(Sha256),
    Sha384(Sha384),
    Sha512(Sha512),
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
            Self::Sha256(h) => h.update(input),
            Self::Sha384(h) => h.update(input),
            Self::Sha512(h) => h.update(input),
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        match self {
            Self::Md5(h) => hex(&h.finalize_reset(), out),
            Self::Sha1(h) => hex(&h.finalize_reset(), out),
            Self::Sha256(h) => hex(&h.finalize_reset(), out),
            Self::Sha384(h) => hex(&h.finalize_reset(), out),
            Self::Sha512(h) => hex(&h.finalize_reset(), out),
        }
        Ok(())
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
}
