//! sort's options as GNU sort 9.7 reads them, through the `scan` stream.
//! The option loop refuses in the order typed: a bad `-t`, two different
//! tabs, a bad KEYDEF, two different `-o` words, a refused `--check` word
//! and a second check mode. Then each key is checked for orderings it
//! cannot mix, and last `-c` refuses a second operand and an output. What
//! the host gets back is the check mode and the configuration it hands
//! every sort engine it opens.

use serde_json::{Value as Json, json};

use super::key::{Compare, Key, Mods};
use crate::scan::{OPERAND, Typed, Values, unknown};
use crate::{StreamError, number, quoted};

/// The ordering letters a KEYDEF takes after a position.
const ORDER_LETTERS: &[u8] = b"bdfghiMnRrV";

/// The words `--check` takes, each mode's together in the order GNU's
/// refusal lists them.
const CHECK_WORDS: [(&str, Check); 3] = [
    ("quiet", Check::Quiet),
    ("silent", Check::Quiet),
    ("diagnose-first", Check::Diagnose),
];

/// Which check `-c`, `-C` or `--check` asks for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Check {
    /// `-c`: report the first disorder.
    Diagnose,
    /// `-C`: exit 1 on a disorder, silently.
    Quiet,
}

impl Check {
    fn letter(self) -> char {
        match self {
            Check::Diagnose => 'c',
            Check::Quiet => 'C',
        }
    }
}

/// A KEYDEF as typed, before the global options it may inherit are known.
struct KeyDef<'a> {
    start_field: usize,
    start_char: usize,
    end_field: Option<usize>,
    end_char: Option<usize>,
    start_letters: &'a [u8],
    end_letters: &'a [u8],
}

impl KeyDef<'_> {
    /// The key: one that carries any letter of its own, `b` included,
    /// takes none of the global options.
    fn key(&self, globals: Mods, skip: bool) -> Key {
        let (mods, start_skip, end_skip) =
            if self.start_letters.is_empty() && self.end_letters.is_empty() {
                (globals, skip, skip)
            } else {
                (
                    mods_of(&[self.start_letters, self.end_letters].concat()),
                    self.start_letters.contains(&b'b'),
                    self.end_letters.contains(&b'b'),
                )
            };
        Key {
            start_field: self.start_field,
            start_char: self.start_char,
            start_skip,
            end_field: self.end_field,
            end_char: self.end_char,
            end_skip,
            mods,
        }
    }
}

fn usage(message: impl AsRef<[u8]>) -> StreamError {
    StreamError::refusal(message.as_ref(), 2)
}

/// sort's typed options, then its operands as `""`.
pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let mut globals = Mods::default();
    let mut skip = false;
    let (mut unique, mut stable, mut zero_terminated) = (false, false, false);
    let mut tab: Option<u8> = None;
    let mut keydefs = Vec::new();
    let mut output: Option<&[u8]> = None;
    let mut check: Option<Check> = None;
    let mut operands = Vec::new();
    for (name, raw) in options {
        match name.as_str() {
            "reverse" => globals.reverse = true,
            "numeric_sort" => globals.numeric = true,
            "general_numeric_sort" => globals.general_numeric = true,
            "human_numeric_sort" => globals.human = true,
            "version_sort" => globals.version = true,
            "month_sort" => globals.month = true,
            "ignore_case" => globals.fold = true,
            "dictionary_order" => globals.dictionary = true,
            "ignore_nonprinting" => globals.ignore_nonprinting = true,
            "ignore_leading_blanks" => skip = true,
            "unique" => unique = true,
            "stable" => stable = true,
            "zero_terminated" => zero_terminated = true,
            "field_separator" => {
                let byte = tab_byte(raw)?;
                if tab.is_some_and(|held| held != byte) {
                    return Err(usage("sort: incompatible tabs"));
                }
                tab = Some(byte);
            }
            "key" => keydefs.push(keydef(raw)?),
            "output" => {
                if output.is_some_and(|held| held != raw.as_slice()) {
                    return Err(usage("sort: multiple output files specified"));
                }
                output = Some(raw);
            }
            "c" | "C" | "check" => {
                let mode = match name.as_str() {
                    "c" => Check::Diagnose,
                    "C" => Check::Quiet,
                    _ => check_word(raw)?,
                };
                if check.is_some_and(|held| held != mode) {
                    return Err(usage("sort: options '-cC' are incompatible"));
                }
                check = Some(mode);
            }
            OPERAND => operands.push(raw.as_slice()),
            _ => return Err(unknown("sort", name)),
        }
    }
    let keys: Vec<Key> = if keydefs.is_empty() {
        vec![Key {
            start_field: 1,
            start_char: 1,
            start_skip: skip,
            end_field: None,
            end_char: None,
            end_skip: skip,
            mods: globals,
        }]
    } else {
        keydefs.iter().map(|def| def.key(globals, skip)).collect()
    };
    if let Some(letters) = keys.iter().find_map(|key| incompatible(&key.mods)) {
        return Err(usage(format!(
            "sort: options '-{letters}' are incompatible"
        )));
    }
    if let Some(mode) = check {
        let letter = mode.letter();
        if let Some(extra) = operands.get(1) {
            let head = b"sort: extra operand '".as_slice();
            let tail = format!("' not allowed with -{letter}");
            return Err(usage([head, extra, tail.as_bytes()].concat()));
        }
        if output.is_some() {
            return Err(usage(format!(
                "sort: options '-{letter}o' are incompatible"
            )));
        }
    }
    let compare = Compare {
        keys,
        field_sep: tab,
        reverse: globals.reverse,
        unique,
        stable,
    };
    let mut values = Values::new();
    values.insert(
        "check".to_owned(),
        check.map_or(Json::Null, |mode| Json::from(mode.letter().to_string())),
    );
    values.insert(
        "config".to_owned(),
        json!({"compare": compare, "zero_terminated": zero_terminated}),
    );
    Ok(values)
}

