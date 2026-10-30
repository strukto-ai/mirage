use blake2::Blake2bVarCore;
use blake2::digest::Output;
use blake2::digest::block_api::{Buffer, UpdateCore, VariableOutputCore};
use md5::Md5;
use serde::Deserialize;
use sha1::Sha1;
use sha2::{Digest, Sha224, Sha256, Sha384, Sha512};

use crate::number;
use crate::{Stream, StreamError, parse_config, quoted};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    algorithm: String,
    /// BLAKE2b's digest length in bits as b2sum's -l was typed, one
    /// character per byte; none is 512.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    length: Option<Vec<u8>>,
}

/// The most bits BLAKE2b gives.
const FULL_LENGTH: u128 = 512;

/// b2sum's -l as GNU reads it in its option loop (coreutils 9.7): a whole
/// decimal past blanks and one `+`, 0 or 512 and past it the whole 512,
/// one under 512 a multiple of 8.
fn length(raw: Option<&[u8]>) -> Result<usize, StreamError> {
    let Some(raw) = raw else {
        return Ok(FULL_LENGTH as usize);
    };
    let refused = format!("b2sum: invalid length: '{}'", quoted(raw));
    let bits =
        number::unsigned_decimal(raw).ok_or_else(|| StreamError::refusal(refused.as_bytes(), 1))?;
    if bits == 0 || bits >= FULL_LENGTH {
        return Ok(FULL_LENGTH as usize);
    }
    if bits % 8 != 0 {
        let refused = format!("{refused}\nb2sum: length is not a multiple of 8");
        return Err(StreamError::refusal(refused.as_bytes(), 1));
    }
    Ok(bits as usize)
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
        "blake2b" => {
            let bits = length(config.length.as_deref())?;
            let bytes = bits / 8;
            let core = Blake2bVarCore::new(bytes)
                .map_err(|_| StreamError::new(format!("bad digest length: {bits}")))?;
            Hasher::Blake2b(Box::new((core, Buffer::<Blake2bVarCore>::default(), bytes)))
        }
        other => return Err(StreamError::new(format!("unknown digest: {other}"))),
    };
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

    /// `{"bits": N}`, the digest's length.
    fn metadata(&self, out: &mut Vec<u8>) {
        let bits = match self {
            Self::Md5(_) => 128,
            Self::Sha1(_) => 160,
            Self::Sha224(_) => 224,
            Self::Sha256(_) => 256,
            Self::Sha384(_) => 384,
            Self::Sha512(_) => 512,
            Self::Blake2b(state) => state.2 * 8,
        };
        out.extend_from_slice(serde_json::json!({ "bits": bits }).to_string().as_bytes());
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
            let config = format!(r#"{{"algorithm":"blake2b","length":"{length}"}}"#);
            let chunks: [&[u8]; 3] = [b"a", &[b'b'; 0], b"bc"];
            assert_eq!(run("digest", &config, &chunks).0, expected.as_bytes());
        }
    }

    #[test]
    fn b2sum_reads_its_length_as_gnu_does() {
        let open = |length: &str| {
            let config = serde_json::json!({"algorithm": "blake2b", "length": length}).to_string();
            crate::open("digest", config.as_bytes()).map(|stream| {
                let mut out = Vec::new();
                stream.metadata(&mut out);
                String::from_utf8(out).expect("json")
            })
        };
        for (typed, bits) in [
            (" +256", 256),
            ("0", 512),
            ("1024", 512),
            ("99999999999999999999999", 512),
        ] {
            assert_eq!(
                open(typed).ok(),
                Some(format!(r#"{{"bits":{bits}}}"#)),
                "{typed}"
            );
        }
        let refused = |typed: &str| open(typed).err().map(|e| (e.message, e.status));
        assert_eq!(
            refused("x"),
            Some(("b2sum: invalid length: 'x'".to_owned(), 1))
        );
        assert_eq!(
            refused("-8"),
            Some(("b2sum: invalid length: '-8'".to_owned(), 1))
        );
        let odd = "b2sum: invalid length: '12'\nb2sum: length is not a multiple of 8".to_owned();
        assert_eq!(refused("12"), Some((odd, 1)));
    }
}
