//! cut's options as typed: which list, which delimiters, and the
//! whitespace extensions, each refused in cut's words with status 1.

use serde::Deserialize;

use super::{Mode, Whitespace};
use crate::{StreamError, quoted};

/// The options cut reads, by the name each host's spec gives it.
const NAMES: [&str; 13] = [
    "bytes",
    "characters",
    "fields",
    "F",
    "delimiter",
    "no_partial",
    "complement",
    "only_delimited",
    "args_O",
    "output_delimiter",
    "w",
    "whitespace_delimited",
    "zero_terminated",
];

/// One option as typed: its name and its text, one character per byte.
/// A switch is the empty text; only `--whitespace-delimited` typed
/// without `=` is null, since `--whitespace-delimited=` reads as a prefix
/// of `trimmed`.
#[derive(Deserialize)]
pub(super) struct Typed(
    String,
    #[serde(deserialize_with = "crate::latin1_opt")] Option<Vec<u8>>,
);

/// What cut's options select, its list still as typed.
pub(super) struct Selection {
    pub(super) list: Vec<u8>,
    pub(super) mode: Mode,
    /// `None` for a byte no UTF-8 character is, which no field ends at.
    /// GNU splits on that byte; fields here are decoded characters, so a
    /// raw byte never ends one.
    pub(super) delimiter: Option<char>,
    pub(super) complement: bool,
    pub(super) only_delimited: bool,
    pub(super) whitespace: Option<Whitespace>,
    pub(super) no_partial: bool,
    pub(super) output_delimiter: Option<Vec<u8>>,
    pub(super) zero_terminated: bool,
}

fn refusal(message: impl Into<String>) -> StreamError {
    StreamError::refusal(message.into().as_bytes(), 1)
}

/// The one character `raw` spells: `Some(None)` for a single byte that is
/// no UTF-8, `None` for anything longer.
fn one_character(raw: &[u8]) -> Option<Option<char>> {
    let mut chunks = raw.utf8_chunks();
    let chunk = chunks.next()?;
    if chunks.next().is_some() {
        return None;
    }
    let mut chars = chunk.valid().chars();
    match (chars.next(), chars.next(), chunk.invalid()) {
        (Some(ch), None, []) => Some(Some(ch)),
        (None, _, [_]) => Some(None),
        _ => None,
    }
}

/// cut's options, each value the last one typed. A list of more than one
/// kind is refused, and so are a `--whitespace-delimited` word other than
/// `trimmed` or a prefix of it, the whitespace extensions outside field
/// mode and a delimiter of more than one character. `-F` is `-f` with `-w`
/// and an output delimiter of a space, `-O` outranks `--output-delimiter`
/// wherever each was typed, and an empty delimiter is NUL.
pub(super) fn read(options: &[Typed]) -> Result<Selection, StreamError> {
    if let Some(Typed(name, _)) = options.iter().find(|Typed(name, text)| {
        !NAMES.contains(&name.as_str()) || (text.is_none() && name != "whitespace_delimited")
    }) {
        return Err(crate::scan::unknown("cut", name));
    }
    let typed = |name: &str| options.iter().any(|Typed(typed, _)| typed == name);
    let last = |name: &str| {
        options
            .iter()
            .rev()
            .find(|Typed(typed, _)| typed == name)
            .map(|Typed(_, text)| text.as_deref())
    };
    let value = |name: &str| last(name).map(Option::unwrap_or_default);
    let lists = [
        (Mode::Bytes, value("bytes")),
        (Mode::Characters, value("characters")),
        (Mode::Fields, value("F").or_else(|| value("fields"))),
    ];
    let mut given = lists
        .into_iter()
        .filter_map(|(mode, list)| list.map(|list| (mode, list)));
    let Some((mode, list)) = given.next() else {
        return Err(refusal(
            "cut: you must specify a list of bytes, characters, or fields",
        ));
    };
    if given.next().is_some() {
        return Err(refusal("cut: only one type of list may be specified"));
    }
    let whitespace = match last("whitespace_delimited") {
        _ if typed("w") || typed("F") => Some(Whitespace::Default),
        Some(None) => Some(Whitespace::Default),
        Some(Some(word)) if b"trimmed".starts_with(word) => Some(Whitespace::Trimmed),
        Some(Some(word)) => {
            return Err(refusal(format!(
                "cut: invalid argument '{}' for '--whitespace-delimited'",
                quoted(word)
            )));
        }
        None => None,
    };
    if whitespace.is_some() && mode != Mode::Fields {
        return Err(refusal("cut: '-w' is only meaningful with fields"));
    }
    let output_delimiter = match value("args_O").or_else(|| value("output_delimiter")) {
        Some([]) => Some(vec![0]),
        Some(raw) => Some(raw.to_vec()),
        None => typed("F").then(|| b" ".to_vec()),
    };
    let delimiter = match value("delimiter") {
        None => Some('\t'),
        Some([]) => Some('\0'),
        Some(raw) => one_character(raw)
            .ok_or_else(|| refusal("cut: the delimiter must be a single character"))?,
    };
    Ok(Selection {
        list: list.to_vec(),
        mode,
        delimiter,
        complement: typed("complement"),
        only_delimited: typed("only_delimited"),
        whitespace,
        no_partial: typed("no_partial"),
        output_delimiter,
        zero_terminated: typed("zero_terminated"),
    })
}

