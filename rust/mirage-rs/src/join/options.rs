//! join's option and operand grammar, read in one pass as GNU join's
//! getopt loop meets its words (coreutils 9.7, `debian:stable-slim`): the
//! first problem left to right is the one reported, so `join a b c -a 3`
//! names the extra operand and `join -a 3 a b c` the file number.
//!
//! The host sends the tape: each option as `[dest, value]`, each operand as
//! `[OPERAND, word]` where it was typed, each `-j1`, `-j2` and `--` word as
//! `[SPELLED, word]` just before the occurrence it spells, and the line's
//! last word as `[LAST_WORD, word]`. The scan answers the `join` engine's
//! whole config under `engine` and the operand positions of FILE1 and
//! FILE2 under `files`.

use serde_json::Value as Json;

use super::{Config, Order};
use crate::scan::{LAST_WORD, OPERAND, SPELLED, Typed, Values, unknown};
use crate::{StreamError, number, quoted};

/// The largest field number join keeps; GNU 9.7 reads any larger one as
/// this one, so `-1 99999999999999999999 -1 1` is refused as
/// "incompatible join fields 9223372036854775806, 0".
const LARGEST_FIELD: u128 = (1 << 63) - 1;

/// The `-t` byte that keeps each record whole: both `-t ''` and
/// `-t $'\n'` select it, under -z as well, and they never conflict.
const WHOLE_RECORD: u8 = b'\n';

const USAGE_HINT: &str = "Try 'join --help' for more information.";

fn refusal(message: impl AsRef<str>) -> StreamError {
    StreamError::refusal(format!("join: {}", message.as_ref()).as_bytes(), 1)
}

/// A refusal that names a word as typed, then the usage hint.
fn usage(line: &[u8]) -> StreamError {
    StreamError::refusal(&[b"join: ", line, b"\n", USAGE_HINT.as_bytes()].concat(), 1)
}

/// A field number as join reads one, counted from 0: C blanks, one plus
/// sign and decimal digits, nothing after them, and never zero. `-1 ' 2'`
/// and `-1 +2` are field 2, `-1 '2 '` and `-1 0` are refused.
fn field_index(raw: &[u8]) -> Result<u64, StreamError> {
    match number::unsigned_decimal(raw) {
        Some(value) if value > 0 => Ok((value.min(LARGEST_FIELD) - 1) as u64),
        _ => Err(refusal(format!("invalid field number: '{}'", quoted(raw)))),
    }
}

/// The 1 or 2 that -a and -v take, read like a field number, as a side.
fn file_side(raw: &[u8]) -> Result<usize, StreamError> {
    match number::unsigned_decimal(raw) {
        Some(1) => Ok(0),
        Some(2) => Ok(1),
        _ => Err(refusal(format!("invalid file number: '{}'", quoted(raw)))),
    }
}

/// One -o item: `0` for the join field, else `FILE.FIELD`. GNU 9.7 sorts
/// a bad item by its first byte: one led by 0, 1 or 2 is an "invalid
/// field specifier" (`01.1`, `1`, `2x`), any other an "invalid file number
/// in field spec" (`3.1`, `.1`, `auto,1.1`), and the text after `1.` or
/// `2.` must be a field number.
fn column(item: &[u8]) -> Result<[u64; 2], StreamError> {
    match item {
        b"0" => Ok([0, 0]),
        [file @ (b'1' | b'2'), b'.', field @ ..] => {
            Ok([u64::from(file - b'0'), field_index(field)?])
        }
        [b'0' | b'1' | b'2', ..] => Err(refusal(format!(
            "invalid field specifier: '{}'",
            quoted(item)
        ))),
        _ => Err(refusal(format!(
            "invalid file number in field spec: '{}'",
            quoted(item)
        ))),
    }
}

/// A `-j1` or `-j2` typed as a word of its own.
struct LoneJ {
    /// The side it spells: 0 for `-j1`, 1 for `-j2`.
    side: usize,
    /// The operand after it was taken as its field.
    claimed: bool,
}

