//! tar as GNU tar 1.35 runs it, as mirage models it from GNU's manual and
//! its pinned output: create (`-c`), list (`-t`) or extract (`-x`), plain
//! or through gzip, bzip2 or xz. Each run is one async task over its host:
//! the archive streams through as it is read or written, its compressor
//! runs in process, and every member is read and every file written
//! through the host. The host walks `-c`'s operands and checks every `-C`;
//! this names, encodes, decodes and words the rest.

mod create;
mod header;
mod read;
#[cfg(test)]
mod tests;

use serde::Deserialize;

use crate::request::{Opening, Reply, Request, failed, failure_text};
use crate::task::Host;
use crate::{Stream, StreamError, parse_config, task};

const FATAL: &str = "tar: Error is not recoverable: exiting now";
const TRAILER: &str = "tar: Exiting with failure status due to previous errors";
/// The status of a run that failed, and of a compressor child that could
/// not open its archive.
const FAILED: i32 = 2;
/// How much of an input one request reads.
const READ: u64 = 256 * 1024;
/// How much output gathers before it goes to the host.
const WINDOW: usize = 256 * 1024;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
enum Mode {
    #[default]
    Create,
    List,
    Extract,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Codec {
    Gzip,
    Bzip2,
    Xz,
}

impl Codec {
    fn format(self) -> &'static str {
        match self {
            Codec::Gzip => "gzip",
            Codec::Bzip2 => "bzip2",
            Codec::Xz => "xz",
        }
    }

    /// The codec whose magic starts `data`.
    fn sniff(data: &[u8]) -> Option<Codec> {
        [Codec::Gzip, Codec::Bzip2, Codec::Xz]
            .into_iter()
            .find(|codec| data.starts_with(codec.magic()))
    }

    fn magic(self) -> &'static [u8] {
        match self {
            Codec::Gzip => b"\x1f\x8b",
            Codec::Bzip2 => b"BZh",
            Codec::Xz => b"\xfd7zXZ\0",
        }
    }

    /// The option that names it.
    fn letter(self) -> &'static str {
        match self {
            Codec::Gzip => "-z",
            Codec::Bzip2 => "-j",
            Codec::Xz => "-J",
        }
    }

    /// The codec stream mirage-rs runs for it.
    fn open(self, operation: &str) -> Box<dyn Stream> {
        let config = format!(
            r#"{{"operation":"{operation}","format":"{}"}}"#,
            self.format()
        );
        crate::compress::open(config.as_bytes()).expect("a codec opens")
    }
}

/// What `-c` stores for one entry the host's walk planned.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Entry {
    #[serde(deserialize_with = "crate::latin1")]
    name: Vec<u8>,
    kind: Planned,
    /// Where its bytes are read, and which host operand that is.
    #[serde(deserialize_with = "crate::latin1_opt")]
    path: Option<Vec<u8>>,
    operand: usize,
    #[serde(deserialize_with = "crate::latin1")]
    target: Vec<u8>,
    /// The path as its operand spelled it, which a diagnostic names.
    #[serde(deserialize_with = "crate::latin1")]
    spelled: Vec<u8>,
    #[serde(deserialize_with = "crate::saturating_u64_opt")]
    size: Option<u64>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
enum Planned {
    #[default]
    File,
    Dir,
    Link,
}

/// The run: its mode, the archive as typed and where `-c` writes it, the
/// compressor, and per mode what the host decided before it began.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct Config {
    mode: Mode,
    #[serde(deserialize_with = "crate::latin1")]
    archive: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1")]
    output: Vec<u8>,
    /// Why the archive's name opens nothing, when the walk already refused
    /// it (the empty name, a link loop).
    #[serde(deserialize_with = "crate::latin1_opt")]
    unopened: Option<Vec<u8>>,
    codec: Option<Codec>,
    verbose: bool,
    /// A missing archive may be a directory a backend keys no file for.
    probe: bool,
    #[serde(deserialize_with = "crate::latin1_list")]
    selectors: Vec<Vec<u8>>,
    #[serde(deserialize_with = "crate::saturating_usize")]
    strip: usize,
    to_stdout: bool,
    /// Where extraction lands.
    #[serde(deserialize_with = "crate::latin1")]
    base: Vec<u8>,
    /// The lines a `-C` the host could not enter ends the run with, once a
    /// member is selected.
    #[serde(deserialize_with = "crate::latin1_list")]
    refusal: Vec<Vec<u8>>,
    members: Vec<Entry>,
    /// What the host's walk said, and the status it came to.
    #[serde(deserialize_with = "crate::latin1_list")]
    notices: Vec<Vec<u8>>,
    status: i32,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(task::spawn(|host| async move {
        match config.mode {
            Mode::Create => create::run(&host, &config).await,
            Mode::List | Mode::Extract => read::run(&host, &config).await,
        }
    }))
}

