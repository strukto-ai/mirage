use std::io::Write;

use serde::Deserialize;

use crate::regex::parse::Dialect;
use crate::regex::posix::{Options, Posix};
use crate::{Stream, StreamError, parse_config, quoted};

const INTMAX: i128 = i64::MAX as i128;
const INTMAX_MIN: i128 = i64::MIN as i128;
const ERANGE: &str = "Numerical result out of range";
const EOVERFLOW: &str = "Value too large for defined data type";
const HINT: &str = "Try 'nl --help' for more information.";

type Bounds = (&'static str, &'static str, i128, Option<i128>, Option<i128>);

/// nl's numeric options: the option, its refusal's wording, the least
/// value GNU 9.7 takes, the greatest (None where it clamps instead), and
/// the value below which a refusal takes the EOVERFLOW wording. `-w`'s
/// floor, -2**30, was found by bisection on coreutils 9.4 / glibc 2.39 /
/// x86-64 and matches no type bound; `-v` and `-i` switch at their own
/// bound, so their ERANGE wording never shows.
const NUMERIC: [Bounds; 4] = [
    (
        "starting_line_number",
        "invalid starting line number",
        INTMAX_MIN,
        Some(INTMAX),
        Some(INTMAX_MIN),
    ),
    (
        "line_increment",
        "invalid line number increment",
        INTMAX_MIN,
        Some(INTMAX),
        Some(INTMAX_MIN),
    ),
    (
        "number_width",
        "invalid line number field width",
        1,
        Some(i32::MAX as i128),
        Some(-(1 << 30)),
    ),
    (
        "join_blank_lines",
        "invalid line number of blank lines",
        0,
        None,
        None,
    ),
];

/// The header, body and footer styles, in section order, and their refusal.
const STYLES: [(&str, &str); 3] = [
    ("header_numbering", "invalid header numbering style"),
    ("body_numbering", "invalid body numbering style"),
    ("footer_numbering", "invalid footer numbering style"),
];

/// One option as the line typed it: its name and value.
#[derive(Deserialize)]
struct Typed(String, #[serde(deserialize_with = "crate::latin1")] Vec<u8>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// Every occurrence of the numeric, style and format options, the
    /// options in the order their first occurrence was typed.
    options: Vec<Typed>,
    #[serde(deserialize_with = "crate::latin1")]
    separator: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1")]
    delimiter: Vec<u8>,
    no_renumber: bool,
    utf8: bool,
    inputs: usize,
}

enum Style {
    All,
    Text,
    None,
    Pattern(Box<Posix>),
}

#[derive(Clone, Copy)]
enum Format {
    Left,
    Right,
    Zeros,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    validate(&config.options, config.utf8)?;
    let last = |name: &str| {
        config
            .options
            .iter()
            .rev()
            .find(|Typed(typed, _)| typed == name)
            .map(|Typed(_, raw)| raw.as_slice())
    };
    let value = |name, default| last(name).and_then(scan).unwrap_or(default);
    let mut styles = Vec::new();
    for ((name, _), default) in STYLES.iter().zip([b"n".as_slice(), b"t", b"n"]) {
        styles.push(match last(name).unwrap_or(default).split_first() {
            Some((b'a', _)) => Style::All,
            Some((b't', _)) => Style::Text,
            Some((b'p', pattern)) => Style::Pattern(Box::new(
                compile(pattern, config.utf8).map_err(StreamError::new)?,
            )),
            _ => Style::None,
        });
    }
    let format = match last("number_format") {
        Some(b"ln") => Format::Left,
        Some(b"rz") => Format::Zeros,
        _ => Format::Right,
    };
    let start = i64::try_from(value("starting_line_number", 1)).unwrap_or(1);
    let mut pair = config.delimiter.clone();
    if pair.len() == 1 {
        pair.push(b':');
    }
    Ok(Box::new(Nl {
        styles,
        start,
        increment: i64::try_from(value("line_increment", 1)).unwrap_or(1),
        width: usize::try_from(value("number_width", 6)).unwrap_or(6),
        join: u64::try_from(value("join_blank_lines", 1)).unwrap_or(u64::MAX),
        format,
        sections: [pair.repeat(3), pair.repeat(2), pair],
        separator: config.separator,
        no_renumber: config.no_renumber,
        inputs: config.inputs,
        input: 0,
        number: start,
        section: 1,
        blank_run: 0,
        overflowed: false,
        aborted: false,
        held: Vec::new(),
        stderr: Vec::new(),
    }))
}

