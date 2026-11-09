use super::transform::Transforms;
use crate::{StreamError, latin1_bytes, number};

const HINT: &[u8] = b"\nTry 'tar --help' or 'tar --usage' for more information.";
/// argp's exit for a line it refuses.
const USAGE: i32 = 2;

/// What the options that take a value came to.
#[derive(Default)]
pub(super) struct Read {
    pub(super) strip: usize,
    pub(super) overwrites: Overwrites,
    pub(super) owner: Option<Owner>,
    pub(super) group: Option<Owner>,
    pub(super) transforms: Transforms,
}

/// What extraction does to a file that is already there.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum Overwrites {
    #[default]
    Replace,
    Keep,
    Skip,
}

/// A `--owner` or `--group`: the name a header records and its id.
#[derive(Clone)]
pub(super) struct Owner {
    pub(super) name: Vec<u8>,
    pub(super) id: u64,
}

/// What `name[:id]` records. A name alone that is all digits is its own
/// id too; any other, unknown to mirage, is id 0.
fn owner(text: &[u8]) -> Result<Owner, StreamError> {
    let digits = |word: &[u8]| {
        std::str::from_utf8(word)
            .ok()
            .filter(|word| !word.is_empty() && word.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|word| word.parse::<u64>().ok())
    };
    match text.iter().position(|&b| b == b':') {
        Some(at) => {
            let id = digits(&text[at + 1..]).ok_or_else(|| {
                StreamError::refusal(
                    &[
                        b"tar: ",
                        &text[at + 1..],
                        b": Invalid owner or group ID\ntar: Error is not recoverable: exiting now",
                    ]
                    .concat(),
                    USAGE,
                )
            })?;
            Ok(Owner {
                name: text[..at].to_vec(),
                id,
            })
        }
        None => Ok(Owner {
            name: text.to_vec(),
            id: digits(text).unwrap_or(0),
        }),
    }
}

/// argmatch over `--sort`'s three words, a unique prefix counting.
fn sort(text: &[u8]) -> Result<(), StreamError> {
    const WORDS: [&[u8]; 3] = [b"none", b"name", b"inode"];
    let found = WORDS.iter().filter(|word| word.starts_with(text)).count();
    if found == 1 && !text.is_empty() || WORDS.contains(&text) {
        return Ok(());
    }
    let what = if found > 1 { "ambiguous" } else { "invalid" };
    let line = [
        b"tar: ".as_slice(),
        what.as_bytes(),
        b" argument '",
        text,
        b"' for '--sort'\nValid arguments are:\n  - 'none'\n  - 'name'\n  - 'inode'",
    ]
    .concat();
    Err(StreamError::refusal(&line, USAGE))
}