/// `-t`'s separator: one byte, `\0` for NUL.
fn tab_byte(raw: &[u8]) -> Result<u8, StreamError> {
    match raw {
        [] => Err(usage("sort: empty tab")),
        b"\\0" => Ok(0),
        [byte] => Ok(*byte),
        _ => Err(usage(format!(
            "sort: multi-character tab '{}'",
            quoted(raw)
        ))),
    }
}

/// `--check`'s word: `quiet` or `silent` for `-C`, `diagnose-first` for
/// `-c`, or a prefix of words that name one of them. GNU refuses any other
/// word with exit 1.
fn check_word(raw: &[u8]) -> Result<Check, StreamError> {
    let mut modes = CHECK_WORDS
        .iter()
        .filter(|(word, _)| word.as_bytes().starts_with(raw))
        .map(|&(_, mode)| mode);
    let kind = match modes.next() {
        None => "invalid",
        Some(mode) if modes.all(|other| other == mode) => return Ok(mode),
        Some(_) => "ambiguous",
    };
    let refused = format!(
        "sort: {kind} argument '{}' for '--check'\n{}",
        quoted(raw),
        check_hint()
    );
    Err(StreamError::refusal(refused.as_bytes(), 1))
}

/// The lines after a refused `--check` word: each mode's words on one
/// line, then the usage hint.
fn check_hint() -> String {
    let mut hint = String::from("Valid arguments are:");
    let mut listed = None;
    for (word, mode) in CHECK_WORDS {
        hint.push_str(if listed == Some(mode) { ", " } else { "\n  - " });
        listed = Some(mode);
        hint.push_str(&format!("'{word}'"));
    }
    hint.push_str("\nTry 'sort --help' for more information.");
    hint
}

/// One `-k` KEYDEF, `F[.C][OPTS][,F[.C][OPTS]]`, read left to right: each
/// number is checked as it is read, so `-k0.x` names the zero field and not
/// the bad offset, and ordering letters run until the first byte that is
/// not one, where anything left over is a stray character. A start offset
/// of zero is refused and an end offset of zero means the end of its field.
fn keydef(spec: &[u8]) -> Result<KeyDef<'_>, StreamError> {
    let (start_field, mut at) = count(spec, 0, "invalid number at field start")?;
    if start_field == 0 {
        return Err(field_spec(spec, "field number is zero"));
    }
    let mut start_char = 1;
    if spec.get(at) == Some(&b'.') {
        (start_char, at) = count(spec, at + 1, "invalid number after '.'")?;
        if start_char == 0 {
            return Err(field_spec(spec, "character offset is zero"));
        }
    }
    let (start_letters, mut at) = letters(spec, at);
    let (mut end_field, mut end_char, mut end_letters) = (None, None, &spec[..0]);
    if spec.get(at) == Some(&b',') {
        let field;
        (field, at) = count(spec, at + 1, "invalid number after ','")?;
        if field == 0 {
            return Err(field_spec(spec, "field number is zero"));
        }
        end_field = Some(field);
        if spec.get(at) == Some(&b'.') {
            let offset;
            (offset, at) = count(spec, at + 1, "invalid number after '.'")?;
            end_char = Some(offset);
        }
        (end_letters, at) = letters(spec, at);
    }
    if at < spec.len() {
        return Err(field_spec(spec, "stray character in field spec"));
    }
    Ok(KeyDef {
        start_field,
        start_char,
        end_field,
        end_char,
        start_letters,
        end_letters,
    })
}