#[cfg(test)]
mod tests {
    use super::{Mode, Selection, Typed, Whitespace, read};

    type Line<'a> = &'a [(&'a str, Option<&'a [u8]>)];

    fn select(options: Line) -> Result<Selection, String> {
        let options: Vec<Typed> = options
            .iter()
            .map(|&(name, text)| Typed(name.to_owned(), text.map(<[u8]>::to_vec)))
            .collect();
        read(&options).map_err(|refusal| {
            assert_eq!(refusal.status, 1);
            refusal.message
        })
    }

    fn refusal(options: Line) -> String {
        match select(options) {
            Ok(_) => panic!("cut read {options:?}"),
            Err(message) => message,
        }
    }

    const F1: (&str, Option<&[u8]>) = ("fields", Some(b"1"));

    #[test]
    fn refuses_in_cut_words_and_order() {
        let cases: [(Line, &str); 10] = [
            (
                &[],
                "you must specify a list of bytes, characters, or fields",
            ),
            (
                &[("complement", Some(b""))],
                "you must specify a list of bytes, characters, or fields",
            ),
            (
                &[F1, ("bytes", Some(b"2"))],
                "only one type of list may be specified",
            ),
            (
                &[("F", Some(b"1")), ("characters", Some(b"2"))],
                "only one type of list may be specified",
            ),
            (
                &[F1, ("bytes", Some(b"0")), ("delimiter", Some(b"ab"))],
                "only one type of list may be specified",
            ),
            (
                &[F1, ("whitespace_delimited", Some(b"tt"))],
                "invalid argument 'tt' for '--whitespace-delimited'",
            ),
            (
                &[F1, ("whitespace_delimited", Some(b"x\xc3\xa9"))],
                "invalid argument 'x\\303\\251' for '--whitespace-delimited'",
            ),
            (
                &[("bytes", Some(b"1")), ("w", Some(b""))],
                "'-w' is only meaningful with fields",
            ),
            (
                &[
                    ("characters", Some(b"1")),
                    ("whitespace_delimited", Some(b"t")),
                    ("delimiter", Some(b"ab")),
                ],
                "'-w' is only meaningful with fields",
            ),
            (
                &[("bytes", Some(b"0")), ("delimiter", Some(b"ab"))],
                "the delimiter must be a single character",
            ),
        ];
        for (options, expected) in cases {
            assert_eq!(refusal(options), format!("cut: {expected}"), "{options:?}");
        }
        for delimiter in [
            b",,".as_slice(),
            b"\xff\xfe",
            b"\xe4\xb8",
            b"a\xff",
            "é,".as_bytes(),
        ] {
            assert_eq!(
                refusal(&[F1, ("delimiter", Some(delimiter))]),
                "cut: the delimiter must be a single character"
            );
        }
        assert_eq!(
            refusal(&[F1, ("width", Some(b"1"))]),
            "scan: cut reads no option width"
        );
    }

