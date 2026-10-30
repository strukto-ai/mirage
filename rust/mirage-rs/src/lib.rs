mod awk;
mod base64;
mod bc;
mod cat;
mod cmp;
mod column;
mod comm;
mod compress;
mod cut;
mod diff;
mod digest;
mod du;
mod expand;
mod fold;
mod generated;
mod glob;
mod grep;
mod head;
#[cfg(test)]
mod host;
mod iconv;
mod integer;
mod join;
mod jq;
mod look;
mod network;
pub mod nfs;
mod nl;
mod number;
mod numfmt;
mod od;
mod paste;
mod patch;
mod pcre;
mod policy;
mod printf;
mod records;
mod reflow;
mod regex;
mod request;
mod rev;
mod rg;
mod rg_format;
mod rg_grapheme;
mod rg_input;
mod rg_matcher;
mod rg_options;
mod scan;
mod sed;
mod seq;
pub mod shell;
mod shuf;
mod sort;
mod split;
mod strings;
mod tac;
mod tail;
mod tar;
mod task;
mod tr;
mod tree;
mod truncate;
mod tsort;
mod uniq;
mod utf8;
mod wc;
mod width;
mod xxd;
mod zip;

use std::fmt;

/// One command's byte processing: bytes are pushed in chunk by chunk and its output is
/// appended to `out`, so the host keeps the I/O and the stream keeps only
/// the state the command needs between chunks. A host may free a stream
/// on another thread than the one that made it (Python's cycle collector
/// runs wherever it runs), so a stream is `Send + Sync`.
pub trait Stream: Send + Sync {
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

    /// Stop processing and schedule bounded retirement through `drain`.
    /// False means the stream has no incremental cancellation protocol.
    fn cancel(&mut self) -> bool {
        false
    }

    /// For a stream that reads one input after another, start the next
    /// with its own configuration; `finish` ends each one.
    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let _ = config;
        Err(StreamError::new("this stream reads one input"))
    }

    /// Answer a yes-or-no question about one whole input in one call: the
    /// bytes fed since the last answer, then `input`. The next input starts
    /// empty. It is for a host asking once per name, where the calls of
    /// `begin`, `feed`, `finish` and `drain` would cost more than the work.
    fn test(&mut self, input: &[u8]) -> Result<bool, StreamError> {
        let _ = input;
        Err(StreamError::new("this stream answers no test"))
    }

    /// Whether the stream wants no more of the current input: the host
    /// stops reading it and calls `finish`.
    fn done(&self) -> bool {
        false
    }

    /// The command's exit status for the input so far.
    fn status(&self) -> i32 {
        0
    }

    /// Serialize the command's current typed progress, when it exposes one.
    fn metadata(&self, out: &mut Vec<u8>) {
        let _ = out;
    }

    /// Append what the command has written to stderr since the last call:
    /// warnings and notices, which do not stop it.
    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        let _ = err;
    }

    /// The host operation the stream waits on before it can go on, for a
    /// stream that reaches files and commands: a JSON header naming it,
    /// with the bytes it carries appended to `data`. None while it waits
    /// on none; each one taken is answered by `respond`.
    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let _ = data;
        None
    }

    /// The host's answer to the request taken last: a JSON reply and the
    /// bytes it carries.
    fn respond(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let _ = (reply, data, out);
        Err(StreamError::new("this stream makes no requests"))
    }
}

/// A count over a whole input, which a 32-bit build's `usize` cannot hold,
/// a value past `u64` saturating.
pub(crate) fn saturating_u64<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<u64, D::Error> {
    struct Visitor;
    impl serde::de::Visitor<'_> for Visitor {
        type Value = u64;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a non-negative count")
        }
        fn visit_u64<E>(self, value: u64) -> Result<u64, E> {
            Ok(value)
        }
        fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<u64, E> {
            u64::try_from(value).map_err(|_| E::custom("a count cannot be negative"))
        }
        // JSON integers past u64 arrive as doubles; the cast saturates.
        fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<u64, E> {
            if value >= 0.0 {
                Ok(value as u64)
            } else {
                Err(E::custom("a count cannot be negative"))
            }
        }
    }
    deserializer.deserialize_any(Visitor)
}

/// `saturating_u64` for an optional count.
pub(crate) fn saturating_u64_opt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = Option<u64>;
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
            saturating_u64(d).map(Some)
        }
    }
    deserializer.deserialize_option(Visitor)
}

/// `saturating_usize` for an optional count.
pub(crate) fn saturating_usize_opt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<usize>, D::Error> {
    Ok(saturating_u64_opt(deserializer)?.map(|value| usize::try_from(value).unwrap_or(usize::MAX)))
}