/// An operand standing as a file name.
struct Operand<'a> {
    /// Its place among the line's operands.
    position: usize,
    word: &'a [u8],
    /// The lone `-jN` typed right before it, which may still take it as a
    /// field number, by its place in `Reading::lone`.
    lone: Option<usize>,
    /// It came straight after an -o list, or after an operand that did,
    /// so it may still be more of that list.
    listed: bool,
}

/// The options read so far, in the order the line typed them.
struct Reading<'a> {
    seen: usize,
    names: Vec<Operand<'a>>,
    lone: Vec<LoneJ>,
    last_word: Option<&'a [u8]>,
    keys: [Option<u64>; 2],
    unpaired: [bool; 2],
    paired: bool,
    filler: Option<&'a [u8]>,
    columns: Vec<[u64; 2]>,
    auto_columns: bool,
    delimiter: Option<u8>,
    separator: u8,
    fold_case: bool,
    zero_terminated: bool,
    order: Order,
    header: bool,
}

impl<'a> Reading<'a> {
    fn new() -> Self {
        Reading {
            seen: 0,
            names: Vec::new(),
            lone: Vec::new(),
            last_word: None,
            keys: [None, None],
            unpaired: [false, false],
            paired: true,
            filler: None,
            columns: Vec::new(),
            auto_columns: false,
            delimiter: None,
            separator: b' ',
            fold_case: false,
            zero_terminated: false,
            order: Order::Warn,
            header: false,
        }
    }

    fn set_key(&mut self, side: usize, index: u64) -> Result<(), StreamError> {
        match self.keys[side] {
            Some(held) if held != index => {
                Err(refusal(format!("incompatible join fields {held}, {index}")))
            }
            _ => {
                self.keys[side] = Some(index);
                Ok(())
            }
        }
    }

    /// File one operand, making room when two are already filed. A third
    /// operand gives the earliest filed one that could be an option's
    /// value to that option: the field number of the lone `-jN` before it
    /// (`join -j1 2 a b` is `-1 2 a b`), or more of the -o list (`join -o
    /// 1.1 2.2 a b` is `-o 1.1,2.2 a b`), appended where the list then
    /// ends. With no such operand it is an extra one.
    fn operand(
        &mut self,
        word: &'a [u8],
        lone: Option<usize>,
        listed: bool,
    ) -> Result<(), StreamError> {
        let position = self.seen;
        self.seen += 1;
        if self.names.len() == 2 {
            let Some(at) = self
                .names
                .iter()
                .position(|name| name.lone.is_some() || name.listed)
            else {
                return Err(usage(&[b"extra operand '", word, b"'"].concat()));
            };
            let taken = self.names.remove(at);
            match taken.lone {
                Some(j) => {
                    self.lone[j].claimed = true;
                    let side = self.lone[j].side;
                    self.set_key(side, field_index(taken.word)?)?;
                }
                None => self.add_items(taken.word)?,
            }
        }
        self.names.push(Operand {
            position,
            word,
            lone,
            listed,
        });
        Ok(())
    }

    /// Read one option: true for an -o list, which the operands right
    /// after it may continue.
    fn option(&mut self, name: &str, raw: &'a [u8]) -> Result<bool, StreamError> {
        match name {
            "a" | "v" => {
                self.unpaired[file_side(raw)?] = true;
                self.paired = self.paired && name == "a";
            }
            "e" => {
                if self.filler.is_some_and(|held| held != raw) {
                    return Err(refusal("conflicting empty-field replacement strings"));
                }
                self.filler = Some(raw);
            }
            "args_1" => self.set_key(0, field_index(raw)?)?,
            "2" => self.set_key(1, field_index(raw)?)?,
            "j" => {
                let index = field_index(raw)?;
                self.set_key(0, index)?;
                self.set_key(1, index)?;
            }
            // Only the whole value `auto` is auto.
            "o" if raw == b"auto" => self.auto_columns = true,
            "o" => {
                self.add_items(raw)?;
                return Ok(true);
            }
            "t" => self.set_delimiter(raw)?,
            "ignore_case" => self.fold_case = true,
            "zero_terminated" => self.zero_terminated = true,
            "check_order" => self.order = Order::Fail,
            "nocheck_order" => self.order = Order::Off,
            "header" => self.header = true,
            _ => return Err(unknown("join", name)),
        }
        Ok(false)
    }