fn compile(pattern: &[u8], utf8: bool) -> Result<Posix, &'static str> {
    let options = Options {
        extended: false,
        dialect: Dialect::Posix,
        ignore_case: false,
        utf8,
        multiline: false,
        word: false,
    };
    Posix::compile(pattern, &options)
}

/// A numeric option's value as strtol reads it: a run of C whitespace, at
/// most one sign, decimal digits and nothing after them; None for anything
/// else. A value past i128 saturates, which every bound compares alike.
fn scan(raw: &[u8]) -> Option<i128> {
    let start = raw
        .iter()
        .position(|b| !b" \t\n\x0b\x0c\r".contains(b))
        .unwrap_or(raw.len());
    let (negative, digits) = match &raw[start..] {
        [b'-', rest @ ..] => (true, rest),
        [b'+', rest @ ..] => (false, rest),
        rest => (false, rest),
    };
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let magnitude = digits.iter().fold(0i128, |n, d| {
        n.saturating_mul(10).saturating_add(i128::from(d - b'0'))
    });
    Some(if negative { -magnitude } else { magnitude })
}

/// What GNU nl prints for the options a line carried, as getopt hands them
/// over. A bad numeric value or a `p` style whose expression does not
/// compile is fatal where it stands, after the style refusals before it;
/// a bad style or format is reported and the parse goes on, and the
/// refusals end with the `--help` hint. Each occurrence is checked, so a
/// later valid `-b t` does not excuse an earlier `-b bogus`.
fn validate(options: &[Typed], utf8: bool) -> Result<(), StreamError> {
    let mut lines = Vec::new();
    for Typed(name, raw) in options {
        let fatal = if let Some(&(_, label, low, high, floor)) =
            NUMERIC.iter().find(|(numeric, ..)| numeric == name)
        {
            numeric_refusal(label, raw, low, high, floor)
        } else if let Some(refusal) = style_refusal(name, raw) {
            lines.push(refusal);
            continue;
        } else if raw.first() == Some(&b'p') && STYLES.iter().any(|(style, _)| style == name) {
            compile(&raw[1..], utf8)
                .err()
                .map(|err| format!("nl: {err}"))
        } else {
            None
        };
        if let Some(fatal) = fatal {
            lines.push(fatal);
            return Err(StreamError::new(lines.join("\n")));
        }
    }
    if lines.is_empty() {
        return Ok(());
    }
    lines.push(HINT.to_string());
    Err(StreamError::new(lines.join("\n")))
}

/// The refusal of a numeric value: the whole value quoted, with the ERANGE
/// clause below the least value and the EOVERFLOW one past the type.
fn numeric_refusal(
    label: &str,
    raw: &[u8],
    low: i128,
    high: Option<i128>,
    floor: Option<i128>,
) -> Option<String> {
    let quoted = quoted(raw);
    let Some(value) = scan(raw) else {
        return Some(format!("nl: {label}: '{quoted}'"));
    };
    if high.is_some_and(|high| value > high) || floor.is_some_and(|floor| value < floor) {
        return Some(format!("nl: {label}: '{quoted}': {EOVERFLOW}"));
    }
    (value < low).then(|| format!("nl: {label}: '{quoted}': {ERANGE}"))
}

/// The refusal of a style, which GNU reads by its first byte alone, or of
/// a format, which must be a whole word.
fn style_refusal(name: &str, raw: &[u8]) -> Option<String> {
    match STYLES.iter().find(|(style, _)| *style == name) {
        Some((_, label)) => (!raw.first().is_some_and(|b| b"atnp".contains(b)))
            .then(|| format!("nl: {label}: '{}'", quoted(raw))),
        None => (!matches!(raw, b"ln" | b"rn" | b"rz"))
            .then(|| format!("nl: invalid line numbering format: '{}'", quoted(raw))),
    }
}

/// GNU nl over its inputs one after another, the numbering and section
/// carried from one to the next. A line equal to the header, body or
/// footer delimiter opens that section and prints empty; a one-byte `-d`
/// is padded with `:` and an empty one matches nothing. An unnumbered line
/// is padded over the number and the separator alike. The counter advances
/// after each numbered line, and the next line that needs a number after
/// it leaves intmax_t ends the run: `line number overflow`, exit 1.
struct Nl {
    styles: Vec<Style>,
    start: i64,
    increment: i64,
    width: usize,
    join: u64,
    format: Format,
    sections: [Vec<u8>; 3],
    separator: Vec<u8>,
    no_renumber: bool,
    inputs: usize,
    input: usize,
    number: i64,
    section: usize,
    blank_run: u64,
    overflowed: bool,
    aborted: bool,
    /// The start of a line the input has not ended yet.
    held: Vec<u8>,
    stderr: Vec<u8>,
}

