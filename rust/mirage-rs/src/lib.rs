mod base64;
mod digest;
mod generated;
mod sort;
mod utf8;
mod wc;
mod width;

use std::fmt;

/// One command's byte processing: bytes are pushed in chunk by chunk and its output is
/// appended to `out`, so the host keeps the I/O and the stream keeps only
/// the state the command needs between chunks.
pub trait Stream {
    /// Consume one chunk. Output written before an error stays in `out`.
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError>;

    /// End of input: flush whatever the stream held back.
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError>;

    /// For a stream that reads several inputs, the one it needs bytes from
    /// before it can write more; `None` once every input has ended or each
    /// has what it needs, as while the stream is `busy`.
    fn wants(&self) -> Option<usize> {
        None
    }

    /// Consume one chunk of input `index`.
    fn feed_input(
        &mut self,
        index: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let _ = index;
        self.feed(input, out)
    }

    /// Input `index` has ended.
    fn end_input(&mut self, index: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let _ = (index, out);
        Ok(())
    }

    /// Whether the stream has work or output left for `drain`: a stream
    /// that would otherwise hold the host for long does it a bounded step
    /// per `drain`, and the host yields between steps.
    fn busy(&self) -> bool {
        false
    }

    /// One bounded step of the work `busy` reports, and any output it
    /// writes.
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let _ = out;
        Ok(())
    }
}

/// `saturating_usize` for an optional count.
pub(crate) fn saturating_usize_opt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<usize>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = Option<usize>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a non-negative count or null")
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
            saturating_usize(d).map(Some)
        }
    }
    deserializer.deserialize_option(Visitor)
}

/// A count from a host's configuration as a `usize`, a value past what this
/// target holds saturating as an unbounded flag does, so a 32-bit wasm build
/// accepts what a 64-bit one does.
pub(crate) fn saturating_usize<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<usize, D::Error> {
    struct Visitor;
    impl serde::de::Visitor<'_> for Visitor {
        type Value = usize;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a non-negative count")
        }
        fn visit_u64<E>(self, value: u64) -> Result<usize, E> {
            Ok(usize::try_from(value).unwrap_or(usize::MAX))
        }
        fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<usize, E> {
            u64::try_from(value)
                .map(|value| usize::try_from(value).unwrap_or(usize::MAX))
                .map_err(|_| E::custom("a count cannot be negative"))
        }
        // JSON integers past u64 arrive as doubles; the cast saturates.
        fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<usize, E> {
            if value >= 0.0 {
                Ok(value as usize)
            } else {
                Err(E::custom("a count cannot be negative"))
            }
        }
    }
    deserializer.deserialize_any(Visitor)
}

/// A refusal: the message is the command's own stderr wording, or what the
/// host reports it as (`sort -c` sends the disordered record's number).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamError {
    pub message: String,
}

impl StreamError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StreamError {}

/// Open the stream `kind` from its JSON configuration.
pub fn open(kind: &str, config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    match kind {
        "base64" => base64::open(config),
        "digest" => digest::open(config),
        "sort" => sort::open(config),
        "wc" => wc::open(config),
        _ => Err(StreamError::new(format!("unknown stream: {kind}"))),
    }
}

pub(crate) fn parse_config<'a, T: serde::Deserialize<'a>>(
    config: &'a [u8],
) -> Result<T, StreamError> {
    serde_json::from_slice(config)
        .map_err(|err| StreamError::new(format!("bad stream config: {err}")))
}

#[cfg(test)]
pub(crate) fn run(kind: &str, config: &str, chunks: &[&[u8]]) -> (Vec<u8>, Option<StreamError>) {
    let mut stream = open(kind, config.as_bytes()).expect("stream opens");
    let mut out = Vec::new();
    for chunk in chunks {
        if let Err(err) = stream.feed(chunk, &mut out) {
            return (out, Some(err));
        }
        drain_all(stream.as_mut(), &mut out);
    }
    let err = stream.finish(&mut out).err();
    drain_all(stream.as_mut(), &mut out);
    (out, err)
}

#[cfg(test)]
pub(crate) fn drain_all(stream: &mut dyn Stream, out: &mut Vec<u8>) {
    while stream.busy() {
        while stream.busy() {
            stream.drain(out).expect("drain");
        }
        stream.feed(&[], out).expect("feed");
    }
}