    /// One -o list: items parted by a single comma, space or tab. One
    /// separator may close the list (`-o '1.1,'`); any other empty item is
    /// refused.
    fn add_items(&mut self, raw: &[u8]) -> Result<(), StreamError> {
        let mut items: Vec<&[u8]> = raw.split(|b| matches!(b, b',' | b' ' | b'\t')).collect();
        if items.len() > 1 && items.last().is_some_and(|item| item.is_empty()) {
            items.pop();
        }
        for item in items {
            self.columns.push(column(item)?);
        }
        Ok(())
    }

    /// `-t ''` keeps records whole but leaves the output separator as it
    /// was; `\0` is NUL; any other value must be one byte.
    fn set_delimiter(&mut self, raw: &[u8]) -> Result<(), StreamError> {
        let byte = match raw {
            b"" => WHOLE_RECORD,
            b"\\0" => 0,
            [byte] => *byte,
            _ => return Err(refusal(format!("multi-character tab '{}'", quoted(raw)))),
        };
        if self.delimiter.is_some_and(|held| held != byte) {
            return Err(refusal("incompatible tabs"));
        }
        self.delimiter = Some(byte);
        if !raw.is_empty() {
            self.separator = byte;
        }
        Ok(())
    }

    /// Check the operands, then apply the lone `-jN` words left. A lone
    /// `-jN` whose operand stayed a file name is `-j N`, and GNU 9.7
    /// applies those after every other option, every `-j1` before every
    /// `-j2`: `join -j2 a -j1 b` is refused as "incompatible join fields
    /// 0, 1". The missing-operand line names the line's last word, as a
    /// loop that reads its operands in order does: `join a -t ,` is
    /// missing an operand after ','.
    fn finish(mut self) -> Result<Values, StreamError> {
        let [one, two] = match &self.names[..] {
            [one, two] => [one, two].map(|name| (name.position, name.word)),
            [] => return Err(usage(b"missing operand")),
            [.., last] => {
                let after = self.last_word.unwrap_or(last.word);
                return Err(usage(&[b"missing operand after '", after, b"'"].concat()));
            }
        };
        for side in [0, 1] {
            if self.lone.iter().any(|j| j.side == side && !j.claimed) {
                self.set_key(0, side as u64)?;
                self.set_key(1, side as u64)?;
            }
        }
        if one.1 == b"-" && two.1 == b"-" {
            return Err(refusal("both files cannot be standard input"));
        }
        let engine = Config {
            keys: self.keys.map(|key| key.unwrap_or(0)),
            unpaired: self.unpaired,
            paired: self.paired,
            filler: self.filler.map(<[u8]>::to_vec),
            columns: self.columns,
            auto_columns: self.auto_columns,
            delimiter: self.delimiter.map(|byte| vec![byte]),
            separator: vec![self.separator],
            fold_case: self.fold_case,
            zero_terminated: self.zero_terminated,
            order: self.order,
            header: self.header,
            names: vec![one.1.to_vec(), two.1.to_vec()],
        };
        let engine = serde_json::to_value(&engine)
            .map_err(|e| StreamError::new(format!("join's engine config: {e}")))?;
        let mut values = Values::new();
        values.insert("engine".to_owned(), engine);
        values.insert("files".to_owned(), Json::from(vec![one.0, two.0]));
        Ok(values)
    }
}