impl Nl {
    fn line(&mut self, line: &[u8], out: &mut Vec<u8>) {
        if self.aborted {
            return;
        }
        if let Some(section) = self
            .sections
            .iter()
            .position(|delimiter| !delimiter.is_empty() && delimiter == line)
        {
            self.section = section;
            self.blank_run = 0;
            if !self.no_renumber {
                self.number = self.start;
            }
            out.push(b'\n');
            return;
        }
        let style = &mut self.styles[self.section];
        let blank = line.is_empty() && matches!(style, Style::All);
        self.blank_run = if blank {
            self.blank_run.saturating_add(1)
        } else {
            0
        };
        let numbered = match style {
            Style::All => !blank || self.blank_run >= self.join,
            Style::Text => !line.is_empty(),
            Style::None => false,
            Style::Pattern(regex) => regex.test(line),
        };
        if !numbered {
            out.resize(out.len() + self.width + self.separator.len(), b' ');
        } else if self.overflowed {
            self.aborted = true;
            self.stderr.extend_from_slice(b"nl: line number overflow\n");
            return;
        } else {
            if blank {
                self.blank_run = 0;
            }
            let (number, width) = (self.number, self.width);
            let _ = match self.format {
                Format::Left => write!(out, "{number:<width$}"),
                Format::Right => write!(out, "{number:>width$}"),
                Format::Zeros => write!(out, "{number:0width$}"),
            };
            out.extend_from_slice(&self.separator);
            match self.number.checked_add(self.increment) {
                Some(next) => self.number = next,
                None => self.overflowed = true,
            }
        }
        out.extend_from_slice(line);
        out.push(b'\n');
    }
}