/// Lines as a diagnostic block, each ended by a newline.
fn lines<T: AsRef<[u8]>>(lines: &[T]) -> Vec<u8> {
    lines
        .iter()
        .flat_map(|line| [line.as_ref(), b"\n"].concat())
        .collect()
}

/// A name as GNU's `escape` quoting style shows it in a UTF-8 locale: C
/// escapes and backslashes doubled, a byte that is not UTF-8 in octal, and
/// of the rest only the C1 controls and the line and paragraph separators
/// escaped, a byte of their UTF-8 at a time.
fn escaped(name: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = name;
    while !rest.is_empty() {
        let (valid, bad) = match std::str::from_utf8(rest) {
            Ok(text) => (text, 0),
            Err(err) => (
                std::str::from_utf8(&rest[..err.valid_up_to()]).unwrap_or_default(),
                err.error_len().unwrap_or(rest.len() - err.valid_up_to()),
            ),
        };
        for c in valid.chars() {
            match c {
                '\\' => out.extend_from_slice(b"\\\\"),
                '\x07' => out.extend_from_slice(b"\\a"),
                '\x08' => out.extend_from_slice(b"\\b"),
                '\t' => out.extend_from_slice(b"\\t"),
                '\n' => out.extend_from_slice(b"\\n"),
                '\x0b' => out.extend_from_slice(b"\\v"),
                '\x0c' => out.extend_from_slice(b"\\f"),
                '\r' => out.extend_from_slice(b"\\r"),
                '\0'..='\x1f' | '\x7f' | '\u{80}'..='\u{9f}' | '\u{2028}' | '\u{2029}' => {
                    for byte in c.to_string().bytes() {
                        out.extend(format!("\\{byte:03o}").bytes());
                    }
                }
                _ => out.extend_from_slice(c.to_string().as_bytes()),
            }
        }
        let start = valid.len();
        for &byte in &rest[start..start + bad] {
            out.extend(format!("\\{byte:03o}").bytes());
        }
        rest = &rest[start + bad..];
    }
    out
}

/// The run's lines for an archive it cannot open or read: GNU opens the
/// archive before anything else, and a directory opens and then fails the
/// first read. With a compressor the archive is opened by tar's child,
/// which names itself on each of its lines; a reading child has already
/// spawned the compressor, which meets an empty pipe and says so, unless
/// the name was missing (tar 1.35, gzip 1.13, xz 5.4).
fn open_failure(config: &Config, reply: &Reply, reading: bool) -> Vec<u8> {
    let who = if config.codec.is_some() {
        "tar (child)"
    } else {
        "tar"
    };
    let (name, text) = (&config.archive, failure_text(reply));
    let mut out = Vec::new();
    if reading && reply.names(&["EISDIR"]) {
        out.extend(
            [
                who.as_bytes(),
                b": ",
                name,
                b": Cannot read: ",
                &text,
                b"\n",
            ]
            .concat(),
        );
        out.extend(format!("{who}: At beginning of tape, quitting now\n").bytes());
    } else {
        out.extend(
            [
                who.as_bytes(),
                b": ",
                name,
                b": Cannot open: ",
                &text,
                b"\n",
            ]
            .concat(),
        );
    }
    out.extend(format!("{who}{}\n", &FATAL[3..]).bytes());
    if let Some(codec) = config.codec {
        if reading && !reply.names(&["ENOENT"]) {
            out.extend_from_slice(match codec {
                Codec::Gzip => b"\ngzip: stdin: unexpected end of file\n",
                Codec::Xz => b"xz: (stdin): File format not recognized\n",
                Codec::Bzip2 => b"",
            });
        }
        out.extend(format!("tar: Child returned status {FAILED}\n{FATAL}\n").bytes());
    }
    out
}

/// A host read of input `fd`, opening it with `open` first; the host's
/// failure when it failed, else its bytes, none at the end.
async fn read(
    host: &Host,
    fd: u32,
    open: Option<(Vec<u8>, Opening)>,
) -> Result<Option<Vec<u8>>, Box<Reply>> {
    let (reply, data) = host
        .ask(Request::Read {
            fd,
            open,
            least: READ,
        })
        .await;
    if failed(&reply) {
        return Err(Box::new(reply));
    }
    Ok((!reply.end).then_some(data))
}