/// A count from a host's configuration as a `usize`, a value past what this
/// target holds saturating as an unbounded flag does, so a 32-bit wasm build
/// accepts what a 64-bit one does.
pub(crate) fn saturating_usize<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<usize, D::Error> {
    saturating_u64(deserializer).map(|value| usize::try_from(value).unwrap_or(usize::MAX))
}

/// Bytes a host sends as a string of one character per byte, each below
/// U+0100, which JSON carries whatever the bytes are.
pub(crate) fn latin1<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<u8>, D::Error> {
    let text = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(deserializer)?;
    latin1_bytes(&text)
        .ok_or_else(|| serde::de::Error::custom("a byte string holds a character past U+00FF"))
}

/// Bytes as a string of one character per byte, the form `latin1` reads
/// back and a refusal carries its stderr in.
pub(crate) fn byte_text(raw: &[u8]) -> String {
    raw.iter().map(|&b| char::from(b)).collect()
}

pub(crate) fn latin1_bytes(text: &str) -> Option<Vec<u8>> {
    text.chars()
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect()
}

/// `latin1` for an optional byte string.
pub(crate) fn latin1_opt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<u8>>, D::Error> {
    let text =
        <Option<std::borrow::Cow<'de, str>> as serde::Deserialize>::deserialize(deserializer)?;
    text.map(|text| {
        latin1_bytes(&text)
            .ok_or_else(|| serde::de::Error::custom("a byte string holds a character past U+00FF"))
    })
    .transpose()
}

/// `latin1` for a list of byte strings.
pub(crate) fn latin1_list<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Vec<u8>>, D::Error> {
    let texts = <Vec<std::borrow::Cow<'de, str>> as serde::Deserialize>::deserialize(deserializer)?;
    texts
        .iter()
        .map(|text| {
            latin1_bytes(text).ok_or_else(|| {
                serde::de::Error::custom("a byte string holds a character past U+00FF")
            })
        })
        .collect()
}

/// A word as gnulib's `quote()` writes it in the C locale, the quotes
/// left to the message: named C escapes, `\'` and `\\`, every other byte
/// outside the printable ASCII range as three octal digits.
pub(crate) fn quoted(text: &[u8]) -> String {
    let mut out = String::new();
    for &byte in text {
        match byte {
            7 => out.push_str("\\a"),
            8 => out.push_str("\\b"),
            b'\t' => out.push_str("\\t"),
            b'\n' => out.push_str("\\n"),
            11 => out.push_str("\\v"),
            12 => out.push_str("\\f"),
            b'\r' => out.push_str("\\r"),
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            32..=126 => out.push(char::from(byte)),
            _ => out.push_str(&format!("\\{byte:03o}")),
        }
    }
    out
}

/// `text` in GNU's shell-escape quoting, as a diagnostic names a word: bare
/// when a shell reads it back as itself, else `'...'` with a quote as
/// `'\''` and a run of controls as one `$'...'` group, or `"..."` for a
/// word whose only trouble is a quote. A character past ASCII is ordinary,
/// as under a UTF-8 locale, except the C1 controls and U+2028 and U+2029;
/// a byte that is no UTF-8 is ordinary too.
pub(crate) fn shell_quoted(text: &[u8]) -> Vec<u8> {
    const ALWAYS: &[u8] = b" !\"$&'()*:;<=>?[\\^`|";
    const DOUBLE_BLOCKERS: &[u8] = b"!\"#$&()*;<=>?[\\^`{|}~";
    let chars: Vec<(Option<char>, &[u8])> = text
        .utf8_chunks()
        .flat_map(|chunk| {
            let valid = chunk.valid();
            let chars = valid
                .char_indices()
                .map(move |(at, c)| (Some(c), &valid.as_bytes()[at..at + c.len_utf8()]));
            chars.chain(chunk.invalid().chunks(1).map(|byte| (None, byte)))
        })
        .collect();
    let escaped = |c: Option<char>| {
        c.is_some_and(|c| matches!(u32::from(c), 0..=0x1f | 0x7f..=0x9f | 0x2028 | 0x2029))
    };
    let special =
        |c: Option<char>, set: &[u8]| c.is_some_and(|c| c.is_ascii() && set.contains(&(c as u8)));
    let bare = !text.is_empty()
        && text != b"{"
        && text != b"}"
        && !matches!(text.first(), Some(b'#' | b'~'))
        && chars
            .iter()
            .all(|&(c, _)| !escaped(c) && !special(c, ALWAYS));
    if bare {
        return text.to_vec();
    }
    if text.contains(&b'\'')
        && chars
            .iter()
            .all(|&(c, _)| !escaped(c) && !special(c, DOUBLE_BLOCKERS))
    {
        return [b"\"", text, b"\""].concat();
    }
    let mut out = vec![b'\''];
    let mut in_escape = false;
    for (c, bytes) in chars {
        if escaped(c) {
            if !in_escape {
                out.extend_from_slice(b"'$'");
                in_escape = true;
            }
            match c {
                Some('\x07') => out.extend_from_slice(b"\\a"),
                Some('\x08') => out.extend_from_slice(b"\\b"),
                Some('\t') => out.extend_from_slice(b"\\t"),
                Some('\n') => out.extend_from_slice(b"\\n"),
                Some('\x0b') => out.extend_from_slice(b"\\v"),
                Some('\x0c') => out.extend_from_slice(b"\\f"),
                Some('\r') => out.extend_from_slice(b"\\r"),
                _ => bytes
                    .iter()
                    .for_each(|byte| out.extend_from_slice(format!("\\{byte:03o}").as_bytes())),
            }
        } else if bytes == b"'" {
            out.extend_from_slice(b"'\\''");
            in_escape = false;
        } else {
            if in_escape {
                out.extend_from_slice(b"''");
                in_escape = false;
            }
            out.extend_from_slice(bytes);
        }
    }
    out.push(b'\'');
    out
}