impl Stream for Nl {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(self.input, input, out)
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.held.is_empty() {
            let held = std::mem::take(&mut self.held);
            self.line(&held, out);
        }
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        (!self.aborted && self.input < self.inputs).then_some(self.input)
    }

    fn feed_input(&mut self, _: usize, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut rest = input;
        while let Some(at) = memchr::memchr(b'\n', rest) {
            if self.held.is_empty() {
                self.line(&rest[..at], out);
            } else {
                let mut held = std::mem::take(&mut self.held);
                held.extend_from_slice(&rest[..at]);
                self.line(&held, out);
                held.clear();
                self.held = held;
            }
            rest = &rest[at + 1..];
        }
        if !self.aborted {
            self.held.extend_from_slice(rest);
        }
        Ok(())
    }

    fn end_input(&mut self, _: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.finish(out)?;
        self.input += 1;
        Ok(())
    }

    fn status(&self) -> i32 {
        i32::from(self.aborted)
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;

    const DEFAULTS: &str = r#"{"options":[],"separator":"\t","delimiter":"\\:","no_renumber":false,"utf8":false,"inputs":1}"#;

    fn nl(options: &str, inputs: &[&[u8]]) -> (Vec<u8>, Vec<u8>, i32) {
        let mut stream = match open(config(DEFAULTS, options).as_bytes()) {
            Ok(stream) => stream,
            Err(err) => return (vec![], err.message.into_bytes(), 1),
        };
        let mut out = Vec::new();
        while let Some(index) = stream.wants() {
            for byte in inputs[index] {
                stream.feed_input(index, &[*byte], &mut out).unwrap();
            }
            stream.end_input(index, &mut out).unwrap();
        }
        stream.finish(&mut out).unwrap();
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        (out, err, stream.status())
    }

    fn refusal(options: &str) -> String {
        String::from_utf8(nl(options, &[b""]).1).unwrap()
    }

    #[test]
    fn numbers_non_empty_lines_across_inputs() {
        let two = r#"{"inputs":2}"#;
        assert_eq!(
            nl(two, &[b"a\n  \n\nb", b"c\n"]).0,
            b"     1\ta\n     2\t  \n       \n     3\tb\n     4\tc\n"
        );
        let all = r#"{"options":[["body_numbering","a"],["join_blank_lines","2"],["number_width","1"]],"separator":":"}"#;
        assert_eq!(nl(all, &[b"a\n\n\n\nb\n"]).0, b"1:a\n  \n2:\n  \n3:b\n");
        let formats = r#"{"options":[["number_format","rz"],["starting_line_number","-5"],["number_width","4"]]}"#;
        assert_eq!(nl(formats, &[b"x\n"]).0, b"-005\tx\n");
        let left =
            r#"{"options":[["number_format","ln"],["line_increment","-2"]],"separator":"\u00e9"}"#;
        assert_eq!(nl(left, &[b"x\ny\n"]).0, b"1     \xe9x\n-1    \xe9y\n");
    }

    #[test]
    fn delimiter_lines_open_sections() {
        let sections =
            r#"{"options":[["header_numbering","a"],["footer_numbering","t"]],"delimiter":"!"}"#;
        assert_eq!(
            nl(sections, &[b"!:!:!:\nh\n!:!:\nb\n!:\nf\n"]).0,
            b"\n     1\th\n\n     1\tb\n\n     1\tf\n"
        );
        assert_eq!(nl(r#"{"delimiter":""}"#, &[b"\\:\n"]).0, b"     1\t\\:\n");
        assert_eq!(
            nl(
                r#"{"delimiter":"xy","no_renumber":true}"#,
                &[b"a\nxyxy\nb\n"]
            )
            .0,
            b"     1\ta\n\n     2\tb\n"
        );
    }

    #[test]
    fn a_pattern_style_numbers_matching_lines() {
        let pattern = r#"{"options":[["body_numbering","pa\\{2\\}"]]}"#;
        assert_eq!(nl(pattern, &[b"aa\nab\n"]).0, b"     1\taa\n       ab\n");
        let utf8 = r#"{"options":[["body_numbering","p^.$"]],"utf8":true}"#;
        assert_eq!(nl(utf8, &[b"\xc3\xa9\n"]).0, b"     1\t\xc3\xa9\n");
        let bytes = r#"{"options":[["body_numbering","p^.$"]]}"#;
        assert_eq!(nl(bytes, &[b"\xc3\xa9\n"]).0, b"       \xc3\xa9\n");
    }

    #[test]
    fn overflow_waits_for_the_next_numbered_line() {
        let max = r#"{"options":[["starting_line_number","9223372036854775806"]]}"#;
        let (out, err, status) = nl(max, &[b"a\nb\n\nc\nd\n"]);
        assert_eq!(
            out,
            b"9223372036854775806\ta\n9223372036854775807\tb\n       \n"
        );
        assert_eq!(
            (err.as_slice(), status),
            (&b"nl: line number overflow\n"[..], 1)
        );
    }

    #[test]
    fn refusals_follow_getopt_order() {
        assert_eq!(
            refusal(r#"{"options":[["number_width","abc"],["starting_line_number","xyz"]]}"#),
            "nl: invalid line number field width: 'abc'"
        );
        assert_eq!(
            refusal(
                r#"{"options":[["body_numbering","bogus"],["number_width","3"],["header_numbering",""]]}"#
            ),
            "nl: invalid body numbering style: 'bogus'\nnl: invalid header numbering style: ''\nTry 'nl --help' for more information."
        );
        assert_eq!(
            refusal(
                r#"{"options":[["header_numbering","bogus"],["body_numbering","p["],["footer_numbering","x"]]}"#
            ),
            "nl: invalid header numbering style: 'bogus'\nnl: Invalid regular expression"
        );
        assert_eq!(
            refusal(r#"{"options":[["number_format","rnn"]]}"#),
            "nl: invalid line numbering format: 'rnn'\nTry 'nl --help' for more information."
        );
    }

    #[test]
    fn numeric_values_read_as_strtol_with_gnu_bounds() {
        let width = |raw: &str| refusal(&format!(r#"{{"options":[["number_width","{raw}"]]}}"#));
        assert_eq!(width(" +3"), "");
        assert_eq!(width("3 "), "nl: invalid line number field width: '3 '");
        assert_eq!(width("3\\n"), "nl: invalid line number field width: '3\\n'");
        assert_eq!(
            width("0"),
            "nl: invalid line number field width: '0': Numerical result out of range"
        );
        assert_eq!(
            width("-1073741824"),
            "nl: invalid line number field width: '-1073741824': Numerical result out of range"
        );
        assert_eq!(
            width("-1073741825"),
            "nl: invalid line number field width: '-1073741825': Value too large for defined data type"
        );
        assert_eq!(
            width("2147483648"),
            "nl: invalid line number field width: '2147483648': Value too large for defined data type"
        );
        let start = |raw: &str| {
            refusal(&format!(
                r#"{{"options":[["starting_line_number","{raw}"]]}}"#
            ))
        };
        assert_eq!(start("-9223372036854775808"), "");
        assert_eq!(
            start("9223372036854775808"),
            "nl: invalid starting line number: '9223372036854775808': Value too large for defined data type"
        );
        let join = |raw: &str| refusal(&format!(r#"{{"options":[["join_blank_lines","{raw}"]]}}"#));
        assert_eq!(join("99999999999999999999999999999999999999999"), "");
        assert_eq!(
            join("-2"),
            "nl: invalid line number of blank lines: '-2': Numerical result out of range"
        );
    }
}