    #[test]
    fn the_last_list_of_a_kind_counts_and_f_upper_outranks_f() {
        let selection = select(&[F1, ("fields", Some(b"2"))]).unwrap();
        assert_eq!(
            (selection.mode, selection.list.as_slice()),
            (Mode::Fields, b"2".as_slice())
        );
        let selection = select(&[("F", Some(b"3")), ("fields", Some(b"2"))]).unwrap();
        assert_eq!(selection.list, b"3");
        assert!(selection.whitespace == Some(Whitespace::Default));
        assert_eq!(selection.output_delimiter.as_deref(), Some(b" ".as_slice()));
        let selection = select(&[("characters", Some(b"1-"))]).unwrap();
        assert!(selection.mode == Mode::Characters && selection.whitespace.is_none());
    }

    #[test]
    fn reads_the_whitespace_extensions() {
        for word in [b"trimmed".as_slice(), b"trim", b"t", b""] {
            let selection = select(&[F1, ("whitespace_delimited", Some(word))]).unwrap();
            assert!(
                selection.whitespace == Some(Whitespace::Trimmed),
                "{word:?}"
            );
        }
        let cases: [Line; 5] = [
            &[F1, ("whitespace_delimited", None)],
            &[F1, ("w", Some(b""))],
            &[F1, ("w", Some(b"")), ("whitespace_delimited", Some(b"x"))],
            &[F1, ("whitespace_delimited", Some(b"x")), ("w", Some(b""))],
            &[
                F1,
                ("whitespace_delimited", Some(b"x")),
                ("whitespace_delimited", None),
            ],
        ];
        for options in cases {
            let selection = select(options).unwrap();
            assert!(
                selection.whitespace == Some(Whitespace::Default),
                "{options:?}"
            );
        }
        assert_eq!(
            refusal(&[
                F1,
                ("whitespace_delimited", None),
                ("whitespace_delimited", Some(b"x"))
            ]),
            "cut: invalid argument 'x' for '--whitespace-delimited'"
        );
    }

    #[test]
    fn reads_both_delimiters() {
        let delimiter = |text: &[u8]| select(&[F1, ("delimiter", Some(text))]).map(|s| s.delimiter);
        assert_eq!(select(&[F1]).unwrap().delimiter, Some('\t'));
        assert_eq!(delimiter(b","), Ok(Some(',')));
        assert_eq!(delimiter(b""), Ok(Some('\0')));
        assert_eq!(delimiter("é".as_bytes()), Ok(Some('é')));
        assert_eq!(delimiter("😀".as_bytes()), Ok(Some('😀')));
        assert_eq!(delimiter(b"\xff"), Ok(None));
        let output = |options: Line| {
            let mut typed = vec![F1];
            typed.extend_from_slice(options);
            select(&typed).unwrap().output_delimiter
        };
        assert_eq!(output(&[]), None);
        assert_eq!(output(&[("output_delimiter", Some(b""))]), Some(vec![0]));
        assert_eq!(
            output(&[("output_delimiter", Some(b"\xff"))]),
            Some(vec![0xff])
        );
        assert_eq!(
            output(&[("args_O", Some(b"+")), ("output_delimiter", Some(b"-"))]),
            Some(b"+".to_vec())
        );
        assert_eq!(
            output(&[("output_delimiter", Some(b"-")), ("args_O", Some(b"+"))]),
            Some(b"+".to_vec())
        );
        assert_eq!(
            output(&[("F", Some(b"1")), ("output_delimiter", Some(b"-"))]),
            Some(b"-".to_vec())
        );
    }

    #[test]
    fn a_null_value_is_only_a_bare_whitespace_delimited() {
        assert!(select(&[F1, ("whitespace_delimited", None)]).is_ok());
        assert_eq!(
            refusal(&[F1, ("complement", None)]),
            "scan: cut reads no option complement"
        );
    }

    #[test]
    fn reads_the_switches() {
        let selection = select(&[F1]).unwrap();
        assert!(
            !(selection.complement
                || selection.only_delimited
                || selection.no_partial
                || selection.zero_terminated)
        );
        let selection = select(&[
            F1,
            ("complement", Some(b"")),
            ("only_delimited", Some(b"")),
            ("no_partial", Some(b"")),
            ("zero_terminated", Some(b"")),
        ])
        .unwrap();
        assert!(
            selection.complement
                && selection.only_delimited
                && selection.no_partial
                && selection.zero_terminated
        );
    }
}