/// The options tar 1.35's argp reads in line order and the checks it makes
/// once it has read them: a second main operation where one is set, or a
/// value that is no good, stops the scan; then more than one archive is
/// refused without -M, which mirage does not have, a line with no main
/// operation, and the pairs that cannot go together. `typed` holds each
/// option that takes part as `[name, text]` in the order typed, each text
/// one character per byte. The last count is the strip.
pub(super) fn read(typed: &[(String, String)]) -> Result<Read, StreamError> {
    let refused =
        |line: &[u8]| StreamError::refusal(&[b"tar: ".as_slice(), line, HINT].concat(), USAGE);
    let bytes = |text: &str| {
        latin1_bytes(text)
            .ok_or_else(|| StreamError::new("a tar option holds a character past U+00FF"))
    };
    let mut mode: Option<&str> = None;
    let mut archives = 0;
    let mut archive_is_dash = false;
    let mut compressed = false;
    let mut overwrite: Option<&'static str> = None;
    let mut out = Read::default();
    for (name, text) in typed {
        match name.as_str() {
            "create" | "extract" | "list" | "append" | "update" | "delete" => match mode {
                Some(set) if set != name => {
                    return Err(refused(
                        b"You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option",
                    ));
                }
                _ => mode = Some(name),
            },
            "file" => {
                archives += 1;
                archive_is_dash = text == "-";
            }
            "gzip" | "bzip2" | "xz" | "zstd" => compressed = true,
            "keep_old_files" | "overwrite" | "skip_old_files" => {
                let (long, keep) = match name.as_str() {
                    "keep_old_files" => ("--keep-old-files", Overwrites::Keep),
                    "overwrite" => ("--overwrite", Overwrites::Replace),
                    _ => ("--skip-old-files", Overwrites::Skip),
                };
                if let Some(earlier) = overwrite.filter(|earlier| *earlier != long) {
                    return Err(refused(
                        format!("'{long}' cannot be used with '{earlier}'").as_bytes(),
                    ));
                }
                overwrite = Some(long);
                out.overwrites = keep;
            }
            "sort" => sort(&bytes(text)?)?,
            "owner" => out.owner = Some(owner(&bytes(text)?)?),
            "group" => out.group = Some(owner(&bytes(text)?)?),
            "transform" => out
                .transforms
                .add(&bytes(text)?)
                .map_err(|line| refused(&line))?,
            "strip_components" => {
                let raw = bytes(text)?;
                let parts = number::parts(&raw, false);
                let count = parts.value().filter(|&count| {
                    !parts.negative() && parts.whole() && count <= u128::from(u64::MAX)
                });
                let Some(count) = count else {
                    return Err(refused(
                        &[raw.as_slice(), b": Invalid number of elements"].concat(),
                    ));
                };
                out.strip = usize::try_from(count).unwrap_or(usize::MAX);
            }
            _ => return Err(StreamError::new(format!("tar reads no option {name}"))),
        }
    }
    if archives > 1 {
        return Err(refused(b"Multiple archive files require '-M' option"));
    }
    let Some(mode) = mode else {
        return Err(refused(
            b"You must specify one of the '-Acdtrux', '--delete' or '--test-label' options",
        ));
    };
    if compressed && matches!(mode, "append" | "update" | "delete") {
        return Err(refused(b"Cannot update compressed archives"));
    }
    if matches!(mode, "append" | "update") && (archive_is_dash || archives == 0) {
        return Err(refused(b"Options '-Aru' are incompatible with '-f -'"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::read as read_options;

    const HINT: &str = "\nTry 'tar --help' or 'tar --usage' for more information.";
    const CONFLICT: &str =
        "tar: You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option";
    const MULTIPLE: &str = "tar: Multiple archive files require '-M' option";
    const NO_MODE: &str =
        "tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options";

    fn read(typed: &[(&str, &str)]) -> Result<usize, (String, i32)> {
        let typed: Vec<(String, String)> = typed
            .iter()
            .map(|&(name, text)| (name.to_owned(), text.to_owned()))
            .collect();
        read_options(&typed)
            .map(|read| read.strip)
            .map_err(|e| (e.message, e.status))
    }

    fn refusal(line: &str) -> Result<usize, (String, i32)> {
        Err((format!("{line}{HINT}"), 2))
    }

    #[test]
    fn each_refusal_comes_in_argps_order() {
        assert_eq!(
            read(&[("create", ""), ("extract", ""), ("file", "a")]),
            refusal(CONFLICT)
        );
        assert_eq!(
            read(&[("file", "a"), ("file", "b"), ("create", ""), ("list", "")]),
            refusal(CONFLICT)
        );
        assert_eq!(
            read(&[("list", ""), ("file", "a"), ("file", "b")]),
            refusal(MULTIPLE)
        );
        assert_eq!(read(&[("file", "a"), ("file", "b")]), refusal(MULTIPLE));
        assert_eq!(read(&[("file", "a")]), refusal(NO_MODE));
        assert_eq!(read(&[]), refusal(NO_MODE));
        assert_eq!(
            read(&[("strip_components", "x"), ("create", ""), ("extract", "")]),
            refusal("tar: x: Invalid number of elements")
        );
        assert_eq!(
            read(&[("create", ""), ("extract", ""), ("strip_components", "x")]),
            refusal(CONFLICT)
        );
        assert_eq!(
            read(&[
                ("create", ""),
                ("file", "a"),
                ("file", "b"),
                ("strip_components", "x")
            ]),
            refusal("tar: x: Invalid number of elements")
        );
        assert_eq!(
            read(&[("create", ""), ("create", ""), ("file", "a")]),
            Ok(0)
        );
    }

    #[test]
    fn strip_components_is_refused_as_typed_and_the_last_counts() {
        for typed in ["x", "-1", "1 ", "0x1", "18446744073709551616", ""] {
            assert_eq!(
                read(&[
                    ("list", ""),
                    ("strip_components", "2"),
                    ("strip_components", typed)
                ]),
                refusal(&format!("tar: {typed}: Invalid number of elements"))
            );
        }
        assert_eq!(
            read(&[
                ("strip_components", " +3"),
                ("extract", ""),
                ("strip_components", "7")
            ]),
            Ok(7)
        );
        assert_eq!(
            read(&[
                ("extract", ""),
                ("strip_components", "18446744073709551615")
            ]),
            Ok(usize::try_from(u64::MAX).unwrap_or(usize::MAX))
        );
    }
}