/// A KEYDEF number as strtoumax reads it from `at`: blanks and one `+`
/// taken, then ASCII digits, a value past `usize` saturating. No digit, or
/// a `-`, is refused with the text from `at` on.
fn count(spec: &[u8], at: usize, what: &str) -> Result<(usize, usize), StreamError> {
    let parts = number::parts(&spec[at..], false);
    if parts.digits.is_empty() || parts.negative() {
        let shown = quoted(&spec[at..]);
        return Err(usage(format!(
            "sort: {what}: invalid count at start of '{shown}'"
        )));
    }
    let value = usize::try_from(parts.saturating()).unwrap_or(usize::MAX);
    Ok((value, spec.len() - parts.rest.len()))
}

fn field_spec(spec: &[u8], why: &str) -> StreamError {
    usage(format!(
        "sort: {why}: invalid field specification '{}'",
        quoted(spec)
    ))
}

/// The run of ordering letters from `at`, and where it ends.
fn letters(spec: &[u8], at: usize) -> (&[u8], usize) {
    let run = spec[at..]
        .iter()
        .take_while(|byte| ORDER_LETTERS.contains(byte))
        .count();
    (&spec[at..at + run], at + run)
}

fn mods_of(letters: &[u8]) -> Mods {
    let has = |letter: u8| letters.contains(&letter);
    Mods {
        numeric: has(b'n'),
        general_numeric: has(b'g'),
        human: has(b'h'),
        version: has(b'V'),
        month: has(b'M'),
        fold: has(b'f'),
        reverse: has(b'r'),
        dictionary: has(b'd'),
        ignore_nonprinting: has(b'i'),
        random: has(b'R'),
    }
}