/// A refusal: the message is the command's own stderr wording, or what the
/// host reports it as (`sort -c` sends the disordered record's number),
/// and the status the command exits with. A refusal of a command's
/// options or operands holds its stderr one character per byte, so both
/// hosts write back the same bytes whether `open` fails with it or a
/// `Refused` stream reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamError {
    pub message: String,
    pub status: i32,
}

impl StreamError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: 1,
        }
    }

    /// The refusal of a command's options or operands: the bytes it writes
    /// to stderr, without the final newline, and its exit status.
    pub fn refusal(stderr: &[u8], status: i32) -> Self {
        Self {
            message: byte_text(stderr),
            status,
        }
    }

    /// The bytes the refusal writes to stderr.
    pub(crate) fn stderr(&self) -> Vec<u8> {
        latin1_bytes(&self.message).unwrap_or_else(|| self.message.as_bytes().to_vec())
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
        "awk" => awk::open(config),
        "base64" => base64::open(config),
        "bc" => bc::open(config),
        "cmp" => cmp::open(config),
        "column" => column::open(config),
        "comm" => comm::open(config),
        "compress" => compress::open(config),
        "csplit" => split::csplit::open(config),
        "cut" => cut::open(config),
        "digest" => digest::open(config),
        "expand" => expand::open_expand(config),
        "fmt" => reflow::open(config),
        "fold" => fold::open(config),
        "diff" => diff::open(config),
        "glob" => glob::open(config),
        "grep" => grep::open(config),
        "iconv" => iconv::open(config),
        "join" => join::open(config),
        "jq_options" => jq::open_options(config),
        "jq_eval" => jq::open_eval(config),
        "jq" => jq::open_main(config),
        "look" => look::open(config),
        "network" => network::open(config),
        "cat" => cat::open(config),
        "nl" => nl::open(config),
        "numfmt" => numfmt::open(config),
        "od" => od::open(config),
        "paste" => paste::open(config),
        "patch" => patch::open(config),
        "policy" => policy::stream::open(config),
        "policy_compose" => policy::composition::open(config),
        "printf" => printf::open(config),
        "regex" => regex::stream::open(config),
        "rev" => rev::open(config),
        "rg" => rg::open(config),
        "rg_format" => rg_format::open(config),
        "scan" => scan::open(config),
        "sed" => sed::open(config),
        "seq" => seq::open(config),
        "shuf" => shuf::open(config),
        "sort" => sort::open(config),
        "split" => split::open(config),
        "strings" => strings::open(config),
        "tac" => tac::open(config),
        "tar" => tar::open(config),
        "tr" => tr::open(config),
        "tsort" => tsort::open(config),
        "unexpand" => expand::open_unexpand(config),
        "uniq" => uniq::open(config),
        "unzip" => zip::open_unzip(config),
        "wc" => wc::open(config),
        "xxd" => xxd::open(config),
        "zip" => zip::open_zip(config),
        _ => Err(StreamError::new(format!("unknown stream: {kind}"))),
    }
}

/// The output a host's `drain` call gathers before it hands back.
pub const PIECE: usize = 16 * 1024;