/// join's tape read in the order typed. A `-j1` or `-j2` typed as one word
/// and followed at once by an operand may be the obsolete `-j1 FIELD`, and
/// the operands right after an -o list may be more of it: such an operand
/// is taken as the value only when a third operand needs the room (`join
/// -j1 2 a b`), and stays a file name otherwise (`join -j1 a b` is `join
/// -j 1 a b`).
pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let mut reading = Reading::new();
    let mut spelled: Option<&[u8]> = None;
    let mut fresh: Option<usize> = None;
    let mut listing = false;
    for (name, raw) in options {
        let after_word = spelled.take();
        let after_lone = fresh.take();
        let after_list = std::mem::take(&mut listing);
        match name.as_str() {
            SPELLED => spelled = Some(raw.as_slice()),
            OPERAND => {
                reading.operand(raw, after_lone, after_list)?;
                listing = after_list;
            }
            LAST_WORD => reading.last_word = Some(raw.as_slice()),
            "j" if matches!(after_word, Some(b"-j1" | b"-j2")) => {
                let side = usize::from(after_word == Some(&b"-j2"[..]));
                fresh = Some(reading.lone.len());
                reading.lone.push(LoneJ {
                    side,
                    claimed: false,
                });
            }
            _ => listing = reading.option(name, raw)?,
        }
    }
    reading.finish()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as Json, json};

    use super::scan;
    use crate::open;

    /// The tape a line types, each word one of: `-x VALUE` pairs given as
    /// `(dest, value)`, an operand as `("", word)` and a spelled word as
    /// `("=", word)`.
    fn read(tape: &[(&str, &str)]) -> Result<Json, (String, i32)> {
        let typed: Vec<(String, Vec<u8>)> = tape
            .iter()
            .map(|(name, text)| ((*name).to_owned(), text.as_bytes().to_vec()))
            .collect();
        scan(&typed)
            .map(Json::Object)
            .map_err(|e| (String::from_utf8_lossy(&e.stderr()).into_owned(), e.status))
    }

    fn engine(tape: &[(&str, &str)]) -> Json {
        read(tape).expect("read")["engine"].clone()
    }

    fn refused(tape: &[(&str, &str)]) -> String {
        let (stderr, status) = read(tape).expect_err("refused");
        assert_eq!(status, 1, "{stderr}");
        stderr
    }

    const FILES: [(&str, &str); 2] = [("", "a"), ("", "b")];

    fn with_files<'a>(options: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        options.iter().copied().chain(FILES).collect()
    }

    #[test]
    fn defaults_name_both_files_and_the_engine_opens_on_them() {
        let values = read(&FILES).expect("read");
        assert_eq!(
            values,
            json!({
                "engine": {
                    "keys": [0, 0], "unpaired": [false, false], "paired": true,
                    "filler": null, "columns": [], "auto_columns": false,
                    "delimiter": null, "separator": " ", "fold_case": false,
                    "zero_terminated": false, "order": "warn", "header": false,
                    "names": ["a", "b"],
                },
                "files": [0, 1],
            })
        );
        let config = values["engine"].to_string();
        assert!(open("join", config.as_bytes()).is_ok());
    }

    #[test]
    fn each_option_lands_in_the_engine() {
        let cases: &[(&[(&str, &str)], Json)] = &[
            (
                &[("a", "2"), ("v", "1")],
                json!({"unpaired": [true, true], "paired": false}),
            ),
            (&[("j", "3")], json!({"keys": [2, 2]})),
            (&[("args_1", " +2"), ("2", "4")], json!({"keys": [1, 3]})),
            (&[("t", "")], json!({"delimiter": "\n", "separator": " "})),
            (
                &[("t", "\\0")],
                json!({"delimiter": "\0", "separator": "\0"}),
            ),
            (
                &[("t", ""), ("t", "\n")],
                json!({"delimiter": "\n", "separator": "\n"}),
            ),
            (
                &[("o", "0,2.3 1.1")],
                json!({"columns": [[0, 0], [2, 2], [1, 0]]}),
            ),
            (&[("o", "1.1,")], json!({"columns": [[1, 0]]})),
            (
                &[("o", "auto"), ("zero_terminated", "")],
                json!({"auto_columns": true, "zero_terminated": true}),
            ),
            (&[("nocheck_order", "")], json!({"order": "off"})),
            (
                &[("nocheck_order", ""), ("check_order", "")],
                json!({"order": "fail"}),
            ),
            (
                &[("ignore_case", ""), ("header", ""), ("e", "-"), ("e", "-")],
                json!({"fold_case": true, "header": true, "filler": "-"}),
            ),
            (
                &[("args_1", "99999999999999999999")],
                json!({"keys": [9223372036854775806u64, 0]}),
            ),
        ];
        for (options, expected) in cases {
            let engine = engine(&with_files(options));
            for (key, value) in expected.as_object().expect("object") {
                assert_eq!(&engine[key], value, "{options:?} {key}");
            }
        }
    }

    #[test]
    fn values_are_bytes_one_character_each() {
        let tape = with_files(&[("e", "\u{e9}")]);
        let typed: Vec<(String, Vec<u8>)> = tape
            .iter()
            .map(|(name, text)| ((*name).to_owned(), text.as_bytes().to_vec()))
            .collect();
        let values = scan(&typed).expect("read");
        assert_eq!(values["engine"]["filler"], json!("\u{c3}\u{a9}"));
    }

    #[test]
    fn bad_values_are_refused_quoted() {
        for (options, shown) in [
            (&[("j", "0")][..], "join: invalid field number: '0'"),
            (&[("j", "2 ")], "join: invalid field number: '2 '"),
            (&[("j", "-1")], "join: invalid field number: '-1'"),
            (&[("args_1", "a\tb")], "join: invalid field number: 'a\\tb'"),
            (&[("a", "3")], "join: invalid file number: '3'"),
            (&[("v", "0")], "join: invalid file number: '0'"),
            (&[("o", "01.1")], "join: invalid field specifier: '01.1'"),
            (&[("o", "2x")], "join: invalid field specifier: '2x'"),
            (&[("o", "1")], "join: invalid field specifier: '1'"),
            (
                &[("o", "3.1")],
                "join: invalid file number in field spec: '3.1'",
            ),
            (
                &[("o", ".1")],
                "join: invalid file number in field spec: '.1'",
            ),
            (
                &[("o", "auto,1.1")],
                "join: invalid file number in field spec: 'auto'",
            ),
            (
                &[("o", "1.1,,2.1")],
                "join: invalid file number in field spec: ''",
            ),
            (&[("o", "1.0")], "join: invalid field number: '0'"),
            (&[("t", "ab")], "join: multi-character tab 'ab'"),
            (&[("t", "\u{e9}")], "join: multi-character tab '\\303\\251'"),
            (&[("t", ","), ("t", ":")], "join: incompatible tabs"),
            (&[("t", ""), ("t", ",")], "join: incompatible tabs"),
            (
                &[("e", "x"), ("e", "y")],
                "join: conflicting empty-field replacement strings",
            ),
            (
                &[("j", "1"), ("args_1", "2")],
                "join: incompatible join fields 0, 1",
            ),
            (
                &[("args_1", "99999999999999999999"), ("args_1", "1")],
                "join: incompatible join fields 9223372036854775806, 0",
            ),
        ] {
            assert_eq!(refused(&with_files(options)), shown, "{options:?}");
        }
    }

    const HINT: &str = "\nTry 'join --help' for more information.";

    #[test]
    fn operands_are_counted_where_they_were_typed() {
        let extra = format!("join: extra operand 'c'{HINT}");
        assert_eq!(
            refused(&[("", "a"), ("", "b"), ("", "c"), ("a", "3")]),
            extra
        );
        assert_eq!(
            refused(&[("a", "3"), ("", "a"), ("", "b"), ("", "c")]),
            "join: invalid file number: '3'"
        );
        assert_eq!(refused(&[]), format!("join: missing operand{HINT}"));
        assert_eq!(
            refused(&[("", "a")]),
            format!("join: missing operand after 'a'{HINT}")
        );
        let tape = [("", "a"), ("t", ","), ("last_word", ",")];
        assert_eq!(
            refused(&tape),
            format!("join: missing operand after ','{HINT}")
        );
        assert_eq!(
            refused(&[("a", "1"), ("last_word", "-a1")]),
            format!("join: missing operand{HINT}")
        );
    }

    #[test]
    fn both_files_cannot_be_standard_input() {
        assert_eq!(
            refused(&[("", "-"), ("", "-")]),
            "join: both files cannot be standard input"
        );
        let values = read(&[("", "-"), ("", "./-")]).expect("read");
        assert_eq!(values["engine"]["names"], json!(["-", "./-"]));
        let refusal = refused(&[
            ("=", "-j2"),
            ("j", "2"),
            ("", "-"),
            ("=", "-j1"),
            ("j", "1"),
            ("", "-"),
        ]);
        assert_eq!(refusal, "join: incompatible join fields 0, 1");
    }

    #[test]
    fn a_lone_j_claims_its_operand_only_when_a_third_needs_the_room() {
        let lone = [("=", "-j1"), ("j", "1")];
        let tape: Vec<_> = lone
            .iter()
            .copied()
            .chain([("", "2"), ("", "a"), ("", "b")])
            .collect();
        let values = read(&tape).expect("read");
        assert_eq!(values["engine"]["keys"], json!([1, 0]));
        assert_eq!(values["files"], json!([1, 2]));
        assert_eq!(values["engine"]["names"], json!(["a", "b"]));
        let tape: Vec<_> = lone.iter().copied().chain(FILES).collect();
        assert_eq!(engine(&tape)["keys"], json!([0, 0]));
        let tape = [("=", "-j2"), ("j", "2"), ("", "a"), ("", "b")];
        assert_eq!(engine(&tape)["keys"], json!([1, 1]));
        let tape = [
            ("=", "-j2"),
            ("j", "2"),
            ("", "a"),
            ("=", "-j1"),
            ("j", "1"),
            ("", "b"),
        ];
        assert_eq!(refused(&tape), "join: incompatible join fields 0, 1");
        let tape = [("=", "-j1"), ("j", "1"), ("", "x"), ("", "a"), ("", "b")];
        assert_eq!(refused(&tape), "join: invalid field number: 'x'");
        let tape = [
            ("=", "-j1"),
            ("j", "1"),
            ("", "2"),
            ("", "a"),
            ("", "b"),
            ("", "c"),
        ];
        assert_eq!(refused(&tape), format!("join: extra operand 'c'{HINT}"));
        let tape = [("j", "1"), ("", "2"), ("", "a"), ("", "b")];
        assert_eq!(refused(&tape), format!("join: extra operand 'b'{HINT}"));
        let tape = [
            ("=", "-j1"),
            ("j", "1"),
            ("=", "--"),
            ("", "2"),
            ("", "a"),
            ("", "b"),
        ];
        assert_eq!(refused(&tape), format!("join: extra operand 'b'{HINT}"));
    }

    #[test]
    fn operands_after_an_o_list_may_be_more_of_it() {
        let tape = [("o", "1.1"), ("", "2.2"), ("", "a"), ("", "b")];
        let values = read(&tape).expect("read");
        assert_eq!(values["engine"]["columns"], json!([[1, 0], [2, 1]]));
        assert_eq!(values["files"], json!([1, 2]));
        let tape = [("o", "1.1"), ("", "2.2"), ("", "1.2"), ("", "a"), ("", "b")];
        assert_eq!(engine(&tape)["columns"], json!([[1, 0], [2, 1], [1, 1]]));
        let tape = [("o", "1.1"), ("", "a"), ("", "b")];
        assert_eq!(read(&tape).expect("read")["files"], json!([0, 1]));
        let tape = [("o", "auto"), ("", "2.2"), ("", "a"), ("", "b")];
        assert_eq!(refused(&tape), format!("join: extra operand 'b'{HINT}"));
        let tape = [("o", "1.1"), ("", "x"), ("", "a"), ("", "b")];
        assert_eq!(
            refused(&tape),
            "join: invalid file number in field spec: 'x'"
        );
        let tape = [
            ("o", "1.1"),
            ("", "2.2"),
            ("ignore_case", ""),
            ("", "a"),
            ("", "b"),
        ];
        assert_eq!(engine(&tape)["columns"], json!([[1, 0], [2, 1]]));
        let tape = [
            ("o", "1.1"),
            ("ignore_case", ""),
            ("", "2.2"),
            ("", "a"),
            ("", "b"),
        ];
        assert_eq!(refused(&tape), format!("join: extra operand 'b'{HINT}"));
    }

    #[test]
    fn a_dest_join_does_not_read_is_the_hosts_mistake() {
        let tape = with_files(&[("x", "")]);
        let typed: Vec<(String, Vec<u8>)> = tape
            .iter()
            .map(|(name, text)| ((*name).to_owned(), text.as_bytes().to_vec()))
            .collect();
        let refusal = scan(&typed).expect_err("refused");
        assert_eq!(refusal.message, "scan: join reads no option x");
    }
}