/// The letters of a key that orders by more than one of `-n`, `-g`, `-h`,
/// `-M` and the group `-V`, `-R`, `-d`, `-i`, whose members combine with
/// each other but with none of the rest. GNU spells them without `-b` and
/// `-r`, and `-d` hides `-i` because it keeps only the stronger filter.
fn incompatible(mods: &Mods) -> Option<String> {
    let text_order = mods.version || mods.random || mods.dictionary || mods.ignore_nonprinting;
    let orderings = [
        mods.numeric,
        mods.general_numeric,
        mods.human,
        mods.month,
        text_order,
    ];
    if orderings.iter().filter(|&&on| on).count() <= 1 {
        return None;
    }
    let spelled = [
        ('d', mods.dictionary),
        ('f', mods.fold),
        ('g', mods.general_numeric),
        ('h', mods.human),
        ('i', mods.ignore_nonprinting && !mods.dictionary),
        ('M', mods.month),
        ('n', mods.numeric),
        ('R', mods.random),
        ('V', mods.version),
    ];
    Some(
        spelled
            .iter()
            .filter(|(_, on)| *on)
            .map(|(letter, _)| *letter)
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as Json, json};

    use super::scan;

    type Options<'a> = [(&'a str, &'a str)];

    /// What sort's grammar makes of `options`: its values, or its stderr
    /// and status.
    fn read(options: &Options) -> Result<Json, (String, i32)> {
        let typed: Vec<_> = options
            .iter()
            .map(|(name, text)| ((*name).to_owned(), text.as_bytes().to_vec()))
            .collect();
        scan(&typed).map(Json::Object).map_err(|refused| {
            let stderr = String::from_utf8_lossy(&refused.stderr()).into_owned();
            (stderr, refused.status)
        })
    }

    fn refusal(options: &Options) -> (String, i32) {
        read(options).expect_err("refused")
    }

    fn usage(message: &str) -> (String, i32) {
        (format!("sort: {message}"), 2)
    }

    fn keys(options: &Options) -> Json {
        read(options).expect("read")["config"]["compare"]["keys"].clone()
    }

    #[test]
    fn a_line_with_no_options_is_one_key_over_the_record() {
        assert_eq!(
            read(&[]).expect("read"),
            json!({"check": null, "config": {
                "compare": {
                    "keys": [{
                        "start_field": 1, "start_char": 1, "start_skip": false,
                        "end_field": null, "end_char": null, "end_skip": false,
                        "mods": {
                            "numeric": false, "general_numeric": false, "human": false,
                            "version": false, "month": false, "fold": false,
                            "reverse": false, "dictionary": false,
                            "ignore_nonprinting": false, "random": false,
                        },
                    }],
                    "field_sep": null, "reverse": false, "unique": false, "stable": false,
                },
                "zero_terminated": false,
            }})
        );
        let values = read(&[
            ("reverse", ""),
            ("unique", ""),
            ("stable", ""),
            ("zero_terminated", ""),
            ("ignore_leading_blanks", ""),
            ("numeric_sort", ""),
        ])
        .expect("read");
        let config = &values["config"];
        assert_eq!(
            (
                &config["compare"]["reverse"],
                &config["compare"]["unique"],
                &config["compare"]["stable"],
                &config["zero_terminated"],
            ),
            (&json!(true), &json!(true), &json!(true), &json!(true))
        );
        let key = &config["compare"]["keys"][0];
        assert_eq!(
            (&key["start_skip"], &key["end_skip"]),
            (&json!(true), &json!(true))
        );
        assert_eq!(
            (&key["mods"]["numeric"], &key["mods"]["reverse"]),
            (&json!(true), &json!(true))
        );
    }

    #[test]
    fn a_keydef_names_its_fields_and_offsets() {
        let key = &keys(&[("key", "2")])[0];
        assert_eq!(
            (&key["start_field"], &key["start_char"], &key["end_field"]),
            (&json!(2), &json!(1), &Json::Null)
        );
        let key = &keys(&[("key", "2.3,4.5")])[0];
        assert_eq!(
            (&key["start_field"], &key["start_char"]),
            (&json!(2), &json!(3))
        );
        assert_eq!(
            (&key["end_field"], &key["end_char"]),
            (&json!(4), &json!(5))
        );
        let key = &keys(&[("key", "2,2.0n")])[0];
        assert_eq!(
            (&key["end_field"], &key["end_char"]),
            (&json!(2), &json!(0))
        );
        assert_eq!(key["mods"]["numeric"], json!(true));
    }

    #[test]
    fn a_number_takes_leading_blanks_and_a_plus_and_saturates() {
        for (spec, at, want) in [
            ("+2", "start_field", 2u64),
            (" 2", "start_field", 2),
            ("\t2", "start_field", 2),
            ("1.+2", "start_char", 2),
            ("1,+2", "end_field", 2),
            ("0002", "start_field", 2),
        ] {
            assert_eq!(keys(&[("key", spec)])[0][at], json!(want), "{spec}");
        }
        let key = &keys(&[("key", "99999999999999999999999.1")])[0];
        assert_eq!(key["start_field"], json!(usize::MAX));
    }

    #[test]
    fn a_key_with_letters_of_its_own_takes_no_global_option() {
        let key = &keys(&[("reverse", ""), ("key", "2,2n")])[0];
        assert_eq!(
            (&key["mods"]["numeric"], &key["mods"]["reverse"]),
            (&json!(true), &json!(false))
        );
        let key = &keys(&[("numeric_sort", ""), ("key", "2b")])[0];
        assert_eq!(
            (
                &key["mods"]["numeric"],
                &key["start_skip"],
                &key["end_skip"]
            ),
            (&json!(false), &json!(true), &json!(false))
        );
        let key = &keys(&[("numeric_sort", ""), ("key", "1,1h")])[0];
        assert_eq!(
            (&key["mods"]["human"], &key["mods"]["numeric"]),
            (&json!(true), &json!(false))
        );
        let typed = [
            ("key", "2"),
            ("numeric_sort", ""),
            ("reverse", ""),
            ("ignore_leading_blanks", ""),
        ];
        let key = &keys(&typed)[0];
        assert_eq!(
            (&key["mods"]["numeric"], &key["mods"]["reverse"]),
            (&json!(true), &json!(true))
        );
        assert_eq!(
            (&key["start_skip"], &key["end_skip"]),
            (&json!(true), &json!(true))
        );
    }

    // GNU coreutils 9.7's own words for a KEYDEF it refuses, measured on
    // debian:stable-slim under LC_ALL=C.
    #[test]
    fn a_refused_keydef_in_gnus_words() {
        for (spec, message) in [
            (
                "a",
                "invalid number at field start: invalid count at start of 'a'",
            ),
            (
                "",
                "invalid number at field start: invalid count at start of ''",
            ),
            (
                "-1",
                "invalid number at field start: invalid count at start of '-1'",
            ),
            (
                "1.a",
                "invalid number after '.': invalid count at start of 'a'",
            ),
            (
                "1.",
                "invalid number after '.': invalid count at start of ''",
            ),
            (
                "1,a",
                "invalid number after ',': invalid count at start of 'a'",
            ),
            (
                "1,",
                "invalid number after ',': invalid count at start of ''",
            ),
            (
                "1,-2",
                "invalid number after ',': invalid count at start of '-2'",
            ),
            (
                "1,1.a",
                "invalid number after '.': invalid count at start of 'a'",
            ),
            ("0", "field number is zero: invalid field specification '0'"),
            (
                "0.x",
                "field number is zero: invalid field specification '0.x'",
            ),
            (
                "1.0",
                "character offset is zero: invalid field specification '1.0'",
            ),
            (
                "1.0x",
                "character offset is zero: invalid field specification '1.0x'",
            ),
            (
                "1,0",
                "field number is zero: invalid field specification '1,0'",
            ),
            (
                "1x",
                "stray character in field spec: invalid field specification '1x'",
            ),
            (
                "1,1x",
                "stray character in field spec: invalid field specification '1,1x'",
            ),
            (
                "1x,2",
                "stray character in field spec: invalid field specification '1x,2'",
            ),
            (
                "1n.2",
                "stray character in field spec: invalid field specification '1n.2'",
            ),
            (
                "1,2,3",
                "stray character in field spec: invalid field specification '1,2,3'",
            ),
            (
                "1N",
                "stray character in field spec: invalid field specification '1N'",
            ),
            (
                "1nMx",
                "stray character in field spec: invalid field specification '1nMx'",
            ),
            (
                "'1",
                "invalid number at field start: invalid count at start of '\\'1'",
            ),
            (
                "1'x",
                "stray character in field spec: invalid field specification '1\\'x'",
            ),
            (
                "1\nx",
                "stray character in field spec: invalid field specification '1\\nx'",
            ),
            (
                "1\u{e9}",
                "stray character in field spec: invalid field specification '1\\303\\251'",
            ),
            (
                "\u{661}",
                "invalid number at field start: invalid count at start of '\\331\\241'",
            ),
            (
                "2.\u{663}",
                "invalid number after '.': invalid count at start of '\\331\\243'",
            ),
        ] {
            assert_eq!(refusal(&[("key", spec)]), usage(message), "{spec:?}");
        }
    }

    #[test]
    fn a_tab_is_one_byte_or_backslash_zero() {
        let tab = |options: &Options| {
            read(options).expect("read")["config"]["compare"]["field_sep"].clone()
        };
        assert_eq!(tab(&[("field_separator", ":")]), json!(58));
        assert_eq!(tab(&[("field_separator", "\\0")]), json!(0));
        let byte = scan(&[("field_separator".to_owned(), vec![0xff])]).expect("read");
        assert_eq!(byte["config"]["compare"]["field_sep"], json!(255));
        let twice = [("field_separator", ":"), ("field_separator", ":")];
        assert_eq!(tab(&twice), json!(58));
        assert_eq!(refusal(&[("field_separator", "")]), usage("empty tab"));
        assert_eq!(
            refusal(&[("field_separator", "ab")]),
            usage("multi-character tab 'ab'")
        );
        assert_eq!(
            refusal(&[("field_separator", "\u{e9}")]),
            usage("multi-character tab '\\303\\251'")
        );
        let two = [("field_separator", ":"), ("field_separator", ",")];
        assert_eq!(refusal(&two), usage("incompatible tabs"));
    }

    #[test]
    fn two_outputs_are_refused_unless_typed_as_one_word() {
        let same = [("output", "/data/p1"), ("output", "/data/p1")];
        assert_eq!(read(&same).expect("read")["check"], Json::Null);
        let two = [("output", "./out"), ("output", "out")];
        assert_eq!(refusal(&two), usage("multiple output files specified"));
    }

    // Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
    #[test]
    fn check_reads_its_word_or_a_prefix_of_one_mode() {
        let check = |options: &Options| read(options).expect("read")["check"].clone();
        for (word, letter) in [
            ("quiet", "C"),
            ("silent", "C"),
            ("q", "C"),
            ("s", "C"),
            ("diagnose-first", "c"),
            ("d", "c"),
        ] {
            assert_eq!(check(&[("check", word)]), json!(letter), "{word}");
        }
        assert_eq!(check(&[("c", "")]), json!("c"));
        assert_eq!(check(&[("C", "")]), json!("C"));
        assert_eq!(check(&[("C", ""), ("check", "quiet")]), json!("C"));
        assert_eq!(check(&[("c", ""), ("check", "diagnose-first")]), json!("c"));
    }

    #[test]
    fn a_refused_check_word_is_quoted_and_exits_one() {
        const HINT: &str = "Valid arguments are:\n  - 'quiet', 'silent'\n  - 'diagnose-first'\nTry 'sort --help' for more information.";
        for (word, kind, shown) in [
            ("x\u{e9}", "invalid", "x\\303\\251"),
            ("x\r", "invalid", "x\\r"),
            ("qu1et", "invalid", "qu1et"),
            ("", "ambiguous", ""),
        ] {
            let message = format!("sort: {kind} argument '{shown}' for '--check'\n{HINT}");
            assert_eq!(refusal(&[("check", word)]), (message, 1), "{word:?}");
        }
    }

    #[test]
    fn the_two_check_modes_refuse_to_mix() {
        for typed in [[("c", ""), ("C", "")], [("check", "silent"), ("c", "")]] {
            assert_eq!(refusal(&typed), usage("options '-cC' are incompatible"));
        }
    }

    #[test]
    fn the_first_bad_option_on_the_line_is_the_one_refused() {
        let outputs = [("output", "/data/p1"), ("output", "/data/p2")];
        let typed = [outputs[0], outputs[1], ("key", "0")];
        assert_eq!(refusal(&typed), usage("multiple output files specified"));
        let typed = [("key", "0"), outputs[0], outputs[1]];
        assert_eq!(
            refusal(&typed),
            usage("field number is zero: invalid field specification '0'")
        );
        let typed = [("c", ""), ("C", ""), outputs[0], outputs[1]];
        assert_eq!(refusal(&typed), usage("options '-cC' are incompatible"));
        let typed = [("field_separator", "ab"), ("check", "x")];
        assert_eq!(refusal(&typed), usage("multi-character tab 'ab'"));
    }

    // sort.c's check_ordering_compatibility, measured against GNU
    // coreutils 9.7 under LC_ALL=C.
    #[test]
    fn the_global_options_are_the_one_key() {
        for (options, letters) in [
            (&["numeric_sort", "general_numeric_sort"][..], "gn"),
            (&["numeric_sort", "dictionary_order"], "dn"),
            (&["human_numeric_sort", "month_sort"], "hM"),
            (&["numeric_sort", "ignore_nonprinting"], "in"),
            (
                &["numeric_sort", "dictionary_order", "ignore_nonprinting"],
                "dn",
            ),
            (
                &["numeric_sort", "general_numeric_sort", "ignore_case"],
                "fgn",
            ),
            (
                &[
                    "numeric_sort",
                    "general_numeric_sort",
                    "ignore_leading_blanks",
                    "reverse",
                ],
                "gn",
            ),
            (&["month_sort", "version_sort"], "MV"),
            (&["human_numeric_sort", "numeric_sort"], "hn"),
            (&["general_numeric_sort", "month_sort"], "gM"),
            (&["dictionary_order", "month_sort"], "dM"),
        ] {
            let typed: Vec<(&str, &str)> = options.iter().map(|name| (*name, "")).collect();
            let message = format!("options '-{letters}' are incompatible");
            assert_eq!(refusal(&typed), usage(&message), "{options:?}");
        }
    }

    #[test]
    fn each_key_is_checked_in_the_order_typed() {
        for (specs, letters) in [
            (&["1n,1g"][..], "gn"),
            (&["1nM"], "Mn"),
            (&["1,1nR"], "nR"),
            (&["1bn,1g"], "gn"),
            (&["1hM"], "hM"),
            (&["1fiM"], "fiM"),
            (&["1idn"], "dn"),
            (&["1,1Mg"], "gM"),
            (&["2Mn", "1gn"], "Mn"),
            (&["1n", "2gh"], "gh"),
        ] {
            let typed: Vec<(&str, &str)> = specs.iter().map(|spec| ("key", *spec)).collect();
            let message = format!("options '-{letters}' are incompatible");
            assert_eq!(refusal(&typed), usage(&message), "{specs:?}");
        }
    }

    #[test]
    fn a_key_without_letters_inherits_the_conflict() {
        let typed = [
            ("key", "1,1"),
            ("numeric_sort", ""),
            ("general_numeric_sort", ""),
        ];
        assert_eq!(refusal(&typed), usage("options '-gn' are incompatible"));
        let typed = [("key", "1"), ("numeric_sort", ""), ("dictionary_order", "")];
        assert_eq!(refusal(&typed), usage("options '-dn' are incompatible"));
    }

    #[test]
    fn globals_no_key_inherits_are_not_checked() {
        let typed = [
            ("key", "1,1n"),
            ("numeric_sort", ""),
            ("general_numeric_sort", ""),
        ];
        assert_eq!(keys(&typed)[0]["mods"]["general_numeric"], json!(false));
        read(&[("key", "1d"), ("numeric_sort", "")]).expect("read");
    }

    #[test]
    fn orderings_that_combine() {
        for typed in [
            &[("key", "1dVR")][..],
            &[("key", "1,1VR")],
            &[("version_sort", ""), ("dictionary_order", "")],
            &[("version_sort", ""), ("ignore_nonprinting", "")],
            &[("dictionary_order", ""), ("ignore_case", "")],
            &[("key", "1n"), ("key", "2g")],
            &[
                ("numeric_sort", ""),
                ("reverse", ""),
                ("ignore_leading_blanks", ""),
            ],
        ] {
            read(typed).expect("combines");
        }
    }

    #[test]
    fn the_option_loop_outranks_incompatible_orderings() {
        let mixed = [("numeric_sort", ""), ("general_numeric_sort", "")];
        let typed = [mixed[0], mixed[1], ("key", "0")];
        assert_eq!(
            refusal(&typed),
            usage("field number is zero: invalid field specification '0'")
        );
        let typed = [mixed[0], mixed[1], ("c", ""), ("C", "")];
        assert_eq!(refusal(&typed), usage("options '-cC' are incompatible"));
    }

    #[test]
    fn check_refuses_a_second_operand_then_an_output_by_its_own_letter() {
        assert_eq!(
            refusal(&[("c", ""), ("output", "/data/out.txt")]),
            usage("options '-co' are incompatible")
        );
        assert_eq!(
            refusal(&[("check", "quiet"), ("output", "/data/out.txt")]),
            usage("options '-Co' are incompatible")
        );
        let typed = [
            ("C", ""),
            ("output", "/data/out.txt"),
            ("", "/data/a"),
            ("", "/data/b"),
        ];
        assert_eq!(
            refusal(&typed),
            usage("extra operand '/data/b' not allowed with -C")
        );
        let read_one = read(&[("c", ""), ("", "/data/a")]).expect("read");
        assert_eq!(read_one["check"], json!("c"));
        read(&[("", "/data/a"), ("", "/data/b"), ("output", "o")]).expect("sorts");
    }

    #[test]
    fn incompatible_orderings_outrank_the_operands() {
        let typed = [
            ("numeric_sort", ""),
            ("general_numeric_sort", ""),
            ("c", ""),
            ("", "/data/a"),
            ("", "/data/b"),
        ];
        assert_eq!(refusal(&typed), usage("options '-gn' are incompatible"));
    }

    #[test]
    fn an_option_the_grammar_does_not_read_is_the_hosts_mistake() {
        let refused = scan(&[("merge".to_owned(), Vec::new())]).expect_err("refused");
        assert_eq!(refused.message, "scan: sort reads no option merge");
    }
}