/// The bounded steps one host `drain` call runs at most.
pub const STEPS: usize = 8;

/// What a host's `drain` call runs: bounded steps of the work `busy`
/// reports, until they have written a piece of output, the stream is no
/// longer busy, or `STEPS` of them have run. A stream whose steps write a
/// few bytes each (`cut`, `jq`) or none (`sort` before its output) then
/// crosses into the host, and on down a pipe, once per piece rather than
/// once per step, and the host still yields between calls.
pub fn drain_steps(stream: &mut dyn Stream, out: &mut Vec<u8>) -> Result<(), StreamError> {
    let start = out.len();
    for _ in 0..STEPS {
        stream.drain(out)?;
        if out.len() - start >= PIECE || !stream.busy() {
            break;
        }
    }
    Ok(())
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

/// A stream's JSON configuration: `defaults` with `options`' fields laid
/// over them.
#[cfg(test)]
pub(crate) fn config(defaults: &str, options: &str) -> String {
    let mut config: serde_json::Value = serde_json::from_str(defaults).expect("defaults");
    let options: serde_json::Value = serde_json::from_str(options).expect("options");
    for (name, value) in options.as_object().expect("an object") {
        config[name] = value.clone();
    }
    config.to_string()
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

/// Release a transient giant byte buffer once little of it remains. Keep
/// ordinary working chunks to avoid an allocation on every record.
pub fn release_capacity(buffer: &mut Vec<u8>) {
    const KEPT: usize = 64 * 1024;
    let needed = buffer.len().max(KEPT);
    if buffer.capacity() / 4 > needed {
        buffer.shrink_to(needed);
    }
}

#[cfg(test)]
mod tests {
    use crate::{PIECE, STEPS, Stream, StreamError, drain_steps};

    struct Steps {
        left: usize,
        width: usize,
        taken: usize,
    }

    impl Stream for Steps {
        fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
            Ok(())
        }
        fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
            Ok(())
        }
        fn busy(&self) -> bool {
            self.left > 0
        }
        fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
            self.left -= 1;
            self.taken += 1;
            out.resize(out.len() + self.width, b'x');
            if self.left == 1 && self.width == 3 {
                return Err(StreamError::new("refused"));
            }
            Ok(())
        }
    }

    fn drained(left: usize, width: usize) -> (usize, usize) {
        let mut stream = Steps {
            left,
            width,
            taken: 0,
        };
        let mut out = Vec::new();
        drain_steps(&mut stream, &mut out).expect("drain");
        (stream.taken, out.len())
    }

    #[test]
    fn a_call_gathers_small_steps_up_to_its_step_bound() {
        assert_eq!(drained(100, 10), (STEPS, STEPS * 10));
    }

    #[test]
    fn a_call_hands_back_once_it_holds_a_piece() {
        assert_eq!(drained(100, PIECE / 2), (2, PIECE));
        assert_eq!(drained(100, PIECE * 4), (1, PIECE * 4));
    }

    #[test]
    fn a_call_ends_with_the_work() {
        assert_eq!(drained(3, 10), (3, 30));
    }

    #[test]
    fn a_refusal_keeps_the_output_written_before_it() {
        let mut stream = Steps {
            left: 5,
            width: 3,
            taken: 0,
        };
        let mut out = Vec::new();
        assert!(drain_steps(&mut stream, &mut out).is_err());
        assert_eq!((stream.taken, out.len()), (4, 12));
    }
}

#[cfg(test)]
mod shell_quote_tests {
    use super::shell_quoted;

    #[test]
    fn shell_quoting_matches_gnu_shell_escape() {
        for (text, quoted) in [
            ("x", "x"),
            ("", "''"),
            ("{", "'{'"),
            ("#a", "'#a'"),
            ("a#", "a#"),
            ("a b", "'a b'"),
            ("it's", "\"it's\""),
            ("it's$", "'it'\\''s$'"),
            ("a\u{9}b", "'a'$'\\t''b'"),
            ("a\u{1}'b", "'a'$'\\001'\\''b'"),
            ("é", "é"),
            ("\u{85}x", "''$'\\302\\205''x'"),
            ("a\u{2028}", "'a'$'\\342\\200\\250'"),
            ("~", "'~'"),
            ("-3", "-3"),
            (" 1", "' 1'"),
            ("\u{1}\u{2}z", "''$'\\001\\002''z'"),
        ] {
            assert_eq!(shell_quoted(text.as_bytes()), quoted.as_bytes(), "{text:?}");
        }
        assert_eq!(shell_quoted(b"a\xffb"), b"a\xffb");
    }
}
