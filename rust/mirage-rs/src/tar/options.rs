use crate::{StreamError, latin1_bytes, number};

const HINT: &[u8] = b"\nTry 'tar --help' or 'tar --usage' for more information.";
/// argp's exit for a line it refuses.
const USAGE: i32 = 2;

/// The options tar 1.35's argp reads in line order and the checks it makes
/// once it has read them: a second main operation where one is set, or a
/// --strip-components value that is no count, stops the scan; then more
/// than one archive is refused without -M, which mirage does not have,
/// and a line with no main operation. `typed` holds `create`, `extract`,
/// `list`, `strip_components` and `file` as `[name, text]` in the order
/// typed, each text one character per byte. The last count is the strip.
pub(super) fn strip(typed: &[(String, String)]) -> Result<usize, StreamError> {
    let refused =
        |line: &[u8]| StreamError::refusal(&[b"tar: ".as_slice(), line, HINT].concat(), USAGE);
    let mut mode: Option<&str> = None;
    let mut archives = 0;
    let mut strip = 0;
    for (name, text) in typed {
        match name.as_str() {
            "create" | "extract" | "list" => match mode {
                Some(set) if set != name => {
                    return Err(refused(
                        b"You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option",
                    ));
                }
                _ => mode = Some(name),
            },
            "file" => archives += 1,
            "strip_components" => {
                let raw = latin1_bytes(text).ok_or_else(|| {
                    StreamError::new("a tar option holds a character past U+00FF")
                })?;
                let parts = number::parts(&raw, false);
                let count = parts.value().filter(|&count| {
                    !parts.negative() && parts.whole() && count <= u128::from(u64::MAX)
                });
                let Some(count) = count else {
                    return Err(refused(
                        &[raw.as_slice(), b": Invalid number of elements"].concat(),
                    ));
                };
                strip = usize::try_from(count).unwrap_or(usize::MAX);
            }
            _ => return Err(StreamError::new(format!("tar reads no option {name}"))),
        }
    }
    if archives > 1 {
        return Err(refused(b"Multiple archive files require '-M' option"));
    }
    if mode.is_none() {
        return Err(refused(
            b"You must specify one of the '-Acdtrux', '--delete' or '--test-label' options",
        ));
    }
    Ok(strip)
}

#[cfg(test)]
mod tests {
    use super::strip;

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
        strip(&typed).map_err(|e| (e.message, e.status))
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
