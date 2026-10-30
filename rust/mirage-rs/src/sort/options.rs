//! sort's options as GNU sort 9.7 reads them, through the `scan` stream.
//! The option loop refuses in the order typed: a bad `-t`, two different
//! tabs, a bad KEYDEF, two different `-o` words, a refused `--check` word
//! and a second check mode. Then each key is checked for orderings it
//! cannot mix, and last `-c` refuses a second operand and an output. What
//! the host gets back is the check mode and the configuration it hands
//! every sort engine it opens.

use serde_json::{Value as Json, json};

use super::key::{Compare, Key, Mods};
use crate::scan::{Typed, Values, unknown};
use crate::{StreamError, quoted};

/// The ordering letters a KEYDEF takes after a position.
const ORDER_LETTERS: &[u8] = b"bdfghiMnRrV";

/// What strtoumax skips before a number, isspace() in the C locale.
const BLANKS: &[u8] = b" \t\n\x0b\x0c\r";

const CHECK_HINT: &str = "Valid arguments are:\n  - 'quiet', 'silent'\n  - 'diagnose-first'\nTry 'sort --help' for more information.";

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
            "" => operands.push(raw.as_slice()),
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
    const WORDS: [(&[u8], Check); 3] = [
        (b"quiet", Check::Quiet),
        (b"silent", Check::Quiet),
        (b"diagnose-first", Check::Diagnose),
    ];
    let mut modes = WORDS
        .iter()
        .filter(|(word, _)| word.starts_with(raw))
        .map(|&(_, mode)| mode);
    let kind = match modes.next() {
        None => "invalid",
        Some(mode) if modes.all(|other| other == mode) => return Ok(mode),
        Some(_) => "ambiguous",
    };
    let refused = format!(
        "sort: {kind} argument '{}' for '--check'\n{CHECK_HINT}",
        quoted(raw)
    );
    Err(StreamError::refusal(refused.as_bytes(), 1))
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
/// taken, then ASCII digits, a value past `usize` saturating. No digit, a
/// `-` included, is refused with the text from `at` on.
fn count(spec: &[u8], at: usize, what: &str) -> Result<(usize, usize), StreamError> {
    let mut end = at;
    while spec.get(end).is_some_and(|byte| BLANKS.contains(byte)) {
        end += 1;
    }
    if spec.get(end) == Some(&b'+') {
        end += 1;
    }
    let digits = end;
    while spec.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    if end == digits {
        let shown = quoted(&spec[at..]);
        return Err(usage(format!(
            "sort: {what}: invalid count at start of '{shown}'"
        )));
    }
    let value = spec[digits..end].iter().fold(0usize, |value, digit| {
        value
            .saturating_mul(10)
            .saturating_add(usize::from(digit - b'0'))
    });
    Ok((value, end))
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
    use crate::{drain_all, open, run};

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

    /// The engine's configuration for `options` under `-z`, with `mode`'s
    /// fields laid over it.
    fn engine(options: &Options, mode: Json) -> String {
        let mut typed = options.to_vec();
        typed.push(("zero_terminated", ""));
        let mut config = read(&typed).expect("read")["config"].clone();
        for (name, value) in mode.as_object().expect("an object") {
            config[name] = value.clone();
        }
        config.to_string()
    }

    // Records end in NUL so one may hold a newline, which is still a blank.
    fn records(list: &[&str]) -> Vec<u8> {
        list.iter()
            .flat_map(|record| [record.as_bytes(), b"\0"].concat())
            .collect()
    }

    fn split(output: &[u8]) -> Vec<String> {
        let text = String::from_utf8(output.to_vec()).expect("utf-8");
        let mut list: Vec<String> = text.split('\0').map(str::to_owned).collect();
        list.pop();
        list
    }

    fn sorted(options: &Options, list: &[&str]) -> Vec<String> {
        let config = engine(options, json!({"mode": "sort", "run_bytes": 8 << 20}));
        split(&run("sort", &config, &[&records(list)]).0)
    }

    fn lines(text: &str, options: &Options) -> Vec<String> {
        sorted(options, &text.split('\n').collect::<Vec<_>>())
    }

    fn merged(options: &Options, runs: &[&[&str]]) -> Vec<String> {
        let config = engine(options, json!({"mode": "merge", "inputs": runs.len()}));
        let mut stream = open("sort", config.as_bytes()).expect("opens");
        let mut out = Vec::new();
        for (index, list) in runs.iter().enumerate() {
            stream
                .feed_input(index, &records(list), &mut out)
                .expect("fed");
            drain_all(stream.as_mut(), &mut out);
        }
        for index in 0..runs.len() {
            stream.end_input(index, &mut out).expect("ended");
            drain_all(stream.as_mut(), &mut out);
        }
        stream.finish(&mut out).expect("finished");
        drain_all(stream.as_mut(), &mut out);
        split(&out)
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

    // Measured against GNU coreutils 9.4 under LC_ALL=C with a raw argv.
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

    #[test]
    fn default_separator_leading_blanks_belong_to_the_following_field() {
        assert_eq!(lines("a 1\na  2", &[("key", "2,2")]), ["a  2", "a 1"]);
        let typed = [("key", "2,2"), ("ignore_leading_blanks", "")];
        assert_eq!(lines("a 1\na  2", &typed), ["a 1", "a  2"]);
    }

    #[test]
    fn an_explicit_separator_collapses_no_blanks() {
        let typed = [("key", "3,3"), ("field_separator", ":")];
        assert_eq!(lines("x::b\ny::a", &typed), ["y::a", "x::b"]);
        let typed = [("key", "2,2"), ("field_separator", ":"), ("stable", "")];
        assert_eq!(lines("y::a\nx::b", &typed), ["y::a", "x::b"]);
    }

    #[test]
    fn a_key_extracts_its_fields() {
        assert_eq!(lines("a 2 z\nb 2 a", &[("key", "2")]), ["b 2 a", "a 2 z"]);
        let typed = [("key", "2,2"), ("stable", "")];
        assert_eq!(lines("b 2 a\na 2 z", &typed), ["b 2 a", "a 2 z"]);
        assert_eq!(lines("a 1\nb  2", &[("key", "2,2")]), ["b  2", "a 1"]);
        assert_eq!(lines("xa\ny 5", &[("key", "1.2")]), ["y 5", "xa"]);
        assert_eq!(lines("a b c\nx 3", &[("key", "3,3")]), ["x 3", "a b c"]);
    }

    #[test]
    fn keydefs_order_records() {
        let data = "a 2 z\nb 2 a\nc 1 m";
        assert_eq!(lines(data, &[("key", "2")]), ["c 1 m", "b 2 a", "a 2 z"]);
        assert_eq!(lines(data, &[("key", "2,2")]), ["c 1 m", "a 2 z", "b 2 a"]);
        let typed = [("key", "2,2n"), ("key", "1,1r")];
        assert_eq!(lines(data, &typed), ["c 1 m", "b 2 a", "a 2 z"]);
        let fruit = "apple 3\nbanana 1\ncherry 2\napple 10";
        assert_eq!(
            lines(fruit, &[("key", "2,2n")]),
            ["banana 1", "cherry 2", "apple 3", "apple 10"]
        );
        let ties = "z 2\nm 2\na 2";
        let typed = [("key", "2,2n"), ("reverse", "")];
        assert_eq!(lines(ties, &typed), ["z 2", "m 2", "a 2"]);
        assert_eq!(lines(ties, &[("key", "2,2n")]), ["a 2", "m 2", "z 2"]);
        let typed = [("key", "2,2n"), ("stable", "")];
        assert_eq!(lines(ties, &typed), ["z 2", "m 2", "a 2"]);
        let typed = [("key", "2b"), ("numeric_sort", "")];
        assert_eq!(
            lines("  a 30\n  b 5\n  c 200", &typed),
            ["  c 200", "  a 30", "  b 5"]
        );
        let typed = [("key", "1.2,1.3"), ("field_separator", ":")];
        assert_eq!(
            lines("apple:12\nbee:3\ncat:100", &typed),
            ["cat:100", "bee:3", "apple:12"]
        );
    }

    #[test]
    fn the_global_options_order_records() {
        let fruit = "banana\napple\ncherry";
        assert_eq!(lines(fruit, &[]), ["apple", "banana", "cherry"]);
        assert_eq!(
            lines(fruit, &[("reverse", "")]),
            ["cherry", "banana", "apple"]
        );
        let numbers = "10\n2\n30\n1";
        assert_eq!(
            lines(numbers, &[("numeric_sort", "")]),
            ["1", "2", "10", "30"]
        );
        let typed = [("numeric_sort", ""), ("reverse", "")];
        assert_eq!(lines(numbers, &typed), ["30", "10", "2", "1"]);
        assert_eq!(
            lines("10\nabc\n2\nxyz", &[("numeric_sort", "")]),
            ["abc", "xyz", "2", "10"]
        );
        assert_eq!(
            lines("banana\napple\nbanana\napple\ncherry", &[("unique", "")]),
            ["apple", "banana", "cherry"]
        );
        assert_eq!(
            lines("Banana\napple\nCherry", &[("ignore_case", "")]),
            ["apple", "Banana", "Cherry"]
        );
        let typed = [("unique", ""), ("ignore_case", "")];
        assert_eq!(
            lines("Apple\napple\nBanana\nbanana", &typed),
            ["Apple", "Banana"]
        );
        let typed = [("key", "2"), ("numeric_sort", "")];
        assert_eq!(lines("a 10\nb 2\nc 30", &typed), ["b 2", "a 10", "c 30"]);
        let typed = [("field_separator", ":"), ("key", "2"), ("numeric_sort", "")];
        assert_eq!(lines("a:10\nb:2\nc:30", &typed), ["b:2", "a:10", "c:30"]);
        let general = [("general_numeric_sort", "")];
        assert_eq!(
            lines("inf\n5\n-3\nnan\nabc", &general),
            ["abc", "nan", "-3", "5", "inf"]
        );
        assert_eq!(
            lines("0x10\n5\n12abc\n0x\n0x1p99999", &general),
            ["0x", "5", "12abc", "0x10", "0x1p99999"]
        );
    }

    // -n and -h in the C locale, pinned against GNU sort 9.7.
    #[test]
    fn numeric_keys_read_as_gnu_does() {
        let numeric = [("numeric_sort", "")];
        assert_eq!(
            sorted(&numeric, &["\n5", "3", "\n-5", "-4"]),
            ["\n-5", "-4", "3", "\n5"]
        );
        assert_eq!(
            sorted(&[("key", "2,2n")], &["b\n1", "a\n2"]),
            ["b\n1", "a\n2"]
        );
        let human = [("human_numeric_sort", "")];
        assert_eq!(
            lines("1500\n1.5K\n2000\n1K", &human),
            ["1500", "2000", "1K", "1.5K"]
        );
        assert_eq!(lines("1m\n1M\n2\n1k", &human), ["1m", "2", "1k", "1M"]);
        assert_eq!(
            lines("-1K\n-2\n1\n-1M\n0\n-0K\n0K", &human),
            ["-1M", "-1K", "-2", "-0K", "0", "0K", "1"]
        );
        let stable = [("human_numeric_sort", ""), ("stable", "")];
        assert_eq!(
            lines("5.K\n3K\n.5K\n3\nK", &stable),
            ["K", "3", ".5K", "3K", "5.K"]
        );
        assert_eq!(
            lines("1.000000000000000002K\n1.000000000000000001K", &stable),
            ["1.000000000000000001K", "1.000000000000000002K"]
        );
    }

    // Measured against GNU coreutils 9.7 on debian:stable-slim, LC_ALL=C.
    #[test]
    fn unique_stops_at_the_keys() {
        let typed = [("key", "2,2"), ("unique", "")];
        assert_eq!(lines("b 1\na 1", &typed), ["b 1"]);
        assert_eq!(lines("b 1\na 1", &[("key", "2,2")]), ["a 1", "b 1"]);
        let typed = [("ignore_case", ""), ("unique", "")];
        assert_eq!(lines("b\na\nB", &typed), ["a", "b"]);
        let typed = [("key", "2,2"), ("unique", ""), ("reverse", "")];
        assert_eq!(lines("a 1\nb 1\nc 2", &typed), ["c 2", "a 1"]);
    }

    #[test]
    fn a_merge_takes_the_smallest_head_and_never_reorders_a_run() {
        assert_eq!(merged(&[], &[&["b", "a"]]), ["b", "a"]);
        assert_eq!(merged(&[], &[&["c", "a"], &["b"]]), ["b", "c", "a"]);
        assert_eq!(
            merged(&[], &[&["a", "d"], &["b", "e"], &["c", "f"]]),
            ["a", "b", "c", "d", "e", "f"]
        );
        let runs: &[&[&str]] = &[&["k 3"], &["k 1"], &["k 2"]];
        let typed = [("key", "1,1"), ("stable", "")];
        assert_eq!(merged(&typed, runs), ["k 3", "k 1", "k 2"]);
        assert_eq!(merged(&[("key", "1,1")], runs), ["k 1", "k 2", "k 3"]);
        assert_eq!(merged(&[], &[&[], &["b", "a"], &[]]), ["b", "a"]);
        assert!(merged(&[], &[&[], &[]]).is_empty());
    }

    #[test]
    fn a_unique_merge_keeps_the_first_of_a_key_equal_series() {
        let unique = [("unique", "")];
        assert_eq!(merged(&unique, &[&["a", "b", "a"]]), ["a", "b", "a"]);
        assert_eq!(
            merged(&unique, &[&["a", "b"], &["a", "c"]]),
            ["a", "b", "c"]
        );
        let typed = [("key", "2,2"), ("unique", "")];
        assert_eq!(merged(&typed, &[&["x 1"], &["a 1"]]), ["x 1"]);
        let typed = [("ignore_case", ""), ("unique", "")];
        assert_eq!(merged(&typed, &[&["b"], &["B"]]), ["b"]);
    }
}
